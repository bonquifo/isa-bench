/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * Nearly everything here is the alias table, and the size of it is the
 * point: AArch64's assembly language is largely made of pseudo-
 * instructions. `cmp` is a subtract that discards its result, `lsl` is a
 * bitfield move, `cset` is a conditional increment from the zero
 * register, and `mov` is any of four different instructions depending on
 * what is being moved. A decoder that agrees with the disassembler on
 * all of them agrees about the encoding; one that does not has usually
 * matched a general form where a specific one was meant, or the reverse.
 */
import { A64, A64_NAME, decode } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

/** Each alias, and the real instructions it is allowed to stand for. */
const ALIASES: Readonly<Record<string, readonly number[]>> = {
  mov: [A64.ORR, A64.ADD, A64.MOVZ, A64.MOVN, A64.FMOV_REG, A64.FMOV_TO_GP,
    A64.FMOV_FROM_GP, A64.UMOV, A64.INS_GENERAL, A64.DUP_ELEMENT, A64.ORR_VEC],
  movi: [A64.MOVI],
  mvn: [A64.ORN],
  mvni: [A64.MOVI],
  neg: [A64.SUB],
  negs: [A64.SUB],
  ngc: [A64.SBC],
  cmp: [A64.SUB],
  cmn: [A64.ADD],
  tst: [A64.AND],
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
  // Loads and stores print their width in the mnemonic; the decoder
  // carries it as a field instead.
  ldr: [A64.LOAD, A64.LOAD_LITERAL],
  ldrb: [A64.LOAD],
  ldrh: [A64.LOAD],
  ldrsb: [A64.LOAD],
  ldrsh: [A64.LOAD],
  ldrsw: [A64.LOAD, A64.LOAD_LITERAL],
  ldur: [A64.LOAD],
  ldurb: [A64.LOAD],
  ldurh: [A64.LOAD],
  ldursb: [A64.LOAD],
  ldursh: [A64.LOAD],
  ldursw: [A64.LOAD],
  str: [A64.STORE],
  strb: [A64.STORE],
  strh: [A64.STORE],
  stur: [A64.STORE],
  sturb: [A64.STORE],
  sturh: [A64.STORE],
  ldp: [A64.LOAD_PAIR],
  ldpsw: [A64.LOAD_PAIR],
  stp: [A64.STORE_PAIR],
  ldnp: [A64.LOAD_PAIR],
  stnp: [A64.STORE_PAIR],
  ldar: [A64.LOAD],
  ldarb: [A64.LOAD],
  ldarh: [A64.LOAD],
  stlr: [A64.STORE],
  stlrb: [A64.STORE],
  stlrh: [A64.STORE],
  ldxr: [A64.LOAD_EXCLUSIVE],
  ldxrb: [A64.LOAD_EXCLUSIVE],
  ldxrh: [A64.LOAD_EXCLUSIVE],
  ldaxr: [A64.LOAD_EXCLUSIVE],
  ldaxrb: [A64.LOAD_EXCLUSIVE],
  ldaxrh: [A64.LOAD_EXCLUSIVE],
  stxr: [A64.STORE_EXCLUSIVE],
  stxrb: [A64.STORE_EXCLUSIVE],
  stxrh: [A64.STORE_EXCLUSIVE],
  stlxr: [A64.STORE_EXCLUSIVE],
  stlxrb: [A64.STORE_EXCLUSIVE],
  stlxrh: [A64.STORE_EXCLUSIVE],
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
  orr: [A64.ORR, A64.ORR_VEC, A64.MOVI],
  and: [A64.AND, A64.AND_VEC],
  eor: [A64.EOR, A64.EOR_VEC],
  add: [A64.ADD, A64.ADD_VEC],
  sub: [A64.SUB],
  // The flag-setting twins are the same operation with one bit set, and
  // the decoder carries that bit as a field rather than as an opcode.
  adds: [A64.ADD],
  subs: [A64.SUB],
  ands: [A64.AND],
  bics: [A64.BIC],
  adcs: [A64.ADC],
  sbcs: [A64.SBC],
  ngcs: [A64.SBC],
  clrex: [A64.CLREX],
  fmov: [A64.FMOV_REG, A64.FMOV_IMM, A64.FMOV_TO_GP, A64.FMOV_FROM_GP],
  // The conversions name their rounding direction in the mnemonic; the
  // decoder carries it as a field, so six names share one operation.
  fcvtas: [A64.FCVT_TO_INT],
  fcvtau: [A64.FCVT_TO_INT],
  fcvtms: [A64.FCVT_TO_INT],
  fcvtmu: [A64.FCVT_TO_INT],
  fcvtns: [A64.FCVT_TO_INT],
  fcvtnu: [A64.FCVT_TO_INT],
  fcvtps: [A64.FCVT_TO_INT],
  fcvtpu: [A64.FCVT_TO_INT],
  fcvtzs: [A64.FCVT_TO_INT],
  fcvtzu: [A64.FCVT_TO_INT],
  scvtf: [A64.FCVT_FROM_INT],
  ucvtf: [A64.FCVT_FROM_INT],
  frinta: [A64.FRINT],
  frinti: [A64.FRINT],
  frintm: [A64.FRINT],
  frintn: [A64.FRINT],
  frintp: [A64.FRINT],
  frintx: [A64.FRINT],
  frintz: [A64.FRINT],
  // The signalling compare differs only in which exception an unordered
  // comparison raises.
  fcmpe: [A64.FCMP],
  fccmpe: [A64.FCCMP],
  // A `2` suffix means the upper half of the narrow source, which is a
  // field rather than a different instruction.
  saddl2: [A64.SADDL],
  saddw2: [A64.SADDW],
  xtn2: [A64.XTN],
  uzp1: [A64.UZP1],
  addp: [A64.ADDP_SCALAR],
  addv: [A64.ADDV],
  ushl: [A64.USHL],
  xtn: [A64.XTN],
  saddl: [A64.SADDL],
  saddw: [A64.SADDW],
  ld1: [A64.LD1_LANE],
  mrs: [A64.MRS],
  msr: [A64.MSR],
}

/** A conditional branch prints as `b.eq` and the like. */
function normalise(mnemonic: string): string {
  if (mnemonic.startsWith('b.')) return 'b_cond'
  return mnemonic
}

export const aarch64DecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    const word = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) |
      (bytes[3]! << 24)) >>> 0
    return { op: decode(word, address).op, length: 4 }
  },
  name(op) {
    return A64_NAME[op] ?? `?${op}`
  },
  aliases: new Proxy(ALIASES, {
    get(target, key: string) {
      return target[normalise(key)] ?? (normalise(key) === 'b_cond' ? [A64.B_COND] : undefined)
    },
    has(target, key: string) {
      return normalise(key) in target
    },
  }),
  // `udf` is the permanently-undefined encoding, and a disassembler
  // prints it rather than refusing.
  refused: ['udf'],
}
