/**
 * MIPS32 program image: the static half the timing model consumes.
 *
 * The delay slot is visible here in one place and invisible everywhere
 * else, which is the outcome worth arguing for.
 *
 * Visible: a branch's `staticTarget` is where control eventually goes, but
 * the instruction that runs next is the one immediately after it. A model
 * that fetched from the target straight away would skip the delay slot and
 * count one instruction too few on every taken branch.
 *
 * Invisible: the retired trace the interpreter produces already has the
 * branch and its slot as separate entries in execution order, with each
 * one's `nextPc` saying where control actually went. So nothing downstream
 * of the trace needs a notion of a delay slot at all.
 *
 * The other thing to know is that register zero is not a register. It
 * reads as zero and discards writes, so it can never carry a dependence
 * and is left out of both lists — which is what stops every `nop`, every
 * `move` and every compare-with-zero from appearing to be dependent on one
 * another.
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
import { Flow, ISA_NAME, MIPS, MIPS_NAME, decode, type MipsInst, type MipsOp } from './decode.ts'

/** r0..r31, then HI and LO, then f0..f31, then the coprocessor status. */
export const HI_ID = 32
export const LO_ID = 33
export const FP_BASE = 34
export const FCSR_ID = 66
export const REG_COUNT = 67

const GPR_NAMES = [
  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
  't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
  't8', 't9', 'k0', 'k1', 'gp', 'sp', 's8', 'ra',
]

export const MIPS_NAMING: RegisterNaming = {
  count: REG_COUNT,
  name(id: number): string {
    if (id < 32) return GPR_NAMES[id]!
    if (id === HI_ID) return 'hi'
    if (id === LO_ID) return 'lo'
    if (id >= FP_BASE && id < FCSR_ID) return `f${id - FP_BASE}`
    if (id === FCSR_ID) return 'fcsr'
    return `?${id}`
  },
}

/** Operations that use the coprocessor's register file. */
const FP_OPS = new Set<MipsOp>([
  MIPS.FP_ADD, MIPS.FP_SUB, MIPS.FP_MUL, MIPS.FP_DIV, MIPS.FP_SQRT,
  MIPS.FP_ABS, MIPS.FP_NEG, MIPS.FP_MOV, MIPS.FP_CVT, MIPS.FP_ROUND,
  MIPS.FP_CMP, MIPS.FP_MOVCF, MIPS.FP_MOVZ, MIPS.FP_MOVN,
])

const LOAD_OPS = new Set<MipsOp>([
  MIPS.LB, MIPS.LBU, MIPS.LH, MIPS.LHU, MIPS.LW, MIPS.LL,
  MIPS.LWL, MIPS.LWR, MIPS.FP_LOAD,
])
const STORE_OPS = new Set<MipsOp>([
  MIPS.SB, MIPS.SH, MIPS.SW, MIPS.SC, MIPS.SWL, MIPS.SWR, MIPS.FP_STORE,
])
const MUL_OPS = new Set<MipsOp>([
  MIPS.MULT, MIPS.MULTU, MIPS.MUL, MIPS.MADD, MIPS.MSUB,
])
const DIV_OPS = new Set<MipsOp>([MIPS.DIV, MIPS.DIVU])
const CONTROL_OPS = new Set<MipsOp>([
  MIPS.J, MIPS.JAL, MIPS.JR, MIPS.JALR, MIPS.BEQ, MIPS.BNE, MIPS.BLEZ,
  MIPS.BGTZ, MIPS.BLTZ, MIPS.BGEZ, MIPS.BLTZAL, MIPS.BGEZAL, MIPS.BC1,
  MIPS.SYSCALL, MIPS.BREAK,
])

function classOf(inst: MipsInst): InstClass {
  if (LOAD_OPS.has(inst.op)) return InstClass.LD
  if (STORE_OPS.has(inst.op)) return InstClass.ST
  if (CONTROL_OPS.has(inst.op)) return InstClass.BR
  if (DIV_OPS.has(inst.op) || inst.op === MIPS.FP_DIV) return InstClass.DIV
  if (MUL_OPS.has(inst.op)) return InstClass.MUL
  if (FP_OPS.has(inst.op)) return InstClass.FP
  if (inst.op === MIPS.SYNC) return InstClass.NOP
  if (
    inst.op === MIPS.LUI || inst.op === MIPS.MFC1 || inst.op === MIPS.MTC1 ||
    inst.op === MIPS.MFHC1 || inst.op === MIPS.MTHC1 || inst.op === MIPS.MFHI ||
    inst.op === MIPS.MFLO || inst.op === MIPS.MTHI || inst.op === MIPS.MTLO ||
    inst.op === MIPS.CFC1 || inst.op === MIPS.CTC1 || inst.op === MIPS.RDHWR
  ) return InstClass.MOV
  return InstClass.ALU
}

function latencyOf(inst: MipsInst): LatencyClass {
  if (LOAD_OPS.has(inst.op)) return LatencyClass.LOAD
  if (DIV_OPS.has(inst.op)) return LatencyClass.DIV
  if (MUL_OPS.has(inst.op)) return LatencyClass.MUL
  if (inst.op === MIPS.FP_DIV || inst.op === MIPS.FP_SQRT) return LatencyClass.FP_DIV
  if (inst.op === MIPS.FP_MUL) return LatencyClass.FP_MUL
  if (FP_OPS.has(inst.op)) return LatencyClass.FP_ADD
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

export function render(inst: MipsInst): string {
  const name = MIPS_NAME[inst.op] ?? '?'
  const fp = FP_OPS.has(inst.op)
  const parts: string[] = []
  const reg = (n: number, coprocessor: boolean): string =>
    coprocessor ? `f${n}` : GPR_NAMES[n] ?? `r${n}`
  if (inst.rd >= 0) parts.push(reg(inst.rd, fp))
  if (inst.rs >= 0) parts.push(reg(inst.rs, fp))
  if (inst.rt >= 0) parts.push(reg(inst.rt, fp && inst.op !== MIPS.FP_MOVZ &&
    inst.op !== MIPS.FP_MOVN))
  if (inst.imm !== 0n) parts.push(`#${inst.imm}`)
  if (inst.sa !== 0) parts.push(`#${inst.sa}`)
  if (inst.target !== 0n) parts.push(`0x${inst.target.toString(16)}`)
  return parts.length > 0 ? `${name} ${parts.join(', ')}` : name
}

export interface MipsStaticInst extends StaticInst {
  readonly inst: MipsInst
}

function toStatic(inst: MipsInst, addr: bigint): MipsStaticInst {
  const reads: number[] = []
  const writes: number[] = []
  // Register zero can never carry a dependence, so it is left out of both
  // lists rather than tracked and ignored.
  const addRead = (id: number): void => {
    if (id > 0 && !reads.includes(id)) reads.push(id)
  }
  const addWrite = (id: number): void => {
    if (id > 0 && !writes.includes(id)) writes.push(id)
  }
  const fp = FP_OPS.has(inst.op)
  const memory = LOAD_OPS.has(inst.op) || STORE_OPS.has(inst.op)

  if (memory) {
    addRead(inst.rs)
    const coprocessor = inst.op === MIPS.FP_LOAD || inst.op === MIPS.FP_STORE
    const slot = coprocessor ? FP_BASE + inst.rt : inst.rt
    if (LOAD_OPS.has(inst.op)) {
      addWrite(slot)
      // The unaligned pair merges into what is already there, and a
      // store-conditional reports its success in the register it stored.
      if (inst.op === MIPS.LWL || inst.op === MIPS.LWR) addRead(slot)
    } else {
      addRead(slot)
      if (inst.op === MIPS.SC) addWrite(slot)
      if (inst.op === MIPS.SWL || inst.op === MIPS.SWR) addRead(slot)
    }
  } else if (fp) {
    if (inst.rs >= 0) addRead(FP_BASE + inst.rs)
    if (inst.rt >= 0) {
      // The conditional moves take their condition from a general
      // register while everything else about them is coprocessor state.
      const fromGeneral = inst.op === MIPS.FP_MOVZ || inst.op === MIPS.FP_MOVN
      addRead(fromGeneral ? inst.rt : FP_BASE + inst.rt)
    }
    if (inst.rd >= 0) {
      if (inst.op === MIPS.FP_CMP) addRead(FP_BASE + inst.rd)
      else addWrite(FP_BASE + inst.rd)
    }
    // A conditional move leaves the destination alone when the condition
    // fails, so it depends on what was there.
    if (inst.op === MIPS.FP_MOVCF || inst.op === MIPS.FP_MOVZ || inst.op === MIPS.FP_MOVN) {
      addRead(FP_BASE + inst.rd)
    }
    if (inst.op === MIPS.FP_CMP) addWrite(FCSR_ID)
    if (inst.op === MIPS.FP_MOVCF) addRead(FCSR_ID)
  } else {
    if (inst.rs >= 0) addRead(inst.rs)
    if (inst.rt >= 0) addRead(inst.rt)
    if (inst.rd >= 0) addWrite(inst.rd)
    // The immediate forms write rt rather than rd, which is the one place
    // the field names mislead.
    if (inst.rd < 0 && inst.rt >= 0 && writesRt(inst.op)) {
      addWrite(inst.rt)
    }
  }

  // The operands the encoding does not name.
  if (MUL_OPS.has(inst.op) || DIV_OPS.has(inst.op)) {
    if (inst.op !== MIPS.MUL) {
      addWrite(HI_ID)
      addWrite(LO_ID)
      if (inst.op === MIPS.MADD || inst.op === MIPS.MSUB) {
        addRead(HI_ID)
        addRead(LO_ID)
      }
    }
  }
  if (inst.op === MIPS.MFHI) addRead(HI_ID)
  if (inst.op === MIPS.MFLO) addRead(LO_ID)
  if (inst.op === MIPS.MTHI) addWrite(HI_ID)
  if (inst.op === MIPS.MTLO) addWrite(LO_ID)
  if (inst.op === MIPS.MFC1 || inst.op === MIPS.MFHC1) {
    addRead(FP_BASE + inst.rd)
    addWrite(inst.rt)
  }
  if (inst.op === MIPS.MTC1 || inst.op === MIPS.MTHC1) {
    addRead(inst.rt)
    addWrite(FP_BASE + inst.rd)
  }
  if (inst.op === MIPS.CFC1) { addRead(FCSR_ID); addWrite(inst.rt) }
  if (inst.op === MIPS.CTC1) { addRead(inst.rt); addWrite(FCSR_ID) }
  if (inst.op === MIPS.BC1) addRead(FCSR_ID)
  if (inst.op === MIPS.JAL || inst.op === MIPS.BLTZAL || inst.op === MIPS.BGEZAL) addWrite(31)
  if (inst.op === MIPS.SYSCALL) {
    for (const id of [2, 4, 5, 6, 7, 29]) addRead(id)
    addWrite(2)
    addWrite(7)
  }

  const control = CONTROL_OF[inst.flow]!
  const direct = control === ControlKind.COND || control === ControlKind.JUMP ||
    (control === ControlKind.CALL && (inst.op === MIPS.JAL ||
      inst.op === MIPS.BLTZAL || inst.op === MIPS.BGEZAL))

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
    staticTarget: direct ? inst.target : NO_ADDRESS,
    readsMem: LOAD_OPS.has(inst.op),
    writesMem: STORE_OPS.has(inst.op),
    accessWidth: memory ? inst.width : 0,
    serializing: inst.op === MIPS.SYSCALL || inst.op === MIPS.BREAK ||
      inst.op === MIPS.SYNC || inst.op === MIPS.LL || inst.op === MIPS.SC,
    origin: OperationOrigin.SEMANTIC,
    inst,
  }
}

/** The immediate forms, whose destination is rt rather than rd. */
function writesRt(op: MipsOp): boolean {
  return op === MIPS.ADDIU || op === MIPS.ANDI || op === MIPS.ORI ||
    op === MIPS.XORI || op === MIPS.SLTI || op === MIPS.SLTIU ||
    op === MIPS.LUI || op === MIPS.EXT || op === MIPS.INS ||
    op === MIPS.RDHWR
}

export class MipsImage implements ProgramImage {
  readonly isa = ISA_NAME
  readonly entry: bigint
  readonly naming = MIPS_NAMING
  readonly codeBytes: number
  private readonly memory: GuestMemory
  private readonly cache = new Map<number, MipsStaticInst>()
  private readonly failed = new Set<number>()

  constructor(memory: GuestMemory, entry: bigint, codeBytes: number) {
    this.memory = memory
    this.entry = entry
    this.codeBytes = codeBytes
  }

  at(addr: bigint): MipsStaticInst {
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

  speculativeAt(addr: bigint): MipsStaticInst | null {
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
