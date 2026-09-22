/** MIPS32 as an IsaBackend. */
import { IsaId } from '../../engine/types.ts'
import type { BackendLoadOptions, IsaBackend, LoadedProgram } from '../backend.ts'
import { ElfMachine } from '../common/elf.ts'
import { MIPS_NAMING } from './image.ts'
import { loadMips } from './load.ts'

/** Keep in sync with ISA_DUMP_BYTES in tools/isa/mips/harness.h. */
export const MIPS_DUMP_BYTES = 1424
/** r0..r31, then HI and LO. */
export const MIPS_GPR_COUNT = 34

export const mipsBackend: IsaBackend = {
  id: IsaId.MIPS,
  name: 'MIPS32',
  elfMachine: ElfMachine.MIPS,
  littleEndian: true,
  naming: MIPS_NAMING,
  gprCount: MIPS_GPR_COUNT,
  dumpBytes: MIPS_DUMP_BYTES,
  load(bytes: Uint8Array, options: BackendLoadOptions = {}): LoadedProgram {
    const initial = options.initialRegisters
    const loaded = loadMips(bytes, {
      instructionBudget: options.instructionBudget,
      // Register 29 is the stack pointer, which the loader needs before
      // it maps one.
      ...(initial ? { initialSp: BigInt.asUintN(32, initial[29] ?? 0n) } : {}),
    })
    if (initial) {
      for (let r = 0; r < initial.length && r < MIPS_GPR_COUNT; r++) {
        loaded.interpreter.setGpr(r, initial[r]!)
      }
    }
    return { image: loaded.image, interpreter: loaded.interpreter }
  },
}
