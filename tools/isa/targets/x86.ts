/**
 * x86-64 as a fixture target.
 *
 * The oracle is the host processor rather than an emulator, which is worth
 * saying plainly: every other target here is compared against qemu, which
 * is a second implementation of the same specification and could in
 * principle be wrong in the same way an interpreter is. On this one target
 * that doubt can be removed, because the machine running the tests is the
 * machine the code is for.
 *
 * The log the tracer writes is therefore this project's own format rather
 * than qemu's, and is deliberately the simplest thing that can be parsed
 * without ambiguity: one line per instruction, every register on it.
 *
 *   PC=401000 R00=0 R01=0 ... R15=0 FL=246
 *
 * The flags are the sixteenth slot. Putting them in the general-register
 * array rather than beside it is what lets the shared conformance suite
 * compare them before every instruction, which matters more here than on
 * any other target: on x86 nearly every instruction writes them.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORPUS_FLAGS, corpusPrograms } from '../corpus.ts'
import { nativeOracle, type FixtureTarget, type LockstepStep } from '../fixture-builder.ts'
import { generateRandomProgram } from '../x86/random.ts'
import { RunState, createRetireChunk } from '../../../src/isa/common/trace.ts'
import { x86Backend } from '../../../src/isa/x86/backend.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(HERE, '..')
const ROOT = resolve(TOOLS, '../..')

/** rax..r15, then the arithmetic flags. */
export const X86_GPR_COUNT = 17
export const X86_FLAGS_SLOT = 16

export function parseX86TraceLog(text: string): LockstepStep[] {
  const steps: LockstepStep[] = []
  for (const line of text.split(/\r?\n/)) {
    const pc = /^PC=([0-9a-f]+)/.exec(line)
    if (!pc) continue
    const step: LockstepStep = {
      pc: BigInt(`0x${pc[1]!}`),
      x: Array.from({ length: X86_GPR_COUNT }, () => 0n),
    }
    for (const match of line.matchAll(/R(\d{2})=([0-9a-f]+)/g)) {
      step.x[Number(match[1]!)] = BigInt(`0x${match[2]!}`)
    }
    const flags = /\bFL=([0-9a-f]+)/.exec(line)
    if (flags) step.x[X86_FLAGS_SLOT] = BigInt(`0x${flags[1]!}`)
    steps.push(step)
  }
  return steps
}

const RANDOM_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]

/**
 * Zeroes, at every step, the flag bits the architecture leaves undefined.
 *
 * After a divide, a multiply or a multi-bit shift, some arithmetic flags
 * are undefined, and a processor puts something there regardless -- a
 * different something on an Intel part than on an AMD one. Recorded as
 * captured, the fixtures therefore changed with the machine that made
 * them, and CI, whose runners are not all the same processor, could never
 * regenerate them cleanly. The lockstep comparison already ignores these
 * bits (they are the ones the interpreter declares undefined through
 * `undefinedBits`), so zeroing them removes nothing a test reads.
 *
 * The interpreter is stepped exactly as the lockstep test steps it. If it
 * leaves the recorded path it stops rewriting there, and the test will
 * report the divergence the same way it would have.
 */
function zeroUndefinedFlags(elf: Uint8Array, steps: LockstepStep[]): void {
  const initialRegisters = steps[0]!.x.map((value) => BigInt.asIntN(64, value))
  const { interpreter } = x86Backend.load(elf, { initialRegisters })
  const chunk = createRetireChunk(1)
  let rewritten = 0
  for (const step of steps) {
    if (interpreter.programCounter !== step.pc) break
    for (let r = 0; r < step.x.length; r++) {
      const unspecified = interpreter.undefinedBits?.(r) ?? 0n
      if (unspecified !== 0n && (step.x[r]! & unspecified) !== 0n) {
        step.x[r] = step.x[r]! & ~unspecified
        rewritten += 1
      }
    }
    if (interpreter.run(chunk) !== RunState.MORE) break
  }
  if (rewritten > 0) console.log(`  zeroed undefined flag bits at ${rewritten} steps`)
}

export const x86Target: FixtureTarget = {
  id: 'x86',
  codegen: 'isa-bench/codegen-min:23.1.0',
  oracle: nativeOracle('isa-bench/native-x86:1'),
  triple: 'x86_64-unknown-linux-gnu',
  march: 'x86-64',
  harnessDir: join(TOOLS, 'x86'),
  sharedProgramsDir: join(TOOLS, 'programs'),
  programsDir: join(TOOLS, 'x86/programs'),
  outDir: join(ROOT, 'src/isa/x86/fixtures'),
  workDir: join(ROOT, 'node_modules/.tmp/isa-fixtures/x86'),
  /** Keep in sync with ISA_DUMP_BYTES in tools/isa/x86/harness.h. */
  dumpBytes: 8592,
  gprCount: X86_GPR_COUNT,
  randomSeeds: RANDOM_SEEDS,
  randomGenerator: 'tools/isa/x86/random.ts',
  generateRandom: (seed: number) => generateRandomProgram(seed),
  parseCpuLog: parseX86TraceLog,
  canonicalize: zeroUndefinedFlags,
  libc: {
    triple: 'x86_64-unknown-linux-musl',
    image: 'isa-bench/codegen-musl:23.1.0-1.2.5-r3',
    sysroot: '/sysroot/x86_64',
    builtins: '/sysroot/builtins/libclang_rt.builtins-x86_64.a',
    programsDir: join(TOOLS, 'libc'),
    libs: ['-lm'],
    extra: corpusPrograms().map((program) => ({
      name: program.name,
      source: program.source,
      flags: CORPUS_FLAGS,
    })),
  },
}
