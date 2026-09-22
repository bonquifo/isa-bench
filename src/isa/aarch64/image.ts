/**
 * AArch64 program image: the static half the timing model consumes.
 *
 * Same lazy, address-keyed decode as RV64. The interesting difference is
 * the resource space: the condition flags are a register here, read and
 * written by most of the instruction set, and a hazard model that did not
 * know that would let a branch issue before the compare it depends on.
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
  A64,
  A64_NAME,
  Flow,
  ISA_NAME,
  Index,
  decode,
  rdIsStackPointer,
  rnIsStackPointer,
  type A64Inst,
  type A64Op,
} from './decode.ts'

/** x0..x30, sp, nzcv, then v0..v31, then the two floating-point status words. */
export const SP_ID = 31
export const NZCV_ID = 32
export const V_BASE = 33
export const FPSR_ID = 65
export const FPCR_ID = 66
export const REG_COUNT = 67

export const AARCH64_NAMING: RegisterNaming = {
  count: REG_COUNT,
  name(id: number): string {
    if (id < SP_ID) return `x${id}`
    if (id === SP_ID) return 'sp'
    if (id === NZCV_ID) return 'nzcv'
    if (id >= V_BASE && id < FPSR_ID) return `v${id - V_BASE}`
    if (id === FPSR_ID) return 'fpsr'
    if (id === FPCR_ID) return 'fpcr'
    return `?${id}`
  },
}

/**
 * Scalar floating point: the operations that use the vector register file
 * *and* update the IEEE exception flags.
 */
const FP_OPS = new Set<A64Op>([
  A64.FMOV_REG, A64.FMOV_IMM, A64.FABS, A64.FNEG, A64.FSQRT, A64.FCVT, A64.FRINT,
  A64.FADD, A64.FSUB, A64.FMUL, A64.FDIV, A64.FMAX, A64.FMIN, A64.FMAXNM, A64.FMINNM,
  A64.FNMUL, A64.FMADD, A64.FMSUB, A64.FNMADD, A64.FNMSUB, A64.FCMP, A64.FCSEL, A64.FCCMP,
])

/**
 * Integer Advanced SIMD. Same register file, so the same hazards, but no
 * exception flags -- listing these as floating point would make every one of
 * them appear to write FPSR and serialise against anything that reads it.
 *
 * They are classed as floating point for issue and latency all the same,
 * because the vector pipes are what the modelled machine has for them.
 */
const SIMD_OPS = new Set<A64Op>([
  A64.MOVI, A64.DUP_GENERAL, A64.DUP_ELEMENT, A64.INS_GENERAL, A64.UMOV,
  A64.ORR_VEC, A64.AND_VEC, A64.EOR_VEC, A64.ADD_VEC, A64.MUL_VEC, A64.MUL_ELEMENT,
  A64.SADDL, A64.SADDW, A64.USHL, A64.XTN, A64.UZP1, A64.ADDV, A64.ADDP_SCALAR,
])

/** Whether an operation uses the vector register file at all. */
const usesVectors = (op: A64Op): boolean => FP_OPS.has(op) || SIMD_OPS.has(op)

/** The operations whose destination is a general register despite that. */
const TO_GENERAL = new Set<A64Op>([A64.FMOV_TO_GP, A64.UMOV])

/** ... and whose first source is one. */
const FROM_GENERAL = new Set<A64Op>([A64.FMOV_FROM_GP, A64.DUP_GENERAL, A64.INS_GENERAL])

const MUL_OPS = new Set<A64Op>([
  A64.MADD, A64.MSUB, A64.SMADDL, A64.SMSUBL, A64.SMULH, A64.UMADDL, A64.UMSUBL, A64.UMULH,
])
const DIV_OPS = new Set<A64Op>([A64.UDIV, A64.SDIV])
const LOAD_OPS = new Set<A64Op>([
  A64.LOAD, A64.LOAD_PAIR, A64.LOAD_LITERAL, A64.LOAD_EXCLUSIVE, A64.LD1_LANE,
])
// Zeroing a cache line writes memory and nothing else, so the model treats
// it as the store of sixty-four zero bytes that it is.
const STORE_OPS = new Set<A64Op>([
  A64.STORE, A64.STORE_PAIR, A64.STORE_EXCLUSIVE, A64.DC_ZVA,
])
const CONTROL_OPS = new Set<A64Op>([
  A64.B, A64.BL, A64.B_COND, A64.CBZ, A64.CBNZ, A64.TBZ, A64.TBNZ,
  A64.BR, A64.BLR, A64.RET, A64.SVC, A64.BRK,
])

function classOf(inst: A64Inst): InstClass {
  if (LOAD_OPS.has(inst.op)) return InstClass.LD
  if (STORE_OPS.has(inst.op)) return InstClass.ST
  if (CONTROL_OPS.has(inst.op)) return InstClass.BR
  if (DIV_OPS.has(inst.op)) return InstClass.DIV
  if (MUL_OPS.has(inst.op)) return InstClass.MUL
  if (usesVectors(inst.op) || inst.op === A64.FCVT_TO_INT || inst.op === A64.FCVT_FROM_INT) {
    return InstClass.FP
  }
  if (inst.op === A64.NOP || inst.op === A64.BARRIER || inst.op === A64.CLREX) return InstClass.NOP
  if (
    inst.op === A64.MOVZ || inst.op === A64.MOVN || inst.op === A64.MOVK ||
    inst.op === A64.FMOV_TO_GP || inst.op === A64.FMOV_FROM_GP ||
    inst.op === A64.MRS || inst.op === A64.MSR
  ) return InstClass.MOV
  return InstClass.ALU
}

function latencyOf(inst: A64Inst): LatencyClass {
  if (LOAD_OPS.has(inst.op)) return LatencyClass.LOAD
  if (DIV_OPS.has(inst.op)) return LatencyClass.DIV
  if (MUL_OPS.has(inst.op)) return LatencyClass.MUL
  if (inst.op === A64.FDIV || inst.op === A64.FSQRT) return LatencyClass.FP_DIV
  if (
    inst.op === A64.FMUL || inst.op === A64.FNMUL || inst.op === A64.FMADD ||
    inst.op === A64.FMSUB || inst.op === A64.FNMADD || inst.op === A64.FNMSUB ||
    inst.op === A64.MUL_VEC || inst.op === A64.MUL_ELEMENT
  ) return LatencyClass.FP_MUL
  if (usesVectors(inst.op) || inst.op === A64.FCVT_TO_INT || inst.op === A64.FCVT_FROM_INT) {
    return LatencyClass.FP_ADD
  }
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

export function render(inst: A64Inst): string {
  const name = A64_NAME[inst.op] ?? '?'
  const parts: string[] = []
  const reg = (n: number, fp: boolean): string =>
    fp ? `v${n}` : n === 31 ? 'x31' : `x${n}`
  const fp = usesVectors(inst.op) || inst.fpTransfer
  if (inst.rd >= 0) parts.push(reg(inst.rd, fp && !TO_GENERAL.has(inst.op)))
  if (inst.rt2 >= 0) parts.push(reg(inst.rt2, fp))
  if (inst.rn >= 0) parts.push(reg(inst.rn, fp && !FROM_GENERAL.has(inst.op)))
  if (inst.rm >= 0) parts.push(reg(inst.rm, fp))
  if (inst.ra >= 0) parts.push(reg(inst.ra, fp))
  if (inst.imm !== 0n) parts.push(`#${inst.imm}`)
  if (inst.sysreg) parts.push(inst.sysreg)
  return parts.length > 0 ? `${name} ${parts.join(', ')}` : name
}

export interface A64StaticInst extends StaticInst {
  readonly inst: A64Inst
}

function toStatic(inst: A64Inst, addr: bigint): A64StaticInst {
  const reads: number[] = []
  const writes: number[] = []
  const fpTransfer = inst.fpTransfer
  const isFp = usesVectors(inst.op)

  const readGp = (n: number): number => (n === 31 ? (rnIsStackPointer(inst) ? SP_ID : -1) : n)
  const writeGp = (n: number): number => (n === 31 ? (rdIsStackPointer(inst) ? SP_ID : -1) : n)
  const gp = readGp
  const addRead = (id: number): void => {
    if (id >= 0 && !reads.includes(id)) reads.push(id)
  }
  const addWrite = (id: number): void => {
    if (id >= 0 && !writes.includes(id)) writes.push(id)
  }

  const memory = LOAD_OPS.has(inst.op) || STORE_OPS.has(inst.op)
  const vectorTransfer = memory ? fpTransfer : isFp

  if (inst.rn >= 0) {
    addRead(isFp && !FROM_GENERAL.has(inst.op) ? V_BASE + inst.rn : gp(inst.rn))
  }
  if (inst.rm >= 0) addRead(isFp ? V_BASE + inst.rm : gp(inst.rm))
  if (inst.ra >= 0) addRead(isFp ? V_BASE + inst.ra : gp(inst.ra))

  if (memory) {
    // The transferred register is never the stack pointer, only the base is.
    const slot = vectorTransfer ? V_BASE + inst.rd : (inst.rd === 31 ? -1 : inst.rd)
    if (LOAD_OPS.has(inst.op)) addWrite(slot)
    else addRead(slot)
    if (inst.rt2 >= 0) {
      const second = vectorTransfer ? V_BASE + inst.rt2 : (inst.rt2 === 31 ? -1 : inst.rt2)
      if (LOAD_OPS.has(inst.op)) addWrite(second)
      else addRead(second)
    }
    if (inst.op === A64.STORE_EXCLUSIVE) addWrite(inst.rm === 31 ? -1 : inst.rm)
    if (inst.indexMode !== Index.OFFSET) addWrite(gp(inst.rn))
  } else if (inst.rd >= 0) {
    if (inst.op === A64.MSR) addRead(readGp(inst.rd))
    else if (isFp && !TO_GENERAL.has(inst.op)) addWrite(V_BASE + inst.rd)
    else if (inst.op === A64.FCVT_FROM_INT) addWrite(V_BASE + inst.rd)
    else addWrite(writeGp(inst.rd))
  }

  if (inst.op === A64.FCVT_FROM_INT) addRead(gp(inst.rn))
  if (inst.op === A64.FCVT_TO_INT) {
    addRead(V_BASE + inst.rn)
    addWrite(gp(inst.rd))
  }
  // An operation that writes part of a vector register depends on what was
  // already in the rest of it, so it reads its own destination.
  if (
    inst.op === A64.INS_GENERAL || inst.op === A64.LD1_LANE ||
    (inst.op === A64.XTN && inst.part)
  ) addRead(V_BASE + inst.rd)

  if (inst.op === A64.BL || inst.op === A64.BLR) addWrite(30)
  if (inst.op === A64.RET) addRead(inst.rn < 0 ? 30 : gp(inst.rn))

  // The condition flags are a register: almost everything either writes them
  // or depends on one that did.
  if (inst.setFlags) addWrite(NZCV_ID)
  if (
    inst.op === A64.B_COND || inst.op === A64.CSEL || inst.op === A64.CSINC ||
    inst.op === A64.CSINV || inst.op === A64.CSNEG || inst.op === A64.CCMP ||
    inst.op === A64.CCMN || inst.op === A64.ADC || inst.op === A64.SBC ||
    inst.op === A64.FCSEL || inst.op === A64.FCCMP
  ) addRead(NZCV_ID)
  if (inst.op === A64.MRS && inst.sysreg === 'nzcv') addRead(NZCV_ID)
  if (inst.op === A64.MSR && inst.sysreg === 'nzcv') addWrite(NZCV_ID)
  if (
    FP_OPS.has(inst.op) || inst.op === A64.FCVT_TO_INT || inst.op === A64.FCVT_FROM_INT
  ) addWrite(FPSR_ID)

  const control = CONTROL_OF[inst.flow]!
  const direct = control === ControlKind.COND || control === ControlKind.JUMP ||
    (control === ControlKind.CALL && inst.op === A64.BL)

  return {
    addr,
    bytes: 4,
    mnemonic: render(inst),
    cls: classOf(inst),
    latencyClass: latencyOf(inst),
    uops: 1,
    reads,
    writes,
    control,
    staticTarget: direct ? addr + inst.imm : NO_ADDRESS,
    readsMem: LOAD_OPS.has(inst.op),
    writesMem: STORE_OPS.has(inst.op),
    accessWidth: memory ? inst.width : 0,
    serializing: inst.op === A64.SVC || inst.op === A64.BRK || inst.op === A64.BARRIER ||
      inst.op === A64.LOAD_EXCLUSIVE || inst.op === A64.STORE_EXCLUSIVE,
    origin: OperationOrigin.SEMANTIC,
    inst,
  }
}

export class A64Image implements ProgramImage {
  readonly isa = ISA_NAME
  readonly entry: bigint
  readonly naming = AARCH64_NAMING
  readonly codeBytes: number
  private readonly memory: GuestMemory
  private readonly cache = new Map<number, A64StaticInst>()
  private readonly failed = new Set<number>()

  constructor(memory: GuestMemory, entry: bigint, codeBytes: number) {
    this.memory = memory
    this.entry = entry
    this.codeBytes = codeBytes
  }

  at(addr: bigint): A64StaticInst {
    const key = Number(addr)
    const hit = this.cache.get(key)
    if (hit) return hit
    if ((key & 3) !== 0) {
      throw new IsaError(`${ISA_NAME}: misaligned instruction fetch at 0x${addr.toString(16)}`)
    }
    const low = this.memory.fetchHalf(addr)
    const high = this.memory.fetchHalf(addr + 2n)
    const word = ((high << 16) | low) >>> 0
    const result = toStatic(decode(word, addr), addr)
    this.cache.set(key, result)
    return result
  }

  speculativeAt(addr: bigint): A64StaticInst | null {
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
