/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * Two things make x86 different from the fixed-length targets here.
 *
 * The disassembler prints the operand size in the mnemonic -- `movq`,
 * `movl`, `movw`, `movb` are one instruction at four widths -- while the
 * decoder carries the width as a field. So the name is normalised by
 * removing a suffix before it is compared, rather than by listing every
 * width of every instruction as an alias.
 *
 * And the length is not fixed, which makes this tier worth more here
 * than anywhere else: agreeing with the disassembler about where each
 * instruction *ends* is a real claim, and one that nothing else checks
 * until an interpreter walks off into the middle of an instruction and
 * produces nonsense.
 */
import { X86, X86_NAME, decode } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

/** The condition codes, as the disassembler spells them. */
const CONDITIONS = [
  'o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a',
  's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g',
  // The spellings that mean the same thing.
  'nae', 'nb', 'nc', 'c', 'z', 'nz', 'na', 'nbe',
  'pe', 'po', 'nge', 'nl', 'ng', 'nle',
]

const ALIASES: Record<string, readonly number[]> = {
  mov: [X86.MOV],
  movabs: [X86.MOV],
  movzb: [X86.MOVZX],
  movzw: [X86.MOVZX],
  movsb: [X86.MOVSX, X86.MOVS],
  movsw: [X86.MOVSX, X86.MOVS],
  movsl: [X86.MOVSX, X86.MOVS],
  movs: [X86.MOVS, X86.MOV_XMM_SCALAR],
  movsd: [X86.MOVS, X86.MOV_XMM_SCALAR],
  movss: [X86.MOV_XMM_SCALAR],
  movsxd: [X86.MOVSX],
  movsl_: [X86.MOVSX],
  lea: [X86.LEA],
  xchg: [X86.XCHG],
  nop: [X86.NOP],
  nopw: [X86.NOP],
  nopl: [X86.NOP],
  ret: [X86.RET],
  leave: [X86.LEAVE],
  call: [X86.CALL, X86.CALL_INDIRECT],
  jmp: [X86.JMP, X86.JMP_INDIRECT],
  push: [X86.PUSH],
  pop: [X86.POP],
  syscall: [X86.SYSCALL],
  int3: [X86.INT3],
  ud2: [X86.UD2],
  lahf: [X86.LAHF],
  // The accumulator-widening pair, whose four names are two operations.
  cbtw: [X86.CWDE],
  cwtl: [X86.CWDE],
  cltq: [X86.CWDE],
  cwtd: [X86.CDQ],
  cltd: [X86.CDQ],
  cqto: [X86.CDQ],
  // The string operations, with and without a repeat prefix.
  rep: [X86.MOVS, X86.STOS],
  stos: [X86.STOS],
  // The multiply and divide family.
  imul: [X86.IMUL1, X86.IMUL2],
  mul: [X86.MUL],
  div: [X86.DIV],
  idiv: [X86.IDIV],
  // Bit scanning, where the newer names are different instructions.
  bsf: [X86.BSF],
  bsr: [X86.BSR],
  tzcnt: [X86.TZCNT],
  lzcnt: [X86.LZCNT],
  popcnt: [X86.POPCNT],
  bswap: [X86.BSWAP],
  shld: [X86.SHLD],
  shrd: [X86.SHRD],
  sar: [X86.SAR],
  sal: [X86.SHL],
  shl: [X86.SHL],
  shr: [X86.SHR],
  rol: [X86.ROL],
  ror: [X86.ROR],
  // SSE, where the mnemonic names the element type and the decoder does
  // not: a 128-bit move is the same operation whatever it is moving.
  movaps: [X86.MOV_XMM],
  movapd: [X86.MOV_XMM],
  movups: [X86.MOV_XMM],
  movupd: [X86.MOV_XMM],
  movdqa: [X86.MOV_XMM],
  movdqu: [X86.MOV_XMM],
  movd: [X86.MOVD],
  movq: [X86.MOV, X86.MOVD, X86.MOVQ_XMM],
  movlps: [X86.MOV_HALF],
  movhps: [X86.MOV_HALF],
  movlpd: [X86.MOV_HALF],
  movhpd: [X86.MOV_HALF],
  movlhps: [X86.MOV_HALF_REG],
  movhlps: [X86.MOV_HALF_REG],
  xorps: [X86.XORP],
  xorpd: [X86.XORP],
  andps: [X86.ANDP],
  andpd: [X86.ANDP],
  andnps: [X86.ANDNP],
  andnpd: [X86.ANDNP],
  orps: [X86.ORP],
  orpd: [X86.ORP],
  pxor: [X86.PXOR],
  pand: [X86.PAND],
  por: [X86.POR],
  paddb: [X86.PADD],
  paddw: [X86.PADD],
  paddd: [X86.PADD],
  paddq: [X86.PADD],
  psubb: [X86.PSUB],
  psubw: [X86.PSUB],
  psubd: [X86.PSUB],
  psubq: [X86.PSUB],
  pcmpeqb: [X86.PCMPEQ],
  pcmpeqw: [X86.PCMPEQ],
  pcmpeqd: [X86.PCMPEQ],
  pcmpgtb: [X86.PCMPGT],
  pcmpgtw: [X86.PCMPGT],
  pcmpgtd: [X86.PCMPGT],
  punpcklbw: [X86.PUNPCKL],
  punpcklwd: [X86.PUNPCKL],
  punpckldq: [X86.PUNPCKL],
  punpcklqdq: [X86.PUNPCKL],
  pmuludq: [X86.PMULUDQ],
  pshufd: [X86.PSHUFD],
  addsd: [X86.ADDSD],
  addss: [X86.ADDSD],
  subsd: [X86.SUBSD],
  subss: [X86.SUBSD],
  mulsd: [X86.MULSD],
  mulss: [X86.MULSD],
  divsd: [X86.DIVSD],
  divss: [X86.DIVSD],
  sqrtsd: [X86.SQRTSD],
  sqrtss: [X86.SQRTSD],
  minsd: [X86.MINSD],
  minss: [X86.MINSD],
  maxsd: [X86.MAXSD],
  maxss: [X86.MAXSD],
  ucomisd: [X86.UCOMIS],
  ucomiss: [X86.UCOMIS],
  comisd: [X86.UCOMIS],
  comiss: [X86.UCOMIS],
  cvttsd2si: [X86.CVTTS2SI],
  cvttss2si: [X86.CVTTS2SI],
  cvtsd2si: [X86.CVTTS2SI],
  cvtss2si: [X86.CVTTS2SI],
  cvtsi2sd: [X86.CVTSI2S],
  cvtsi2ss: [X86.CVTSI2S],
  cvtsd2ss: [X86.CVTS2S],
  cvtss2sd: [X86.CVTS2S],
  // x87, where the escape byte and the operand width are both in the name.
  fld: [X86.X87_LOAD],
  flds: [X86.X87_LOAD],
  fldl: [X86.X87_LOAD],
  fldt: [X86.X87_LOAD],
  fldz: [X86.X87_CONST],
  fld1: [X86.X87_CONST],
  fild: [X86.X87_LOAD],
  fildl: [X86.X87_LOAD],
  fildll: [X86.X87_LOAD],
  filds: [X86.X87_LOAD],
  fst: [X86.X87_STORE],
  fstl: [X86.X87_STORE],
  fstp: [X86.X87_STORE],
  fstpl: [X86.X87_STORE],
  fstpt: [X86.X87_STORE],
  fstps: [X86.X87_STORE],
  fist: [X86.X87_STORE],
  fistl: [X86.X87_STORE],
  fistp: [X86.X87_STORE],
  fistpl: [X86.X87_STORE],
  fistpll: [X86.X87_STORE],
  fistps: [X86.X87_STORE],
  fadd: [X86.X87_ARITH],
  faddl: [X86.X87_ARITH],
  fadds: [X86.X87_ARITH],
  faddp: [X86.X87_ARITH],
  fiadd: [X86.X87_ARITH],
  fiaddl: [X86.X87_ARITH],
  fiadds: [X86.X87_ARITH],
  fsub: [X86.X87_ARITH],
  fsubl: [X86.X87_ARITH],
  fsubs: [X86.X87_ARITH],
  fsubp: [X86.X87_ARITH],
  fsubr: [X86.X87_ARITH],
  fsubrl: [X86.X87_ARITH],
  fsubrs: [X86.X87_ARITH],
  fsubrp: [X86.X87_ARITH],
  fisub: [X86.X87_ARITH],
  fisubl: [X86.X87_ARITH],
  fisubs: [X86.X87_ARITH],
  fmul: [X86.X87_ARITH],
  fmull: [X86.X87_ARITH],
  fmuls: [X86.X87_ARITH],
  fmulp: [X86.X87_ARITH],
  fimul: [X86.X87_ARITH],
  fimull: [X86.X87_ARITH],
  fimuls: [X86.X87_ARITH],
  fdiv: [X86.X87_ARITH],
  fdivl: [X86.X87_ARITH],
  fdivs: [X86.X87_ARITH],
  fdivp: [X86.X87_ARITH],
  fdivr: [X86.X87_ARITH],
  fdivrl: [X86.X87_ARITH],
  fdivrs: [X86.X87_ARITH],
  fdivrp: [X86.X87_ARITH],
  fidiv: [X86.X87_ARITH],
  fchs: [X86.X87_UNARY],
  fabs: [X86.X87_UNARY],
  fxch: [X86.X87_XCH],
  fldcw: [X86.X87_LDCW],
  fnstcw: [X86.X87_STCW],
  ffree: [X86.X87_FREE],
  fucomi: [X86.X87_COMPARE],
  fucomip: [X86.X87_COMPARE],
  fucompi: [X86.X87_COMPARE],
  fcompi: [X86.X87_COMPARE],
  fcomi: [X86.X87_COMPARE],
  fcomip: [X86.X87_COMPARE],
  fucom: [X86.X87_COMPARE],
  fucomp: [X86.X87_COMPARE],
  fcom: [X86.X87_COMPARE],
  fcomp: [X86.X87_COMPARE],
  ficom: [X86.X87_COMPARE],
  fwait: [X86.NOP],
  wait: [X86.NOP],
  // The atomics, whose lock prefix the disassembler may print separately.
  cmpxchg: [X86.CMPXCHG],
  xadd: [X86.XADD],
  lock: [X86.CMPXCHG, X86.XADD, X86.ADD, X86.SUB, X86.AND, X86.OR, X86.XOR,
    X86.INC, X86.DEC, X86.BTS, X86.BTR, X86.BTC],
}

/**
 * The arithmetic and logic, whose every width shares one operation.
 *
 * These are listed rather than inferred because the check is membership:
 * a suffixed name normalises onto the stem, and the stem has to resolve
 * to something for that to mean anything.
 */
const PLAIN: Readonly<Record<string, number>> = {
  add: X86.ADD, or: X86.OR, adc: X86.ADC, sbb: X86.SBB, and: X86.AND,
  sub: X86.SUB, xor: X86.XOR, cmp: X86.CMP, test: X86.TEST,
  not: X86.NOT, neg: X86.NEG, inc: X86.INC, dec: X86.DEC,
  bt: X86.BT, bts: X86.BTS, btr: X86.BTR, btc: X86.BTC,
}
for (const [name, op] of Object.entries(PLAIN)) ALIASES[name] = [op]

for (const condition of CONDITIONS) {
  ALIASES[`j${condition}`] = [X86.JCC]
  ALIASES[`set${condition}`] = [X86.SETCC]
  ALIASES[`cmov${condition}`] = [X86.CMOVCC]
}

/** The instruction stems the disassembler gives an operand-size suffix. */
const SIZED = new Set([
  'add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp', 'test',
  'not', 'neg', 'inc', 'dec', 'mov', 'movabs', 'xchg', 'lea',
  'shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'shld', 'shrd',
  'imul', 'mul', 'div', 'idiv', 'push', 'pop', 'call', 'jmp', 'ret',
  'bt', 'bts', 'btr', 'btc', 'bsf', 'bsr', 'tzcnt', 'lzcnt', 'popcnt',
  'bswap', 'cmpxchg', 'xadd', 'movzb', 'movzw', 'movsb', 'movsw',
  'nop', 'stos', 'movs',
])

/**
 * Removes the operand-size suffix, when the stem without it is an
 * instruction this decoder knows by that name.
 *
 * Done by looking the stem up rather than by stripping any trailing
 * b/w/l/q, because plenty of mnemonics end in one of those letters
 * without it being a size: `mul` is not `mu` at long width.
 */
function normalise(mnemonic: string): string {
  if (ALIASES[mnemonic] !== undefined) return mnemonic
  const stem = mnemonic.slice(0, -1)
  if (/[bwlq]$/.test(mnemonic) && SIZED.has(stem)) return stem
  // A conditional with a size suffix, such as `cmovel`.
  if (/[bwlq]$/.test(mnemonic) && ALIASES[stem] !== undefined) return stem
  return mnemonic
}

export const x86DecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    const inst = decode((offset) => bytes[offset] ?? 0, address)
    return { op: inst.op, length: inst.length }
  },
  name(op) {
    return X86_NAME[op] ?? `?${op}`
  },
  aliases: new Proxy(ALIASES, {
    get: (target, key: string) => target[normalise(key)],
    has: (target, key: string) => normalise(key) in target,
  }),
  // The padding a compiler puts between functions, which is not code.
  ignored: ['(bad)'],
}
