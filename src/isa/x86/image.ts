/**
 * x86-64 program image: the static half the timing model consumes.
 *
 * Two things differ from the fixed-length targets.
 *
 * Decoding cannot be keyed on an aligned address, because there is no
 * alignment. The cache is keyed on the byte address an instruction starts
 * at, and the same bytes decoded from a different offset are a different
 * instruction — which is not a hazard here only because the timing model
 * walks the stream the interpreter reports rather than guessing at
 * boundaries.
 *
 * The flags are a register that nearly every instruction writes and nearly
 * every branch reads, so the dependence graph is dense in a way the other
 * targets' are not. That is a property of the architecture and not of the
 * model: on this machine a compare and the branch after it really are
 * dependent, and a model that missed it would let them issue together.
 */
import { InstClass, OperationOrigin } from '../../engine/types.ts'
import { IsaError } from '../common/errors.ts'
import type { GuestMemory } from '../common/memory.ts'
import {
  ControlKind,
  LatencyClass,
  NO_ADDRESS,
  type ProgramImage,
  type RegisterNaming,
  type StaticInst,
} from '../common/trace.ts'
import {
  File,
  Flow,
  ISA_NAME,
  NO_REG,
  X86,
  X86_NAME,
  decode,
  type X86Inst,
  type X86Op,
} from './decode.ts'

/** rax..r15, then the flags, then xmm0..xmm15. */
export const FLAGS_ID = 16
export const XMM_BASE = 17
export const FS_BASE_ID = 33
export const X87_ID = 34
export const REG_COUNT = 35

const GPR_NAMES = [
  'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
]

export const X86_NAMING: RegisterNaming = {
  count: REG_COUNT,
  name(id: number): string {
    if (id < 16) return GPR_NAMES[id]!
    if (id === FLAGS_ID) return 'rflags'
    if (id >= XMM_BASE && id < FS_BASE_ID) return `xmm${id - XMM_BASE}`
    if (id === FS_BASE_ID) return 'fs.base'
    if (id === X87_ID) return 'st'
    return `?${id}`
  },
}

/** Operations that write the flags as part of what they do. */
const WRITES_FLAGS = new Set<X86Op>([
  X86.ADD, X86.OR, X86.ADC, X86.SBB, X86.AND, X86.SUB, X86.XOR, X86.CMP, X86.TEST,
  X86.NEG, X86.INC, X86.DEC,
  X86.ROL, X86.ROR, X86.RCL, X86.RCR, X86.SHL, X86.SHR, X86.SAR, X86.SHLD, X86.SHRD,
  X86.IMUL1, X86.IMUL2, X86.MUL, X86.DIV, X86.IDIV,
  X86.BT, X86.BTS, X86.BTR, X86.BTC, X86.BSF, X86.BSR, X86.TZCNT, X86.LZCNT, X86.POPCNT,
  X86.CMPXCHG, X86.XADD, X86.UCOMIS,
])

/** ... and those that read them. */
const READS_FLAGS = new Set<X86Op>([
  X86.JCC, X86.SETCC, X86.CMOVCC, X86.ADC, X86.SBB, X86.RCL, X86.RCR, X86.LAHF,
])

const VECTOR_OPS = new Set<X86Op>([
  X86.MOV_XMM, X86.MOV_XMM_SCALAR, X86.MOVD, X86.MOVQ_XMM,
  X86.MOV_HALF, X86.MOV_HALF_REG,
  X86.PXOR, X86.PAND, X86.POR, X86.PADD, X86.PSUB, X86.PMULUDQ,
  X86.PCMPGT, X86.PCMPEQ, X86.PUNPCKL, X86.PSHUFD,
  X86.ADDSD, X86.SUBSD, X86.MULSD, X86.DIVSD, X86.SQRTSD, X86.MINSD, X86.MAXSD,
  X86.UCOMIS, X86.ANDP, X86.ANDNP, X86.ORP, X86.XORP,
  X86.CVTTS2SI, X86.CVTSI2S, X86.CVTS2S,
])

/**
 * The x87 stack, as one resource rather than eight.
 *
 * st(i) is relative to a top the instructions move, so which physical
 * slot an instruction touches cannot be worked out without executing the
 * ones before it. Naming the stack as a whole is the honest resolution:
 * it says the dependence exists without inventing a precision the static
 * view does not have.
 */
const X87_OPS = new Set<X86Op>([
  X86.X87_LOAD, X86.X87_STORE, X86.X87_ARITH, X86.X87_COMPARE, X86.X87_CONST,
  X86.X87_UNARY, X86.X87_XCH, X86.X87_LDCW, X86.X87_STCW, X86.X87_FREE,
])

const MUL_OPS = new Set<X86Op>([X86.IMUL1, X86.IMUL2, X86.MUL])
const DIV_OPS = new Set<X86Op>([X86.DIV, X86.IDIV])
const CONTROL_OPS = new Set<X86Op>([
  X86.JCC, X86.JMP, X86.JMP_INDIRECT, X86.CALL, X86.CALL_INDIRECT, X86.RET,
  X86.SYSCALL, X86.INT3, X86.UD2,
])

/** Whether the instruction touches memory, and in which direction. */
function memoryUse(inst: X86Inst): { reads: boolean; writes: boolean } {
  switch (inst.op) {
    case X86.X87_LOAD:
    case X86.X87_ARITH:
    case X86.X87_COMPARE:
    case X86.X87_LDCW:
      return { reads: inst.mem !== null, writes: false }
    case X86.X87_STORE:
    case X86.X87_STCW:
      return { reads: false, writes: inst.mem !== null }
    case X86.LEA:
    case X86.NOP:
      // lea computes an address and does not follow it, which is exactly
      // why a compiler uses it for arithmetic.
      return { reads: false, writes: false }
    case X86.PUSH:
    case X86.CALL:
    case X86.CALL_INDIRECT:
      return { reads: inst.mem !== null, writes: true }
    case X86.POP:
    case X86.RET:
    case X86.LEAVE:
      return { reads: true, writes: inst.mem !== null }
    case X86.MOVS:
      return { reads: true, writes: true }
    case X86.STOS:
      return { reads: false, writes: true }
    default:
      break
  }
  if (inst.mem === null) return { reads: false, writes: false }
  // With a memory operand, the direction bit says which side it is on.
  // A destination that is read-modify-write is both.
  const writesRm = !inst.regIsDestination &&
    inst.op !== X86.CMP && inst.op !== X86.TEST && inst.op !== X86.BT &&
    inst.op !== X86.UCOMIS
  return { reads: true, writes: writesRm }
}

function classOf(inst: X86Inst): InstClass {
  if (CONTROL_OPS.has(inst.op)) return InstClass.BR
  const memory = memoryUse(inst)
  if (DIV_OPS.has(inst.op)) return InstClass.DIV
  if (MUL_OPS.has(inst.op)) return InstClass.MUL
  if (VECTOR_OPS.has(inst.op) || X87_OPS.has(inst.op)) return InstClass.FP
  if (memory.writes) return InstClass.ST
  if (memory.reads) return InstClass.LD
  if (inst.op === X86.NOP) return InstClass.NOP
  if (inst.op === X86.MOV || inst.op === X86.MOVZX || inst.op === X86.MOVSX ||
      inst.op === X86.LEA || inst.op === X86.CMOVCC) return InstClass.MOV
  return InstClass.ALU
}

function latencyOf(inst: X86Inst): LatencyClass {
  if (DIV_OPS.has(inst.op)) return LatencyClass.DIV
  if (MUL_OPS.has(inst.op)) return LatencyClass.MUL
  if (inst.op === X86.DIVSD || inst.op === X86.SQRTSD) return LatencyClass.FP_DIV
  if (inst.op === X86.MULSD) return LatencyClass.FP_MUL
  if (inst.op === X86.X87_ARITH && (inst.cond === 6 || inst.cond === 7)) {
    return LatencyClass.FP_DIV
  }
  if (VECTOR_OPS.has(inst.op) || X87_OPS.has(inst.op)) return LatencyClass.FP_ADD
  if (memoryUse(inst).reads) return LatencyClass.LOAD
  return LatencyClass.FIXED
}

const CONTROL_OF: Record<number, ControlKind> = {
  [Flow.SEQ]: ControlKind.SEQ,
  [Flow.BRANCH]: ControlKind.COND,
  [Flow.JUMP]: ControlKind.JUMP,
  [Flow.CALL]: ControlKind.CALL,
  [Flow.RET]: ControlKind.RET,
  [Flow.INDIRECT]: ControlKind.INDIRECT,
  [Flow.TRAP]: ControlKind.TRAP,
}

export function render(inst: X86Inst): string {
  const name = X86_NAME[inst.op] ?? '?'
  const parts: string[] = []
  const reg = (n: number, file: number): string =>
    file === File.XMM ? `xmm${n}` : GPR_NAMES[n] ?? `r${n}`
  if (inst.reg !== NO_REG) parts.push(reg(inst.reg, inst.regFile))
  if (inst.rm !== NO_REG) parts.push(reg(inst.rm, inst.rmFile))
  if (inst.mem !== null) {
    const pieces: string[] = []
    if (inst.mem.fsRelative) pieces.push('fs')
    if (inst.mem.base !== NO_REG) pieces.push(GPR_NAMES[inst.mem.base]!)
    if (inst.mem.index !== NO_REG) {
      pieces.push(`${GPR_NAMES[inst.mem.index]}*${inst.mem.scale}`)
    }
    if (inst.mem.disp !== 0n || pieces.length === 0) pieces.push(`0x${inst.mem.disp.toString(16)}`)
    parts.push(`[${pieces.join('+')}]`)
  }
  if (inst.hasImm) parts.push(`#${inst.imm}`)
  if (inst.target !== 0n) parts.push(`0x${inst.target.toString(16)}`)
  return parts.length > 0 ? `${name} ${parts.join(', ')}` : name
}

export interface X86StaticInst extends StaticInst {
  readonly inst: X86Inst
}

function toStatic(inst: X86Inst, addr: bigint): X86StaticInst {
  const reads: number[] = []
  const writes: number[] = []
  const addRead = (id: number): void => {
    if (id >= 0 && !reads.includes(id)) reads.push(id)
  }
  const addWrite = (id: number): void => {
    if (id >= 0 && !writes.includes(id)) writes.push(id)
  }
  const slot = (n: number, file: number): number =>
    n < 0 ? -1 : file === File.XMM ? XMM_BASE + n : n

  // The address is computed from registers whether or not the operand is
  // read, so a base or index is a dependence even for a pure store.
  if (inst.mem !== null) {
    addRead(inst.mem.base)
    addRead(inst.mem.index)
    if (inst.mem.fsRelative) addRead(FS_BASE_ID)
  }

  const memory = memoryUse(inst)
  const rmSlot = inst.rm === NO_REG ? -1 : slot(inst.rm, inst.rmFile)
  const regSlot = inst.reg === NO_REG ? -1 : slot(inst.reg, inst.regFile)

  if (inst.op === X86.LEA) {
    addWrite(regSlot)
  } else if (inst.regIsDestination) {
    addWrite(regSlot)
    addRead(rmSlot)
    // Most two-operand forms read their destination as well as writing it;
    // a plain move and a widening move do not.
    if (inst.op !== X86.MOV && inst.op !== X86.MOVZX && inst.op !== X86.MOVSX &&
        inst.op !== X86.MOV_XMM && inst.op !== X86.MOVD && inst.op !== X86.MOVQ_XMM) {
      addRead(regSlot)
    }
  } else {
    addRead(regSlot)
    if (!inst.hasImm || inst.op === X86.SHLD || inst.op === X86.SHRD) addRead(rmSlot)
    const readModifyWrite = inst.op !== X86.MOV && inst.op !== X86.SETCC
    if (readModifyWrite) addRead(rmSlot)
    if (inst.op !== X86.CMP && inst.op !== X86.TEST && inst.op !== X86.BT &&
        inst.op !== X86.UCOMIS) {
      addWrite(rmSlot)
    }
  }

  // Operands the encoding does not name but the operation still uses.
  if (inst.accumulatorForm) {
    addRead(0)
    if (inst.op !== X86.CMP && inst.op !== X86.TEST) addWrite(0)
  }
  if (inst.shiftByCl) addRead(1)
  if (MUL_OPS.has(inst.op) || DIV_OPS.has(inst.op)) {
    if (inst.op !== X86.IMUL2) {
      addRead(0)
      addWrite(0)
      if (inst.size !== 1) {
        if (DIV_OPS.has(inst.op)) addRead(2)
        addWrite(2)
      }
    }
  }
  if (inst.op === X86.CWDE || inst.op === X86.LAHF) { addRead(0); addWrite(0) }
  if (inst.op === X86.CDQ) { addRead(0); addWrite(2) }
  if (inst.op === X86.CMPXCHG) { addRead(0); addWrite(0) }
  if (inst.op === X86.MOVS || inst.op === X86.STOS) {
    addRead(6); addRead(7); addWrite(6); addWrite(7)
    if (inst.rep !== 0) { addRead(1); addWrite(1) }
    if (inst.op === X86.STOS) addRead(0)
  }
  if (inst.op === X86.SYSCALL) {
    for (const id of [0, 7, 6, 2, 10, 8, 9]) addRead(id)
    addWrite(0); addWrite(1); addWrite(11)
  }

  // The stack pointer is an operand of everything that touches the stack.
  if (inst.op === X86.PUSH || inst.op === X86.POP || inst.op === X86.CALL ||
      inst.op === X86.CALL_INDIRECT || inst.op === X86.RET || inst.op === X86.LEAVE) {
    addRead(4)
    addWrite(4)
    if (inst.reg !== NO_REG && (inst.op === X86.PUSH || inst.op === X86.POP)) {
      if (inst.op === X86.PUSH) addRead(inst.reg)
      else addWrite(inst.reg)
    }
    if (inst.op === X86.LEAVE) { addRead(5); addWrite(5) }
  }

  if (X87_OPS.has(inst.op)) {
    addRead(X87_ID)
    addWrite(X87_ID)
    if (inst.op === X86.X87_COMPARE && inst.cond === 8) addWrite(FLAGS_ID)
  }

  if (WRITES_FLAGS.has(inst.op)) addWrite(FLAGS_ID)
  if (READS_FLAGS.has(inst.op)) addRead(FLAGS_ID)

  const control = CONTROL_OF[inst.flow]!
  const direct = control === ControlKind.COND || control === ControlKind.JUMP ||
    (control === ControlKind.CALL && inst.op === X86.CALL)

  return {
    addr,
    bytes: inst.length,
    mnemonic: render(inst),
    cls: classOf(inst),
    latencyClass: latencyOf(inst),
    uops: 1,
    reads,
    writes,
    control,
    staticTarget: direct ? inst.target : NO_ADDRESS,
    readsMem: memory.reads,
    writesMem: memory.writes,
    accessWidth: memory.reads || memory.writes ? inst.size : 0,
    serializing: inst.op === X86.SYSCALL || inst.lock ||
      inst.op === X86.CMPXCHG || inst.op === X86.XADD,
    origin: OperationOrigin.SEMANTIC,
    inst,
  }
}

export class X86Image implements ProgramImage {
  readonly isa = ISA_NAME
  readonly entry: bigint
  readonly naming = X86_NAMING
  readonly codeBytes: number
  private readonly memory: GuestMemory
  private readonly cache = new Map<number, X86StaticInst>()
  private readonly failed = new Set<number>()

  constructor(memory: GuestMemory, entry: bigint, codeBytes: number) {
    this.memory = memory
    this.entry = entry
    this.codeBytes = codeBytes
  }

  at(addr: bigint): X86StaticInst {
    const key = Number(addr)
    const hit = this.cache.get(key)
    if (hit) return hit
    // No alignment to check: an instruction may begin at any byte, which is
    // why the cache is keyed on the byte address rather than a word index.
    const result = toStatic(decode((offset) => this.fetchByte(addr, offset), addr), addr)
    this.cache.set(key, result)
    return result
  }

  private fetchByte(base: bigint, offset: number): number {
    const at = base + BigInt(offset)
    const half = this.memory.fetchHalf(at & ~1n)
    return (at & 1n) === 0n ? half & 0xff : (half >> 8) & 0xff
  }

  speculativeAt(addr: bigint): X86StaticInst | null {
    const key = Number(addr)
    const hit = this.cache.get(key)
    if (hit) return hit
    if (this.failed.has(key)) return null
    try {
      return this.at(addr)
    } catch (error) {
      if (error instanceof IsaError) {
        this.failed.add(key)
        return null
      }
      throw error
    }
  }
}
