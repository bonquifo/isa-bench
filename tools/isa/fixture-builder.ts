/**
 * Generic driver for capturing differential fixtures from a real oracle.
 *
 * Everything that differs between architectures is in a FixtureTarget: the
 * compiler triple, which qemu binary to run, where the guest harness lives,
 * how big its state dump is, and — the one that is easy to overlook — how to
 * parse that architecture's register dump out of qemu's log. RISC-V prints
 * ` pc  <hex>` followed by `x0/zero 0 x1/ra 0 ...`; AArch64 prints
 * `PC=<16 hex> X00=<16 hex> ...` with the stack pointer separate from the
 * numbered registers and PSTATE on the end. One parser cannot serve both, and
 * pretending otherwise would produce a trace that looked plausible and
 * compared nothing.
 *
 * What is *not* per-target: the four artefacts, the delta encoding, the
 * two-run capture, and the index. Those are the shared contract that
 * src/isa/common/fixtures.node.ts reads back.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface LockstepStep {
  pc: bigint
  /** General-purpose registers in the target's own numbering. */
  x: bigint[]
}

export interface FixtureTarget {
  /** Short name, used for messages only. */
  id: string
  /** Docker image providing clang, lld and llvm-objdump. */
  codegen: string
  /** Docker image providing the reference emulator. */
  oracle: string
  /** Path to the emulator inside that image. */
  qemu: string
  triple: string
  march: string
  /** Extra clang arguments beyond the shared freestanding set. */
  extraFlags?: string[]
  /** Directory holding harness.h, harness.c and harness.S. */
  harnessDir: string
  /** Directory of hand-written programs, one per .c file. */
  programsDir: string
  /** Where the four artefacts per program are written. */
  outDir: string
  /** Scratch directory for intermediate build products. */
  workDir: string
  /** Size of the architectural state dump the harness writes. */
  dumpBytes: number
  gprCount: number
  randomSeeds: number[]
  randomGenerator: string
  generateRandom(seed: number): { source: string }
  parseCpuLog(text: string): LockstepStep[]
  /** Optional second tier: whole programs linked against a real libc. */
  libc?: LibcTier
}

/**
 * Programs compiled against a cross libc, compared on what they print rather
 * than on architectural state.
 *
 * Architectural comparison is not available here and cannot be made so. A
 * libc owns the entry point, and it reads argc, argv, the environment and the
 * auxiliary vector off the initial stack -- which under qemu contains the
 * container's real environment and a full kernel-supplied aux vector, and
 * under the interpreter contains a synthetic one. The two processes therefore
 * start from genuinely different state, and their registers diverge
 * immediately and legitimately.
 *
 * What must still agree exactly is the output and the exit status, which is
 * the property anyone actually depends on.
 */
export interface LibcTier {
  /**
   * Target triple for the libc build. Distinct from the freestanding one:
   * musl is its own environment, and clang's driver behaves differently for
   * `-musl` than for `-gnu`.
   */
  triple: string
  /** Docker image carrying the cross sysroot. */
  image: string
  /** Sysroot directory inside that image. */
  sysroot: string
  /** compiler-rt builtins archive inside that image. */
  builtins: string
  /** Directory of programs, each with a main(). */
  programsDir: string
  /** Extra libraries, after -lc. */
  libs: string[]
  /**
   * Further programs supplied in memory rather than from a directory, with
   * their own compiler flags. Used for the app's own corpus, which lives in
   * the source tree and needs signed overflow defined.
   */
  extra?: { name: string; source: string; flags: string[] }[]
}

const SHARED_FLAGS = ['-O2', '-ffreestanding', '-fno-builtin', '-nostdlib', '-static']

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

/** Step 0 lists every register; later steps list only what changed. */
export function encodeLockstep(steps: readonly LockstepStep[], gprCount: number): string {
  const out: string[] = [
    '# lockstep v1',
    '# <pc> [x<n>=<hex>]*  — registers omitted are unchanged from the step before',
  ]
  let previous: bigint[] | null = null
  for (const step of steps) {
    const parts: string[] = [step.pc.toString(16)]
    for (let r = 0; r < gprCount; r++) {
      if (previous && previous[r] === step.x[r]) continue
      parts.push(`x${r}=${(step.x[r] ?? 0n).toString(16)}`)
    }
    out.push(parts.join(' '))
    previous = step.x
  }
  return `${out.join('\n')}\n`
}

function buildOne(target: FixtureTarget, name: string, source: string, work: string): number {
  writeFileSync(join(work, 'prog.c'), source)
  for (const file of ['harness.h', 'harness.c', 'harness.S']) {
    writeFileSync(join(work, file), readFileSync(join(target.harnessDir, file)))
  }

  run(target.codegen, work, [
    'clang', '-target', target.triple, `-march=${target.march}`,
    ...SHARED_FLAGS, ...(target.extraFlags ?? []),
    '-fuse-ld=lld', '-I/work',
    '-o', '/work/out.elf',
    '/work/harness.S', '/work/harness.c', '/work/prog.c',
  ])

  const objdump = sh(target.codegen, work, 'llvm-objdump -d /work/out.elf')

  // Two runs: one clean, so the state dump on fd 1 is not interleaved with
  // anything, and one logging the lockstep trace to a file.
  sh(target.oracle, work, `${target.qemu} /work/out.elf > /work/final.bin`)
  sh(
    target.oracle,
    work,
    `${target.qemu} -one-insn-per-tb -d in_asm,cpu,nochain ` +
    '-D /work/trace.log /work/out.elf > /dev/null',
  )

  const elf = readFileSync(join(work, 'out.elf'))
  const final = readFileSync(join(work, 'final.bin'))
  const steps = target.parseCpuLog(readFileSync(join(work, 'trace.log'), 'utf8'))

  if (final.length !== target.dumpBytes) {
    throw new Error(`${name}: guest dump was ${final.length} bytes, expected ${target.dumpBytes}`)
  }
  if (steps.length === 0) throw new Error(`${name}: the oracle produced no cpu trace`)

  writeFileSync(join(target.outDir, `${name}.elf`), elf)
  writeFileSync(join(target.outDir, `${name}.objdump.txt`), objdump)
  writeFileSync(join(target.outDir, `${name}.final.bin`), final)
  writeFileSync(join(target.outDir, `${name}.lockstep.txt`), encodeLockstep(steps, target.gprCount))

  console.log(
    `${name.padEnd(14)} ${String(elf.length).padStart(6)} B elf   ` +
    `${String(steps.length).padStart(7)} steps`,
  )
  return steps.length
}

function buildLibcOne(
  target: FixtureTarget,
  name: string,
  source: string,
  work: string,
  flags: string[] = [],
): { exitCode: number; stderr: string } {
  const tier = target.libc!
  writeFileSync(join(work, 'prog.c'), source)
  const s = tier.sysroot
  run(tier.image, work, [
    'sh', '-c',
    `clang -target ${tier.triple} -O2 ${flags.join(' ')} -static -nostdlib ` +
    `-fuse-ld=lld -isystem ${s}/include ` +
    `-o /work/out.elf ${s}/lib/crt1.o ${s}/lib/crti.o /work/prog.c ` +
    `-L${s}/lib -lc ${tier.libs.join(' ')} ${tier.builtins} ${s}/lib/crtn.o`,
  ])
  sh(
    target.oracle,
    work,
    `${target.qemu} /work/out.elf > /work/out.stdout 2>/work/out.stderr; ` +
    'echo $? > /work/out.exit',
  )

  const elf = readFileSync(join(work, 'out.elf'))
  const stdout = readFileSync(join(work, 'out.stdout'))
  const stderr = readFileSync(join(work, 'out.stderr'), 'utf8')
  const exitCode = Number(readFileSync(join(work, 'out.exit'), 'utf8').trim())
  // A program that produces nothing at all did not run. Printing nothing to
  // stdout alone is legitimate: several corpus programs only return a value,
  // which the driver writes to stderr.
  if (stdout.length === 0 && stderr.length === 0) {
    throw new Error(`${name}: the reference produced no output at all`)
  }

  writeFileSync(join(target.outDir, `${name}.elf`), elf)
  writeFileSync(join(target.outDir, `${name}.stdout`), stdout)
  if (stderr.length > 0) writeFileSync(join(target.outDir, `${name}.stderr`), stderr)
  console.log(
    `${name.padEnd(16)} ${String(elf.length).padStart(6)} B elf   ` +
    `${String(stdout.length).padStart(7)} B stdout  exit ${exitCode}`,
  )
  return { exitCode, stderr }
}

export function buildFixtures(target: FixtureTarget): void {
  mkdirSync(target.outDir, { recursive: true })
  const work = target.workDir
  mkdirSync(work, { recursive: true })

  const names = readdirSync(target.programsDir).filter((f) => f.endsWith('.c')).sort()
  if (names.length === 0) throw new Error(`no programs in ${target.programsDir}`)

  const index: { name: string; steps: number; seed?: number }[] = []
  for (const file of names) {
    const name = file.replace(/\.c$/, '')
    const steps = buildOne(target, name, readFileSync(join(target.programsDir, file), 'utf8'), work)
    index.push({ name, steps })
  }

  for (const seed of target.randomSeeds) {
    const name = `random-${seed}`
    const program = target.generateRandom(seed)
    const steps = buildOne(target, name, program.source, work)
    // The generated source is committed beside the fixture: a failing seed
    // should be readable without re-running the generator.
    writeFileSync(join(target.outDir, `${name}.c`), program.source)
    index.push({ name, steps, seed })
  }

  const libc: { name: string; exitCode: number; stderr?: string }[] = []
  if (target.libc) {
    const libcNames = readdirSync(target.libc.programsDir).filter((f) => f.endsWith('.c')).sort()
    for (const file of libcNames) {
      const name = `libc-${file.replace(/\.c$/, '')}`
      const source = readFileSync(join(target.libc.programsDir, file), 'utf8')
      libc.push({ name, ...buildLibcOne(target, name, source, work) })
    }
    for (const program of target.libc.extra ?? []) {
      const result = buildLibcOne(target, program.name, program.source, work, program.flags)
      libc.push({ name: program.name, ...result })
    }
  }

  writeFileSync(
    join(target.outDir, 'index.json'),
    `${JSON.stringify(
      {
        generator: 'tools/isa/fixture-builder.ts',
        codegen: target.codegen,
        oracle: target.oracle,
        target: target.triple,
        march: target.march,
        flags: SHARED_FLAGS.join(' '),
        randomGenerator: target.randomGenerator,
        randomSeeds: target.randomSeeds,
        fixtures: index,
        libcImage: target.libc?.image ?? null,
        libcFixtures: libc,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`\nwrote ${index.length + libc.length} fixtures to ${target.outDir}`)
}
