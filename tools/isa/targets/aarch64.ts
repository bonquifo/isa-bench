/**
 * AArch64 as a fixture target.
 *
 * The parser below is the whole reason a FixtureTarget carries one. qemu
 * prints AArch64 state in a completely different shape from RISC-V:
 *
 *    PC=0000000000210120 X00=0000000000000000 X01=0000000000000000
 *   X02=0000000000000000 ...
 *   X29=0000000000000000 X30=0000000000000000  SP=000077c16b1f1d80
 *   PSTATE=0000000040000000 -Z-- EL0t  SVCR=00000000 --  BTYPE=0
 *
 * Two consequences. The stack pointer is not one of the numbered registers,
 * so it gets a slot of its own after them. And the condition flags *are* in
 * the trace, which RISC-V's fcsr is not — so on this target they can be
 * compared before every instruction rather than only at the end. That is a
 * significant gain, because flags are where an AArch64 interpreter is most
 * likely to be quietly wrong.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORPUS_FLAGS, corpusPrograms } from '../corpus.ts'
import { qemuOracle, type FixtureTarget, type LockstepStep } from '../fixture-builder.ts'
import { generateRandomProgram } from '../aarch64/random.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(HERE, '..')
const ROOT = resolve(TOOLS, '../..')

/** x0..x30, then sp, then the condition flags. */
export const AARCH64_GPR_COUNT = 33
export const AARCH64_SP_SLOT = 31
export const AARCH64_NZCV_SLOT = 32

/**
 * Only NZCV is compared out of PSTATE. The rest of that register describes
 * the exception level, the stack selector and the interrupt masks, which are
 * constant for a userspace program and are not modelled.
 */
const NZCV_MASK = 0xf0000000n

export function parseAarch64CpuLog(text: string): LockstepStep[] {
  const steps: LockstepStep[] = []
  let pending: LockstepStep | null = null

  for (const line of text.split(/\r?\n/)) {
    const pc = /^\s*PC=([0-9a-f]+)/.exec(line)
    if (pc) {
      pending = {
        pc: BigInt(`0x${pc[1]!}`),
        x: Array.from({ length: AARCH64_GPR_COUNT }, () => 0n),
      }
      steps.push(pending)
    }
    if (!pending) continue
    for (const match of line.matchAll(/X(\d{2})=([0-9a-f]+)/g)) {
      pending.x[Number(match[1]!)] = BigInt(`0x${match[2]!}`)
    }
    const sp = /\bSP=([0-9a-f]+)/.exec(line)
    if (sp) pending.x[AARCH64_SP_SLOT] = BigInt(`0x${sp[1]!}`)
    // PSTATE closes the block, so a run of them cannot merge.
    const pstate = /\bPSTATE=([0-9a-f]+)/.exec(line)
    if (pstate) {
      pending.x[AARCH64_NZCV_SLOT] = BigInt(`0x${pstate[1]!}`) & NZCV_MASK
      pending = null
    }
  }
  return steps
}

const RANDOM_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]

export const aarch64Target: FixtureTarget = {
  id: 'aarch64',
  codegen: 'isa-bench/codegen-min:23.1.0',
  oracle: qemuOracle('isa-sim/qemu-user:11.1.0', '/opt/qemu/bin/qemu-aarch64'),
  triple: 'aarch64-unknown-linux-gnu',
  march: 'armv8-a',
  harnessDir: join(TOOLS, 'aarch64'),
  sharedProgramsDir: join(TOOLS, 'programs'),
  programsDir: join(TOOLS, 'aarch64/programs'),
  outDir: join(ROOT, 'src/isa/aarch64/fixtures'),
  workDir: join(ROOT, 'node_modules/.tmp/isa-fixtures/aarch64'),
  /** Keep in sync with ISA_DUMP_BYTES in tools/isa/aarch64/harness.h. */
  dumpBytes: 1824,
  gprCount: AARCH64_GPR_COUNT,
  randomSeeds: RANDOM_SEEDS,
  randomGenerator: 'tools/isa/aarch64/random.ts',
  generateRandom: (seed: number) => generateRandomProgram(seed),
  parseCpuLog: parseAarch64CpuLog,
  libc: {
    triple: 'aarch64-unknown-linux-musl',
    image: 'isa-bench/codegen-musl:23.1.0-1.2.5-r2',
    sysroot: '/sysroot/aarch64',
    builtins: '/sysroot/builtins/libclang_rt.builtins-aarch64.a',
    programsDir: join(TOOLS, 'libc'),
    libs: ['-lm'],
    extra: corpusPrograms().map((program) => ({
      name: program.name,
      source: program.source,
      flags: CORPUS_FLAGS,
    })),
  },
}
