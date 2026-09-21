/**
 * RV64GC as an IsaBackend. The first implementation of the contract, and the
 * one the others are measured against.
 */
import { IsaId } from '../../engine/types.ts'
import type { BackendLoadOptions, IsaBackend, LoadedProgram } from '../backend.ts'
import { ElfMachine } from '../common/elf.ts'
import { RV64_NAMING } from './image.ts'
import { loadRv64 } from './load.ts'

/** Keep in sync with ISA_DUMP_BYTES in tools/isa/rv64/harness.h. */
export const RV64_DUMP_BYTES = 1552

export const rv64Backend: IsaBackend = {
  id: IsaId.RISCV,
  name: 'RV64GC',
  elfMachine: ElfMachine.RISCV,
  littleEndian: true,
  naming: RV64_NAMING,
  gprCount: 32,
  dumpBytes: RV64_DUMP_BYTES,
  load(bytes: Uint8Array, options: BackendLoadOptions = {}): LoadedProgram {
    const initial = options.initialRegisters
    const loaded = loadRv64(bytes, {
      instructionBudget: options.instructionBudget,
      // x2 is the stack pointer; the loader needs it before it maps a stack.
      ...(initial ? { initialSp: initial[2] } : {}),
    })
    if (initial) {
      // x0 is hardwired to zero and the setter ignores it, so starting at 1
      // simply says what is true rather than relying on that.
      for (let r = 1; r < initial.length && r < 32; r++) {
        loaded.interpreter.setGpr(r, initial[r]!)
      }
    }
    return { image: loaded.image, interpreter: loaded.interpreter }
  },
}
