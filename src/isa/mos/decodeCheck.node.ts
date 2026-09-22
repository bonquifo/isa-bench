/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * The shortest of these files by a long way, and the reason is worth
 * stating: this assembly language has no pseudo-instructions. Every other
 * target here needs a table mapping what the disassembler prints to what
 * the encoding actually is -- `mv` is an add, `nop` is a shift by zero,
 * `li` is whichever instruction produces the constant -- because those
 * architectures have enough encoding space that the assembler can afford
 * to offer friendlier names for special cases. The 6502 has 256 opcodes
 * and no room for a synonym, so what the disassembler prints is the
 * instruction.
 *
 * There is also nothing in the `refused` list, which is a stronger claim
 * than it looks. The disassembler is given the ELF's text sections, and
 * every byte in them decoded: over the whole fixture set, LLVM printed
 * only documented instructions, so the 105 encodings this decoder refuses
 * never appear in code the compiler emits. That is the check that the
 * refusal costs nothing real.
 */
import { MOS_NAME, decode } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

export const mosDecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    const inst = decode((offset) => bytes[offset] ?? 0, address)
    return { op: inst.op, length: inst.length }
  },
  name(op) {
    return MOS_NAME[op] ?? `?${op}`
  },
}
