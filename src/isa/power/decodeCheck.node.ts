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
import { PPC, PPC_NAME, decode } from './decode.ts'
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
  'mullw.': [PPC.MULLW], 'mulld.': [PPC.MULLD],
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

  // Comparison, whose width is a field rather than part of the name.
  cmpw: [PPC.CMP], cmpd: [PPC.CMP], cmplw: [PPC.CMPL], cmpld: [PPC.CMPL],
  cmpwi: [PPC.CMPI], cmpdi: [PPC.CMPI],
  cmplwi: [PPC.CMPLI], cmpldi: [PPC.CMPLI],

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
  mfcr: [PPC.MFCR], mfocrf: [PPC.MFCR], mtcr: [PPC.MTCRF], mtcrf: [PPC.MTCRF], mtocrf: [PPC.MTCRF],

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

  // Loads and stores: the width and the sign are fields here, so all of
  // these are four operations.
  lbz: [PPC.LOAD], lhz: [PPC.LOAD], lha: [PPC.LOAD], lwz: [PPC.LOAD],
  lwa: [PPC.LOAD], ld: [PPC.LOAD], lfs: [PPC.LOAD], lfd: [PPC.LOAD],
  lbzu: [PPC.LOADU], lhzu: [PPC.LOADU], lhau: [PPC.LOADU], lwzu: [PPC.LOADU],
  ldu: [PPC.LOADU], lfsu: [PPC.LOADU], lfdu: [PPC.LOADU],
  stb: [PPC.STORE], sth: [PPC.STORE], stw: [PPC.STORE], std: [PPC.STORE],
  stfs: [PPC.STORE], stfd: [PPC.STORE],
  stbu: [PPC.STOREU], sthu: [PPC.STOREU], stwu: [PPC.STOREU], stdu: [PPC.STOREU],
  stfsu: [PPC.STOREU], stfdu: [PPC.STOREU],
  lbzx: [PPC.LOADX], lhzx: [PPC.LOADX], lhax: [PPC.LOADX], lwzx: [PPC.LOADX],
  lwax: [PPC.LOADX], ldx: [PPC.LOADX], lfsx: [PPC.LOADX], lfdx: [PPC.LOADX],
  lbzux: [PPC.LOADUX], lhzux: [PPC.LOADUX], lhaux: [PPC.LOADUX],
  lwzux: [PPC.LOADUX], lwaux: [PPC.LOADUX], ldux: [PPC.LOADUX],
  stbx: [PPC.STOREX], sthx: [PPC.STOREX], stwx: [PPC.STOREX], stdx: [PPC.STOREX],
  stfsx: [PPC.STOREX], stfdx: [PPC.STOREX],
  stbux: [PPC.STOREUX], sthux: [PPC.STOREUX], stwux: [PPC.STOREUX],
  stdux: [PPC.STOREUX],
  lhbrx: [PPC.LOADBR], lwbrx: [PPC.LOADBR], ldbrx: [PPC.LOADBR],
  sthbrx: [PPC.STOREBR], stwbrx: [PPC.STOREBR], stdbrx: [PPC.STOREBR],
  lwarx: [PPC.LARX], ldarx: [PPC.LARX],
  'stwcx.': [PPC.STCX], 'stdcx.': [PPC.STCX],

  // The classic floating-point unit, where single and double are the
  // same operation in a different primary opcode.
  fadd: [PPC.FADD], fadds: [PPC.FADD], fsub: [PPC.FSUB], fsubs: [PPC.FSUB],
  fmul: [PPC.FMUL], fmuls: [PPC.FMUL], fdiv: [PPC.FDIV], fdivs: [PPC.FDIV],
  fsqrt: [PPC.FSQRT], fsqrts: [PPC.FSQRT],
  fmadd: [PPC.FMADD], fmadds: [PPC.FMADD],
  fmsub: [PPC.FMSUB], fmsubs: [PPC.FMSUB],
  fnmadd: [PPC.FNMADD], fnmadds: [PPC.FNMADD],
  fnmsub: [PPC.FNMSUB], fnmsubs: [PPC.FNMSUB],
  fmr: [PPC.FMR], 'fmr.': [PPC.FMR], fneg: [PPC.FNEG], fabs: [PPC.FABS],
  fnabs: [PPC.FNABS], fsel: [PPC.FSEL], frsp: [PPC.FRSP],
  fcmpu: [PPC.FCMPU], fcmpo: [PPC.FCMPO],
  fctid: [PPC.FCTID], fctidz: [PPC.FCTID], fctiw: [PPC.FCTIW],
  fctiwz: [PPC.FCTIW], fcfid: [PPC.FCFID],
  frin: [PPC.FRIN], friz: [PPC.FRIN], frip: [PPC.FRIN], frim: [PPC.FRIN],
  mffs: [PPC.MFFS], mtfsf: [PPC.MTFSF],

  // Moving between the register files, which have one encoding each
  // and several names.
  mfvsrd: [PPC.MFVSR], mfvsrwz: [PPC.MFVSR], mffprd: [PPC.MFVSR],
  mffprwz: [PPC.MFVSR],
  mtvsrd: [PPC.MTVSR], mtvsrwa: [PPC.MTVSR], mtvsrwz: [PPC.MTVSR],
  mtfprd: [PPC.MTVSR], mtfprwa: [PPC.MTVSR], mtfprwz: [PPC.MTVSR],

  // VSX memory.
  lxvd2x: [PPC.LXV], lxvw4x: [PPC.LXV], lxvdsx: [PPC.LXV], lxsdx: [PPC.LXV],
  lxsiwzx: [PPC.LXV], lxsiwax: [PPC.LXV],
  stxvd2x: [PPC.STXV], stxvw4x: [PPC.STXV], stxsdx: [PPC.STXV],
  stfiwx: [PPC.STOREX],
  // The Altivec operations, which are one entry each because what they
  // compute lives in a field rather than in the operation.
  vadduwm: [PPC.VOP], vmuluwm: [PPC.VOP], vslw: [PPC.VOP], vsrw: [PPC.VOP],
  vperm: [PPC.VOP], vsel: [PPC.VOP], vand: [PPC.VOP], vor: [PPC.VOP],
  vxor: [PPC.VOP], vnor: [PPC.VOP],
  xxswapd: [PPC.XXPERM],

  // Altivec.
  vspltisw: [PPC.VSPLTISW], vspltish: [PPC.VSPLTISW], vspltisb: [PPC.VSPLTISW],
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
for (const name of ['xxland', 'xxlandc', 'xxlor', 'xxlxor', 'xxlnor',
  'xxlorc', 'xxlnand', 'xxleqv']) GENERATED[name] = [PPC.XXLOGIC]
for (const name of ['xxsel']) GENERATED[name] = [PPC.XXSEL]
for (const name of ['xxpermdi', 'xxmrghw', 'xxmrglw', 'xxsldwi']) {
  GENERATED[name] = [PPC.XXPERM]
}
for (const name of ['xxspltw', 'xxspltd']) GENERATED[name] = [PPC.XXSPLT]
// The conversions, whose names spell both formats.
for (const from of ['sx', 'ux', 'sp', 'dp', 'sxd', 'uxd', 'sxw', 'uxw']) {
  for (const to of ['dp', 'sp', 'sxds', 'uxds', 'sxws', 'uxws', 'dpo']) {
    GENERATED[`xscv${from}${to}`] = [PPC.XSCVT]
    GENERATED[`xvcv${from}${to}`] = [PPC.XVCVT]
  }
}

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

export const powerDecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    // Little-endian in memory; the bit numbering inside is the other
    // way round, which the decoder handles.
    const word = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) |
      (bytes[3]! << 24)) >>> 0
    return { op: decode(word, address).op, length: 4 }
  },
  name(op) {
    return PPC_NAME[op] ?? `?${op}`
  },
  aliases: GENERATED,
  ignored: ['<unknown>', '.long', '.word'],
}
