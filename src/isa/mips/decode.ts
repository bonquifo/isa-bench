/**
 * MIPS32 decoder.
 *
 * The encodings are the easiest of any target here: fixed 32 bits, three
 * formats, and a register field always in the same place. What is not easy
 * is everything downstream of the *delay slot*.
 *
 * On this architecture a branch does not take effect immediately. The
 * instruction after it -- the one in the delay slot -- executes first, and
 * only then does control move. A load has a similar shape on the original
 * MIPS I, though MIPS32 interlocks that one. This is the one place where
 * "what does the next instruction do" is not answered by "look at the next
 * address", and it reaches into the decoder, the interpreter and the
 * timing model.
 *
 * The decoder's part is small and worth stating: it marks which
 * instructions have a delay slot, and whether that slot is *annulled* when
 * the branch is not taken, which the "likely" forms do and the ordinary
 * ones do not. Everything else about delay slots is the interpreter's
 * problem, because it is about order rather than encoding.
 *
 * Scope is what the corpus and a real libc execute, measured rather than
 * guessed, and everything outside it raises rather than falling through.
 */
import { IllegalInstruction, UnimplementedInstruction } from '../common/errors.ts'

export const ISA_NAME = 'mips'

export const MIPS = {
  ILLEGAL: 0,

  // Arithmetic and logic. MIPS distinguishes the trapping forms from the
  // wrapping ones by name; a compiler emits only the wrapping ones.
  ADDU: 1,
  SUBU: 2,
  AND: 3,
  OR: 4,
  XOR: 5,
  NOR: 6,
  SLT: 7,
  SLTU: 8,

  // The same, with an immediate.
  ADDIU: 9,
  ANDI: 10,
  ORI: 11,
  XORI: 12,
  SLTI: 13,
  SLTIU: 14,
  LUI: 15,

  // Shifts, by a constant and by a register.
  SLL: 16,
  SRL: 17,
  SRA: 18,
  SLLV: 19,
  SRLV: 20,
  SRAV: 21,
  ROTR: 22,

  /** Multiply and divide, which write the HI and LO registers. */
  MULT: 23,
  MULTU: 24,
  DIV: 25,
  DIVU: 26,
  MFHI: 27,
  MFLO: 28,
  MTHI: 29,
  MTLO: 30,
  /** The three-operand multiply that writes a general register instead. */
  MUL: 31,
  MADD: 32,
  MSUB: 33,

  // Memory. The unaligned pair is here because a compiler uses it for
  // anything it cannot prove aligned, which on this architecture is a
  // fault rather than a slow path.
  LB: 34,
  LBU: 35,
  LH: 36,
  LHU: 37,
  LW: 38,
  LWL: 39,
  LWR: 40,
  SB: 41,
  SH: 42,
  SW: 43,
  SWL: 44,
  SWR: 45,
  LL: 46,
  SC: 47,

  // Control. Every one of these has a delay slot.
  J: 48,
  JAL: 49,
  JR: 50,
  JALR: 51,
  BEQ: 52,
  BNE: 53,
  BLEZ: 54,
  BGTZ: 55,
  BLTZ: 56,
  BGEZ: 57,
  BLTZAL: 58,
  BGEZAL: 59,

  SYSCALL: 60,
  BREAK: 61,
  SYNC: 62,

  // Bit manipulation, which MIPS32r2 added and a compiler uses freely.
  CLZ: 63,
  CLO: 64,
  SEB: 65,
  SEH: 66,
  EXT: 67,
  INS: 68,
  WSBH: 69,
  MOVN: 70,
  MOVZ: 71,

  /** Reads the thread pointer, which is a coprocessor register here. */
  RDHWR: 72,

  /**
   * The floating-point coprocessor.
   *
   * It is a coprocessor rather than part of the core: its own register
   * file, its own control register, its own condition bits, and no
   * instruction that takes one of its registers and one of the core's as
   * operands. Values cross between them only through the move
   * instructions, and a comparison's result crosses only through a
   * condition bit that a branch reads later.
   */
  FP_LOAD: 73,
  FP_STORE: 74,
  MFC1: 75,
  MTC1: 76,
  MFHC1: 77,
  MTHC1: 78,
  CFC1: 79,
  CTC1: 80,
  FP_ADD: 81,
  FP_SUB: 82,
  FP_MUL: 83,
  FP_DIV: 84,
  FP_SQRT: 85,
  FP_ABS: 86,
  FP_NEG: 87,
  FP_MOV: 88,
  /** Converts between the floating formats and to and from an integer. */
  FP_CVT: 89,
  /** Rounds to an integer in a named direction rather than the current one. */
  FP_ROUND: 90,
  FP_CMP: 91,
  BC1: 92,
  FP_MOVCF: 93,
  FP_MOVZ: 94,
  FP_MOVN: 95,
  /**
   * Multiply-add, which lives in an escape of its own because it needs a
   * fourth register field and the ordinary format has nowhere to put one.
   */
  FP_MADD: 96,

  /**
   * Moving a general register conditionally on a *floating-point*
   * condition bit. It sits in the integer opcode space and reads
   * coprocessor state, which is the one place the two files meet outside
   * the explicit moves.
   */
  MOVCI: 97,
  /** Trap if a condition holds. A compiler emits these as guards. */
  TRAP: 98,
} as const

export type MipsOp = (typeof MIPS)[keyof typeof MIPS]

export const MIPS_NAME: readonly string[] = (() => {
  const names: string[] = []
  for (const [key, value] of Object.entries(MIPS)) names[value] = key.toLowerCase()
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

export interface MipsInst {
  op: MipsOp
  /** Destination register, or -1. */
  rd: number
  rs: number
  rt: number
  /** Shift amount, or the field position for a bitfield operation. */
  sa: number
  /** Field width for a bitfield operation. */
  size: number
  imm: bigint
  /** Bytes moved by a memory access. */
  width: number
  signed: boolean
  /** Floating-point operand format: 4 for single, 8 for double, 0 for none. */
  fmt: number
  /** The format a conversion produces, in the same units. */
  toFmt: number
  /** Which of the eight condition bits a compare writes or a branch reads. */
  cc: number
  /** The predicate a compare applies, or the direction a rounding takes. */
  predicate: number
  /**
   * Whether the instruction is followed by a delay slot that executes
   * before control moves.
   */
  delayed: boolean
  /** Absolute target of a direct branch or jump. */
  target: bigint
  flow: FlowKind
  raw: number
}

function make(op: MipsOp, raw: number, flow: FlowKind = Flow.SEQ): MipsInst {
  return {
    op,
    rd: -1,
    rs: -1,
    rt: -1,
    sa: 0,
    size: 0,
    imm: 0n,
    width: 0,
    signed: false,
    fmt: 0,
    toFmt: 0,
    cc: 0,
    predicate: 0,
    delayed: flow !== Flow.SEQ && flow !== Flow.TRAP,
    target: 0n,
    flow,
    raw,
  }
}

const bits = (word: number, hi: number, lo: number): number =>
  (word >>> lo) & ((1 << (hi - lo + 1)) - 1)

function rawBytes(word: number): Uint8Array {
  return Uint8Array.from([word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24])
}

type Fail = (detail: string) => never

/** The eight loads and stores, by their shared three-bit size field. */
const MEMORY: Record<number, { op: MipsOp; width: number; signed: boolean }> = {
  0x20: { op: MIPS.LB, width: 1, signed: true },
  0x21: { op: MIPS.LH, width: 2, signed: true },
  0x22: { op: MIPS.LWL, width: 4, signed: false },
  0x23: { op: MIPS.LW, width: 4, signed: true },
  0x24: { op: MIPS.LBU, width: 1, signed: false },
  0x25: { op: MIPS.LHU, width: 2, signed: false },
  0x26: { op: MIPS.LWR, width: 4, signed: false },
  0x28: { op: MIPS.SB, width: 1, signed: false },
  0x29: { op: MIPS.SH, width: 2, signed: false },
  0x2a: { op: MIPS.SWL, width: 4, signed: false },
  0x2b: { op: MIPS.SW, width: 4, signed: false },
  0x2e: { op: MIPS.SWR, width: 4, signed: false },
  0x30: { op: MIPS.LL, width: 4, signed: true },
  0x38: { op: MIPS.SC, width: 4, signed: false },
}

export function decode(word: number, address: bigint): MipsInst {
  const unsupported = (detail: string): never => {
    throw new UnimplementedInstruction(ISA_NAME, address, rawBytes(word), detail)
  }
  const bad = (detail: string): never => {
    throw new IllegalInstruction(ISA_NAME, address, rawBytes(word), detail)
  }

  const opcode = bits(word, 31, 26)
  const rs = bits(word, 25, 21)
  const rt = bits(word, 20, 16)
  const rd = bits(word, 15, 11)
  const sa = bits(word, 10, 6)
  const funct = bits(word, 5, 0)
  const immediate = BigInt.asIntN(16, BigInt(word & 0xffff))

  if (opcode === 0) return decodeSpecial(word, address, rs, rt, rd, sa, funct, unsupported, bad)
  if (opcode === 0x1c) return decodeSpecial2(word, rs, rt, rd, sa, funct, unsupported)
  if (opcode === 0x1f) return decodeSpecial3(word, rs, rt, rd, sa, funct, unsupported)

  // The branch group whose condition is in the rt field rather than the
  // opcode, which is the only place a register position means something
  // other than a register.
  if (opcode === 1) {
    const table: Record<number, MipsOp> = {
      0: MIPS.BLTZ, 1: MIPS.BGEZ, 16: MIPS.BLTZAL, 17: MIPS.BGEZAL,
    }
    const op = table[rt]
    if (op === undefined) return unsupported(`regimm branch ${rt}`)
    const inst = make(op, word, Flow.BRANCH)
    inst.rs = rs
    inst.imm = immediate << 2n
    inst.target = address + 4n + (immediate << 2n)
    if (op === MIPS.BLTZAL || op === MIPS.BGEZAL) {
      inst.rd = 31
      inst.flow = Flow.CALL
    }
    return inst
  }

  if (opcode === 2 || opcode === 3) {
    // The jump target is formed from the *next* instruction's address,
    // not this one's, because the delay slot has already moved on.
    const inst = make(opcode === 2 ? MIPS.J : MIPS.JAL, word,
      opcode === 2 ? Flow.JUMP : Flow.CALL)
    const region = (address + 4n) & ~0x0fffffffn
    inst.target = region | (BigInt(word & 0x03ffffff) << 2n)
    if (opcode === 3) inst.rd = 31
    return inst
  }

  if (opcode >= 4 && opcode <= 7) {
    const table: Record<number, MipsOp> = {
      4: MIPS.BEQ, 5: MIPS.BNE, 6: MIPS.BLEZ, 7: MIPS.BGTZ,
    }
    const inst = make(table[opcode]!, word, Flow.BRANCH)
    inst.rs = rs
    if (opcode === 4 || opcode === 5) inst.rt = rt
    inst.imm = immediate << 2n
    inst.target = address + 4n + (immediate << 2n)
    return inst
  }

  switch (opcode) {
    // addi traps on overflow and addiu does not, but a compiler emits only
    // addiu, so the trapping one is refused rather than quietly aliased.
    case 8: return unsupported('addi, which traps on overflow')
    case 9: {
      const inst = make(MIPS.ADDIU, word)
      inst.rt = rt
      inst.rs = rs
      inst.imm = immediate
      return inst
    }
    case 0x0a:
    case 0x0b: {
      const inst = make(opcode === 0x0a ? MIPS.SLTI : MIPS.SLTIU, word)
      inst.rt = rt
      inst.rs = rs
      inst.imm = immediate
      return inst
    }
    case 0x0c:
    case 0x0d:
    case 0x0e: {
      // The logical immediates are zero-extended, unlike every other one.
      const table: Record<number, MipsOp> = { 0x0c: MIPS.ANDI, 0x0d: MIPS.ORI, 0x0e: MIPS.XORI }
      const inst = make(table[opcode]!, word)
      inst.rt = rt
      inst.rs = rs
      inst.imm = BigInt(word & 0xffff)
      return inst
    }
    case 0x0f: {
      const inst = make(MIPS.LUI, word)
      inst.rt = rt
      inst.imm = BigInt((word & 0xffff) << 16) & 0xffffffffn
      return inst
    }
    default:
      break
  }

  const memory = MEMORY[opcode]
  if (memory !== undefined) {
    const inst = make(memory.op, word)
    inst.rt = rt
    inst.rs = rs
    inst.imm = immediate
    inst.width = memory.width
    inst.signed = memory.signed
    return inst
  }

  // The coprocessor loads and stores, which are ordinary memory
  // instructions that happen to name a coprocessor register.
  if (opcode === 0x31 || opcode === 0x35 || opcode === 0x39 || opcode === 0x3d) {
    const store = opcode >= 0x39
    const inst = make(store ? MIPS.FP_STORE : MIPS.FP_LOAD, word)
    inst.rt = rt
    inst.rs = rs
    inst.imm = immediate
    inst.width = opcode === 0x31 || opcode === 0x39 ? 4 : 8
    inst.fmt = inst.width
    return inst
  }

  if (opcode === 0x11) return decodeCop1(word, address, rs, rt, rd, sa, funct, unsupported)
  if (opcode === 0x13) return decodeCop1x(word, rs, rt, rd, sa, funct, unsupported)
  if (opcode === 0x10 || opcode === 0x12) {
    return unsupported(`coprocessor ${opcode - 0x10}`)
  }
  return unsupported(`opcode ${opcode}`)
}

/**
 * Coprocessor 1: the floating-point unit.
 *
 * The rs field, which everywhere else names a register, here names what
 * kind of instruction this is: a move between the files, a branch on a
 * condition bit, or an operation in one of the numeric formats. Only once
 * it has said "an operation in the double format" does the function field
 * mean what it usually means.
 */
function decodeCop1(
  word: number,
  address: bigint,
  rs: number,
  rt: number,
  fs: number,
  fd: number,
  funct: number,
  unsupported: Fail,
): MipsInst {
  // The moves between the two register files.
  const moves: Record<number, MipsOp> = {
    0x00: MIPS.MFC1, 0x02: MIPS.CFC1, 0x03: MIPS.MFHC1,
    0x04: MIPS.MTC1, 0x06: MIPS.CTC1, 0x07: MIPS.MTHC1,
  }
  const move = moves[rs]
  if (move !== undefined) {
    const inst = make(move, word)
    inst.rt = rt
    inst.rd = fs
    return inst
  }

  if (rs === 0x08) {
    // Branch on a condition bit. The rt field carries which bit, whether
    // the branch is on true or false, and whether the delay slot is
    // annulled -- the last of which is refused rather than guessed.
    const inst = make(MIPS.BC1, word, Flow.BRANCH)
    inst.cc = (rt >> 2) & 7
    inst.predicate = rt & 1
    if ((rt & 2) !== 0) return unsupported('a branch that annuls its delay slot')
    inst.imm = BigInt.asIntN(16, BigInt(word & 0xffff)) << 2n
    inst.target = address + 4n + inst.imm
    return inst
  }

  const formats: Record<number, number> = { 0x10: 4, 0x11: 8, 0x14: 1, 0x15: 2 }
  const fmt = formats[rs]
  if (fmt === undefined) return unsupported(`coprocessor 1 with rs ${rs}`)

  // The compares occupy the top quarter of the function space, with the
  // predicate in the low four bits rather than in a field of its own.
  if (funct >= 0x30) {
    if (fmt !== 4 && fmt !== 8) return unsupported(`compare in format ${fmt}`)
    const inst = make(MIPS.FP_CMP, word)
    inst.rd = fs
    inst.rt = rt
    inst.fmt = fmt
    inst.cc = (fd >> 2) & 7
    inst.predicate = funct & 0xf
    return inst
  }

  const arithmetic: Record<number, MipsOp> = {
    0x00: MIPS.FP_ADD, 0x01: MIPS.FP_SUB, 0x02: MIPS.FP_MUL, 0x03: MIPS.FP_DIV,
    0x04: MIPS.FP_SQRT, 0x05: MIPS.FP_ABS, 0x06: MIPS.FP_MOV, 0x07: MIPS.FP_NEG,
  }
  const op = arithmetic[funct]
  if (op !== undefined) {
    if (fmt !== 4 && fmt !== 8) return unsupported(`arithmetic in format ${fmt}`)
    const inst = make(op, word)
    inst.rd = fd
    inst.rs = fs
    inst.rt = rt
    inst.fmt = fmt
    inst.toFmt = fmt
    return inst
  }

  // Rounding to an integer in a named direction. The low two bits of the
  // function number are the direction, in the order the control register
  // numbers them.
  if (funct >= 0x0c && funct <= 0x0f) {
    if (fmt !== 4 && fmt !== 8) return unsupported(`rounding in format ${fmt}`)
    const inst = make(MIPS.FP_ROUND, word)
    inst.rd = fd
    inst.rs = fs
    inst.fmt = fmt
    inst.toFmt = 1
    inst.predicate = funct & 3
    return inst
  }

  const conversions: Record<number, number> = { 0x20: 4, 0x21: 8, 0x24: 1 }
  const to = conversions[funct]
  if (to !== undefined) {
    const inst = make(MIPS.FP_CVT, word)
    inst.rd = fd
    inst.rs = fs
    inst.fmt = fmt
    inst.toFmt = to
    return inst
  }

  if (funct === 0x11 || funct === 0x12 || funct === 0x13) {
    const table: Record<number, MipsOp> = {
      0x11: MIPS.FP_MOVCF, 0x12: MIPS.FP_MOVZ, 0x13: MIPS.FP_MOVN,
    }
    const inst = make(table[funct]!, word)
    inst.rd = fd
    inst.rs = fs
    inst.rt = rt
    inst.fmt = fmt
    inst.toFmt = fmt
    if (funct === 0x11) {
      inst.cc = (rt >> 2) & 7
      inst.predicate = rt & 1
    }
    return inst
  }

  return unsupported(`coprocessor 1 function ${funct} in format ${fmt}`)
}

/**
 * The multiply-add escape.
 *
 * It exists because the operation needs four register fields and the
 * ordinary floating-point format has three. The fourth, the addend, takes
 * the place the source register usually occupies, which is why this is a
 * separate opcode rather than another function code.
 *
 * `predicate` carries which of the four it is: bit 0 negates the addend,
 * bit 1 negates the whole result.
 */
function decodeCop1x(
  word: number,
  fr: number,
  ft: number,
  fs: number,
  fd: number,
  funct: number,
  unsupported: Fail,
): MipsInst {
  const table: Record<number, { negateAddend: boolean; negateResult: boolean; fmt: number }> = {
    0x20: { negateAddend: false, negateResult: false, fmt: 4 },
    0x21: { negateAddend: false, negateResult: false, fmt: 8 },
    0x28: { negateAddend: true, negateResult: false, fmt: 4 },
    0x29: { negateAddend: true, negateResult: false, fmt: 8 },
    0x30: { negateAddend: false, negateResult: true, fmt: 4 },
    0x31: { negateAddend: false, negateResult: true, fmt: 8 },
    0x38: { negateAddend: true, negateResult: true, fmt: 4 },
    0x39: { negateAddend: true, negateResult: true, fmt: 8 },
  }
  const form = table[funct]
  if (form === undefined) return unsupported(`cop1x function ${funct}`)
  const inst = make(MIPS.FP_MADD, word)
  inst.rd = fd
  inst.rs = fs
  inst.rt = ft
  inst.sa = fr
  inst.fmt = form.fmt
  inst.toFmt = form.fmt
  inst.predicate = (form.negateAddend ? 1 : 0) | (form.negateResult ? 2 : 0)
  return inst
}

function decodeSpecial(
  word: number,
  address: bigint,
  rs: number,
  rt: number,
  rd: number,
  sa: number,
  funct: number,
  unsupported: Fail,
  bad: Fail,
): MipsInst {
  const three: Record<number, MipsOp> = {
    0x21: MIPS.ADDU, 0x23: MIPS.SUBU, 0x24: MIPS.AND, 0x25: MIPS.OR,
    0x26: MIPS.XOR, 0x27: MIPS.NOR, 0x2a: MIPS.SLT, 0x2b: MIPS.SLTU,
    0x04: MIPS.SLLV, 0x06: MIPS.SRLV, 0x07: MIPS.SRAV,
    0x0a: MIPS.MOVZ, 0x0b: MIPS.MOVN,
  }
  const op = three[funct]
  if (op !== undefined) {
    const inst = make(op, word)
    inst.rd = rd
    inst.rs = rs
    inst.rt = rt
    return inst
  }

  if (funct === 0x01) {
    const inst = make(MIPS.MOVCI, word)
    inst.rd = rd
    inst.rs = rs
    inst.cc = (rt >> 2) & 7
    inst.predicate = rt & 1
    return inst
  }

  // The conditional traps, which a compiler puts in front of a divide so
  // that dividing by zero stops rather than being unpredictable.
  if (funct >= 0x30 && funct <= 0x36 && funct !== 0x35) {
    const inst = make(MIPS.TRAP, word, Flow.TRAP)
    inst.rs = rs
    inst.rt = rt
    inst.predicate = funct - 0x30
    return inst
  }

  switch (funct) {
    case 0x00:
    case 0x02:
    case 0x03: {
      // The shift by a constant. funct 2 with rs set is a rotate rather
      // than a shift, which is the same encoding with one bit moved.
      if (funct === 0x02 && rs === 1) {
        const inst = make(MIPS.ROTR, word)
        inst.rd = rd
        inst.rt = rt
        inst.sa = sa
        return inst
      }
      const table: Record<number, MipsOp> = { 0x00: MIPS.SLL, 0x02: MIPS.SRL, 0x03: MIPS.SRA }
      const inst = make(table[funct]!, word)
      inst.rd = rd
      inst.rt = rt
      inst.sa = sa
      return inst
    }

    case 0x08:
    case 0x09: {
      const inst = make(funct === 0x08 ? MIPS.JR : MIPS.JALR, word,
        funct === 0x08 ? (rs === 31 ? Flow.RET : Flow.INDIRECT) : Flow.CALL)
      inst.rs = rs
      if (funct === 0x09) inst.rd = rd === 0 ? 31 : rd
      void address
      return inst
    }

    case 0x0c: return make(MIPS.SYSCALL, word, Flow.TRAP)
    case 0x0d: return make(MIPS.BREAK, word, Flow.TRAP)
    case 0x0f: return make(MIPS.SYNC, word)

    case 0x10:
    case 0x12: {
      const inst = make(funct === 0x10 ? MIPS.MFHI : MIPS.MFLO, word)
      inst.rd = rd
      return inst
    }
    case 0x11:
    case 0x13: {
      const inst = make(funct === 0x11 ? MIPS.MTHI : MIPS.MTLO, word)
      inst.rs = rs
      return inst
    }

    case 0x18:
    case 0x19:
    case 0x1a:
    case 0x1b: {
      const table: Record<number, MipsOp> = {
        0x18: MIPS.MULT, 0x19: MIPS.MULTU, 0x1a: MIPS.DIV, 0x1b: MIPS.DIVU,
      }
      const inst = make(table[funct]!, word)
      inst.rs = rs
      inst.rt = rt
      return inst
    }

    case 0x20: return unsupported('add, which traps on overflow')
    case 0x22: return unsupported('sub, which traps on overflow')

    default:
      void bad
      return unsupported(`special function ${funct}`)
  }
}

function decodeSpecial2(
  word: number,
  rs: number,
  rt: number,
  rd: number,
  sa: number,
  funct: number,
  unsupported: Fail,
): MipsInst {
  void sa
  switch (funct) {
    case 0x02: {
      const inst = make(MIPS.MUL, word)
      inst.rd = rd
      inst.rs = rs
      inst.rt = rt
      return inst
    }
    case 0x00:
    case 0x04: {
      const inst = make(funct === 0x00 ? MIPS.MADD : MIPS.MSUB, word)
      inst.rs = rs
      inst.rt = rt
      return inst
    }
    case 0x20:
    case 0x21: {
      const inst = make(funct === 0x20 ? MIPS.CLZ : MIPS.CLO, word)
      inst.rd = rd
      inst.rs = rs
      return inst
    }
    default:
      return unsupported(`special2 function ${funct}`)
  }
}

function decodeSpecial3(
  word: number,
  rs: number,
  rt: number,
  rd: number,
  sa: number,
  funct: number,
  unsupported: Fail,
): MipsInst {
  switch (funct) {
    case 0x00:
    case 0x04: {
      // Extract and insert. The two encode their operands differently:
      // for ext, rd is the width minus one; for ins, it is the position
      // of the last bit rather than the width.
      const inst = make(funct === 0x00 ? MIPS.EXT : MIPS.INS, word)
      inst.rt = rt
      inst.rs = rs
      inst.sa = sa
      inst.size = funct === 0x00 ? rd + 1 : rd + 1 - sa
      if (inst.size <= 0 || inst.sa + inst.size > 32) {
        return unsupported(`bitfield of ${inst.size} bits at ${inst.sa}`)
      }
      return inst
    }
    case 0x20: {
      const table: Record<number, MipsOp> = {
        0x02: MIPS.WSBH, 0x10: MIPS.SEB, 0x18: MIPS.SEH,
      }
      const op = table[sa]
      if (op === undefined) return unsupported(`bshfl function ${sa}`)
      const inst = make(op, word)
      inst.rd = rd
      inst.rt = rt
      return inst
    }
    case 0x3b: {
      // The one hardware register a userspace program may read: the
      // thread pointer, which this architecture does not give a general
      // register to.
      if (rd !== 29) return unsupported(`hardware register ${rd}`)
      const inst = make(MIPS.RDHWR, word)
      inst.rt = rt
      inst.rd = rd
      return inst
    }
    default:
      return unsupported(`special3 function ${funct}`)
  }
}
