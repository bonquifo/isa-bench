/**
 * Captures the WebAssembly fixtures.
 *
 *   npx vite-node tools/isa/wasm/build-fixtures.ts
 *
 * Requires Docker and `isa-sim/wasi:33.0-48.0.1`, which carries both the
 * WASI SDK and wasmtime. The output is committed, so this runs when the
 * programs or the toolchain change -- not as part of the test suite.
 *
 * ## Why this does not use the shared fixture builder
 *
 * tools/isa/fixture-builder.ts captures four artefacts per program: an
 * ELF, a disassembly, a per-instruction register log from qemu, and the
 * guest's own dump of its architectural state. Three of the four have no
 * counterpart here.
 *
 * There is no ELF -- a module is its own container. There is no register
 * log, because no engine will single-step and report state; that is the
 * same absence the 6502 has, and it is answered the same way, with a
 * different tier rather than a worse version of this one. And there is no
 * guest dump, because the engine hands over the module's entire linear
 * memory, which is a stronger thing to compare than any dump a harness
 * could write.
 *
 * What is captured instead:
 *
 *   <name>.wasm          the module
 *   <name>.objdump.txt   LLVM's disassembly, for the decode tier
 *   corpus-<id>.wasm     the app's own programs, against a real libc
 *   corpus-<id>.stdout   what wasmtime printed
 *
 * No behaviour is recorded for the freestanding modules, and that is the
 * point of them: the engine that would produce a recording is the same
 * one the tests run inside, so they are compared live instead.
 *
 * `randomSeeds` in the index is empty for the same reason. The seeds the
 * generated tier uses live in src/isa/wasm/conformance.test.ts, next to
 * the comparison they drive, because nothing has to be captured for them
 * first.
 *
 * ## Two oracles, deliberately
 *
 * The freestanding programs are compared against **Node's own engine**,
 * in process, at test time -- so that tier needs no recording at all and
 * cannot go stale. The recording here exists for the corpus tier, whose
 * oracle is **wasmtime**: a different engine, from a different vendor,
 * with a different compiler. Agreement between the interpreter and both
 * of them says rather more than agreement with either.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORPUS_FLAGS, corpusPrograms } from '../corpus.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(HERE, '..')
const ROOT = resolve(TOOLS, '../..')
const OUT = join(ROOT, 'src/isa/wasm/fixtures')
const WORK = join(ROOT, 'node_modules/.tmp/isa-fixtures/wasm')

const IMAGE = 'isa-sim/wasi:33.0-48.0.1'
const CLANG = '/opt/wasi-sdk/bin/clang'
const OBJDUMP = '/opt/wasi-sdk/bin/llvm-objdump'
const WASMTIME = '/opt/wasmtime/wasmtime'

/**
 * The freestanding triple. `wasm32-wasip1` would link the libc startup
 * and its five imports into programs that have no use for them; these
 * ones export a function and are called directly.
 */
const FREESTANDING = [
  '--target=wasm32', '-O2',
  '-ffreestanding', '-fno-builtin', '-nostdlib',
  '-Wl,--no-entry', '-Wl,--export-memory',
  // Without this the linker garbage-collects everything the export
  // attributes name, and the module comes out empty and passing.
  '-Wl,--export-dynamic',
  '-fno-vectorize', '-fno-slp-vectorize',
]

/** The libc triple, for the corpus. */
const HOSTED = ['--target=wasm32-wasip1', '-O2', ...CORPUS_FLAGS]

function mountPath(path: string): string {
  return resolve(path).replace(/\\/g, '/')
}

function sh(script: string): string {
  return execFileSync(
    'docker',
    [
      'run', '--rm', '--network', 'none',
      '-e', 'HOME=/tmp',
      '-v', `${mountPath(WORK)}:/work`,
      '-w', '/work',
      '--entrypoint', 'sh',
      IMAGE, '-c', script,
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  ).toString('utf8')
}

function main(): void {
  mkdirSync(WORK, { recursive: true })
  mkdirSync(OUT, { recursive: true })

  // ---- The shared freestanding programs -----------------------------
  const sharedDir = join(TOOLS, 'programs')
  const names = readdirSync(sharedDir)
    .filter((file) => file.endsWith('.c'))
    .map((file) => file.slice(0, -2))
    .sort()

  writeFileSync(join(WORK, 'harness.h'), readFileSync(join(HERE, 'harness.h')))
  writeFileSync(join(WORK, 'harness.c'), readFileSync(join(HERE, 'harness.c')))
  for (const name of names) {
    writeFileSync(join(WORK, `${name}.c`), readFileSync(join(sharedDir, `${name}.c`)))
  }

  const flags = FREESTANDING.join(' ')
  sh(names.map((name) =>
    `${CLANG} ${flags} -o ${name}.wasm ${name}.c harness.c`).join(' && '))
  sh(names.map((name) =>
    `${OBJDUMP} -d ${name}.wasm > ${name}.objdump.txt`).join(' && '))

  for (const name of names) {
    writeFileSync(join(OUT, `${name}.wasm`), readFileSync(join(WORK, `${name}.wasm`)))
    writeFileSync(join(OUT, `${name}.objdump.txt`),
      readFileSync(join(WORK, `${name}.objdump.txt`)))
  }

  // ---- The corpus, against a real libc ------------------------------
  const corpus = corpusPrograms()
  for (const program of corpus) {
    writeFileSync(join(WORK, `${program.name}.c`), program.source)
  }

  const built: string[] = []
  const failed: { name: string; error: string }[] = []
  for (const program of corpus) {
    try {
      sh(`${CLANG} ${HOSTED.join(' ')} -o ${program.name}.wasm ${program.name}.c -lm`)
      built.push(program.name)
    } catch (error) {
      failed.push({ name: program.name, error: String(error).slice(0, 400) })
    }
  }

  // wasmtime is the oracle for these: a different engine from the one the
  // freestanding tier compares against.
  const results: Record<string, { exitCode: number; stderr: string }> = {}
  for (const name of built) {
    const script =
      `${WASMTIME} run ${name}.wasm > ${name}.stdout 2> ${name}.stderr; ` +
      `echo $? > ${name}.exit`
    sh(script)
    const exitCode = Number(readFileSync(join(WORK, `${name}.exit`), 'utf8').trim())
    const stderr = readFileSync(join(WORK, `${name}.stderr`), 'utf8')
    results[name] = { exitCode, stderr }
    writeFileSync(join(OUT, `${name}.wasm`), readFileSync(join(WORK, `${name}.wasm`)))
    writeFileSync(join(OUT, `${name}.stdout`), readFileSync(join(WORK, `${name}.stdout`)))
  }

  const index = {
    generator: 'tools/isa/wasm/build-fixtures.ts',
    codegen: IMAGE,
    oracle: `${IMAGE} (wasmtime) and the host engine at test time`,
    target: 'wasm32 / wasm32-wasip1',
    march: '',
    flags: FREESTANDING.join(' '),
    randomGenerator: 'src/isa/wasm/generate.node.ts',
    randomSeeds: [] as number[],
    fixtures: names.map((name) => ({ name, steps: 0 })),
    libcImage: IMAGE,
    libcFixtures: built.map((name) => ({
      name,
      exitCode: results[name]!.exitCode,
      ...(results[name]!.stderr ? { stderr: results[name]!.stderr } : {}),
    })),
    /** Corpus programs the toolchain refused, with the reason. */
    unbuilt: failed,
  }
  writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)

  console.log(`freestanding: ${names.join(', ')}`)
  console.log(`corpus built: ${built.length}/${corpus.length}`)
  for (const item of failed) console.log(`  refused: ${item.name}`)
}

main()
