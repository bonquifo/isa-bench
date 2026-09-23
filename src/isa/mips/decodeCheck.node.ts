/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * MIPS assembly is written almost entirely in pseudo-instructions, more
 * so than any other target here: `move` is an or with the zero register,
 * `li` is whichever of three instructions produces the constant, `nop`
 * is a shift by zero, and `b` is a branch on a condition that is always
 * true. Those differ by operand, and the alias table admits each as one
 * of the instructions it can stand for.
 *
 * The floating-point unit is the other way round: its names spell out
 * fields -- the format, the compare predicate, the rounding direction --
 * that decide what the instruction computes, and the signature further
 * down requires the exact name those fields imply.
 */
import { MIPS, MIPS_NAME, decode, type MipsInst } from './decode.ts'
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
  bal: [MIPS.BGEZAL],
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
  // The moves to and from the coprocessor.
  mfc1: [MIPS.MFC1],
  mtc1: [MIPS.MTC1],
  mfhc1: [MIPS.MFHC1],
  mthc1: [MIPS.MTHC1],
  cfc1: [MIPS.CFC1],
  ctc1: [MIPS.CTC1],
}

/** The compare predicates, in the order the function field numbers them. */
const FP_PREDICATES = [
  'f', 'un', 'eq', 'ueq', 'olt', 'ult', 'ole', 'ule',
  'sf', 'ngle', 'seq', 'ngl', 'lt', 'nge', 'le', 'ngt',
]

function decodeBytes(bytes: Uint8Array, address: bigint): MipsInst {
  const word = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) |
    (bytes[3]! << 24)) >>> 0
  return decode(word, address)
}

/** The format letter a coprocessor mnemonic ends in, by operand width. */
const FORMAT: Readonly<Record<number, string>> = { 4: 's', 8: 'd', 1: 'w', 2: 'l' }

/** The arithmetic whose name is a stem and the format. */
const FORMATTED: ReadonlyMap<number, string> = new Map([
  [MIPS.FP_ADD, 'add'], [MIPS.FP_SUB, 'sub'], [MIPS.FP_MUL, 'mul'],
  [MIPS.FP_DIV, 'div'], [MIPS.FP_SQRT, 'sqrt'], [MIPS.FP_ABS, 'abs'],
  [MIPS.FP_NEG, 'neg'], [MIPS.FP_MOV, 'mov'], [MIPS.FP_MOVZ, 'movz'],
  [MIPS.FP_MOVN, 'movn'],
])

/** The rounding directions, in the order the function field numbers them. */
const DIRECTIONS = ['round', 'trunc', 'ceil', 'floor']

/** The traps, by function number less 0x30. */
const TRAPS = ['tge', 'tgeu', 'tlt', 'tltu', 'teq', undefined, 'tne']

/** Multiply-add by which of its two negations it applies. */
const MADD = ['madd', 'msub', 'nmadd', 'nmsub']

/**
 * The names the decoded fields imply.
 *
 * The floating-point unit is where membership was loosest. Format,
 * predicate and rounding direction are fields, so `add.s` and `add.d`,
 * sixteen compare predicates, four rounding directions and four
 * multiply-adds each shared an operation, and a decoder that misread any
 * of those fields -- running a double as a single, an ordered compare as
 * an unordered one -- passed. So did one that read a trap's condition,
 * or a branch's true-or-false bit, the wrong way round. Here those fields
 * decide the name.
 */
function signature(inst: MipsInst): readonly string[] | undefined {
  const format = FORMAT[inst.fmt] ?? '?'
  const stem = FORMATTED.get(inst.op)
  if (stem !== undefined) return [`${stem}.${format}`]

  switch (inst.op) {
    case MIPS.FP_CMP:
      return [`c.${FP_PREDICATES[inst.predicate] ?? '?'}.${format}`]
    case MIPS.FP_CVT:
      return [`cvt.${FORMAT[inst.toFmt] ?? '?'}.${format}`]
    case MIPS.FP_ROUND:
      return [`${DIRECTIONS[inst.predicate] ?? '?'}.${FORMAT[inst.toFmt] ?? '?'}.${format}`]
    case MIPS.FP_MADD:
      return [`${MADD[inst.predicate] ?? '?'}.${format}`]
    case MIPS.FP_MOVCF:
      return [`mov${inst.predicate === 1 ? 't' : 'f'}.${format}`]
    case MIPS.MOVCI:
      return [inst.predicate === 1 ? 'movt' : 'movf']
    case MIPS.BC1:
      return [inst.predicate === 1 ? 'bc1t' : 'bc1f']
    case MIPS.FP_LOAD:
      return [inst.width === 8 ? 'ldc1' : 'lwc1']
    case MIPS.FP_STORE:
      return [inst.width === 8 ? 'sdc1' : 'swc1']
    case MIPS.TRAP:
      return [TRAPS[inst.predicate] ?? '?']

    // Which operand is the zero register decides the pseudo-instruction.
    case MIPS.BEQ:
      if (inst.rs === 0 && inst.rt === 0) return ['b']
      return inst.rt === 0 ? ['beqz'] : ['beq']
    case MIPS.BNE:
      return inst.rt === 0 ? ['bnez'] : ['bne']

    default:
      return undefined
  }
}

export const mipsDecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    return { op: decodeBytes(bytes, address).op, length: 4 }
  },
  signature(bytes, address) {
    return signature(decodeBytes(bytes, address))
  },
  name(op) {
    return MIPS_NAME[op] ?? `?${op}`
  },
  aliases: ALIASES,
  // Assembler directives the disassembler echoes, which are not code.
  ignored: ['.set', '<unknown>'],
}
