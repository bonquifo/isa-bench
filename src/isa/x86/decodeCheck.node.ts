/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * Two things make x86 different from the fixed-length targets here.
 *
 * The disassembler prints much of what the decoder carries as fields in
 * the mnemonic: the operand size (`movq`, `movl`), the condition (`jne`,
 * `cmovbl`), the precision (`addsd`, `addss`) and the element width
 * (`paddb`, `paddq`). The signature further down builds the name those
 * fields imply and requires it exactly, so a decoder that got any of
 * them wrong fails here rather than producing a plausible number.
 *
 * And the length is not fixed, which makes this tier worth more here
 * than anywhere else: agreeing with the disassembler about where each
 * instruction *ends* is a real claim, and one that nothing else checks
 * until an interpreter walks off into the middle of an instruction and
 * produces nonsense.
 */
import { X86, X86_NAME, decode, type X86Inst } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

/**
 * The operations with no field in their name, and the spellings each
 * may be printed under.
 */
const ALIASES: Record<string, readonly number[]> = {
  nop: [X86.NOP],
  nopw: [X86.NOP],
  nopl: [X86.NOP],
  // `wait` checks for pending x87 exceptions, which are never raised here.
  fwait: [X86.NOP],
  wait: [X86.NOP],
  ret: [X86.RET],
  retq: [X86.RET],
  leave: [X86.LEAVE],
  leaveq: [X86.LEAVE],
  call: [X86.CALL, X86.CALL_INDIRECT],
  callq: [X86.CALL, X86.CALL_INDIRECT],
  jmp: [X86.JMP, X86.JMP_INDIRECT],
  jmpq: [X86.JMP, X86.JMP_INDIRECT],
  // SSE, where the mnemonic names the element type and the decoder does
  // not: a 128-bit move is the same operation whatever it is moving, and
  // a bitwise operation is the same whatever the bits mean.
  movaps: [X86.MOV_XMM],
  movapd: [X86.MOV_XMM],
  movups: [X86.MOV_XMM],
  movupd: [X86.MOV_XMM],
  movdqa: [X86.MOV_XMM],
  movdqu: [X86.MOV_XMM],
  movq: [X86.MOVQ_XMM],
  xorps: [X86.XORP],
  xorpd: [X86.XORP],
  andps: [X86.ANDP],
  andpd: [X86.ANDP],
  andnps: [X86.ANDNP],
  andnpd: [X86.ANDNP],
  orps: [X86.ORP],
  orpd: [X86.ORP],
  // The x87 control operations.
  fxch: [X86.X87_XCH],
  fldcw: [X86.X87_LDCW],
  fnstcw: [X86.X87_STCW],
  ffree: [X86.X87_FREE],
}


/** The operand-size suffix AT&T syntax gives each width. */
const SUFFIX: Readonly<Record<number, string>> = { 1: 'b', 2: 'w', 4: 'l', 8: 'q' }

/** Each condition code's spellings, in encoding order. */
const CONDITION_SPELLINGS: readonly (readonly string[])[] = [
  ['o'], ['no'], ['b', 'c', 'nae'], ['ae', 'nb', 'nc'],
  ['e', 'z'], ['ne', 'nz'], ['be', 'na'], ['a', 'nbe'],
  ['s'], ['ns'], ['p', 'pe'], ['np', 'po'],
  ['l', 'nge'], ['ge', 'nl'], ['le', 'ng'], ['g', 'nle'],
]

/**
 * The general-purpose operations whose name is a stem plus a width. The
 * width is checked: `addl` is only accepted from a decode that produced a
 * four-byte add.
 */
const SIZED_STEMS: ReadonlyMap<number, readonly string[]> = new Map([
  [X86.ADD, ['add']], [X86.OR, ['or']], [X86.ADC, ['adc']], [X86.SBB, ['sbb']],
  [X86.AND, ['and']], [X86.SUB, ['sub']], [X86.XOR, ['xor']], [X86.CMP, ['cmp']],
  [X86.TEST, ['test']], [X86.NOT, ['not']], [X86.NEG, ['neg']],
  [X86.INC, ['inc']], [X86.DEC, ['dec']],
  [X86.MOV, ['mov', 'movabs']], [X86.LEA, ['lea']], [X86.XCHG, ['xchg']],
  [X86.ROL, ['rol']], [X86.ROR, ['ror']], [X86.RCL, ['rcl']], [X86.RCR, ['rcr']],
  [X86.SHL, ['shl', 'sal']], [X86.SHR, ['shr']], [X86.SAR, ['sar']],
  [X86.SHLD, ['shld']], [X86.SHRD, ['shrd']],
  [X86.IMUL1, ['imul']], [X86.IMUL2, ['imul']],
  [X86.MUL, ['mul']], [X86.DIV, ['div']], [X86.IDIV, ['idiv']],
  [X86.BT, ['bt']], [X86.BTS, ['bts']], [X86.BTR, ['btr']], [X86.BTC, ['btc']],
  [X86.BSF, ['bsf']], [X86.BSR, ['bsr']], [X86.TZCNT, ['tzcnt']],
  [X86.LZCNT, ['lzcnt']], [X86.POPCNT, ['popcnt']], [X86.BSWAP, ['bswap']],
  [X86.CMPXCHG, ['cmpxchg']], [X86.XADD, ['xadd']],
  [X86.PUSH, ['push']], [X86.POP, ['pop']],
])

/** The x87 two-operand operations, by the `cond` the decoder gives them. */
const X87_ARITH_NAMES = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr']

/** The packed element width, as the mnemonic spells it. */
const ELEMENT: Readonly<Record<number, string>> = { 1: 'b', 2: 'w', 4: 'd', 8: 'q' }
const UNPACK: Readonly<Record<number, string>> = { 1: 'bw', 2: 'wd', 4: 'dq', 8: 'qdq' }

/** `sd` or `ss`, from the scalar width the decoder recorded. */
const precision = (inst: X86Inst): string => (inst.sourceSize === 8 ? 'sd' : 'ss')

/**
 * The names the decoded fields imply.
 *
 * Membership was looser here than on any other target. The suffix was
 * stripped before comparing, so a decoder that got an operand's width
 * wrong passed; every jump, set and conditional move shared one operation
 * whatever its condition; and `addsd` and `addss`, `cvttsd2si` and
 * `cvtsd2si`, `paddb` and `paddq`, `movlps` and `movhps` were each one
 * name to the check although they are different instructions to the
 * interpreter. Here width, condition, precision, truncation, element size
 * and which half all decide the name.
 *
 * What is still a choice of spellings is only what the interpreter does
 * not distinguish: the aligned and unaligned 128-bit moves, the single-
 * and double-precision bitwise operations, `ucomis` and `comis` (which
 * differ only in which NaNs raise an exception nothing here observes),
 * and the synonyms the architecture itself gives a condition.
 */
function signature(inst: X86Inst): readonly string[] | undefined {
  const suffix = SUFFIX[inst.size] ?? ''
  const stems = SIZED_STEMS.get(inst.op)
  if (stems !== undefined) return stems.flatMap((stem) => [`${stem}${suffix}`, stem])

  const conditions = CONDITION_SPELLINGS[inst.cond] ?? []
  switch (inst.op) {
    case X86.JCC: return conditions.map((c) => `j${c}`)
    case X86.SETCC: return conditions.map((c) => `set${c}`)
    case X86.CMOVCC: return conditions.flatMap((c) => [`cmov${c}${suffix}`, `cmov${c}`])

    case X86.MOVZX:
    case X86.MOVSX: {
      const from = SUFFIX[inst.sourceSize] ?? '?'
      return [`mov${inst.op === X86.MOVZX ? 'z' : 's'}${from}${suffix}`]
    }
    case X86.CWDE: return [({ 2: 'cbtw', 4: 'cwtl', 8: 'cltq' } as Record<number, string>)[inst.size] ?? '?']
    case X86.CDQ: return [({ 2: 'cwtd', 4: 'cltd', 8: 'cqto' } as Record<number, string>)[inst.size] ?? '?']
    case X86.MOVS: return inst.rep !== 0 ? ['rep'] : [`movs${suffix}`]
    case X86.STOS: return inst.rep !== 0 ? ['rep'] : [`stos${suffix}`]

    case X86.MOV_XMM_SCALAR: return [`mov${precision(inst)}`]
    case X86.MOVD: return [inst.size === 8 ? 'movq' : 'movd']
    case X86.MOV_HALF: return inst.cond === 1 ? ['movhps', 'movhpd'] : ['movlps', 'movlpd']
    // The register forms are named for the half they read, not the one
    // they write.
    case X86.MOV_HALF_REG: return inst.cond === 1 ? ['movlhps'] : ['movhlps']

    case X86.PADD: return [`padd${ELEMENT[inst.sourceSize] ?? '?'}`]
    case X86.PSUB: return [`psub${ELEMENT[inst.sourceSize] ?? '?'}`]
    case X86.PCMPEQ: return [`pcmpeq${ELEMENT[inst.sourceSize] ?? '?'}`]
    case X86.PCMPGT: return [`pcmpgt${ELEMENT[inst.sourceSize] ?? '?'}`]
    case X86.PUNPCKL: return [`punpckl${UNPACK[inst.sourceSize] ?? '?'}`]

    case X86.ADDSD: return [`add${precision(inst)}`]
    case X86.SUBSD: return [`sub${precision(inst)}`]
    case X86.MULSD: return [`mul${precision(inst)}`]
    case X86.DIVSD: return [`div${precision(inst)}`]
    case X86.SQRTSD: return [`sqrt${precision(inst)}`]
    case X86.MINSD: return [`min${precision(inst)}`]
    case X86.MAXSD: return [`max${precision(inst)}`]
    case X86.UCOMIS: return [`ucomi${precision(inst)}`, `comi${precision(inst)}`]
    case X86.CVTTS2SI: {
      const name = `cvt${inst.cond === 1 ? 't' : ''}${precision(inst)}2si`
      return [name, `${name}${suffix}`]
    }
    case X86.CVTSI2S: {
      const name = `cvtsi2${precision(inst)}`
      return [name, `${name}${suffix}`]
    }
    case X86.CVTS2S: return [inst.sourceSize === 8 ? 'cvtsd2ss' : 'cvtss2sd']

    case X86.X87_LOAD:
    case X86.X87_STORE:
      return [x87Transfer(inst)]
    case X86.X87_ARITH:
    case X86.X87_COMPARE:
      return x87Arith(inst)
    case X86.X87_CONST: return [inst.cond === 1 ? 'fld1' : 'fldz']
    case X86.X87_UNARY: return [inst.cond === 1 ? 'fabs' : 'fchs']

    default:
      return undefined
  }
}

/** An x87 load or store: integer or not, width, and whether it pops. */
function x87Transfer(inst: X86Inst): string {
  const store = inst.op === X86.X87_STORE
  const pop = store && inst.accumulatorForm ? 'p' : ''
  if (inst.mem === null) return store ? `fst${pop}` : 'fld'
  if (inst.signed) {
    const width = ({ 2: 's', 4: 'l', 8: 'll' } as Record<number, string>)[inst.sourceSize] ?? '?'
    return `${store ? 'fist' : 'fild'}${pop}${width}`
  }
  const width = ({ 4: 's', 8: 'l', 10: 't' } as Record<number, string>)[inst.sourceSize] ?? '?'
  return `${store ? 'fst' : 'fld'}${pop}${width}`
}

/** An x87 arithmetic or compare, from memory or on the stack. */
function x87Arith(inst: X86Inst): readonly string[] {
  if (inst.cond === 8) {
    // fucomi and fcomi, which set the integer flags.
    const stem = inst.signed ? 'fcom' : 'fucom'
    return inst.accumulatorForm ? [`${stem}pi`, `${stem}ip`] : [`${stem}i`]
  }
  const base = X87_ARITH_NAMES[inst.cond] ?? '?'
  if (inst.mem !== null) {
    if (inst.signed) return [`fi${base.slice(1)}${inst.sourceSize === 4 ? 'l' : 's'}`]
    return [`${base}${inst.sourceSize === 8 ? 'l' : 's'}`]
  }
  if (inst.op === X86.X87_COMPARE && inst.accumulatorForm) return ['fcompp']
  // AT&T syntax names the forms that write st(i) the other way round from
  // Intel's manual -- Intel's `fsubp st(1), st` is `fsubrp %st, %st(1)` --
  // a historical accident every AT&T assembler keeps. `cond` is the
  // operation actually performed, so the name has to be swapped back.
  const swapped = inst.regIsDestination && inst.cond >= 4
    ? X87_ARITH_NAMES[inst.cond ^ 1] ?? '?'
    : base
  return [`${swapped}${inst.accumulatorForm ? 'p' : ''}`]
}

function decodeBytes(bytes: Uint8Array, address: bigint): X86Inst {
  return decode((offset) => bytes[offset] ?? 0, address)
}

export const x86DecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    const inst = decodeBytes(bytes, address)
    return { op: inst.op, length: inst.length }
  },
  signature(bytes, address) {
    return signature(decodeBytes(bytes, address))
  },
  name(op) {
    return X86_NAME[op] ?? `?${op}`
  },
  aliases: ALIASES,
  // The padding a compiler puts between functions, which is not code.
  ignored: ['(bad)'],
  // What musl's start code leaves after the exit call. It is privileged,
  // so a user-mode guest reaching it has gone wrong, and it is refused.
  refused: ['hlt'],
}
