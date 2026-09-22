/** AArch64 as an IsaBackend. */
import { IsaId } from '../../engine/types.ts'
import type { BackendLoadOptions, IsaBackend, LoadedProgram } from '../backend.ts'
import { ElfMachine } from '../common/elf.ts'
import { AARCH64_NAMING } from './image.ts'
import { loadA64 } from './load.ts'

/** Keep in sync with ISA_DUMP_BYTES in tools/isa/aarch64/harness.h. */
export const AARCH64_DUMP_BYTES = 1824
/** x0..x30, then sp, then the condition flags. */
export const AARCH64_GPR_COUNT = 33

export const aarch64Backend: IsaBackend = {
  id: IsaId.ARM,
  name: 'AArch64',
  elfMachine: ElfMachine.AARCH64,
  littleEndian: true,
  naming: AARCH64_NAMING,
  gprCount: AARCH64_GPR_COUNT,
  dumpBytes: AARCH64_DUMP_BYTES,
  load(bytes: Uint8Array, options: BackendLoadOptions = {}): LoadedProgram {
    const initial = options.initialRegisters
    const loaded = loadA64(bytes, {
      instructionBudget: options.instructionBudget,
      // Slot 31 is the stack pointer, which the loader needs before it maps one.
      ...(initial ? { initialSp: initial[31] } : {}),
    })
    if (initial) {
      for (let r = 0; r < initial.length && r < AARCH64_GPR_COUNT; r++) {
        loaded.interpreter.setGpr(r, initial[r]!)
      }
    }
    return { image: loaded.image, interpreter: loaded.interpreter }
  },
}
