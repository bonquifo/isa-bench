/**
 * POWER program image: the static half the timing model consumes.
 *
 * Two decisions about the resource-id space are particular to this
 * architecture, and both were predicted before the backend was built
 * and confirmed by what the compiler actually emits.
 *
 * ## The condition register is eight resources, not one
 *
 * `cr` is 32 bits holding eight independent four-bit fields, and an
 * instruction names which field it uses. A compare writes one field; a
 * branch reads one field; and code that has two conditions in flight
 * puts them in different fields precisely so that neither waits for the
 * other. Treating `cr` as a single resource would serialise exactly the
 * code that was written not to serialise, which is why there are eight
 * ids here rather than one.
 *
 * ## The floating-point registers are a view, not a file
 *
 * At `-O2` for POWER8 clang does not emit `fadd`; it emits `xsadddp`,
 * the VSX instruction operating on one element of a 128-bit register.
 * The 32 floating-point registers *are* the upper halves of the first
 * 32 VSX registers -- the same storage under two names, exactly as
 * SPARC's `%o` and `%i` are -- so `lfd` into `f3` and `xsadddp` on
 * `vs3` touch one resource. Giving them separate ids would report two
 * independent values where the hardware has one, and would miss every
 * dependence between the classic unit and the vector one.
 *
 * Here that aliasing is *exact* rather than approximate, because unlike
 * SPARC's windows it does not depend on anything dynamic: `f3` is
 * always the top half of `vs3`. So the id is simply the VSX number, and
 * an instruction naming a floating-point register resolves to it at
 * decode time.
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
import { File, Flow, ISA_NAME, PPC, PPC_NAME, decode, type PpcInst } from './decode.ts'

/**
 * Architectural resource ids.
 *
 * Ordered so that everything the lockstep tier compares comes first and
 * in the same order, which is what makes a mismatch name the thing that
 * actually differs. The vector registers come last because the
 * reference does not report them at all -- qemu's dump has no
 * floating-point state -- so they are covered by the guest's own dump
 * instead.
 */
export const Res = {
  /** r0..r31. */
  GPR: 0,
  LR: 32,
  CTR: 33,
  /** The fixed-point exception register, which is where carry lives. */
  XER: 34,
  /** The eight condition-register fields, each its own resource. */
  CR: 35,
  /** The floating-point status and control register. */
  FPSCR: 43,
  /**
   * vs0..vs63. The floating-point registers are the first 32 of these
   * rather than a file of their own; see the note at the top.
   */
  VSR: 44,
} as const

/** What the lockstep tier compares: ids 0 to 42, in this order. */
export const LOCKSTEP_COUNT = 43

export const REG_COUNT = Res.VSR + 64

const NAMES: readonly string[] = (() => {
  const names: string[] = []
  for (let i = 0; i < 32; i++) names[Res.GPR + i] = `r${i}`
  names[Res.LR] = 'lr'
  names[Res.CTR] = 'ctr'
  names[Res.XER] = 'xer'
  for (let i = 0; i < 8; i++) names[Res.CR + i] = `cr${i}`
  names[Res.FPSCR] = 'fpscr'
  for (let i = 0; i < 64; i++) names[Res.VSR + i] = `vs${i}`
  return names
})()

export const POWER_NAMING: RegisterNaming = {
  count: REG_COUNT,
  name(id: number): string {
    return NAMES[id] ?? `?${id}`
  },
}

/** Special-purpose register numbers, of which three are reachable here. */
export const Spr = { XER: 1, LR: 8, CTR: 9, VRSAVE: 256 } as const

const LOAD_OPS = new Set<number>([
  PPC.LOAD, PPC.LOADU, PPC.LOADX, PPC.LOADUX, PPC.LOADBR, PPC.LARX,
  PPC.LXVD2X, PPC.LXSIWZX, PPC.LFIW,
])
const STORE_OPS = new Set<number>([
  PPC.STORE, PPC.STOREU, PPC.STOREX, PPC.STOREUX, PPC.STOREBR, PPC.STCX,
  PPC.STXVD2X, PPC.STXSDX, PPC.STFIWX,
])
/** The forms that write the base register back with the new address. */
const UPDATE_OPS = new Set<number>([
  PPC.LOADU, PPC.LOADUX, PPC.STOREU, PPC.STOREUX,
])
const FP_OPS = new Set<number>([
  PPC.FADD, PPC.FSUB, PPC.FMUL, PPC.FDIV, PPC.FSQRT, PPC.FMADD, PPC.FMSUB,
  PPC.FNMADD, PPC.FNMSUB, PPC.FMR, PPC.FNEG, PPC.FABS, PPC.FNABS,
  PPC.FCMPU, PPC.FCMPO, PPC.FCFID, PPC.FRSP,
  PPC.FSEL,
  PPC.XSADD, PPC.XSSUB, PPC.XSMUL, PPC.XSDIV, PPC.XSSQRT, PPC.XSMADD,
  PPC.XSMSUB, PPC.XSNMADD, PPC.XSNMSUB, PPC.XSCMP, PPC.XSCVT,
  PPC.XSNEG, PPC.XSABS, PPC.XSNABS, PPC.XSCPSGN, PPC.XSMAX, PPC.XSMIN,
  PPC.XSRDPI, PPC.XVCVT, PPC.XVADD, PPC.XVMUL,
])
const MUL_OPS = new Set<number>([
  PPC.VMULUWM,
  PPC.MULLI, PPC.MULLW, PPC.MULLD, PPC.MULHW, PPC.MULHWU, PPC.MULHD, PPC.MULHDU,
])
const DIV_OPS = new Set<number>([PPC.DIVW, PPC.DIVWU, PPC.DIVD, PPC.DIVDU])

function classOf(inst: PpcInst): InstClass {
  if (LOAD_OPS.has(inst.op)) return InstClass.LD
  if (STORE_OPS.has(inst.op)) return InstClass.ST
  if (inst.flow !== Flow.SEQ) return InstClass.BR
  if (DIV_OPS.has(inst.op) || inst.op === PPC.FDIV || inst.op === PPC.XSDIV) {
    return InstClass.DIV
  }
  if (MUL_OPS.has(inst.op)) return InstClass.MUL
  if (FP_OPS.has(inst.op)) return InstClass.FP
  switch (inst.op) {
    case PPC.MFSPR: case PPC.MTSPR: case PPC.MFCR: case PPC.MTCRF:
    case PPC.MFVSR: case PPC.MTVSR: case PPC.ADDI: case PPC.ADDIS:
      return InstClass.MOV
    case PPC.SYNC: case PPC.ISYNC: case PPC.NOP_CACHE:
      return InstClass.NOP
    default:
      return InstClass.ALU
  }
}

function latencyOf(inst: PpcInst): LatencyClass {
  if (LOAD_OPS.has(inst.op)) return LatencyClass.LOAD
  if (DIV_OPS.has(inst.op)) return LatencyClass.DIV
  if (MUL_OPS.has(inst.op)) return LatencyClass.MUL
  if (inst.op === PPC.FDIV || inst.op === PPC.XSDIV ||
      inst.op === PPC.FSQRT || inst.op === PPC.XSSQRT) return LatencyClass.FP_DIV
  if (inst.op === PPC.FMUL || inst.op === PPC.XSMUL || inst.op === PPC.XVMUL) {
    return LatencyClass.FP_MUL
  }
  if (FP_OPS.has(inst.op)) return LatencyClass.FP_ADD
  return LatencyClass.FIXED
}

const CONTROL_OF: Readonly<Record<number, ControlKind>> = {
  [Flow.SEQ]: ControlKind.SEQ,
  [Flow.BRANCH]: ControlKind.COND,
  [Flow.JUMP]: ControlKind.JUMP,
  [Flow.CALL]: ControlKind.CALL,
  [Flow.RET]: ControlKind.RET,
  [Flow.INDIRECT]: ControlKind.INDIRECT,
  [Flow.TRAP]: ControlKind.TRAP,
}

export function render(inst: PpcInst): string {
  const name = PPC_NAME[inst.op] ?? '?'
  const reg = (n: number, file: number): string =>
    file === File.VSR ? `vs${n}` : file === File.FPR ? `f${n}` :
    file === File.CR ? `cr${n}` : `r${n}`
  const parts: string[] = []
  if (inst.op === PPC.B || inst.op === PPC.BC) {
    return `${name} 0x${inst.target.toString(16)}`
  }
  if (inst.rd >= 0) parts.push(reg(inst.rd, inst.destFile))
  if (inst.destFile === File.CR && inst.rd < 0) parts.push(`cr${inst.crField}`)
  if (inst.ra >= 0) parts.push(reg(inst.ra, inst.sourceFile))
  if (inst.rb >= 0) parts.push(reg(inst.rb, inst.sourceFile))
  if (inst.rc >= 0) parts.push(reg(inst.rc, inst.sourceFile))
  if (inst.imm !== 0n) parts.push(`${inst.imm}`)
  const suffix = inst.recordCr ? '.' : ''
  return parts.length > 0 ? `${name}${suffix} ${parts.join(', ')}` : `${name}${suffix}`
}

export interface PowerStaticInst extends StaticInst {
  readonly inst: PpcInst
}

/** The resource an operand names, given which file it is in. */
function resourceOf(index: number, file: number): number {
  switch (file) {
    // A floating-point register and the VSX register that contains it
    // are one resource, because they are one register.
    case File.FPR: return Res.VSR + index
    case File.VSR: return Res.VSR + index
    case File.CR: return Res.CR + index
    default: return Res.GPR + index
  }
}

function toStatic(inst: PpcInst, addr: bigint): PowerStaticInst {
  const reads: number[] = []
  const writes: number[] = []
  const addRead = (id: number): void => { if (!reads.includes(id)) reads.push(id) }
  const addWrite = (id: number): void => { if (!writes.includes(id)) writes.push(id) }

  const memory = LOAD_OPS.has(inst.op) || STORE_OPS.has(inst.op)

  if (memory) {
    // The base register is r0 only when the architecture means zero,
    // which for these forms it does -- so a base of r0 is not a read.
    if (inst.ra > 0) addRead(Res.GPR + inst.ra)
    if (inst.rb >= 0) addRead(Res.GPR + inst.rb)
    const slot = resourceOf(inst.rd, inst.destFile)
    if (LOAD_OPS.has(inst.op)) addWrite(slot)
    else addRead(slot)
    if (UPDATE_OPS.has(inst.op) && inst.ra > 0) addWrite(Res.GPR + inst.ra)
    if (inst.op === PPC.STCX) {
      // A store-conditional reports whether it succeeded, in cr0.
      addWrite(Res.CR + 0)
    }
  } else {
    if (inst.ra >= 0) addRead(resourceOf(inst.ra, inst.sourceFile))
    if (inst.rb >= 0) addRead(resourceOf(inst.rb, inst.sourceFile))
    if (inst.rc >= 0) addRead(resourceOf(inst.rc, inst.sourceFile))
    if (inst.rd >= 0) {
      // The logical-immediate forms write `ra` and read `rd`, which is
      // the one family where the field names read backwards.
      if (writesRa(inst.op)) {
        addWrite(Res.GPR + inst.ra)
        addRead(Res.GPR + inst.rd)
        const index = reads.indexOf(Res.GPR + inst.ra)
        if (index >= 0 && inst.ra !== inst.rd) reads.splice(index, 1)
      } else {
        addWrite(resourceOf(inst.rd, inst.destFile))
      }
    }
  }

  // The rotate-and-insert forms merge into what is already there.
  if (inst.op === PPC.RLWIMI || inst.op === PPC.RLDIMI) addRead(Res.GPR + inst.ra)

  // The condition register. A comparison writes one field, a branch
  // reads one, and the record forms write field zero.
  if (inst.destFile === File.CR && inst.rd < 0) addWrite(Res.CR + inst.crField)
  if (inst.recordCr) addWrite(Res.CR + 0)
  if (inst.op === PPC.BC || inst.op === PPC.BCLR || inst.op === PPC.BCCTR) {
    // Only when the branch actually tests a condition: `blr` and the
    // count-register forms do not, and saying they did would make every
    // return wait for the last comparison.
    if ((inst.bo & 0x10) === 0) addRead(Res.CR + (inst.bi >> 2))
    // And only when it decrements the counter.
    if ((inst.bo & 0x04) === 0) { addRead(Res.CTR); addWrite(Res.CTR) }
  }
  if (inst.op === PPC.ISEL) addRead(Res.CR + (inst.bi >> 2))
  if (inst.op === PPC.MFCR) for (let f = 0; f < 8; f++) addRead(Res.CR + f)
  if (inst.op === PPC.MTCRF) {
    for (let f = 0; f < 8; f++) if ((Number(inst.imm) >> (7 - f)) & 1) addWrite(Res.CR + f)
  }
  for (const op of [PPC.CRAND, PPC.CROR, PPC.CRXOR, PPC.CRNAND, PPC.CRNOR,
    PPC.CREQV, PPC.CRANDC, PPC.CRORC]) {
    if (inst.op === op) {
      addWrite(Res.CR + (inst.rd >> 2))
      addRead(Res.CR + (inst.ra >> 2))
      addRead(Res.CR + (inst.rb >> 2))
    }
  }
  if (inst.op === PPC.MCRF) {
    addWrite(Res.CR + (inst.rd >> 2))
    addRead(Res.CR + (inst.ra >> 2))
  }

  // Carry lives in a register of its own, which is what makes the
  // extended-precision chain a chain.
  if (inst.op === PPC.ADDC || inst.op === PPC.SUBFC || inst.op === PPC.ADDIC ||
      inst.op === PPC.ADDE || inst.op === PPC.SUBFE || inst.op === PPC.ADDME ||
      inst.op === PPC.SUBFME || inst.op === PPC.ADDZE || inst.op === PPC.SUBFZE ||
      inst.op === PPC.SUBFIC) {
    addWrite(Res.XER)
  }
  if (inst.op === PPC.ADDE || inst.op === PPC.SUBFE || inst.op === PPC.ADDME ||
      inst.op === PPC.SUBFME || inst.op === PPC.ADDZE || inst.op === PPC.SUBFZE) {
    addRead(Res.XER)
  }
  if (inst.recordOv) addWrite(Res.XER)
  // The arithmetic shifts report whether any bit was shifted out, which
  // is carry again and is how a signed divide by a power of two is done.
  if (inst.op === PPC.SRAW || inst.op === PPC.SRAWI ||
      inst.op === PPC.SRAD || inst.op === PPC.SRADI) addWrite(Res.XER)

  // The link and count registers.
  if ((inst.op === PPC.B || inst.op === PPC.BC || inst.op === PPC.BCLR ||
       inst.op === PPC.BCCTR) && inst.link) addWrite(Res.LR)
  if (inst.op === PPC.BCLR) addRead(Res.LR)
  if (inst.op === PPC.BCCTR) addRead(Res.CTR)
  if (inst.op === PPC.MFSPR) {
    addRead(sprResource(inst.spr))
    addWrite(Res.GPR + inst.rd)
  }
  if (inst.op === PPC.MTSPR) {
    addWrite(sprResource(inst.spr))
    addRead(Res.GPR + inst.rd)
  }

  const control = CONTROL_OF[inst.flow]!
  const direct = control === ControlKind.COND || control === ControlKind.JUMP ||
    (control === ControlKind.CALL && inst.op === PPC.B)

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
    serializing: inst.op === PPC.SC || inst.op === PPC.SYNC ||
      inst.op === PPC.ISYNC || inst.op === PPC.LARX || inst.op === PPC.STCX,
    origin: OperationOrigin.SEMANTIC,
    inst,
  }
}

/** Which resource a special-purpose register number names. */
function sprResource(spr: number): number {
  switch (spr) {
    case Spr.LR: return Res.LR
    case Spr.CTR: return Res.CTR
    case Spr.XER: return Res.XER
    default: return Res.XER
  }
}

/** The immediate forms whose destination is `ra` rather than `rd`. */
function writesRa(op: number): boolean {
  return op === PPC.ORI || op === PPC.ORIS || op === PPC.XORI || op === PPC.XORIS ||
    op === PPC.ANDI || op === PPC.ANDIS ||
    op === PPC.AND || op === PPC.ANDC || op === PPC.OR || op === PPC.ORC ||
    op === PPC.XOR || op === PPC.NAND || op === PPC.NOR || op === PPC.EQV ||
    op === PPC.SLW || op === PPC.SRW || op === PPC.SRAW || op === PPC.SRAWI ||
    op === PPC.SLD || op === PPC.SRD || op === PPC.SRAD || op === PPC.SRADI ||
    op === PPC.RLWINM || op === PPC.RLWNM || op === PPC.RLWIMI ||
    op === PPC.RLDICL || op === PPC.RLDICR || op === PPC.RLDIC ||
    op === PPC.RLDIMI || op === PPC.RLDCL || op === PPC.RLDCR ||
    op === PPC.EXTSB || op === PPC.EXTSH || op === PPC.EXTSW ||
    op === PPC.CNTLZW || op === PPC.CNTLZD || op === PPC.POPCNTD ||
    op === PPC.POPCNTW || op === PPC.CNTTZD
}

export class PowerImage implements ProgramImage {
  readonly isa = ISA_NAME
  readonly entry: bigint
  readonly naming = POWER_NAMING
  readonly codeBytes: number
  private readonly memory: GuestMemory
  private readonly cache = new Map<number, PowerStaticInst>()
  private readonly failed = new Set<number>()

  constructor(memory: GuestMemory, entry: bigint, codeBytes: number) {
    this.memory = memory
    this.entry = entry
    this.codeBytes = codeBytes
  }

  at(addr: bigint): PowerStaticInst {
    const key = Number(addr)
    const hit = this.cache.get(key)
    if (hit) return hit
    if ((key & 3) !== 0) {
      throw new IsaError(
        `${ISA_NAME}: misaligned instruction fetch at 0x${addr.toString(16)}`,
      )
    }
    const low = this.memory.fetchHalf(addr)
    const high = this.memory.fetchHalf(addr + 2n)
    const word = ((high << 16) | low) >>> 0
    const result = toStatic(decode(word, addr), addr)
    this.cache.set(key, result)
    return result
  }

  speculativeAt(addr: bigint): PowerStaticInst | null {
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
