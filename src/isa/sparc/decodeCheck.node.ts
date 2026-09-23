/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * SPARC assembly is written in synthetic instructions to a degree only
 * MIPS approaches, and for the same reason: with `%g0` reading as zero
 * and discarding writes, one instruction covers several jobs. `mov` is
 * an or, `cmp` is a subtract whose result is thrown away, `tst` is an or
 * whose result is thrown away, `ret` and `retl` are the same jump
 * through different link registers, and `nop` is a `sethi` of nothing
 * into nowhere.
 *
 * The decoder also folds `addcc` into `add` and records that it writes
 * the condition codes, because the encoding says so -- bit four of `op3`
 * -- and keeps one operation for every branch, every trap and each
 * floating-point operation across its formats. Those fields decide what
 * the instruction does, so they are checked by signature further down
 * rather than admitted by membership here.
 */
import { FpFormat, SPARC, SPARC_NAME, decode, type SparcInst } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

const ALIASES: Readonly<Record<string, readonly number[]>> = {
  // %g0 makes one instruction look like several.
  mov: [SPARC.RDY],
  nop: [SPARC.SETHI],
  clr: [SPARC.ST, SPARC.STB, SPARC.STH, SPARC.STD],
  clrb: [SPARC.STB],
  clrh: [SPARC.STH],
  // Returning is a jump through the link register, plus the delay slot's
  // worth of offset.
  ret: [SPARC.JMPL],
  retl: [SPARC.JMPL],
  jmp: [SPARC.JMPL],
  call: [SPARC.CALL, SPARC.JMPL],
  // Reading %y is one encoding of a four-register instruction.
  rd: [SPARC.RDY],
  wr: [SPARC.WRY],

  // A load into a floating-point register is a different instruction
  // from a load into an integer one -- a different `op3` entirely -- but
  // the disassembler spells both `ld`, leaving the register to say
  // which. The decoder keeps them apart, so both are accepted here.
  ld: [SPARC.LD, SPARC.LDF, SPARC.LDFSR],
  ldd: [SPARC.LDD, SPARC.LDDF],
  st: [SPARC.ST, SPARC.STF, SPARC.STFSR],
  std: [SPARC.STD, SPARC.STDF],
}

const GENERATED: Record<string, readonly number[]> = { ...ALIASES, fsmuld: [SPARC.FSMULD] }

function decodeBytes(bytes: Uint8Array, address: bigint): SparcInst {
  // Big endian: the first byte in memory is the most significant.
  const word = ((bytes[0]! << 24) | (bytes[1]! << 16) |
    (bytes[2]! << 8) | bytes[3]!) >>> 0
  return decode(word, address)
}

/** The integer conditions' spellings, by the encoding's condition field. */
const INTEGER_CONDITIONS: readonly (readonly string[])[] = [
  ['n'], ['e', 'z'], ['le'], ['l'], ['leu'], ['cs', 'lu'], ['neg'], ['vs'],
  ['a', ''], ['ne', 'nz'], ['g'], ['ge'], ['gu'], ['cc', 'geu'], ['pos'], ['vc'],
]

/** The floating-point conditions' spellings, likewise. */
const FLOAT_CONDITIONS: readonly (readonly string[])[] = [
  ['n'], ['ne', 'nz'], ['lg'], ['ul'], ['l'], ['ug'], ['g'], ['u'],
  ['a', ''], ['e', 'z'], ['ue'], ['ge'], ['uge'], ['le'], ['ule'], ['o'],
]

/** The letter a floating-point mnemonic gives each format. */
const FORMAT_LETTER: Readonly<Record<number, string>> = {
  [FpFormat.SINGLE]: 's', [FpFormat.DOUBLE]: 'd', [FpFormat.QUAD]: 'q', [FpFormat.INT32]: 'i',
}

/**
 * The integer operations by whether they set the condition codes, with
 * the synthetic names each form can print as.
 */
const ALU_NAMES: ReadonlyMap<number, { plain: readonly string[]; cc: readonly string[] }> = new Map([
  [SPARC.ADD, { plain: ['add', 'inc', 'mov'], cc: ['addcc', 'inccc'] }],
  [SPARC.SUB, { plain: ['sub', 'dec', 'neg'], cc: ['subcc', 'cmp', 'deccc', 'tst'] }],
  [SPARC.AND, { plain: ['and'], cc: ['andcc', 'btst', 'tst'] }],
  [SPARC.OR, { plain: ['or', 'mov', 'clr', 'bset'], cc: ['orcc', 'tst'] }],
  [SPARC.XOR, { plain: ['xor', 'btog'], cc: ['xorcc'] }],
  [SPARC.ANDN, { plain: ['andn', 'bclr'], cc: ['andncc'] }],
  [SPARC.ORN, { plain: ['orn'], cc: ['orncc'] }],
  [SPARC.XNOR, { plain: ['xnor', 'not'], cc: ['xnorcc'] }],
  [SPARC.ADDX, { plain: ['addx'], cc: ['addxcc'] }],
  [SPARC.SUBX, { plain: ['subx'], cc: ['subxcc'] }],
  [SPARC.UMUL, { plain: ['umul'], cc: ['umulcc'] }],
  [SPARC.SMUL, { plain: ['smul'], cc: ['smulcc'] }],
  [SPARC.UDIV, { plain: ['udiv'], cc: ['udivcc'] }],
  [SPARC.SDIV, { plain: ['sdiv'], cc: ['sdivcc'] }],
])

/** The floating-point arithmetic whose name is a stem and the format. */
const FP_STEMS: ReadonlyMap<number, string> = new Map([
  [SPARC.FADD, 'fadd'], [SPARC.FSUB, 'fsub'], [SPARC.FMUL, 'fmul'],
  [SPARC.FDIV, 'fdiv'], [SPARC.FSQRT, 'fsqrt'], [SPARC.FMOV, 'fmov'],
  [SPARC.FNEG, 'fneg'], [SPARC.FABS, 'fabs'],
])

/**
 * The names the decoded fields imply.
 *
 * The decoder folds `addcc` into `add` with a flag, keeps one operation
 * for every integer branch, every floating-point branch and every trap,
 * and one for each floating-point operation across its three formats.
 * Membership accepted any of those names for any of those fields, so a
 * decoder that dropped the flag, misread a condition, ignored the annul
 * bit or took a double for a single passed. Here the fields decide.
 *
 * `fcmp` and `fcmpe` remain one name: they differ only in raising an
 * exception on an unordered compare, which Linux leaves disabled and the
 * interpreter, which keeps no accrued exception bits at all, cannot show.
 */
function signature(inst: SparcInst): readonly string[] | undefined {
  const alu = ALU_NAMES.get(inst.op)
  if (alu !== undefined) return inst.writesIcc ? alu.cc : alu.plain

  const annul = inst.annul ? ',a' : ''
  const fpStem = FP_STEMS.get(inst.op)
  if (fpStem !== undefined) return [`${fpStem}${FORMAT_LETTER[inst.toFormat] ?? '?'}`]

  switch (inst.op) {
    case SPARC.BICC:
      return (INTEGER_CONDITIONS[inst.cond] ?? []).map((c) => `b${c}${annul}`)
    case SPARC.FBFCC:
      return (FLOAT_CONDITIONS[inst.cond] ?? []).map((c) => `fb${c}${annul}`)
    case SPARC.TICC:
      return (INTEGER_CONDITIONS[inst.cond] ?? []).filter((c) => c !== '').map((c) => `t${c}`)
    case SPARC.FTO:
      return [`f${FORMAT_LETTER[inst.fromFormat] ?? '?'}to${FORMAT_LETTER[inst.toFormat] ?? '?'}`]
    case SPARC.FCMP: {
      const letter = FORMAT_LETTER[inst.fromFormat] ?? '?'
      return [`fcmp${letter}`, `fcmpe${letter}`]
    }
    default:
      return undefined
  }
}

export const sparcDecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    return { op: decodeBytes(bytes, address).op, length: 4 }
  },
  signature(bytes, address) {
    return signature(decodeBytes(bytes, address))
  },
  name(op) {
    return SPARC_NAME[op] ?? `?${op}`
  },
  aliases: GENERATED,
  ignored: ['<unknown>', '.word'],
}
