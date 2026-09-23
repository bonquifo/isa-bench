/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * The longest of these tables by a wide margin, and that is the fact
 * about POWER rather than an accident of how it was written. Almost
 * nothing a compiler emits here is spelled as the instruction it is:
 * `li` and `lis` are adds, `mr` and `nop` and `not` are ors, `sub` is a
 * subtract with its operands the other way round, every branch
 * condition is one conditional branch with a different `BO`/`BI` pair,
 * and the entire shift-and-mask vocabulary -- `sldi`, `srdi`, `clrldi`,
 * `clrlwi`, `extldi`, `rotlwi` and a dozen more -- is four rotate
 * instructions underneath.
 *
 * Membership is right for those: `li` is an `addi` from r0, and so is
 * `la`; `mr` and `nop` are both `or`, and which one is printed is a
 * matter of operands the lockstep tier checks. It is wrong wherever the
 * name reflects a *field* the interpreter acts on -- a width, a
 * precision, a branch condition -- and those are checked by signature
 * instead, further down.
 */
import { File, PPC, PPC_NAME, decode, type PpcInst } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

const ALIASES: Readonly<Record<string, readonly number[]>> = {
  // r0 reads as zero in the places that matter, which is what makes an
  // add into a load-immediate.
  li: [PPC.ADDI], la: [PPC.ADDI], lis: [PPC.ADDIS],
  subi: [PPC.ADDI], subis: [PPC.ADDIS], subic: [PPC.ADDIC],
  'subic.': [PPC.ADDIC],
  mr: [PPC.OR], 'mr.': [PPC.OR], nop: [PPC.ORI], not: [PPC.NOR], 'not.': [PPC.NOR],
  sub: [PPC.SUBF], 'sub.': [PPC.SUBF], subc: [PPC.SUBFC],
  // The record-form suffix is part of the printed name.
  'add.': [PPC.ADD], 'subf.': [PPC.SUBF], 'and.': [PPC.AND], 'or.': [PPC.OR],
  'xor.': [PPC.XOR], 'nand.': [PPC.NAND], 'nor.': [PPC.NOR], 'eqv.': [PPC.EQV],
  'andc.': [PPC.ANDC], 'orc.': [PPC.ORC],
  'mullw.': [PPC.MULLW], 'mulld.': [PPC.MULLD], 'mulhdu.': [PPC.MULHDU],
  'divw.': [PPC.DIVW], 'divd.': [PPC.DIVD],
  'divwu.': [PPC.DIVWU], 'divdu.': [PPC.DIVDU],
  'neg.': [PPC.NEG], 'extsb.': [PPC.EXTSB], 'extsh.': [PPC.EXTSH],
  'extsw.': [PPC.EXTSW], 'cntlzw.': [PPC.CNTLZW], 'cntlzd.': [PPC.CNTLZD],
  'addc.': [PPC.ADDC], 'adde.': [PPC.ADDE], 'subfc.': [PPC.SUBFC],
  'subfe.': [PPC.SUBFE], 'addze.': [PPC.ADDZE], 'subfze.': [PPC.SUBFZE],
  'addme.': [PPC.ADDME], 'subfme.': [PPC.SUBFME],
  'slw.': [PPC.SLW], 'srw.': [PPC.SRW], 'sraw.': [PPC.SRAW],
  'sld.': [PPC.SLD], 'srd.': [PPC.SRD], 'srad.': [PPC.SRAD],
  'srawi.': [PPC.SRAWI], 'sradi.': [PPC.SRADI],
  'andi.': [PPC.ANDI], 'andis.': [PPC.ANDIS],

  // The rotate family, which is where most of the names come from.
  slwi: [PPC.RLWINM], 'slwi.': [PPC.RLWINM],
  srwi: [PPC.RLWINM], 'srwi.': [PPC.RLWINM],
  clrlwi: [PPC.RLWINM], 'clrlwi.': [PPC.RLWINM],
  clrrwi: [PPC.RLWINM], 'clrrwi.': [PPC.RLWINM],
  extlwi: [PPC.RLWINM], extrwi: [PPC.RLWINM],
  rotlwi: [PPC.RLWINM], rotrwi: [PPC.RLWINM], rotlw: [PPC.RLWNM],
  inslwi: [PPC.RLWIMI], insrwi: [PPC.RLWIMI],
  'rlwinm.': [PPC.RLWINM], 'rlwimi.': [PPC.RLWIMI], 'rlwnm.': [PPC.RLWNM],
  sldi: [PPC.RLDICR], 'sldi.': [PPC.RLDICR],
  srdi: [PPC.RLDICL], 'srdi.': [PPC.RLDICL],
  clrldi: [PPC.RLDICL], 'clrldi.': [PPC.RLDICL],
  clrrdi: [PPC.RLDICR], 'clrrdi.': [PPC.RLDICR],
  extldi: [PPC.RLDICR], extrdi: [PPC.RLDICL],
  rotldi: [PPC.RLDICL], rotrdi: [PPC.RLDICL], rotld: [PPC.RLDCL],
  insrdi: [PPC.RLDIMI],
  'rldicl.': [PPC.RLDICL], 'rldicr.': [PPC.RLDICR], 'rldic.': [PPC.RLDIC],
  'rldimi.': [PPC.RLDIMI], 'rldcl.': [PPC.RLDCL], 'rldcr.': [PPC.RLDCR],

  // Comparisons are checked by signature below: their width is a field,
  // and `cmpw` and `cmpd` are different questions.

  // Branches, the special-register moves, `isel` and `trap` are checked
  // by signature below: what a branch tests, which register is moved and
  // which bit is selected on are fields, and each changes the result.

  // One field or all of them, which for a single-bit mask is the same.
  mtcr: [PPC.MTCRF], mtcrf: [PPC.MTCRF], mtocrf: [PPC.MTCRF],

  // The condition-register logic, where the same-operand case is named
  // after what it does rather than what it is.
  crset: [PPC.CREQV], crclr: [PPC.CRXOR], crmove: [PPC.CROR], crnot: [PPC.CRNOR],

  // Ordering and cache hints, several of which share an encoding.
  sync: [PPC.SYNC], lwsync: [PPC.SYNC], hwsync: [PPC.SYNC], msync: [PPC.SYNC],
  eieio: [PPC.SYNC], ptesync: [PPC.SYNC], isync: [PPC.ISYNC],
  dcbz: [PPC.DCBZ], icbi: [PPC.ICBI],
  dcbt: [PPC.NOP_CACHE], dcbtst: [PPC.NOP_CACHE], dcbst: [PPC.NOP_CACHE],
  dcbf: [PPC.NOP_CACHE],
  'sc': [PPC.SC],

  // Loads and stores are checked by signature below. The width, the
  // sign and the register file are fields, and `lfs` and `lwz` -- one
  // converts a single to a double on the way in -- are the same
  // operation with a different field.
  lhbrx: [PPC.LOADBR], lwbrx: [PPC.LOADBR], ldbrx: [PPC.LOADBR],
  sthbrx: [PPC.STOREBR], stwbrx: [PPC.STOREBR], stdbrx: [PPC.STOREBR],
  lwarx: [PPC.LARX], ldarx: [PPC.LARX],
  'stwcx.': [PPC.STCX], 'stdcx.': [PPC.STCX],

  // The classic floating-point arithmetic is checked by signature below:
  // single and double are the same operation with a precision flag, and
  // the flag decides the rounding.
  fmr: [PPC.FMR], 'fmr.': [PPC.FMR], fneg: [PPC.FNEG], fabs: [PPC.FABS],
  fnabs: [PPC.FNABS], fsel: [PPC.FSEL], frsp: [PPC.FRSP],
  fcmpu: [PPC.FCMPU], fcmpo: [PPC.FCMPO],
  fcfid: [PPC.FCFID],
  mffs: [PPC.MFFS], mtfsf: [PPC.MTFSF],

  // Moving between the register files, which have one encoding each
  // and several names.
  // The register-file moves are checked by signature below; the `fpr`
  // spellings are the same instructions under a second name.

  // VSX memory needs no entries: each form is its own operation, named as
  // the disassembler names it.
  // The Altivec operations need no entries either: each is its own
  // operation. They were once all one, admitted here by membership, which
  // meant the tier could not tell `vadduwm` from `vsubuwm`.
  //
  // What *is* an alias is `xxpermdi` with a particular selector, which the
  // disassembler prints under four names of its own.
  xxswapd: [PPC.XXPERMDI], xxmrghd: [PPC.XXPERMDI],
  xxmrgld: [PPC.XXPERMDI], xxspltd: [PPC.XXPERMDI],
}

const GENERATED: Record<string, readonly number[]> = { ...ALIASES }

/** The bitwise operations, spaced by eight from 130. */
const LOGIC_NAMES = [
  'xxland', 'xxlandc', 'xxlor', 'xxlxor', 'xxlnor', 'xxlorc', 'xxlnand', 'xxleqv',
]
/** Measured spellings of the conversions, keyed on their nine-bit opcode. */
const CONVERSION_NAMES: Readonly<Record<number, string>> = {
  72: 'xscvdpuxws', 88: 'xscvdpsxws', 344: 'xscvdpsxds',
  360: 'xscvuxddp', 376: 'xscvsxddp', 248: 'xvcvsxwdp',
}

/**
 * Second spellings the disassembler uses for the same instruction.
 * `mffprd` is `mfvsrd` named for the floating-point half it reads.
 */
const SECOND_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  mfvsrd: ['mffprd'], mfvsrwz: ['mffprwz'],
  mtvsrd: ['mtfprd'], mtvsrwa: ['mtfprwa'], mtvsrwz: ['mtfprwz'],
}

/** The special registers the disassembler has a name for. */
const SPR_NAMES: Readonly<Record<number, string>> = {
  1: 'xer', 8: 'lr', 9: 'ctr', 256: 'vrsave', 268: 'tb',
}

/** The double-precision scalar operations, each of which is one name. */
const SCALAR_NAMES: ReadonlyMap<number, readonly string[]> = new Map([
  [PPC.XSADD, ['xsadddp']], [PPC.XSSUB, ['xssubdp']],
  [PPC.XSMUL, ['xsmuldp']], [PPC.XSDIV, ['xsdivdp']],
  [PPC.XSSQRT, ['xssqrtdp']], [PPC.XSNEG, ['xsnegdp']],
  [PPC.XSCPSGN, ['xscpsgndp']],
  // Unordered and ordered differ only in which NaNs raise an exception,
  // which nothing here observes.
  [PPC.XSCMP, ['xscmpudp', 'xscmpodp']],
])

/** The fused multiply-adds, by operation. */
const FUSED_STEMS: ReadonlyMap<number, string> = new Map([
  [PPC.XSMADD, 'madd'], [PPC.XSMSUB, 'msub'],
  [PPC.XSNMADD, 'nmadd'], [PPC.XSNMSUB, 'nmsub'],
])

/**
 * A conditional branch's name, from BO.
 *
 * BO says whether the condition register is tested and for which value,
 * whether the count register is decremented and tested for zero, and --
 * in the bits neither of those uses -- which way the branch is likely to
 * go. The last is printed as a trailing `+` or `-` and changes nothing
 * the branch does, but the first two are the whole of what it does: a
 * decoder that read BO wrongly branches on the wrong thing.
 *
 * The generic spelling (`bc`, `bclr`, `bcctr`) is admitted as well,
 * because the disassembler falls back to it with BO printed as an
 * operand, where the lockstep tier checks it.
 */
function branchNames(inst: PpcInst, to: '' | 'lr' | 'ctr'): readonly string[] {
  const { bo } = inst
  const link = inst.link ? 'l' : ''
  const testsCr = (bo & 0b10000) === 0
  const decrements = (bo & 0b00100) === 0
  const generic = `bc${to}${link}`
  if (!testsCr && !decrements) return [`b${to}${link}`, generic]
  const onTrue = (bo & 0b01000) !== 0 ? 't' : 'f'
  const onZero = (bo & 0b00010) !== 0 ? 'z' : 'nz'
  let stem: string
  let hints: readonly string[]
  if (!decrements) {
    stem = `b${onTrue}`
    // BO = 0b0x1at: `at` of 11 is likely, 10 unlikely, 00 no hint.
    const at = bo & 0b11
    hints = [at === 3 ? '+' : at === 2 ? '-' : '']
  } else if (!testsCr) {
    stem = `bd${onZero}`
    // BO = 0b1a0zt: `a` set means a hint is given, and `t` which way.
    hints = [(bo & 0b01000) === 0 ? '' : (bo & 1) !== 0 ? '+' : '-']
  } else {
    stem = `bd${onZero}${onTrue}`
    hints = ['', '+', '-']
  }
  return [...hints.map((hint) => `${stem}${to}${link}${hint}`), generic]
}

/**
 * The names the decoded fields imply.
 *
 * For the operations where one identity covers several instructions --
 * a load is a load whatever its width, a conditional branch is one
 * operation whatever it tests -- the check has to be of the fields, or a
 * decoder that read them wrong would pass. This is where three real
 * mistakes hid: `stfiwx` decoded as `stfsx`, `mfocrf` as `mfcr`, and the
 * word merges as a doubleword permute, each admitted because the name was
 * in the set the operation could stand for.
 *
 * Returns undefined for the operations whose identity is already exact,
 * or whose remaining spellings differ only by operand -- `mr` is `or` with
 * one register twice -- which the lockstep tier checks as it executes.
 */
function signature(inst: PpcInst): readonly string[] | undefined {
  const named = fieldName(inst)
  if (named !== undefined) return [named, ...(SECOND_SPELLINGS[named] ?? [])]
  const scalar = SCALAR_NAMES.get(inst.op)
  if (scalar !== undefined) return scalar
  const fused = FUSED_STEMS.get(inst.op)
  if (fused !== undefined) {
    // The `a` form accumulates into its destination and the `m` form
    // multiplies by it. When the other source is the same register the
    // two compute the same thing, and either name is right.
    const accumulates = inst.rb === inst.rd
    const multiplies = inst.rc === inst.rd
    return [
      ...(accumulates ? [`xs${fused}adp`] : []),
      ...(multiplies ? [`xs${fused}mdp`] : []),
    ]
  }
  switch (inst.op) {
    case PPC.XXLOGIC: return [LOGIC_NAMES[(inst.shift - 130) / 8] ?? '?']
    case PPC.XSCVT: case PPC.XVCVT: return [CONVERSION_NAMES[inst.shift] ?? '?']
    case PPC.B: return inst.link ? ['bl', 'bla'] : ['b', 'ba']
    case PPC.BC: return branchNames(inst, '')
    case PPC.BCLR: return branchNames(inst, 'lr')
    case PPC.BCCTR: return branchNames(inst, 'ctr')
    case PPC.MFSPR: return [SPR_NAMES[inst.spr] ? `mf${SPR_NAMES[inst.spr]}` : 'mfspr']
    case PPC.MTSPR: return [SPR_NAMES[inst.spr] ? `mt${SPR_NAMES[inst.spr]}` : 'mtspr']
    // With a condition bit in cr0, `isel` is printed as the test it makes.
    case PPC.ISEL: return [(['isellt', 'iselgt', 'iseleq'] as const)[inst.bi] ?? 'isel']
    // The only traps the decoder accepts are the unconditional ones, which
    // the disassembler spells by width.
    case PPC.TRAP: return ['trap', 'tdu']
    default: return undefined
  }
}

/**
 * The name an instruction must have, given the fields the interpreter
 * acts on, for the operations that pick a width, a sign or a register file
 * from a field.
 */
function fieldName(inst: PpcInst): string | undefined {
  const fpr = inst.destFile === File.FPR || inst.sourceFile === File.FPR
  const suffix = (update: boolean, indexed: boolean): string =>
    (update ? 'u' : '') + (indexed ? 'x' : '')
  switch (inst.op) {
    case PPC.LOAD: case PPC.LOADU: case PPC.LOADX: case PPC.LOADUX: {
      const update = inst.op === PPC.LOADU || inst.op === PPC.LOADUX
      const indexed = inst.op === PPC.LOADX || inst.op === PPC.LOADUX
      const stem = fpr
        ? (inst.width === 4 ? 'lfs' : 'lfd')
        : inst.width === 1 ? 'lbz'
          : inst.width === 2 ? (inst.signed ? 'lha' : 'lhz')
            : inst.width === 4 ? (inst.signed ? 'lwa' : 'lwz')
              : 'ld'
      return stem + suffix(update, indexed)
    }
    case PPC.STORE: case PPC.STOREU: case PPC.STOREX: case PPC.STOREUX: {
      const update = inst.op === PPC.STOREU || inst.op === PPC.STOREUX
      const indexed = inst.op === PPC.STOREX || inst.op === PPC.STOREUX
      const stem = fpr
        ? (inst.width === 4 ? 'stfs' : 'stfd')
        : ['', 'stb', 'sth', '', 'stw', '', '', '', 'std'][inst.width] ?? '?'
      return stem + suffix(update, indexed)
    }
    case PPC.LFIW: return inst.signed ? 'lfiwax' : 'lfiwzx'
    // All eight fields, or the ones a mask names: two instructions with
    // different results, which were once one.
    case PPC.MFCR: return inst.imm === 0xffn ? 'mfcr' : 'mfocrf'
    case PPC.MFVSR: return inst.width === 8 ? 'mfvsrd' : 'mfvsrwz'
    case PPC.MTVSR:
      return inst.width === 8 ? 'mtvsrd' : inst.signed ? 'mtvsrwa' : 'mtvsrwz'
    case PPC.CMP: return inst.is32 ? 'cmpw' : 'cmpd'
    case PPC.CMPL: return inst.is32 ? 'cmplw' : 'cmpld'
    case PPC.CMPI: return inst.is32 ? 'cmpwi' : 'cmpdi'
    case PPC.CMPLI: return inst.is32 ? 'cmplwi' : 'cmpldi'
    case PPC.FADD: case PPC.FSUB: case PPC.FMUL: case PPC.FDIV: case PPC.FSQRT:
    case PPC.FMADD: case PPC.FMSUB: case PPC.FNMADD: case PPC.FNMSUB:
      return PPC_NAME[inst.op]! + (inst.is32 ? 's' : '')
    default:
      return undefined
  }
}

function decodeBytes(bytes: Uint8Array, address: bigint): PpcInst {
  // Little-endian in memory; the bit numbering inside is the other way
  // round, which the decoder handles.
  const word = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) |
    (bytes[3]! << 24)) >>> 0
  return decode(word, address)
}

export const powerDecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    return { op: decodeBytes(bytes, address).op, length: 4 }
  },
  signature(bytes, address) {
    return signature(decodeBytes(bytes, address))
  },
  name(op) {
    return PPC_NAME[op] ?? `?${op}`
  },
  aliases: GENERATED,
  ignored: ['<unknown>', '.long', '.word'],
}
