/**
 * Builds the committed RV64 differential-test fixtures.
 *
 *   npx vite-node tools/isa/build-rv64-fixtures.ts
 *
 * Requires two images that already exist on a development machine:
 *   isa-bench/codegen-min:23.1.0   clang, lld, llvm-objdump
 *   isa-sim/qemu-user:11.1.0       qemu-riscv64
 *
 * For each program under tools/isa/rv64/programs it emits, into
 * src/isa/riscv/fixtures:
 *
 *   <name>.elf           the linked static binary, byte for byte what runs
 *   <name>.objdump.txt   llvm-objdump with raw encodings, the decoder oracle
 *   <name>.final.bin     the guest's own architectural state dump
 *   <name>.lockstep.txt  qemu's pre-instruction register state, delta encoded
 *
 * Committing the outputs is the point. The fixtures are generated against a
 * real reference here, and then the test suite replays them everywhere —
 * including on machines with no Docker and in CI — so differential coverage is
 * not contingent on the oracle being installed. Regenerating requires the
 * oracle; trusting the result does not.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateRandomProgram } from './rv64/random.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const PROGRAMS = join(HERE, 'rv64/programs')
const HARNESS = join(HERE, 'rv64')
const OUT = join(ROOT, 'src/isa/riscv/fixtures')

const CODEGEN = 'isa-bench/codegen-min:23.1.0'
const QEMU = 'isa-sim/qemu-user:11.1.0'
const TARGET = 'riscv64-unknown-linux-gnu'
const MARCH = 'rv64gc'
/** Keep in sync with ISA_DUMP_BYTES in tools/isa/rv64/harness.h. */
const DUMP_BYTES = 1552

/**
 * Seeds for the randomised programs. Fixed rather than drawn at build time so
 * that regenerating the fixtures reproduces the same programs, and so that a
 * failure is named by its seed. Adding a seed adds coverage without
 * disturbing anything already committed.
 */
const RANDOM_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]

/** Docker on Windows needs a drive-letter path, not the MSYS translation. */
function mountPath(path: string): string {
  return resolve(path).replace(/\\/g, '/')
}

function run(image: string, workdir: string, argv: string[]): Buffer {
  return execFileSync(
    'docker',
    [
      'run', '--rm', '--network', 'none',
      '-v', `${mountPath(workdir)}:/work`,
      '--entrypoint', argv[0]!,
      image,
      ...argv.slice(1),
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  )
}

function sh(image: string, workdir: string, script: string): string {
  return run(image, workdir, ['sh', '-c', script]).toString('utf8')
}

export interface LockstepStep {
  pc: bigint
  /** x0..x31; x0 is always zero but kept so indices are architectural. */
  x: bigint[]
}

/**
 * Parses `qemu -d in_asm,cpu,nochain -one-insn-per-tb` output.
 *
 * `in_asm` is emitted once per translation, `cpu` once per execution, so only
 * the cpu blocks form the trace; the in_asm lines are a disassembly cache
 * keyed by address, used to make a divergence report readable.
 */
export function parseQemuLog(text: string): {
  steps: LockstepStep[]
  disasm: Map<string, string>
} {
  const steps: LockstepStep[] = []
  const disasm = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  let pending: LockstepStep | null = null

  for (const line of lines) {
    const code = /^0x([0-9a-f]+):\s+([0-9a-f]+)\s+(.*)$/.exec(line)
    if (code) {
      disasm.set(BigInt(`0x${code[1]!}`).toString(16), `${code[2]!}  ${code[3]!.trim()}`)
      continue
    }
    const pc = /^\s*pc\s+([0-9a-f]+)\s*$/.exec(line)
    if (pc) {
      pending = { pc: BigInt(`0x${pc[1]!}`), x: Array.from({ length: 32 }, () => 0n) }
      steps.push(pending)
      continue
    }
    if (!pending) continue
    // " x0/zero  0 x1/ra    111d8 x2/sp    7ffffff0 x3/gp    0"
    const regs = [...line.matchAll(/x(\d{1,2})\/\w+\s+([0-9a-f]+)/g)]
    if (regs.length === 0) continue
    for (const match of regs) {
      pending.x[Number(match[1]!)] = BigInt(`0x${match[2]!}`)
    }
    if (regs.some((m) => Number(m[1]!) === 31)) pending = null
  }
  return { steps, disasm }
}

/** Delta encoding: step 0 lists every register, later steps only what changed. */
export function encodeLockstep(steps: readonly LockstepStep[]): string {
  const out: string[] = [
    '# rv64 lockstep v1',
    '# <pc> [x<n>=<hex>]*  — registers omitted are unchanged from the step before',
  ]
  let previous: bigint[] | null = null
  for (const step of steps) {
    const parts: string[] = [step.pc.toString(16)]
    for (let r = 0; r < 32; r++) {
      if (previous && previous[r] === step.x[r]) continue
      parts.push(`x${r}=${step.x[r]!.toString(16)}`)
    }
    out.push(parts.join(' '))
    previous = step.x
  }
  return `${out.join('\n')}\n`
}

function buildOne(name: string, source: string, work: string): void {
  writeFileSync(join(work, 'prog.c'), source)
  writeFileSync(join(work, 'harness.h'), readFileSync(join(HARNESS, 'harness.h')))
  writeFileSync(join(work, 'harness.c'), readFileSync(join(HARNESS, 'harness.c')))
  writeFileSync(join(work, 'harness.S'), readFileSync(join(HARNESS, 'harness.S')))

  const compile = [
    'clang', '-target', TARGET, `-march=${MARCH}`, '-O2',
    '-ffreestanding', '-fno-builtin', '-nostdlib', '-static',
    '-fuse-ld=lld', '-I/work',
    '-o', '/work/out.elf',
    '/work/harness.S', '/work/harness.c', '/work/prog.c',
  ]
  run(CODEGEN, work, compile)

  const objdump = sh(CODEGEN, work, 'llvm-objdump -d /work/out.elf')

  // Two qemu runs: one clean, so the state dump on fd 1 is not interleaved
  // with anything, and one logging the lockstep trace to a file.
  sh(QEMU, work, '/opt/qemu/bin/qemu-riscv64 /work/out.elf > /work/final.bin')
  sh(
    QEMU,
    work,
    '/opt/qemu/bin/qemu-riscv64 -one-insn-per-tb -d in_asm,cpu,nochain ' +
    '-D /work/trace.log /work/out.elf > /dev/null',
  )

  const elf = readFileSync(join(work, 'out.elf'))
  const final = readFileSync(join(work, 'final.bin'))
  const { steps } = parseQemuLog(readFileSync(join(work, 'trace.log'), 'utf8'))

  if (final.length !== DUMP_BYTES) {
    throw new Error(`${name}: guest dump was ${final.length} bytes, expected ${DUMP_BYTES}`)
  }
  if (steps.length === 0) throw new Error(`${name}: qemu produced no cpu trace`)

  writeFileSync(join(OUT, `${name}.elf`), elf)
  writeFileSync(join(OUT, `${name}.objdump.txt`), objdump)
  writeFileSync(join(OUT, `${name}.final.bin`), final)
  writeFileSync(join(OUT, `${name}.lockstep.txt`), encodeLockstep(steps))

  console.log(
    `${name.padEnd(14)} ${String(elf.length).padStart(6)} B elf   ` +
    `${String(steps.length).padStart(7)} steps`,
  )
}

function main(): void {
  mkdirSync(OUT, { recursive: true })
  const work = join(ROOT, 'node_modules/.tmp/rv64-fixtures')
  mkdirSync(work, { recursive: true })

  const names = readdirSync(PROGRAMS).filter((f) => f.endsWith('.c')).sort()
  if (names.length === 0) throw new Error(`no programs in ${PROGRAMS}`)

  const index: { name: string; steps: number; seed?: number }[] = []
  const record = (name: string, seed?: number) => {
    const encoded = readFileSync(join(OUT, `${name}.lockstep.txt`), 'utf8')
    const steps = encoded.trimEnd().split('\n').length - 2
    index.push(seed === undefined ? { name, steps } : { name, steps, seed })
  }

  for (const file of names) {
    const name = file.replace(/\.c$/, '')
    buildOne(name, readFileSync(join(PROGRAMS, file), 'utf8'), work)
    record(name)
  }

  for (const seed of RANDOM_SEEDS) {
    const program = generateRandomProgram(seed)
    const name = `random-${seed}`
    buildOne(name, program.source, work)
    // The generated source is committed alongside the fixture: a failing seed
    // should be readable without re-running the generator.
    writeFileSync(join(OUT, `${name}.c`), program.source)
    record(name, seed)
  }

  writeFileSync(
    join(OUT, 'index.json'),
    `${JSON.stringify(
      {
        generator: 'tools/isa/build-rv64-fixtures.ts',
        codegen: CODEGEN,
        oracle: QEMU,
        target: TARGET,
        march: MARCH,
        flags: '-O2 -ffreestanding -fno-builtin -nostdlib -static',
        randomGenerator: 'tools/isa/rv64/random.ts',
        randomSeeds: RANDOM_SEEDS,
        fixtures: index,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`\nwrote ${index.length} fixtures to ${OUT}`)
}

main()
