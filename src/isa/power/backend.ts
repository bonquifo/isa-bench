/** POWER (powerpc64le) as an IsaBackend. */
import { IsaId } from '../../engine/types.ts'
import type { BackendLoadOptions, IsaBackend, LoadedProgram } from '../backend.ts'
import { ElfMachine } from '../common/elf.ts'
import { LOCKSTEP_COUNT, POWER_NAMING } from './image.ts'
import { loadPower } from './load.ts'

/**
 * r0..r31, then the link register, the count register, the packed
 * condition register and the fixed-point exception register.
 *
 * The last four are in the comparison because on this architecture they
 * are where the work happens. `lr` and `ctr` are both branch targets, so
 * an implementation that confused them would still run straight-line
 * code correctly. `cr` is eight independent conditions and is the only
 * place a comparison's result exists. And `xer` holds carry, which is a
 * register here rather than a flag -- an extended-precision add is a
 * chain through it, and nothing else would notice if a link in that
 * chain were wrong.
 */
export const POWER_GPR_COUNT = LOCKSTEP_COUNT

/** Keep in sync with ISA_DUMP_BYTES in tools/isa/power/harness.h. */
export const POWER_DUMP_BYTES = 1568

export const powerBackend: IsaBackend = {
  id: IsaId.POWER,
  name: 'POWER',
  elfMachine: ElfMachine.PPC64,
  littleEndian: true,
  naming: POWER_NAMING,
  gprCount: POWER_GPR_COUNT,
  dumpBytes: POWER_DUMP_BYTES,
  load(bytes: Uint8Array, options: BackendLoadOptions = {}): LoadedProgram {
    const initial = options.initialRegisters
    const loaded = loadPower(bytes, {
      ...(options.instructionBudget !== undefined
        ? { instructionBudget: options.instructionBudget }
        : {}),
      // r1 is the stack pointer, and the loader needs it before it maps
      // a stack to put it in.
      ...(initial ? { initialSp: BigInt.asUintN(64, initial[1] ?? 0n) } : {}),
      ...(initial ? { initialRegisters: initial } : {}),
    })
    return { image: loaded.image, interpreter: loaded.interpreter }
  },
}
