/** SPARC V8 as an IsaBackend. */
import { IsaId } from '../../engine/types.ts'
import type { BackendLoadOptions, IsaBackend, LoadedProgram } from '../backend.ts'
import { ElfMachine } from '../common/elf.ts'
import { LOCKSTEP_COUNT, SPARC_NAMING } from './image.ts'
import { loadSparc } from './load.ts'

/**
 * The 32 window-relative registers, `y`, the four condition codes, the
 * window pointer, `npc` and `wim`.
 *
 * Window-relative rather than physical because this is what the
 * lockstep comparison covers: the reference reports the window it is
 * in, not the file behind it.
 *
 * Three of these are in the comparison for reasons particular to this
 * architecture. `npc` is architectural state rather than a derived
 * value, so a backend that got the delay slot wrong would still agree
 * on `pc` for one instruction longer than it should. `cwp` and `wim`
 * are what the window traps move, and those happen inside an
 * instruction rather than in guest code, so nothing else would notice
 * a spill that went to the wrong place.
 */
export const SPARC_GPR_COUNT = LOCKSTEP_COUNT

/** Keep in sync with ISA_DUMP_BYTES in tools/isa/sparc/harness.h. */
export const SPARC_DUMP_BYTES = 1296

export const sparcBackend: IsaBackend = {
  id: IsaId.SPARC,
  name: 'SPARC V8',
  elfMachine: ElfMachine.SPARC,
  littleEndian: false,
  naming: SPARC_NAMING,
  gprCount: SPARC_GPR_COUNT,
  dumpBytes: SPARC_DUMP_BYTES,
  load(bytes: Uint8Array, options: BackendLoadOptions = {}): LoadedProgram {
    const initial = options.initialRegisters
    const loaded = loadSparc(bytes, {
      ...(options.instructionBudget !== undefined
        ? { instructionBudget: options.instructionBudget }
        : {}),
      // %o6 is the stack pointer, and the loader needs it before it maps
      // a stack to put it in.
      ...(initial ? { initialSp: BigInt.asUintN(32, initial[14] ?? 0n) } : {}),
      ...(initial ? { initialRegisters: initial } : {}),
    })
    return { image: loaded.image, interpreter: loaded.interpreter }
  },
}
