/**
 * x86-64 decoder.
 *
 * The structural difference from the other targets is that an instruction
 * has no fixed length and no fixed shape. It is a sequence of optional
 * prefixes, an optional REX byte, one to three opcode bytes, an optional
 * ModRM byte that may pull in a SIB byte and a displacement, and an optional
 * immediate. Nothing before the ModRM byte tells you whether there is one.
 *
 * Two consequences run through this file.
 *
 * The decoder reads bytes through a cursor rather than indexing a word, and
 * reports how many it consumed, because the caller cannot know where the
 * next instruction starts until this one has been decoded. A RIP-relative
 * displacement is resolved here for the same reason: it is relative to the
 * end of the instruction, which is not known until the immediate has been
 * read, so leaving it to the executor would mean computing the length twice.
 *
 * The operand model is one register field, one register-or-memory field and
 * one immediate, which is the shape of the encoding rather than the shape of
 * any particular instruction. An x86 instruction has at most one memory
 * operand, and that is what makes the model work at all.
 *
 * Scope is what the corpus and a real libc actually execute, measured rather
 * than guessed, and everything outside it raises rather than falling
 * through. The measurement is in docs/architecture/real-isa.md.
 */
import { IllegalInstruction, UnimplementedInstruction } from '../common/errors.ts'

export const ISA_NAME = 'x86'

export const X86 = {
  ILLEGAL: 0,

  // Integer arithmetic and logic. The flag-setting behaviour is part of the
  // operation rather than an option, which is the opposite of AArch64.
  ADD: 1,
  OR: 2,
  ADC: 3,
  SBB: 4,
  AND: 5,
  SUB: 6,
  XOR: 7,
  CMP: 8,
  TEST: 9,
  NOT: 10,
  NEG: 11,
  INC: 12,
  DEC: 13,

  // Moves.
  MOV: 14,
  MOVZX: 15,
  MOVSX: 16,
  LEA: 17,
  XCHG: 18,

  // Shifts and rotates.
  ROL: 19,
  ROR: 20,
  RCL: 21,
  RCR: 22,
  SHL: 23,
  SHR: 24,
  SAR: 25,
  SHLD: 26,
  SHRD: 27,

  // Multiply and divide.
  IMUL1: 28,
  IMUL2: 29,
  MUL: 30,
  DIV: 31,
  IDIV: 32,

  // Bit operations.
  BT: 33,
  BTS: 34,
  BTR: 35,
  BTC: 36,
  BSF: 37,
  BSR: 38,
  TZCNT: 39,
  LZCNT: 40,
  POPCNT: 41,
  BSWAP: 42,

  /** Sign-extend the accumulator into itself, or into rDX. */
  CWDE: 43,
  CDQ: 44,
  /**
   * Copies five of the flags into ah. The sixth, overflow, needs a seto,
   * which is why reading the whole flag word takes two instructions.
   */
  LAHF: 94,

  // Conditional on the flags.
  JCC: 45,
  SETCC: 46,
  CMOVCC: 47,

  // Control transfer.
  JMP: 48,
  JMP_INDIRECT: 49,
  CALL: 50,
  CALL_INDIRECT: 51,
  RET: 52,
  PUSH: 53,
  POP: 54,
  LEAVE: 55,
  SYSCALL: 56,
  INT3: 57,
  NOP: 58,
  UD2: 59,

  // String operations, with or without a repeat prefix.
  MOVS: 60,
  STOS: 61,

  // The read-modify-write pair a libc's allocator needs.
  CMPXCHG: 62,
  XADD: 63,

  // SSE and SSE2. Moves first: the same operation at four widths, which the
  // prefix rather than the opcode selects.
  MOV_XMM: 64,
  MOV_XMM_SCALAR: 65,
  MOVD: 66,
  MOVQ_XMM: 67,
  /**
   * Moves one half of a vector register, leaving the other half alone.
   * `cond` says which half is written: 0 the low one, 1 the high one.
   */
  MOV_HALF: 95,
  /** ... and the register-to-register forms, movhlps and movlhps. */
  MOV_HALF_REG: 96,

  /**
   * The x87 stack. Present because a `long double` on this target is the
   * 80-bit format and a libc's printf converts through one, not because
   * anything a compiler emits for ordinary arithmetic uses it.
   *
   * `cond` carries the arithmetic operation for X87_ARITH: 0 add, 1
   * multiply, 2 compare, 3 compare and pop, 4 subtract, 5 subtract from,
   * 6 divide, 7 divide into. `regIsDestination` says the destination is
   * st(i) rather than st(0), and `accumulatorForm` says pop afterwards.
   */
  X87_LOAD: 97,
  X87_STORE: 98,
  X87_ARITH: 99,
  X87_COMPARE: 100,
  X87_CONST: 101,
  X87_UNARY: 102,
  X87_XCH: 103,
  X87_LDCW: 104,
  X87_STCW: 105,
  X87_FREE: 106,

  // Packed integer.
  PXOR: 68,
  PAND: 69,
  POR: 70,
  PADD: 71,
  PSUB: 72,
  PMULUDQ: 73,
  PCMPGT: 74,
  PCMPEQ: 75,
  PUNPCKL: 76,
  PSHUFD: 77,

  // Scalar floating point.
  ADDSD: 78,
  SUBSD: 79,
  MULSD: 80,
  DIVSD: 81,
  SQRTSD: 82,
  MINSD: 83,
  MAXSD: 84,
  UCOMIS: 85,
  ANDP: 86,
  ANDNP: 87,
  ORP: 88,
  XORP: 89,
  CVTTS2SI: 90,
  CVTSI2S: 91,
  CVTS2S: 92,

  // Reads a segment-relative address. Only FS is implemented, because
  // thread-local storage is the only thing that uses one here.
  PREFETCH: 93,
} as const

export type X86Op = (typeof X86)[keyof typeof X86]

export const X86_NAME: readonly string[] = (() => {
  const names: string[] = []
  for (const [key, value] of Object.entries(X86)) names[value] = key.toLowerCase()
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

/** Condition codes, in the order the encoding numbers them. */
export const Cond = {
  O: 0, NO: 1, B: 2, AE: 3, E: 4, NE: 5, BE: 6, A: 7,
  S: 8, NS: 9, P: 10, NP: 11, L: 12, GE: 13, LE: 14, G: 15,
} as const

/** Which register file an operand names. */
export const File = { GPR: 0, XMM: 1 } as const

export const NO_REG = -1

/** A memory operand, already reduced to base + index * scale + disp. */
export interface MemOperand {
  /** Base register, or NO_REG for an absolute or RIP-relative address. */
  base: number
  index: number
  scale: number
  disp: bigint
  /** True when `disp` is already the resolved absolute target. */
  absolute: boolean
  /** Whether the address is relative to the FS base. */
  fsRelative: boolean
}

export interface X86Inst {
  op: X86Op
  /** Operand size in bytes: 1, 2, 4 or 8. */
  size: number
  /** The ModRM.reg operand, or NO_REG. */
  reg: number
  /** The r/m operand when it is a register, or NO_REG when it is memory. */
  rm: number
  /** Non-null when the r/m operand is in memory. */
  mem: MemOperand | null
  /** Which register file `reg` names. */
  regFile: number
  /** Which register file `rm` names. */
  rmFile: number
  /**
   * Whether `reg` is the destination. x86 encodes the direction in the
   * opcode rather than the operand order, so this is a field and not a
   * property of the operation.
   */
  regIsDestination: boolean
  /** True when the r/m byte operand is one of ah, ch, dh, bh. */
  rmHigh: boolean
  /** True when the reg byte operand is one of ah, ch, dh, bh. */
  regHigh: boolean
  imm: bigint
  hasImm: boolean
  /** Source size for a widening move, in bytes. */
  sourceSize: number
  /**
   * Whether a memory operand is an integer rather than a float. Only the
   * x87 instructions need this: the same escape byte reaches both, and
   * which one it is comes from the escape rather than from the operand.
   */
  signed: boolean
  cond: number
  lock: boolean
  /** 0 none, 1 rep/repe, 2 repne. */
  rep: number
  /**
   * The operand is the accumulator, which the encoding does not name: the
   * short forms of the arithmetic instructions have no ModRM byte at all.
   */
  accumulatorForm: boolean
  /** The shift count is in cl rather than in the encoding. */
  shiftByCl: boolean
  /** The memory displacement was encoded relative to the next instruction. */
  ripRelative: boolean
  /** The immediate was encoded relative to the next instruction. */
  relative: boolean
  /** Total encoded length in bytes. */
  length: number
  /** Absolute target of a direct branch. */
  target: bigint
  flow: FlowKind
  /** The encoded bytes, kept for error messages and disassembly. */
  bytes: Uint8Array
}

const REP_NONE = 0
const REP_REPE = 1
const REP_REPNE = 2

function make(op: X86Op, flow: FlowKind = Flow.SEQ): X86Inst {
  return {
    op,
    size: 4,
    reg: NO_REG,
    rm: NO_REG,
    mem: null,
    regFile: File.GPR,
    rmFile: File.GPR,
    regIsDestination: true,
    rmHigh: false,
    regHigh: false,
    imm: 0n,
    hasImm: false,
    sourceSize: 0,
    signed: false,
    accumulatorForm: false,
    shiftByCl: false,
    ripRelative: false,
    relative: false,
    cond: 0,
    lock: false,
    rep: REP_NONE,
    length: 0,
    target: 0n,
    flow,
    bytes: new Uint8Array(0),
  }
}

/**
 * Reads the bytes of one instruction, remembering them.
 *
 * The remembering is not bookkeeping: an error has to be able to say which
 * bytes it could not decode, and by the time it is raised the instruction
 * has already been partly consumed.
 */
class Cursor {
  private readonly fetch: (offset: number) => number
  private at = 0
  private readonly seen: number[] = []

  constructor(fetch: (offset: number) => number) {
    this.fetch = fetch
  }

  byte(): number {
    const value = this.fetch(this.at) & 0xff
    this.seen.push(value)
    this.at += 1
    return value
  }

  /** Looks at the next byte without consuming it. */
  peek(): number {
    return this.fetch(this.at) & 0xff
  }

  unsigned(bytes: number): bigint {
    let value = 0n
    for (let i = 0; i < bytes; i++) value |= BigInt(this.byte()) << BigInt(i * 8)
    return value
  }

  signed(bytes: number): bigint {
    return BigInt.asIntN(bytes * 8, this.unsigned(bytes))
  }

  get length(): number {
    return this.at
  }

  get consumed(): Uint8Array {
    return Uint8Array.from(this.seen)
  }
}

interface Prefixes {
  operandSize16: boolean
  addressSize32: boolean
  lock: boolean
  rep: number
  fs: boolean
  gs: boolean
  rex: number
  hasRex: boolean
}

const REX_W = 8
const REX_R = 4
const REX_X = 2
const REX_B = 1

/** Decodes one instruction beginning at `address`. */
export function decode(fetch: (offset: number) => number, address: bigint): X86Inst {
  const cursor = new Cursor(fetch)
  const fail = (detail: string): never => {
    throw new UnimplementedInstruction(ISA_NAME, address, cursor.consumed, detail)
  }
  const bad = (detail: string): never => {
    throw new IllegalInstruction(ISA_NAME, address, cursor.consumed, detail)
  }

  const prefixes: Prefixes = {
    operandSize16: false,
    addressSize32: false,
    lock: false,
    rep: REP_NONE,
    fs: false,
    gs: false,
    rex: 0,
    hasRex: false,
  }

  // Legacy prefixes, then at most one REX, which must be the last one before
  // the opcode: a REX followed by another prefix is not a REX at all.
  for (;;) {
    const next = cursor.peek()
    if (next === 0x66) { prefixes.operandSize16 = true; cursor.byte(); continue }
    if (next === 0x67) { prefixes.addressSize32 = true; cursor.byte(); continue }
    if (next === 0xf0) { prefixes.lock = true; cursor.byte(); continue }
    if (next === 0xf2) { prefixes.rep = REP_REPNE; cursor.byte(); continue }
    if (next === 0xf3) { prefixes.rep = REP_REPE; cursor.byte(); continue }
    if (next === 0x64) { prefixes.fs = true; cursor.byte(); continue }
    if (next === 0x65) { prefixes.gs = true; cursor.byte(); continue }
    if (next === 0x2e || next === 0x3e || next === 0x26 || next === 0x36) {
      // In 64-bit mode CS, DS, ES and SS overrides are ignored, and a
      // compiler emits one only as padding in front of a nop.
      cursor.byte()
      continue
    }
    if ((next & 0xf0) === 0x40) {
      prefixes.rex = cursor.byte() & 0x0f
      prefixes.hasRex = true
    }
    break
  }

  if (prefixes.addressSize32) fail('32-bit address size')
  if (prefixes.gs) fail('gs-relative addressing')

  const inst = decodeOpcode(cursor, prefixes, address, fail, bad)
  inst.length = cursor.length
  inst.bytes = cursor.consumed
  inst.lock = prefixes.lock

  // Both of these count from the end of the instruction, so neither can be
  // resolved until the immediate has been read and the length is known.
  if (inst.ripRelative && inst.mem !== null) {
    inst.mem.disp = address + BigInt(inst.length) + inst.mem.disp
  }
  if (inst.relative) inst.target = address + BigInt(inst.length) + inst.imm
  return inst
}

/** Operand size, once the prefixes and the opcode's own width bit agree. */
function operandSize(prefixes: Prefixes, byteForm: boolean): number {
  if (byteForm) return 1
  if ((prefixes.rex & REX_W) !== 0) return 8
  return prefixes.operandSize16 ? 2 : 4
}

/**
 * Reads a ModRM byte and everything it implies.
 *
 * The three cases that are easy to get wrong, and are each a silently
 * plausible address if missed: rm = 100 means a SIB byte follows rather than
 * naming rsp; rm = 101 with mod = 00 means RIP-relative rather than naming
 * rbp; and an index of 100 in the SIB byte means no index rather than rsp.
 */
function readModrm(
  cursor: Cursor,
  prefixes: Prefixes,
  inst: X86Inst,
): number {
  const modrm = cursor.byte()
  const mod = modrm >> 6
  const regField = ((modrm >> 3) & 7) | (((prefixes.rex & REX_R) !== 0) ? 8 : 0)
  const rmField = modrm & 7

  inst.reg = regField

  if (mod === 3) {
    inst.rm = rmField | (((prefixes.rex & REX_B) !== 0) ? 8 : 0)
    inst.mem = null
    return regField
  }

  let base = NO_REG
  let index = NO_REG
  let scale = 1
  let disp = 0n
  let ripRelative = false

  if (rmField === 4) {
    const sib = cursor.byte()
    scale = 1 << (sib >> 6)
    const indexField = ((sib >> 3) & 7) | (((prefixes.rex & REX_X) !== 0) ? 8 : 0)
    // Index 4 without REX.X is the encoding for "no index". With REX.X it
    // is r12, which is a real index register.
    if (indexField !== 4) index = indexField
    const baseField = (sib & 7) | (((prefixes.rex & REX_B) !== 0) ? 8 : 0)
    if ((sib & 7) === 5 && mod === 0) {
      disp = cursor.signed(4)
    } else {
      base = baseField
    }
  } else if (rmField === 5 && mod === 0) {
    disp = cursor.signed(4)
    ripRelative = true
  } else {
    base = rmField | (((prefixes.rex & REX_B) !== 0) ? 8 : 0)
  }

  if (mod === 1) disp += cursor.signed(1)
  else if (mod === 2) disp += cursor.signed(4)

  inst.rm = NO_REG
  inst.mem = {
    base,
    index,
    scale,
    disp,
    absolute: ripRelative || (base === NO_REG && index === NO_REG),
    fsRelative: prefixes.fs,
  }
  if (ripRelative) inst.ripRelative = true
  return regField
}

type Fail = (detail: string) => never

/** The eight operations the 0x00-0x3f block and group 1 share. */
const ALU_OPS: readonly X86Op[] = [
  X86.ADD, X86.OR, X86.ADC, X86.SBB, X86.AND, X86.SUB, X86.XOR, X86.CMP,
]

/** The eight shifts and rotates group 2 selects between. */
const SHIFT_OPS: readonly (X86Op | undefined)[] = [
  X86.ROL, X86.ROR, X86.RCL, X86.RCR, X86.SHL, X86.SHR, undefined, X86.SAR,
]

function decodeOpcode(
  cursor: Cursor,
  prefixes: Prefixes,
  address: bigint,
  fail: Fail,
  bad: Fail,
): X86Inst {
  const opcode = cursor.byte()

  // The arithmetic block: eight operations, six forms each, laid out so the
  // operation is the top five bits and the form is the bottom three.
  if (opcode < 0x40 && (opcode & 7) < 6) {
    const op = ALU_OPS[opcode >> 3]!
    const form = opcode & 7
    const byteForm = (form & 1) === 0
    const inst = make(op)
    inst.size = operandSize(prefixes, byteForm)
    if (form < 4) {
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = form >= 2
      applyByteRegisters(inst, prefixes)
    } else {
      // The accumulator forms, which name no register at all.
      inst.reg = 0
      inst.rm = NO_REG
      inst.mem = null
      inst.regIsDestination = true
      inst.imm = cursor.signed(inst.size === 1 ? 1 : Math.min(inst.size, 4))
      inst.hasImm = true
      inst.accumulatorForm = true
    }
    return inst
  }

  if (opcode >= 0x50 && opcode <= 0x57) {
    const inst = make(X86.PUSH)
    inst.size = 8
    inst.reg = (opcode - 0x50) | (((prefixes.rex & REX_B) !== 0) ? 8 : 0)
    return inst
  }
  if (opcode >= 0x58 && opcode <= 0x5f) {
    const inst = make(X86.POP)
    inst.size = 8
    inst.reg = (opcode - 0x58) | (((prefixes.rex & REX_B) !== 0) ? 8 : 0)
    return inst
  }

  switch (opcode) {
    case 0x63: {
      // movsxd: the one sign-extending move with its own opcode, because
      // widening 32 to 64 bits is what every array index needs.
      const inst = make(X86.MOVSX)
      inst.size = operandSize(prefixes, false)
      inst.sourceSize = 4
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = true
      return inst
    }

    case 0x68:
    case 0x6a: {
      const inst = make(X86.PUSH)
      inst.size = 8
      inst.reg = NO_REG
      inst.imm = cursor.signed(opcode === 0x68 ? 4 : 1)
      inst.hasImm = true
      return inst
    }

    case 0x69:
    case 0x6b: {
      const inst = make(X86.IMUL2)
      inst.size = operandSize(prefixes, false)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = true
      inst.imm = cursor.signed(opcode === 0x69 ? Math.min(inst.size, 4) : 1)
      inst.hasImm = true
      return inst
    }

    case 0x80:
    case 0x81:
    case 0x83: {
      const inst = make(X86.ILLEGAL)
      inst.size = operandSize(prefixes, opcode === 0x80)
      const extension = (readModrm(cursor, prefixes, inst) & 7)
      inst.op = ALU_OPS[extension]!
      inst.reg = NO_REG
      inst.regIsDestination = false
      applyByteRegisters(inst, prefixes)
      inst.imm = opcode === 0x81
        ? cursor.signed(Math.min(inst.size, 4))
        : cursor.signed(1)
      inst.hasImm = true
      return inst
    }

    case 0x84:
    case 0x85: {
      const inst = make(X86.TEST)
      inst.size = operandSize(prefixes, opcode === 0x84)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = false
      applyByteRegisters(inst, prefixes)
      return inst
    }

    case 0x86:
    case 0x87: {
      const inst = make(X86.XCHG)
      inst.size = operandSize(prefixes, opcode === 0x86)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = false
      applyByteRegisters(inst, prefixes)
      return inst
    }

    case 0x88:
    case 0x89:
    case 0x8a:
    case 0x8b: {
      const inst = make(X86.MOV)
      inst.size = operandSize(prefixes, (opcode & 1) === 0)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = opcode >= 0x8a
      applyByteRegisters(inst, prefixes)
      return inst
    }

    case 0x8d: {
      const inst = make(X86.LEA)
      inst.size = operandSize(prefixes, false)
      readModrm(cursor, prefixes, inst)
      if (inst.mem === null) return bad('lea of a register')
      inst.regIsDestination = true
      return inst
    }

    case 0x90: {
      // Without REX.B this is the canonical one-byte nop rather than an
      // exchange of rax with itself.
      if ((prefixes.rex & REX_B) === 0) return make(X86.NOP)
      const inst = make(X86.XCHG)
      inst.size = operandSize(prefixes, false)
      inst.reg = 0
      inst.rm = 8
      return inst
    }

    case 0x98: {
      const inst = make(X86.CWDE)
      inst.size = operandSize(prefixes, false)
      return inst
    }
    case 0x99: {
      const inst = make(X86.CDQ)
      inst.size = operandSize(prefixes, false)
      return inst
    }

    case 0x9f: {
      const inst = make(X86.LAHF)
      inst.size = 1
      return inst
    }

    case 0x9b:
      // fwait. With no unmasked x87 exception pending it does nothing, and
      // this interpreter raises on the instructions that could raise one.
      return make(X86.NOP)

    case 0xa4:
    case 0xa5: {
      const inst = make(X86.MOVS)
      inst.size = operandSize(prefixes, opcode === 0xa4)
      inst.rep = prefixes.rep
      return inst
    }

    case 0xaa:
    case 0xab: {
      const inst = make(X86.STOS)
      inst.size = operandSize(prefixes, opcode === 0xaa)
      inst.rep = prefixes.rep
      return inst
    }

    case 0xa8:
    case 0xa9: {
      const inst = make(X86.TEST)
      inst.size = operandSize(prefixes, opcode === 0xa8)
      inst.reg = 0
      inst.rm = NO_REG
      inst.accumulatorForm = true
      inst.imm = cursor.signed(inst.size === 1 ? 1 : Math.min(inst.size, 4))
      inst.hasImm = true
      return inst
    }

    case 0xc0:
    case 0xc1:
    case 0xd0:
    case 0xd1:
    case 0xd2:
    case 0xd3: {
      const inst = make(X86.ILLEGAL)
      inst.size = operandSize(prefixes, (opcode & 1) === 0)
      const extension = readModrm(cursor, prefixes, inst) & 7
      const op = SHIFT_OPS[extension]
      if (op === undefined) return fail(`shift group extension ${extension}`)
      inst.op = op
      inst.reg = NO_REG
      inst.regIsDestination = false
      applyByteRegisters(inst, prefixes)
      if (opcode === 0xc0 || opcode === 0xc1) {
        inst.imm = cursor.unsigned(1)
        inst.hasImm = true
      } else if (opcode === 0xd0 || opcode === 0xd1) {
        inst.imm = 1n
        inst.hasImm = true
      } else {
        // The count is in cl, which is not an encoded operand.
        inst.shiftByCl = true
      }
      return inst
    }

    case 0xc3:
      return make(X86.RET, Flow.RET)

    case 0xc6:
    case 0xc7: {
      const inst = make(X86.MOV)
      inst.size = operandSize(prefixes, opcode === 0xc6)
      const extension = readModrm(cursor, prefixes, inst) & 7
      if (extension !== 0) return fail(`mov-immediate group extension ${extension}`)
      inst.reg = NO_REG
      inst.regIsDestination = false
      applyByteRegisters(inst, prefixes)
      inst.imm = cursor.signed(inst.size === 1 ? 1 : Math.min(inst.size, 4))
      inst.hasImm = true
      return inst
    }

    case 0xc9: {
      const inst = make(X86.LEAVE)
      inst.size = 8
      return inst
    }

    case 0xcc:
      return make(X86.INT3, Flow.TRAP)

    case 0xe8: {
      const inst = make(X86.CALL, Flow.CALL)
      inst.size = 8
      inst.imm = cursor.signed(4)
      inst.relative = true
      return inst
    }

    case 0xe9:
    case 0xeb: {
      const inst = make(X86.JMP, Flow.JUMP)
      inst.imm = cursor.signed(opcode === 0xe9 ? 4 : 1)
      inst.relative = true
      return inst
    }

    case 0xf6:
    case 0xf7: {
      const inst = make(X86.ILLEGAL)
      inst.size = operandSize(prefixes, opcode === 0xf6)
      const extension = readModrm(cursor, prefixes, inst) & 7
      inst.reg = NO_REG
      inst.regIsDestination = false
      applyByteRegisters(inst, prefixes)
      switch (extension) {
        case 0:
        case 1:
          inst.op = X86.TEST
          inst.imm = cursor.signed(inst.size === 1 ? 1 : Math.min(inst.size, 4))
          inst.hasImm = true
          return inst
        case 2: inst.op = X86.NOT; return inst
        case 3: inst.op = X86.NEG; return inst
        case 4: inst.op = X86.MUL; return inst
        case 5: inst.op = X86.IMUL1; return inst
        case 6: inst.op = X86.DIV; return inst
        default: inst.op = X86.IDIV; return inst
      }
    }

    case 0xfe:
    case 0xff: {
      const inst = make(X86.ILLEGAL)
      inst.size = operandSize(prefixes, opcode === 0xfe)
      const extension = readModrm(cursor, prefixes, inst) & 7
      inst.reg = NO_REG
      inst.regIsDestination = false
      applyByteRegisters(inst, prefixes)
      if (extension === 0) { inst.op = X86.INC; return inst }
      if (extension === 1) { inst.op = X86.DEC; return inst }
      if (opcode === 0xfe) return bad(`byte inc/dec group extension ${extension}`)
      if (extension === 2) {
        inst.op = X86.CALL_INDIRECT
        inst.flow = Flow.CALL
        inst.size = 8
        return inst
      }
      if (extension === 4) {
        inst.op = X86.JMP_INDIRECT
        inst.flow = Flow.INDIRECT
        inst.size = 8
        return inst
      }
      if (extension === 6) {
        inst.op = X86.PUSH
        inst.size = 8
        return inst
      }
      return fail(`indirect group extension ${extension}`)
    }

    default:
      break
  }

  if (opcode >= 0x70 && opcode <= 0x7f) {
    const inst = make(X86.JCC, Flow.BRANCH)
    inst.cond = opcode - 0x70
    inst.imm = cursor.signed(1)
    inst.relative = true
    return inst
  }

  if (opcode >= 0xb0 && opcode <= 0xb7) {
    const inst = make(X86.MOV)
    inst.size = 1
    inst.reg = NO_REG
    inst.rm = (opcode - 0xb0) | (((prefixes.rex & REX_B) !== 0) ? 8 : 0)
    inst.rmHigh = !prefixes.hasRex && (opcode - 0xb0) >= 4
    if (inst.rmHigh) inst.rm = (opcode - 0xb0) - 4
    inst.regIsDestination = false
    inst.imm = cursor.unsigned(1)
    inst.hasImm = true
    return inst
  }

  if (opcode >= 0xb8 && opcode <= 0xbf) {
    const inst = make(X86.MOV)
    inst.size = operandSize(prefixes, false)
    inst.reg = NO_REG
    inst.rm = (opcode - 0xb8) | (((prefixes.rex & REX_B) !== 0) ? 8 : 0)
    inst.regIsDestination = false
    // The 64-bit form is the only instruction that carries a full 64-bit
    // immediate, which is why it has an assembler mnemonic of its own.
    inst.imm = inst.size === 8 ? cursor.unsigned(8) : cursor.unsigned(inst.size)
    inst.hasImm = true
    return inst
  }

  if (opcode === 0x0f) return decodeTwoByte(cursor, prefixes, address, fail, bad)

  if (opcode >= 0xd8 && opcode <= 0xdf) {
    return decodeX87(cursor, prefixes, opcode, fail, bad)
  }

  return fail(`opcode ${opcode.toString(16)}`)
}

/**
 * Byte operands 4 to 7 name ah, ch, dh and bh when no REX byte is present,
 * and spl, bpl, sil and dil when one is. Getting this wrong reads the wrong
 * half of the wrong register and produces a plausible number.
 */
function applyByteRegisters(inst: X86Inst, prefixes: Prefixes): void {
  if (inst.size !== 1 || prefixes.hasRex) return
  if (inst.reg >= 4 && inst.reg <= 7) {
    inst.reg -= 4
    inst.regHigh = true
  }
  if (inst.rm >= 4 && inst.rm <= 7 && inst.mem === null) {
    inst.rm -= 4
    inst.rmHigh = true
  }
}

/**
 * The eight escape opcodes the x87 stack lives behind.
 *
 * Which instruction is meant depends on the escape byte, on whether the
 * ModRM byte names memory or a register, and then on either the three-bit
 * extension field or the whole byte. The same escape with a memory operand
 * and with a register operand are unrelated instructions, which is why
 * this is a decoder of its own rather than a table.
 */
function decodeX87(
  cursor: Cursor,
  prefixes: Prefixes,
  escape: number,
  fail: Fail,
  bad: Fail,
): X86Inst {
  const modrm = cursor.peek()
  if (modrm >= 0xc0) return decodeX87Register(cursor, escape, fail, bad)

  const inst = make(X86.ILLEGAL)
  const extension = readModrm(cursor, prefixes, inst) & 7
  inst.reg = 0
  inst.rmFile = File.GPR
  // With a memory operand the destination is always the top of the stack.
  // Leaving this at its default would make the top both operands, which
  // turns every addition into a doubling.
  inst.regIsDestination = false

  // The escape byte says what the memory operand is: a 32- or 64-bit
  // float, a 16- or 32-bit integer, or one of the wider forms the
  // load/store escapes carry.
  const arithmetic: Record<number, { size: number; integer: boolean }> = {
    0xd8: { size: 4, integer: false },
    0xdc: { size: 8, integer: false },
    0xda: { size: 4, integer: true },
    0xde: { size: 2, integer: true },
  }
  const operand = arithmetic[escape]
  if (operand !== undefined) {
    if (extension === 2 || extension === 3) {
      inst.op = X86.X87_COMPARE
      inst.cond = extension
    } else {
      inst.op = X86.X87_ARITH
      inst.cond = extension
    }
    inst.sourceSize = operand.size
    inst.signed = operand.integer
    inst.size = operand.size
    return inst
  }

  const loadStore = (op: X86Op, size: number, integer: boolean, pop: boolean): X86Inst => {
    inst.op = op
    inst.sourceSize = size
    inst.size = size
    inst.signed = integer
    inst.accumulatorForm = pop
    return inst
  }

  switch (escape) {
    case 0xd9:
      if (extension === 0) return loadStore(X86.X87_LOAD, 4, false, false)
      if (extension === 2) return loadStore(X86.X87_STORE, 4, false, false)
      if (extension === 3) return loadStore(X86.X87_STORE, 4, false, true)
      if (extension === 5) return loadStore(X86.X87_LDCW, 2, true, false)
      if (extension === 7) return loadStore(X86.X87_STCW, 2, true, false)
      return fail(`x87 d9 memory extension ${extension}`)
    case 0xdb:
      if (extension === 0) return loadStore(X86.X87_LOAD, 4, true, false)
      if (extension === 2) return loadStore(X86.X87_STORE, 4, true, false)
      if (extension === 3) return loadStore(X86.X87_STORE, 4, true, true)
      if (extension === 5) return loadStore(X86.X87_LOAD, 10, false, false)
      if (extension === 7) return loadStore(X86.X87_STORE, 10, false, true)
      return fail(`x87 db memory extension ${extension}`)
    case 0xdd:
      if (extension === 0) return loadStore(X86.X87_LOAD, 8, false, false)
      if (extension === 2) return loadStore(X86.X87_STORE, 8, false, false)
      if (extension === 3) return loadStore(X86.X87_STORE, 8, false, true)
      return fail(`x87 dd memory extension ${extension}`)
    case 0xdf:
      if (extension === 0) return loadStore(X86.X87_LOAD, 2, true, false)
      if (extension === 2) return loadStore(X86.X87_STORE, 2, true, false)
      if (extension === 3) return loadStore(X86.X87_STORE, 2, true, true)
      if (extension === 5) return loadStore(X86.X87_LOAD, 8, true, false)
      if (extension === 7) return loadStore(X86.X87_STORE, 8, true, true)
      return fail(`x87 df memory extension ${extension}`)
    default:
      void bad
      return fail(`x87 escape ${escape.toString(16)} with a memory operand`)
  }
}

/**
 * The operations on the stack itself, where the whole ModRM byte is part
 * of the opcode.
 *
 * Subtract and divide are the awkward part. Which operand is subtracted
 * from which is not the same for the escape that writes st(0) and the one
 * that writes st(i): dc e8 is `fsub st(i), st(0)` and d8 e8 is `fsubr
 * st(0), st(i)`, and the pair are each other's mirror rather than the same
 * instruction with the operands swapped. They are mapped onto one
 * operation code here so the executor has one case, and the mapping is the
 * whole reason this table is written out.
 */
function decodeX87Register(
  cursor: Cursor,
  escape: number,
  fail: Fail,
  bad: Fail,
): X86Inst {
  const modrm = cursor.byte()
  const index = modrm & 7
  const group = (modrm >> 3) & 7
  const inst = make(X86.ILLEGAL)
  inst.reg = index
  inst.sourceSize = 0
  inst.size = 10

  /** dc and de name the operation from the other side. */
  const mirrored = [0, 1, 2, 3, 5, 4, 7, 6]

  const arith = (operation: number, toIndex: boolean, pop: boolean): X86Inst => {
    inst.op = operation === 2 || operation === 3 ? X86.X87_COMPARE : X86.X87_ARITH
    inst.cond = operation
    inst.regIsDestination = toIndex
    inst.accumulatorForm = pop
    return inst
  }

  switch (escape) {
    case 0xd8:
      return arith(group, false, false)
    case 0xdc:
      if (group === 2 || group === 3) return fail('x87 dc compare with a register')
      return arith(mirrored[group]!, true, false)
    case 0xde:
      if (modrm === 0xd9) return arith(3, false, true)
      if (group === 2 || group === 3) return fail('x87 de compare with a register')
      return arith(mirrored[group]!, true, true)

    case 0xd9:
      if (group === 0) { inst.op = X86.X87_LOAD; return inst }
      if (group === 1) { inst.op = X86.X87_XCH; return inst }
      if (modrm === 0xd0) { inst.op = X86.NOP; return inst }
      if (modrm === 0xe0 || modrm === 0xe1) {
        inst.op = X86.X87_UNARY
        inst.cond = modrm === 0xe0 ? 0 : 1
        return inst
      }
      if (modrm === 0xe8 || modrm === 0xee) {
        inst.op = X86.X87_CONST
        inst.cond = modrm === 0xe8 ? 1 : 0
        return inst
      }
      return fail(`x87 d9 ${modrm.toString(16)}`)

    case 0xdb:
      if (group === 5 || group === 6) {
        // fucomi and fcomi: a compare that writes the integer flags
        // rather than the x87 status word, which is the only form a
        // compiler emits now.
        inst.op = X86.X87_COMPARE
        inst.cond = 8
        inst.signed = group === 6
        return inst
      }
      return fail(`x87 db ${modrm.toString(16)}`)

    case 0xdd:
      if (group === 0) { inst.op = X86.X87_FREE; return inst }
      if (group === 2 || group === 3) {
        inst.op = X86.X87_STORE
        inst.regIsDestination = true
        inst.accumulatorForm = group === 3
        return inst
      }
      return fail(`x87 dd ${modrm.toString(16)}`)

    case 0xdf:
      if (group === 5 || group === 6) {
        inst.op = X86.X87_COMPARE
        inst.cond = 8
        inst.signed = group === 6
        inst.accumulatorForm = true
        return inst
      }
      void bad
      return fail(`x87 df ${modrm.toString(16)}`)

    default:
      return fail(`x87 escape ${escape.toString(16)} on the stack`)
  }
}

function decodeTwoByte(
  cursor: Cursor,
  prefixes: Prefixes,
  address: bigint,
  fail: Fail,
  bad: Fail,
): X86Inst {
  const opcode = cursor.byte()

  if (opcode >= 0x80 && opcode <= 0x8f) {
    const inst = make(X86.JCC, Flow.BRANCH)
    inst.cond = opcode - 0x80
    inst.imm = cursor.signed(4)
    inst.relative = true
    return inst
  }

  if (opcode >= 0x90 && opcode <= 0x9f) {
    const inst = make(X86.SETCC)
    inst.size = 1
    inst.cond = opcode - 0x90
    readModrm(cursor, prefixes, inst)
    inst.reg = NO_REG
    inst.regIsDestination = false
    applyByteRegisters(inst, prefixes)
    return inst
  }

  if (opcode >= 0x40 && opcode <= 0x4f) {
    const inst = make(X86.CMOVCC)
    inst.size = operandSize(prefixes, false)
    inst.cond = opcode - 0x40
    readModrm(cursor, prefixes, inst)
    inst.regIsDestination = true
    return inst
  }

  switch (opcode) {
    case 0x05:
      return make(X86.SYSCALL, Flow.TRAP)

    case 0x0b:
      return make(X86.UD2, Flow.TRAP)

    case 0x1f: {
      // The multi-byte nop. It has a ModRM byte purely to give the assembler
      // somewhere to put padding, and no effect at all.
      const inst = make(X86.NOP)
      inst.size = operandSize(prefixes, false)
      readModrm(cursor, prefixes, inst)
      inst.reg = NO_REG
      inst.rm = NO_REG
      inst.mem = null
      return inst
    }

    case 0xba: {
      // The bit tests with an immediate bit number, which the architecture
      // puts in a group of their own rather than beside the register forms.
      const inst = make(X86.ILLEGAL)
      inst.size = operandSize(prefixes, false)
      const extension = readModrm(cursor, prefixes, inst) & 7
      const table: Record<number, X86Op> = {
        4: X86.BT, 5: X86.BTS, 6: X86.BTR, 7: X86.BTC,
      }
      const op = table[extension]
      if (op === undefined) return fail(`bit-test group extension ${extension}`)
      inst.op = op
      inst.reg = NO_REG
      inst.regIsDestination = false
      inst.imm = cursor.unsigned(1)
      inst.hasImm = true
      return inst
    }

    case 0xa3:
    case 0xab:
    case 0xb3:
    case 0xbb: {
      const table: Record<number, X86Op> = {
        0xa3: X86.BT, 0xab: X86.BTS, 0xb3: X86.BTR, 0xbb: X86.BTC,
      }
      const inst = make(table[opcode]!)
      inst.size = operandSize(prefixes, false)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = false
      return inst
    }

    case 0xa4:
    case 0xa5:
    case 0xac:
    case 0xad: {
      const inst = make(opcode < 0xac ? X86.SHLD : X86.SHRD)
      inst.size = operandSize(prefixes, false)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = false
      if (opcode === 0xa4 || opcode === 0xac) {
        inst.imm = cursor.unsigned(1)
        inst.hasImm = true
      } else {
        inst.shiftByCl = true
      }
      return inst
    }

    case 0xaf: {
      const inst = make(X86.IMUL2)
      inst.size = operandSize(prefixes, false)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = true
      return inst
    }

    case 0xb0:
    case 0xb1: {
      const inst = make(X86.CMPXCHG)
      inst.size = operandSize(prefixes, opcode === 0xb0)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = false
      applyByteRegisters(inst, prefixes)
      return inst
    }

    case 0xc0:
    case 0xc1: {
      const inst = make(X86.XADD)
      inst.size = operandSize(prefixes, opcode === 0xc0)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = false
      applyByteRegisters(inst, prefixes)
      return inst
    }

    case 0xb6:
    case 0xb7:
    case 0xbe:
    case 0xbf: {
      const inst = make(opcode < 0xbe ? X86.MOVZX : X86.MOVSX)
      inst.size = operandSize(prefixes, false)
      inst.sourceSize = (opcode & 1) === 0 ? 1 : 2
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = true
      // The source is a byte, so the high-byte registers apply to it.
      if (inst.sourceSize === 1 && !prefixes.hasRex && inst.mem === null &&
          inst.rm >= 4 && inst.rm <= 7) {
        inst.rm -= 4
        inst.rmHigh = true
      }
      return inst
    }

    case 0xbc:
    case 0xbd: {
      const inst = make(opcode === 0xbc
        ? (prefixes.rep === REP_REPE ? X86.TZCNT : X86.BSF)
        : (prefixes.rep === REP_REPE ? X86.LZCNT : X86.BSR))
      inst.size = operandSize(prefixes, false)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = true
      return inst
    }

    case 0xb8: {
      if (prefixes.rep !== REP_REPE) return fail('0f b8 without a repeat prefix')
      const inst = make(X86.POPCNT)
      inst.size = operandSize(prefixes, false)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = true
      return inst
    }

    default:
      break
  }

  if (opcode >= 0xc8 && opcode <= 0xcf) {
    const inst = make(X86.BSWAP)
    inst.size = operandSize(prefixes, false)
    inst.rm = (opcode - 0xc8) | (((prefixes.rex & REX_B) !== 0) ? 8 : 0)
    inst.reg = NO_REG
    inst.regIsDestination = false
    return inst
  }

  return decodeSse(cursor, prefixes, opcode, address, fail, bad)
}

/**
 * The width of the general-register operand of an SSE instruction.
 *
 * Not `operandSize`, and this is the trap: for these opcodes the 0x66
 * prefix is part of the instruction rather than an operand-size override,
 * so asking the usual question gives 16 bits and a destination that keeps
 * half its old contents. Only REX.W widens one of these.
 */
function sseGeneralSize(prefixes: Prefixes): number {
  return (prefixes.rex & REX_W) !== 0 ? 8 : 4
}

/** Which of the four prefix-selected forms of an SSE opcode is meant. */
function sseForm(prefixes: Prefixes): 'none' | '66' | 'f2' | 'f3' {
  if (prefixes.rep === REP_REPNE) return 'f2'
  if (prefixes.rep === REP_REPE) return 'f3'
  return prefixes.operandSize16 ? '66' : 'none'
}

function decodeSse(
  cursor: Cursor,
  prefixes: Prefixes,
  opcode: number,
  address: bigint,
  fail: Fail,
  bad: Fail,
): X86Inst {
  const form = sseForm(prefixes)
  const vector = (op: X86Op, regDest: boolean, element = 0): X86Inst => {
    const inst = make(op)
    inst.regFile = File.XMM
    inst.rmFile = File.XMM
    inst.size = 16
    inst.sourceSize = element
    readModrm(cursor, prefixes, inst)
    inst.regIsDestination = regDest
    return inst
  }

  switch (opcode) {
    case 0x10:
    case 0x11: {
      const toReg = opcode === 0x10
      if (form === 'f2' || form === 'f3') {
        const inst = vector(X86.MOV_XMM_SCALAR, toReg, form === 'f2' ? 8 : 4)
        return inst
      }
      return vector(X86.MOV_XMM, toReg)
    }

    case 0x12:
    case 0x13:
    case 0x16:
    case 0x17: {
      // The same four opcodes mean two different things depending on
      // whether the r/m operand is memory: with memory they move a half
      // in or out, and with a register they move a half across.
      const high = opcode >= 0x16
      const toRegister = (opcode & 1) === 0
      const inst = vector(toRegister ? X86.MOV_HALF : X86.MOV_HALF, toRegister, 8)
      inst.cond = high ? 1 : 0
      if (inst.mem === null) {
        if (!toRegister) return bad(`0f ${opcode.toString(16)} with a register operand`)
        inst.op = X86.MOV_HALF_REG
      }
      return inst
    }

    case 0x28:
    case 0x29:
      if (form === 'f2' || form === 'f3') return bad(`0f ${opcode.toString(16)} with a repeat prefix`)
      return vector(X86.MOV_XMM, opcode === 0x28)

    case 0x2a: {
      if (form !== 'f2' && form !== 'f3') return fail('packed integer to floating point')
      const inst = make(X86.CVTSI2S)
      inst.regFile = File.XMM
      inst.rmFile = File.GPR
      inst.size = sseGeneralSize(prefixes)
      inst.sourceSize = form === 'f2' ? 8 : 4
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = true
      return inst
    }

    case 0x2c:
    case 0x2d: {
      if (form !== 'f2' && form !== 'f3') return fail('packed floating point to integer')
      const inst = make(X86.CVTTS2SI)
      inst.regFile = File.GPR
      inst.rmFile = File.XMM
      inst.size = sseGeneralSize(prefixes)
      inst.sourceSize = form === 'f2' ? 8 : 4
      inst.cond = opcode === 0x2c ? 1 : 0
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = true
      return inst
    }

    case 0x2e:
    case 0x2f: {
      const inst = vector(X86.UCOMIS, false, form === '66' ? 8 : 4)
      inst.regIsDestination = true
      return inst
    }

    case 0x51:
    case 0x58:
    case 0x59:
    case 0x5c:
    case 0x5e:
    case 0x5d:
    case 0x5f: {
      if (form !== 'f2' && form !== 'f3') return fail(`packed floating point ${opcode.toString(16)}`)
      const table: Record<number, X86Op> = {
        0x51: X86.SQRTSD, 0x58: X86.ADDSD, 0x59: X86.MULSD,
        0x5c: X86.SUBSD, 0x5e: X86.DIVSD, 0x5d: X86.MINSD, 0x5f: X86.MAXSD,
      }
      return vector(table[opcode]!, true, form === 'f2' ? 8 : 4)
    }

    case 0x54:
    case 0x55:
    case 0x56:
    case 0x57: {
      const table: Record<number, X86Op> = {
        0x54: X86.ANDP, 0x55: X86.ANDNP, 0x56: X86.ORP, 0x57: X86.XORP,
      }
      return vector(table[opcode]!, true)
    }

    case 0x5a: {
      if (form !== 'f2' && form !== 'f3') return fail('packed conversion between float widths')
      const inst = vector(X86.CVTS2S, true, form === 'f2' ? 8 : 4)
      return inst
    }

    case 0x6e: {
      // Moves a general register into the low lane and zeroes the rest.
      if (form !== '66') return fail('movd without the operand-size prefix')
      const inst = make(X86.MOVD)
      inst.regFile = File.XMM
      inst.rmFile = File.GPR
      inst.size = sseGeneralSize(prefixes)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = true
      return inst
    }

    case 0x7e: {
      if (form === 'f3') {
        // The other direction entirely: xmm to xmm, low 64 bits, zeroing.
        return vector(X86.MOVQ_XMM, true, 8)
      }
      if (form !== '66') return fail('0f 7e without a prefix')
      const inst = make(X86.MOVD)
      inst.regFile = File.XMM
      inst.rmFile = File.GPR
      inst.size = sseGeneralSize(prefixes)
      readModrm(cursor, prefixes, inst)
      inst.regIsDestination = false
      return inst
    }

    case 0xd6: {
      if (form !== '66') return fail('0f d6 without the operand-size prefix')
      return vector(X86.MOVQ_XMM, false, 8)
    }

    case 0x6f:
    case 0x7f: {
      if (form !== '66' && form !== 'f3') return fail('0f 6f without a prefix')
      return vector(X86.MOV_XMM, opcode === 0x6f)
    }

    case 0x60:
    case 0x61:
    case 0x62:
    case 0x6c: {
      if (form !== '66') return fail('packed unpack without the operand-size prefix')
      const element = opcode === 0x60 ? 1 : opcode === 0x61 ? 2 : opcode === 0x62 ? 4 : 8
      return vector(X86.PUNPCKL, true, element)
    }

    case 0x70: {
      if (form !== '66') return fail('shuffle without the operand-size prefix')
      const inst = vector(X86.PSHUFD, true, 4)
      inst.imm = cursor.unsigned(1)
      inst.hasImm = true
      return inst
    }

    case 0x64:
    case 0x65:
    case 0x66: {
      if (form !== '66') return fail('packed compare without the operand-size prefix')
      const element = opcode === 0x64 ? 1 : opcode === 0x65 ? 2 : 4
      return vector(X86.PCMPGT, true, element)
    }

    case 0x74:
    case 0x75:
    case 0x76: {
      if (form !== '66') return fail('packed compare without the operand-size prefix')
      const element = opcode === 0x74 ? 1 : opcode === 0x75 ? 2 : 4
      return vector(X86.PCMPEQ, true, element)
    }

    case 0xd4:
    case 0xfc:
    case 0xfd:
    case 0xfe: {
      if (form !== '66') return fail('packed add without the operand-size prefix')
      const element = opcode === 0xd4 ? 8 : opcode === 0xfc ? 1 : opcode === 0xfd ? 2 : 4
      return vector(X86.PADD, true, element)
    }

    case 0xf8:
    case 0xf9:
    case 0xfa:
    case 0xfb: {
      if (form !== '66') return fail('packed subtract without the operand-size prefix')
      const element = opcode === 0xf8 ? 1 : opcode === 0xf9 ? 2 : opcode === 0xfa ? 4 : 8
      return vector(X86.PSUB, true, element)
    }

    case 0xf4: {
      if (form !== '66') return fail('pmuludq without the operand-size prefix')
      return vector(X86.PMULUDQ, true, 4)
    }

    case 0xdb:
    case 0xeb:
    case 0xef: {
      if (form !== '66') return fail('packed logical without the operand-size prefix')
      const table: Record<number, X86Op> = {
        0xdb: X86.PAND, 0xeb: X86.POR, 0xef: X86.PXOR,
      }
      return vector(table[opcode]!, true)
    }

    default:
      void address
      return fail(`two-byte opcode 0f ${opcode.toString(16)}`)
  }
}
