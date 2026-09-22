/**
 * POWER (powerpc64le) as a fixture target.
 *
 * qemu prints this architecture's state in a shape of its own again,
 * and the part that matters is what it leaves out. The dump has the
 * general registers, the link and count registers, the condition
 * register and the exception register -- and none of the 32
 * floating-point registers. On this target that is not a detail: at
 * `-O2` clang compiles `double` arithmetic to the VSX forms, whose
 * results live in exactly those registers, so the lockstep tier can see
 * a floating-point program's control flow and not its answers. The
 * guest's own dump is what covers them, which is the reason that
 * mechanism exists.
 *
 * The other awkwardness is that one dump spans eleven lines with the
 * registers four to a row and the condition register on the end, so the
 * parser matches a block rather than a line.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { qemuOracle, type FixtureTarget, type LockstepStep } from '../fixture-builder.ts'
import { generateRandomProgram } from '../power/random.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(HERE, '..')
const ROOT = resolve(TOOLS, '../..')

/**
 * r0..r31, then the link register, the count register, the exception
 * register, and the eight condition fields one slot each. The order
 * matches the resource ids in src/isa/power/image.ts, so a mismatch is
 * labelled with the name of the thing that actually differs.
 *
 * Those last eleven are in the comparison because they are where this
 * architecture keeps what others keep in flags and in the program
 * counter. `lr` and `ctr` are both branch targets. `cr` is eight
 * independent conditions, which is why it is eight slots rather than
 * one. And `xer` holds carry -- a register here, so an
 * extended-precision add is a chain through it and nothing else would
 * notice a wrong link.
 */
export const POWER_GPR_COUNT = 43
export const POWER_LR_SLOT = 32
export const POWER_CTR_SLOT = 33
export const POWER_XER_SLOT = 34
/** The eight condition fields, each its own slot. */
export const POWER_CR_SLOT = 35

const RANDOM_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]

const BLOCK = new RegExp(
  String.raw`NIP ([0-9a-f]+)\s+LR ([0-9a-f]+) CTR ([0-9a-f]+) XER ([0-9a-f]+)` +
  String.raw`[^]*?\n((?:GPR\d\d[^\n]*\n){8})CR ([0-9a-f]+)`,
  'g',
)

export function parsePowerCpuLog(text: string): LockstepStep[] {
  const steps: LockstepStep[] = []
  BLOCK.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BLOCK.exec(text)) !== null) {
    const x: bigint[] = []
    for (const line of match[5]!.trim().split('\n')) {
      // Each row is labelled with the number of the first register on
      // it and then holds four values; the label is not repeated.
      for (const value of line.replace(/^GPR\d\d/, '').trim().split(/\s+/)) {
        x.push(BigInt(`0x${value}`))
      }
    }
    if (x.length !== 32) continue
    x[POWER_LR_SLOT] = BigInt(`0x${match[2]!}`)
    x[POWER_CTR_SLOT] = BigInt(`0x${match[3]!}`)
    // The condition register is unpacked into a slot per field, so a
    // mismatch says which condition differs rather than which of
    // thirty-two bits.
    const cr = Number(BigInt(`0x${match[6]!}`))
    for (let f = 0; f < 8; f++) x[POWER_CR_SLOT + f] = BigInt((cr >>> (28 - f * 4)) & 0xf)
    x[POWER_XER_SLOT] = BigInt(`0x${match[4]!}`)
    steps.push({ pc: BigInt(`0x${match[1]!}`), x })
  }
  return steps
}

export const powerTarget: FixtureTarget = {
  id: 'power',
  codegen: 'isa-bench/codegen-min:23.1.0',
  oracle: qemuOracle('isa-sim/qemu-user:11.1.0', '/opt/qemu/bin/qemu-ppc64le'),
  triple: 'powerpc64le-unknown-linux-gnu',
  // clang wants -mcpu for this target; -march names something else.
  march: '',
  // POWER8 because that is the baseline the VSX scalar forms need, and
  // they are what ordinary `double` arithmetic compiles to.
  extraFlags: ['-mcpu=pwr8', '-Wl,-e,_start'],
  harnessDir: join(TOOLS, 'power'),
  sharedProgramsDir: join(TOOLS, 'programs'),
  programsDir: join(TOOLS, 'power/programs'),
  outDir: join(ROOT, 'src/isa/power/fixtures'),
  workDir: join(ROOT, 'node_modules/.tmp/isa-fixtures/power'),
  /** Keep in sync with ISA_DUMP_BYTES in tools/isa/power/harness.h. */
  dumpBytes: 1568,
  gprCount: POWER_GPR_COUNT,
  randomSeeds: RANDOM_SEEDS,
  randomGenerator: 'tools/isa/power/random.ts',
  generateRandom: (seed: number) => generateRandomProgram(seed),
  parseCpuLog: parsePowerCpuLog,
  // No libc tier yet, and the reasons are specific rather than general.
  //
  // Eleven of the eighteen programs already run correctly end to end;
  // the other seven stop for three causes, each identified and none of
  // them mysterious:
  //
  //   - musl's `memcpy` and `strlen` use Altivec, and the vector
  //     operations are decoded here but have no semantics yet. They
  //     fail loudly, which is the right behaviour and still a failure.
  //   - one program outgrows the heap: the address it faults on is
  //     inside the range `brk` should have mapped, which points at the
  //     page size the auxiliary vector advertises rather than at the
  //     syscall.
  //   - printf's floating-point path produces zeroes. The value reaches
  //     it correctly -- traced through the variadic save area and into
  //     the digit loop -- and the arithmetic matches the reference for
  //     3,177 instructions of `vfprintf` before the two diverge on a
  //     pointer comparison in the big-integer loop.
  //
  // Enabling the tier before those are fixed would mean committing
  // fixtures the suite cannot pass, so it is left off and the gap is
  // written down instead.
}
