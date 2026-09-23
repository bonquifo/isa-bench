/**
 * WebAssembly as an IsaBackend.
 *
 * One field of the frozen contract does not apply here and is worth
 * being explicit about rather than filling in with something plausible.
 * `elfMachine` names the `e_machine` value a backend's objects carry --
 * and a `.wasm` module is not an ELF file at all. There is no registered
 * value to give, and inventing one would mean the loader accepted
 * something it cannot read. It is zero, which is `EM_NONE`, and the
 * loader refuses anything without the module's own magic.
 *
 * This is the only target where that is true. The 6502 looks like it
 * should be the exception, since it is an eight-bit microprocessor from
 * 1975, but llvm-mos emits perfectly ordinary ELF objects for it.
 */
import { IsaId } from '../../engine/types.ts'
import type { BackendLoadOptions, IsaBackend, LoadedProgram } from '../backend.ts'
import { GLOBAL_SLOTS, WASM_NAMING } from './image.ts'
import { loadWasm } from './load.ts'

/**
 * The globals, which is the only state that outlives a call.
 *
 * Every other target here reports a register file. This one does not
 * have one: operands live on a stack and locals belong to an
 * activation, so the nearest thing to a register is a module global --
 * clang keeps the shadow stack pointer in one. Reporting those is the
 * honest answer to "what are this architecture's registers", and it is
 * why the resource-id space puts them first.
 */
export const WASM_GPR_COUNT = GLOBAL_SLOTS

export const wasmBackend: IsaBackend = {
  id: IsaId.WASM,
  name: 'WebAssembly',
  // Not an ELF target. See the note at the top.
  elfMachine: 0,
  littleEndian: true,
  naming: WASM_NAMING,
  gprCount: WASM_GPR_COUNT,
  // No guest state dump. The oracle here is an engine rather than an
  // emulator, and what it exposes is a called function's results and the
  // module's linear memory -- so the differential tier compares all of
  // memory byte for byte, which is a stronger statement than a dump of
  // the registers a harness chose to write.
  dumpBytes: 0,
  load(bytes: Uint8Array, options: BackendLoadOptions = {}): LoadedProgram {
    const loaded = loadWasm(bytes, {
      ...(options.instructionBudget !== undefined
        ? { instructionBudget: options.instructionBudget }
        : {}),
    })
    const initial = options.initialRegisters
    if (initial) {
      for (let g = 0; g < initial.length && g < GLOBAL_SLOTS; g++) {
        loaded.interpreter.globals[g] = BigInt.asUintN(64, initial[g]!)
      }
    }
    return { image: loaded.image, interpreter: loaded.interpreter }
  },
}
