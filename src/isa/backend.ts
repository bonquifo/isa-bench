/**
 * The contract every real-ISA backend implements.
 *
 * Frozen after RV64GC and before the other seven, which is the cheapest
 * moment to get it wrong and fix it. What is here is exactly what turned out
 * to be needed to run one instruction set end to end and verify it against a
 * reference; nothing is speculative.
 *
 * AArch64 was then built against it without changing it, which is the only
 * evidence that freezing early was right rather than lucky.
 *
 * The division of labour that this encodes:
 *
 *   per ISA     decode, semantics, the register file and its numbering, and
 *               which ELF machine and byte order it accepts
 *   shared      address space, ELF loading, IEEE-754, the trace interface,
 *               the timing model, and the whole differential test suite
 *
 * Note what is *not* here. Nothing about cycles, caches or prediction: a
 * backend produces architectural facts and the timing model consumes them.
 * And nothing about how the reference oracle is driven, because that differs
 * per target in ways the interpreter should not know about — qemu's register
 * dump format alone varies enough between RISC-V and AArch64 that it has to
 * live with the fixture tooling instead.
 */
import type { IsaId } from '../engine/types.ts'
import type { Interpreter, ProgramImage, RegisterNaming } from './common/trace.ts'

export interface BackendLoadOptions {
  /**
   * Initial general-purpose register values, in the backend's own numbering.
   *
   * A differential run seeds these from the reference's first trace entry so
   * both executions start from identical architectural state. qemu-user
   * randomises the initial stack pointer, and while the programs here set
   * their own stack immediately, starting from the same place removes the
   * question entirely.
   */
  initialRegisters?: readonly bigint[]
  /** Ceiling on retired instructions, to turn a guest hang into an error. */
  instructionBudget?: number
}

export interface LoadedProgram {
  image: ProgramImage
  interpreter: Interpreter
}

export interface IsaBackend {
  /** The engine-wide identifier, so the app can look a backend up by target. */
  readonly id: IsaId
  /** How the architecture is named in diagnostics. */
  readonly name: string
  /** e_machine value this backend accepts; a mismatch is refused by the loader. */
  readonly elfMachine: number
  readonly littleEndian: boolean
  /** Names for the architectural resource ids in `reads` and `writes`. */
  readonly naming: RegisterNaming
  /** General-purpose registers a lockstep comparison covers. */
  readonly gprCount: number
  /**
   * Byte size of the architectural state dump the guest harness writes. Zero
   * for a backend with no differential fixtures yet.
   */
  readonly dumpBytes: number
  load(bytes: Uint8Array, options?: BackendLoadOptions): LoadedProgram
}
