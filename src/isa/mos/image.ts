/**
 * MOS 6502 program image: the static half the timing model consumes.
 *
 * One decision here is worth arguing for, because it is the opposite of
 * what the other backends do. **Each status flag is its own resource id.**
 *
 * On a 64-bit target the flags either do not exist (RISC-V) or are a
 * single condition register that almost every arithmetic instruction
 * writes and almost every branch reads. Treating that register as one
 * resource costs little, because the dependence it creates is usually a
 * real one. On this machine it would be a disaster. The 6502 has three
 * registers and no barrel shifter, so *everything* is done with flags: a
 * sixteen-bit add is four instructions chained through carry, and a loop
 * is a decrement whose zero flag is read six instructions later while
 * carry is being used for something else entirely. Collapsing N, V, Z and
 * C into one id would serialise code that a real machine overlaps, and
 * the timing model would report a dependence stall that does not exist.
 *
 * So there are ten resource ids: three registers, the stack pointer, and
 * six flags. The stack pointer is one of them because `pha`/`pla` pairs
 * chain through it and nothing else does.
 */
import { InstClass, OperationOrigin } from '../../engine/types.ts'
import { IsaError } from '../common/errors.ts'
import {
  ControlKind,
  LatencyClass,
  NO_ADDRESS,
  type ProgramImage,
  type RegisterNaming,
  type StaticInst,
} from '../common/trace.ts'
import type { MosBus } from './bus.ts'
import { Flow, ISA_NAME, MOS, MOS_NAME, Mode, decode, type MosInst } from './decode.ts'

/** Architectural resource ids. */
export const Res = {
  A: 0,
  X: 1,
  Y: 2,
  S: 3,
  C: 4,
  Z: 5,
  I: 6,
  D: 7,
  V: 8,
  N: 9,
} as const

export const REG_COUNT = 10

const RES_NAMES = ['a', 'x', 'y', 's', 'c', 'z', 'i', 'd', 'v', 'n']

export const MOS_NAMING: RegisterNaming = {
  count: REG_COUNT,
  name(id: number): string {
    return RES_NAMES[id] ?? `?${id}`
  },
}

/** Flags each operation writes, beyond what the operand analysis adds. */
const NZ = [Res.N, Res.Z]
const NZC = [Res.N, Res.Z, Res.C]
const NZCV = [Res.N, Res.Z, Res.C, Res.V]

const WRITES_FLAGS: Readonly<Record<number, readonly number[]>> = {
  [MOS.LDA]: NZ, [MOS.LDX]: NZ, [MOS.LDY]: NZ,
  [MOS.TAX]: NZ, [MOS.TAY]: NZ, [MOS.TXA]: NZ, [MOS.TYA]: NZ, [MOS.TSX]: NZ,
  [MOS.PLA]: NZ,
  [MOS.AND]: NZ, [MOS.ORA]: NZ, [MOS.EOR]: NZ,
  [MOS.INC]: NZ, [MOS.DEC]: NZ,
  [MOS.INX]: NZ, [MOS.INY]: NZ, [MOS.DEX]: NZ, [MOS.DEY]: NZ,
  [MOS.ADC]: NZCV, [MOS.SBC]: NZCV,
  [MOS.CMP]: NZC, [MOS.CPX]: NZC, [MOS.CPY]: NZC,
  [MOS.ASL]: NZC, [MOS.LSR]: NZC, [MOS.ROL]: NZC, [MOS.ROR]: NZC,
  [MOS.BIT]: [Res.N, Res.Z, Res.V],
  // `txs` is the one transfer that does not touch the flags, which is why
  // it is absent here and `tsx` is present.
}

/** Which flag each branch tests. */
const BRANCH_FLAG: Readonly<Record<number, number>> = {
  [MOS.BPL]: Res.N, [MOS.BMI]: Res.N,
  [MOS.BVC]: Res.V, [MOS.BVS]: Res.V,
  [MOS.BCC]: Res.C, [MOS.BCS]: Res.C,
  [MOS.BNE]: Res.Z, [MOS.BEQ]: Res.Z,
}

/** The single flag each of the seven flag instructions writes. */
const FLAG_WRITE: Readonly<Record<number, number>> = {
  [MOS.CLC]: Res.C, [MOS.SEC]: Res.C,
  [MOS.CLI]: Res.I, [MOS.SEI]: Res.I,
  [MOS.CLD]: Res.D, [MOS.SED]: Res.D,
  [MOS.CLV]: Res.V,
}

const LOADS = new Set<number>([
  MOS.LDA, MOS.LDX, MOS.LDY, MOS.ADC, MOS.SBC, MOS.AND, MOS.ORA, MOS.EOR,
  MOS.CMP, MOS.CPX, MOS.CPY, MOS.BIT,
])
const STORES = new Set<number>([MOS.STA, MOS.STX, MOS.STY])
/** Read, modify, write: one instruction that touches memory twice. */
const RMW = new Set<number>([
  MOS.ASL, MOS.LSR, MOS.ROL, MOS.ROR, MOS.INC, MOS.DEC,
])

/** Which register an operation reads or writes, where the name says so. */
const REG_OF: Readonly<Record<number, number>> = {
  [MOS.LDA]: Res.A, [MOS.STA]: Res.A,
  [MOS.LDX]: Res.X, [MOS.STX]: Res.X,
  [MOS.LDY]: Res.Y, [MOS.STY]: Res.Y,
  [MOS.CPX]: Res.X, [MOS.CPY]: Res.Y,
  [MOS.INX]: Res.X, [MOS.DEX]: Res.X,
  [MOS.INY]: Res.Y, [MOS.DEY]: Res.Y,
}

function touchesMemory(inst: MosInst): boolean {
  return inst.mode !== Mode.IMPLIED && inst.mode !== Mode.ACCUMULATOR &&
    inst.mode !== Mode.IMMEDIATE && inst.mode !== Mode.RELATIVE &&
    inst.op !== MOS.JMP && inst.op !== MOS.JSR
}

function classOf(inst: MosInst): InstClass {
  if (inst.flow !== Flow.SEQ) return InstClass.BR
  if (STORES.has(inst.op)) return InstClass.ST
  if (inst.op === MOS.PHA || inst.op === MOS.PHP) return InstClass.ST
  if (inst.op === MOS.PLA || inst.op === MOS.PLP) return InstClass.LD
  if (RMW.has(inst.op) && inst.mode !== Mode.ACCUMULATOR) return InstClass.ST
  if (touchesMemory(inst)) return InstClass.LD
  if (inst.op === MOS.NOP) return InstClass.NOP
  switch (inst.op) {
    case MOS.TAX: case MOS.TAY: case MOS.TXA: case MOS.TYA:
    case MOS.TSX: case MOS.TXS: case MOS.LDA: case MOS.LDX: case MOS.LDY:
      return InstClass.MOV
    default:
      return InstClass.ALU
  }
}

export function render(inst: MosInst): string {
  const name = MOS_NAME[inst.op] ?? '?'
  const hex = (v: number, digits: number): string =>
    `$${v.toString(16).padStart(digits, '0')}`
  switch (inst.mode) {
    case Mode.IMPLIED: return name
    case Mode.ACCUMULATOR: return `${name} a`
    case Mode.IMMEDIATE: return `${name} #${hex(inst.operand, 2)}`
    case Mode.ZERO_PAGE: return `${name} ${hex(inst.operand, 2)}`
    case Mode.ZERO_PAGE_X: return `${name} ${hex(inst.operand, 2)}, x`
    case Mode.ZERO_PAGE_Y: return `${name} ${hex(inst.operand, 2)}, y`
    case Mode.ABSOLUTE: return `${name} ${hex(inst.operand, 4)}`
    case Mode.ABSOLUTE_X: return `${name} ${hex(inst.operand, 4)}, x`
    case Mode.ABSOLUTE_Y: return `${name} ${hex(inst.operand, 4)}, y`
    case Mode.INDIRECT: return `${name} (${hex(inst.operand, 4)})`
    case Mode.INDEXED_INDIRECT: return `${name} (${hex(inst.operand, 2)}, x)`
    case Mode.INDIRECT_INDEXED: return `${name} (${hex(inst.operand, 2)}), y`
    case Mode.RELATIVE: return `${name} ${hex(inst.target, 4)}`
    default: return name
  }
}

export interface MosStaticInst extends StaticInst {
  readonly inst: MosInst
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

function toStatic(inst: MosInst, addr: bigint): MosStaticInst {
  const reads: number[] = []
  const writes: number[] = []
  const addRead = (id: number): void => { if (!reads.includes(id)) reads.push(id) }
  const addWrite = (id: number): void => { if (!writes.includes(id)) writes.push(id) }

  // The index register the addressing mode uses, which is a dependence
  // the mnemonic does not mention.
  if (inst.mode === Mode.ZERO_PAGE_X || inst.mode === Mode.ABSOLUTE_X ||
      inst.mode === Mode.INDEXED_INDIRECT) addRead(Res.X)
  if (inst.mode === Mode.ZERO_PAGE_Y || inst.mode === Mode.ABSOLUTE_Y ||
      inst.mode === Mode.INDIRECT_INDEXED) addRead(Res.Y)

  const named = REG_OF[inst.op]
  if (named !== undefined) {
    if (inst.op === MOS.LDA || inst.op === MOS.LDX || inst.op === MOS.LDY) {
      addWrite(named)
    } else if (STORES.has(inst.op)) {
      addRead(named)
    } else {
      addRead(named)
      if (inst.op !== MOS.CPX && inst.op !== MOS.CPY) addWrite(named)
    }
  }

  switch (inst.op) {
    case MOS.ADC: case MOS.SBC: case MOS.AND: case MOS.ORA: case MOS.EOR:
      addRead(Res.A); addWrite(Res.A); break
    case MOS.CMP: case MOS.BIT:
      addRead(Res.A); break
    case MOS.TAX: addRead(Res.A); addWrite(Res.X); break
    case MOS.TAY: addRead(Res.A); addWrite(Res.Y); break
    case MOS.TXA: addRead(Res.X); addWrite(Res.A); break
    case MOS.TYA: addRead(Res.Y); addWrite(Res.A); break
    case MOS.TSX: addRead(Res.S); addWrite(Res.X); break
    case MOS.TXS: addRead(Res.X); addWrite(Res.S); break
    case MOS.PHA: addRead(Res.A); addRead(Res.S); addWrite(Res.S); break
    case MOS.PLA: addRead(Res.S); addWrite(Res.S); addWrite(Res.A); break
    case MOS.PHP:
      addRead(Res.S); addWrite(Res.S)
      for (const f of [Res.C, Res.Z, Res.I, Res.D, Res.V, Res.N]) addRead(f)
      break
    case MOS.PLP: case MOS.RTI:
      addRead(Res.S); addWrite(Res.S)
      for (const f of [Res.C, Res.Z, Res.I, Res.D, Res.V, Res.N]) addWrite(f)
      break
    case MOS.JSR: case MOS.RTS:
      addRead(Res.S); addWrite(Res.S); break
    case MOS.BRK:
      addRead(Res.S); addWrite(Res.S); addWrite(Res.I)
      for (const f of [Res.C, Res.Z, Res.I, Res.D, Res.V, Res.N]) addRead(f)
      break
    default: break
  }

  // Decimal mode changes what an add is, so it is an input to one.
  if (inst.op === MOS.ADC || inst.op === MOS.SBC) {
    addRead(Res.C)
    addRead(Res.D)
  }
  if (inst.op === MOS.ROL || inst.op === MOS.ROR) addRead(Res.C)
  if (inst.mode === Mode.ACCUMULATOR) { addRead(Res.A); addWrite(Res.A) }

  const branchFlag = BRANCH_FLAG[inst.op]
  if (branchFlag !== undefined) addRead(branchFlag)

  const flagWrite = FLAG_WRITE[inst.op]
  if (flagWrite !== undefined) addWrite(flagWrite)

  for (const id of WRITES_FLAGS[inst.op] ?? []) addWrite(id)

  const readsMem = touchesMemory(inst) &&
    (LOADS.has(inst.op) || RMW.has(inst.op) || inst.op === MOS.JMP)
  const writesMem = (touchesMemory(inst) && (STORES.has(inst.op) || RMW.has(inst.op))) ||
    inst.op === MOS.PHA || inst.op === MOS.PHP || inst.op === MOS.JSR ||
    inst.op === MOS.BRK
  const pulls = inst.op === MOS.PLA || inst.op === MOS.PLP ||
    inst.op === MOS.RTS || inst.op === MOS.RTI

  const control = CONTROL_OF[inst.flow]!

  return {
    addr,
    bytes: inst.length,
    mnemonic: render(inst),
    cls: classOf(inst),
    // Every instruction on this machine takes a fixed number of cycles.
    // There is no multiplier, no divider and no floating-point unit, so
    // there is exactly one latency class and nothing to choose between.
    latencyClass: LatencyClass.FIXED,
    uops: 1,
    reads,
    writes,
    control,
    staticTarget: inst.flow === Flow.BRANCH || inst.flow === Flow.JUMP ||
      inst.flow === Flow.CALL ? BigInt(inst.target) : NO_ADDRESS,
    readsMem: readsMem || pulls || inst.mode === Mode.INDIRECT ||
      inst.mode === Mode.INDEXED_INDIRECT || inst.mode === Mode.INDIRECT_INDEXED,
    writesMem,
    accessWidth: readsMem || writesMem || pulls ? 1 : 0,
    // `brk` and the flag instruction that masks interrupts change how the
    // machine responds to the outside world.
    serializing: inst.op === MOS.BRK || inst.op === MOS.RTI ||
      inst.op === MOS.SEI || inst.op === MOS.CLI,
    origin: OperationOrigin.SEMANTIC,
    inst,
  }
}

export class MosImage implements ProgramImage {
  readonly isa = ISA_NAME
  readonly entry: bigint
  readonly naming = MOS_NAMING
  readonly codeBytes: number
  private readonly bus: MosBus
  private readonly cache = new Map<number, MosStaticInst>()
  private readonly failed = new Set<number>()
  /**
   * The span of addresses anything has ever been decoded at, so a store
   * to the stack or to page zero -- which is most stores -- can be known
   * not to have hit code without touching the cache at all.
   */
  private lowest = 0x10000
  private highest = -1

  constructor(bus: MosBus, entry: bigint, codeBytes: number) {
    this.bus = bus
    this.entry = entry
    this.codeBytes = codeBytes
  }

  at(addr: bigint): MosStaticInst {
    const key = Number(addr & 0xffffn)
    const hit = this.cache.get(key)
    if (hit) return hit
    if (addr < 0n || addr > 0xffffn) {
      throw new IsaError(
        `${ISA_NAME}: instruction fetch outside the address space at 0x${addr.toString(16)}`,
      )
    }
    const result = toStatic(
      decode((offset) => this.bus.read((key + offset) & 0xffff), addr),
      addr,
    )
    this.cache.set(key, result)
    if (key < this.lowest) this.lowest = key
    if (key > this.highest) this.highest = key
    return result
  }

  speculativeAt(addr: bigint): MosStaticInst | null {
    const key = Number(addr & 0xffffn)
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

  /**
   * Forgets what was decoded at an address.
   *
   * Self-modifying code is not a curiosity on this machine; it is how a
   * 6502 program does an indirect jump table or an unrolled copy, and the
   * compiler's own runtime does it. The cache has to be told.
   */
  invalidate(address: number): void {
    if (address + 2 < this.lowest || address > this.highest) return
    // Any byte of an instruction may have changed, and the longest is
    // three bytes, so two earlier addresses may also be stale.
    for (let back = 0; back <= 2; back++) {
      const key = (address - back) & 0xffff
      this.cache.delete(key)
      this.failed.delete(key)
    }
  }
}
