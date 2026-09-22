/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * MIPS assembly is written almost entirely in pseudo-instructions, more
 * so than any other target here: `move` is an or with the zero register,
 * `li` is whichever of three instructions produces the constant, `nop`
 * is a shift by zero, and `b` is a branch on a condition that is always
 * true. A decoder that agrees with the disassembler across all of them
 * has the encoding right; one that does not has usually mistaken a
 * special case for the general form it is built from.
 */
import { MIPS, MIPS_NAME, decode } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

const ALIASES: Readonly<Record<string, readonly number[]>> = {
  // The zero register makes one instruction look like several.
  move: [MIPS.OR, MIPS.ADDU],
  nop: [MIPS.SLL],
  li: [MIPS.ADDIU, MIPS.ORI, MIPS.LUI],
  lui: [MIPS.LUI],
  not: [MIPS.NOR],
  negu: [MIPS.SUBU],
  neg: [MIPS.SUBU],
  b: [MIPS.BEQ],
  bal: [MIPS.BGEZAL],
  beqz: [MIPS.BEQ],
  bnez: [MIPS.BNE],
  blez: [MIPS.BLEZ],
  bgez: [MIPS.BGEZ],
  bltz: [MIPS.BLTZ],
  bgtz: [MIPS.BGTZ],
  // The shifts have named forms for the common amounts.
  sll: [MIPS.SLL],
  srl: [MIPS.SRL],
  sra: [MIPS.SRA],
  sllv: [MIPS.SLLV],
  srlv: [MIPS.SRLV],
  srav: [MIPS.SRAV],
  sltu: [MIPS.SLTU],
  // Trap instructions, of which the compiler emits one.
  teq: [MIPS.TRAP],
  tne: [MIPS.TRAP],
  tge: [MIPS.TRAP],
  tgeu: [MIPS.TRAP],
  tlt: [MIPS.TRAP],
  tltu: [MIPS.TRAP],
  // The conditional moves on a floating-point condition, which sit in
  // the integer opcode space and read coprocessor state.
  movt: [MIPS.MOVCI],
  movf: [MIPS.MOVCI],
  // The coprocessor. Its mnemonics name the format, which the decoder
  // carries as a field.
  'add.s': [MIPS.FP_ADD],
  'add.d': [MIPS.FP_ADD],
  'sub.s': [MIPS.FP_SUB],
  'sub.d': [MIPS.FP_SUB],
  'mul.s': [MIPS.FP_MUL],
  'mul.d': [MIPS.FP_MUL],
  'div.s': [MIPS.FP_DIV],
  'div.d': [MIPS.FP_DIV],
  'sqrt.s': [MIPS.FP_SQRT],
  'sqrt.d': [MIPS.FP_SQRT],
  'abs.s': [MIPS.FP_ABS],
  'abs.d': [MIPS.FP_ABS],
  'neg.s': [MIPS.FP_NEG],
  'neg.d': [MIPS.FP_NEG],
  'mov.s': [MIPS.FP_MOV],
  'mov.d': [MIPS.FP_MOV],
  'movz.s': [MIPS.FP_MOVZ],
  'movz.d': [MIPS.FP_MOVZ],
  'movn.s': [MIPS.FP_MOVN],
  'movn.d': [MIPS.FP_MOVN],
  'movt.s': [MIPS.FP_MOVCF],
  'movt.d': [MIPS.FP_MOVCF],
  'movf.s': [MIPS.FP_MOVCF],
  'movf.d': [MIPS.FP_MOVCF],
  'madd.s': [MIPS.FP_MADD],
  'madd.d': [MIPS.FP_MADD],
  'msub.s': [MIPS.FP_MADD],
  'msub.d': [MIPS.FP_MADD],
  'nmadd.s': [MIPS.FP_MADD],
  'nmadd.d': [MIPS.FP_MADD],
  'nmsub.s': [MIPS.FP_MADD],
  'nmsub.d': [MIPS.FP_MADD],
  bc1t: [MIPS.BC1],
  bc1f: [MIPS.BC1],
  mfc1: [MIPS.MFC1],
  mtc1: [MIPS.MTC1],
  mfhc1: [MIPS.MFHC1],
  mthc1: [MIPS.MTHC1],
  cfc1: [MIPS.CFC1],
  ctc1: [MIPS.CTC1],
  lwc1: [MIPS.FP_LOAD],
  ldc1: [MIPS.FP_LOAD],
  swc1: [MIPS.FP_STORE],
  sdc1: [MIPS.FP_STORE],
}

/**
 * The comparisons and conversions, whose names carry the predicate or
 * the format pair. Generated rather than listed: there are sixteen
 * predicates times two formats, and writing them out would be a table
 * of the same fact repeated thirty-two times.
 */
const GENERATED: Record<string, readonly number[]> = { ...ALIASES }
const PREDICATES = [
  'f', 'un', 'eq', 'ueq', 'olt', 'ult', 'ole', 'ule',
  'sf', 'ngle', 'seq', 'ngl', 'lt', 'nge', 'le', 'ngt',
]
for (const format of ['s', 'd']) {
  for (const predicate of PREDICATES) {
    GENERATED[`c.${predicate}.${format}`] = [MIPS.FP_CMP]
  }
  for (const to of ['s', 'd', 'w', 'l']) {
    GENERATED[`cvt.${to}.${format}`] = [MIPS.FP_CVT]
    GENERATED[`cvt.${to}.w`] = [MIPS.FP_CVT]
    GENERATED[`cvt.${to}.l`] = [MIPS.FP_CVT]
  }
  for (const direction of ['round', 'trunc', 'ceil', 'floor']) {
    GENERATED[`${direction}.w.${format}`] = [MIPS.FP_ROUND]
    GENERATED[`${direction}.l.${format}`] = [MIPS.FP_ROUND]
  }
}

export const mipsDecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    const word = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) |
      (bytes[3]! << 24)) >>> 0
    return { op: decode(word, address).op, length: 4 }
  },
  name(op) {
    return MIPS_NAME[op] ?? `?${op}`
  },
  aliases: GENERATED,
  // Assembler directives the disassembler echoes, which are not code.
  ignored: ['.set', '<unknown>'],
}
