/**
 * AArch64 decoder.
 *
 * Fixed 32-bit encodings, so there is no length problem to solve, but far
 * more encoding groups than RISC-V and considerably more per instruction:
 * most arithmetic can shift or extend its second operand as part of the
 * instruction, most of it has a flag-setting twin, and a whole family reads
 * those flags back.
 *
 * The decoded record is therefore wider than RISC-V's. That is deliberate:
 * carrying the shift kind, the extension kind and the index mode as fields
 * keeps the execute switch to one case per operation, rather than one case
 * per operation times the ways its operands can be formed.
 *
 * Nothing falls through. An encoding this decoder does not implement raises
 * UnimplementedInstruction; a bit pattern that is not an instruction at all
 * raises IllegalInstruction.
 */
import { IllegalInstruction, UnimplementedInstruction } from '../common/errors.ts'

export const ISA_NAME = 'aarch64'

/**
 * Bytes a single `dc zva` clears, and the block size DCZID_EL0 reports.
 *
 * The architecture lets an implementation choose this. Two answers would be
 * wrong. One is an inconsistent pair, because a libc reads the register to
 * size its loop and then calls the instruction that loop is built around.
 * The other is any value the reference does not also use: a memset that
 * clears a different amount per iteration runs a different number of
 * iterations, and the two sides of the differential test stop comparing the
 * same execution. This is the reference emulator's value, confirmed by the
 * asm_simd fixture, which reads the register and records what it said.
 */
export const DC_ZVA_BYTES = 512

export const A64 = {
  ILLEGAL: 0,

  // Data processing: immediate and register, integer.
  ADR: 1,
  ADRP: 2,
  ADD: 3,
  SUB: 4,
  AND: 5,
  ORR: 6,
  EOR: 7,
  BIC: 8,
  ORN: 9,
  EON: 10,
  MOVN: 11,
  MOVZ: 12,
  MOVK: 13,
  SBFM: 14,
  BFM: 15,
  UBFM: 16,
  EXTR: 17,
  ADC: 18,
  SBC: 19,
  CCMP: 20,
  CCMN: 21,
  CSEL: 22,
  CSINC: 23,
  CSINV: 24,
  CSNEG: 25,
  RBIT: 26,
  REV16: 27,
  REV32: 28,
  REV: 29,
  CLZ: 30,
  CLS: 31,
  UDIV: 32,
  SDIV: 33,
  LSLV: 34,
  LSRV: 35,
  ASRV: 36,
  RORV: 37,
  MADD: 38,
  MSUB: 39,
  SMADDL: 40,
  SMSUBL: 41,
  SMULH: 42,
  UMADDL: 43,
  UMSUBL: 44,
  UMULH: 45,

  // Branches, exceptions, system.
  B: 46,
  BL: 47,
  B_COND: 48,
  CBZ: 49,
  CBNZ: 50,
  TBZ: 51,
  TBNZ: 52,
  BR: 53,
  BLR: 54,
  RET: 55,
  SVC: 56,
  BRK: 57,
  NOP: 58,
  MRS: 59,
  MSR: 60,
  BARRIER: 61,
  CLREX: 62,

  // Loads and stores.
  LOAD: 63,
  STORE: 64,
  LOAD_PAIR: 65,
  STORE_PAIR: 66,
  LOAD_LITERAL: 67,
  LOAD_EXCLUSIVE: 68,
  STORE_EXCLUSIVE: 69,

  // Scalar floating point.
  FMOV_REG: 70,
  FMOV_IMM: 71,
  FMOV_TO_GP: 72,
  FMOV_FROM_GP: 73,
  FABS: 74,
  FNEG: 75,
  FSQRT: 76,
  FCVT: 77,
  FRINT: 78,
  FADD: 79,
  FSUB: 80,
  FMUL: 81,
  FDIV: 82,
  FMAX: 83,
  FMIN: 84,
  FMAXNM: 85,
  FMINNM: 86,
  FNMUL: 87,
  FMADD: 88,
  FMSUB: 89,
  FNMADD: 90,
  FNMSUB: 91,
  FCMP: 92,
  FCSEL: 93,
  FCCMP: 94,
  FCVT_TO_INT: 95,
  FCVT_FROM_INT: 96,

  /**
   * The sliver of Advanced SIMD that ordinary scalar code reaches: a
   * compiler materialises constants with these, and a libc's string
   * routines splat a search byte across a vector before comparing.
   */
  MOVI: 97,
  DUP_GENERAL: 98,
  ORR_VEC: 99,
  AND_VEC: 100,
  EOR_VEC: 101,
  DUP_ELEMENT: 102,
  INS_GENERAL: 103,
  UMOV: 104,
  ADD_VEC: 105,
  MUL_VEC: 106,
  MUL_ELEMENT: 107,
  SADDL: 108,
  SADDW: 109,
  USHL: 110,
  XTN: 111,
  UZP1: 112,
  ADDV: 113,
  ADDP_SCALAR: 114,
  LD1_LANE: 115,

  /** Zero a cache line. A data-cache maintenance operation, not arithmetic. */
  DC_ZVA: 116,
} as const

export type A64Op = (typeof A64)[keyof typeof A64]

export const A64_NAME: readonly string[] = (() => {
  const names: string[] = []
  for (const [key, value] of Object.entries(A64)) names[value] = key.toLowerCase()
  return names
})()

export const Flow = {
  SEQ: 0,
  BRANCH: 1,
  JUMP: 2,
  CALL: 3,
  RET: 4,
  INDIRECT: 5,
  TRAP: 6,
} as const
export type FlowKind = (typeof Flow)[keyof typeof Flow]

/** How a second operand is transformed before use. */
export const Shift = { LSL: 0, LSR: 1, ASR: 2, ROR: 3, NONE: -1 } as const
/** UXTB UXTH UXTW UXTX SXTB SXTH SXTW SXTX, in encoding order. */
export const Extend = { NONE: -1 } as const
/** Where the writeback lands, for the indexed addressing modes. */
export const Index = { OFFSET: 0, PRE: 1, POST: 2 } as const

/** Rounding a conversion or a frint applies. */
export const Round = {
  NEAREST_EVEN: 0,
  POS_INF: 1,
  NEG_INF: 2,
  ZERO: 3,
  NEAREST_AWAY: 4,
  CURRENT: 5,
  EXACT: 6,
} as const

export interface A64Inst {
  op: A64Op
  /** Destination, or the transferred register for a load or store. */
  rd: number
  rn: number
  rm: number
  /** Third source for the multiply-accumulate and select families. */
  ra: number
  /** Second transferred register, paired loads and stores only. */
  rt2: number
  imm: bigint
  /** True for the 64-bit form, false for the 32-bit one. */
  sf: boolean
  /** Whether the instruction also writes the condition flags. */
  setFlags: boolean
  cond: number
  shiftType: number
  shiftAmount: number
  /** -1 when the second operand is not extended. */
  extendType: number
  /** Bytes moved by a memory access. */
  width: number
  /** Whether a load sign-extends. */
  signed: boolean
  indexMode: number
  /**
   * Bytes of a floating-point operand: 4, 8 or 16. For a vector operation it
   * is the width of the whole register the instruction writes, so `fpSize`
   * divided by `esize` is the lane count.
   */
  fpSize: number
  /** Bytes in one lane of a vector operation. */
  esize: number
  /** Which lane a copy, an insert or a single-lane load names. */
  index: number
  /**
   * Whether a widening operation reads the upper half of its narrow source.
   * This is the difference between saddl and saddl2, which are otherwise the
   * same instruction.
   */
  part: boolean
  /** Whether the transferred register belongs to the vector file. */
  fpTransfer: boolean
  /** Flag value a conditional compare substitutes when its condition fails. */
  nzcv: number
  rounding: number
  /**
   * Fractional bits for a fixed-point conversion. Zero means the plain
   * integer form; anything else scales by a power of two as part of the
   * conversion, which is how a compiler folds a multiply by 0.125 into the
   * instruction that produced the value.
   */
  fbits: number
  /** Which status register an MRS or MSR names. */
  sysreg: string
  len: 4
  raw: number
  flow: FlowKind
}

function make(op: A64Op, raw: number, flow: FlowKind = Flow.SEQ): A64Inst {
  return {
    op,
    rd: -1,
    rn: -1,
    rm: -1,
    ra: -1,
    rt2: -1,
    imm: 0n,
    sf: true,
    setFlags: false,
    cond: 0,
    shiftType: Shift.LSL,
    shiftAmount: 0,
    extendType: Extend.NONE,
    width: 0,
    signed: false,
    indexMode: Index.OFFSET,
    fpSize: 0,
    esize: 0,
    index: 0,
    part: false,
    fpTransfer: false,
    nzcv: 0,
    rounding: Round.CURRENT,
    fbits: 0,
    sysreg: '',
    len: 4,
    raw,
    flow,
  }
}

const bits = (word: number, hi: number, lo: number): number =>
  (word >>> lo) & ((1 << (hi - lo + 1)) - 1)

const bit = (word: number, at: number): number => (word >>> at) & 1

/** Sign-extend a displacement of `n` bits, which arrives as a bigint. */
const sextBig = (value: bigint, n: number): bigint => BigInt.asIntN(n, value)

function rawBytes(word: number): Uint8Array {
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) out[i] = (word >>> (8 * i)) & 0xff
  return out
}

/**
 * The architecture's DecodeBitMasks, which produces *two* masks.
 *
 * The logical immediate instructions use only the first, which is why it is
 * tempting to stop there. The bitfield instructions need both: the wrap mask
 * selects the bits of the rotated source, and the top mask decides where the
 * extracted field ends and sign extension or the old destination begins.
 * Masking by the register width instead of by the top mask gives a logical
 * shift right that keeps the bits that rotated round the end — correct in
 * the low half and wrong above it.
 *
 * Transcribed rather than reconstructed: the element size comes from the
 * position of the highest clear bit in a six-bit field, which is not a thing
 * to guess at.
 */
export interface BitMasks {
  wmask: bigint
  tmask: bigint
}

export function decodeBitMasks(
  n: number,
  imms: number,
  immr: number,
  immediate: boolean,
  sf: boolean,
): BitMasks | null {
  const width = sf ? 64 : 32
  const combined = (n << 6) | (~imms & 0x3f)
  const length = 31 - Math.clz32(combined)
  if (length < 1) return null
  const size = 1 << length
  if (size > width) return null
  const levels = size - 1
  const s = imms & levels
  const r = immr & levels
  if (immediate && s === levels) return null

  const sizeBig = BigInt(size)
  const elementMask = (1n << sizeBig) - 1n
  const replicate = (element: bigint): bigint => {
    let value = 0n
    for (let filled = 0; filled < width; filled += size) value |= element << BigInt(filled)
    return BigInt.asUintN(width, value)
  }

  // wmask: s+1 ones at the bottom of each element, rotated right by r.
  const ones = (1n << BigInt(s + 1)) - 1n
  const rotate = BigInt(r)
  const rotated = rotate === 0n
    ? ones
    : ((ones >> rotate) | (ones << (sizeBig - rotate))) & elementMask

  // tmask: diff+1 ones at the bottom of each element, where diff is the
  // six-bit difference between the field's end and its start.
  const diff = (s - r) & levels
  const top = (1n << BigInt(diff + 1)) - 1n

  return { wmask: replicate(rotated), tmask: replicate(top & elementMask) }
}

/**
 * The eight-bit floating-point immediate, abcdefgh.
 *
 * The exponent is not the three-bit field it looks like. Bit b selects which
 * of two disjoint ranges the remaining two bits index: set, and the exponent
 * is cd - 3, giving -3 to 0; clear, and it is cd + 1, giving 1 to 4. Reading
 * bcd as one number and subtracting a bias swaps the two halves, so `fmov
 * d0, #2.5` quietly becomes 0.15625.
 */
export function decodeFpImmediate(imm8: number): number {
  const sign = (imm8 >> 7) & 1
  const b = (imm8 >> 6) & 1
  const cd = (imm8 >> 4) & 3
  const frac = imm8 & 15
  const exponent = b === 1 ? cd - 3 : cd + 1
  const value = (1 + frac / 16) * 2 ** exponent
  return sign ? -value : value
}

/** The memory instructions, whose base register may be the stack pointer. */
const MEMORY_OPS = new Set<A64Op>([
  A64.LOAD, A64.STORE, A64.LOAD_PAIR, A64.STORE_PAIR,
  A64.LOAD_EXCLUSIVE, A64.STORE_EXCLUSIVE, A64.LD1_LANE,
])

/**
 * Whether register 31 means the stack pointer in each operand position.
 *
 * It is a per-form question, not a per-instruction one. `sub x0, sp, x1` and
 * `sub x0, xzr, x1` are both register 31, and which is meant depends on
 * whether the second operand is a shifted register or an extended one. Read
 * the wrong one and the arithmetic is silently done against a stack address.
 */
function immediateOrExtended(inst: A64Inst): boolean {
  return inst.rm < 0 || inst.extendType >= 0
}

export function rnIsStackPointer(inst: A64Inst): boolean {
  if (inst.op === A64.ADD || inst.op === A64.SUB) return immediateOrExtended(inst)
  return MEMORY_OPS.has(inst.op)
}

export function rdIsStackPointer(inst: A64Inst): boolean {
  if (inst.setFlags) return false
  if (inst.op === A64.ADD || inst.op === A64.SUB) return immediateOrExtended(inst)
  // The logical immediate forms can write the stack pointer; the shifted
  // register forms cannot, and `mov sp, xn` is encoded as an add anyway.
  if (inst.op === A64.AND || inst.op === A64.ORR || inst.op === A64.EOR) return inst.rm < 0
  return false
}

export function decode(word: number, address: bigint): A64Inst {
  const unsupported = (detail: string): never => {
    throw new UnimplementedInstruction(ISA_NAME, address, rawBytes(word), detail)
  }
  const bad = (detail: string): never => {
    throw new IllegalInstruction(ISA_NAME, address, rawBytes(word), detail)
  }

  const op0 = bits(word, 28, 25)
  if ((op0 & 0b1110) === 0b1000) return decodeDataImmediate(word, address, unsupported, bad)
  if ((op0 & 0b1110) === 0b1010) return decodeBranchSystem(word, unsupported)
  if ((op0 & 0b0101) === 0b0100) return decodeLoadStore(word, unsupported, bad)
  if ((op0 & 0b0111) === 0b0101) return decodeDataRegister(word, unsupported, bad)
  if ((op0 & 0b0111) === 0b0111) return decodeFloating(word, address, unsupported, bad)
  return bad(`unallocated encoding group ${op0.toString(2)}`)
}

type Fail = (detail: string) => never

function decodeDataImmediate(word: number, address: bigint, unsupported: Fail, bad: Fail): A64Inst {
  const op0 = bits(word, 25, 23)
  const rd = bits(word, 4, 0)
  const rn = bits(word, 9, 5)
  const sf = bit(word, 31) === 1

  if (op0 <= 1) {
    // PC-relative addressing. ADRP scales by a page and clears the low bits.
    const immlo = bits(word, 30, 29)
    const immhi = bits(word, 23, 5)
    const raw21 = (immhi << 2) | immlo
    const page = bit(word, 31) === 1
    const inst = make(page ? A64.ADRP : A64.ADR, word)
    inst.rd = rd
    inst.imm = page
      ? (sextBig(BigInt(raw21), 21) << 12n) + ((address & ~0xfffn) - address)
      : sextBig(BigInt(raw21), 21)
    return inst
  }

  if (op0 === 2 || op0 === 3) {
    // Add/subtract immediate, optionally shifted left by twelve.
    const shift = bits(word, 23, 22)
    if (shift > 1) return bad('add/sub immediate with reserved shift')
    const inst = make(bit(word, 30) === 1 ? A64.SUB : A64.ADD, word)
    inst.rd = rd
    inst.rn = rn
    inst.sf = sf
    inst.setFlags = bit(word, 29) === 1
    inst.imm = BigInt(bits(word, 21, 10)) << BigInt(shift * 12)
    // Register 31 is the stack pointer here unless the flags are written.
    return inst
  }

  if (op0 === 4) {
    const opc = bits(word, 30, 29)
    const n = bit(word, 22)
    if (!sf && n === 1) return bad('logical immediate with N set in a 32-bit form')
    const masks = decodeBitMasks(n, bits(word, 15, 10), bits(word, 21, 16), true, sf)
    if (masks === null) return bad('logical immediate with a reserved bit pattern')
    const inst = make([A64.AND, A64.ORR, A64.EOR, A64.AND][opc]!, word)
    inst.rd = rd
    inst.rn = rn
    inst.sf = sf
    inst.setFlags = opc === 3
    inst.imm = masks.wmask
    return inst
  }

  if (op0 === 5) {
    const opc = bits(word, 30, 29)
    const hw = bits(word, 22, 21)
    if (!sf && hw > 1) return bad('move wide with a shift beyond the register')
    const op = [A64.MOVN, A64.ILLEGAL, A64.MOVZ, A64.MOVK][opc]!
    if (op === A64.ILLEGAL) return bad('unallocated move wide opcode')
    const inst = make(op, word)
    inst.rd = rd
    inst.sf = sf
    inst.imm = BigInt(bits(word, 20, 5))
    inst.shiftAmount = hw * 16
    return inst
  }

  if (op0 === 6) {
    const opc = bits(word, 30, 29)
    const n = bit(word, 22)
    if (n !== (sf ? 1 : 0)) return bad('bitfield with N not matching the operand size')
    const op = [A64.SBFM, A64.BFM, A64.UBFM][opc]
    if (op === undefined) return bad('unallocated bitfield opcode')
    const inst = make(op, word)
    inst.rd = rd
    inst.rn = rn
    inst.sf = sf
    // immr, imms and N packed into one field, unpacked by the interpreter
    // together with the operand size to rebuild both masks.
    inst.imm = BigInt(bits(word, 21, 16)) |
      (BigInt(bits(word, 15, 10)) << 8n) |
      (BigInt(n) << 16n)
    return inst
  }

  if (op0 === 7) {
    if (bits(word, 30, 29) !== 0 || bit(word, 21) !== 0) return bad('unallocated extract')
    const inst = make(A64.EXTR, word)
    inst.rd = rd
    inst.rn = rn
    inst.rm = bits(word, 20, 16)
    inst.sf = sf
    inst.imm = BigInt(bits(word, 15, 10))
    return inst
  }

  return unsupported(`data-processing immediate group ${op0}`)
}

function decodeBranchSystem(word: number, unsupported: Fail): A64Inst {
  const op0 = bits(word, 31, 29)
  const op1 = bits(word, 25, 22)

  if ((op0 & 0b011) === 0b000 && (word >>> 26) !== 0b000101 && (word >>> 26) !== 0b100101) {
    // Falls through to the more specific tests below.
  }

  // Unconditional branch, immediate.
  if (bits(word, 30, 26) === 0b00101) {
    const link = bit(word, 31) === 1
    const inst = make(link ? A64.BL : A64.B, word, link ? Flow.CALL : Flow.JUMP)
    inst.imm = sextBig(BigInt(bits(word, 25, 0)), 26) << 2n
    return inst
  }

  // Compare and branch.
  if (bits(word, 30, 25) === 0b011010) {
    const inst = make(bit(word, 24) === 1 ? A64.CBNZ : A64.CBZ, word, Flow.BRANCH)
    inst.rd = bits(word, 4, 0)
    inst.sf = bit(word, 31) === 1
    inst.imm = sextBig(BigInt(bits(word, 23, 5)), 19) << 2n
    return inst
  }

  // Test and branch.
  if (bits(word, 30, 25) === 0b011011) {
    const inst = make(bit(word, 24) === 1 ? A64.TBNZ : A64.TBZ, word, Flow.BRANCH)
    inst.rd = bits(word, 4, 0)
    inst.shiftAmount = (bit(word, 31) << 5) | bits(word, 23, 19)
    inst.imm = sextBig(BigInt(bits(word, 18, 5)), 14) << 2n
    return inst
  }

  // Conditional branch.
  if (bits(word, 31, 25) === 0b0101010 && bit(word, 4) === 0) {
    const inst = make(A64.B_COND, word, Flow.BRANCH)
    inst.cond = bits(word, 3, 0)
    inst.imm = sextBig(BigInt(bits(word, 23, 5)), 19) << 2n
    return inst
  }

  // Exception generation.
  if (bits(word, 31, 24) === 0b11010100) {
    const opc = bits(word, 23, 21)
    const ll = bits(word, 4, 0)
    if (opc === 0 && ll === 1) {
      const inst = make(A64.SVC, word, Flow.TRAP)
      inst.imm = BigInt(bits(word, 20, 5))
      return inst
    }
    if (opc === 1 && ll === 0) {
      const inst = make(A64.BRK, word, Flow.TRAP)
      inst.imm = BigInt(bits(word, 20, 5))
      return inst
    }
    return unsupported(`exception-generating instruction, opc ${opc}`)
  }

  // Unconditional branch, register.
  if (bits(word, 31, 25) === 0b1101011) {
    const opc = bits(word, 24, 21)
    const rn = bits(word, 9, 5)
    if (opc === 0) {
      const inst = make(A64.BR, word, Flow.INDIRECT)
      inst.rn = rn
      return inst
    }
    if (opc === 1) {
      const inst = make(A64.BLR, word, Flow.CALL)
      inst.rn = rn
      return inst
    }
    if (opc === 2) {
      const inst = make(A64.RET, word, Flow.RET)
      inst.rn = rn
      return inst
    }
    return unsupported(`branch-to-register opcode ${opc}`)
  }

  // System.
  if (bits(word, 31, 22) === 0b1101010100) {
    const l = bit(word, 21)
    const op0f = bits(word, 20, 19)
    const rt = bits(word, 4, 0)
    if (op0f === 0 && rt === 0b11111) {
      // Which of these an encoding is depends on CRn, not on CRm: CRn of
      // 2 is the hint space, where every unallocated point is a nop by
      // definition, and CRn of 3 is the barriers, where CRm varies the
      // scope rather than the instruction.
      const crn = bits(word, 15, 12)
      const crm = bits(word, 11, 8)
      const op2 = bits(word, 7, 5)
      if (crn === 2) return make(A64.NOP, word)
      if (crn === 3) {
        if (op2 === 2) return make(A64.CLREX, word)
        if (op2 >= 4 && op2 <= 7) return make(A64.BARRIER, word)
        return unsupported(`system instruction crn 3 op2 ${op2}`)
      }
      void crm
      return unsupported(`system instruction crn ${crn}`)
    }
    if (op0f >= 2) {
      const name = systemRegisterName(word)
      if (name === null) {
        return unsupported(`system register o0=${op0f} op1=${bits(word, 18, 16)} ` +
          `CRn=${bits(word, 15, 12)} CRm=${bits(word, 11, 8)} op2=${bits(word, 7, 5)}`)
      }
      const inst = make(l === 1 ? A64.MRS : A64.MSR, word)
      inst.rd = rt
      inst.sysreg = name
      return inst
    }
    // The cache maintenance instructions. Only the one a libc's memset
    // reaches is implemented; the rest still fail loudly.
    if (op0f === 1 && l === 0) {
      const key = `${bits(word, 18, 16)}:${bits(word, 15, 12)}:` +
        `${bits(word, 11, 8)}:${bits(word, 7, 5)}`
      if (key === '3:7:4:1') {
        const inst = make(A64.DC_ZVA, word)
        inst.rn = rt
        inst.width = DC_ZVA_BYTES
        return inst
      }
      return unsupported(`system instruction ${key}`)
    }
    return unsupported('system instruction')
  }

  return unsupported(`branch/system group op0=${op0} op1=${op1}`)
}

/**
 * Only the registers a userspace program can reach and this model keeps.
 * Anything else is named in the failure rather than silently read as zero.
 */
function systemRegisterName(word: number): string | null {
  const o0 = bits(word, 20, 19)
  const op1 = bits(word, 18, 16)
  const crn = bits(word, 15, 12)
  const crm = bits(word, 11, 8)
  const op2 = bits(word, 7, 5)
  const key = `${o0}:${op1}:${crn}:${crm}:${op2}`
  const known: Record<string, string> = {
    '3:3:4:2:0': 'nzcv',
    '3:3:4:4:0': 'fpcr',
    '3:3:4:4:1': 'fpsr',
    '3:3:0:0:7': 'dczid_el0',
    '3:3:13:0:2': 'tpidr_el0',
    '3:3:13:0:3': 'tpidrro_el0',
    '3:3:14:0:1': 'cntvct_el0',
    '3:3:14:0:0': 'cntfrq_el0',
  }
  return known[key] ?? null
}

function decodeDataRegister(word: number, unsupported: Fail, bad: Fail): A64Inst {
  const sf = bit(word, 31) === 1
  const rd = bits(word, 4, 0)
  const rn = bits(word, 9, 5)
  const rm = bits(word, 20, 16)
  const op0 = bit(word, 30)
  const op1 = bit(word, 28)
  const op2 = bits(word, 24, 21)

  if (op1 === 1 && op2 === 0b0110) {
    // Data processing, one and two source.
    if (op0 === 1) {
      // One source.
      const opcode = bits(word, 15, 10)
      const table: Record<number, A64Op> = {
        0: A64.RBIT, 1: A64.REV16, 2: A64.REV32, 3: A64.REV, 4: A64.CLZ, 5: A64.CLS,
      }
      // On the 32-bit form, opcode 2 is REV rather than REV32.
      const op = !sf && opcode === 2 ? A64.REV : table[opcode]
      if (op === undefined) return unsupported(`one-source data processing opcode ${opcode}`)
      const inst = make(op, word)
      inst.rd = rd
      inst.rn = rn
      inst.sf = sf
      return inst
    }
    const opcode = bits(word, 15, 10)
    const table: Record<number, A64Op> = {
      2: A64.UDIV, 3: A64.SDIV, 8: A64.LSLV, 9: A64.LSRV, 10: A64.ASRV, 11: A64.RORV,
    }
    const op = table[opcode]
    if (op === undefined) return unsupported(`two-source data processing opcode ${opcode}`)
    const inst = make(op, word)
    inst.rd = rd
    inst.rn = rn
    inst.rm = rm
    inst.sf = sf
    return inst
  }

  if ((op2 & 0b1000) === 0b1000 && op1 === 1) {
    // Three source.
    const op31 = bits(word, 23, 21)
    const o0 = bit(word, 15)
    const inst = make(A64.MADD, word)
    inst.rd = rd
    inst.rn = rn
    inst.rm = rm
    inst.ra = bits(word, 14, 10)
    inst.sf = sf
    if (op31 === 0) inst.op = o0 === 0 ? A64.MADD : A64.MSUB
    else if (op31 === 1) inst.op = o0 === 0 ? A64.SMADDL : A64.SMSUBL
    else if (op31 === 2) inst.op = A64.SMULH
    else if (op31 === 5) inst.op = o0 === 0 ? A64.UMADDL : A64.UMSUBL
    else if (op31 === 6) inst.op = A64.UMULH
    else return unsupported(`three-source data processing op31 ${op31}`)
    return inst
  }

  if (op1 === 0) {
    // Logical, shifted register.
    if ((op2 & 0b1000) === 0) {
      const opc = bits(word, 30, 29)
      const negate = bit(word, 21) === 1
      const table: [A64Op, A64Op][] = [
        [A64.AND, A64.BIC], [A64.ORR, A64.ORN], [A64.EOR, A64.EON], [A64.AND, A64.BIC],
      ]
      const inst = make(table[opc]![negate ? 1 : 0], word)
      inst.rd = rd
      inst.rn = rn
      inst.rm = rm
      inst.sf = sf
      inst.setFlags = opc === 3
      inst.shiftType = bits(word, 23, 22)
      inst.shiftAmount = bits(word, 15, 10)
      if (!sf && inst.shiftAmount >= 32) return bad('shift beyond a 32-bit register')
      return inst
    }
    // Add/subtract, shifted or extended register.
    const extended = bit(word, 21) === 1
    const inst = make(bit(word, 30) === 1 ? A64.SUB : A64.ADD, word)
    inst.rd = rd
    inst.rn = rn
    inst.rm = rm
    inst.sf = sf
    inst.setFlags = bit(word, 29) === 1
    if (extended) {
      inst.extendType = bits(word, 15, 13)
      inst.shiftAmount = bits(word, 12, 10)
      if (inst.shiftAmount > 4) return bad('extended register with a shift beyond four')
    } else {
      inst.shiftType = bits(word, 23, 22)
      if (inst.shiftType === Shift.ROR) return bad('add/sub with a rotated operand')
      inst.shiftAmount = bits(word, 15, 10)
      if (!sf && inst.shiftAmount >= 32) return bad('shift beyond a 32-bit register')
    }
    return inst
  }

  // op1 === 1 and the remaining groups.
  if (op2 === 0b0000) {
    // Add/subtract with carry.
    const inst = make(bit(word, 30) === 1 ? A64.SBC : A64.ADC, word)
    inst.rd = rd
    inst.rn = rn
    inst.rm = rm
    inst.sf = sf
    inst.setFlags = bit(word, 29) === 1
    return inst
  }

  if (op2 === 0b0010) {
    // Conditional compare, register or immediate.
    const immediate = bit(word, 11) === 1
    const inst = make(bit(word, 30) === 1 ? A64.CCMP : A64.CCMN, word)
    inst.rn = rn
    inst.sf = sf
    inst.setFlags = true
    inst.cond = bits(word, 15, 12)
    inst.nzcv = bits(word, 3, 0)
    if (immediate) inst.imm = BigInt(rm)
    else inst.rm = rm
    return inst
  }

  if (op2 === 0b0100) {
    // Conditional select.
    const op2b = bits(word, 11, 10)
    const negate = bit(word, 30) === 1
    const table: A64Op[] = negate
      ? [A64.CSINV, A64.CSNEG, A64.ILLEGAL, A64.ILLEGAL]
      : [A64.CSEL, A64.CSINC, A64.ILLEGAL, A64.ILLEGAL]
    const op = table[op2b]!
    if (op === A64.ILLEGAL) return bad('unallocated conditional select')
    const inst = make(op, word)
    inst.rd = rd
    inst.rn = rn
    inst.rm = rm
    inst.sf = sf
    inst.cond = bits(word, 15, 12)
    return inst
  }

  return unsupported(`data-processing register group op1=${op1} op2=${op2.toString(2)}`)
}

/** Vector access widths for size = 00, 01, 10, 11. */
const LOAD_STORE_FP_SIZE = [1, 2, 4, 8]

/**
 * LD1 and ST1 of a single lane.
 *
 * The element size is not a field. It is spread across the three-bit opcode,
 * the S bit and the two-bit size field, and those same bits carry what is
 * left of the lane index once the element size has been taken out of them.
 */
function decodeLoadLane(word: number, unsupported: Fail, bad: Fail): A64Inst {
  const q = bit(word, 30)
  const postIndex = bit(word, 23) === 1
  const load = bit(word, 22) === 1
  const replicate = bit(word, 21) === 1
  const opcode = bits(word, 15, 13)
  const selector = bit(word, 12)
  const size = bits(word, 11, 10)

  if (!load) return unsupported('single-lane store')
  if (replicate) return unsupported('load and replicate')
  if (!postIndex && bits(word, 20, 16) !== 0) return bad('single-lane load with a reserved field')

  let esize: number
  let index: number
  if (opcode === 0b000) {
    esize = 1
    index = (q << 3) | (selector << 2) | size
  } else if (opcode === 0b010) {
    if ((size & 1) !== 0) return bad('16-bit single-lane load with an odd size field')
    esize = 2
    index = (q << 2) | (selector << 1) | (size >>> 1)
  } else if (opcode === 0b100 && size === 0b00) {
    esize = 4
    index = (q << 1) | selector
  } else if (opcode === 0b100 && size === 0b01 && selector === 0) {
    esize = 8
    index = q
  } else {
    return unsupported(`single-lane load opcode ${opcode} size ${size} s ${selector}`)
  }

  const inst = make(A64.LD1_LANE, word)
  inst.rd = bits(word, 4, 0)
  inst.rn = bits(word, 9, 5)
  // Register 31 in the offset field is not a register at all: it selects
  // the immediate form, whose step is the element just transferred.
  const offsetRegister = bits(word, 20, 16)
  inst.rm = postIndex && offsetRegister !== 31 ? offsetRegister : -1
  inst.imm = BigInt(esize)
  inst.esize = esize
  inst.width = esize
  inst.index = index
  inst.fpTransfer = true
  inst.indexMode = postIndex ? Index.POST : Index.OFFSET
  return inst
}

function decodeLoadStore(word: number, unsupported: Fail, bad: Fail): A64Inst {
  const op0 = bits(word, 31, 28)

  // Load one lane of a vector register. A compiler reaches for this when it
  // gathers scattered values into a vector, which is common enough in
  // ordinary code that leaving it out blocks whole programs.
  if (bit(word, 31) === 0 && bits(word, 29, 24) === 0b001101) {
    return decodeLoadLane(word, unsupported, bad)
  }

  // Load/store exclusive, which the architecture places at 001000 in bits
  // 29:24 rather than at zero.
  if (bits(word, 29, 24) === 0b001000) {
    const size = bits(word, 31, 30)
    const l = bit(word, 22)
    const o2 = bit(word, 23)
    const o1 = bit(word, 21)
    const o0 = bit(word, 15)
    if (o1 === 1) return unsupported('load/store exclusive pair')
    const width = 1 << size
    if (o2 === 1) {
      // Load-acquire and store-release without a reservation.
      const inst = make(l === 1 ? A64.LOAD : A64.STORE, word)
      inst.rd = bits(word, 4, 0)
      inst.rn = bits(word, 9, 5)
      inst.width = width
      inst.sf = size === 3
      return inst
    }
    const inst = make(l === 1 ? A64.LOAD_EXCLUSIVE : A64.STORE_EXCLUSIVE, word)
    inst.rd = bits(word, 4, 0)
    inst.rn = bits(word, 9, 5)
    inst.rm = bits(word, 20, 16)
    inst.width = width
    inst.sf = size === 3
    // o0 marks the acquire/release variants, which are ordering only here.
    void o0
    return inst
  }

  // Load register, literal.
  if (bits(word, 29, 27) === 0b011 && bit(word, 24) === 0) {
    const opc = bits(word, 31, 30)
    const isFp = bit(word, 26) === 1
    const inst = make(A64.LOAD_LITERAL, word)
    inst.rd = bits(word, 4, 0)
    inst.imm = sextBig(BigInt(bits(word, 23, 5)), 19) << 2n
    inst.fpTransfer = isFp
    if (isFp) {
      inst.width = [4, 8, 16][opc] ?? 0
      if (inst.width === 0) return bad('unallocated literal load size')
      inst.fpSize = inst.width
    } else {
      if (opc === 3) return bad('prefetch literal is not modelled')
      inst.width = opc === 1 ? 8 : 4
      inst.signed = opc === 2
    }
    inst.sf = !isFp && opc === 0 ? false : true
    return inst
  }

  // Load/store pair, in its three index modes.
  if (bits(word, 29, 27) === 0b101) {
    const mode = bits(word, 24, 23)
    if (mode === 0) return unsupported('load/store no-allocate pair')
    const opc = bits(word, 31, 30)
    const isFp = bit(word, 26) === 1
    const l = bit(word, 22)
    const inst = make(l === 1 ? A64.LOAD_PAIR : A64.STORE_PAIR, word)
    inst.rd = bits(word, 4, 0)
    inst.rt2 = bits(word, 14, 10)
    inst.rn = bits(word, 9, 5)
    inst.fpTransfer = isFp
    if (isFp) {
      inst.width = [4, 8, 16][opc] ?? 0
      if (inst.width === 0) return bad('unallocated paired access size')
      inst.fpSize = inst.width
      inst.sf = true
    } else {
      if (opc === 3) return bad('unallocated paired access opcode')
      // 00 is a 32-bit pair, 01 is the sign-extending word pair, 10 is a
      // 64-bit pair.
      inst.width = opc === 2 ? 8 : 4
      inst.signed = opc === 1
      inst.sf = opc !== 0
    }
    inst.imm = sextBig(BigInt(bits(word, 21, 15)), 7) * BigInt(inst.width)
    inst.indexMode = mode === 1 ? Index.POST : mode === 3 ? Index.PRE : Index.OFFSET
    return inst
  }

  // Load/store register, the remaining forms.
  if (bits(word, 29, 27) === 0b111) {
    const size = bits(word, 31, 30)
    const isFp = bit(word, 26) === 1
    const opc = bits(word, 23, 22)
    const unsignedOffset = bit(word, 24) === 1

    let width: number
    let load: boolean
    let signed = false
    if (isFp) {
      // A 128-bit access is encoded as size 00 with the high opc bit set,
      // which is why the size field alone does not give the width.
      width = bit(word, 23) === 1 ? (size === 0 ? 16 : 0) : LOAD_STORE_FP_SIZE[size]!
      load = bit(word, 22) === 1
      if (width === 0) return bad(`unallocated vector access size ${size}`)
    } else {
      width = 1 << size
      load = opc !== 0
      signed = opc >= 2
      if (opc === 3 && size === 2) return bad('unallocated load/store opcode')
      if (size === 3 && opc >= 2) {
        if (opc === 2) return unsupported('prefetch is not modelled')
        return bad('unallocated 64-bit load/store opcode')
      }
    }

    const inst = make(load ? A64.LOAD : A64.STORE, word)
    inst.rd = bits(word, 4, 0)
    inst.rn = bits(word, 9, 5)
    inst.width = width
    inst.signed = signed
    inst.fpTransfer = isFp
    inst.fpSize = isFp ? width : 0
    // A signed load of a narrow value targets a 32-bit register when opc is 3.
    inst.sf = isFp ? true : !(signed && opc === 3)

    if (unsignedOffset) {
      inst.imm = BigInt(bits(word, 21, 10)) * BigInt(width)
      return inst
    }
    const kind = bits(word, 11, 10)
    if (bit(word, 21) === 1) {
      if (kind !== 0b10) return unsupported('load/store with an atomic or unprivileged form')
      inst.rm = bits(word, 20, 16)
      inst.extendType = bits(word, 15, 13)
      // S selects whether the index is scaled by the access size.
      inst.shiftAmount = bit(word, 12) === 1 ? Math.log2(width) : 0
      return inst
    }
    inst.imm = sextBig(BigInt(bits(word, 20, 12)), 9)
    inst.indexMode = kind === 0b01 ? Index.POST : kind === 0b11 ? Index.PRE : Index.OFFSET
    if (kind === 0b10) return unsupported('unprivileged load/store')
    return inst
  }

  return unsupported(`load/store group op0=${op0.toString(2)}`)
}

function decodeFloating(word: number, address: bigint, unsupported: Fail, bad: Fail): A64Inst {
  // Scalar floating point and Advanced SIMD share this encoding space, and
  // the discriminator is narrow. Bit 31 is *not* part of it: in the
  // conversion group it is the integer operand size, so treating it as a
  // SIMD marker rejects every 64-bit conversion. Nor is 11110 the whole of
  // it: the three-source multiply-accumulate group sits at 11111, so
  // matching only 11110 rejects every fmadd.
  const group = bits(word, 28, 24)
  if (bit(word, 30) !== 0 || (group !== 0b11110 && group !== 0b11111)) {
    return decodeSimd(word, unsupported, bad)
  }
  if (bit(word, 29) !== 0) return bad('unallocated scalar floating-point encoding')

  if (group === 0b11111) return decodeFpThreeSource(word, unsupported, bad)

  // Conversion between floating point and fixed point, which differs from
  // the integer form only in bit 21 and a scale field.
  if (bit(word, 21) === 0) return decodeFpFixedPoint(word, address, unsupported, bad)

  const ptype = bits(word, 23, 22)
  const size = ptype === 0 ? 4 : ptype === 1 ? 8 : 0
  const rd = bits(word, 4, 0)
  const rn = bits(word, 9, 5)
  const rm = bits(word, 20, 16)

  // Conversion between floating point and integer: the only floating-point
  // group whose operands span both register files.
  if (bit(word, 21) === 1 && bits(word, 11, 10) === 0 && bits(word, 15, 12) === 0) {
    return decodeFpIntegerConversion(word, address, unsupported, bad)
  }

  // Outside the conversion group, bit 31 must be clear.
  if (bit(word, 31) !== 0) return bad('unallocated scalar floating-point encoding')
  if (size === 0) return unsupported(`floating-point type ${ptype}`)

  if (bit(word, 21) === 1) {
    const op2 = bits(word, 11, 10)
    void unsupported
    if (op2 === 0b10) {
      // Data processing, two source.
      const opcode = bits(word, 15, 12)
      const table: Record<number, A64Op> = {
        0: A64.FMUL, 1: A64.FDIV, 2: A64.FADD, 3: A64.FSUB,
        4: A64.FMAX, 5: A64.FMIN, 6: A64.FMAXNM, 7: A64.FMINNM, 8: A64.FNMUL,
      }
      const op = table[opcode]
      if (op === undefined) return unsupported(`floating-point two-source opcode ${opcode}`)
      const inst = make(op, word)
      inst.rd = rd
      inst.rn = rn
      inst.rm = rm
      inst.fpSize = size
      return inst
    }
    if (op2 === 0b01) {
      // Conditional compare.
      const inst = make(A64.FCCMP, word)
      inst.rn = rn
      inst.rm = rm
      inst.cond = bits(word, 15, 12)
      inst.nzcv = bits(word, 3, 0)
      inst.fpSize = size
      inst.setFlags = true
      return inst
    }
    if (op2 === 0b11) {
      const inst = make(A64.FCSEL, word)
      inst.rd = rd
      inst.rn = rn
      inst.rm = rm
      inst.cond = bits(word, 15, 12)
      inst.fpSize = size
      return inst
    }
    // op2 === 0b00: compare, immediate, or one source.
    const opcode = bits(word, 20, 15)
    void opcode
    if (bits(word, 15, 10) === 0b001000 || bits(word, 15, 10) === 0b011000) {
      // Compare, against a register or against zero.
      const inst = make(A64.FCMP, word)
      inst.rn = rn
      inst.rm = rm
      inst.fpSize = size
      inst.setFlags = true
      // Bit 3 selects the signalling form; bit 4 selects comparison with zero.
      inst.imm = BigInt(bits(word, 4, 0))
      return inst
    }
    if (bits(word, 12, 10) === 0b100) {
      const inst = make(A64.FMOV_IMM, word)
      inst.rd = rd
      inst.fpSize = size
      inst.imm = BigInt(bits(word, 20, 13))
      return inst
    }
    if (bits(word, 14, 10) === 0b10000) {
      // Data processing, one source.
      const opcode1 = bits(word, 20, 15)
      return decodeFpOneSource(word, opcode1, rd, rn, size, unsupported, bad)
    }
    return unsupported(`floating-point group with op2 ${op2}`)
  }

  return unsupported(`unallocated scalar floating-point encoding ${group.toString(2)}`)
}

/**
 * The fused multiply-accumulate group, which the architecture places in its
 * own top-level slot rather than beside the other floating-point arithmetic.
 */
/**
 * Fixed-point conversion: the same four operations as the integer form, with
 * the result scaled by two to the power of the fractional bit count.
 */
function decodeFpFixedPoint(
  word: number,
  address: bigint,
  unsupported: Fail,
  bad: Fail,
): A64Inst {
  const sf = bit(word, 31) === 1
  const ptype = bits(word, 23, 22)
  const size = ptype === 0 ? 4 : ptype === 1 ? 8 : 0
  if (size === 0) {
    throw new UnimplementedInstruction(
      ISA_NAME, address, rawBytes(word), `fixed-point conversion of type ${ptype}`,
    )
  }
  if (bits(word, 20, 19) !== 0) return bad('fixed-point conversion with a rounding mode')
  const opcode = bits(word, 18, 16)
  const scale = bits(word, 15, 10)
  const fbits = 64 - scale
  if (!sf && fbits > 32) return bad('fixed-point conversion wider than its register')

  const inst = make(A64.ILLEGAL, word)
  inst.rd = bits(word, 4, 0)
  inst.rn = bits(word, 9, 5)
  inst.sf = sf
  inst.fpSize = size
  inst.fbits = fbits
  if (opcode === 2 || opcode === 3) {
    inst.op = A64.FCVT_FROM_INT
    inst.signed = opcode === 2
    return inst
  }
  if (opcode === 0 || opcode === 1) {
    inst.op = A64.FCVT_TO_INT
    inst.signed = opcode === 0
    // The fixed-point forms always round towards zero.
    inst.rounding = Round.ZERO
    return inst
  }
  return unsupported(`fixed-point conversion opcode ${opcode}`)
}

function decodeFpThreeSource(word: number, unsupported: Fail, bad: Fail): A64Inst {
  if (bit(word, 31) !== 0) return bad('unallocated fused multiply-accumulate')
  const ptype = bits(word, 23, 22)
  const size = ptype === 0 ? 4 : ptype === 1 ? 8 : 0
  if (size === 0) return unsupported(`fused multiply-accumulate of type ${ptype}`)
  const o1 = bit(word, 21)
  const o0 = bit(word, 15)
  const table: A64Op[][] = [[A64.FMADD, A64.FMSUB], [A64.FNMADD, A64.FNMSUB]]
  const inst = make(table[o1]![o0]!, word)
  inst.rd = bits(word, 4, 0)
  inst.rn = bits(word, 9, 5)
  inst.rm = bits(word, 20, 16)
  inst.ra = bits(word, 14, 10)
  inst.fpSize = size
  return inst
}

/**
 * The sliver of Advanced SIMD that ordinary scalar code reaches.
 *
 * A compiler materialises a zero double with `movi d0, #0` rather than a
 * floating-point move, so refusing all of SIMD refuses perfectly ordinary
 * arithmetic. Everything past that narrow case is still refused by name:
 * this is a scalar interpreter and pretending otherwise would be the silent
 * wrong answer the whole design is built to avoid.
 */
/**
 * The lane size a five-bit copy selector names, and the lane it names.
 *
 * imm5 does not hold a size field. The position of its lowest set bit gives
 * the element size and the bits above it give the index, so the two are read
 * out together or not at all.
 */
function copySelector(imm5: number): { esize: number; index: number } | null {
  const lowest = imm5 & -imm5
  if (lowest !== 1 && lowest !== 2 && lowest !== 4 && lowest !== 8) return null
  const shift = Math.log2(lowest) + 1
  return { esize: lowest, index: imm5 >>> shift }
}

function decodeSimd(word: number, unsupported: Fail, bad: Fail): A64Inst {
  const q = bit(word, 30)
  const op = bit(word, 29)
  const wide = q === 1 ? 16 : 8

  // Modified immediate: 0 Q op 0111100000 abc cmode o1 defgh Rd. Q is not
  // part of the pattern -- it selects 64 or 128 bits of destination.
  if (bit(word, 31) === 0 && bits(word, 28, 19) === 0b0111100000 &&
      bits(word, 11, 10) === 0b01) {
    const cmode = bits(word, 15, 12)
    // Odd cmode below 12 is ORR or BIC by immediate, which merge into the
    // destination rather than replace it. Nothing measured uses them, so
    // they are refused instead of being run as the move they resemble.
    if ((cmode & 1) === 1 && cmode < 12) {
      return unsupported(`advanced SIMD ${op === 1 ? 'bic' : 'orr'} (vector, immediate)`)
    }
    const imm8 = (bits(word, 18, 16) << 5) | bits(word, 9, 5)
    const expanded = expandSimdImmediate(imm8, cmode, op)
    if (expanded === null) {
      return unsupported(`advanced SIMD modified immediate, cmode ${cmode} op ${op}`)
    }
    const inst = make(A64.MOVI, word)
    inst.rd = bits(word, 4, 0)
    inst.fpSize = wide
    inst.esize = wide
    inst.imm = q === 1 ? (expanded << 64n) | expanded : expanded
    return inst
  }

  // The copy group, vector and scalar. Both shapes put the selector in the
  // same place; the scalar one writes a single lane rather than a whole
  // register, which is why it is the one that reaches `mov d1, v0.d[1]`.
  const vectorCopy = bit(word, 31) === 0 && bits(word, 28, 21) === 0b01110000
  const scalarCopy = bits(word, 31, 29) === 0b010 && bits(word, 28, 21) === 0b11110000
  if ((vectorCopy || scalarCopy) && bit(word, 15) === 0 && bit(word, 10) === 1) {
    return decodeSimdCopy(word, scalarCopy, unsupported, bad)
  }

  // Three registers of the same shape: 0 Q U 01110 size 1 Rm opcode 1 Rn Rd.
  if (bit(word, 31) === 0 && bits(word, 28, 24) === 0b01110 &&
      bit(word, 21) === 1 && bit(word, 10) === 1) {
    return decodeSimdThreeSame(word, unsupported)
  }

  // Three registers, the second pair narrower than the first: the widening
  // adds, which is how a compiler sums 32-bit values into 64-bit ones.
  if (bit(word, 31) === 0 && bits(word, 28, 24) === 0b01110 &&
      bit(word, 21) === 1 && bits(word, 11, 10) === 0b00) {
    return decodeSimdThreeDifferent(word, unsupported)
  }

  // Two registers, miscellaneous, and the across-lanes reductions. They
  // share bits 11:10 and differ in bits 21:17.
  if (bit(word, 31) === 0 && bits(word, 28, 24) === 0b01110 &&
      bits(word, 21, 17) === 0b10000 && bits(word, 11, 10) === 0b10) {
    return decodeSimdTwoRegister(word, unsupported)
  }
  // The scalar reduction sits at 11110 rather than 01110, in the encoding
  // space it shares with scalar floating point.
  const reduceScalar = bits(word, 31, 30) === 0b01 && bits(word, 28, 24) === 0b11110
  const reduceVector = bit(word, 31) === 0 && bits(word, 28, 24) === 0b01110
  if ((reduceScalar || reduceVector) && bits(word, 21, 17) === 0b11000 &&
      bits(word, 11, 10) === 0b10) {
    return decodeSimdReduce(word, reduceScalar, unsupported, bad)
  }

  // Permute: 0 Q 0 01110 size 0 Rm 0 opcode 10 Rn Rd.
  if (bit(word, 31) === 0 && op === 0 && bits(word, 28, 24) === 0b01110 &&
      bit(word, 21) === 0 && bit(word, 15) === 0 && bits(word, 11, 10) === 0b10) {
    const opcode = bits(word, 14, 12)
    if (opcode !== 0b001) return unsupported(`advanced SIMD permute opcode ${opcode}`)
    const inst = make(A64.UZP1, word)
    inst.rd = bits(word, 4, 0)
    inst.rn = bits(word, 9, 5)
    inst.rm = bits(word, 20, 16)
    inst.esize = 1 << bits(word, 23, 22)
    inst.fpSize = wide
    return inst
  }

  // By element: 0 Q U 01111 size L M Rm opcode H 0 Rn Rd.
  if (bit(word, 31) === 0 && bits(word, 28, 24) === 0b01111 && bit(word, 10) === 0) {
    return decodeSimdByElement(word, unsupported)
  }

  return unsupported('advanced SIMD is not implemented')
}

function decodeSimdCopy(
  word: number,
  scalar: boolean,
  unsupported: Fail,
  bad: Fail,
): A64Inst {
  const q = bit(word, 30)
  const op = bit(word, 29)
  const imm4 = bits(word, 14, 11)
  const imm5 = bits(word, 20, 16)
  const rd = bits(word, 4, 0)
  const rn = bits(word, 9, 5)

  if (op === 1) return unsupported('advanced SIMD insert from an element')

  const selected = copySelector(imm5)
  if (selected === null) return bad(`vector copy with reserved imm5 ${imm5}`)
  const { esize, index } = selected

  // dup from a general register: the one case whose selector gives only a
  // size, since there is no lane to take the value from.
  if (imm4 === 0b0001 && !scalar) {
    if (esize === 8 && q === 0) return bad('dup of a 64-bit element into 64 bits')
    const inst = make(A64.DUP_GENERAL, word)
    inst.rd = rd
    inst.rn = rn
    inst.esize = esize
    inst.fpSize = q === 1 ? 16 : 8
    return inst
  }

  if (imm4 === 0b0000) {
    // dup from an element. The scalar form writes one lane and zeroes the
    // rest of the register, which the lane count of one expresses.
    if (!scalar && esize === 8 && q === 0) return bad('dup of a 64-bit element into 64 bits')
    const inst = make(A64.DUP_ELEMENT, word)
    inst.rd = rd
    inst.rn = rn
    inst.esize = esize
    inst.fpSize = scalar ? esize : (q === 1 ? 16 : 8)
    inst.index = index
    return inst
  }

  if (imm4 === 0b0011) {
    if (scalar || q === 0) return bad('insert into the upper half of a 64-bit vector')
    const inst = make(A64.INS_GENERAL, word)
    inst.rd = rd
    inst.rn = rn
    inst.esize = esize
    inst.fpSize = 16
    inst.index = index
    return inst
  }

  if (imm4 === 0b0111) {
    // umov. The destination is a general register, so the 64-bit form needs
    // a 64-bit element and the 32-bit form needs a narrower one.
    if (scalar) return bad('umov has no scalar form')
    if (q === 1 && esize !== 8) return bad('64-bit umov of a narrower element')
    if (q === 0 && esize === 8) return bad('32-bit umov of a 64-bit element')
    const inst = make(A64.UMOV, word)
    inst.rd = rd
    inst.rn = rn
    inst.esize = esize
    inst.fpSize = 16
    inst.index = index
    inst.sf = q === 1
    return inst
  }

  return unsupported(`advanced SIMD copy imm4 ${imm4}`)
}

function decodeSimdThreeSame(word: number, unsupported: Fail): A64Inst {
  const q = bit(word, 30)
  const u = bit(word, 29)
  const size = bits(word, 23, 22)
  const opcode = bits(word, 15, 11)

  let inst: A64Inst | null = null
  if (opcode === 0b00011) {
    // The logical operations have no element structure: the size field
    // selects which of them is meant rather than how wide a lane is.
    if (u === 0 && size === 0b00) inst = make(A64.AND_VEC, word)
    else if (u === 0 && size === 0b10) inst = make(A64.ORR_VEC, word)
    else if (u === 1 && size === 0b00) inst = make(A64.EOR_VEC, word)
  } else if (opcode === 0b10000 && u === 0) inst = make(A64.ADD_VEC, word)
  else if (opcode === 0b10011 && u === 0) inst = make(A64.MUL_VEC, word)
  else if (opcode === 0b01000 && u === 1) inst = make(A64.USHL, word)

  if (inst === null) {
    return unsupported(`advanced SIMD three-same opcode ${opcode} u ${u} size ${size}`)
  }

  inst.rd = bits(word, 4, 0)
  inst.rn = bits(word, 9, 5)
  inst.rm = bits(word, 20, 16)
  inst.fpSize = q === 1 ? 16 : 8
  inst.esize = opcode === 0b00011 ? inst.fpSize : 1 << size
  // mul has no 64-bit element form, and no arithmetic form leaves a single
  // lane in a 64-bit vector.
  if (opcode === 0b10011 && size === 0b11) return unsupported('mul of 64-bit elements')
  if (inst.esize === 8 && q === 0 && opcode !== 0b00011) {
    return unsupported('a 64-bit element in a 64-bit vector leaves one lane')
  }
  return inst
}

function decodeSimdThreeDifferent(word: number, unsupported: Fail): A64Inst {
  const u = bit(word, 29)
  const size = bits(word, 23, 22)
  const opcode = bits(word, 15, 12)
  if (u !== 0 || (opcode !== 0b0000 && opcode !== 0b0001)) {
    return unsupported(`advanced SIMD three-different opcode ${opcode} u ${u}`)
  }
  if (size === 0b11) return unsupported('advanced SIMD widening from 64-bit elements')

  const inst = make(opcode === 0b0000 ? A64.SADDL : A64.SADDW, word)
  inst.rd = bits(word, 4, 0)
  inst.rn = bits(word, 9, 5)
  inst.rm = bits(word, 20, 16)
  // The destination element is twice the source element, and the
  // destination is always the full 128 bits.
  inst.esize = 2 << size
  inst.fpSize = 16
  inst.signed = true
  inst.part = bit(word, 30) === 1
  return inst
}

function decodeSimdTwoRegister(word: number, unsupported: Fail): A64Inst {
  const u = bit(word, 29)
  const opcode = bits(word, 16, 12)
  if (u !== 0 || opcode !== 0b10010) {
    return unsupported(`advanced SIMD two-register opcode ${opcode} u ${u}`)
  }
  const size = bits(word, 23, 22)
  if (size === 0b11) return unsupported('xtn from 128-bit elements')
  const inst = make(A64.XTN, word)
  inst.rd = bits(word, 4, 0)
  inst.rn = bits(word, 9, 5)
  // The narrowed result is 64 bits wide; Q selects which half it lands in.
  inst.esize = 1 << size
  inst.fpSize = 8
  inst.part = bit(word, 30) === 1
  return inst
}

function decodeSimdReduce(
  word: number,
  scalar: boolean,
  unsupported: Fail,
  bad: Fail,
): A64Inst {
  const u = bit(word, 29)
  const opcode = bits(word, 16, 12)
  const size = bits(word, 23, 22)
  if (u !== 0 || opcode !== 0b11011) {
    return unsupported(`advanced SIMD reduction opcode ${opcode} u ${u}`)
  }
  const inst = make(scalar ? A64.ADDP_SCALAR : A64.ADDV, word)
  inst.rd = bits(word, 4, 0)
  inst.rn = bits(word, 9, 5)
  if (scalar) {
    // addp of a pair. Only the 64-bit element form exists.
    if (size !== 0b11) return bad(`scalar addp with size ${size}`)
    inst.esize = 8
    inst.fpSize = 16
    return inst
  }
  const q = bit(word, 30)
  if (size === 0b11 || (size === 0b10 && q === 0)) return bad(`addv with size ${size} q ${q}`)
  inst.esize = 1 << size
  inst.fpSize = q === 1 ? 16 : 8
  return inst
}

function decodeSimdByElement(word: number, unsupported: Fail): A64Inst {
  const u = bit(word, 29)
  const opcode = bits(word, 15, 12)
  if (u !== 0 || opcode !== 0b1000) {
    return unsupported(`advanced SIMD by-element opcode ${opcode} u ${u}`)
  }
  const size = bits(word, 23, 22)
  const l = bit(word, 21)
  const m = bit(word, 20)
  const h = bit(word, 11)
  // The element selector is spread over three bits in three places, and how
  // it divides between the index and the register number depends on the
  // element size: a 16-bit element can only come from the first sixteen
  // registers, because its index needs the bit that would name the rest.
  let rm: number
  let index: number
  if (size === 0b01) {
    rm = bits(word, 19, 16)
    index = (h << 2) | (l << 1) | m
  } else if (size === 0b10) {
    rm = (m << 4) | bits(word, 19, 16)
    index = (h << 1) | l
  } else {
    return unsupported(`advanced SIMD by-element size ${size}`)
  }
  const inst = make(A64.MUL_ELEMENT, word)
  inst.rd = bits(word, 4, 0)
  inst.rn = bits(word, 9, 5)
  inst.rm = rm
  inst.esize = 1 << size
  inst.fpSize = bit(word, 30) === 1 ? 16 : 8
  inst.index = index
  return inst
}

/**
 * AdvSIMDExpandImm: turns the eight-bit immediate and the four-bit control
 * field into the 64-bit pattern a lane is filled with.
 *
 * The control field is not a shift amount. Its top three bits choose among
 * element sizes and shift positions, its bottom bit sometimes selects a
 * variant that shifts *ones* in rather than zeroes, and the all-ones case
 * means something different again. Returns null for the forms this
 * interpreter does not implement, so they are refused rather than guessed.
 */
export function expandSimdImmediate(imm8: number, cmode: number, op: number): bigint | null {
  const value = BigInt(imm8)
  const replicate = (element: bigint, bytes: number): bigint => {
    let out = 0n
    for (let at = 0; at < 8; at += bytes) out |= element << BigInt(at * 8)
    return out
  }
  let imm64: bigint
  switch (cmode >> 1) {
    case 0b000: imm64 = replicate(value, 4); break
    case 0b001: imm64 = replicate(value << 8n, 4); break
    case 0b010: imm64 = replicate(value << 16n, 4); break
    case 0b011: imm64 = replicate(value << 24n, 4); break
    case 0b100: imm64 = replicate(value, 2); break
    case 0b101: imm64 = replicate(value << 8n, 2); break
    case 0b110:
      // Shifting ones in rather than zeroes.
      imm64 = (cmode & 1) === 0
        ? replicate((value << 8n) | 0xffn, 4)
        : replicate((value << 16n) | 0xffffn, 4)
      break
    default: {
      if ((cmode & 1) === 0 && op === 0) {
        imm64 = replicate(value, 1)
      } else if ((cmode & 1) === 0 && op === 1) {
        // Each bit of the immediate selects a whole byte of the element.
        let bytes = 0n
        for (let i = 0; i < 8; i++) if ((imm8 >> i) & 1) bytes |= 0xffn << BigInt(i * 8)
        return bytes
      } else {
        // The floating-point immediate forms.
        return null
      }
      break
    }
  }
  return op === 1 ? BigInt.asUintN(64, ~imm64) : imm64
}

function decodeFpOneSource(
  word: number,
  opcode: number,
  rd: number,
  rn: number,
  size: number,
  unsupported: Fail,
  bad: Fail,
): A64Inst {
  const simple: Record<number, A64Op> = {
    0: A64.FMOV_REG, 1: A64.FABS, 2: A64.FNEG, 3: A64.FSQRT,
  }
  if (simple[opcode] !== undefined) {
    const inst = make(simple[opcode]!, word)
    inst.rd = rd
    inst.rn = rn
    inst.fpSize = size
    return inst
  }
  if (opcode >= 4 && opcode <= 7) {
    // Convert between floating-point sizes; the low two bits name the target,
    // and two of the four are half precision, which is not modelled.
    const targets: readonly number[] = [4, 8, 0, 2]
    const target = targets[opcode - 4]!
    if (target !== 4 && target !== 8) return unsupported('half-precision conversion')
    const inst = make(A64.FCVT, word)
    inst.rd = rd
    inst.rn = rn
    inst.fpSize = size
    inst.width = target
    return inst
  }
  const rounds: Record<number, number> = {
    8: Round.NEAREST_EVEN,
    9: Round.POS_INF,
    10: Round.NEG_INF,
    11: Round.ZERO,
    12: Round.NEAREST_AWAY,
    14: Round.EXACT,
    15: Round.CURRENT,
  }
  if (rounds[opcode] !== undefined) {
    const inst = make(A64.FRINT, word)
    inst.rd = rd
    inst.rn = rn
    inst.fpSize = size
    inst.rounding = rounds[opcode]!
    return inst
  }
  return bad(`unallocated floating-point one-source opcode ${opcode}`)
}

function decodeFpIntegerConversion(
  word: number,
  address: bigint,
  unsupported: Fail,
  bad: Fail,
): A64Inst {
  const sf = bit(word, 31) === 1
  const ptype = bits(word, 23, 22)
  const size = ptype === 0 ? 4 : ptype === 1 ? 8 : 0
  if (size === 0) {
    throw new UnimplementedInstruction(
      ISA_NAME, address, rawBytes(word), `floating-point type ${ptype} conversion`,
    )
  }
  const rmode = bits(word, 20, 19)
  const opcode = bits(word, 18, 16)
  const rd = bits(word, 4, 0)
  const rn = bits(word, 9, 5)

  // Moves between a general register and a scalar floating-point register.
  if (rmode === 0 && (opcode === 6 || opcode === 7)) {
    const inst = make(opcode === 6 ? A64.FMOV_TO_GP : A64.FMOV_FROM_GP, word)
    inst.rd = rd
    inst.rn = rn
    inst.sf = sf
    inst.fpSize = size
    return inst
  }

  if (opcode === 2 || opcode === 3) {
    // Integer to floating point.
    const inst = make(A64.FCVT_FROM_INT, word)
    inst.rd = rd
    inst.rn = rn
    inst.sf = sf
    inst.fpSize = size
    inst.signed = opcode === 2
    if (rmode !== 0) return bad('integer-to-float conversion with a rounding mode field')
    return inst
  }

  if (opcode === 0 || opcode === 1 || opcode === 4 || opcode === 5) {
    const inst = make(A64.FCVT_TO_INT, word)
    inst.rd = rd
    inst.rn = rn
    inst.sf = sf
    inst.fpSize = size
    inst.signed = opcode === 0 || opcode === 4
    // rmode selects the rounding, except opcode 4/5 which round to nearest
    // with ties away from zero regardless.
    inst.rounding = opcode >= 4
      ? Round.NEAREST_AWAY
      : [Round.NEAREST_EVEN, Round.POS_INF, Round.NEG_INF, Round.ZERO][rmode]!
    return inst
  }

  return unsupported(`floating-point conversion opcode ${opcode} rmode ${rmode}`)
}
