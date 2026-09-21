/**
 * RV64GC decoder.
 *
 * Decodes the bytes of `.text`, not the text of a disassembler. Objdump output
 * canonicalises pseudo-instructions (`li`, `mv`, `ret`, `j`, `seqz`), loses the
 * raw operand encoding, and would put a subprocess in the middle of the
 * interpreter. The real encoding is both smaller to handle and independently
 * checkable: the fixtures carry objdump's opinion of the same bytes, and the
 * decoder is tested against it.
 *
 * Compressed instructions are expanded to their 32-bit equivalents rather than
 * given their own semantics. That is how the C extension is specified — every
 * compressed instruction *is* a 32-bit instruction with a shorter encoding — so
 * expansion halves the semantic surface and leaves one place where, say, `addi`
 * can be wrong. Only `len` remembers that the original was two bytes, which is
 * what the timing model needs.
 *
 * Nothing falls through. An encoding this decoder does not implement raises
 * UnimplementedInstruction; a bit pattern that is not an instruction at all
 * raises IllegalInstruction.
 */
import { IllegalInstruction, UnimplementedInstruction } from '../common/errors.ts'

export const ISA_NAME = 'rv64'

/**
 * Canonical operations. Numeric so the interpreter's dispatch is a jump table
 * rather than a string comparison; the names live in `RV_NAME` alongside.
 */
export const Rv = {
  ILLEGAL: 0,

  LUI: 1,
  AUIPC: 2,
  JAL: 3,
  JALR: 4,

  BEQ: 5,
  BNE: 6,
  BLT: 7,
  BGE: 8,
  BLTU: 9,
  BGEU: 10,

  LB: 11,
  LH: 12,
  LW: 13,
  LBU: 14,
  LHU: 15,
  LWU: 16,
  LD: 17,
  SB: 18,
  SH: 19,
  SW: 20,
  SD: 21,

  ADDI: 22,
  SLTI: 23,
  SLTIU: 24,
  XORI: 25,
  ORI: 26,
  ANDI: 27,
  SLLI: 28,
  SRLI: 29,
  SRAI: 30,

  ADD: 31,
  SUB: 32,
  SLL: 33,
  SLT: 34,
  SLTU: 35,
  XOR: 36,
  SRL: 37,
  SRA: 38,
  OR: 39,
  AND: 40,

  ADDIW: 41,
  SLLIW: 42,
  SRLIW: 43,
  SRAIW: 44,
  ADDW: 45,
  SUBW: 46,
  SLLW: 47,
  SRLW: 48,
  SRAW: 49,

  FENCE: 50,
  ECALL: 51,
  EBREAK: 52,

  MUL: 53,
  MULH: 54,
  MULHSU: 55,
  MULHU: 56,
  DIV: 57,
  DIVU: 58,
  REM: 59,
  REMU: 60,
  MULW: 61,
  DIVW: 62,
  DIVUW: 63,
  REMW: 64,
  REMUW: 65,

  CSRRW: 66,
  CSRRS: 67,
  CSRRC: 68,
  CSRRWI: 69,
  CSRRSI: 70,
  CSRRCI: 71,

  FLW: 72,
  FLD: 73,
  FSW: 74,
  FSD: 75,

  FADD_S: 76,
  FSUB_S: 77,
  FMUL_S: 78,
  FDIV_S: 79,
  FSQRT_S: 80,
  FSGNJ_S: 81,
  FSGNJN_S: 82,
  FSGNJX_S: 83,
  FMIN_S: 84,
  FMAX_S: 85,
  FEQ_S: 86,
  FLT_S: 87,
  FLE_S: 88,
  FCLASS_S: 89,
  FMV_X_W: 90,
  FMV_W_X: 91,

  FADD_D: 92,
  FSUB_D: 93,
  FMUL_D: 94,
  FDIV_D: 95,
  FSQRT_D: 96,
  FSGNJ_D: 97,
  FSGNJN_D: 98,
  FSGNJX_D: 99,
  FMIN_D: 100,
  FMAX_D: 101,
  FEQ_D: 102,
  FLT_D: 103,
  FLE_D: 104,
  FCLASS_D: 105,
  FMV_X_D: 106,
  FMV_D_X: 107,

  FCVT_S_D: 108,
  FCVT_D_S: 109,

  FCVT_W_S: 110,
  FCVT_WU_S: 111,
  FCVT_L_S: 112,
  FCVT_LU_S: 113,
  FCVT_S_W: 114,
  FCVT_S_WU: 115,
  FCVT_S_L: 116,
  FCVT_S_LU: 117,

  FCVT_W_D: 118,
  FCVT_WU_D: 119,
  FCVT_L_D: 120,
  FCVT_LU_D: 121,
  FCVT_D_W: 122,
  FCVT_D_WU: 123,
  FCVT_D_L: 124,
  FCVT_D_LU: 125,

  FMADD_S: 126,
  FMSUB_S: 127,
  FNMSUB_S: 128,
  FNMADD_S: 129,
  FMADD_D: 130,
  FMSUB_D: 131,
  FNMSUB_D: 132,
  FNMADD_D: 133,
} as const

export type RvOp = (typeof Rv)[keyof typeof Rv]

/** Canonical assembler spelling, indexed by opcode. Diagnostics only. */
export const RV_NAME: readonly string[] = (() => {
  const names: string[] = []
  for (const [key, value] of Object.entries(Rv)) {
    names[value] = key.toLowerCase().replace(/_/g, '.')
  }
  return names
})()

/** How an instruction reaches its successor. The timing model keys on this. */
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

export interface RvInst {
  op: RvOp
  /** Integer or float destination, depending on the operation. -1 when none. */
  rd: number
  rs1: number
  rs2: number
  /** Third source, fused multiply-add only. */
  rs3: number
  /** Already sign-extended and scaled per the instruction format. */
  imm: bigint
  /** Rounding-mode field; 7 means "use the dynamic mode in fcsr". */
  rm: number
  csr: number
  len: 2 | 4
  /** The encoding as fetched, for diagnostics and for the decoder round-trip. */
  raw: number
  flow: FlowKind
}

const NONE = -1

function make(op: RvOp, len: 2 | 4, raw: number, flow: FlowKind = Flow.SEQ): RvInst {
  return { op, rd: NONE, rs1: NONE, rs2: NONE, rs3: NONE, imm: 0n, rm: 0, csr: 0, len, raw, flow }
}

// ---------------------------------------------------------------------------
// Field extraction. `word` is an unsigned 32-bit value held in a JS number.
// ---------------------------------------------------------------------------

const bits = (word: number, hi: number, lo: number): number =>
  (word >>> lo) & ((1 << (hi - lo + 1)) - 1)

/** Sign-extend an `n`-bit value held in a JS number. */
const sextN = (value: number, n: number): number => (value << (32 - n)) >> (32 - n)

const immI = (word: number): number => sextN(bits(word, 31, 20), 12)

const immS = (word: number): number => sextN((bits(word, 31, 25) << 5) | bits(word, 11, 7), 12)

const immB = (word: number): number =>
  sextN(
    (bits(word, 31, 31) << 12) |
    (bits(word, 7, 7) << 11) |
    (bits(word, 30, 25) << 5) |
    (bits(word, 11, 8) << 1),
    13,
  )

/** U-type keeps its 20 bits in place; the low 12 are zero. */
const immU = (word: number): number => (word & 0xfffff000) | 0

const immJ = (word: number): number =>
  sextN(
    (bits(word, 31, 31) << 20) |
    (bits(word, 19, 12) << 12) |
    (bits(word, 20, 20) << 11) |
    (bits(word, 30, 21) << 1),
    21,
  )

// ---------------------------------------------------------------------------
// Encoders, used to expand compressed instructions into the 32-bit forms.
// ---------------------------------------------------------------------------

const encodeR = (opcode: number, rd: number, funct3: number, rs1: number, rs2: number, funct7: number): number =>
  ((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0

const encodeI = (opcode: number, rd: number, funct3: number, rs1: number, imm: number): number =>
  (((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0

const encodeS = (opcode: number, funct3: number, rs1: number, rs2: number, imm: number): number =>
  ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) |
    ((imm & 0x1f) << 7) | opcode) >>> 0

const encodeB = (opcode: number, funct3: number, rs1: number, rs2: number, imm: number): number =>
  ((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) |
    (funct3 << 12) | (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | opcode) >>> 0

const encodeU = (opcode: number, rd: number, imm20: number): number =>
  (((imm20 & 0xfffff) << 12) | (rd << 7) | opcode) >>> 0

const encodeJ = (opcode: number, rd: number, imm: number): number =>
  ((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) |
    (((imm >> 12) & 0xff) << 12) | (rd << 7) | opcode) >>> 0

const OP_LOAD = 0x03
const OP_LOAD_FP = 0x07
const OP_IMM = 0x13
const OP_AUIPC = 0x17
const OP_IMM_32 = 0x1b
const OP_STORE = 0x23
const OP_STORE_FP = 0x27
const OP_OP = 0x33
const OP_LUI = 0x37
const OP_OP_32 = 0x3b
const OP_MADD = 0x43
const OP_MSUB = 0x47
const OP_NMSUB = 0x4b
const OP_NMADD = 0x4f
const OP_FP = 0x53
const OP_BRANCH = 0x63
const OP_JALR = 0x67
const OP_JAL = 0x6f
const OP_SYSTEM = 0x73
const OP_MISC_MEM = 0x0f
const OP_AMO = 0x2f

/**
 * Expands one 16-bit compressed instruction into the 32-bit instruction it is
 * defined to be equivalent to. Reserved and hint-only encodings raise rather
 * than expanding into something plausible.
 */
export function decompress(half: number, address: bigint): number {
  const raw = () => Uint8Array.from([half & 0xff, (half >> 8) & 0xff])
  const illegal = (why: string): never => {
    throw new IllegalInstruction(ISA_NAME, address, raw(), why)
  }
  const quadrant = half & 3
  const funct3 = bits(half, 15, 13)
  // Three-bit register fields name x8..x15.
  const rdShort = 8 + bits(half, 4, 2)
  const rs1Short = 8 + bits(half, 9, 7)
  const rdFull = bits(half, 11, 7)
  const rs2Full = bits(half, 6, 2)

  if (quadrant === 0) {
    switch (funct3) {
      case 0: {
        const nzuimm =
          (bits(half, 10, 7) << 6) | (bits(half, 12, 11) << 4) |
          (bits(half, 5, 5) << 3) | (bits(half, 6, 6) << 2)
        if (nzuimm === 0) return illegal('c.addi4spn with zero immediate is reserved')
        return encodeI(OP_IMM, rdShort, 0, 2, nzuimm)
      }
      case 1: {
        const off = (bits(half, 6, 5) << 6) | (bits(half, 12, 10) << 3)
        return encodeI(OP_LOAD_FP, rdShort, 3, rs1Short, off)
      }
      case 2: {
        const off = (bits(half, 5, 5) << 6) | (bits(half, 12, 10) << 3) | (bits(half, 6, 6) << 2)
        return encodeI(OP_LOAD, rdShort, 2, rs1Short, off)
      }
      case 3: {
        const off = (bits(half, 6, 5) << 6) | (bits(half, 12, 10) << 3)
        return encodeI(OP_LOAD, rdShort, 3, rs1Short, off)
      }
      case 5: {
        const off = (bits(half, 6, 5) << 6) | (bits(half, 12, 10) << 3)
        return encodeS(OP_STORE_FP, 3, rs1Short, rdShort, off)
      }
      case 6: {
        const off = (bits(half, 5, 5) << 6) | (bits(half, 12, 10) << 3) | (bits(half, 6, 6) << 2)
        return encodeS(OP_STORE, 2, rs1Short, rdShort, off)
      }
      case 7: {
        const off = (bits(half, 6, 5) << 6) | (bits(half, 12, 10) << 3)
        return encodeS(OP_STORE, 3, rs1Short, rdShort, off)
      }
      default:
        return illegal('reserved encoding in compressed quadrant 0')
    }
  }

  if (quadrant === 1) {
    switch (funct3) {
      case 0: {
        // c.nop when rd is zero, c.addi otherwise; both are addi rd, rd, imm.
        const imm = sextN((bits(half, 12, 12) << 5) | rs2Full, 6)
        return encodeI(OP_IMM, rdFull, 0, rdFull, imm)
      }
      case 1: {
        const imm = sextN((bits(half, 12, 12) << 5) | rs2Full, 6)
        if (rdFull === 0) return illegal('c.addiw with rd = x0 is reserved')
        return encodeI(OP_IMM_32, rdFull, 0, rdFull, imm)
      }
      case 2: {
        const imm = sextN((bits(half, 12, 12) << 5) | rs2Full, 6)
        return encodeI(OP_IMM, rdFull, 0, 0, imm)
      }
      case 3: {
        if (rdFull === 2) {
          const imm =
            sextN(
              (bits(half, 12, 12) << 9) | (bits(half, 4, 3) << 7) | (bits(half, 5, 5) << 6) |
              (bits(half, 2, 2) << 5) | (bits(half, 6, 6) << 4),
              10,
            )
          if (imm === 0) return illegal('c.addi16sp with zero immediate is reserved')
          return encodeI(OP_IMM, 2, 0, 2, imm)
        }
        const imm6 = sextN((bits(half, 12, 12) << 5) | rs2Full, 6)
        if (imm6 === 0) return illegal('c.lui with zero immediate is reserved')
        return encodeU(OP_LUI, rdFull, imm6)
      }
      case 4: {
        const funct2 = bits(half, 11, 10)
        const shamt = (bits(half, 12, 12) << 5) | rs2Full
        if (funct2 === 0) return encodeI(OP_IMM, rs1Short, 5, rs1Short, shamt)
        if (funct2 === 1) return encodeI(OP_IMM, rs1Short, 5, rs1Short, shamt | 0x400)
        if (funct2 === 2) {
          const imm = sextN(shamt, 6)
          return encodeI(OP_IMM, rs1Short, 7, rs1Short, imm)
        }
        const rs2Short = 8 + bits(half, 4, 2)
        const kind = bits(half, 6, 5)
        if (bits(half, 12, 12) === 0) {
          switch (kind) {
            case 0: return encodeR(OP_OP, rs1Short, 0, rs1Short, rs2Short, 0x20)
            case 1: return encodeR(OP_OP, rs1Short, 4, rs1Short, rs2Short, 0)
            case 2: return encodeR(OP_OP, rs1Short, 6, rs1Short, rs2Short, 0)
            default: return encodeR(OP_OP, rs1Short, 7, rs1Short, rs2Short, 0)
          }
        }
        if (kind === 0) return encodeR(OP_OP_32, rs1Short, 0, rs1Short, rs2Short, 0x20)
        if (kind === 1) return encodeR(OP_OP_32, rs1Short, 0, rs1Short, rs2Short, 0)
        return illegal('reserved c.alu encoding')
      }
      case 5: {
        const imm = sextN(
          (bits(half, 12, 12) << 11) | (bits(half, 8, 8) << 10) | (bits(half, 10, 9) << 8) |
          (bits(half, 6, 6) << 7) | (bits(half, 7, 7) << 6) | (bits(half, 2, 2) << 5) |
          (bits(half, 11, 11) << 4) | (bits(half, 5, 3) << 1),
          12,
        )
        return encodeJ(OP_JAL, 0, imm)
      }
      case 6:
      case 7: {
        const imm = sextN(
          (bits(half, 12, 12) << 8) | (bits(half, 6, 5) << 6) | (bits(half, 2, 2) << 5) |
          (bits(half, 11, 10) << 3) | (bits(half, 4, 3) << 1),
          9,
        )
        return encodeB(OP_BRANCH, funct3 === 6 ? 0 : 1, rs1Short, 0, imm)
      }
      default:
        return illegal('reserved encoding in compressed quadrant 1')
    }
  }

  // Quadrant 2.
  switch (funct3) {
    case 0: {
      const shamt = (bits(half, 12, 12) << 5) | rs2Full
      return encodeI(OP_IMM, rdFull, 1, rdFull, shamt)
    }
    case 1: {
      const off = (bits(half, 4, 2) << 6) | (bits(half, 12, 12) << 5) | (bits(half, 6, 5) << 3)
      return encodeI(OP_LOAD_FP, rdFull, 3, 2, off)
    }
    case 2: {
      if (rdFull === 0) return illegal('c.lwsp with rd = x0 is reserved')
      const off = (bits(half, 3, 2) << 6) | (bits(half, 12, 12) << 5) | (bits(half, 6, 4) << 2)
      return encodeI(OP_LOAD, rdFull, 2, 2, off)
    }
    case 3: {
      if (rdFull === 0) return illegal('c.ldsp with rd = x0 is reserved')
      const off = (bits(half, 4, 2) << 6) | (bits(half, 12, 12) << 5) | (bits(half, 6, 5) << 3)
      return encodeI(OP_LOAD, rdFull, 3, 2, off)
    }
    case 4: {
      if (bits(half, 12, 12) === 0) {
        if (rs2Full === 0) {
          if (rdFull === 0) return illegal('c.jr with rs1 = x0 is reserved')
          return encodeI(OP_JALR, 0, 0, rdFull, 0)
        }
        return encodeR(OP_OP, rdFull, 0, 0, rs2Full, 0)
      }
      if (rs2Full === 0) {
        if (rdFull === 0) return encodeI(OP_SYSTEM, 0, 0, 0, 1)
        return encodeI(OP_JALR, 1, 0, rdFull, 0)
      }
      return encodeR(OP_OP, rdFull, 0, rdFull, rs2Full, 0)
    }
    case 5: {
      const off = (bits(half, 9, 7) << 6) | (bits(half, 12, 10) << 3)
      return encodeS(OP_STORE_FP, 3, 2, rs2Full, off)
    }
    case 6: {
      const off = (bits(half, 8, 7) << 6) | (bits(half, 12, 9) << 2)
      return encodeS(OP_STORE, 2, 2, rs2Full, off)
    }
    case 7: {
      const off = (bits(half, 9, 7) << 6) | (bits(half, 12, 10) << 3)
      return encodeS(OP_STORE, 3, 2, rs2Full, off)
    }
    default:
      return illegal('reserved encoding in compressed quadrant 2')
  }
}

/** True when the halfword begins a 4-byte instruction rather than a 2-byte one. */
export function isFullLength(half: number): boolean {
  return (half & 3) === 3
}

function rawBytes(word: number, len: 2 | 4): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = (word >>> (8 * i)) & 0xff
  return out
}

const LOAD_OPS: readonly RvOp[] = [Rv.LB, Rv.LH, Rv.LW, Rv.LD, Rv.LBU, Rv.LHU, Rv.LWU, Rv.ILLEGAL]
const STORE_OPS: readonly RvOp[] = [Rv.SB, Rv.SH, Rv.SW, Rv.SD]
const BRANCH_OPS: readonly RvOp[] = [
  Rv.BEQ, Rv.BNE, Rv.ILLEGAL, Rv.ILLEGAL, Rv.BLT, Rv.BGE, Rv.BLTU, Rv.BGEU,
]
const OP_IMM_OPS: readonly RvOp[] = [
  Rv.ADDI, Rv.SLLI, Rv.SLTI, Rv.SLTIU, Rv.XORI, Rv.SRLI, Rv.ORI, Rv.ANDI,
]
const CSR_OPS: readonly RvOp[] = [
  Rv.ILLEGAL, Rv.CSRRW, Rv.CSRRS, Rv.CSRRC, Rv.ILLEGAL, Rv.CSRRWI, Rv.CSRRSI, Rv.CSRRCI,
]

/**
 * Decodes one instruction. `len` says how many bytes the encoding occupied,
 * which for an expanded compressed instruction is 2 even though `word` is the
 * 32-bit equivalent. `address` appears only in diagnostics.
 */
export function decode32(word: number, len: 2 | 4, address: bigint): RvInst {
  const unsupported = (detail: string): never => {
    throw new UnimplementedInstruction(ISA_NAME, address, rawBytes(word, len), detail)
  }
  const bad = (detail: string): never => {
    throw new IllegalInstruction(ISA_NAME, address, rawBytes(word, len), detail)
  }

  const opcode = word & 0x7f
  const rd = bits(word, 11, 7)
  const rs1 = bits(word, 19, 15)
  const rs2 = bits(word, 24, 20)
  const funct3 = bits(word, 14, 12)
  const funct7 = bits(word, 31, 25)

  switch (opcode) {
    case OP_LUI: {
      const inst = make(Rv.LUI, len, word)
      inst.rd = rd
      inst.imm = BigInt(immU(word))
      return inst
    }
    case OP_AUIPC: {
      const inst = make(Rv.AUIPC, len, word)
      inst.rd = rd
      inst.imm = BigInt(immU(word))
      return inst
    }
    case OP_JAL: {
      // A jump that saves a return address is a call; one that does not is a
      // plain jump. The timing model's return-address stack depends on the
      // distinction, and it is visible right here in rd.
      const inst = make(Rv.JAL, len, word, rd === 0 ? Flow.JUMP : Flow.CALL)
      inst.rd = rd
      inst.imm = BigInt(immJ(word))
      return inst
    }
    case OP_JALR: {
      if (funct3 !== 0) return bad('jalr with a non-zero funct3')
      // `ret` is jalr x0, 0(ra): an indirect jump through the link register.
      const isReturn = rd === 0 && rs1 === 1 && immI(word) === 0
      const inst = make(
        Rv.JALR,
        len,
        word,
        isReturn ? Flow.RET : rd === 0 ? Flow.INDIRECT : Flow.CALL,
      )
      inst.rd = rd
      inst.rs1 = rs1
      inst.imm = BigInt(immI(word))
      return inst
    }
    case OP_BRANCH: {
      const op = BRANCH_OPS[funct3]!
      if (op === Rv.ILLEGAL) return bad(`branch with reserved funct3 ${funct3}`)
      const inst = make(op, len, word, Flow.BRANCH)
      inst.rs1 = rs1
      inst.rs2 = rs2
      inst.imm = BigInt(immB(word))
      return inst
    }
    case OP_LOAD: {
      const op = LOAD_OPS[funct3]!
      if (op === Rv.ILLEGAL) return bad(`load with reserved funct3 ${funct3}`)
      const inst = make(op, len, word)
      inst.rd = rd
      inst.rs1 = rs1
      inst.imm = BigInt(immI(word))
      return inst
    }
    case OP_STORE: {
      if (funct3 > 3) return bad(`store with reserved funct3 ${funct3}`)
      const inst = make(STORE_OPS[funct3]!, len, word)
      inst.rs1 = rs1
      inst.rs2 = rs2
      inst.imm = BigInt(immS(word))
      return inst
    }
    case OP_IMM: {
      if (funct3 === 1) {
        // RV64 takes a 6-bit shift amount; bit 25 belongs to it, not to funct7.
        if (bits(word, 31, 26) !== 0) return bad('slli with reserved high bits')
        const inst = make(Rv.SLLI, len, word)
        inst.rd = rd
        inst.rs1 = rs1
        inst.imm = BigInt(bits(word, 25, 20))
        return inst
      }
      if (funct3 === 5) {
        const top = bits(word, 31, 26)
        if (top !== 0 && top !== 0x10) return bad('srli/srai with reserved high bits')
        const inst = make(top === 0x10 ? Rv.SRAI : Rv.SRLI, len, word)
        inst.rd = rd
        inst.rs1 = rs1
        inst.imm = BigInt(bits(word, 25, 20))
        return inst
      }
      const inst = make(OP_IMM_OPS[funct3]!, len, word)
      inst.rd = rd
      inst.rs1 = rs1
      inst.imm = BigInt(immI(word))
      return inst
    }
    case OP_IMM_32: {
      let op: RvOp
      if (funct3 === 0) op = Rv.ADDIW
      else if (funct3 === 1) {
        if (funct7 !== 0) return bad('slliw with reserved funct7')
        op = Rv.SLLIW
      } else if (funct3 === 5) {
        if (funct7 !== 0 && funct7 !== 0x20) return bad('srliw/sraiw with reserved funct7')
        op = funct7 === 0x20 ? Rv.SRAIW : Rv.SRLIW
      } else return bad(`op-imm-32 with reserved funct3 ${funct3}`)
      const inst = make(op, len, word)
      inst.rd = rd
      inst.rs1 = rs1
      inst.imm = op === Rv.ADDIW ? BigInt(immI(word)) : BigInt(bits(word, 24, 20))
      return inst
    }
    case OP_OP: {
      let op: RvOp
      if (funct7 === 1) {
        op = [Rv.MUL, Rv.MULH, Rv.MULHSU, Rv.MULHU, Rv.DIV, Rv.DIVU, Rv.REM, Rv.REMU][funct3]!
      } else if (funct7 === 0) {
        op = [Rv.ADD, Rv.SLL, Rv.SLT, Rv.SLTU, Rv.XOR, Rv.SRL, Rv.OR, Rv.AND][funct3]!
      } else if (funct7 === 0x20 && (funct3 === 0 || funct3 === 5)) {
        op = funct3 === 0 ? Rv.SUB : Rv.SRA
      } else {
        return unsupported(`op with funct7 ${funct7}, funct3 ${funct3}`)
      }
      const inst = make(op, len, word)
      inst.rd = rd
      inst.rs1 = rs1
      inst.rs2 = rs2
      return inst
    }
    case OP_OP_32: {
      let op: RvOp
      if (funct7 === 1) {
        const table: readonly RvOp[] = [
          Rv.MULW, Rv.ILLEGAL, Rv.ILLEGAL, Rv.ILLEGAL, Rv.DIVW, Rv.DIVUW, Rv.REMW, Rv.REMUW,
        ]
        op = table[funct3]!
        if (op === Rv.ILLEGAL) return bad(`op-32 mul/div with reserved funct3 ${funct3}`)
      } else if (funct7 === 0 && (funct3 === 0 || funct3 === 1 || funct3 === 5)) {
        op = funct3 === 0 ? Rv.ADDW : funct3 === 1 ? Rv.SLLW : Rv.SRLW
      } else if (funct7 === 0x20 && (funct3 === 0 || funct3 === 5)) {
        op = funct3 === 0 ? Rv.SUBW : Rv.SRAW
      } else {
        return unsupported(`op-32 with funct7 ${funct7}, funct3 ${funct3}`)
      }
      const inst = make(op, len, word)
      inst.rd = rd
      inst.rs1 = rs1
      inst.rs2 = rs2
      return inst
    }
    case OP_MISC_MEM: {
      if (funct3 === 0) return make(Rv.FENCE, len, word)
      if (funct3 === 1) return unsupported('fence.i: instruction-cache flush is out of scope')
      return bad(`misc-mem with reserved funct3 ${funct3}`)
    }
    case OP_SYSTEM: {
      if (funct3 === 0) {
        const imm = bits(word, 31, 20)
        if (imm === 0) return make(Rv.ECALL, len, word, Flow.TRAP)
        if (imm === 1) return make(Rv.EBREAK, len, word, Flow.TRAP)
        return unsupported(`privileged system instruction, funct12 ${imm}`)
      }
      const op = CSR_OPS[funct3]!
      if (op === Rv.ILLEGAL) return bad(`system with reserved funct3 ${funct3}`)
      const inst = make(op, len, word)
      inst.rd = rd
      inst.csr = bits(word, 31, 20)
      // The immediate forms put a 5-bit unsigned value where rs1 would be.
      if (op === Rv.CSRRWI || op === Rv.CSRRSI || op === Rv.CSRRCI) inst.imm = BigInt(rs1)
      else inst.rs1 = rs1
      return inst
    }
    case OP_AMO:
      return unsupported('atomic memory operation: the A extension is not implemented')
    case OP_LOAD_FP: {
      if (funct3 !== 2 && funct3 !== 3) return unsupported(`fp load with width funct3 ${funct3}`)
      const inst = make(funct3 === 2 ? Rv.FLW : Rv.FLD, len, word)
      inst.rd = rd
      inst.rs1 = rs1
      inst.imm = BigInt(immI(word))
      return inst
    }
    case OP_STORE_FP: {
      if (funct3 !== 2 && funct3 !== 3) return unsupported(`fp store with width funct3 ${funct3}`)
      const inst = make(funct3 === 2 ? Rv.FSW : Rv.FSD, len, word)
      inst.rs1 = rs1
      inst.rs2 = rs2
      inst.imm = BigInt(immS(word))
      return inst
    }
    case OP_MADD:
    case OP_MSUB:
    case OP_NMSUB:
    case OP_NMADD: {
      const fmt = bits(word, 26, 25)
      if (fmt !== 0 && fmt !== 1) return unsupported(`fused multiply-add with format ${fmt}`)
      const single = fmt === 0
      const op =
        opcode === OP_MADD ? (single ? Rv.FMADD_S : Rv.FMADD_D)
          : opcode === OP_MSUB ? (single ? Rv.FMSUB_S : Rv.FMSUB_D)
            : opcode === OP_NMSUB ? (single ? Rv.FNMSUB_S : Rv.FNMSUB_D)
              : (single ? Rv.FNMADD_S : Rv.FNMADD_D)
      const inst = make(op, len, word)
      inst.rd = rd
      inst.rs1 = rs1
      inst.rs2 = rs2
      inst.rs3 = bits(word, 31, 27)
      inst.rm = funct3
      return inst
    }
    case OP_FP:
      return decodeOpFp(word, len, address, rd, rs1, rs2, funct3, funct7)
    default:
      return bad(`unknown opcode 0x${opcode.toString(16)}`)
  }
}

function decodeOpFp(
  word: number,
  len: 2 | 4,
  address: bigint,
  rd: number,
  rs1: number,
  rs2: number,
  funct3: number,
  funct7: number,
): RvInst {
  const unsupported = (detail: string): never => {
    throw new UnimplementedInstruction(ISA_NAME, address, rawBytes(word, len), detail)
  }
  const bad = (detail: string): never => {
    throw new IllegalInstruction(ISA_NAME, address, rawBytes(word, len), detail)
  }
  const fmt = funct7 & 3
  if (fmt !== 0 && fmt !== 1) return unsupported(`fp format ${fmt} (only single and double)`)
  const single = fmt === 0
  const pick = <T,>(s: T, d: T): T => (single ? s : d)

  const inst = make(Rv.ILLEGAL, len, word)
  inst.rd = rd
  inst.rs1 = rs1
  inst.rs2 = rs2
  inst.rm = funct3

  switch (funct7 & ~3) {
    case 0x00:
      inst.op = pick(Rv.FADD_S, Rv.FADD_D)
      return inst
    case 0x04:
      inst.op = pick(Rv.FSUB_S, Rv.FSUB_D)
      return inst
    case 0x08:
      inst.op = pick(Rv.FMUL_S, Rv.FMUL_D)
      return inst
    case 0x0c:
      inst.op = pick(Rv.FDIV_S, Rv.FDIV_D)
      return inst
    case 0x2c:
      if (rs2 !== 0) return bad('fsqrt with a non-zero rs2')
      inst.op = pick(Rv.FSQRT_S, Rv.FSQRT_D)
      return inst
    case 0x10:
      if (funct3 === 0) inst.op = pick(Rv.FSGNJ_S, Rv.FSGNJ_D)
      else if (funct3 === 1) inst.op = pick(Rv.FSGNJN_S, Rv.FSGNJN_D)
      else if (funct3 === 2) inst.op = pick(Rv.FSGNJX_S, Rv.FSGNJX_D)
      else return bad(`fsgnj with reserved funct3 ${funct3}`)
      return inst
    case 0x14:
      if (funct3 === 0) inst.op = pick(Rv.FMIN_S, Rv.FMIN_D)
      else if (funct3 === 1) inst.op = pick(Rv.FMAX_S, Rv.FMAX_D)
      else return bad(`fmin/fmax with reserved funct3 ${funct3}`)
      return inst
    case 0x50:
      if (funct3 === 0) inst.op = pick(Rv.FLE_S, Rv.FLE_D)
      else if (funct3 === 1) inst.op = pick(Rv.FLT_S, Rv.FLT_D)
      else if (funct3 === 2) inst.op = pick(Rv.FEQ_S, Rv.FEQ_D)
      else return bad(`fp compare with reserved funct3 ${funct3}`)
      return inst
    case 0x20:
      // fcvt between the two float formats; rs2 names the source format.
      if (single) {
        if (rs2 !== 1) return unsupported(`fcvt.s.* from format ${rs2}`)
        inst.op = Rv.FCVT_S_D
      } else {
        if (rs2 !== 0) return unsupported(`fcvt.d.* from format ${rs2}`)
        inst.op = Rv.FCVT_D_S
      }
      return inst
    case 0x60: {
      const table = single
        ? [Rv.FCVT_W_S, Rv.FCVT_WU_S, Rv.FCVT_L_S, Rv.FCVT_LU_S]
        : [Rv.FCVT_W_D, Rv.FCVT_WU_D, Rv.FCVT_L_D, Rv.FCVT_LU_D]
      const op = table[rs2]
      if (op === undefined) return bad(`fcvt to integer with reserved rs2 ${rs2}`)
      inst.op = op
      return inst
    }
    case 0x68: {
      const table = single
        ? [Rv.FCVT_S_W, Rv.FCVT_S_WU, Rv.FCVT_S_L, Rv.FCVT_S_LU]
        : [Rv.FCVT_D_W, Rv.FCVT_D_WU, Rv.FCVT_D_L, Rv.FCVT_D_LU]
      const op = table[rs2]
      if (op === undefined) return bad(`fcvt from integer with reserved rs2 ${rs2}`)
      inst.op = op
      return inst
    }
    case 0x70:
      if (rs2 !== 0) return bad('fmv.x/fclass with a non-zero rs2')
      if (funct3 === 0) inst.op = pick(Rv.FMV_X_W, Rv.FMV_X_D)
      else if (funct3 === 1) inst.op = pick(Rv.FCLASS_S, Rv.FCLASS_D)
      else return bad(`fmv.x/fclass with reserved funct3 ${funct3}`)
      return inst
    case 0x78:
      if (rs2 !== 0 || funct3 !== 0) return bad('fmv.*.x with reserved fields')
      inst.op = pick(Rv.FMV_W_X, Rv.FMV_D_X)
      return inst
    default:
      return unsupported(`op-fp with funct7 0x${funct7.toString(16)}`)
  }
}
