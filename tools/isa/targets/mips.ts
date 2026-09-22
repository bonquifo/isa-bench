/**
 * MIPS32 as a fixture target.
 *
 * qemu prints MIPS state in a shape of its own again: a `pc=` line that
 * also carries the HI and LO pair, then eight lines of four registers
 * each, named by their ABI names rather than numbered.
 *
 *   pc=0x00020160 HI=0x00000000 LO=0x00000000 ds 00e2 00000000 0
 *   GPR00: r0 00000000 at 00000000 v0 00000000 v1 00000000
 *   ...
 *   GPR28: gp 00000000 sp 2b2abe50 s8 00000000 ra 00000000
 *
 * Two things follow. The register index has to come from the `GPRnn:`
 * label rather than from the names, because the names are not in any
 * order a parser could exploit. And HI and LO are in the trace, so the
 * multiply and divide results can be compared before every instruction
 * rather than only at the end -- which matters here, because they are
 * written by one instruction and read by another several later.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORPUS_FLAGS, corpusPrograms } from '../corpus.ts'
import { qemuOracle, type FixtureTarget, type LockstepStep } from '../fixture-builder.ts'
import { generateRandomProgram } from '../mips/random.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(HERE, '..')
const ROOT = resolve(TOOLS, '../..')

/** r0..r31, then HI and LO. */
export const MIPS_GPR_COUNT = 34
export const MIPS_HI_SLOT = 32
export const MIPS_LO_SLOT = 33

export function parseMipsCpuLog(text: string): LockstepStep[] {
  const steps: LockstepStep[] = []
  let pending: LockstepStep | null = null

  for (const line of text.split(/\r?\n/)) {
    const pc = /^pc=0x([0-9a-f]+)/.exec(line)
    if (pc) {
      pending = {
        pc: BigInt(`0x${pc[1]!}`),
        x: Array.from({ length: MIPS_GPR_COUNT }, () => 0n),
      }
      const hi = /\bHI=0x([0-9a-f]+)/.exec(line)
      const lo = /\bLO=0x([0-9a-f]+)/.exec(line)
      if (hi) pending.x[MIPS_HI_SLOT] = BigInt(`0x${hi[1]!}`)
      if (lo) pending.x[MIPS_LO_SLOT] = BigInt(`0x${lo[1]!}`)
      steps.push(pending)
      continue
    }
    if (!pending) continue
    const group = /^GPR(\d{2}):(.*)$/.exec(line)
    if (!group) continue
    // The four values on the line are the four registers starting at the
    // index in the label. Their names are not used: they are the ABI's
    // rather than the architecture's, and two of them are `k0` and `k1`,
    // which no amount of ordering would make parseable.
    const base = Number(group[1]!)
    const values = [...group[2]!.matchAll(/\b([0-9a-f]{8})\b/g)]
    values.forEach((match, i) => {
      pending!.x[base + i] = BigInt(`0x${match[1]!}`)
    })
  }
  return steps
}

const RANDOM_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]

export const mipsTarget: FixtureTarget = {
  id: 'mips',
  codegen: 'isa-bench/codegen-min:23.1.0',
  oracle: qemuOracle('isa-sim/qemu-user:11.1.0', '/opt/qemu/bin/qemu-mipsel'),
  triple: 'mipsel-unknown-linux-gnu',
  march: 'mips32r2',
  // Two defaults have to change for a freestanding binary. lld looks for
  // __start rather than _start here. And the position-independent
  // convention expects a caller to have put the callee's own address in
  // t9 so the callee can compute the global pointer from it, which a
  // hand-written entry stub has not done -- so the first function that
  // uses the global pointer reads from nowhere.
  //
  // `-fno-pic` alone is what fixes it. Adding `-mno-abicalls`, which
  // reads as though it would help, does the opposite: it enables
  // gp-relative addressing of small data, so the code needs the global
  // pointer it was previously only computing.
  extraFlags: ['-Wl,-e,_start', '-fno-pic'],
  harnessDir: join(TOOLS, 'mips'),
  sharedProgramsDir: join(TOOLS, 'programs'),
  programsDir: join(TOOLS, 'mips/programs'),
  outDir: join(ROOT, 'src/isa/mips/fixtures'),
  workDir: join(ROOT, 'node_modules/.tmp/isa-fixtures/mips'),
  /** Keep in sync with ISA_DUMP_BYTES in tools/isa/mips/harness.h. */
  dumpBytes: 1424,
  gprCount: MIPS_GPR_COUNT,
  randomSeeds: RANDOM_SEEDS,
  randomGenerator: 'tools/isa/mips/random.ts',
  generateRandom: (seed: number) => generateRandomProgram(seed),
  parseCpuLog: parseMipsCpuLog,
  libc: {
    triple: 'mipsel-unknown-linux-musl',
    image: 'isa-bench/codegen-musl:23.1.0-1.2.5-r2',
    sysroot: '/sysroot/mipsel',
    builtins: '/sysroot/builtins/libclang_rt.builtins-mipsel.a',
    programsDir: join(TOOLS, 'libc'),
    libs: ['-lm'],
    extra: corpusPrograms().map((program) => ({
      name: program.name,
      source: program.source,
      flags: CORPUS_FLAGS,
    })),
  },
}
