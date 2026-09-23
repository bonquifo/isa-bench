/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * Two checks, for two kinds of name. AArch64's assembly language is
 * largely made of pseudo-instructions: `lsl` is a bitfield move, `cset`
 * is a conditional increment from the zero register, and `mov` is any of
 * several instructions depending on what is being moved. Those differ by
 * operand, and the alias table admits each as one of the instructions it
 * can stand for. Where a name instead reflects a field the interpreter
 * acts on -- a width, a condition, a rounding mode -- the signature
 * further down requires the exact name the field implies.
 */
import { A64, A64_NAME, Round, decode, type A64Inst } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

/** Each alias, and the real instructions it is allowed to stand for. */
const ALIASES: Readonly<Record<string, readonly number[]>> = {
  // `mov` to or from sp is an add, which the signature below admits.
  mov: [A64.ORR, A64.MOVZ, A64.MOVN, A64.FMOV_REG, A64.FMOV_TO_GP,
    A64.FMOV_FROM_GP, A64.UMOV, A64.INS_GENERAL, A64.DUP_ELEMENT, A64.ORR_VEC],
  mvn: [A64.ORN],
  cset: [A64.CSINC],
  csetm: [A64.CSINV],
  cinc: [A64.CSINC],
  cinv: [A64.CSINV],
  cneg: [A64.CSNEG],
  lsl: [A64.UBFM, A64.LSLV],
  lsr: [A64.UBFM, A64.LSRV],
  asr: [A64.SBFM, A64.ASRV],
  ror: [A64.EXTR, A64.RORV],
  ubfx: [A64.UBFM],
  ubfiz: [A64.UBFM],
  sbfx: [A64.SBFM],
  sbfiz: [A64.SBFM],
  bfi: [A64.BFM],
  bfxil: [A64.BFM],
  bfc: [A64.BFM],
  sxtb: [A64.SBFM],
  sxth: [A64.SBFM],
  sxtw: [A64.SBFM],
  uxtb: [A64.UBFM],
  uxth: [A64.UBFM],
  nop: [A64.NOP],
  ret: [A64.RET],
  // The barriers and the hint space, which print under many names.
  dmb: [A64.BARRIER],
  dsb: [A64.BARRIER],
  isb: [A64.BARRIER],
  yield: [A64.NOP],
  sev: [A64.NOP],
  sevl: [A64.NOP],
  wfe: [A64.NOP],
  wfi: [A64.NOP],
  hint: [A64.NOP],
  // The multiply family, whose accumulate forms print without the
  // register they accumulate into when it is the zero register.
  mul: [A64.MADD, A64.MUL_VEC, A64.MUL_ELEMENT],
  mneg: [A64.MSUB],
  madd: [A64.MADD],
  msub: [A64.MSUB],
  smull: [A64.SMADDL],
  smnegl: [A64.SMSUBL],
  umull: [A64.UMADDL],
  umnegl: [A64.UMSUBL],
  smaddl: [A64.SMADDL],
  umaddl: [A64.UMADDL],
  smsubl: [A64.SMSUBL],
  umsubl: [A64.UMSUBL],
  // Sign and zero extension folded into an add.
  rev64: [A64.REV],
  // Data-cache maintenance prints the operation as an operand.
  dc: [A64.DC_ZVA],
  dup: [A64.DUP_GENERAL, A64.DUP_ELEMENT],
  umov: [A64.UMOV],
  orr: [A64.ORR, A64.ORR_VEC],
  and: [A64.AND_VEC],
  eor: [A64.EOR, A64.EOR_VEC],
  add: [A64.ADD_VEC],
  clrex: [A64.CLREX],
  fmov: [A64.FMOV_REG, A64.FMOV_IMM, A64.FMOV_TO_GP, A64.FMOV_FROM_GP],
  // The signalling compare differs only in which exception an unordered
  // comparison raises.
  fcmpe: [A64.FCMP],
  fccmpe: [A64.FCCMP],
  uzp1: [A64.UZP1],
  addp: [A64.ADDP_SCALAR],
  addv: [A64.ADDV],
  ushl: [A64.USHL],
  ld1: [A64.LD1_LANE],
  mrs: [A64.MRS],
  msr: [A64.MSR],
}

function decodeBytes(bytes: Uint8Array, address: bigint): A64Inst {
  const word = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) |
    (bytes[3]! << 24)) >>> 0
  return decode(word, address)
}

/** The branch conditions, with the two the disassembler spells two ways. */
const CONDITION_NAMES: readonly (readonly string[])[] = [
  ['eq'], ['ne'], ['hs', 'cs'], ['lo', 'cc'], ['mi'], ['pl'], ['vs'], ['vc'],
  ['hi'], ['ls'], ['ge'], ['lt'], ['gt'], ['le'], ['al'], ['nv'],
]

/** What each rounding mode is called inside `fcvt?s` and `frint?`. */
const ROUNDING_LETTER: Readonly<Record<number, string>> = {
  [Round.NEAREST_EVEN]: 'n',
  [Round.POS_INF]: 'p',
  [Round.NEG_INF]: 'm',
  [Round.ZERO]: 'z',
  [Round.NEAREST_AWAY]: 'a',
  [Round.EXACT]: 'x',
  [Round.CURRENT]: 'i',
}

/** The width-and-sign part of a load or store name. */
function accessStem(width: number, signed: boolean): string {
  if (width === 1) return signed ? 'sb' : 'b'
  if (width === 2) return signed ? 'sh' : 'h'
  if (width === 4) return signed ? 'sw' : ''
  return ''
}

/**
 * The names the decoded fields imply.
 *
 * AArch64's decoder carries width, sign, rounding, condition and whether
 * flags are set as *fields*, which is the right design for an interpreter
 * and exactly what membership cannot check: ten `fcvt` names, seven
 * `frint` names, every load width and every branch condition each shared
 * one operation, so a decoder that read the rounding mode or the condition
 * wrongly would have passed. Here those fields decide the name.
 *
 * The narrowing and widening vector operations likewise: `xtn` and `xtn2`
 * write different halves of the destination.
 *
 * What is still admitted as a choice of spellings is only what differs by
 * operand or addressing form -- `cmp` is `subs` into the zero register,
 * `ldur` is `ldr` with an unscaled offset -- because the lockstep tier
 * checks operands and addresses on every instruction it executes.
 */
function signature(inst: A64Inst): readonly string[] | undefined {
  switch (inst.op) {
    case A64.B_COND:
      return (CONDITION_NAMES[inst.cond] ?? []).map((name) => `b.${name}`)

    case A64.LOAD: {
      if (inst.fpTransfer) return ['ldr', 'ldur']
      const stem = accessStem(inst.width, inst.signed)
      return inst.signed ? [`ldr${stem}`, `ldur${stem}`] : [`ldr${stem}`, `ldur${stem}`, `ldar${stem}`]
    }
    case A64.STORE: {
      if (inst.fpTransfer) return ['str', 'stur']
      const stem = accessStem(inst.width, false)
      return [`str${stem}`, `stur${stem}`, `stlr${stem}`]
    }
    case A64.LOAD_LITERAL:
      return inst.signed ? ['ldrsw'] : ['ldr']
    case A64.LOAD_PAIR:
      return inst.signed ? ['ldpsw'] : ['ldp']
    case A64.STORE_PAIR:
      return ['stp']
    case A64.LOAD_EXCLUSIVE: {
      const stem = accessStem(inst.width, false)
      return [`ldxr${stem}`, `ldaxr${stem}`]
    }
    case A64.STORE_EXCLUSIVE: {
      const stem = accessStem(inst.width, false)
      return [`stxr${stem}`, `stlxr${stem}`]
    }

    case A64.FCVT_TO_INT:
      return [`fcvt${ROUNDING_LETTER[inst.rounding] ?? '?'}${inst.signed ? 's' : 'u'}`]
    case A64.FCVT_FROM_INT:
      return [inst.signed ? 'scvtf' : 'ucvtf']
    case A64.FRINT:
      return [`frint${ROUNDING_LETTER[inst.rounding] ?? '?'}`]

    // A replacing move, whichever way its immediate was written.
    case A64.MOVI:
      return ['movi', 'mvni']

    // A `2` reads or writes the upper half of the narrow register rather
    // than the lower, which is a different result.
    case A64.SADDL: return [inst.part ? 'saddl2' : 'saddl']
    case A64.SADDW: return [inst.part ? 'saddw2' : 'saddw']
    case A64.XTN: return [inst.part ? 'xtn2' : 'xtn']

    // Whether flags are set is the behaviour; the rest is operands.
    case A64.ADD: return inst.setFlags ? ['adds', 'cmn'] : ['add', 'mov']
    case A64.SUB: return inst.setFlags ? ['subs', 'cmp', 'negs'] : ['sub', 'neg']
    case A64.AND: return inst.setFlags ? ['ands', 'tst'] : ['and']
    case A64.BIC: return inst.setFlags ? ['bics'] : ['bic']
    case A64.ADC: return inst.setFlags ? ['adcs'] : ['adc']
    case A64.SBC: return inst.setFlags ? ['sbcs', 'ngcs'] : ['sbc', 'ngc']

    default:
      return undefined
  }
}

export const aarch64DecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    return { op: decodeBytes(bytes, address).op, length: 4 }
  },
  signature(bytes, address) {
    return signature(decodeBytes(bytes, address))
  },
  name(op) {
    return A64_NAME[op] ?? `?${op}`
  },
  aliases: ALIASES,
  // `udf` is the permanently-undefined encoding, and a disassembler
  // prints it rather than refusing.
  refused: ['udf'],
}
