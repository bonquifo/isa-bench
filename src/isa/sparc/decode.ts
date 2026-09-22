/**
 * SPARC V8 decoder.
 *
 * The most regular encoding of any target here, and by some distance the
 * easiest to decode: two bits at the top choose between three formats,
 * and within the big one a six-bit field chooses the operation. There is
 * no prefix, no variable length, no alternate encoding of the same
 * instruction. After x86-64 it reads like a different discipline.
 *
 * Three things about it are not regular, and they are the whole of the
 * interest.
 *
 * **A branch carries an annul bit.** Every control transfer on this
 * architecture has a delay slot, as on MIPS, but here the branch can
 * also say "and do not run the delay instruction". What "not run" means
 * depends on the branch: for a conditional branch the slot is annulled
 * when the branch is *not* taken, and for an unconditional one it is
 * annulled always. The same bit therefore means two different things,
 * and getting it backwards produces a program that works until it meets
 * a loop the compiler chose to close with an annulling branch.
 *
 * **`sethi` is how a constant is built, and also how `nop` is spelled.**
 * A `sethi` writing to `%g0` with a zero immediate does nothing, which is
 * the canonical no-operation. The decoder keeps it as `sethi`; the
 * disassembler prints `nop`.
 *
 * **Most of the assembly language is not instructions.** `mov`, `cmp`,
 * `ret`, `retl`, `tst`, `clr`, `inc` and `not` are all spellings of
 * something else, usually involving `%g0`. That is handled in
 * decodeCheck.node.ts, where the disassembler's names are mapped back.
 */
import { IllegalInstruction, UnimplementedInstruction } from '../common/errors.ts'

export const ISA_NAME = 'sparc'

export const SPARC = {
  ILLEGAL: 0,

  // Format 1 and 2.
  CALL: 1,
  SETHI: 2,
  /** Integer conditional branch; `cond` says which. */
  BICC: 3,
  /** Floating-point conditional branch. */
  FBFCC: 4,
  UNIMP: 5,

  // Format 3: arithmetic and logic. The `cc` variants are the same
  // operation with a flag write, and are distinguished by `writesIcc`
  // rather than by having their own identity -- which is what lets the
  // interpreter have one implementation of add.
  ADD: 10,
  AND: 11,
  OR: 12,
  XOR: 13,
  SUB: 14,
  ANDN: 15,
  ORN: 16,
  XNOR: 17,
  ADDX: 18,
  SUBX: 19,
  UMUL: 20,
  SMUL: 21,
  UDIV: 22,
  SDIV: 23,
  TADDCC: 24,
  TSUBCC: 25,
  TADDCCTV: 26,
  TSUBCCTV: 27,
  MULSCC: 28,
  SLL: 29,
  SRL: 30,
  SRA: 31,

  // State registers.
  RDY: 40,
  RDPSR: 41,
  RDWIM: 42,
  RDTBR: 43,
  WRY: 44,
  WRPSR: 45,
  WRWIM: 46,
  WRTBR: 47,

  // Control and windows.
  JMPL: 50,
  RETT: 51,
  TICC: 52,
  FLUSH: 53,
  SAVE: 54,
  RESTORE: 55,

  // Memory.
  LD: 60,
  LDUB: 61,
  LDUH: 62,
  LDD: 63,
  ST: 64,
  STB: 65,
  STH: 66,
  STD: 67,
  LDSB: 68,
  LDSH: 69,
  LDSTUB: 70,
  SWAP: 71,
  LDF: 72,
  LDDF: 73,
  LDFSR: 74,
  STF: 75,
  STDF: 76,
  STFSR: 77,

  // Floating point. The format is a field of the instruction, not part
  // of the operation, so `fadds` and `faddd` are one entry.
  FADD: 80,
  FSUB: 81,
  FMUL: 82,
  FDIV: 83,
  FSQRT: 84,
  FMOV: 85,
  FNEG: 86,
  FABS: 87,
  /** Integer to float, float to integer, and float to another width. */
  FTO: 88,
  FCMP: 89,
  /** Single to double multiply, which produces a wider result. */
  FSMULD: 90,
} as const

export type SparcOp = (typeof SPARC)[keyof typeof SPARC]

export const SPARC_NAME: readonly string[] = (() => {
  const names: string[] = []
  for (const [key, value] of Object.entries(SPARC)) names[value] = key.toLowerCase()
  return names
})()

export const Flow = {
  SEQ: 0,
  BRANCH: 1,
  CALL: 2,
  INDIRECT: 3,
  TRAP: 4,
} as const
export type FlowKind = (typeof Flow)[keyof typeof Flow]

/** Which values an operand field holds. */
export const Width = {
  NONE: 0,
  BYTE: 1,
  HALF: 2,
  WORD: 4,
  DOUBLE: 8,
} as const

/**
 * The floating-point format an instruction works in.
 *
 * Carried as a field because the opcode does not distinguish them: the
 * `opf` field spells out `fadds`, `faddd` and `faddq` as three encodings
 * of one operation, and treating them as three operations would triple
 * the table for no gain.
 */
export const FpFormat = {
  NONE: 0,
  SINGLE: 1,
  DOUBLE: 2,
  QUAD: 3,
  /** A 32-bit integer held in a floating-point register. */
  INT32: 4,
} as const
export type FpFormat = (typeof FpFormat)[keyof typeof FpFormat]

export interface SparcInst {
  op: SparcOp
  /** Source and destination register numbers, or -1 where unused. */
  rd: number
  rs1: number
  rs2: number
  /** True when the second operand is `simm13` rather than `rs2`. */
  immediate: boolean
  /** Sign-extended `simm13`, or the `sethi`/branch/call displacement. */
  imm: number
  /** Branch and call target, absolute. */
  target: number
  /** Condition field of a branch or trap. */
  cond: number
  /** The annul bit of a branch. */
  annul: boolean
  /** Whether this instruction writes the integer condition codes. */
  writesIcc: boolean
  /** Bytes touched by a load or store, or 0. */
  width: number
  /** Whether a load sign-extends. */
  signed: boolean
  /** Source format for floating point, and destination format. */
  fromFormat: FpFormat
  toFormat: FpFormat
  flow: FlowKind
  word: number
}

/** Condition codes, shared by branches and by `Ticc`. */
export const Cond = {
  N: 0, E: 1, LE: 2, L: 3, LEU: 4, CS: 5, NEG: 6, VS: 7,
  A: 8, NE: 9, G: 10, GE: 11, GU: 12, CC: 13, POS: 14, VC: 15,
} as const

function bits(word: number, high: number, low: number): number {
  return (word >>> low) & ((1 << (high - low + 1)) - 1)
}

function signExtend(value: number, width: number): number {
  const shift = 32 - width
  return (value << shift) >> shift
}

function blank(word: number): SparcInst {
  return {
    op: SPARC.ILLEGAL,
    rd: -1, rs1: -1, rs2: -1,
    immediate: false,
    imm: 0,
    target: 0,
    cond: 0,
    annul: false,
    writesIcc: false,
    width: 0,
    signed: false,
    fromFormat: FpFormat.NONE,
    toFormat: FpFormat.NONE,
    flow: Flow.SEQ,
    word,
  }
}

/** op=2 arithmetic, indexed by op3 with the flag-setting bit masked off. */
const ALU_OPS: Readonly<Record<number, SparcOp>> = {
  0x00: SPARC.ADD, 0x01: SPARC.AND, 0x02: SPARC.OR, 0x03: SPARC.XOR,
  0x04: SPARC.SUB, 0x05: SPARC.ANDN, 0x06: SPARC.ORN, 0x07: SPARC.XNOR,
  0x08: SPARC.ADDX, 0x0c: SPARC.SUBX,
  0x0a: SPARC.UMUL, 0x0b: SPARC.SMUL, 0x0e: SPARC.UDIV, 0x0f: SPARC.SDIV,
}

/** op=3 memory operations, indexed by op3. */
interface MemEntry { op: SparcOp; width: number; signed: boolean; float: boolean }
const M = (op: SparcOp, width: number, signed = false, float = false): MemEntry =>
  ({ op, width, signed, float })

const MEM_OPS: Readonly<Record<number, MemEntry>> = {
  0x00: M(SPARC.LD, 4), 0x01: M(SPARC.LDUB, 1), 0x02: M(SPARC.LDUH, 2),
  0x03: M(SPARC.LDD, 8),
  0x04: M(SPARC.ST, 4), 0x05: M(SPARC.STB, 1), 0x06: M(SPARC.STH, 2),
  0x07: M(SPARC.STD, 8),
  0x09: M(SPARC.LDSB, 1, true), 0x0a: M(SPARC.LDSH, 2, true),
  0x0d: M(SPARC.LDSTUB, 1), 0x0f: M(SPARC.SWAP, 4),
  0x20: M(SPARC.LDF, 4, false, true), 0x21: M(SPARC.LDFSR, 4, false, true),
  0x23: M(SPARC.LDDF, 8, false, true),
  0x24: M(SPARC.STF, 4, false, true), 0x25: M(SPARC.STFSR, 4, false, true),
  0x27: M(SPARC.STDF, 8, false, true),
}

/** FPop1, indexed by the `opf` field. */
interface FpEntry { op: SparcOp; from: FpFormat; to: FpFormat }
const F = (op: SparcOp, from: FpFormat, to: FpFormat): FpEntry => ({ op, from, to })
const S = FpFormat.SINGLE
const D = FpFormat.DOUBLE
const Q = FpFormat.QUAD
const I32 = FpFormat.INT32

const FPOP1: Readonly<Record<number, FpEntry>> = {
  0x001: F(SPARC.FMOV, S, S),
  0x005: F(SPARC.FNEG, S, S),
  0x009: F(SPARC.FABS, S, S),
  0x029: F(SPARC.FSQRT, S, S), 0x02a: F(SPARC.FSQRT, D, D), 0x02b: F(SPARC.FSQRT, Q, Q),
  0x041: F(SPARC.FADD, S, S), 0x042: F(SPARC.FADD, D, D), 0x043: F(SPARC.FADD, Q, Q),
  0x045: F(SPARC.FSUB, S, S), 0x046: F(SPARC.FSUB, D, D), 0x047: F(SPARC.FSUB, Q, Q),
  0x049: F(SPARC.FMUL, S, S), 0x04a: F(SPARC.FMUL, D, D), 0x04b: F(SPARC.FMUL, Q, Q),
  0x04d: F(SPARC.FDIV, S, S), 0x04e: F(SPARC.FDIV, D, D), 0x04f: F(SPARC.FDIV, Q, Q),
  0x069: F(SPARC.FSMULD, S, D),
  0x0c4: F(SPARC.FTO, I32, S), 0x0c8: F(SPARC.FTO, I32, D),
  0x0cc: F(SPARC.FTO, I32, Q),
  0x0d1: F(SPARC.FTO, S, I32), 0x0d2: F(SPARC.FTO, D, I32),
  0x0d3: F(SPARC.FTO, Q, I32),
  0x0c9: F(SPARC.FTO, S, D), 0x0cd: F(SPARC.FTO, S, Q),
  0x0c6: F(SPARC.FTO, D, S), 0x0ce: F(SPARC.FTO, D, Q),
  0x0c7: F(SPARC.FTO, Q, S), 0x0cb: F(SPARC.FTO, Q, D),
}

/** The floating-point operations that read one source rather than two. */
const UNARY_FP = new Set<SparcOp>([
  SPARC.FMOV, SPARC.FNEG, SPARC.FABS, SPARC.FSQRT, SPARC.FTO,
])

/** FPop2: the comparisons, which write the floating-point condition code. */
const FPOP2: Readonly<Record<number, FpEntry>> = {
  0x051: F(SPARC.FCMP, S, S), 0x052: F(SPARC.FCMP, D, D), 0x053: F(SPARC.FCMP, Q, Q),
  0x055: F(SPARC.FCMP, S, S), 0x056: F(SPARC.FCMP, D, D), 0x057: F(SPARC.FCMP, Q, Q),
}

function refuse(address: bigint, word: number, detail: string): never {
  const raw = new Uint8Array(4)
  // Big endian: the first byte in memory is the most significant.
  raw[0] = (word >>> 24) & 0xff
  raw[1] = (word >>> 16) & 0xff
  raw[2] = (word >>> 8) & 0xff
  raw[3] = word & 0xff
  throw new UnimplementedInstruction(ISA_NAME, address, raw, detail)
}

export function decode(word: number, address: bigint): SparcInst {
  const inst = blank(word >>> 0)
  const op = bits(word, 31, 30)
  const here = Number(address & 0xffffffffn)

  // ---- Format 1: call, and nothing else. -------------------------------
  if (op === 1) {
    inst.op = SPARC.CALL
    // A 30-bit word displacement, so the reach is the whole address space.
    inst.imm = signExtend(bits(word, 29, 0), 30) * 4
    inst.target = (here + inst.imm) >>> 0
    inst.flow = Flow.CALL
    // The return address goes in %o7, always.
    inst.rd = 15
    return inst
  }

  // ---- Format 2: sethi and the branches. -------------------------------
  if (op === 0) {
    const op2 = bits(word, 24, 22)
    if (op2 === 0) {
      inst.op = SPARC.UNIMP
      inst.flow = Flow.TRAP
      return inst
    }
    if (op2 === 4) {
      inst.op = SPARC.SETHI
      inst.rd = bits(word, 29, 25)
      // The immediate occupies the top 22 bits of the result.
      inst.imm = (bits(word, 21, 0) << 10) >>> 0
      return inst
    }
    if (op2 === 2 || op2 === 6) {
      inst.op = op2 === 2 ? SPARC.BICC : SPARC.FBFCC
      inst.cond = bits(word, 28, 25)
      inst.annul = bits(word, 29, 29) === 1
      inst.imm = signExtend(bits(word, 21, 0), 22) * 4
      inst.target = (here + inst.imm) >>> 0
      inst.flow = Flow.BRANCH
      return inst
    }
    // op2 3 and 5 are reserved; 7 is the coprocessor branch, and there is
    // no coprocessor here to branch on.
    return refuse(address, word, `format 2 op2 ${op2}`)
  }

  const rd = bits(word, 29, 25)
  const op3 = bits(word, 24, 19)
  const rs1 = bits(word, 18, 14)
  const useImm = bits(word, 13, 13) === 1
  const rs2 = bits(word, 4, 0)
  const simm13 = signExtend(bits(word, 12, 0), 13)

  inst.rd = rd
  inst.rs1 = rs1
  inst.immediate = useImm
  if (useImm) inst.imm = simm13
  else inst.rs2 = rs2

  // ---- Format 3, op=3: loads and stores. -------------------------------
  if (op === 3) {
    const entry = MEM_OPS[op3]
    if (!entry) {
      // The alternate-space forms have bit 5 of op3 set and name an ASI.
      // A user-mode program cannot execute one; refusing is correct
      // rather than conservative.
      return refuse(address, word, `load/store op3 0x${op3.toString(16)}`)
    }
    inst.op = entry.op
    inst.width = entry.width
    inst.signed = entry.signed
    if (entry.float) inst.toFormat = entry.width === 8 ? FpFormat.DOUBLE : FpFormat.SINGLE
    return inst
  }

  // ---- Format 3, op=2: everything else. --------------------------------
  // The flag-setting arithmetic is the same op3 with bit 4 set, which is
  // why one table serves both and `writesIcc` is a property rather than
  // a separate operation.
  if (op3 < 0x20) {
    const base = op3 & 0x0f
    const entry = ALU_OPS[base]
    if (entry === undefined) return refuse(address, word, `alu op3 0x${op3.toString(16)}`)
    inst.op = entry
    inst.writesIcc = (op3 & 0x10) !== 0
    return inst
  }

  switch (op3) {
    case 0x20: inst.op = SPARC.TADDCC; inst.writesIcc = true; return inst
    case 0x21: inst.op = SPARC.TSUBCC; inst.writesIcc = true; return inst
    case 0x22: inst.op = SPARC.TADDCCTV; inst.writesIcc = true; inst.flow = Flow.TRAP; return inst
    case 0x23: inst.op = SPARC.TSUBCCTV; inst.writesIcc = true; inst.flow = Flow.TRAP; return inst
    case 0x24: inst.op = SPARC.MULSCC; inst.writesIcc = true; return inst
    case 0x25: inst.op = SPARC.SLL; return inst
    case 0x26: inst.op = SPARC.SRL; return inst
    case 0x27: inst.op = SPARC.SRA; return inst

    case 0x28:
      // One encoding, four registers, chosen by rs1. `rd %y` is the
      // common one; the others are privileged and cannot run here.
      if (rs1 === 0) { inst.op = SPARC.RDY; inst.rs1 = -1; return inst }
      return refuse(address, word, `rd of state register ${rs1}`)
    case 0x29: return refuse(address, word, 'rd %psr is privileged')
    case 0x2a: return refuse(address, word, 'rd %wim is privileged')
    case 0x2b: return refuse(address, word, 'rd %tbr is privileged')

    case 0x30:
      if (rd === 0) { inst.op = SPARC.WRY; inst.rd = -1; return inst }
      return refuse(address, word, `wr of state register ${rd}`)
    case 0x31: return refuse(address, word, 'wr %psr is privileged')
    case 0x32: return refuse(address, word, 'wr %wim is privileged')
    case 0x33: return refuse(address, word, 'wr %tbr is privileged')

    case 0x34: {
      const opf = bits(word, 13, 5)
      const entry = FPOP1[opf]
      if (!entry) return refuse(address, word, `fpop1 opf 0x${opf.toString(16)}`)
      inst.op = entry.op
      inst.fromFormat = entry.from
      inst.toFormat = entry.to
      inst.rs2 = rs2
      inst.immediate = false
      // The unary operations encode an rs1 field and ignore it. Leaving
      // it set would make the dependence analysis claim a read of a
      // register the instruction never looks at.
      if (UNARY_FP.has(entry.op)) inst.rs1 = -1
      return inst
    }
    case 0x35: {
      const opf = bits(word, 13, 5)
      const entry = FPOP2[opf]
      if (!entry) return refuse(address, word, `fpop2 opf 0x${opf.toString(16)}`)
      inst.op = entry.op
      inst.fromFormat = entry.from
      inst.toFormat = entry.to
      inst.rs2 = rs2
      inst.rd = -1
      inst.immediate = false
      return inst
    }

    case 0x38: inst.op = SPARC.JMPL; inst.flow = Flow.INDIRECT; return inst
    case 0x39: return refuse(address, word, 'rett is privileged')
    case 0x3a:
      inst.op = SPARC.TICC
      inst.cond = bits(word, 28, 25)
      inst.rd = -1
      inst.flow = Flow.TRAP
      return inst
    case 0x3b:
      // A hint to a cache this model does not have, and architecturally
      // a no-operation for everything the interpreter tracks.
      inst.op = SPARC.FLUSH
      inst.rd = -1
      return inst
    case 0x3c: inst.op = SPARC.SAVE; return inst
    case 0x3d: inst.op = SPARC.RESTORE; return inst
    default:
      return refuse(address, word, `op3 0x${op3.toString(16)}`)
  }
}

export function illegal(address: bigint, word: number): never {
  const raw = new Uint8Array(4)
  raw[0] = (word >>> 24) & 0xff
  raw[1] = (word >>> 16) & 0xff
  raw[2] = (word >>> 8) & 0xff
  raw[3] = word & 0xff
  throw new IllegalInstruction(ISA_NAME, address, raw)
}
