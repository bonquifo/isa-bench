import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyData, interpretIr, IrBuilder, parseIr, type IrProgram } from '../../src/engine/ir.ts'
import { STDOUT_BASE } from '../../src/engine/types.ts'
import { emitCanonicalLlvmIr } from '../../src/toolchains/llvmEmitter.ts'
import { compareResultFrame, parseResultFrame } from '../../src/toolchains/resultFrame.ts'

interface Case {
  name: string
  program: IrProgram
  kind: 'i32' | 'binary64'
  fault?: boolean
}

const cases: Case[] = [
  sourceCase('div-zero', 'imm r0, 123\nimm r1, 0\ndiv r2, r0, r1\nhalt r2', 'i32'),
  sourceCase('rem-zero', 'imm r0, 123\nimm r1, 0\nrem r2, r0, r1\nhalt r2', 'i32'),
  sourceCase('div-overflow', 'imm r0, -2147483648\nimm r1, -1\ndiv r2, r0, r1\nhalt r2', 'i32'),
  sourceCase('calls-icalls', [
    'la r0, first', 'icall r0', 'halt r1', 'first:', 'imm r1, 40', 'call second',
    'ret', 'second:', 'addi r1, r1, 2', 'ret',
  ].join('\n'), 'i32'),
  sourceCase('stdout-bytes', `.data ${STDOUT_BASE}\n.word 3 65 128 255\n.text\nimm r0, 7\nhalt r0`, 'i32'),
  sourceCase('memory-fault', 'imm r0, 2097152\nldw r1, 0(r0)\nhalt r1', 'i32', true),
  sourceCase('callstack-fault', 'ret\nimm r0, 0\nhalt r0', 'i32', true),
  floatCase('dtoi-nan', Number.NaN, 'dtoi', 'i32'),
  floatCase('dtoi-infinity', Number.POSITIVE_INFINITY, 'dtoi', 'i32'),
  floatCase('itod-kind', -1, 'itod', 'binary64'),
  movedFloatCase(),
  ieeeCase('negative-zero', -0),
  ieeeCase('positive-infinity', Number.POSITIVE_INFINITY),
  ieeeCase('nan', Number.NaN),
]

const root = resolve(import.meta.dirname, '..', '..')
const directory = mkdtempSync(join(tmpdir(), 'isa-semantic-cases-'))
const observations: Record<string, Record<string, string>> = {}

try {
  writeFileSync(join(directory, 'linux-freestanding.c'), readFileSync(join(root, 'toolchains/runtime/linux-freestanding.c')))
  writeFileSync(join(directory, 'x86_64-linux.c'), readFileSync(join(root, 'toolchains/runtime/x86_64-linux.c')))
  writeFileSync(join(directory, 'host.c'), readFileSync(join(root, 'toolchains/runtime/host.c')))
  for (const item of cases) {
    const memory = new ArrayBuffer(item.program.memSize)
    applyData(memory, item.program.data)
    let reference: ReturnType<typeof interpretIr> | undefined
    let referenceFault = ''
    try {
      reference = interpretIr(item.program, memory)
    } catch (error) {
      referenceFault = error instanceof Error ? error.message : String(error)
    }
    if (Boolean(item.fault) !== Boolean(referenceFault)) throw new Error(`${item.name}: reference fault expectation is wrong`)
    const irName = `${item.name}.ll`
    writeFileSync(join(directory, irName), emitCanonicalLlvmIr(item.program))
    observations[item.name] = {}
    for (const target of ['x86_64-linux', 'wasm32-wasip1'] as const) {
      process.stderr.write(`semantic-case ${item.name} ${target}\n`)
      const output = target === 'x86_64-linux' ? `${item.name}.elf` : `${item.name}.wasm`
      const image = target === 'x86_64-linux' ? 'isa-sim/codegen:23.1.0' : 'isa-sim/wasi:33.0-48.0.1'
      const adapter = target === 'x86_64-linux' ? 'x86_64-linux.c' : 'host.c'
      const compile = target === 'x86_64-linux'
        ? ['clang', '-target', 'x86_64-unknown-linux-gnu', '-fuse-ld=lld', '-nostdlib', '-static',
            '-fno-stack-protector', '-fno-builtin', '-Wl,-e,_start',
            `/artifacts/${irName}`, `/artifacts/${adapter}`, '-o', `/artifacts/${output}`]
        : ['clang', `/artifacts/${irName}`, `/artifacts/${adapter}`, '-o', `/artifacts/${output}`]
      await runText('docker', hardened(image, compile, directory))
      const execute = target === 'x86_64-linux'
        ? [`/artifacts/${output}`]
        : ['wasmtime', 'run', '-C', 'cache=n', '-W', 'fuel=10000000', '-W', 'timeout=5s',
            '-W', 'max-memory-size=67108864', `/artifacts/${output}`]
      const frame = parseResultFrame(await runBytes('docker', hardened(image, execute, directory)))
      if (item.fault) {
        if (frame.status !== 'fault' || !frame.fault) throw new Error(`${item.name}/${target}: missing fault frame`)
      } else {
        const comparison = compareResultFrame(frame, reference!)
        if (frame.resultKind !== item.kind || !comparison.equal) {
          throw new Error(`${item.name}/${target}: ${comparison.reason}; kind=${frame.resultKind}`)
        }
      }
      observations[item.name]![target] = item.fault ? `fault:${frame.fault}` : `${frame.resultKind}:0x${frame.rawBits.toString(16)}`
    }
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, observations }, null, 2)}\n`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

function sourceCase(name: string, source: string, kind: Case['kind'], fault = false): Case {
  return { name, program: parseIr(source), kind, fault }
}

function floatCase(name: string, value: number, conversion: 'dtoi' | 'itod', kind: Case['kind']): Case {
  const b = new IrBuilder()
  const source = conversion === 'itod' ? b.imm(value) : b.immf(value)
  const result = b.convert(conversion, source)
  b.halt(result)
  return { name, program: b.program(), kind }
}

function movedFloatCase(): Case {
  const b = new IrBuilder()
  const condition = b.imm(1)
  const zero = b.imm(0)
  const selected = b.reg()
  const alternate = b.lab('alternate')
  const done = b.lab('done')
  b.beq(condition, zero, alternate)
  const negativeZero = b.immf(-0)
  b.movTo(selected, negativeZero)
  b.br(done)
  b.label(alternate)
  const integer = b.imm(5)
  b.movTo(selected, integer)
  b.label(done)
  const moved = b.mov(selected)
  b.halt(moved)
  return { name: 'branch-move-runtime-kind', program: b.program(), kind: 'binary64' }
}

function ieeeCase(name: string, value: number): Case {
  const b = new IrBuilder()
  const result = b.immf(value)
  b.halt(result)
  return { name, program: b.program(), kind: 'binary64' }
}

function hardened(image: string, argv: string[], mount: string): string[] {
  return [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '128',
    '--memory', '1g', '--cpus', '2', '--user', '65532:65532',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864',
    '--mount', `type=bind,src=${mount},dst=/artifacts`, image, ...argv,
  ]
}

function runText(command: string, args: string[]): Promise<void> {
  return run(command, args).then(() => undefined)
}

function runBytes(command: string, args: string[]): Promise<Uint8Array> {
  return run(command, args)
}

function run(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'pipe' })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolveRun(Buffer.concat(stdout))
      : reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-8192)}`)))
  })
}
