/**
 * POWER (powerpc64le) decoder.
 *
 * The widest instruction set in this project, and the one where the
 * encoding documentation is most likely to mislead you if you read it
 * the way you read every other architecture's.
 *
 * **Bits are numbered from the most significant end.** Bit 0 is the top
 * bit of the word, not the bottom. Every field in the manual is given in
 * those terms, so `fld` below takes them that way and converts once,
 * rather than every table entry converting in its head and one of them
 * getting it wrong.
 *
 * **The target is little-endian but the encoding is not.** A
 * powerpc64le instruction word is stored least significant byte first,
 * and then its *bits* are described most significant first. Those are
 * two independent facts and both are true at once.
 *
 * **Almost every mnemonic a compiler emits is an extended one.** `li` is
 * an add of an immediate to nothing, `nop` is an or of a register with
 * itself, `mr` is the same or with a different operand, `blr` is a
 * conditional branch to the link register with a condition that always
 * holds, and the whole rotate family -- `sldi`, `srwi`, `clrldi` and
 * their relatives -- is two instructions wearing a dozen names. The
 * decoder keeps the real instruction and decodeCheck.node.ts maps the
 * names back, which is how the two are checked against each other.
 *
 * **The scalar floating-point unit is the vector unit.** At `-O2` for
 * POWER8 clang does not emit `fadd` at all; it emits `xsadddp`, which is
 * the VSX instruction operating on one element of a 128-bit register
 * whose low half *is* the floating-point register. So the register file
 * here is 64 VSX registers with the 32 FPRs as a view onto the top half
 * of the first 32, and treating those as separate files would be
 * modelling something that does not exist.
 */
import { IllegalInstruction, UnimplementedInstruction } from '../common/errors.ts'

export const ISA_NAME = 'power'

export const PPC = {
  ILLEGAL: 0,

  // Fixed-point arithmetic.
  ADD: 1,
  ADDI: 2,
  ADDIS: 3,
  ADDIC: 4,
  ADDC: 5,
  ADDE: 6,
  ADDME: 7,
  ADDZE: 8,
  SUBF: 9,
  SUBFIC: 10,
  SUBFC: 11,
  SUBFE: 12,
  SUBFME: 13,
  SUBFZE: 14,
  NEG: 15,
  MULLI: 16,
  MULLW: 17,
  MULLD: 18,
  MULHW: 19,
  MULHWU: 20,
  MULHD: 21,
  MULHDU: 22,
  DIVW: 23,
  DIVWU: 24,
  DIVD: 25,
  DIVDU: 26,

  // Logic.
  AND: 30,
  ANDC: 31,
  OR: 32,
  ORC: 33,
  XOR: 34,
  NAND: 35,
  NOR: 36,
  EQV: 37,
  ANDI: 38,
  ANDIS: 39,
  ORI: 40,
  ORIS: 41,
  XORI: 42,
  XORIS: 43,
  EXTSB: 44,
  EXTSH: 45,
  EXTSW: 46,
  CNTLZW: 47,
  CNTLZD: 48,
  POPCNTD: 49,
  POPCNTW: 50,
  CNTTZD: 51,

  // Shifts and rotates.
  SLW: 55,
  SRW: 56,
  SRAW: 57,
  SRAWI: 58,
  SLD: 59,
  SRD: 60,
  SRAD: 61,
  SRADI: 62,
  RLWINM: 63,
  RLWNM: 64,
  RLWIMI: 65,
  RLDICL: 66,
  RLDICR: 67,
  RLDIC: 68,
  RLDIMI: 69,
  RLDCL: 70,
  RLDCR: 71,

  // Comparison and the condition register.
  CMP: 75,
  CMPL: 76,
  CMPI: 77,
  CMPLI: 78,
  ISEL: 79,
  CRAND: 80,
  CROR: 81,
  CRXOR: 82,
  CRNAND: 83,
  CRNOR: 84,
  CREQV: 85,
  CRANDC: 86,
  CRORC: 87,
  MCRF: 88,
  MFCR: 89,
  MTCRF: 90,

  // Branches.
  B: 95,
  BC: 96,
  BCLR: 97,
  BCCTR: 98,
  SC: 99,
  TRAP: 100,

  // Special registers.
  MFSPR: 105,
  MTSPR: 106,

  // Loads and stores. The width and the sign live in fields rather than
  // in the operation, so one entry serves `lbz` and `lhz`.
  LOAD: 110,
  LOADU: 111,
  LOADX: 112,
  LOADUX: 113,
  STORE: 114,
  STOREU: 115,
  STOREX: 116,
  STOREUX: 117,
  /** Load or store with the byte order reversed. */
  LOADBR: 118,
  STOREBR: 119,
  /** The load-reserve and store-conditional pair. */
  LARX: 120,
  STCX: 121,
  /**
   * Load an integer *word* into a floating-point register.
   *
   * Not a floating-point load: no conversion happens, the word simply
   * lands in the register so that a following instruction can convert
   * it. Treating it as a single-precision load reads the bits as a
   * float and produces a number with no relation to the integer.
   */
  LFIW: 122,

  // Floating point, the classic register file.
  FADD: 130,
  FSUB: 131,
  FMUL: 132,
  FDIV: 133,
  FSQRT: 134,
  FMADD: 135,
  FMSUB: 136,
  FNMADD: 137,
  FNMSUB: 138,
  FMR: 139,
  FNEG: 140,
  FABS: 141,
  FNABS: 142,
  FCMPU: 143,
  FCMPO: 144,
  FCTID: 145,
  FCTIW: 146,
  FCFID: 147,
  FRSP: 148,
  FSEL: 149,
  FRIN: 150,
  MFFS: 151,
  MTFSF: 152,

  // VSX: the same arithmetic on the register file that contains the
  // floating-point one.
  XSADD: 160,
  XSSUB: 161,
  XSMUL: 162,
  XSDIV: 163,
  XSSQRT: 164,
  XSMADD: 165,
  XSMSUB: 166,
  XSNMADD: 167,
  XSNMSUB: 168,
  XSCMP: 169,
  XSCVT: 170,
  XSNEG: 171,
  XSCPSGN: 174,
  /** The bitwise operations, which are on the whole 128 bits. */
  XXLOGIC: 180,
  XXSEL: 181,
  /**
   * Doubleword select from two registers. `xxswapd`, `xxmrghd`,
   * `xxmrgld` and `xxspltd` are all this with a particular selector.
   */
  XXPERMDI: 182,
  XXSPLTW: 183,
  /**
   * The word merges and the word shift are *not* `xxpermdi`: they move
   * 32-bit elements rather than 64-bit ones. They were once admitted to
   * the decode check as aliases of it, which is how a decoder that
   * confused them could pass -- each now has its own identity.
   */
  XXMRGHW: 184,
  XXMRGLW: 188,
  XXSLDWI: 189,
  /** Element-wise conversions, the `xv` family. */
  XVCVT: 185,

  // Moving between the register files.
  MFVSR: 190,
  MTVSR: 191,

  // VSX loads and stores, one identity each: they differ in width and in
  // where the elements land, and treating them as one is how a scalar
  // store came to write sixteen bytes.
  LXVD2X: 195,
  STXVD2X: 196,
  STXSDX: 197,
  LXSIWZX: 198,
  /** The low word of a floating-point register, stored unconverted. */
  STFIWX: 199,

  // Altivec, which shares the upper 32 VSX registers. One identity per
  // operation, so the decode tier checks each by name.
  VSPLTISW: 200,
  VADDUWM: 210,
  VADDUDM: 211,
  VSUBUWM: 212,
  VSUBUDM: 213,
  VMULUWM: 214,
  VSLW: 215,
  VSRW: 216,
  VSRAW: 217,
  VSLD: 218,
  VSRAD: 219,
  VCMPEQUW: 220,
  VCMPEQUD: 221,
  VCMPGTUW: 222,
  VCMPGTUD: 223,
  VPKUDUM: 224,
  VUPKLSW: 225,
  VPERM: 226,

  // Cache and ordering.
  SYNC: 205,
  ISYNC: 206,
  DCBZ: 207,
  ICBI: 208,
  NOP_CACHE: 209,
} as const

export type PpcOp = (typeof PPC)[keyof typeof PPC]

export const PPC_NAME: readonly string[] = (() => {
  const names: string[] = []
  for (const [key, value] of Object.entries(PPC)) names[value] = key.toLowerCase()
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

/** Which register file an operand names. */
export const File = {
  GPR: 0,
  FPR: 1,
  VSR: 2,
  CR: 3,
} as const
export type RegFile = (typeof File)[keyof typeof File]

export interface PpcInst {
  op: PpcOp
  /** Destination, in whichever file `destFile` names. */
  rd: number
  ra: number
  rb: number
  /** Third source, for the multiply-add family. */
  rc: number
  destFile: RegFile
  sourceFile: RegFile
  /** Sign-extended displacement or immediate. */
  imm: bigint
  /** Absolute branch target. */
  target: bigint
  /** Condition register field a comparison writes or a branch reads. */
  crField: number
  /** BO and BI, the two fields that say what a conditional branch tests. */
  bo: number
  bi: number
  /** Whether the branch writes the link register. */
  link: boolean
  /** Whether the instruction updates CR0 -- the `.` suffix. */
  recordCr: boolean
  /** Whether it updates the summary overflow bits -- the `o` suffix. */
  recordOv: boolean
  /** Bytes touched by a load or store, or 0. */
  width: number
  signed: boolean
  /** Whether a 32-bit operation, where the architecture has both widths. */
  is32: boolean
  /** Rotate mask boundaries, in the manual's bit numbering. */
  maskBegin: number
  maskEnd: number
  shift: number
  /** Special-purpose register number, for the move instructions. */
  spr: number
  flow: FlowKind
  word: number
}

/**
 * A field, in the manual's bit numbering: bit 0 is the most significant.
 *
 * Every table below is written in the manual's terms so it can be
 * checked against the manual without translating in your head.
 */
function fld(word: number, hi: number, lo: number): number {
  return (word >>> (31 - lo)) & ((1 << (lo - hi + 1)) - 1)
}

function signed16(value: number): bigint {
  return BigInt((value << 16) >> 16)
}

function blank(word: number): PpcInst {
  return {
    op: PPC.ILLEGAL,
    rd: -1, ra: -1, rb: -1, rc: -1,
    destFile: File.GPR,
    sourceFile: File.GPR,
    imm: 0n,
    target: 0n,
    crField: 0,
    bo: 0,
    bi: 0,
    link: false,
    recordCr: false,
    recordOv: false,
    width: 0,
    signed: false,
    is32: false,
    flow: Flow.SEQ,
    maskBegin: 0,
    maskEnd: 63,
    shift: 0,
    spr: -1,
    word,
  }
}

function refuse(address: bigint, word: number, detail: string): never {
  // Little-endian in memory, whatever the bit numbering says.
  const raw = Uint8Array.from([
    word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff,
  ])
  throw new UnimplementedInstruction(ISA_NAME, address, raw, detail)
}

interface MemEntry { op: PpcOp; width: number; signed: boolean; file: RegFile }
const M = (op: PpcOp, width: number, signed = false, file: RegFile = File.GPR): MemEntry =>
  ({ op, width, signed, file })

/** Primary opcodes 32..55: the D-form loads and stores. */
const D_MEMORY: Readonly<Record<number, MemEntry>> = {
  32: M(PPC.LOAD, 4), 33: M(PPC.LOADU, 4),
  34: M(PPC.LOAD, 1), 35: M(PPC.LOADU, 1),
  36: M(PPC.STORE, 4), 37: M(PPC.STOREU, 4),
  38: M(PPC.STORE, 1), 39: M(PPC.STOREU, 1),
  40: M(PPC.LOAD, 2), 41: M(PPC.LOADU, 2),
  42: M(PPC.LOAD, 2, true), 43: M(PPC.LOADU, 2, true),
  44: M(PPC.STORE, 2), 45: M(PPC.STOREU, 2),
  48: M(PPC.LOAD, 4, false, File.FPR), 49: M(PPC.LOADU, 4, false, File.FPR),
  50: M(PPC.LOAD, 8, false, File.FPR), 51: M(PPC.LOADU, 8, false, File.FPR),
  52: M(PPC.STORE, 4, false, File.FPR), 53: M(PPC.STOREU, 4, false, File.FPR),
  54: M(PPC.STORE, 8, false, File.FPR), 55: M(PPC.STOREU, 8, false, File.FPR),
}

/** Primary 31, indexed by the ten-bit extended opcode. */
interface XEntry {
  op: PpcOp
  width?: number
  signed?: boolean
  file?: RegFile
  is32?: boolean
}
const X: Readonly<Record<number, XEntry>> = {
  // Arithmetic. The XO-form entries appear at both settings of the
  // overflow bit, which is why each is listed twice by the builder.
  266: { op: PPC.ADD }, 40: { op: PPC.SUBF },
  10: { op: PPC.ADDC }, 8: { op: PPC.SUBFC },
  138: { op: PPC.ADDE }, 136: { op: PPC.SUBFE },
  234: { op: PPC.ADDME }, 232: { op: PPC.SUBFME },
  202: { op: PPC.ADDZE }, 200: { op: PPC.SUBFZE },
  104: { op: PPC.NEG },
  235: { op: PPC.MULLW, is32: true }, 233: { op: PPC.MULLD },
  75: { op: PPC.MULHW, is32: true }, 11: { op: PPC.MULHWU, is32: true },
  73: { op: PPC.MULHD }, 9: { op: PPC.MULHDU },
  491: { op: PPC.DIVW, is32: true }, 459: { op: PPC.DIVWU, is32: true },
  489: { op: PPC.DIVD }, 457: { op: PPC.DIVDU },

  // Logic.
  28: { op: PPC.AND }, 60: { op: PPC.ANDC },
  444: { op: PPC.OR }, 412: { op: PPC.ORC },
  316: { op: PPC.XOR }, 476: { op: PPC.NAND },
  124: { op: PPC.NOR }, 284: { op: PPC.EQV },
  954: { op: PPC.EXTSB }, 922: { op: PPC.EXTSH }, 986: { op: PPC.EXTSW },
  26: { op: PPC.CNTLZW, is32: true }, 58: { op: PPC.CNTLZD },
  506: { op: PPC.POPCNTD }, 378: { op: PPC.POPCNTW },
  570: { op: PPC.CNTTZD },

  // Shifts.
  24: { op: PPC.SLW, is32: true }, 536: { op: PPC.SRW, is32: true },
  792: { op: PPC.SRAW, is32: true }, 824: { op: PPC.SRAWI, is32: true },
  794: { op: PPC.SRAD },
  27: { op: PPC.SLD }, 539: { op: PPC.SRD },

  // Comparison and selection.
  0: { op: PPC.CMP }, 32: { op: PPC.CMPL },
  15: { op: PPC.ISEL },

  // Special registers and the condition register.
  339: { op: PPC.MFSPR }, 467: { op: PPC.MTSPR },
  19: { op: PPC.MFCR }, 144: { op: PPC.MTCRF },

  // Indexed loads and stores.
  87: { op: PPC.LOADX, width: 1 }, 119: { op: PPC.LOADUX, width: 1 },
  279: { op: PPC.LOADX, width: 2 }, 311: { op: PPC.LOADUX, width: 2 },
  343: { op: PPC.LOADX, width: 2, signed: true },
  375: { op: PPC.LOADUX, width: 2, signed: true },
  23: { op: PPC.LOADX, width: 4 }, 55: { op: PPC.LOADUX, width: 4 },
  341: { op: PPC.LOADX, width: 4, signed: true },
  373: { op: PPC.LOADUX, width: 4, signed: true },
  21: { op: PPC.LOADX, width: 8 }, 53: { op: PPC.LOADUX, width: 8 },
  215: { op: PPC.STOREX, width: 1 }, 247: { op: PPC.STOREUX, width: 1 },
  407: { op: PPC.STOREX, width: 2 }, 439: { op: PPC.STOREUX, width: 2 },
  151: { op: PPC.STOREX, width: 4 }, 183: { op: PPC.STOREUX, width: 4 },
  149: { op: PPC.STOREX, width: 8 }, 181: { op: PPC.STOREUX, width: 8 },
  535: { op: PPC.LOADX, width: 4, file: File.FPR },
  599: { op: PPC.LOADX, width: 8, file: File.FPR },
  663: { op: PPC.STOREX, width: 4, file: File.FPR },
  727: { op: PPC.STOREX, width: 8, file: File.FPR },
  790: { op: PPC.LOADBR, width: 2 }, 534: { op: PPC.LOADBR, width: 4 },
  532: { op: PPC.LOADBR, width: 8 },
  918: { op: PPC.STOREBR, width: 2 }, 662: { op: PPC.STOREBR, width: 4 },
  660: { op: PPC.STOREBR, width: 8 },
  20: { op: PPC.LARX, width: 4 }, 84: { op: PPC.LARX, width: 8 },
  855: { op: PPC.LFIW, width: 4, signed: true, file: File.FPR },
  887: { op: PPC.LFIW, width: 4, file: File.FPR },
  150: { op: PPC.STCX, width: 4 }, 214: { op: PPC.STCX, width: 8 },

  // VSX moves and memory, which live in the fixed-point opcode space.
  //
  // The three move-in forms are not one instruction: `mtvsrd` moves all
  // sixty-four bits, `mtvsrwa` sign-extends the low word and `mtvsrwz`
  // zero-extends it. Folding them together is right until a negative
  // number arrives, and then wrong for the rest of the program.
  51: { op: PPC.MFVSR, width: 8 },
  115: { op: PPC.MFVSR, width: 4 },
  179: { op: PPC.MTVSR, width: 8 },
  211: { op: PPC.MTVSR, width: 4, signed: true },
  243: { op: PPC.MTVSR, width: 4 },
  // `lxvw4x` and `stxvw4x` (780, 908) are deliberately absent. On a
  // little-endian machine they place the four words in a different order
  // from `lxvd2x`, and they used to be decoded as it -- which would run
  // and produce a plausible, permuted answer. Nothing measured uses them,
  // so they are refused rather than implemented unverified.
  844: { op: PPC.LXVD2X, width: 16 }, 972: { op: PPC.STXVD2X, width: 16 },
  // `stxsdx` moves one doubleword, not sixteen bytes: it is the scalar
  // form, and storing the whole register would overwrite eight bytes
  // that belong to whatever is next in memory.
  716: { op: PPC.STXSDX, width: 8 },
  12: { op: PPC.LXSIWZX, width: 4 },
  // `stfiwx` stores the low word of the register *as it is*. It shares a
  // shape with `stfsx` (663), which converts a double to single precision
  // first, and it used to be decoded as that -- so every integer musl's
  // `printf` produced with a float-to-integer conversion was stored as the
  // bit pattern of a float, and the digits it printed came out as zeros.
  983: { op: PPC.STFIWX, width: 4, file: File.FPR },

  // Ordering and cache hints, which are architectural no-operations for
  // everything an interpreter without a cache hierarchy can observe.
  598: { op: PPC.SYNC }, 854: { op: PPC.SYNC },
  1014: { op: PPC.DCBZ }, 982: { op: PPC.ICBI },
  278: { op: PPC.NOP_CACHE }, 246: { op: PPC.NOP_CACHE },
  54: { op: PPC.NOP_CACHE }, 86: { op: PPC.NOP_CACHE },
  4: { op: PPC.TRAP }, 68: { op: PPC.TRAP },
}

/** Primary 63, the classic floating-point unit. */
const FP_A: Readonly<Record<number, PpcOp>> = {
  21: PPC.FADD, 20: PPC.FSUB, 25: PPC.FMUL, 18: PPC.FDIV, 22: PPC.FSQRT,
  29: PPC.FMADD, 28: PPC.FMSUB, 31: PPC.FNMADD, 30: PPC.FNMSUB,
  // 24 is not here. It is `fres`, a reciprocal *estimate*, and it used
  // to be listed as `frsp` -- which is the X-form entry 12 below. Nothing
  // measured uses it, so it is refused rather than guessed at.
  23: PPC.FSEL,
}
const FP_X: Readonly<Record<number, PpcOp>> = {
  72: PPC.FMR, 40: PPC.FNEG, 264: PPC.FABS, 136: PPC.FNABS,
  0: PPC.FCMPU, 32: PPC.FCMPO,
  846: PPC.FCFID,
  // Absent on purpose, and each for a reason the table used to hide by
  // folding several instructions into one:
  //
  //   814, 14   `fctid`, `fctiw` round to nearest; they were executed as
  //             their truncating `z` forms, which differ on 2.7.
  //   815, 15   `fctidz`, `fctiwz` truncate, but saturate out-of-range
  //             values and give the most negative integer for a NaN,
  //             neither of which was implemented.
  //   392..488  `frin`, `friz`, `frip`, `frim` round four different ways
  //             and were one operation.
  //
  // No binary measured here contains any of them -- the compiler reaches
  // the VSX conversions instead -- so they are refused rather than
  // implemented without anything to check them against.
  583: PPC.MFFS, 711: PPC.MTFSF,
  12: PPC.FRSP,
}

/** Primary 60, VSX. Indexed by the XX3-form extended opcode. */
const XX3: Readonly<Record<number, PpcOp>> = {
  // The double-precision scalar arithmetic. The single-precision forms
  // are 0, 8, 16 and 24 and round differently, so they are not here.
  32: PPC.XSADD, 40: PPC.XSSUB, 48: PPC.XSMUL, 56: PPC.XSDIV,
  33: PPC.XSMADD, 41: PPC.XSMADD, 49: PPC.XSMSUB, 57: PPC.XSMSUB,
  161: PPC.XSNMADD, 169: PPC.XSNMADD, 177: PPC.XSNMSUB, 185: PPC.XSNMSUB,
  // xscmpudp and xscmpodp.
  35: PPC.XSCMP, 43: PPC.XSCMP,
  // xsmaxdp and xsmindp (160, 168) are refused: nothing measured uses
  // them, and they have no semantics to be wrong with.
  176: PPC.XSCPSGN,
  // The bitwise operations are on all 128 bits, and the eight of them
  // are spaced by eight: and, andc, or, xor, nor, orc, nand, eqv.
  130: PPC.XXLOGIC, 138: PPC.XXLOGIC, 146: PPC.XXLOGIC, 154: PPC.XXLOGIC,
  162: PPC.XXLOGIC, 170: PPC.XXLOGIC, 178: PPC.XXLOGIC, 186: PPC.XXLOGIC,
  // The word merges, measured: 18 is `xxmrghw` and 50 is `xxmrglw`.
  // `xxpermdi` and `xxsldwi` are not here because two of these eight
  // bits are an operand for them; they are matched on their five-bit
  // opcode after this table misses.
  18: PPC.XXMRGHW, 50: PPC.XXMRGLW,
}

/**
 * Primary 60, the two-operand forms, keyed on bits 21 to 29.
 *
 * Every entry here was read off a disassembly rather than out of a
 * table, because an entry that is merely plausible is worse than a
 * missing one: a missing encoding is refused loudly, and a wrong one
 * decodes as some other instruction and runs.
 */
const XX2: Readonly<Record<number, PpcOp>> = {
  // Scalar conversions. The name spells source then destination, and
  // the two halves move independently, so these do not follow a stride
  // worth generalising from.
  72: PPC.XSCVT,   // xscvdpuxws
  88: PPC.XSCVT,   // xscvdpsxws
  344: PPC.XSCVT,  // xscvdpsxds
  360: PPC.XSCVT,  // xscvuxddp
  376: PPC.XSCVT,  // xscvsxddp
  248: PPC.XVCVT,  // xvcvsxwdp
  // Sign manipulation, which is one bit and so never rounds.
  377: PPC.XSNEG,
  // Roots.
  75: PPC.XSSQRT,
  // Splat, which is a two-operand form despite its name.
  164: PPC.XXSPLTW,
}

/**
 * The Altivec operations the corpus and its libc reach, by their
 * eleven-bit opcode. Listed rather than generalised for the same reason
 * the VSX table is: each one was seen in a disassembly.
 */
const ALTIVEC: Readonly<Record<number, PpcOp>> = {
  128: PPC.VADDUWM, 192: PPC.VADDUDM,
  1152: PPC.VSUBUWM, 1216: PPC.VSUBUDM,
  137: PPC.VMULUWM,
  388: PPC.VSLW, 644: PPC.VSRW, 900: PPC.VSRAW,
  1476: PPC.VSLD, 964: PPC.VSRAD,
  // The comparisons without the record bit. With it -- the same numbers
  // plus 1024 -- they also write a condition field, which is not
  // implemented and so is refused by being absent.
  134: PPC.VCMPEQUW, 199: PPC.VCMPEQUD,
  646: PPC.VCMPGTUW, 711: PPC.VCMPGTUD,
  1102: PPC.VPKUDUM,
  1742: PPC.VUPKLSW,
}

export function decode(word: number, address: bigint): PpcInst {
  const inst = blank(word >>> 0)
  const primary = fld(word, 0, 5)
  inst.rd = fld(word, 6, 10)
  inst.ra = fld(word, 11, 15)
  inst.rb = fld(word, 16, 20)

  switch (primary) {
    // ---- Branches --------------------------------------------------
    case 18: {
      // I-form: a 24-bit word displacement, absolute or relative.
      const li = fld(word, 6, 29)
      const displacement = BigInt((li << 8) >> 8) * 4n
      const absolute = fld(word, 30, 30) === 1
      inst.link = fld(word, 31, 31) === 1
      inst.target = BigInt.asUintN(64, absolute ? displacement : address + displacement)
      inst.op = PPC.B
      inst.flow = inst.link ? Flow.CALL : Flow.JUMP
      inst.rd = -1; inst.ra = -1; inst.rb = -1
      return inst
    }
    case 16: {
      // B-form: a 14-bit displacement, plus BO and BI.
      inst.op = PPC.BC
      inst.bo = fld(word, 6, 10)
      inst.bi = fld(word, 11, 15)
      const bd = fld(word, 16, 29)
      const displacement = BigInt((bd << 18) >> 18) * 4n
      const absolute = fld(word, 30, 30) === 1
      inst.link = fld(word, 31, 31) === 1
      inst.target = BigInt.asUintN(64, absolute ? displacement : address + displacement)
      inst.crField = inst.bi >> 2
      inst.flow = Flow.BRANCH
      inst.rd = -1; inst.ra = -1; inst.rb = -1
      return inst
    }
    case 17:
      inst.op = PPC.SC
      inst.flow = Flow.TRAP
      inst.rd = -1; inst.ra = -1; inst.rb = -1
      return inst

    case 19: {
      const xo = fld(word, 21, 30)
      inst.bo = fld(word, 6, 10)
      inst.bi = fld(word, 11, 15)
      inst.crField = inst.bi >> 2
      inst.link = fld(word, 31, 31) === 1
      if (xo === 16) {
        inst.op = PPC.BCLR
        inst.flow = inst.link ? Flow.CALL : Flow.RET
        inst.rd = -1; inst.ra = -1; inst.rb = -1
        return inst
      }
      if (xo === 528) {
        inst.op = PPC.BCCTR
        inst.flow = inst.link ? Flow.CALL : Flow.INDIRECT
        inst.rd = -1; inst.ra = -1; inst.rb = -1
        return inst
      }
      if (xo === 150) { inst.op = PPC.ISYNC; inst.rd = -1; inst.ra = -1; inst.rb = -1; return inst }
      if (xo === 0) { inst.op = PPC.MCRF; return inst }
      const logic: Readonly<Record<number, PpcOp>> = {
        257: PPC.CRAND, 449: PPC.CROR, 193: PPC.CRXOR, 225: PPC.CRNAND,
        33: PPC.CRNOR, 289: PPC.CREQV, 129: PPC.CRANDC, 417: PPC.CRORC,
      }
      const found = logic[xo]
      if (found !== undefined) {
        inst.op = found
        inst.destFile = File.CR
        inst.sourceFile = File.CR
        return inst
      }
      return refuse(address, word, `primary 19 extended ${xo}`)
    }

    // ---- Immediate arithmetic --------------------------------------
    case 14: case 15: case 12: case 13: case 7: case 8: {
      inst.imm = signed16(fld(word, 16, 31))
      inst.rb = -1
      inst.op =
        primary === 14 ? PPC.ADDI :
        primary === 15 ? PPC.ADDIS :
        primary === 7 ? PPC.MULLI :
        primary === 8 ? PPC.SUBFIC :
        PPC.ADDIC
      inst.recordCr = primary === 13
      return inst
    }
    case 10: case 11: {
      inst.op = primary === 10 ? PPC.CMPLI : PPC.CMPI
      inst.crField = fld(word, 6, 8)
      inst.is32 = fld(word, 10, 10) === 0
      inst.imm = primary === 10
        ? BigInt(fld(word, 16, 31))
        : signed16(fld(word, 16, 31))
      inst.rd = -1
      inst.rb = -1
      inst.destFile = File.CR
      return inst
    }
    case 24: case 25: case 26: case 27: case 28: case 29: {
      // The logical immediates take an unsigned field, and the
      // destination is `ra` rather than `rd`, which is the one place
      // POWER reverses the usual roles.
      inst.imm = BigInt(fld(word, 16, 31))
      inst.rb = -1
      inst.op =
        primary === 24 ? PPC.ORI : primary === 25 ? PPC.ORIS :
        primary === 26 ? PPC.XORI : primary === 27 ? PPC.XORIS :
        primary === 28 ? PPC.ANDI : PPC.ANDIS
      inst.recordCr = primary === 28 || primary === 29
      return inst
    }

    // ---- Rotates ---------------------------------------------------
    case 20: case 21: case 23: {
      inst.op = primary === 20 ? PPC.RLWIMI : primary === 21 ? PPC.RLWINM : PPC.RLWNM
      inst.shift = fld(word, 16, 20)
      inst.maskBegin = fld(word, 21, 25)
      inst.maskEnd = fld(word, 26, 30)
      inst.recordCr = fld(word, 31, 31) === 1
      inst.is32 = true
      if (primary === 23) inst.shift = -1
      else inst.rb = -1
      return inst
    }
    case 30: {
      // The 64-bit rotates split the shift amount and the mask bit
      // across the word, because neither fits where it would like to.
      const xo = fld(word, 27, 29)
      const sh = fld(word, 16, 20) | (fld(word, 30, 30) << 5)
      // The six-bit mask boundary is split with its *most* significant
      // bit alone in bit 26 and the other five in bits 21 to 25, which
      // is the opposite way round from how it reads. Assembling it the
      // other way gives a mask that is plausible, wrong, and only wrong
      // for boundaries above 31.
      const raw = fld(word, 21, 26)
      const mask = ((raw & 1) << 5) | (raw >> 1)
      inst.shift = sh
      inst.recordCr = fld(word, 31, 31) === 1
      switch (xo) {
        case 0: inst.op = PPC.RLDICL; inst.maskBegin = mask; inst.maskEnd = 63; break
        case 1: inst.op = PPC.RLDICR; inst.maskBegin = 0; inst.maskEnd = mask; break
        case 2: inst.op = PPC.RLDIC; inst.maskBegin = mask; inst.maskEnd = 63; break
        case 3: inst.op = PPC.RLDIMI; inst.maskBegin = mask; inst.maskEnd = 63; break
        case 4:
          inst.op = fld(word, 30, 30) === 0 ? PPC.RLDCL : PPC.RLDCR
          inst.maskBegin = mask
          inst.shift = -1
          return inst
        default:
          return refuse(address, word, `primary 30 extended ${xo}`)
      }
      inst.rb = -1
      return inst
    }

    // ---- D-form and DS-form memory ---------------------------------
    case 32: case 33: case 34: case 35: case 36: case 37: case 38: case 39:
    case 40: case 41: case 42: case 43: case 44: case 45:
    case 48: case 49: case 50: case 51: case 52: case 53: case 54: case 55: {
      const entry = D_MEMORY[primary]!
      inst.op = entry.op
      inst.width = entry.width
      inst.signed = entry.signed
      inst.destFile = entry.file
      inst.sourceFile = entry.file
      inst.imm = signed16(fld(word, 16, 31))
      inst.rb = -1
      return inst
    }
    case 58: case 62: {
      // DS-form: the displacement is a multiple of four, so its low two
      // bits are the extended opcode instead.
      const xo = fld(word, 30, 31)
      inst.imm = BigInt((fld(word, 16, 29) << 18) >> 18) * 4n
      inst.rb = -1
      if (primary === 58) {
        if (xo === 0) { inst.op = PPC.LOAD; inst.width = 8 }
        else if (xo === 1) { inst.op = PPC.LOADU; inst.width = 8 }
        else if (xo === 2) { inst.op = PPC.LOAD; inst.width = 4; inst.signed = true }
        else return refuse(address, word, `primary 58 extended ${xo}`)
      } else {
        if (xo === 0) { inst.op = PPC.STORE; inst.width = 8 }
        else if (xo === 1) { inst.op = PPC.STOREU; inst.width = 8 }
        else return refuse(address, word, `primary 62 extended ${xo}`)
      }
      return inst
    }

    // ---- The big one -----------------------------------------------
    case 31:
      return decodeX(inst, word, address)

    // ---- Floating point --------------------------------------------
    case 59: case 63:
      return decodeFp(inst, word, address, primary === 59)

    // ---- VSX --------------------------------------------------------
    case 60:
      return decodeVsx(inst, word, address)

    // ---- Altivec ----------------------------------------------------
    case 4: {
      inst.destFile = File.VSR
      inst.sourceFile = File.VSR
      // The Altivec registers are not a separate file either: v0 to v31
      // *are* vector-scalar registers 32 to 63. An instruction here
      // names `v2` and means `vs34`, and a decoder that took the field
      // at face value would have `vspltisw` and the `xv` conversion
      // that reads its result disagreeing about which register they
      // were talking about.
      inst.rd += 32
      inst.ra += 32
      inst.rb += 32
      // Two forms share this opcode. VA-form has four register operands
      // and a six-bit opcode at the very bottom of the word; VX-form
      // has three and an eleven-bit one. The VA opcodes occupy a narrow
      // range, which is what tells them apart.
      //
      // Only `vperm` is implemented of the VA forms; the rest are refused.
      const va = fld(word, 26, 31)
      if (va === 43) {
        inst.op = PPC.VPERM
        inst.rc = fld(word, 21, 25) + 32
        return inst
      }
      if (va >= 32 && va <= 47) return refuse(address, word, `altivec VA-form ${va}`)
      const xo = fld(word, 21, 31)
      // Only the word form. 844 and 780 are `vspltish` and `vspltisb`,
      // which splat halfwords and bytes; they used to be decoded as this,
      // which would have produced a vector of the right value in the
      // wrong element width.
      if (xo === 908) {
        inst.op = PPC.VSPLTISW
        // The immediate is in the field that would otherwise be a
        // register, so it is read before the offset above applies.
        inst.imm = BigInt((fld(word, 11, 15) << 27) >> 27)
        inst.ra = -1; inst.rb = -1
        return inst
      }
      const found = ALTIVEC[xo]
      if (found !== undefined) {
        inst.op = found
        // The unpack reads one source; its A field is zero rather than a
        // register, and naming v0 there would invent a dependence.
        if (found === PPC.VUPKLSW) inst.ra = -1
        return inst
      }
      return refuse(address, word, `altivec extended ${xo}`)
    }

    default:
      return refuse(address, word, `primary opcode ${primary}`)
  }
}

function decodeX(inst: PpcInst, word: number, address: bigint): PpcInst {
  const xo = fld(word, 21, 30)
  inst.recordCr = fld(word, 31, 31) === 1

  // Two instructions in this space do not have a ten-bit extended
  // opcode, and looking them up as though they did finds nothing.
  //
  // `isel` uses five bits, with the condition-register bit it tests
  // sitting in the five above them, so its extended opcode reads as
  // 15 plus 32 times that bit.
  if (fld(word, 26, 30) === 15) {
    inst.op = PPC.ISEL
    inst.bi = fld(word, 21, 25)
    inst.crField = inst.bi >> 2
    inst.recordCr = false
    return inst
  }
  // `sradi` uses nine, because the sixth bit of its shift amount had
  // to go somewhere and the only space left was bit 30 -- the same
  // trick the 64-bit rotates play.
  if (fld(word, 21, 29) === 413) {
    inst.op = PPC.SRADI
    inst.shift = fld(word, 16, 20) | (fld(word, 30, 30) << 5)
    inst.rb = -1
    return inst
  }

  // The XO-form arithmetic has a nine-bit opcode and an overflow bit
  // above it, so it is looked up with that bit removed.
  const xoShort = fld(word, 22, 30)
  const oe = fld(word, 21, 21) === 1
  const arithmetic = X[xoShort]
  if (arithmetic && isArithmetic(arithmetic.op)) {
    inst.op = arithmetic.op
    inst.recordOv = oe
    inst.is32 = arithmetic.is32 ?? false
    if (inst.op === PPC.NEG) inst.rb = -1
    return inst
  }

  const entry = X[xo]
  if (!entry) return refuse(address, word, `primary 31 extended ${xo}`)
  inst.op = entry.op
  inst.is32 = entry.is32 ?? false

  switch (entry.op) {
    case PPC.CMP: case PPC.CMPL:
      inst.crField = fld(word, 6, 8)
      inst.is32 = fld(word, 10, 10) === 0
      inst.rd = -1
      inst.destFile = File.CR
      return inst

    case PPC.SRAWI:
      inst.shift = fld(word, 16, 20)
      inst.rb = -1
      return inst

    case PPC.MFSPR: case PPC.MTSPR: {
      // The special-register number is in two halves, swapped.
      const raw = fld(word, 11, 20)
      inst.spr = ((raw & 0x1f) << 5) | (raw >> 5)
      inst.ra = -1
      inst.rb = -1
      return inst
    }

    case PPC.MFCR:
      inst.ra = -1; inst.rb = -1
      inst.sourceFile = File.CR
      // `mfocrf` is this opcode with bit 11 set, and it moves only the
      // fields its mask names; the rest of the result is zero. Treating it
      // as `mfcr` returns every field, which is a different value in a
      // register a caller then saves and compares.
      inst.imm = fld(word, 11, 11) === 1 ? BigInt(fld(word, 12, 19)) : 0xffn
      return inst
    case PPC.MTCRF:
      inst.imm = BigInt(fld(word, 12, 19))
      inst.ra = -1; inst.rb = -1
      inst.destFile = File.CR
      return inst

    case PPC.ISEL:
      inst.crField = fld(word, 21, 25) >> 2
      inst.bi = fld(word, 21, 25)
      return inst

    case PPC.EXTSB: case PPC.EXTSH: case PPC.EXTSW:
    case PPC.CNTLZW: case PPC.CNTLZD: case PPC.POPCNTD:
    case PPC.POPCNTW: case PPC.CNTTZD:
      inst.rb = -1
      return inst

    case PPC.LOADX: case PPC.LOADUX: case PPC.STOREX: case PPC.STOREUX:
    case PPC.LOADBR: case PPC.STOREBR: case PPC.LARX: case PPC.STCX:
    case PPC.LFIW: case PPC.STFIWX:
      inst.width = entry.width ?? 0
      inst.signed = entry.signed ?? false
      inst.destFile = entry.file ?? File.GPR
      inst.sourceFile = entry.file ?? File.GPR
      return inst

    case PPC.LXVD2X: case PPC.STXVD2X: case PPC.STXSDX: case PPC.LXSIWZX:
      // The width is the table's. An earlier version set sixteen here for
      // every form, which overrode the scalar entries: `stxsdx` wrote
      // eight bytes past its operand, and `lxsiwzx` read twelve bytes too
      // many into a register that should have held one word.
      inst.width = entry.width ?? 16
      // The VSX register number's high bit is at the bottom of the word.
      inst.rd = fld(word, 6, 10) | (fld(word, 31, 31) << 5)
      inst.recordCr = false
      inst.destFile = File.VSR
      inst.sourceFile = File.VSR
      return inst

    case PPC.MFVSR:
      inst.rd = fld(word, 11, 15)
      inst.ra = fld(word, 6, 10) | (fld(word, 31, 31) << 5)
      inst.rb = -1
      inst.sourceFile = File.VSR
      inst.recordCr = false
      inst.width = entry.width ?? 8
      return inst
    case PPC.MTVSR:
      inst.rd = fld(word, 6, 10) | (fld(word, 31, 31) << 5)
      inst.ra = fld(word, 11, 15)
      inst.rb = -1
      inst.destFile = File.VSR
      inst.recordCr = false
      inst.width = entry.width ?? 8
      inst.signed = entry.signed ?? false
      return inst

    case PPC.SYNC: case PPC.ISYNC: case PPC.NOP_CACHE:
      inst.rd = -1; inst.ra = -1; inst.rb = -1
      inst.recordCr = false
      return inst
    case PPC.DCBZ: case PPC.ICBI:
      inst.rd = -1
      inst.recordCr = false
      return inst

    case PPC.TRAP:
      // TO says which comparisons trap. All five set is `trap`, which
      // traps always and is the only form measured here; the others trap
      // only sometimes, and running one as an unconditional trap would
      // stop a program that should have carried on.
      if (fld(word, 6, 10) !== 31) return refuse(address, word, 'conditional trap')
      inst.flow = Flow.TRAP
      return inst

    default:
      return inst
  }
}

/** The XO-form arithmetic, which is looked up without its overflow bit. */
function isArithmetic(op: PpcOp): boolean {
  return op === PPC.ADD || op === PPC.SUBF || op === PPC.ADDC || op === PPC.SUBFC ||
    op === PPC.ADDE || op === PPC.SUBFE || op === PPC.ADDME || op === PPC.SUBFME ||
    op === PPC.ADDZE || op === PPC.SUBFZE || op === PPC.NEG ||
    op === PPC.MULLW || op === PPC.MULLD || op === PPC.MULHW || op === PPC.MULHWU ||
    op === PPC.MULHD || op === PPC.MULHDU ||
    op === PPC.DIVW || op === PPC.DIVWU || op === PPC.DIVD || op === PPC.DIVDU
}

function decodeFp(inst: PpcInst, word: number, address: bigint, single: boolean): PpcInst {
  inst.destFile = File.FPR
  inst.sourceFile = File.FPR
  inst.recordCr = fld(word, 31, 31) === 1
  inst.is32 = single

  // A-form first: a five-bit opcode and three source registers.
  const a = fld(word, 26, 30)
  const found = FP_A[a]
  if (found !== undefined) {
    inst.op = found
    inst.rc = fld(word, 21, 25)
    // Multiply and divide name their operands in different fields, so
    // the unused one is cleared rather than left pointing at a register
    // the instruction never reads.
    if (found === PPC.FMUL) { inst.rc = fld(word, 21, 25); inst.rb = -1 }
    if (found === PPC.FSQRT || found === PPC.FRSP) { inst.ra = -1; inst.rc = -1 }
    if (found === PPC.FADD || found === PPC.FSUB || found === PPC.FDIV) inst.rc = -1
    return inst
  }

  const xo = fld(word, 21, 30)
  const x = FP_X[xo]
  if (x === undefined) return refuse(address, word, `primary ${single ? 59 : 63} extended ${xo}`)
  inst.op = x
  switch (x) {
    case PPC.FCMPU: case PPC.FCMPO:
      inst.crField = fld(word, 6, 8)
      inst.rd = -1
      inst.destFile = File.CR
      return inst
    case PPC.FMR: case PPC.FNEG: case PPC.FABS: case PPC.FNABS:
    case PPC.FCFID: case PPC.FRSP:
      inst.ra = -1
      return inst
    case PPC.MFFS:
      inst.ra = -1; inst.rb = -1
      return inst
    case PPC.MTFSF:
      inst.rd = -1
      return inst
    default:
      return inst
  }
}

function decodeVsx(inst: PpcInst, word: number, address: bigint): PpcInst {
  inst.destFile = File.VSR
  inst.sourceFile = File.VSR
  inst.recordCr = false

  // Every VSX register number is six bits with the top one kept at the
  // bottom of the word, because the five-bit fields were already spoken
  // for when the extension was added.
  const xt = fld(word, 6, 10) | (fld(word, 31, 31) << 5)
  const xa = fld(word, 11, 15) | (fld(word, 29, 29) << 5)
  const xb = fld(word, 16, 20) | (fld(word, 30, 30) << 5)

  // `xxsel` is the one four-operand form, recognised by two bits alone:
  // 26 and 27 both set. It is checked first because its third source
  // occupies bits 21 to 25, which would otherwise be read as part of an
  // opcode. No entry in the tables below has both bits set.
  if (fld(word, 26, 27) === 3) {
    inst.op = PPC.XXSEL
    inst.rd = xt; inst.ra = xa; inst.rb = xb
    inst.rc = fld(word, 21, 25) | (fld(word, 28, 28) << 5)
    return inst
  }

  const three = fld(word, 21, 28)
  const found = XX3[three]
  if (found !== undefined) {
    inst.op = found
    inst.rd = xt
    inst.ra = xa
    inst.rb = xb
    // The multiply-add family reads its destination as a third source,
    // and *which* role it plays is the difference between the two forms
    // the architecture provides. In the `a` form the destination is the
    // addend -- `XT <- (XA * XB) + XT`, which is what a saxpy wants --
    // and in the `m` form it is a multiplicand: `XT <- (XA * XT) + XB`.
    // They differ by eight in the opcode and by everything in the
    // answer, and getting them the wrong way round produces a plausible
    // number from the right three operands.
    //
    // Both are normalised here to the shape the classic floating-point
    // forms already use: multiply `ra` by `rc`, add `rb`.
    if (found === PPC.XSMADD || found === PPC.XSMSUB ||
        found === PPC.XSNMADD || found === PPC.XSNMSUB) {
      const multiplyForm = (three & 8) !== 0
      inst.rc = multiplyForm ? xt : xb
      inst.rb = multiplyForm ? xb : xt
    }
    if (found === PPC.XSCMP) {
      inst.crField = fld(word, 6, 8)
      inst.destFile = File.CR
      inst.rd = -1
    }
    if (found === PPC.XXLOGIC) inst.shift = three
    return inst
  }

  const two = fld(word, 21, 29)
  const second = XX2[two]
  if (second !== undefined) {
    inst.op = second
    inst.rd = xt
    inst.rb = xb
    inst.ra = -1
    inst.shift = two
    // `xxspltw` names the word it splats in the two bits that would be
    // the top of the A field.
    if (second === PPC.XXSPLTW) inst.imm = BigInt(fld(word, 14, 15))
    return inst
  }

  // `xxpermdi` and `xxsldwi` give up two of their opcode bits to an
  // operand -- the doubleword selector and the word shift -- so they are
  // five bits wide and are looked up after the wider tables have missed.
  // `xxswapd` is `xxpermdi` with the selector set to two.
  if (fld(word, 21, 21) === 0 && fld(word, 24, 28) === 10) {
    inst.op = PPC.XXPERMDI
    inst.rd = xt; inst.ra = xa; inst.rb = xb
    inst.imm = BigInt(fld(word, 22, 23))
    return inst
  }
  if (fld(word, 21, 21) === 0 && fld(word, 24, 28) === 2) {
    inst.op = PPC.XXSLDWI
    inst.rd = xt; inst.ra = xa; inst.rb = xb
    inst.imm = BigInt(fld(word, 22, 23))
    return inst
  }

  return refuse(address, word, `vsx extended ${three} / ${two}`)
}

export function illegal(address: bigint, word: number): never {
  const raw = Uint8Array.from([
    word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff,
  ])
  throw new IllegalInstruction(ISA_NAME, address, raw)
}
