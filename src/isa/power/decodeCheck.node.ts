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
 * Membership rather than equality is doing real work here. `li` is an
 * `addi` from r0, but so is `la`; `mr` and `nop` are both `or`. The
 * check is that the decoder produced *one of* the instructions the
 * disassembler's name can stand for, which is the strongest statement
 * that does not require reimplementing the disassembler.
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

  // Every branch is one of three instructions.
  b: [PPC.B], ba: [PPC.B], bl: [PPC.B], bla: [PPC.B],
  blr: [PPC.BCLR], blrl: [PPC.BCLR], bctr: [PPC.BCCTR], bctrl: [PPC.BCCTR],
  bt: [PPC.BC], bf: [PPC.BC], bdnz: [PPC.BC], bdz: [PPC.BC],
  bdnzt: [PPC.BC], bdnzf: [PPC.BC], bdzt: [PPC.BC], bdzf: [PPC.BC],
  bc: [PPC.BC], bcl: [PPC.BC], bclr: [PPC.BCLR], bcctr: [PPC.BCCTR],
  btlr: [PPC.BCLR], bflr: [PPC.BCLR], btctr: [PPC.BCCTR], bfctr: [PPC.BCCTR],
  bdnzlr: [PPC.BCLR], bdzlr: [PPC.BCLR],

  // Moving to and from the special registers, each spelled as its own
  // instruction even though there is one encoding.
  mflr: [PPC.MFSPR], mtlr: [PPC.MTSPR],
  mfctr: [PPC.MFSPR], mtctr: [PPC.MTSPR],
  mfxer: [PPC.MFSPR], mtxer: [PPC.MTSPR],
  mfspr: [PPC.MFSPR], mtspr: [PPC.MTSPR],
  mftb: [PPC.MFSPR], mfvrsave: [PPC.MFSPR], mtvrsave: [PPC.MTSPR],
  mtcr: [PPC.MTCRF], mtcrf: [PPC.MTCRF], mtocrf: [PPC.MTCRF],

  // The condition-register logic, where the same-operand case is named
  // after what it does rather than what it is.
  crset: [PPC.CREQV], crclr: [PPC.CRXOR], crmove: [PPC.CROR], crnot: [PPC.CRNOR],

  // `isel` with a fixed condition, which is how a compiler spells a
  // select without a branch.
  iselgt: [PPC.ISEL], isellt: [PPC.ISEL], iseleq: [PPC.ISEL], isel: [PPC.ISEL],

  // Ordering and cache hints, several of which share an encoding.
  sync: [PPC.SYNC], lwsync: [PPC.SYNC], hwsync: [PPC.SYNC], msync: [PPC.SYNC],
  eieio: [PPC.SYNC], ptesync: [PPC.SYNC], isync: [PPC.ISYNC],
  dcbz: [PPC.DCBZ], icbi: [PPC.ICBI],
  dcbt: [PPC.NOP_CACHE], dcbtst: [PPC.NOP_CACHE], dcbst: [PPC.NOP_CACHE],
  dcbf: [PPC.NOP_CACHE],
  trap: [PPC.TRAP], tw: [PPC.TRAP], td: [PPC.TRAP], twi: [PPC.TRAP], tdi: [PPC.TRAP],
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

/**
 * The VSX arithmetic, generated rather than listed.
 *
 * Every one of these exists in a scalar and a vector form and in single
 * and double precision, which is four spellings of one operation, and
 * the multiply-adds exist in two more for which operand is accumulated
 * into. Writing them out by hand is how a typo gets into the table that
 * is supposed to be catching typos.
 */
const GENERATED: Record<string, readonly number[]> = { ...ALIASES }
for (const [stem, scalar, vector] of [
  ['add', PPC.XSADD, PPC.XVADD], ['sub', PPC.XSSUB, PPC.XVADD],
  ['mul', PPC.XSMUL, PPC.XVMUL], ['div', PPC.XSDIV, PPC.XVMUL],
] as const) {
  for (const precision of ['sp', 'dp']) {
    GENERATED[`xs${stem}${precision}`] = [scalar]
    GENERATED[`xv${stem}${precision}`] = [vector]
  }
}
for (const [stem, op] of [
  ['madda', PPC.XSMADD], ['maddm', PPC.XSMADD],
  ['msuba', PPC.XSMSUB], ['msubm', PPC.XSMSUB],
  ['nmadda', PPC.XSNMADD], ['nmaddm', PPC.XSNMADD],
  ['nmsuba', PPC.XSNMSUB], ['nmsubm', PPC.XSNMSUB],
] as const) {
  for (const precision of ['sp', 'dp']) GENERATED[`xs${stem}${precision}`] = [op]
}
for (const precision of ['sp', 'dp']) {
  GENERATED[`xssqrt${precision}`] = [PPC.XSSQRT]
  GENERATED[`xsrdpi`] = [PPC.XSRDPI]
  GENERATED[`xscmpodp`] = [PPC.XSCMP]
  GENERATED[`xscmpudp`] = [PPC.XSCMP]
  void precision
}
for (const name of ['xsnegdp', 'xsnegsp']) GENERATED[name] = [PPC.XSNEG]
for (const name of ['xsabsdp', 'xsabssp']) GENERATED[name] = [PPC.XSABS]
for (const name of ['xsnabsdp', 'xsnabssp']) GENERATED[name] = [PPC.XSNABS]
for (const name of ['xscpsgndp', 'xscpsgnsp']) GENERATED[name] = [PPC.XSCPSGN]
for (const name of ['xsmaxdp', 'xsmaxsp']) GENERATED[name] = [PPC.XSMAX]
for (const name of ['xsmindp', 'xsminsp']) GENERATED[name] = [PPC.XSMIN]
// The bitwise operations and the conversions are not listed here at all.
// Each is one operation to the interpreter, which picks the behaviour from
// a field, so they are *refined* to one name apiece in `decode` below
// rather than admitted by membership -- membership would let a decoder
// that confused `xxland` with `xxlor` pass.

/**
 * A branch may be printed with a `+` or `-` on the end.
 *
 * That is the static prediction hint, which lives in the same `BO`
 * field as the condition and changes nothing about what the branch
 * does. The disassembler attaches it to the mnemonic rather than
 * printing it as an operand, so each branch has two more spellings.
 */
for (const [name, ops] of Object.entries({ ...GENERATED })) {
  if (/^bd?[a-z]*$/.test(name) && ops.some((op) =>
    op === PPC.BC || op === PPC.BCLR || op === PPC.BCCTR)) {
    GENERATED[`${name}+`] = ops
    GENERATED[`${name}-`] = ops
  }
}

/**
 * Operations the interpreter keeps as one and selects between by a field.
 *
 * Reported to the tier under a distinct identity per behaviour, so that
 * the check is of the field as well as the opcode. The identities are
 * offset far above the real ones so they cannot collide.
 */
const REFINED_BASE = 10_000

/**
 * The name an instruction must have, given the fields the interpreter
 * actually acts on.
 *
 * For the operations where one identity covers several instructions --
 * a load is a load whatever its width -- the check has to be of the
 * fields, or a decoder that read the width wrong would pass. This is
 * where three real mistakes hid: `stfiwx` decoded as `stfsx`, `mfocrf`
 * as `mfcr`, and the word merges as a doubleword permute, each admitted
 * because the name was in the set the operation could stand for.
 *
 * Returns undefined for the operations whose identity is already exact.
 */
function signature(inst: PpcInst): string | undefined {
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

/** Every signature, numbered once so a name maps to one stable identity. */
const SIGNATURES: string[] = []
function signatureId(name: string): number {
  let index = SIGNATURES.indexOf(name)
  if (index < 0) index = SIGNATURES.push(name) - 1
  return REFINED_BASE + 5000 + index
}

/**
 * Second spellings the disassembler uses for the same instruction.
 * `mffprd` is `mfvsrd` named for the floating-point half it reads.
 */
const SIGNATURE_SPELLINGS: Readonly<Record<string, string>> = {
  mffprd: 'mfvsrd', mffprwz: 'mfvsrwz',
  mtfprd: 'mtvsrd', mtfprwa: 'mtvsrwa', mtfprwz: 'mtvsrwz',
}
for (const [spelling, canonical] of Object.entries(SIGNATURE_SPELLINGS)) {
  GENERATED[spelling] = [signatureId(canonical)]
}
// A compare with a field other than cr0 is still printed as the same
// mnemonic, so nothing more is needed for those.
const LOGIC_NAMES = [
  'xxland', 'xxlandc', 'xxlor', 'xxlxor', 'xxlnor', 'xxlorc', 'xxlnand', 'xxleqv',
]
/** Measured spellings of the conversions, keyed on their nine-bit opcode. */
const CONVERSION_NAMES: Readonly<Record<number, string>> = {
  72: 'xscvdpuxws', 88: 'xscvdpsxws', 344: 'xscvdpsxds',
  360: 'xscvuxddp', 376: 'xscvsxddp', 248: 'xvcvsxwdp',
}

export const powerDecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    // Little-endian in memory; the bit numbering inside is the other
    // way round, which the decoder handles.
    const word = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) |
      (bytes[3]! << 24)) >>> 0
    const inst = decode(word, address)
    const named = signature(inst)
    if (named !== undefined) return { op: signatureId(named), length: 4 }
    if (inst.op === PPC.XXLOGIC) {
      return { op: REFINED_BASE + (inst.shift - 130) / 8, length: 4 }
    }
    if (inst.op === PPC.XSCVT || inst.op === PPC.XVCVT) {
      return { op: REFINED_BASE + 1000 + inst.shift, length: 4 }
    }
    return { op: inst.op, length: 4 }
  },
  name(op) {
    if (op >= REFINED_BASE + 5000) return SIGNATURES[op - REFINED_BASE - 5000] ?? `?sig${op}`
    if (op >= REFINED_BASE + 1000) {
      return CONVERSION_NAMES[op - REFINED_BASE - 1000] ?? `?cvt${op}`
    }
    if (op >= REFINED_BASE) return LOGIC_NAMES[op - REFINED_BASE] ?? `?logic${op}`
    return PPC_NAME[op] ?? `?${op}`
  },
  aliases: GENERATED,
  ignored: ['<unknown>', '.long', '.word'],
}
