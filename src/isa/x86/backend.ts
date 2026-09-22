/** x86-64 as an IsaBackend. */
import { IsaId } from '../../engine/types.ts'
import type { BackendLoadOptions, IsaBackend, LoadedProgram } from '../backend.ts'
import { ElfMachine } from '../common/elf.ts'
import { loadX86 } from './load.ts'
import { X86_NAMING } from './image.ts'

/** Keep in sync with ISA_DUMP_BYTES in tools/isa/x86/harness.h. */
export const X86_DUMP_BYTES = 8592
/** rax..r15, then the flags. */
export const X86_GPR_COUNT = 17

export const x86Backend: IsaBackend = {
  id: IsaId.X86,
  name: 'x86-64',
  elfMachine: ElfMachine.X86_64,
  littleEndian: true,
  naming: X86_NAMING,
  gprCount: X86_GPR_COUNT,
  dumpBytes: X86_DUMP_BYTES,
  load(bytes: Uint8Array, options: BackendLoadOptions = {}): LoadedProgram {
    const initial = options.initialRegisters
    const loaded = loadX86(bytes, {
      instructionBudget: options.instructionBudget,
      // Slot 4 is the stack pointer, which the loader needs before it maps one.
      ...(initial ? { initialSp: BigInt.asUintN(64, initial[4] ?? 0n) } : {}),
    })
    if (initial) {
      for (let r = 0; r < initial.length && r < X86_GPR_COUNT; r++) {
        loaded.interpreter.setGpr(r, initial[r]!)
      }
    }
    return { image: loaded.image, interpreter: loaded.interpreter }
  },
}
