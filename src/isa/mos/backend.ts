/** MOS 6502 as an IsaBackend. */
import { IsaId } from '../../engine/types.ts'
import type { BackendLoadOptions, IsaBackend, LoadedProgram } from '../backend.ts'
import { ElfMachine } from '../common/elf.ts'
import { MOS_NAMING } from './image.ts'
import { loadMos } from './load.ts'

/**
 * A, X, Y, the stack pointer and the status register.
 *
 * Five, against thirty-two on every other target here. The whole point of
 * including this architecture in the comparison is that the number is
 * five: the register pressure is what makes the code shape different, and
 * a comparison of eight targets that were all roughly the same machine
 * would not be telling anyone anything.
 */
export const MOS_GPR_COUNT = 5

export const mosBackend: IsaBackend = {
  id: IsaId.MOS,
  name: 'MOS 6502',
  elfMachine: ElfMachine.MOS,
  littleEndian: true,
  naming: MOS_NAMING,
  gprCount: MOS_GPR_COUNT,
  // No guest state dump: this target has no lockstep oracle to compare one
  // against. What it has instead is per-opcode vectors recorded from
  // hardware, which say more about a single instruction than a dump of the
  // state at the end of a program says about all of them. See
  // src/isa/mos/vectors.test.ts.
  dumpBytes: 0,
  load(bytes: Uint8Array, options: BackendLoadOptions = {}): LoadedProgram {
    const loaded = loadMos(bytes, {
      ...(options.instructionBudget !== undefined
        ? { instructionBudget: options.instructionBudget }
        : {}),
    })
    const initial = options.initialRegisters
    if (initial) {
      for (let r = 0; r < initial.length && r < MOS_GPR_COUNT; r++) {
        loaded.interpreter.setGpr(r, initial[r]!)
      }
    }
    return { image: loaded.image, interpreter: loaded.interpreter }
  },
}
