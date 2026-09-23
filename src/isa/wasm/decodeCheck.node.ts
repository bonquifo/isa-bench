/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * Nearly empty, and for a better reason than the 6502's was. There the
 * assembly language had no synonyms because there was no encoding space
 * to spare. Here the mnemonic *is* the specification's own name for the
 * opcode -- the text format and the binary format are defined together
 * -- so a disassembler has nothing to choose. The few entries below are
 * places where LLVM prints a type prefix the specification does not.
 */
import { decode, nameOf } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

/**
 * `select` is one opcode whatever it selects between, and the typed
 * form carries its types as an immediate rather than in its name. LLVM
 * prints the type it inferred, so each spelling maps back to the one
 * instruction.
 */
const ALIASES: Record<string, readonly number[]> = {}
for (const type of ['i32', 'i64', 'f32', 'f64', 'v128', 'externref', 'funcref']) {
  ALIASES[`${type}.select`] = [0x1b, 0x1c]
}

export const wasmDecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    const inst = decode((offset) => bytes[offset] ?? 0, address)
    return { op: inst.op, length: inst.length }
  },
  name(op) {
    return nameOf(op)
  },
  aliases: ALIASES,
  // The disassembler prints a function's local declarations and its
  // section headers in the same column as instructions; neither is one.
  ignored: ['.local', '.functype', '.size', '.globl', '<unknown>'],
}
