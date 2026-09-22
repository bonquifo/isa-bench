/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * RV64 had this tier before it was shared, and the alias table below is
 * the one it always used. What moved is the machinery around it, so that
 * the same check runs for every target rather than for this one.
 *
 * The compressed instructions are the part that is particular here: a
 * two-byte encoding expands into a full-length one before it is decoded,
 * and the length the decoder reports has to stay two. A decoder that
 * reported four would walk past the next instruction.
 */
import { Rv, decode32, decompress } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

/**
 * objdump prints pseudo-instructions. Each maps onto one or more
 * canonical operations, and which one depends on the operands, so the
 * check is membership rather than equality.
 */
const ALIASES: Record<string, readonly number[]> = {
  li: [Rv.ADDI, Rv.LUI],
  mv: [Rv.ADDI, Rv.ADD],
  nop: [Rv.ADDI],
  j: [Rv.JAL],
  jr: [Rv.JALR],
  ret: [Rv.JALR],
  call: [Rv.JALR, Rv.AUIPC],
  tail: [Rv.JALR, Rv.AUIPC],
  neg: [Rv.SUB],
  negw: [Rv.SUBW],
  not: [Rv.XORI],
  seqz: [Rv.SLTIU],
  snez: [Rv.SLTU],
  sltz: [Rv.SLT],
  sgtz: [Rv.SLT],
  'sext.w': [Rv.ADDIW],
  'zext.w': [Rv.ADD],
  beqz: [Rv.BEQ],
  bnez: [Rv.BNE],
  blez: [Rv.BGE],
  bgez: [Rv.BGE],
  bltz: [Rv.BLT],
  bgtz: [Rv.BLT],
  bgt: [Rv.BLT],
  ble: [Rv.BGE],
  bgtu: [Rv.BLTU],
  bleu: [Rv.BGEU],
  frcsr: [Rv.CSRRS],
  fscsr: [Rv.CSRRW],
  frrm: [Rv.CSRRS],
  fsrm: [Rv.CSRRW],
  frflags: [Rv.CSRRS],
  csrr: [Rv.CSRRS],
  csrw: [Rv.CSRRW],
  'fmv.d': [Rv.FSGNJ_D],
  'fneg.d': [Rv.FSGNJN_D],
  'fabs.d': [Rv.FSGNJX_D],
  'fmv.s': [Rv.FSGNJ_S],
  'fneg.s': [Rv.FSGNJN_S],
  'fabs.s': [Rv.FSGNJX_S],
}

export const rv64DecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    const compressed = bytes.length === 2
    const word = compressed
      ? bytes[0]! | (bytes[1]! << 8)
      : (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0
    const expanded = compressed ? decompress(word, address) : word
    const inst = decode32(expanded, compressed ? 2 : 4, address)
    return { op: inst.op, length: inst.len }
  },
  name(op) {
    for (const [key, value] of Object.entries(Rv)) {
      if (value === op) return key.toLowerCase().replace(/_/g, '.')
    }
    return `?${op}`
  },
  aliases: ALIASES,
  // The canonical trap word, which a disassembler names but which is not
  // an instruction to execute.
  refused: ['unimp'],
}
