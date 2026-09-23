/**
 * SPARC V8 program image: the static half the timing model consumes.
 *
 * ## The register window, and what the contract can and cannot say
 *
 * This is the one place where the frozen backend contract does not quite
 * fit an architecture, and it is worth being exact about why rather than
 * quietly approximating.
 *
 * `reads` and `writes` are resource ids attached to a *statically
 * decoded instruction*, which the image caches by address. On this
 * architecture the register an instruction names is not determined by
 * the instruction: `%l0` is a different physical register in every
 * window, and `%o0` in one window is the same physical register as
 * `%i0` in the next. The exact answer therefore depends on the current
 * window pointer, which is dynamic, and the contract has nowhere to put
 * it -- the image is addressed by program counter, and a retired chunk
 * can span many windows before the timing model walks it.
 *
 * The contract was frozen deliberately and had survived four backends
 * with one documented addition, so it was not reopened for a
 * refinement to a timing model. What is done instead is stated plainly:
 *
 * **Window registers are identified window-relative, and the window
 * pointer is itself a resource.** Every instruction that names a window
 * register reads `Res.WINDOW`, and `save` and `restore` read and write
 * it. That is not a workaround dressed up -- it is true of the hardware,
 * since reading `%l0` genuinely does depend on which window is current,
 * and it makes the dependence on a preceding `save` real rather than
 * missing.
 *
 * What remains approximate: two instructions naming `%l0` in different
 * windows look like the same resource, and a caller's `%o0` and a
 * callee's `%i0` look like different ones when they are the same
 * register. Both errors are confined to a window boundary, because the
 * `save` between them is a dependence that both sides carry. For an
 * in-order model whose output is model cycles, that is a bounded
 * inaccuracy in a number that is already declared not to be measured.
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
import { Cond, Flow, ISA_NAME, SPARC, SPARC_NAME, decode, type SparcInst } from './decode.ts'

/** Architectural resource ids. */
export const Res = {
  /** g0..g7 are 0..7; g0 never appears in a list. */
  GLOBAL: 0,
  /** %o0..%o7, %l0..%l7, %i0..%i7, window-relative. */
  OUT: 8,
  LOCAL: 16,
  IN: 24,
  Y: 32,
  N: 33,
  Z: 34,
  V: 35,
  C: 36,
  /** The current window pointer. See the note at the top. */
  WINDOW: 37,
  /**
   * The second program counter, which on this architecture is state
   * rather than a derived value.
   */
  NPC: 38,
  /** Which windows may not be entered without spilling first. */
  WIM: 39,
  FCC: 40,
  FP: 41,
} as const

/**
 * Ids 0 to 39 are exactly what the lockstep tier compares, in the same
 * order, so a mismatch is labelled with the name of the thing that
 * actually differs. Getting that wrong is only a reporting bug, but it
 * is the kind that sends you looking in the wrong place: an earlier
 * version of this reported a differing `npc` as a differing `z`.
 */
export const LOCKSTEP_COUNT = 40

export const REG_COUNT = Res.FP + 32

const NAMES: readonly string[] = (() => {
  const names: string[] = []
  for (let i = 0; i < 8; i++) names[i] = `g${i}`
  for (let i = 0; i < 8; i++) names[Res.OUT + i] = `o${i}`
  for (let i = 0; i < 8; i++) names[Res.LOCAL + i] = `l${i}`
  for (let i = 0; i < 8; i++) names[Res.IN + i] = `i${i}`
  names[Res.Y] = 'y'
  names[Res.N] = 'n'
  names[Res.Z] = 'z'
  names[Res.V] = 'v'
  names[Res.C] = 'c'
  names[Res.WINDOW] = 'cwp'
  names[Res.NPC] = 'npc'
  names[Res.WIM] = 'wim'
  names[Res.FCC] = 'fcc'
  for (let i = 0; i < 32; i++) names[Res.FP + i] = `f${i}`
  return names
})()

export const SPARC_NAMING: RegisterNaming = {
  count: REG_COUNT,
  name(id: number): string {
    return NAMES[id] ?? `?${id}`
  },
}

const LOAD_OPS = new Set<number>([
  SPARC.LD, SPARC.LDUB, SPARC.LDUH, SPARC.LDD, SPARC.LDSB, SPARC.LDSH,
  SPARC.LDSTUB, SPARC.SWAP, SPARC.LDF, SPARC.LDDF, SPARC.LDFSR,
])
const STORE_OPS = new Set<number>([
  SPARC.ST, SPARC.STB, SPARC.STH, SPARC.STD, SPARC.STF, SPARC.STDF,
  SPARC.STFSR, SPARC.LDSTUB, SPARC.SWAP,
])
const FP_OPS = new Set<number>([
  SPARC.FADD, SPARC.FSUB, SPARC.FMUL, SPARC.FDIV, SPARC.FSQRT,
  SPARC.FMOV, SPARC.FNEG, SPARC.FABS, SPARC.FTO, SPARC.FCMP, SPARC.FSMULD,
])
/** Operations whose destination is a floating-point register. */
const FP_DEST = new Set<number>([
  SPARC.FADD, SPARC.FSUB, SPARC.FMUL, SPARC.FDIV, SPARC.FSQRT,
  SPARC.FMOV, SPARC.FNEG, SPARC.FABS, SPARC.FTO, SPARC.FSMULD,
  SPARC.LDF, SPARC.LDDF,
])

function classOf(inst: SparcInst): InstClass {
  if (LOAD_OPS.has(inst.op) && !STORE_OPS.has(inst.op)) return InstClass.LD
  if (STORE_OPS.has(inst.op)) return InstClass.ST
  if (inst.flow !== Flow.SEQ) return InstClass.BR
  if (inst.op === SPARC.UDIV || inst.op === SPARC.SDIV || inst.op === SPARC.FDIV) {
    return InstClass.DIV
  }
  if (inst.op === SPARC.UMUL || inst.op === SPARC.SMUL || inst.op === SPARC.MULSCC) {
    return InstClass.MUL
  }
  if (FP_OPS.has(inst.op)) return InstClass.FP
  if (inst.op === SPARC.SETHI || inst.op === SPARC.RDY || inst.op === SPARC.WRY) {
    return InstClass.MOV
  }
  if (inst.op === SPARC.FLUSH) return InstClass.NOP
  return InstClass.ALU
}

function latencyOf(inst: SparcInst): LatencyClass {
  if (LOAD_OPS.has(inst.op)) return LatencyClass.LOAD
  if (inst.op === SPARC.UDIV || inst.op === SPARC.SDIV) return LatencyClass.DIV
  if (inst.op === SPARC.UMUL || inst.op === SPARC.SMUL) return LatencyClass.MUL
  if (inst.op === SPARC.FDIV || inst.op === SPARC.FSQRT) return LatencyClass.FP_DIV
  if (inst.op === SPARC.FMUL || inst.op === SPARC.FSMULD) return LatencyClass.FP_MUL
  if (FP_OPS.has(inst.op)) return LatencyClass.FP_ADD
  return LatencyClass.FIXED
}

const CONTROL_OF: Readonly<Record<number, ControlKind>> = {
  [Flow.SEQ]: ControlKind.SEQ,
  [Flow.BRANCH]: ControlKind.COND,
  [Flow.CALL]: ControlKind.CALL,
  [Flow.INDIRECT]: ControlKind.INDIRECT,
  [Flow.TRAP]: ControlKind.TRAP,
}

/**
 * How an instruction transfers control, which for `jmpl` depends on its
 * operands rather than its opcode.
 *
 * `jmpl` is the one indirect transfer, and the architecture spells calls
 * and returns with it: linking into %o7 is a call through a register, and
 * jumping to %i7+8 or %o7+8 while discarding the link is `ret` or `retl`.
 * Treating every one as an indirect jump charged each return a redirect
 * and left calls unpaired, so a return-address stack never saw one.
 */
function controlOf(inst: SparcInst): ControlKind {
  if (inst.op === SPARC.JMPL) {
    if (inst.rd === 15) return ControlKind.CALL
    if (inst.rd === 0 && inst.immediate && inst.imm === 8 &&
        (inst.rs1 === 15 || inst.rs1 === 31)) {
      return ControlKind.RET
    }
  }
  return CONTROL_OF[inst.flow]!
}

const CONDITION_NAME: readonly string[] = [
  'n', 'e', 'le', 'l', 'leu', 'cs', 'neg', 'vs',
  'a', 'ne', 'g', 'ge', 'gu', 'cc', 'pos', 'vc',
]

function regName(r: number): string {
  if (r < 8) return `%g${r}`
  if (r < 16) return `%o${r - 8}`
  if (r < 24) return `%l${r - 16}`
  return `%i${r - 24}`
}

export function render(inst: SparcInst): string {
  const name = SPARC_NAME[inst.op] ?? '?'
  switch (inst.op) {
    case SPARC.CALL:
      return `call 0x${inst.target.toString(16)}`
    case SPARC.BICC:
      return `b${CONDITION_NAME[inst.cond]}${inst.annul ? ',a' : ''} ` +
        `0x${inst.target.toString(16)}`
    case SPARC.FBFCC:
      return `fb${CONDITION_NAME[inst.cond]}${inst.annul ? ',a' : ''} ` +
        `0x${inst.target.toString(16)}`
    case SPARC.SETHI:
      return `sethi %hi(0x${inst.imm.toString(16)}), ${regName(inst.rd)}`
    default: {
      const parts: string[] = []
      if (inst.rs1 >= 0) parts.push(regName(inst.rs1))
      if (inst.immediate) parts.push(`${inst.imm}`)
      else if (inst.rs2 >= 0) parts.push(FP_OPS.has(inst.op) ? `%f${inst.rs2}` : regName(inst.rs2))
      if (inst.rd >= 0) parts.push(FP_DEST.has(inst.op) ? `%f${inst.rd}` : regName(inst.rd))
      const suffix = inst.writesIcc && inst.op !== SPARC.SUB ? 'cc' : ''
      return parts.length > 0 ? `${name}${suffix} ${parts.join(', ')}` : name
    }
  }
}

export interface SparcStaticInst extends StaticInst {
  readonly inst: SparcInst
}

function toStatic(inst: SparcInst, addr: bigint): SparcStaticInst {
  const reads: number[] = []
  const writes: number[] = []
  let touchesWindow = false

  const note = (r: number): void => { if (r >= 8) touchesWindow = true }
  const addRead = (id: number): void => {
    // %g0 can never carry a dependence, so it is in neither list.
    if (id === 0) return
    if (!reads.includes(id)) reads.push(id)
  }
  const addWrite = (id: number): void => {
    if (id === 0) return
    if (!writes.includes(id)) writes.push(id)
  }

  const fpDest = FP_DEST.has(inst.op)
  const fpSource = FP_OPS.has(inst.op)

  if (inst.rs1 >= 0) {
    if (fpSource && inst.op !== SPARC.FTO) { addRead(Res.FP + inst.rs1) }
    else { addRead(inst.rs1); note(inst.rs1) }
  }
  if (!inst.immediate && inst.rs2 >= 0) {
    if (fpSource) addRead(Res.FP + inst.rs2)
    else { addRead(inst.rs2); note(inst.rs2) }
  }

  if (inst.rd >= 0) {
    if (fpDest) {
      addWrite(Res.FP + inst.rd)
      // A double writes a register pair.
      if (inst.width === 8 || inst.toFormat === 2) addWrite(Res.FP + (inst.rd | 1))
    } else if (STORE_OPS.has(inst.op)) {
      // The "destination" of a store is the value being stored.
      if (inst.op === SPARC.STF || inst.op === SPARC.STDF) {
        addRead(Res.FP + inst.rd)
        if (inst.op === SPARC.STDF) addRead(Res.FP + (inst.rd | 1))
      } else {
        addRead(inst.rd); note(inst.rd)
        if (inst.op === SPARC.STD) { addRead(inst.rd | 1); note(inst.rd | 1) }
      }
      if (inst.op === SPARC.LDSTUB || inst.op === SPARC.SWAP) {
        addWrite(inst.rd); note(inst.rd)
      }
    } else {
      addWrite(inst.rd); note(inst.rd)
      if (inst.op === SPARC.LDD) { addWrite(inst.rd | 1); note(inst.rd | 1) }
    }
  }

  if (inst.writesIcc) {
    addWrite(Res.N); addWrite(Res.Z); addWrite(Res.V); addWrite(Res.C)
  }
  if (inst.op === SPARC.ADDX || inst.op === SPARC.SUBX) addRead(Res.C)
  if (inst.op === SPARC.MULSCC) { addRead(Res.N); addRead(Res.V); addRead(Res.Y) }
  if (inst.op === SPARC.UMUL || inst.op === SPARC.SMUL) addWrite(Res.Y)
  if (inst.op === SPARC.UDIV || inst.op === SPARC.SDIV) addRead(Res.Y)
  if (inst.op === SPARC.RDY) addRead(Res.Y)
  if (inst.op === SPARC.WRY) addWrite(Res.Y)
  if (inst.op === SPARC.FCMP) addWrite(Res.FCC)
  if (inst.op === SPARC.FBFCC) addRead(Res.FCC)

  // Which flags a branch actually looks at. Listing only those, rather
  // than all four, is what lets a compare and an unrelated branch
  // overlap the way they do on the hardware.
  if (inst.op === SPARC.BICC || inst.op === SPARC.TICC) {
    for (const id of flagsFor(inst.cond)) addRead(id)
  }

  if (inst.op === SPARC.CALL) { addWrite(Res.OUT + 7); touchesWindow = true }

  // `save` and `restore` move the window, so they are the one thing that
  // genuinely writes it. Everything above that named a window register
  // depends on it.
  if (inst.op === SPARC.SAVE || inst.op === SPARC.RESTORE) {
    addRead(Res.WINDOW)
    addWrite(Res.WINDOW)
    touchesWindow = true
  } else if (touchesWindow) {
    addRead(Res.WINDOW)
  }

  const readsMem = LOAD_OPS.has(inst.op)
  const writesMem = STORE_OPS.has(inst.op)
  const control = controlOf(inst)
  const direct = control === ControlKind.COND || inst.op === SPARC.CALL

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
    staticTarget: direct ? BigInt(inst.target >>> 0) : NO_ADDRESS,
    readsMem,
    writesMem,
    accessWidth: readsMem || writesMem ? inst.width : 0,
    serializing: inst.op === SPARC.TICC || inst.op === SPARC.LDSTUB ||
      inst.op === SPARC.SWAP || inst.op === SPARC.UNIMP,
    origin: OperationOrigin.SEMANTIC,
    inst,
  }
}

/** Which condition-code bits a branch condition consults. */
function flagsFor(cond: number): readonly number[] {
  switch (cond) {
    case Cond.N: case Cond.A: return []
    case Cond.E: case Cond.NE: return [Res.Z]
    case Cond.LE: case Cond.G: return [Res.Z, Res.N, Res.V]
    case Cond.L: case Cond.GE: return [Res.N, Res.V]
    case Cond.LEU: case Cond.GU: return [Res.C, Res.Z]
    case Cond.CS: case Cond.CC: return [Res.C]
    case Cond.NEG: case Cond.POS: return [Res.N]
    default: return [Res.V]
  }
}

export class SparcImage implements ProgramImage {
  readonly isa = ISA_NAME
  readonly entry: bigint
  readonly naming = SPARC_NAMING
  readonly codeBytes: number
  /** Every control transfer has one: `call` links past it, `ret` adds 8. */
  readonly delaySlotBytes = 4
  private readonly memory: GuestMemory
  private readonly cache = new Map<number, SparcStaticInst>()
  private readonly failed = new Set<number>()

  constructor(memory: GuestMemory, entry: bigint, codeBytes: number) {
    this.memory = memory
    this.entry = entry
    this.codeBytes = codeBytes
  }

  at(addr: bigint): SparcStaticInst {
    const key = Number(addr)
    const hit = this.cache.get(key)
    if (hit) return hit
    if ((key & 3) !== 0) {
      throw new IsaError(
        `${ISA_NAME}: misaligned instruction fetch at 0x${addr.toString(16)}`,
      )
    }
    // Big endian, so the halves go the other way round from every other
    // target here.
    const high = this.memory.fetchHalf(addr)
    const low = this.memory.fetchHalf(addr + 2n)
    const word = ((high << 16) | low) >>> 0
    const result = toStatic(decode(word, addr), addr)
    this.cache.set(key, result)
    return result
  }

  speculativeAt(addr: bigint): SparcStaticInst | null {
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
