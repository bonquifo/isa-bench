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
 * The other half of this table is the flag-setting arithmetic. The
 * decoder folds `addcc` into `add` and records that it writes the
 * condition codes, because they are the same operation and the encoding
 * says so -- bit four of `op3`. The disassembler spells them as separate
 * mnemonics, so each one is listed here against the operation it folds
 * into.
 */
import { SPARC, SPARC_NAME, decode } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

const ALIASES: Readonly<Record<string, readonly number[]>> = {
  // %g0 makes one instruction look like several.
  mov: [SPARC.OR, SPARC.ADD, SPARC.RDY],
  nop: [SPARC.SETHI],
  cmp: [SPARC.SUB],
  tst: [SPARC.OR, SPARC.SUB, SPARC.AND],
  clr: [SPARC.OR, SPARC.ST, SPARC.STB, SPARC.STH, SPARC.STD],
  clrb: [SPARC.STB],
  clrh: [SPARC.STH],
  not: [SPARC.XNOR],
  neg: [SPARC.SUB],
  inc: [SPARC.ADD],
  inccc: [SPARC.ADD],
  dec: [SPARC.SUB],
  deccc: [SPARC.SUB],
  btst: [SPARC.AND],
  bset: [SPARC.OR],
  bclr: [SPARC.ANDN],
  btog: [SPARC.XOR],
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

  // The flag-setting arithmetic, which the decoder folds into the
  // operation it sets flags for.
  addcc: [SPARC.ADD],
  andcc: [SPARC.AND],
  orcc: [SPARC.OR],
  xorcc: [SPARC.XOR],
  subcc: [SPARC.SUB],
  andncc: [SPARC.ANDN],
  orncc: [SPARC.ORN],
  xnorcc: [SPARC.XNOR],
  addxcc: [SPARC.ADDX],
  subxcc: [SPARC.SUBX],
  umulcc: [SPARC.UMUL],
  smulcc: [SPARC.SMUL],
  udivcc: [SPARC.UDIV],
  sdivcc: [SPARC.SDIV],

  // Every integer branch is one instruction with a condition field.
  ba: [SPARC.BICC], bn: [SPARC.BICC], be: [SPARC.BICC], bne: [SPARC.BICC],
  bg: [SPARC.BICC], ble: [SPARC.BICC], bge: [SPARC.BICC], bl: [SPARC.BICC],
  bgu: [SPARC.BICC], bleu: [SPARC.BICC], bcc: [SPARC.BICC], bcs: [SPARC.BICC],
  bpos: [SPARC.BICC], bneg: [SPARC.BICC], bvc: [SPARC.BICC], bvs: [SPARC.BICC],
  bgeu: [SPARC.BICC], blu: [SPARC.BICC], bz: [SPARC.BICC], bnz: [SPARC.BICC],
  // And every floating-point branch likewise.
  fba: [SPARC.FBFCC], fbn: [SPARC.FBFCC], fbu: [SPARC.FBFCC], fbg: [SPARC.FBFCC],
  fbug: [SPARC.FBFCC], fbl: [SPARC.FBFCC], fbul: [SPARC.FBFCC], fblg: [SPARC.FBFCC],
  fbne: [SPARC.FBFCC], fbe: [SPARC.FBFCC], fbue: [SPARC.FBFCC], fbge: [SPARC.FBFCC],
  fbuge: [SPARC.FBFCC], fble: [SPARC.FBFCC], fbule: [SPARC.FBFCC], fbo: [SPARC.FBFCC],

  // The trap-on-condition family, one instruction with a condition.
  ta: [SPARC.TICC], tn: [SPARC.TICC], te: [SPARC.TICC], tne: [SPARC.TICC],
  tg: [SPARC.TICC], tle: [SPARC.TICC], tge: [SPARC.TICC], tl: [SPARC.TICC],
  tgu: [SPARC.TICC], tleu: [SPARC.TICC], tcc: [SPARC.TICC], tcs: [SPARC.TICC],
  tpos: [SPARC.TICC], tneg: [SPARC.TICC], tvc: [SPARC.TICC], tvs: [SPARC.TICC],
}

/**
 * The floating-point mnemonics, which name their format and so multiply
 * out. Generated rather than listed: it is one fact stated repeatedly,
 * and writing it out by hand is how a typo gets into a table that is
 * supposed to be catching typos.
 */
const GENERATED: Record<string, readonly number[]> = { ...ALIASES }
for (const [stem, op] of [
  ['fadd', SPARC.FADD], ['fsub', SPARC.FSUB], ['fmul', SPARC.FMUL],
  ['fdiv', SPARC.FDIV], ['fsqrt', SPARC.FSQRT],
] as const) {
  for (const format of ['s', 'd', 'q']) GENERATED[`${stem}${format}`] = [op]
}
for (const [stem, op] of [
  ['fmov', SPARC.FMOV], ['fneg', SPARC.FNEG], ['fabs', SPARC.FABS],
] as const) {
  GENERATED[`${stem}s`] = [op]
}
GENERATED.fsmuld = [SPARC.FSMULD]

// The annul bit is spelled as part of the mnemonic -- `bl,a` rather
// than `bl a` -- so it arrives attached to the name rather than as an
// operand, and every branch has a second spelling.
for (const [name, ops] of Object.entries({ ...GENERATED })) {
  if (/^f?b/.test(name) && ops.length === 1 &&
      (ops[0] === SPARC.BICC || ops[0] === SPARC.FBFCC)) {
    GENERATED[`${name},a`] = ops
  }
}
for (const from of ['i', 's', 'd', 'q']) {
  for (const to of ['i', 's', 'd', 'q']) {
    if (from === to) continue
    GENERATED[`f${from}to${to}`] = [SPARC.FTO]
  }
}
for (const format of ['s', 'd', 'q']) {
  GENERATED[`fcmp${format}`] = [SPARC.FCMP]
  GENERATED[`fcmpe${format}`] = [SPARC.FCMP]
}

export const sparcDecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    // Big endian: the first byte in memory is the most significant.
    const word = ((bytes[0]! << 24) | (bytes[1]! << 16) |
      (bytes[2]! << 8) | bytes[3]!) >>> 0
    return { op: decode(word, address).op, length: 4 }
  },
  name(op) {
    return SPARC_NAME[op] ?? `?${op}`
  },
  aliases: GENERATED,
  ignored: ['<unknown>', '.word'],
}
