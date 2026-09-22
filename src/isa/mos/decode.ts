/**
 * MOS 6502 decoder.
 *
 * The smallest instruction set in this project by a wide margin: one
 * byte of opcode, 151 documented instructions, thirteen addressing
 * modes, and a decoder that is a table rather than a cascade of guards.
 *
 * Two things about it are worth stating, because they are what a decoder
 * written from the obvious pattern gets wrong.
 *
 * **The opcode map has holes, and they are not spare.** The 105 unused
 * encodings do something on real silicon -- they are the "undocumented"
 * instructions, and they are undocumented because they fall out of the
 * decode logic rather than because they were designed. This decoder
 * refuses every one of them. That is a deliberate narrowing and it is
 * tested: an emulator that quietly implemented them would be claiming
 * behaviour this project has not verified.
 *
 * **The addressing mode is not a uniform field.** The regular pattern
 * that generates most of the map breaks for exactly the instructions
 * that matter most -- the stores, the branches, the stack operations --
 * so the table is written out rather than computed. A computed table
 * would be shorter and wrong in about a dozen places.
 */
import { IllegalInstruction, UnimplementedInstruction } from '../common/errors.ts'

export const ISA_NAME = 'mos'

export const MOS = {
  ILLEGAL: 0,

  // Loads and stores.
  LDA: 1,
  LDX: 2,
  LDY: 3,
  STA: 4,
  STX: 5,
  STY: 6,

  // Between registers.
  TAX: 7,
  TAY: 8,
  TXA: 9,
  TYA: 10,
  TSX: 11,
  TXS: 12,

  // The stack, which lives in page one and nowhere else.
  PHA: 13,
  PHP: 14,
  PLA: 15,
  PLP: 16,

  // Arithmetic and logic.
  ADC: 17,
  SBC: 18,
  AND: 19,
  ORA: 20,
  EOR: 21,
  CMP: 22,
  CPX: 23,
  CPY: 24,
  BIT: 25,
  INC: 26,
  DEC: 27,
  INX: 28,
  INY: 29,
  DEX: 30,
  DEY: 31,

  // Shifts, which have an accumulator form and a memory form.
  ASL: 32,
  LSR: 33,
  ROL: 34,
  ROR: 35,

  // Control.
  JMP: 36,
  JSR: 37,
  RTS: 38,
  RTI: 39,
  BRK: 40,
  BPL: 41,
  BMI: 42,
  BVC: 43,
  BVS: 44,
  BCC: 45,
  BCS: 46,
  BNE: 47,
  BEQ: 48,

  // The flag instructions, which are each one bit.
  CLC: 49,
  SEC: 50,
  CLI: 51,
  SEI: 52,
  CLD: 53,
  SED: 54,
  CLV: 55,

  NOP: 56,
} as const

export type MosOp = (typeof MOS)[keyof typeof MOS]

export const MOS_NAME: readonly string[] = (() => {
  const names: string[] = []
  for (const [key, value] of Object.entries(MOS)) names[value] = key.toLowerCase()
  return names
})()

/** How an instruction names the byte it works on. */
export const Mode = {
  /** No operand at all. */
  IMPLIED: 0,
  /** The accumulator is the operand. */
  ACCUMULATOR: 1,
  /** The byte after the opcode is the value. */
  IMMEDIATE: 2,
  /** One byte of address, so page zero only. */
  ZERO_PAGE: 3,
  ZERO_PAGE_X: 4,
  ZERO_PAGE_Y: 5,
  ABSOLUTE: 6,
  ABSOLUTE_X: 7,
  ABSOLUTE_Y: 8,
  /** Only `jmp` has this, and only `jmp` has its page-wrap defect. */
  INDIRECT: 9,
  /** (zp,X): the index is added before the indirection. */
  INDEXED_INDIRECT: 10,
  /** (zp),Y: the index is added after it. */
  INDIRECT_INDEXED: 11,
  /** A signed byte from the end of the instruction. */
  RELATIVE: 12,
} as const
export type AddressMode = (typeof Mode)[keyof typeof Mode]

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

export interface MosInst {
  op: MosOp
  mode: AddressMode
  /** Total encoded length: one, two or three bytes. */
  length: number
  /** The operand byte or word, before any indexing. */
  operand: number
  /** Absolute target of a branch or a direct jump. */
  target: number
  flow: FlowKind
  opcode: number
}

/** Bits of the processor status register. */
export const Flag = {
  C: 0x01,
  Z: 0x02,
  I: 0x04,
  D: 0x08,
  B: 0x10,
  /** Bit five is not a flag; it reads as one wherever it is observable. */
  UNUSED: 0x20,
  V: 0x40,
  N: 0x80,
} as const

interface Entry {
  op: MosOp
  mode: AddressMode
  flow?: FlowKind
}

const T = (op: MosOp, mode: AddressMode, flow?: FlowKind): Entry => ({ op, mode, flow })

/**
 * The opcode map, written out.
 *
 * Every entry not listed is one of the 105 encodings the architecture
 * does not define, and is refused.
 */
const TABLE: Readonly<Record<number, Entry>> = {
  0x00: T(MOS.BRK, Mode.IMPLIED, Flow.TRAP),
  0x01: T(MOS.ORA, Mode.INDEXED_INDIRECT),
  0x05: T(MOS.ORA, Mode.ZERO_PAGE),
  0x06: T(MOS.ASL, Mode.ZERO_PAGE),
  0x08: T(MOS.PHP, Mode.IMPLIED),
  0x09: T(MOS.ORA, Mode.IMMEDIATE),
  0x0a: T(MOS.ASL, Mode.ACCUMULATOR),
  0x0d: T(MOS.ORA, Mode.ABSOLUTE),
  0x0e: T(MOS.ASL, Mode.ABSOLUTE),
  0x10: T(MOS.BPL, Mode.RELATIVE, Flow.BRANCH),
  0x11: T(MOS.ORA, Mode.INDIRECT_INDEXED),
  0x15: T(MOS.ORA, Mode.ZERO_PAGE_X),
  0x16: T(MOS.ASL, Mode.ZERO_PAGE_X),
  0x18: T(MOS.CLC, Mode.IMPLIED),
  0x19: T(MOS.ORA, Mode.ABSOLUTE_Y),
  0x1d: T(MOS.ORA, Mode.ABSOLUTE_X),
  0x1e: T(MOS.ASL, Mode.ABSOLUTE_X),
  0x20: T(MOS.JSR, Mode.ABSOLUTE, Flow.CALL),
  0x21: T(MOS.AND, Mode.INDEXED_INDIRECT),
  0x24: T(MOS.BIT, Mode.ZERO_PAGE),
  0x25: T(MOS.AND, Mode.ZERO_PAGE),
  0x26: T(MOS.ROL, Mode.ZERO_PAGE),
  0x28: T(MOS.PLP, Mode.IMPLIED),
  0x29: T(MOS.AND, Mode.IMMEDIATE),
  0x2a: T(MOS.ROL, Mode.ACCUMULATOR),
  0x2c: T(MOS.BIT, Mode.ABSOLUTE),
  0x2d: T(MOS.AND, Mode.ABSOLUTE),
  0x2e: T(MOS.ROL, Mode.ABSOLUTE),
  0x30: T(MOS.BMI, Mode.RELATIVE, Flow.BRANCH),
  0x31: T(MOS.AND, Mode.INDIRECT_INDEXED),
  0x35: T(MOS.AND, Mode.ZERO_PAGE_X),
  0x36: T(MOS.ROL, Mode.ZERO_PAGE_X),
  0x38: T(MOS.SEC, Mode.IMPLIED),
  0x39: T(MOS.AND, Mode.ABSOLUTE_Y),
  0x3d: T(MOS.AND, Mode.ABSOLUTE_X),
  0x3e: T(MOS.ROL, Mode.ABSOLUTE_X),
  0x40: T(MOS.RTI, Mode.IMPLIED, Flow.RET),
  0x41: T(MOS.EOR, Mode.INDEXED_INDIRECT),
  0x45: T(MOS.EOR, Mode.ZERO_PAGE),
  0x46: T(MOS.LSR, Mode.ZERO_PAGE),
  0x48: T(MOS.PHA, Mode.IMPLIED),
  0x49: T(MOS.EOR, Mode.IMMEDIATE),
  0x4a: T(MOS.LSR, Mode.ACCUMULATOR),
  0x4c: T(MOS.JMP, Mode.ABSOLUTE, Flow.JUMP),
  0x4d: T(MOS.EOR, Mode.ABSOLUTE),
  0x4e: T(MOS.LSR, Mode.ABSOLUTE),
  0x50: T(MOS.BVC, Mode.RELATIVE, Flow.BRANCH),
  0x51: T(MOS.EOR, Mode.INDIRECT_INDEXED),
  0x55: T(MOS.EOR, Mode.ZERO_PAGE_X),
  0x56: T(MOS.LSR, Mode.ZERO_PAGE_X),
  0x58: T(MOS.CLI, Mode.IMPLIED),
  0x59: T(MOS.EOR, Mode.ABSOLUTE_Y),
  0x5d: T(MOS.EOR, Mode.ABSOLUTE_X),
  0x5e: T(MOS.LSR, Mode.ABSOLUTE_X),
  0x60: T(MOS.RTS, Mode.IMPLIED, Flow.RET),
  0x61: T(MOS.ADC, Mode.INDEXED_INDIRECT),
  0x65: T(MOS.ADC, Mode.ZERO_PAGE),
  0x66: T(MOS.ROR, Mode.ZERO_PAGE),
  0x68: T(MOS.PLA, Mode.IMPLIED),
  0x69: T(MOS.ADC, Mode.IMMEDIATE),
  0x6a: T(MOS.ROR, Mode.ACCUMULATOR),
  0x6c: T(MOS.JMP, Mode.INDIRECT, Flow.INDIRECT),
  0x6d: T(MOS.ADC, Mode.ABSOLUTE),
  0x6e: T(MOS.ROR, Mode.ABSOLUTE),
  0x70: T(MOS.BVS, Mode.RELATIVE, Flow.BRANCH),
  0x71: T(MOS.ADC, Mode.INDIRECT_INDEXED),
  0x75: T(MOS.ADC, Mode.ZERO_PAGE_X),
  0x76: T(MOS.ROR, Mode.ZERO_PAGE_X),
  0x78: T(MOS.SEI, Mode.IMPLIED),
  0x79: T(MOS.ADC, Mode.ABSOLUTE_Y),
  0x7d: T(MOS.ADC, Mode.ABSOLUTE_X),
  0x7e: T(MOS.ROR, Mode.ABSOLUTE_X),
  0x81: T(MOS.STA, Mode.INDEXED_INDIRECT),
  0x84: T(MOS.STY, Mode.ZERO_PAGE),
  0x85: T(MOS.STA, Mode.ZERO_PAGE),
  0x86: T(MOS.STX, Mode.ZERO_PAGE),
  0x88: T(MOS.DEY, Mode.IMPLIED),
  0x8a: T(MOS.TXA, Mode.IMPLIED),
  0x8c: T(MOS.STY, Mode.ABSOLUTE),
  0x8d: T(MOS.STA, Mode.ABSOLUTE),
  0x8e: T(MOS.STX, Mode.ABSOLUTE),
  0x90: T(MOS.BCC, Mode.RELATIVE, Flow.BRANCH),
  0x91: T(MOS.STA, Mode.INDIRECT_INDEXED),
  0x94: T(MOS.STY, Mode.ZERO_PAGE_X),
  0x95: T(MOS.STA, Mode.ZERO_PAGE_X),
  0x96: T(MOS.STX, Mode.ZERO_PAGE_Y),
  0x98: T(MOS.TYA, Mode.IMPLIED),
  0x99: T(MOS.STA, Mode.ABSOLUTE_Y),
  0x9a: T(MOS.TXS, Mode.IMPLIED),
  0x9d: T(MOS.STA, Mode.ABSOLUTE_X),
  0xa0: T(MOS.LDY, Mode.IMMEDIATE),
  0xa1: T(MOS.LDA, Mode.INDEXED_INDIRECT),
  0xa2: T(MOS.LDX, Mode.IMMEDIATE),
  0xa4: T(MOS.LDY, Mode.ZERO_PAGE),
  0xa5: T(MOS.LDA, Mode.ZERO_PAGE),
  0xa6: T(MOS.LDX, Mode.ZERO_PAGE),
  0xa8: T(MOS.TAY, Mode.IMPLIED),
  0xa9: T(MOS.LDA, Mode.IMMEDIATE),
  0xaa: T(MOS.TAX, Mode.IMPLIED),
  0xac: T(MOS.LDY, Mode.ABSOLUTE),
  0xad: T(MOS.LDA, Mode.ABSOLUTE),
  0xae: T(MOS.LDX, Mode.ABSOLUTE),
  0xb0: T(MOS.BCS, Mode.RELATIVE, Flow.BRANCH),
  0xb1: T(MOS.LDA, Mode.INDIRECT_INDEXED),
  0xb4: T(MOS.LDY, Mode.ZERO_PAGE_X),
  0xb5: T(MOS.LDA, Mode.ZERO_PAGE_X),
  0xb6: T(MOS.LDX, Mode.ZERO_PAGE_Y),
  0xb8: T(MOS.CLV, Mode.IMPLIED),
  0xb9: T(MOS.LDA, Mode.ABSOLUTE_Y),
  0xba: T(MOS.TSX, Mode.IMPLIED),
  0xbc: T(MOS.LDY, Mode.ABSOLUTE_X),
  0xbd: T(MOS.LDA, Mode.ABSOLUTE_X),
  0xbe: T(MOS.LDX, Mode.ABSOLUTE_Y),
  0xc0: T(MOS.CPY, Mode.IMMEDIATE),
  0xc1: T(MOS.CMP, Mode.INDEXED_INDIRECT),
  0xc4: T(MOS.CPY, Mode.ZERO_PAGE),
  0xc5: T(MOS.CMP, Mode.ZERO_PAGE),
  0xc6: T(MOS.DEC, Mode.ZERO_PAGE),
  0xc8: T(MOS.INY, Mode.IMPLIED),
  0xc9: T(MOS.CMP, Mode.IMMEDIATE),
  0xca: T(MOS.DEX, Mode.IMPLIED),
  0xcc: T(MOS.CPY, Mode.ABSOLUTE),
  0xcd: T(MOS.CMP, Mode.ABSOLUTE),
  0xce: T(MOS.DEC, Mode.ABSOLUTE),
  0xd0: T(MOS.BNE, Mode.RELATIVE, Flow.BRANCH),
  0xd1: T(MOS.CMP, Mode.INDIRECT_INDEXED),
  0xd5: T(MOS.CMP, Mode.ZERO_PAGE_X),
  0xd6: T(MOS.DEC, Mode.ZERO_PAGE_X),
  0xd8: T(MOS.CLD, Mode.IMPLIED),
  0xd9: T(MOS.CMP, Mode.ABSOLUTE_Y),
  0xdd: T(MOS.CMP, Mode.ABSOLUTE_X),
  0xde: T(MOS.DEC, Mode.ABSOLUTE_X),
  0xe0: T(MOS.CPX, Mode.IMMEDIATE),
  0xe1: T(MOS.SBC, Mode.INDEXED_INDIRECT),
  0xe4: T(MOS.CPX, Mode.ZERO_PAGE),
  0xe5: T(MOS.SBC, Mode.ZERO_PAGE),
  0xe6: T(MOS.INC, Mode.ZERO_PAGE),
  0xe8: T(MOS.INX, Mode.IMPLIED),
  0xe9: T(MOS.SBC, Mode.IMMEDIATE),
  0xea: T(MOS.NOP, Mode.IMPLIED),
  0xec: T(MOS.CPX, Mode.ABSOLUTE),
  0xed: T(MOS.SBC, Mode.ABSOLUTE),
  0xee: T(MOS.INC, Mode.ABSOLUTE),
  0xf0: T(MOS.BEQ, Mode.RELATIVE, Flow.BRANCH),
  0xf1: T(MOS.SBC, Mode.INDIRECT_INDEXED),
  0xf5: T(MOS.SBC, Mode.ZERO_PAGE_X),
  0xf6: T(MOS.INC, Mode.ZERO_PAGE_X),
  0xf8: T(MOS.SED, Mode.IMPLIED),
  0xf9: T(MOS.SBC, Mode.ABSOLUTE_Y),
  0xfd: T(MOS.SBC, Mode.ABSOLUTE_X),
  0xfe: T(MOS.INC, Mode.ABSOLUTE_X),
}

/** How many bytes each addressing mode takes, opcode included. */
const LENGTH: Readonly<Record<number, number>> = {
  [Mode.IMPLIED]: 1,
  [Mode.ACCUMULATOR]: 1,
  [Mode.IMMEDIATE]: 2,
  [Mode.ZERO_PAGE]: 2,
  [Mode.ZERO_PAGE_X]: 2,
  [Mode.ZERO_PAGE_Y]: 2,
  [Mode.RELATIVE]: 2,
  [Mode.INDEXED_INDIRECT]: 2,
  [Mode.INDIRECT_INDEXED]: 2,
  [Mode.ABSOLUTE]: 3,
  [Mode.ABSOLUTE_X]: 3,
  [Mode.ABSOLUTE_Y]: 3,
  [Mode.INDIRECT]: 3,
}

/** Every opcode the architecture defines, for tests that need the list. */
export const DOCUMENTED_OPCODES: readonly number[] =
  Object.keys(TABLE).map(Number).sort((a, b) => a - b)

export function decode(
  read: (offset: number) => number,
  address: bigint,
): MosInst {
  const opcode = read(0) & 0xff
  const entry = TABLE[opcode]
  if (entry === undefined) {
    // One of the 105 encodings the architecture does not define. Real
    // silicon does something for each of them; this refuses rather than
    // claiming behaviour nothing here has verified.
    throw new UnimplementedInstruction(
      ISA_NAME, address, Uint8Array.from([opcode]),
      `undocumented opcode ${opcode.toString(16).padStart(2, '0')}`,
    )
  }

  const length = LENGTH[entry.mode]!
  let operand = 0
  if (length === 2) operand = read(1) & 0xff
  else if (length === 3) operand = (read(1) & 0xff) | ((read(2) & 0xff) << 8)

  const inst: MosInst = {
    op: entry.op,
    mode: entry.mode,
    length,
    operand,
    target: 0,
    flow: entry.flow ?? Flow.SEQ,
    opcode,
  }

  const here = Number(address & 0xffffn)
  if (entry.mode === Mode.RELATIVE) {
    // The displacement counts from the end of the instruction, and the
    // result wraps within the sixteen-bit address space.
    inst.target = (here + 2 + ((operand << 24) >> 24)) & 0xffff
  } else if (entry.mode === Mode.ABSOLUTE &&
      (entry.op === MOS.JMP || entry.op === MOS.JSR)) {
    inst.target = operand
  }
  return inst
}

/** Raised for a byte that cannot begin an instruction at all. */
export function illegal(address: bigint, opcode: number): never {
  throw new IllegalInstruction(
    ISA_NAME, address, Uint8Array.from([opcode]), 'not an instruction',
  )
}
