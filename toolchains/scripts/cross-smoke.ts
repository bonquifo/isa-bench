import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseResultFrame } from '../../src/toolchains/resultFrame.ts'

const root = resolve(import.meta.dirname, '..', '..')
const directory = mkdtempSync(join(tmpdir(), 'isa-cross-smoke-'))
const configurations = {
  'aarch64-linux': {
    triple: 'aarch64-unknown-linux-gnu',
    flags: [],
    qemu: 'qemu-aarch64',
  },
  'riscv64-linux': {
    triple: 'riscv64-unknown-linux-gnu',
    flags: ['-march=rv64gc', '-mabi=lp64d'],
    qemu: 'qemu-riscv64',
  },
  'mipsel-o32': {
    triple: 'mipsel-unknown-linux-gnu',
    flags: ['-march=mips32', '-mabi=o32', '-mno-abicalls', '-fno-pic'],
    qemu: 'qemu-mipsel',
  },
  'powerpc64le-elfv2': {
    triple: 'powerpc64le-unknown-linux-gnu',
    flags: ['-mabi=elfv2'],
    qemu: 'qemu-ppc64le',
  },
  'sparc-v8': {
    triple: 'sparc-unknown-linux-gnu',
    flags: ['-mcpu=v8'],
    qemu: 'qemu-sparc',
  },
} as const
const observations: Record<string, unknown> = {}

try {
  writeFileSync(join(directory, 'canonical.ll'), readFileSync(join(root, '.isa-bench-data/toolchain-smoke/canonical.ll')))
  writeFileSync(join(directory, 'runtime.c'), readFileSync(join(root, 'toolchains/runtime/linux-freestanding.c')))
  for (const [target, config] of Object.entries(configurations)) {
    if (process.argv[2] && process.argv[2] !== target) continue
    process.stderr.write(`cross-smoke ${target}\n`)
    const binary = `${target}.elf`
    const compile = [
      'clang', '-target', config.triple, ...config.flags, '-fuse-ld=lld', '-nostdlib', '-static',
      '-fno-stack-protector', '-fno-builtin', '-Wl,-e,_start',
      '/artifacts/canonical.ll', '/artifacts/runtime.c', '-o', `/artifacts/${binary}`,
    ]
    const sparcCompile = [
      ['clang', '-target', config.triple, ...config.flags, '-fno-stack-protector', '-fno-builtin',
        '-c', '/artifacts/canonical.ll', '-o', '/artifacts/sparc-core.o'],
      ['clang', '-target', config.triple, ...config.flags, '-fno-stack-protector', '-fno-builtin',
        '-c', '/artifacts/runtime.c', '-o', '/artifacts/sparc-runtime.o'],
      ['sparc64-linux-gnu-ld', '-m', 'elf32_sparc', '-static', '-e', '_start',
        '/artifacts/sparc-core.o', '/artifacts/sparc-runtime.o', '-o', `/artifacts/${binary}`],
    ]
    try {
      if (target === 'sparc-v8') {
        await runText('docker', hardened('isa-sim/codegen:23.1.0', sparcCompile[0]!, directory))
        await runText('docker', hardened('isa-sim/codegen:23.1.0', sparcCompile[1]!, directory))
        await runText('docker', hardened('isa-sim/sparc-linker:2.40-2', sparcCompile[2]!, directory))
      } else {
        await runText('docker', hardened('isa-sim/codegen:23.1.0', compile, directory))
      }
      const started = performance.now()
      const bytes = await runBytes('docker', hardened('isa-sim/qemu-user:11.1.0', [
        config.qemu, ...(target === 'mipsel-o32' ? ['-strace'] : []), `/artifacts/${binary}`,
      ], directory))
      const durationMs = performance.now() - started
      const frame = parseResultFrame(bytes)
      if (frame.status !== 'ok' || frame.resultKind !== 'i32' || frame.rawBits !== 0x11223300n) {
        throw new Error(`unexpected result frame ${JSON.stringify({
          status: frame.status, kind: frame.resultKind, bits: frame.rawBits.toString(16),
        })}`)
      }
      observations[target] = {
        tier: 'execute',
        smokeWallClockMs: durationMs,
        timingClaim: 'none; wall clock includes Docker startup and is diagnostic only',
        frame: { version: frame.version, kind: frame.resultKind, rawBits: `0x${frame.rawBits.toString(16)}` },
        compile: target === 'sparc-v8' ? sparcCompile : [compile],
        execute: [config.qemu, `/artifacts/${binary}`],
      }
    } catch (error) {
      observations[target] = {
        tier: 'codegen-only',
        reason: error instanceof Error ? error.message : String(error),
        compile: target === 'sparc-v8' ? sparcCompile : [compile],
      }
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    imagesLockSha256: await sha256(readFileSync(join(root, 'toolchains/images.lock.json'))),
    observations,
  }
  if (!process.argv[2]) {
    writeFileSync(join(root, 'toolchains/capabilities.lock.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

function hardened(image: string, argv: string[], mount: string): string[] {
  const name = `isa-cross-${crypto.randomUUID()}`
  return [
    'run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
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
    const nameIndex = args.indexOf('--name')
    const containerName = nameIndex >= 0 ? args[nameIndex + 1] : undefined
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      if (containerName) {
        const killer = spawn('docker', ['kill', containerName], { shell: false, windowsHide: true })
        killer.on('error', () => undefined)
      }
    }, 15_000)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`${command} exceeded 15000 ms timeout: ${Buffer.concat(stderr).toString('utf8').slice(-8192)}`))
      else if (code === 0) resolveRun(Buffer.concat(stdout))
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-8192)}`))
    })
  })
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Buffer.from(digest).toString('hex')
}
