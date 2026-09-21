/**
 * RV64 program image: the static half of what a timing model consumes.
 *
 * Instructions are decoded on demand and cached by address, never eagerly over
 * the whole text. That is not an optimisation. A variable-length encoding has
 * no way to know where instructions begin without following control flow, and
 * an executable contains bytes that are not instructions at all — literal
 * pools, padding, the trap word after a noreturn call. Decoding lazily means
 * those are never decoded, and `speculativeAt` lets a model walk a mispredicted
 * path into them without the run failing.
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
import { Flow, ISA_NAME, RV_NAME, Rv, decode32, decompress, isFullLength, type RvInst, type RvOp } from './decode.ts'

/** Architectural resource ids: x0..x31, then f0..f31, then fcsr. */
export const INT_BASE = 0
export const FP_BASE = 32
export const FCSR_ID = 64
export const REG_COUNT = 65

const ABI_NAMES = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
  's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
]

export const RV64_NAMING: RegisterNaming = {
  count: REG_COUNT,
  name(id: number): string {
    if (id >= INT_BASE && id < FP_BASE) return ABI_NAMES[id]!
    if (id >= FP_BASE && id < FCSR_ID) return `f${id - FP_BASE}`
    if (id === FCSR_ID) return 'fcsr'
    return `?${id}`
  },
}

/** Which register file each operand slot names, per operation. */
const X = 1
const F = 2

interface Shape {
  cls: InstClass
  lat: LatencyClass
  rd: 0 | 1 | 2
  rs1: 0 | 1 | 2
  rs2: 0 | 1 | 2
  rs3: 0 | 1 | 2
  width: number
  reads: boolean
  writes: boolean
  serializing: boolean
}

function shape(
  cls: InstClass,
  lat: LatencyClass,
  rd: 0 | 1 | 2,
  rs1: 0 | 1 | 2,
  rs2: 0 | 1 | 2,
  extra: Partial<Pick<Shape, 'rs3' | 'width' | 'reads' | 'writes' | 'serializing'>> = {},
): Shape {
  return {
    cls,
    lat,
    rd,
    rs1,
    rs2,
    rs3: extra.rs3 ?? 0,
    width: extra.width ?? 0,
    reads: extra.reads ?? false,
    writes: extra.writes ?? false,
    serializing: extra.serializing ?? false,
  }
}

const SHAPES: Shape[] = (() => {
  const t: Shape[] = []
  const alu = (op: RvOp, rs2: 0 | 1 | 2) => {
    t[op] = shape(InstClass.ALU, LatencyClass.FIXED, X, X, rs2)
  }
  const load = (op: RvOp, width: number) => {
    t[op] = shape(InstClass.LD, LatencyClass.LOAD, X, X, 0, { width, reads: true })
  }
  const store = (op: RvOp, width: number) => {
    t[op] = shape(InstClass.ST, LatencyClass.FIXED, 0, X, X, { width, writes: true })
  }
  const branch = (op: RvOp) => {
    t[op] = shape(InstClass.BR, LatencyClass.FIXED, 0, X, X)
  }
  const muldiv = (op: RvOp, cls: InstClass, lat: LatencyClass) => {
    t[op] = shape(cls, lat, X, X, X)
  }
  const fpBin = (op: RvOp, lat: LatencyClass) => {
    t[op] = shape(InstClass.FP, lat, F, F, F)
  }
  const fpUn = (op: RvOp, lat: LatencyClass) => {
    t[op] = shape(InstClass.FP, lat, F, F, 0)
  }
  const fpToInt = (op: RvOp) => {
    t[op] = shape(InstClass.FP, LatencyClass.FP_ADD, X, F, 0)
  }
  const intToFp = (op: RvOp) => {
    t[op] = shape(InstClass.FP, LatencyClass.FP_ADD, F, X, 0)
  }
  const fma = (op: RvOp) => {
    t[op] = shape(InstClass.FP, LatencyClass.FP_MUL, F, F, F, { rs3: F })
  }

  t[Rv.LUI] = shape(InstClass.MOV, LatencyClass.FIXED, X, 0, 0)
  t[Rv.AUIPC] = shape(InstClass.ALU, LatencyClass.FIXED, X, 0, 0)
  t[Rv.JAL] = shape(InstClass.BR, LatencyClass.FIXED, X, 0, 0)
  t[Rv.JALR] = shape(InstClass.BR, LatencyClass.FIXED, X, X, 0)

  for (const op of [Rv.BEQ, Rv.BNE, Rv.BLT, Rv.BGE, Rv.BLTU, Rv.BGEU]) branch(op)

  load(Rv.LB, 1)
  load(Rv.LBU, 1)
  load(Rv.LH, 2)
  load(Rv.LHU, 2)
  load(Rv.LW, 4)
  load(Rv.LWU, 4)
  load(Rv.LD, 8)
  store(Rv.SB, 1)
  store(Rv.SH, 2)
  store(Rv.SW, 4)
  store(Rv.SD, 8)

  for (const op of [Rv.ADDI, Rv.SLTI, Rv.SLTIU, Rv.XORI, Rv.ORI, Rv.ANDI, Rv.SLLI, Rv.SRLI,
    Rv.SRAI, Rv.ADDIW, Rv.SLLIW, Rv.SRLIW, Rv.SRAIW]) alu(op, 0)
  for (const op of [Rv.ADD, Rv.SUB, Rv.SLL, Rv.SLT, Rv.SLTU, Rv.XOR, Rv.SRL, Rv.SRA, Rv.OR,
    Rv.AND, Rv.ADDW, Rv.SUBW, Rv.SLLW, Rv.SRLW, Rv.SRAW]) alu(op, X)

  t[Rv.FENCE] = shape(InstClass.NOP, LatencyClass.FIXED, 0, 0, 0, { serializing: true })
  t[Rv.ECALL] = shape(InstClass.BR, LatencyClass.FIXED, 0, 0, 0, { serializing: true })
  t[Rv.EBREAK] = shape(InstClass.BR, LatencyClass.FIXED, 0, 0, 0, { serializing: true })

  for (const op of [Rv.MUL, Rv.MULH, Rv.MULHSU, Rv.MULHU, Rv.MULW]) {
    muldiv(op, InstClass.MUL, LatencyClass.MUL)
  }
  for (const op of [Rv.DIV, Rv.DIVU, Rv.REM, Rv.REMU, Rv.DIVW, Rv.DIVUW, Rv.REMW, Rv.REMUW]) {
    muldiv(op, InstClass.DIV, LatencyClass.DIV)
  }

  for (const op of [Rv.CSRRW, Rv.CSRRS, Rv.CSRRC]) {
    t[op] = shape(InstClass.MOV, LatencyClass.FIXED, X, X, 0, { serializing: true })
  }
  for (const op of [Rv.CSRRWI, Rv.CSRRSI, Rv.CSRRCI]) {
    t[op] = shape(InstClass.MOV, LatencyClass.FIXED, X, 0, 0, { serializing: true })
  }

  t[Rv.FLW] = shape(InstClass.LD, LatencyClass.LOAD, F, X, 0, { width: 4, reads: true })
  t[Rv.FLD] = shape(InstClass.LD, LatencyClass.LOAD, F, X, 0, { width: 8, reads: true })
  t[Rv.FSW] = shape(InstClass.ST, LatencyClass.FIXED, 0, X, F, { width: 4, writes: true })
  t[Rv.FSD] = shape(InstClass.ST, LatencyClass.FIXED, 0, X, F, { width: 8, writes: true })

  for (const op of [Rv.FADD_S, Rv.FADD_D, Rv.FSUB_S, Rv.FSUB_D]) fpBin(op, LatencyClass.FP_ADD)
  for (const op of [Rv.FMUL_S, Rv.FMUL_D]) fpBin(op, LatencyClass.FP_MUL)
  for (const op of [Rv.FDIV_S, Rv.FDIV_D]) fpBin(op, LatencyClass.FP_DIV)
  for (const op of [Rv.FSQRT_S, Rv.FSQRT_D]) fpUn(op, LatencyClass.FP_DIV)
  for (const op of [Rv.FSGNJ_S, Rv.FSGNJN_S, Rv.FSGNJX_S, Rv.FMIN_S, Rv.FMAX_S,
    Rv.FSGNJ_D, Rv.FSGNJN_D, Rv.FSGNJX_D, Rv.FMIN_D, Rv.FMAX_D]) fpBin(op, LatencyClass.FP_ADD)
  for (const op of [Rv.FEQ_S, Rv.FLT_S, Rv.FLE_S, Rv.FEQ_D, Rv.FLT_D, Rv.FLE_D]) {
    t[op] = shape(InstClass.FP, LatencyClass.FP_ADD, X, F, F)
  }
  for (const op of [Rv.FCLASS_S, Rv.FCLASS_D, Rv.FCVT_W_S, Rv.FCVT_WU_S, Rv.FCVT_L_S,
    Rv.FCVT_LU_S, Rv.FCVT_W_D, Rv.FCVT_WU_D, Rv.FCVT_L_D, Rv.FCVT_LU_D]) fpToInt(op)
  for (const op of [Rv.FCVT_S_W, Rv.FCVT_S_WU, Rv.FCVT_S_L, Rv.FCVT_S_LU, Rv.FCVT_D_W,
    Rv.FCVT_D_WU, Rv.FCVT_D_L, Rv.FCVT_D_LU]) intToFp(op)
  for (const op of [Rv.FCVT_S_D, Rv.FCVT_D_S]) fpUn(op, LatencyClass.FP_ADD)
  for (const op of [Rv.FMV_X_W, Rv.FMV_X_D]) {
    t[op] = shape(InstClass.MOV, LatencyClass.FP_ADD, X, F, 0)
  }
  for (const op of [Rv.FMV_W_X, Rv.FMV_D_X]) {
    t[op] = shape(InstClass.MOV, LatencyClass.FP_ADD, F, X, 0)
  }
  for (const op of [Rv.FMADD_S, Rv.FMSUB_S, Rv.FNMSUB_S, Rv.FNMADD_S,
    Rv.FMADD_D, Rv.FMSUB_D, Rv.FNMSUB_D, Rv.FNMADD_D]) fma(op)

  return t
})()

export function shapeOf(op: RvOp): Shape {
  const found = SHAPES[op]
  if (!found) throw new IsaError(`${ISA_NAME}: no timing shape for operation ${RV_NAME[op] ?? op}`)
  return found
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

/** Renders one decoded instruction the way the engine's disassembly pane wants. */
export function render(inst: RvInst): string {
  const name = RV_NAME[inst.op] ?? '?'
  const x = (r: number) => ABI_NAMES[r] ?? `x${r}`
  const s = shapeOf(inst.op)
  const reg = (kind: 0 | 1 | 2, r: number) => (kind === F ? `f${r}` : x(r))
  const parts: string[] = []
  if (s.rd !== 0 && inst.rd >= 0) parts.push(reg(s.rd, inst.rd))
  if (s.width > 0) {
    // Memory operands read better in the assembler's own offset(base) form.
    const value = s.reads ? reg(s.rd, inst.rd) : reg(s.rs2, inst.rs2)
    return `${name} ${value}, ${inst.imm}(${x(inst.rs1)})`
  }
  if (s.rs1 !== 0 && inst.rs1 >= 0) parts.push(reg(s.rs1, inst.rs1))
  if (s.rs2 !== 0 && inst.rs2 >= 0) parts.push(reg(s.rs2, inst.rs2))
  if (s.rs3 !== 0 && inst.rs3 >= 0) parts.push(reg(s.rs3, inst.rs3))
  if (inst.imm !== 0n || inst.op === Rv.ADDI || inst.op === Rv.LUI) parts.push(String(inst.imm))
  return parts.length > 0 ? `${name} ${parts.join(', ')}` : name
}

/** Everything decode produced, kept beside the timing view for the interpreter. */
export interface RvStaticInst extends StaticInst {
  readonly inst: RvInst
}

function toStatic(inst: RvInst, addr: bigint): RvStaticInst {
  const s = shapeOf(inst.op)
  const reads: number[] = []
  const writes: number[] = []
  const addRead = (kind: 0 | 1 | 2, r: number) => {
    if (kind === 0 || r < 0) return
    // x0 is hardwired to zero, so it is never a dependency in either direction.
    if (kind === X && r === 0) return
    reads.push(kind === F ? FP_BASE + r : r)
  }
  addRead(s.rs1, inst.rs1)
  addRead(s.rs2, inst.rs2)
  addRead(s.rs3, inst.rs3)
  if (s.rd !== 0 && inst.rd >= 0 && !(s.rd === X && inst.rd === 0)) {
    writes.push(s.rd === F ? FP_BASE + inst.rd : inst.rd)
  }
  if (inst.csr === 3 || inst.csr === 1 || inst.csr === 2) {
    // fflags, frm and fcsr are three views of one register.
    reads.push(FCSR_ID)
    writes.push(FCSR_ID)
  }
  // Every floating-point operation that can raise a flag updates fcsr.
  if (s.cls === InstClass.FP) writes.push(FCSR_ID)

  const control = CONTROL_OF[inst.flow]!
  const staticTarget =
    control === ControlKind.COND || control === ControlKind.JUMP ||
    (control === ControlKind.CALL && inst.op === Rv.JAL)
      ? addr + inst.imm
      : NO_ADDRESS

  return {
    addr,
    bytes: inst.len,
    mnemonic: render(inst),
    cls: s.cls,
    latencyClass: s.lat,
    uops: 1,
    reads,
    writes,
    control,
    staticTarget,
    readsMem: s.reads,
    writesMem: s.writes,
    accessWidth: s.width,
    serializing: s.serializing,
    origin: OperationOrigin.SEMANTIC,
    inst,
  }
}

export class Rv64Image implements ProgramImage {
  readonly isa = ISA_NAME
  readonly entry: bigint
  readonly naming = RV64_NAMING
  readonly codeBytes: number
  private readonly memory: GuestMemory
  private readonly cache = new Map<number, RvStaticInst>()
  private readonly failed = new Set<number>()

  constructor(memory: GuestMemory, entry: bigint, codeBytes: number) {
    this.memory = memory
    this.entry = entry
    this.codeBytes = codeBytes
  }

  at(addr: bigint): RvStaticInst {
    const key = Number(addr)
    const hit = this.cache.get(key)
    if (hit) return hit
    const low = this.memory.fetchHalf(addr)
    let word = low
    let len: 2 | 4 = 2
    if (isFullLength(low)) {
      word = (low | (this.memory.fetchHalf(addr + 2n) << 16)) >>> 0
      len = 4
    } else {
      word = decompress(low, addr)
    }
    const decoded = decode32(word, len, addr)
    const result = toStatic(decoded, addr)
    this.cache.set(key, result)
    return result
  }

  speculativeAt(addr: bigint): RvStaticInst | null {
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
