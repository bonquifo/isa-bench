/**
 * RV64GC interpreter.
 *
 * Executes real instructions against a real address space and emits a retired
 * trace. It knows nothing about cycles, caches or branch prediction: those are
 * the timing model's, and keeping the two apart is what stops eight ISAs from
 * having to be implemented twice over, once for the in-order model and once
 * for the out-of-order one.
 *
 * Registers are `bigint`. Integer registers are exactly 64 bits wide, which a
 * JavaScript number cannot represent — the engine's legacy `Float64Array`
 * register file holds 53 bits — and BigInt64Array's assignment conversion
 * gives wrapping at the architectural width for free.
 *
 * Floating-point registers hold raw bit patterns rather than numbers, so a
 * signalling NaN stays signalling and a negative zero stays negative.
 */
import { mulhs, mulhsu, mulhu, sext, u64, zext } from '../common/bits64.ts'
import {
  ExecutionBudgetExceeded,
  IsaError,
  UnimplementedInstruction,
  UnsupportedSyscall,
} from '../common/errors.ts'
import {
  CANONICAL_NAN_D,
  CANONICAL_NAN_S,
  F32,
  F64,
  RoundMode,
  bitsToF32,
  bitsToF64,
  boxSingle,
  classifyF32,
  classifyF64,
  exactOf,
  exactProduct,
  exactSum,
  f32ToBits,
  f64ToBits,
  fusedMulAdd,
  isNan32,
  isNan64,
  isSignaling32,
  isSignaling64,
  quotientStatus,
  roundToIntegral,
  sqrtStatus,
  statusOf,
  unboxSingle,
  type Exact,
  type RoundingStatus,
} from '../common/fp.ts'
import type { GuestMemory, AccessWidth } from '../common/memory.ts'
import {
  RunState,
  type ArchState,
  type Interpreter,
  type RetireChunk,
} from '../common/trace.ts'
import { ISA_NAME, RV_NAME, Rv, type RvOp } from './decode.ts'
import type { Rv64Image, RvStaticInst } from './image.ts'

/** Accrued exception bits in fcsr, lowest five. */
export const FFlag = {
  NX: 0x01,
  UF: 0x02,
  OF: 0x04,
  DZ: 0x08,
  NV: 0x10,
} as const

/**
 * The three flags that depend on whether rounding changed the value, as
 * opposed to on the operands alone. They are sticky, so once all three are
 * set the exact recomputation that produces them can be skipped entirely —
 * which is what keeps a floating-point loop from paying for them on every
 * iteration.
 */
const ROUNDING_FLAGS = FFlag.NX | FFlag.OF | FFlag.UF

const EXIT_SYSCALLS = new Set([93, 94])
const SYS_WRITE = 64

export interface Rv64Options {
  /**
   * Initial stack pointer. Fixtures seed it from the reference run so the two
   * executions start from identical architectural state; the program under
   * test sets its own stack immediately afterwards.
   */
  initialSp?: bigint
  /** Ceiling on retired instructions, to turn a guest hang into an error. */
  instructionBudget?: number
}

const DEFAULT_BUDGET = 200_000_000

export class Rv64Interpreter implements Interpreter {
  readonly image: Rv64Image
  private readonly memory: GuestMemory
  private readonly x = new BigInt64Array(32)
  private readonly f = new BigInt64Array(32)
  private fcsr = 0
  private pc: bigint
  private exited = false
  private readonly budget: number
  private readonly outBytes: number[] = []
  exitCode = 0
  retired = 0

  constructor(image: Rv64Image, memory: GuestMemory, options: Rv64Options = {}) {
    this.image = image
    this.memory = memory
    this.pc = image.entry
    this.budget = options.instructionBudget ?? DEFAULT_BUDGET
    if (options.initialSp !== undefined) this.x[2] = options.initialSp
  }

  /** Register state, for seeding from a reference trace and for inspection. */
  setGpr(index: number, value: bigint): void {
    if (index !== 0) this.x[index] = value
  }

  gpr(index: number): bigint {
    return this.x[index]!
  }

  fpr(index: number): bigint {
    return this.f[index]!
  }

  get programCounter(): bigint {
    return this.pc
  }

  finalState(): ArchState {
    return {
      gpr: Array.from(this.x),
      fpr: Array.from(this.f),
      status: { fcsr: BigInt(this.fcsr) },
      pc: this.pc,
    }
  }

  stdout(): Uint8Array {
    return Uint8Array.from(this.outBytes)
  }

  run(into: RetireChunk): RunState {
    const capacity = into.pc.length
    let n = 0
    while (n < capacity && !this.exited) {
      const si = this.image.at(this.pc)
      const pc = this.pc
      this.access = 0n
      this.accessWidth = 0
      this.taken = 0
      this.next = pc + BigInt(si.bytes)
      this.execute(si)
      into.pc[n] = pc
      into.nextPc[n] = this.next
      into.effAddr[n] = this.access
      into.accessWidth[n] = this.accessWidth
      into.taken[n] = this.taken
      this.pc = this.next
      n += 1
      this.retired += 1
      if (this.retired > this.budget) {
        into.count = n
        throw new ExecutionBudgetExceeded(ISA_NAME, this.retired)
      }
    }
    into.count = n
    return this.exited ? RunState.EXITED : RunState.MORE
  }

  // Per-instruction outputs, written by execute() and read back by run().
  private next = 0n
  private access = 0n
  private accessWidth = 0
  private taken = 0

  private flag(mask: number): void {
    this.fcsr |= mask
  }

  private applyStatus(status: RoundingStatus): void {
    if (status.inexact) this.fcsr |= FFlag.NX
    if (status.overflow) this.fcsr |= FFlag.OF
    if (status.underflow) this.fcsr |= FFlag.UF
  }

  /** False once every rounding flag is already set; nothing more can change. */
  private needsStatus(): boolean {
    return (this.fcsr & ROUNDING_FLAGS) !== ROUNDING_FLAGS
  }

  /**
   * Resolves the rounding mode an instruction asks for. The host rounds to
   * nearest-even and nothing else, so an operation that genuinely needs a
   * different mode is refused rather than silently rounded the wrong way.
   */
  private roundingMode(si: RvStaticInst): number {
    const rm = si.inst.rm === RoundMode.DYN ? (this.fcsr >> 5) & 7 : si.inst.rm
    if (rm > 4) {
      throw new UnimplementedInstruction(
        ISA_NAME, si.addr, new Uint8Array([]), `reserved rounding mode ${rm}`,
      )
    }
    return rm
  }

  private requireNearestEven(si: RvStaticInst): void {
    if (this.roundingMode(si) !== RoundMode.RNE) {
      throw new UnimplementedInstruction(
        ISA_NAME, si.addr, new Uint8Array([]),
        `${RV_NAME[si.inst.op]} with a rounding mode other than nearest-even: the host ` +
        'provides only round-to-nearest-even for arithmetic',
      )
    }
  }

  private write(index: number, value: bigint): void {
    if (index !== 0) this.x[index] = value
  }

  private loadMem(addr: bigint, width: AccessWidth, signed: boolean): bigint {
    this.access = addr
    this.accessWidth = width
    return this.memory.load(addr, width, signed)
  }

  private storeMem(addr: bigint, width: AccessWidth, value: bigint): void {
    this.access = addr
    this.accessWidth = width
    this.memory.store(addr, width, value)
  }

  private execute(si: RvStaticInst): void {
    const inst = si.inst
    const op = inst.op
    const x = this.x
    const a = inst.rs1 >= 0 ? x[inst.rs1]! : 0n
    const b = inst.rs2 >= 0 ? x[inst.rs2]! : 0n
    const imm = inst.imm

    switch (op) {
      case Rv.LUI:
        this.write(inst.rd, imm)
        return
      case Rv.AUIPC:
        this.write(inst.rd, si.addr + imm)
        return
      case Rv.JAL:
        this.write(inst.rd, si.addr + BigInt(si.bytes))
        this.next = si.addr + imm
        return
      case Rv.JALR: {
        // The target's low bit is cleared, which is why `jalr` can be used
        // with an odd offset without landing off the instruction grid.
        const target = (a + imm) & ~1n
        this.write(inst.rd, si.addr + BigInt(si.bytes))
        this.next = target
        return
      }

      case Rv.BEQ:
        return this.branch(si, a === b)
      case Rv.BNE:
        return this.branch(si, a !== b)
      case Rv.BLT:
        return this.branch(si, a < b)
      case Rv.BGE:
        return this.branch(si, a >= b)
      case Rv.BLTU:
        return this.branch(si, u64(a) < u64(b))
      case Rv.BGEU:
        return this.branch(si, u64(a) >= u64(b))

      case Rv.LB:
        return this.write(inst.rd, this.loadMem(a + imm, 1, true))
      case Rv.LBU:
        return this.write(inst.rd, this.loadMem(a + imm, 1, false))
      case Rv.LH:
        return this.write(inst.rd, this.loadMem(a + imm, 2, true))
      case Rv.LHU:
        return this.write(inst.rd, this.loadMem(a + imm, 2, false))
      case Rv.LW:
        return this.write(inst.rd, this.loadMem(a + imm, 4, true))
      case Rv.LWU:
        return this.write(inst.rd, this.loadMem(a + imm, 4, false))
      case Rv.LD:
        return this.write(inst.rd, this.loadMem(a + imm, 8, true))
      case Rv.SB:
        return this.storeMem(a + imm, 1, b)
      case Rv.SH:
        return this.storeMem(a + imm, 2, b)
      case Rv.SW:
        return this.storeMem(a + imm, 4, b)
      case Rv.SD:
        return this.storeMem(a + imm, 8, b)

      case Rv.ADDI:
        return this.write(inst.rd, a + imm)
      case Rv.SLTI:
        return this.write(inst.rd, a < imm ? 1n : 0n)
      case Rv.SLTIU:
        return this.write(inst.rd, u64(a) < u64(imm) ? 1n : 0n)
      case Rv.XORI:
        return this.write(inst.rd, a ^ imm)
      case Rv.ORI:
        return this.write(inst.rd, a | imm)
      case Rv.ANDI:
        return this.write(inst.rd, a & imm)
      case Rv.SLLI:
        return this.write(inst.rd, a << imm)
      case Rv.SRLI:
        return this.write(inst.rd, u64(a) >> imm)
      case Rv.SRAI:
        return this.write(inst.rd, a >> imm)

      case Rv.ADD:
        return this.write(inst.rd, a + b)
      case Rv.SUB:
        return this.write(inst.rd, a - b)
      case Rv.SLL:
        return this.write(inst.rd, a << (b & 63n))
      case Rv.SLT:
        return this.write(inst.rd, a < b ? 1n : 0n)
      case Rv.SLTU:
        return this.write(inst.rd, u64(a) < u64(b) ? 1n : 0n)
      case Rv.XOR:
        return this.write(inst.rd, a ^ b)
      case Rv.SRL:
        return this.write(inst.rd, u64(a) >> (b & 63n))
      case Rv.SRA:
        return this.write(inst.rd, a >> (b & 63n))
      case Rv.OR:
        return this.write(inst.rd, a | b)
      case Rv.AND:
        return this.write(inst.rd, a & b)

      // The W forms compute on the low 32 bits and sign-extend the result
      // back across the whole register, which is the single most common way
      // an RV64 interpreter written from the RV32 manual goes wrong.
      case Rv.ADDIW:
        return this.write(inst.rd, sext(a + imm, 32))
      case Rv.SLLIW:
        return this.write(inst.rd, sext(sext(a, 32) << (imm & 31n), 32))
      case Rv.SRLIW:
        return this.write(inst.rd, sext(zext(a, 32) >> (imm & 31n), 32))
      case Rv.SRAIW:
        return this.write(inst.rd, sext(sext(a, 32) >> (imm & 31n), 32))
      case Rv.ADDW:
        return this.write(inst.rd, sext(a + b, 32))
      case Rv.SUBW:
        return this.write(inst.rd, sext(a - b, 32))
      case Rv.SLLW:
        return this.write(inst.rd, sext(sext(a, 32) << (b & 31n), 32))
      case Rv.SRLW:
        return this.write(inst.rd, sext(zext(a, 32) >> (b & 31n), 32))
      case Rv.SRAW:
        return this.write(inst.rd, sext(sext(a, 32) >> (b & 31n), 32))

      case Rv.FENCE:
        // Single-threaded and with no store buffer visible to the guest, so
        // ordering is already what a fence would establish.
        return
      case Rv.ECALL:
        return this.syscall()
      case Rv.EBREAK:
        throw new IsaError(`${ISA_NAME}: guest executed ebreak at 0x${si.addr.toString(16)}`)

      case Rv.MUL:
        return this.write(inst.rd, a * b)
      case Rv.MULH:
        return this.write(inst.rd, mulhs(a, b))
      case Rv.MULHU:
        return this.write(inst.rd, mulhu(a, b))
      case Rv.MULHSU:
        return this.write(inst.rd, mulhsu(a, b))
      case Rv.MULW:
        return this.write(inst.rd, sext(a * b, 32))
      case Rv.DIV:
        return this.write(inst.rd, divideSigned(a, b, 64))
      case Rv.DIVU:
        return this.write(inst.rd, divideUnsigned(a, b, 64))
      case Rv.REM:
        return this.write(inst.rd, remainderSigned(a, b, 64))
      case Rv.REMU:
        return this.write(inst.rd, remainderUnsigned(a, b, 64))
      case Rv.DIVW:
        return this.write(inst.rd, divideSigned(a, b, 32))
      case Rv.DIVUW:
        return this.write(inst.rd, divideUnsigned(a, b, 32))
      case Rv.REMW:
        return this.write(inst.rd, remainderSigned(a, b, 32))
      case Rv.REMUW:
        return this.write(inst.rd, remainderUnsigned(a, b, 32))

      case Rv.CSRRW:
      case Rv.CSRRS:
      case Rv.CSRRC:
      case Rv.CSRRWI:
      case Rv.CSRRSI:
      case Rv.CSRRCI:
        return this.csr(si, a)

      case Rv.FLW:
        return this.writeF(inst.rd, boxSingle(Number(this.loadMem(a + imm, 4, false))))
      case Rv.FLD:
        return this.writeF(inst.rd, this.loadMem(a + imm, 8, false))
      case Rv.FSW:
        // A raw transfer of the low half, not a single-precision operation: the
        // NaN-boxing check does not apply and the payload survives unmodified.
        return this.storeMem(a + imm, 4, this.f[inst.rs2]!)
      case Rv.FSD:
        return this.storeMem(a + imm, 8, this.f[inst.rs2]!)

      default:
        return this.executeFloat(si)
    }
  }

  private branch(si: RvStaticInst, taken: boolean): void {
    this.taken = taken ? 1 : 0
    if (taken) this.next = si.addr + si.inst.imm
  }

  private writeF(index: number, bits: bigint): void {
    this.f[index] = BigInt.asIntN(64, bits)
  }

  private csr(si: RvStaticInst, rs1Value: bigint): void {
    const inst = si.inst
    const number = inst.csr
    if (number !== 0x001 && number !== 0x002 && number !== 0x003) {
      throw new UnimplementedInstruction(
        ISA_NAME, si.addr, new Uint8Array([]), `control register 0x${number.toString(16)}`,
      )
    }
    // fflags, frm and fcsr are three views of one eight-bit register.
    const view = number === 0x001 ? this.fcsr & 0x1f
      : number === 0x002 ? (this.fcsr >> 5) & 7
        : this.fcsr & 0xff
    const immediateForm = inst.op === Rv.CSRRWI || inst.op === Rv.CSRRSI || inst.op === Rv.CSRRCI
    const source = Number(BigInt.asUintN(32, immediateForm ? inst.imm : rs1Value))
    // For the set and clear forms, naming x0 (or a zero immediate) means
    // "read only": the register must not be written at all.
    const writes = inst.op === Rv.CSRRW || inst.op === Rv.CSRRWI
      ? true
      : immediateForm ? inst.imm !== 0n : inst.rs1 !== 0
    let updated = view
    if (writes) {
      if (inst.op === Rv.CSRRW || inst.op === Rv.CSRRWI) updated = source
      else if (inst.op === Rv.CSRRS || inst.op === Rv.CSRRSI) updated = view | source
      else updated = view & ~source
    }
    this.write(inst.rd, BigInt(view))
    if (!writes) return
    if (number === 0x001) this.fcsr = (this.fcsr & ~0x1f) | (updated & 0x1f)
    else if (number === 0x002) this.fcsr = (this.fcsr & 0x1f) | ((updated & 7) << 5)
    else this.fcsr = updated & 0xff
  }

  private syscall(): void {
    const number = Number(this.x[17]!)
    if (EXIT_SYSCALLS.has(number)) {
      this.exited = true
      this.exitCode = Number(BigInt.asIntN(32, this.x[10]!))
      return
    }
    if (number === SYS_WRITE) {
      const fd = Number(this.x[10]!)
      const buffer = this.x[11]!
      const length = Number(this.x[12]!)
      if (fd !== 1 && fd !== 2) {
        throw new UnsupportedSyscall(ISA_NAME, number, `to file descriptor ${fd}`)
      }
      const bytes = this.memory.readBytes(buffer, length)
      for (const byte of bytes) this.outBytes.push(byte)
      this.write(10, BigInt(length))
      return
    }
    throw new UnsupportedSyscall(ISA_NAME, number)
  }

  // -------------------------------------------------------------------------
  // Floating point. Split out only so `execute` stays readable.
  // -------------------------------------------------------------------------

  private executeFloat(si: RvStaticInst): void {
    const inst = si.inst
    const op = inst.op
    if (DOUBLE_OPS.has(op)) return this.executeDouble(si)
    if (SINGLE_OPS.has(op)) return this.executeSingle(si)
    throw new UnimplementedInstruction(
      ISA_NAME, si.addr, new Uint8Array([]),
      `no execute case for ${RV_NAME[op] ?? op}`,
    )
  }

  private executeDouble(si: RvStaticInst): void {
    const inst = si.inst
    const op = inst.op
    const aBits = this.f[inst.rs1]!
    const bBits = this.f[inst.rs2]!
    const a = bitsToF64(aBits)
    const b = bitsToF64(bBits)
    const signalling = isSignaling64(aBits) || isSignaling64(bBits)

    switch (op) {
      // Sign injection is a bit operation: it never signals and it passes a
      // NaN payload straight through.
      case Rv.FSGNJ_D:
        return this.writeF(inst.rd, (u64(aBits) & ~SIGN64) | (u64(bBits) & SIGN64))
      case Rv.FSGNJN_D:
        return this.writeF(inst.rd, (u64(aBits) & ~SIGN64) | (~u64(bBits) & SIGN64))
      case Rv.FSGNJX_D:
        return this.writeF(inst.rd, u64(aBits) ^ (u64(bBits) & SIGN64))
      case Rv.FMV_X_D:
        return this.write(inst.rd, aBits)
      case Rv.FMV_D_X:
        return this.writeF(inst.rd, this.x[inst.rs1]!)
      case Rv.FCLASS_D:
        return this.write(inst.rd, classifyF64(aBits))

      case Rv.FEQ_D:
        if (signalling) this.flag(FFlag.NV)
        return this.write(inst.rd, !isNan64(aBits) && !isNan64(bBits) && a === b ? 1n : 0n)
      case Rv.FLT_D:
        if (isNan64(aBits) || isNan64(bBits)) this.flag(FFlag.NV)
        return this.write(inst.rd, a < b ? 1n : 0n)
      case Rv.FLE_D:
        if (isNan64(aBits) || isNan64(bBits)) this.flag(FFlag.NV)
        return this.write(inst.rd, a <= b ? 1n : 0n)

      case Rv.FMIN_D:
      case Rv.FMAX_D: {
        if (signalling) this.flag(FFlag.NV)
        return this.writeF(inst.rd, minMax64(aBits, bBits, op === Rv.FMAX_D))
      }

      case Rv.FADD_D:
      case Rv.FSUB_D:
      case Rv.FMUL_D:
      case Rv.FDIV_D:
      case Rv.FSQRT_D: {
        this.requireNearestEven(si)
        if (signalling) this.flag(FFlag.NV)
        const value = this.arith64(op, a, b, aBits, bBits)
        return this.writeF(inst.rd, Number.isNaN(value) ? CANONICAL_NAN_D : f64ToBits(value))
      }

      case Rv.FMADD_D:
      case Rv.FMSUB_D:
      case Rv.FNMSUB_D:
      case Rv.FNMADD_D: {
        this.requireNearestEven(si)
        const cBits = this.f[inst.rs3]!
        if (signalling || isSignaling64(cBits)) this.flag(FFlag.NV)
        const { first, addend } = fmaOperands(op, aBits, cBits)
        const result = fusedMulAdd(first, bBits, addend, F64)
        if (result === null) {
          this.flag(FFlag.NV)
          return this.writeF(inst.rd, CANONICAL_NAN_D)
        }
        if (this.needsStatus()) {
          this.applyStatus(statusOf(fusedExact(first, bBits, addend), result, F64))
        }
        return this.writeF(inst.rd, f64ToBits(result))
      }

      case Rv.FCVT_W_D:
      case Rv.FCVT_WU_D:
      case Rv.FCVT_L_D:
      case Rv.FCVT_LU_D:
        return this.write(inst.rd, this.floatToInt(si, a, op))

      case Rv.FCVT_D_W:
        return this.writeF(inst.rd, f64ToBits(Number(sext(this.x[inst.rs1]!, 32))))
      case Rv.FCVT_D_WU:
        return this.writeF(inst.rd, f64ToBits(Number(zext(this.x[inst.rs1]!, 32))))
      case Rv.FCVT_D_L:
        return this.writeF(inst.rd, this.intToFloat64(si, this.x[inst.rs1]!))
      case Rv.FCVT_D_LU:
        return this.writeF(inst.rd, this.intToFloat64(si, u64(this.x[inst.rs1]!)))
      case Rv.FCVT_D_S: {
        // Widening is always exact, so the rounding mode cannot matter.
        const single = unboxSingle(aBits)
        if (isSignaling32(single)) this.flag(FFlag.NV)
        const value = bitsToF32(single)
        return this.writeF(inst.rd, Number.isNaN(value) ? CANONICAL_NAN_D : f64ToBits(value))
      }
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, new Uint8Array([]), `no double-precision case for ${RV_NAME[op]}`,
        )
    }
  }

  private arith64(op: RvOp, a: number, b: number, aBits: bigint, bBits: bigint): number {
    const track = this.needsStatus()
    switch (op) {
      case Rv.FADD_D: {
        if (!Number.isFinite(a) && a === -b) this.flag(FFlag.NV)
        const value = a + b
        if (track) this.applyStatus(statusOf(exactSum(aBits, bBits), value, F64))
        return value
      }
      case Rv.FSUB_D: {
        if (!Number.isFinite(a) && a === b && !isNan64(aBits)) this.flag(FFlag.NV)
        const value = a - b
        if (track) this.applyStatus(statusOf(exactSum(aBits, negateBits(bBits)), value, F64))
        return value
      }
      case Rv.FMUL_D: {
        if ((a === 0 && !Number.isFinite(b) && !isNan64(bBits)) ||
            (b === 0 && !Number.isFinite(a) && !isNan64(aBits))) this.flag(FFlag.NV)
        const value = a * b
        if (track) this.applyStatus(statusOf(exactProduct(aBits, bBits), value, F64))
        return value
      }
      case Rv.FDIV_D: {
        if (a === 0 && b === 0) this.flag(FFlag.NV)
        else if (!Number.isFinite(a) && !Number.isFinite(b) &&
                 !isNan64(aBits) && !isNan64(bBits)) this.flag(FFlag.NV)
        else if (b === 0 && !isNan64(aBits)) this.flag(FFlag.DZ)
        const value = a / b
        if (track) this.applyStatus(quotientStatus(aBits, bBits, value, F64))
        return value
      }
      default: {
        // fsqrt: negative operands other than -0 are invalid.
        if (a < 0) this.flag(FFlag.NV)
        const value = Math.sqrt(a)
        if (track) this.applyStatus(sqrtStatus(aBits, value))
        return value
      }
    }
  }

  /**
   * Float to integer. RISC-V saturates rather than wrapping: NaN and anything
   * above the range give the maximum, anything below gives the minimum, and
   * the invalid flag is raised. The rounding happens first, so a value that
   * rounds back into range is in range.
   */
  private floatToInt(si: RvStaticInst, value: number, op: RvOp): bigint {
    const wide = op === Rv.FCVT_L_D || op === Rv.FCVT_LU_D ||
      op === Rv.FCVT_L_S || op === Rv.FCVT_LU_S
    const unsigned = op === Rv.FCVT_WU_D || op === Rv.FCVT_LU_D ||
      op === Rv.FCVT_WU_S || op === Rv.FCVT_LU_S
    const width = wide ? 64 : 32
    const low = unsigned ? 0n : -(1n << BigInt(width - 1))
    const high = unsigned ? (1n << BigInt(width)) - 1n : (1n << BigInt(width - 1)) - 1n
    const saturate = (v: bigint): bigint => sext(v, 64)

    if (Number.isNaN(value)) {
      this.flag(FFlag.NV)
      return saturate(wide ? high : sext(high, 32))
    }
    const rounded = roundToIntegral(value, this.roundingMode(si))
    if (!Number.isFinite(rounded)) {
      this.flag(FFlag.NV)
      const clamped = rounded > 0 ? high : low
      return wide ? BigInt.asIntN(64, clamped) : sext(clamped, 32)
    }
    const exact = BigInt(rounded)
    if (exact < low || exact > high) {
      this.flag(FFlag.NV)
      const clamped = exact < low ? low : high
      return wide ? BigInt.asIntN(64, clamped) : sext(clamped, 32)
    }
    // A conversion that had to round is inexact. An invalid one is not also
    // reported inexact, which is why this sits after the range checks.
    if (rounded !== value) this.flag(FFlag.NX)
    return wide ? BigInt.asIntN(64, exact) : sext(exact, 32)
  }

  /**
   * Integer to double. Exact for every 32-bit input, and for 64-bit inputs
   * only when the value fits in 53 bits; anything wider has to round, and the
   * host rounds to nearest-even and nothing else.
   */
  private intToFloat64(si: RvStaticInst, value: bigint): bigint {
    const converted = Number(value)
    if (BigInt(converted) !== value) {
      this.requireNearestEven(si)
      this.flag(FFlag.NX)
    }
    return f64ToBits(converted)
  }

  /** Integer to single, which is inexact far more often than the double form. */
  private intToFloat32(si: RvStaticInst, value: bigint): number {
    const converted = Math.fround(Number(value))
    if (!Number.isFinite(converted) || BigInt(converted) !== value) {
      this.requireNearestEven(si)
      this.flag(FFlag.NX)
    }
    return converted
  }

  private executeSingle(si: RvStaticInst): void {
    const inst = si.inst
    const op = inst.op
    const aBox = this.f[inst.rs1]!
    const bBox = this.f[inst.rs2]!
    const aBits = unboxSingle(aBox)
    const bBits = unboxSingle(bBox)
    const a = bitsToF32(aBits)
    const b = bitsToF32(bBits)
    const signalling = isSignaling32(aBits) || isSignaling32(bBits)
    const put = (value: number): void => {
      this.writeF(inst.rd, boxSingle(Number.isNaN(value) ? CANONICAL_NAN_S : f32ToBits(value)))
    }

    switch (op) {
      case Rv.FSGNJ_S:
        return this.writeF(inst.rd, boxSingle((aBits & ~SIGN32) | (bBits & SIGN32)))
      case Rv.FSGNJN_S:
        return this.writeF(inst.rd, boxSingle((aBits & ~SIGN32) | (~bBits & SIGN32)))
      case Rv.FSGNJX_S:
        return this.writeF(inst.rd, boxSingle(aBits ^ (bBits & SIGN32)))
      case Rv.FMV_X_W:
        // Also a raw transfer: the low 32 bits of the register as they are,
        // sign-extended, with no NaN-boxing check and no canonicalisation.
        return this.write(inst.rd, sext(this.f[inst.rs1]!, 32))
      case Rv.FMV_W_X:
        return this.writeF(inst.rd, boxSingle(Number(zext(this.x[inst.rs1]!, 32))))
      case Rv.FCLASS_S:
        return this.write(inst.rd, classifyF32(aBits))

      case Rv.FEQ_S:
        if (signalling) this.flag(FFlag.NV)
        return this.write(inst.rd, !isNan32(aBits) && !isNan32(bBits) && a === b ? 1n : 0n)
      case Rv.FLT_S:
        if (isNan32(aBits) || isNan32(bBits)) this.flag(FFlag.NV)
        return this.write(inst.rd, a < b ? 1n : 0n)
      case Rv.FLE_S:
        if (isNan32(aBits) || isNan32(bBits)) this.flag(FFlag.NV)
        return this.write(inst.rd, a <= b ? 1n : 0n)

      case Rv.FMIN_S:
      case Rv.FMAX_S: {
        if (signalling) this.flag(FFlag.NV)
        return this.writeF(inst.rd, boxSingle(minMax32(aBits, bBits, op === Rv.FMAX_S)))
      }

      case Rv.FADD_S:
      case Rv.FSUB_S:
      case Rv.FMUL_S:
      case Rv.FDIV_S:
      case Rv.FSQRT_S: {
        this.requireNearestEven(si)
        if (signalling) this.flag(FFlag.NV)
        // Computing in double and rounding to single is exact here: binary64
        // carries more than 2p+2 bits relative to binary32, which is the
        // condition under which the second rounding cannot change the result.
        return put(this.arithSingle(op, a, b, aBits, bBits))
      }

      case Rv.FMADD_S:
      case Rv.FMSUB_S:
      case Rv.FNMSUB_S:
      case Rv.FNMADD_S: {
        this.requireNearestEven(si)
        const cBits = unboxSingle(this.f[inst.rs3]!)
        if (signalling || isSignaling32(cBits)) this.flag(FFlag.NV)
        const { first, addend } = fmaOperands(
          op, f64ToBits(bitsToF32(aBits)), f64ToBits(bitsToF32(cBits)),
        )
        const second = f64ToBits(bitsToF32(bBits))
        const result = fusedMulAdd(first, second, addend, F32)
        if (result === null) {
          this.flag(FFlag.NV)
          return this.writeF(inst.rd, boxSingle(CANONICAL_NAN_S))
        }
        if (this.needsStatus()) {
          this.applyStatus(statusOf(fusedExact(first, second, addend), result, F32))
        }
        return put(result)
      }

      case Rv.FCVT_W_S:
      case Rv.FCVT_WU_S:
      case Rv.FCVT_L_S:
      case Rv.FCVT_LU_S:
        return this.write(inst.rd, this.floatToInt(si, a, op))

      case Rv.FCVT_S_W:
        return put(this.intToFloat32(si, sext(this.x[inst.rs1]!, 32)))
      case Rv.FCVT_S_WU:
        return put(this.intToFloat32(si, zext(this.x[inst.rs1]!, 32)))
      case Rv.FCVT_S_L:
        return put(this.intToFloat32(si, this.x[inst.rs1]!))
      case Rv.FCVT_S_LU:
        return put(this.intToFloat32(si, u64(this.x[inst.rs1]!)))
      case Rv.FCVT_S_D: {
        this.requireNearestEven(si)
        const wide = this.f[inst.rs1]!
        if (isSignaling64(wide)) this.flag(FFlag.NV)
        const value = Math.fround(bitsToF64(wide))
        // Narrowing is the one conversion that can overflow or go subnormal.
        if (this.needsStatus()) this.applyStatus(statusOf(exactOf(wide), value, F32))
        return put(value)
      }
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, new Uint8Array([]), `no single-precision case for ${RV_NAME[op]}`,
        )
    }
  }

  private arithSingle(op: RvOp, a: number, b: number, aBits: number, bBits: number): number {
    const track = this.needsStatus()
    // Every single is exactly a double, so widening the operands to form the
    // exact result loses nothing; only the format rounded to differs.
    const wideA = f64ToBits(a)
    const wideB = f64ToBits(b)
    switch (op) {
      case Rv.FADD_S: {
        if (!Number.isFinite(a) && a === -b) this.flag(FFlag.NV)
        const value = Math.fround(a + b)
        if (track) this.applyStatus(statusOf(exactSum(wideA, wideB), value, F32))
        return value
      }
      case Rv.FSUB_S: {
        if (!Number.isFinite(a) && a === b && !isNan32(aBits)) this.flag(FFlag.NV)
        const value = Math.fround(a - b)
        if (track) this.applyStatus(statusOf(exactSum(wideA, negateBits(wideB)), value, F32))
        return value
      }
      case Rv.FMUL_S: {
        if ((a === 0 && !Number.isFinite(b) && !isNan32(bBits)) ||
            (b === 0 && !Number.isFinite(a) && !isNan32(aBits))) this.flag(FFlag.NV)
        const value = Math.fround(a * b)
        if (track) this.applyStatus(statusOf(exactProduct(wideA, wideB), value, F32))
        return value
      }
      case Rv.FDIV_S: {
        if (a === 0 && b === 0) this.flag(FFlag.NV)
        else if (!Number.isFinite(a) && !Number.isFinite(b) &&
                 !isNan32(aBits) && !isNan32(bBits)) this.flag(FFlag.NV)
        else if (b === 0 && !isNan32(aBits)) this.flag(FFlag.DZ)
        const value = Math.fround(a / b)
        if (track) this.applyStatus(quotientStatus(wideA, wideB, value, F32))
        return value
      }
      default: {
        if (a < 0) this.flag(FFlag.NV)
        const value = Math.fround(Math.sqrt(a))
        if (track) this.applyStatus(sqrtStatus(wideA, value))
        return value
      }
    }
  }
}

const SIGN64 = 0x8000000000000000n
const SIGN32 = 0x80000000 | 0

/**
 * fmin/fmax on RISC-V: a NaN operand is ignored rather than propagated, two
 * NaNs give the canonical one, and the zeroes are ordered so that -0 is below
 * +0. The host's Math.min and Math.max agree on the zeroes and disagree on
 * the NaNs, so this cannot delegate to them.
 */
function minMax64(aBits: bigint, bBits: bigint, wantMax: boolean): bigint {
  const aNan = isNan64(aBits)
  const bNan = isNan64(bBits)
  if (aNan && bNan) return CANONICAL_NAN_D
  if (aNan) return bBits
  if (bNan) return aBits
  const a = bitsToF64(aBits)
  const b = bitsToF64(bBits)
  if (a === 0 && b === 0) {
    const aNegative = (u64(aBits) & SIGN64) !== 0n
    return wantMax ? (aNegative ? bBits : aBits) : (aNegative ? aBits : bBits)
  }
  return (wantMax ? a > b : a < b) ? aBits : bBits
}

function minMax32(aBits: number, bBits: number, wantMax: boolean): number {
  const aNan = isNan32(aBits)
  const bNan = isNan32(bBits)
  if (aNan && bNan) return CANONICAL_NAN_S
  if (aNan) return bBits
  if (bNan) return aBits
  const a = bitsToF32(aBits)
  const b = bitsToF32(bBits)
  if (a === 0 && b === 0) {
    const aNegative = (aBits & SIGN32) !== 0
    return wantMax ? (aNegative ? bBits : aBits) : (aNegative ? aBits : bBits)
  }
  return (wantMax ? a > b : a < b) ? aBits : bBits
}

/**
 * The four fused forms differ only in which operands are negated:
 *   fmadd    rs1 * rs2 + rs3
 *   fmsub    rs1 * rs2 - rs3
 *   fnmsub  -rs1 * rs2 + rs3
 *   fnmadd  -rs1 * rs2 - rs3
 * Negating the product by negating rs1 is exact, and negating the final
 * result is exact, so neither introduces a rounding the hardware would not do.
 */
function fmaOperands(op: RvOp, aBits: bigint, cBits: bigint): { first: bigint; addend: bigint } {
  switch (op) {
    case Rv.FMADD_D:
    case Rv.FMADD_S:
      return { first: aBits, addend: cBits }
    case Rv.FMSUB_D:
    case Rv.FMSUB_S:
      return { first: aBits, addend: negateBits(cBits) }
    case Rv.FNMSUB_D:
    case Rv.FNMSUB_S:
      return { first: negateBits(aBits), addend: cBits }
    default:
      return { first: negateBits(aBits), addend: negateBits(cBits) }
  }
}

/** The exact value of first * second + addend, for the status computation. */
function fusedExact(first: bigint, second: bigint, addend: bigint): Exact | null {
  const product = exactProduct(first, second)
  const c = exactOf(addend)
  if (product === null || c === null) return null
  const e = Math.min(product.e, c.e)
  return { m: (product.m << BigInt(product.e - e)) + (c.m << BigInt(c.e - e)), e }
}

/** Flips a float's sign bit. Exact, and correct for zeroes and NaNs alike. */
function negateBits(bits: bigint): bigint {
  return BigInt.asIntN(64, u64(bits) ^ SIGN64)
}

/**
 * RISC-V division never traps. Division by zero yields all ones for signed
 * and the unsigned maximum for unsigned; the one overflowing case, the most
 * negative value divided by -1, yields itself. The W forms do all of this one
 * width down and sign-extend the answer.
 */
function divideSigned(a: bigint, b: bigint, width: number): bigint {
  const x = sext(a, width)
  const y = sext(b, width)
  if (y === 0n) return -1n
  const min = -(1n << BigInt(width - 1))
  if (x === min && y === -1n) return sext(min, 64)
  return sext(x / y, 64)
}

function divideUnsigned(a: bigint, b: bigint, width: number): bigint {
  const x = zext(a, width)
  const y = zext(b, width)
  if (y === 0n) return sext((1n << BigInt(width)) - 1n, width === 64 ? 64 : 32)
  return sext(x / y, width === 64 ? 64 : 32)
}

function remainderSigned(a: bigint, b: bigint, width: number): bigint {
  const x = sext(a, width)
  const y = sext(b, width)
  if (y === 0n) return sext(x, 64)
  const min = -(1n << BigInt(width - 1))
  if (x === min && y === -1n) return 0n
  return sext(x % y, 64)
}

function remainderUnsigned(a: bigint, b: bigint, width: number): bigint {
  const x = zext(a, width)
  const y = zext(b, width)
  if (y === 0n) return sext(x, width === 64 ? 64 : 32)
  return sext(x % y, width === 64 ? 64 : 32)
}

const DOUBLE_OPS = new Set<RvOp>([
  Rv.FADD_D, Rv.FSUB_D, Rv.FMUL_D, Rv.FDIV_D, Rv.FSQRT_D,
  Rv.FSGNJ_D, Rv.FSGNJN_D, Rv.FSGNJX_D, Rv.FMIN_D, Rv.FMAX_D,
  Rv.FEQ_D, Rv.FLT_D, Rv.FLE_D, Rv.FCLASS_D, Rv.FMV_X_D, Rv.FMV_D_X,
  Rv.FCVT_W_D, Rv.FCVT_WU_D, Rv.FCVT_L_D, Rv.FCVT_LU_D,
  Rv.FCVT_D_W, Rv.FCVT_D_WU, Rv.FCVT_D_L, Rv.FCVT_D_LU, Rv.FCVT_D_S,
  Rv.FMADD_D, Rv.FMSUB_D, Rv.FNMSUB_D, Rv.FNMADD_D,
])

const SINGLE_OPS = new Set<RvOp>([
  Rv.FADD_S, Rv.FSUB_S, Rv.FMUL_S, Rv.FDIV_S, Rv.FSQRT_S,
  Rv.FSGNJ_S, Rv.FSGNJN_S, Rv.FSGNJX_S, Rv.FMIN_S, Rv.FMAX_S,
  Rv.FEQ_S, Rv.FLT_S, Rv.FLE_S, Rv.FCLASS_S, Rv.FMV_X_W, Rv.FMV_W_X,
  Rv.FCVT_W_S, Rv.FCVT_WU_S, Rv.FCVT_L_S, Rv.FCVT_LU_S,
  Rv.FCVT_S_W, Rv.FCVT_S_WU, Rv.FCVT_S_L, Rv.FCVT_S_LU, Rv.FCVT_S_D,
  Rv.FMADD_S, Rv.FMSUB_S, Rv.FNMSUB_S, Rv.FNMADD_S,
])
