/**
 * Generic driver for capturing differential fixtures from a real oracle.
 *
 * Everything that differs between architectures is in a FixtureTarget: the
 * compiler triple, how to run the reference, where the guest harness lives,
 * how big its state dump is, and — the one that is easy to overlook — how to
 * parse that architecture's register dump out of the reference's log. RISC-V
 * prints ` pc  <hex>` followed by `x0/zero 0 x1/ra 0 ...`; AArch64 prints
 * `PC=<16 hex> X00=<16 hex> ...` with the stack pointer separate from the
 * numbered registers and PSTATE on the end. One parser cannot serve both, and
 * pretending otherwise would produce a trace that looked plausible and
 * compared nothing.
 *
 * The reference itself is not assumed to be qemu either. x86-64 is compared
 * against the processor the tests are running on, single-stepped through
 * ptrace, so an oracle is a pair of shell commands and the image to run them
 * in rather than a path to an emulator.
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

/**
 * How to obtain reference behaviour for a target.
 *
 * Two commands rather than one binary, because running a program and
 * recording what every instruction did are separate operations with
 * separate requirements, and for one target they are not even the same
 * tool.
 */
export interface Oracle {
  /** Docker image the commands run in. */
  image: string
  /** Extra `docker run` arguments this oracle needs, if any. */
  dockerArgs?: string[]
  /** Command that runs the guest, with nothing redirected. */
  run(elf: string): string
  /** Command that runs it and writes a register log to `log`. */
  trace(elf: string, log: string): string
}

/** An oracle that is a qemu linux-user emulator at a known path. */
export function qemuOracle(image: string, qemu: string): Oracle {
  return {
    image,
    // qemu places the guest's stack wherever the host's mmap puts it, so
    // with address-space randomisation on, the initial stack pointer in
    // every lockstep fixture changed on every capture and regenerating
    // could never come out clean. `setarch -R` turns it off, for which the
    // container needs the same relaxation as the native oracle below.
    dockerArgs: ['--security-opt', 'seccomp=unconfined'],
    run: (elf) => `setarch -R ${qemu} ${elf}`,
    trace: (elf, log) =>
      `setarch -R ${qemu} -one-insn-per-tb -d in_asm,cpu,nochain -D ${log} ${elf} > /dev/null`,
  }
}

/**
 * An oracle that is the host processor, single-stepped through ptrace.
 *
 * Turning off address-space randomisation needs a system call Docker's
 * default seccomp profile rejects, so the container is run without it. That
 * is a real relaxation, and it is confined to fixture generation: the
 * committed output is what the test suite reads, and nothing about running
 * the tests needs Docker at all.
 */
export function nativeOracle(image: string): Oracle {
  return {
    image,
    dockerArgs: ['--security-opt', 'seccomp=unconfined'],
    run: (elf) => elf,
    trace: (elf, log) => `isa-trace ${log} ${elf} > /dev/null`,
  }
}

/**
 * How to link, for a target whose codegen image cannot.
 *
 * `lld` does not support 32-bit SPARC -- it refuses with `unknown
 * emulation: elf32_sparc` -- so that target compiles in one image and
 * links in another with GNU binutils. Everything else links in place
 * and leaves this undefined.
 */
export interface ExternalLinker {
  image: string
  /** Command that links the named objects into `out`. */
  command(objects: readonly string[], out: string): string
}

export interface FixtureTarget {
  /** Short name, used for messages only. */
  id: string
  /** Docker image providing clang, lld and llvm-objdump. */
  codegen: string
  /** How to obtain reference behaviour. */
  oracle: Oracle
  triple: string
  /**
   * Architecture selector. Usually the value for `-march=`; a target
   * whose clang wants a different flag leaves this empty and puts the
   * flag in `extraFlags`, which is what SPARC does since clang rejects
   * `-march=` for it outright.
   */
  march: string
  /** Set when the codegen image's linker cannot handle this target. */
  linker?: ExternalLinker
  /** Extra clang arguments beyond the shared freestanding set. */
  extraFlags?: string[]
  /** Directory holding harness.h, harness.c and harness.S. */
  harnessDir: string
  /**
   * Programs every target compiles: ordinary C that prescribes no encoding.
   * What each target emits for them is the difference being compared, so the
   * source must be the same one.
   */
  sharedProgramsDir: string
  /** Programs written for this architecture, naming its instructions. */
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
  /**
   * The shell command that turns /work/prog.c into /work/out.elf, for a
   * target whose libc is not laid out the way musl's is. Given the
   * program's own extra flags. Absent means the musl recipe: one clang
   * invocation with lld.
   *
   * SPARC is the one user: its libc is picolibc with a platform layer of
   * this project's, and it has to link with GNU ld because lld cannot.
   */
  build?(flags: readonly string[]): string
}

/**
 * Flags for the architectural tier.
 *
 * Auto-vectorisation is off here and only here. These programs exist to pin
 * down named instructions, and a compiler that turns a run of stores into a
 * vector one is substituting its own choice for the thing under test. The
 * corpus and libc tiers keep plain -O2, so whatever a compiler really emits
 * for ordinary code -- vector instructions included -- still has to be
 * implemented and is still compared against the reference.
 */
const SHARED_FLAGS = [
  '-O2', '-fno-vectorize', '-fno-slp-vectorize',
  '-ffreestanding', '-fno-builtin', '-nostdlib', '-static',
]

/** Docker on Windows needs a drive-letter path, not the MSYS translation. */
function mountPath(path: string): string {
  return resolve(path).replace(/\\/g, '/')
}

function run(
  image: string,
  workdir: string,
  argv: string[],
  dockerArgs: readonly string[] = [],
): Buffer {
  return execFileSync(
    'docker',
    [
      'run', '--rm', '--network', 'none',
      ...dockerArgs,
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

/** Runs a command in the oracle's image, with whatever it needs to work. */
function oracleSh(oracle: Oracle, workdir: string, script: string): string {
  return run(oracle.image, workdir, ['sh', '-c', script], oracle.dockerArgs ?? []).toString('utf8')
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

  const sources = ['/work/harness.S', '/work/harness.c', '/work/prog.c']
  const archFlags = target.march ? [`-march=${target.march}`] : []
  if (target.linker) {
    // Compile to objects here and link in the other image. Each source
    // is named explicitly rather than compiled as a batch, because
    // harness.S and harness.c would otherwise both want harness.o.
    // The flags that belong to linking are dropped, since clang would
    // hand them to a linker it is not going to run.
    const objects = sources.map((source) =>
      source.replace(/\.[cS]$/, source.endsWith('.S') ? '-asm.o' : '.o'))
    for (let i = 0; i < sources.length; i++) {
      run(target.codegen, work, [
        'clang', '-target', target.triple, ...archFlags,
        ...SHARED_FLAGS.filter((flag) => flag !== '-static' && flag !== '-nostdlib'),
        ...(target.extraFlags ?? []), '-I/work', '-c',
        '-o', objects[i]!, sources[i]!,
      ])
    }
    sh(target.linker.image, work, target.linker.command(objects, '/work/out.elf'))
  } else {
    run(target.codegen, work, [
      'clang', '-target', target.triple, ...archFlags,
      ...SHARED_FLAGS, ...(target.extraFlags ?? []),
      '-fuse-ld=lld', '-I/work',
      '-o', '/work/out.elf',
      ...sources,
    ])
  }

  const objdump = sh(target.codegen, work, 'llvm-objdump -d /work/out.elf')

  // Two runs: one clean, so the state dump on fd 1 is not interleaved with
  // anything, and one logging the lockstep trace to a file.
  oracleSh(target.oracle, work, `${target.oracle.run('/work/out.elf')} > /work/final.bin`)
  oracleSh(target.oracle, work, target.oracle.trace('/work/out.elf', '/work/trace.log'))

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
    tier.build
      ? tier.build(flags)
      : `clang -target ${tier.triple} -O2 ${flags.join(' ')} -static -nostdlib ` +
        `-fuse-ld=lld -isystem ${s}/include ` +
        `-o /work/out.elf ${s}/lib/crt1.o ${s}/lib/crti.o /work/prog.c ` +
        `-L${s}/lib -lc ${tier.libs.join(' ')} ${tier.builtins} ${s}/lib/crtn.o`,
  ])
  oracleSh(
    target.oracle,
    work,
    `${target.oracle.run('/work/out.elf')} > /work/out.stdout 2>/work/out.stderr; ` +
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
  // The disassembly too, so the decode tier covers these binaries. They
  // are where the libc lives, and a libc reaches instructions no
  // freestanding program does -- on POWER, the whole of the vector unit.
  writeFileSync(join(target.outDir, `${name}.objdump.txt`),
    sh(target.codegen, work, 'llvm-objdump -d /work/out.elf'))
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

  const sources: { name: string; path: string }[] = []
  for (const [dir, prefix] of [[target.sharedProgramsDir, ''], [target.programsDir, '']] as const) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.c')).sort()) {
      sources.push({ name: prefix + file.replace(/\.c$/, ''), path: join(dir, file) })
    }
  }
  if (sources.length === 0) throw new Error(`no programs for ${target.id}`)
  sources.sort((a, b) => a.name.localeCompare(b.name))

  const index: { name: string; steps: number; seed?: number }[] = []
  for (const source of sources) {
    const steps = buildOne(target, source.name, readFileSync(source.path, 'utf8'), work)
    index.push({ name: source.name, steps })
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
        oracle: target.oracle.image,
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
