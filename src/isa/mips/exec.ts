/**
 * MIPS32 interpreter.
 *
 * The delay slot is the whole story. On this architecture a branch does
 * not take effect when it executes: the instruction after it runs first,
 * and only then does control move. That is not a quirk to be worked
 * around, it is the semantics, and it shapes this file in three places.
 *
 * A taken branch records where control will go and lets the next
 * instruction run normally. The instruction in the slot is an ordinary
 * instruction that happens to be followed by a jump, and it retires in its
 * own right -- so the retired trace has both, in the order they executed,
 * with the branch's successor being the slot and the slot's successor
 * being the target. A timing model reading that trace needs to know
 * nothing about delay slots at all, which is the point.
 *
 * A branch *inside* a delay slot is architecturally undefined, and is
 * refused rather than given some plausible meaning.
 *
 * The other thing worth knowing is that the floating-point unit is a
 * coprocessor with its own register file, its own condition flags and its
 * own control register, reached through move instructions rather than
 * shared operands. A compare writes a condition bit that a branch reads
 * several instructions later, which makes it architectural state the
 * comparison has to cover.
 */
import { u64 } from '../common/bits64.ts'
import {
  ExecutionBudgetExceeded,
  GuestFault,
  IsaError,
  UnimplementedInstruction,
  UnsupportedSyscall,
} from '../common/errors.ts'
import {
  F32,
  F64,
  RoundMode,
  exactProduct,
  exactSum,
  quotientStatus,
  sqrtStatus,
  statusOf,
  type RoundingStatus,
  bitsToF32,
  bitsToF64,
  f32ToBits,
  f64ToBits,
  fusedMulAdd,
  isNan32,
  isNan64,
  roundToIntegral,
} from '../common/fp.ts'
import { MIPS_SYSCALL_NUMBERS, Sys, type LinuxSyscalls } from '../common/linux.ts'
import type { AccessWidth, GuestMemory } from '../common/memory.ts'
import { RunState, type ArchState, type Interpreter, type RetireChunk } from '../common/trace.ts'
import { ISA_NAME, MIPS, type MipsInst } from './decode.ts'
import type { MipsImage, MipsStaticInst } from './image.ts'

const DEFAULT_BUDGET = 2_000_000_000
const MASK32 = 0xffffffffn

export interface MipsOptions {
  initialRegisters?: readonly bigint[]
  instructionBudget?: number
  syscalls?: LinuxSyscalls
}

export class MipsInterpreter implements Interpreter {
  readonly image: MipsImage
  private readonly memory: GuestMemory
  private readonly r = new Uint32Array(32)
  private readonly f: bigint[] = Array.from({ length: 32 }, () => 0n)
  private hi = 0
  private lo = 0
  /** Floating-point control and status, of which only a little is used. */
  private fcsr = 0
  /** The thread pointer, which this architecture keeps out of the file. */
  private tls = 0n
  /** The address a load-linked reserved, or null when none is held. */
  private reservation: bigint | null = null
  private pc: bigint
  private next = 0n
  /**
   * Where control goes after the next instruction, when a branch has been
   * taken and its delay slot has not run yet.
   */
  private pending: bigint | null = null
  private exited = false
  private access = 0n
  private accessWidth = 0
  private taken = 0
  private readonly budget: number
  private readonly linux: LinuxSyscalls | undefined
  exitCode = 0
  retired = 0

  constructor(image: MipsImage, memory: GuestMemory, options: MipsOptions = {}) {
    this.image = image
    this.memory = memory
    this.pc = image.entry
    this.budget = options.instructionBudget ?? DEFAULT_BUDGET
    this.linux = options.syscalls
    const initial = options.initialRegisters
    if (initial) for (let i = 0; i < 32 && i < initial.length; i++) this.setGpr(i, initial[i]!)
  }

  setGpr(index: number, value: bigint): void {
    if (index < 32) this.r[index] = Number(BigInt.asUintN(32, value))
    else if (index === 32) this.hi = Number(BigInt.asUintN(32, value))
    else if (index === 33) this.lo = Number(BigInt.asUintN(32, value))
  }

  gpr(index: number): bigint {
    if (index < 32) return BigInt(this.r[index]!)
    if (index === 32) return BigInt(this.hi >>> 0)
    if (index === 33) return BigInt(this.lo >>> 0)
    return 0n
  }

  fpr(index: number): bigint {
    return this.f[index]!
  }

  get programCounter(): bigint {
    return this.pc
  }

  finalState(): ArchState {
    return {
      gpr: Array.from(this.r, (v) => BigInt(v >>> 0)),
      fpr: [...this.f],
      status: {
        hi: BigInt(this.hi >>> 0),
        lo: BigInt(this.lo >>> 0),
        fcsr: BigInt(this.fcsr >>> 0),
      },
      pc: this.pc,
    }
  }

  stdout(): Uint8Array {
    return this.linux?.stdout() ?? new Uint8Array()
  }

  stderr(): Uint8Array {
    return this.linux?.stderr() ?? new Uint8Array()
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
      // A branch whose slot is about to run has already said where control
      // goes; every other instruction simply falls through.
      const arriving = this.pending
      this.pending = null
      this.next = pc + 4n
      this.execute(si)
      if (arriving !== null) {
        if (this.pending !== null) {
          throw new IsaError(
            `${ISA_NAME}: a branch in a delay slot at 0x${pc.toString(16)}`,
          )
        }
        this.next = arriving
      }
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

  // -------------------------------------------------------------------------
  // Registers. Register zero reads as zero and discards what is written to
  // it, which is what lets `move` be an add and `nop` be a shift.
  // -------------------------------------------------------------------------

  private read(index: number): number {
    return index === 0 ? 0 : this.r[index]! | 0
  }

  private readU(index: number): number {
    return index === 0 ? 0 : this.r[index]! >>> 0
  }

  private write(index: number, value: number): void {
    if (index !== 0) this.r[index] = value >>> 0
  }

  /**
   * Where control goes after the delay slot, once a branch is taken.
   *
   * `taken` is recorded on the branch, not on its slot: the branch is the
   * instruction whose outcome a predictor has to guess. Marking the slot
   * instead left every branch looking untaken, so a timing model saw a
   * perfectly predicted MIPS.
   */
  private branchTo(target: bigint): void {
    this.pending = target
    this.taken = 1
  }

  private address(inst: MipsInst): bigint {
    return u64(BigInt(this.readU(inst.rs)) + inst.imm) & 0xffffffffn
  }

  private execute(si: MipsStaticInst): void {
    const inst = si.inst

    switch (inst.op) {
      case MIPS.SYNC:
        return

      case MIPS.ADDU:
        return this.write(inst.rd, (this.read(inst.rs) + this.read(inst.rt)) | 0)
      case MIPS.SUBU:
        return this.write(inst.rd, (this.read(inst.rs) - this.read(inst.rt)) | 0)
      case MIPS.AND:
        return this.write(inst.rd, this.read(inst.rs) & this.read(inst.rt))
      case MIPS.OR:
        return this.write(inst.rd, this.read(inst.rs) | this.read(inst.rt))
      case MIPS.XOR:
        return this.write(inst.rd, this.read(inst.rs) ^ this.read(inst.rt))
      case MIPS.NOR:
        return this.write(inst.rd, ~(this.read(inst.rs) | this.read(inst.rt)))
      case MIPS.SLT:
        return this.write(inst.rd, this.read(inst.rs) < this.read(inst.rt) ? 1 : 0)
      case MIPS.SLTU:
        return this.write(inst.rd, this.readU(inst.rs) < this.readU(inst.rt) ? 1 : 0)

      case MIPS.ADDIU:
        return this.write(inst.rt, (this.read(inst.rs) + Number(inst.imm)) | 0)
      case MIPS.ANDI:
        return this.write(inst.rt, this.read(inst.rs) & Number(inst.imm))
      case MIPS.ORI:
        return this.write(inst.rt, this.read(inst.rs) | Number(inst.imm))
      case MIPS.XORI:
        return this.write(inst.rt, this.read(inst.rs) ^ Number(inst.imm))
      case MIPS.SLTI:
        return this.write(inst.rt, this.read(inst.rs) < Number(inst.imm) ? 1 : 0)
      case MIPS.SLTIU:
        // The immediate is sign-extended and *then* compared without sign,
        // which is not the same as comparing it unsigned.
        return this.write(
          inst.rt, this.readU(inst.rs) < Number(BigInt.asUintN(32, inst.imm)) ? 1 : 0,
        )
      case MIPS.LUI:
        return this.write(inst.rt, Number(inst.imm) | 0)

      case MIPS.SLL:
        return this.write(inst.rd, this.read(inst.rt) << inst.sa)
      case MIPS.SRL:
        return this.write(inst.rd, this.readU(inst.rt) >>> inst.sa)
      case MIPS.SRA:
        return this.write(inst.rd, this.read(inst.rt) >> inst.sa)
      case MIPS.ROTR: {
        const value = this.readU(inst.rt)
        const n = inst.sa & 31
        return this.write(inst.rd, n === 0 ? value : (value >>> n) | (value << (32 - n)))
      }
      case MIPS.SLLV:
        return this.write(inst.rd, this.read(inst.rt) << (this.read(inst.rs) & 31))
      case MIPS.SRLV:
        return this.write(inst.rd, this.readU(inst.rt) >>> (this.read(inst.rs) & 31))
      case MIPS.SRAV:
        return this.write(inst.rd, this.read(inst.rt) >> (this.read(inst.rs) & 31))

      case MIPS.MOVN:
        if (this.read(inst.rt) !== 0) this.write(inst.rd, this.read(inst.rs))
        return
      case MIPS.MOVZ:
        if (this.read(inst.rt) === 0) this.write(inst.rd, this.read(inst.rs))
        return

      case MIPS.MULT:
      case MIPS.MULTU:
      case MIPS.MADD:
      case MIPS.MSUB:
        return this.multiplyAccumulate(inst)
      case MIPS.MUL:
        // The three-operand form writes a general register and leaves the
        // HI and LO pair unspecified, so nothing here may rely on them.
        return this.write(
          inst.rd, Math.imul(this.read(inst.rs), this.read(inst.rt)) | 0,
        )
      case MIPS.DIV:
      case MIPS.DIVU:
        return this.divide(inst)

      case MIPS.MFHI: return this.write(inst.rd, this.hi)
      case MIPS.MFLO: return this.write(inst.rd, this.lo)
      case MIPS.MTHI: this.hi = this.read(inst.rs); return
      case MIPS.MTLO: this.lo = this.read(inst.rs); return

      case MIPS.CLZ:
      case MIPS.CLO: {
        const value = inst.op === MIPS.CLZ ? this.readU(inst.rs) : ~this.readU(inst.rs) >>> 0
        return this.write(inst.rd, value === 0 ? 32 : Math.clz32(value))
      }
      case MIPS.SEB:
        return this.write(inst.rd, (this.read(inst.rt) << 24) >> 24)
      case MIPS.SEH:
        return this.write(inst.rd, (this.read(inst.rt) << 16) >> 16)
      case MIPS.WSBH: {
        const v = this.readU(inst.rt)
        return this.write(
          inst.rd,
          ((v & 0x00ff00ff) << 8) | ((v >>> 8) & 0x00ff00ff),
        )
      }
      case MIPS.EXT: {
        const mask = inst.size === 32 ? 0xffffffff : (1 << inst.size) - 1
        return this.write(inst.rt, (this.readU(inst.rs) >>> inst.sa) & mask)
      }
      case MIPS.INS: {
        const mask = ((inst.size === 32 ? 0xffffffff : (1 << inst.size) - 1) << inst.sa) >>> 0
        const inserted = (this.readU(inst.rs) << inst.sa) & mask
        return this.write(inst.rt, ((this.readU(inst.rt) & ~mask) | inserted) | 0)
      }

      case MIPS.RDHWR:
        return this.write(inst.rt, Number(this.tls & MASK32))

      case MIPS.LB:
      case MIPS.LBU:
      case MIPS.LH:
      case MIPS.LHU:
      case MIPS.LW:
      case MIPS.LL:
        return this.load(inst)
      case MIPS.SB:
      case MIPS.SH:
      case MIPS.SW:
        return this.store(inst)
      case MIPS.SC:
        return this.storeConditional(inst)
      case MIPS.LWL:
      case MIPS.LWR:
      case MIPS.SWL:
      case MIPS.SWR:
        return this.unaligned(inst)

      case MIPS.J:
        return this.branchTo(inst.target)
      case MIPS.JAL:
        this.write(31, Number(this.pc + 8n))
        return this.branchTo(inst.target)
      case MIPS.JR:
        return this.branchTo(BigInt(this.readU(inst.rs)))
      case MIPS.JALR: {
        // The link register is written before the target is read, which
        // matters only when they are the same register.
        const target = BigInt(this.readU(inst.rs))
        this.write(inst.rd, Number(this.pc + 8n))
        return this.branchTo(target)
      }

      case MIPS.BEQ:
        if (this.read(inst.rs) === this.read(inst.rt)) this.branchTo(inst.target)
        return
      case MIPS.BNE:
        if (this.read(inst.rs) !== this.read(inst.rt)) this.branchTo(inst.target)
        return
      case MIPS.BLEZ:
        if (this.read(inst.rs) <= 0) this.branchTo(inst.target)
        return
      case MIPS.BGTZ:
        if (this.read(inst.rs) > 0) this.branchTo(inst.target)
        return
      case MIPS.BLTZ:
        if (this.read(inst.rs) < 0) this.branchTo(inst.target)
        return
      case MIPS.BGEZ:
        if (this.read(inst.rs) >= 0) this.branchTo(inst.target)
        return
      case MIPS.BLTZAL:
      case MIPS.BGEZAL: {
        const condition = inst.op === MIPS.BLTZAL
          ? this.read(inst.rs) < 0
          : this.read(inst.rs) >= 0
        // The link happens whether or not the branch is taken.
        this.write(31, Number(this.pc + 8n))
        if (condition) this.branchTo(inst.target)
        return
      }

      case MIPS.MOVCI:
        if (this.condition(inst.cc) === (inst.predicate === 1)) {
          this.write(inst.rd, this.read(inst.rs))
        }
        return

      case MIPS.TRAP: {
        const a = this.read(inst.rs)
        const b = this.read(inst.rt)
        const ua = this.readU(inst.rs)
        const ub = this.readU(inst.rt)
        // tge tgeu tlt tltu teq - tne, in the order the encoding numbers
        // them, with a gap where 0x35 would be.
        const holds = [
          a >= b, ua >= ub, a < b, ua < ub, a === b, false, a !== b,
        ][inst.predicate] ?? false
        if (holds) {
          throw new IsaError(
            `${ISA_NAME}: trap at 0x${si.addr.toString(16)}`,
          )
        }
        return
      }

      case MIPS.SYSCALL:
        return this.syscall(si)
      case MIPS.BREAK:
        throw new IsaError(`${ISA_NAME}: break at 0x${si.addr.toString(16)}`)

      case MIPS.FP_LOAD:
      case MIPS.FP_STORE:
      case MIPS.MFC1:
      case MIPS.MTC1:
      case MIPS.MFHC1:
      case MIPS.MTHC1:
      case MIPS.CFC1:
      case MIPS.CTC1:
      case MIPS.FP_ADD:
      case MIPS.FP_SUB:
      case MIPS.FP_MUL:
      case MIPS.FP_DIV:
      case MIPS.FP_SQRT:
      case MIPS.FP_ABS:
      case MIPS.FP_NEG:
      case MIPS.FP_MOV:
      case MIPS.FP_CVT:
      case MIPS.FP_ROUND:
      case MIPS.FP_CMP:
      case MIPS.BC1:
      case MIPS.FP_MOVCF:
      case MIPS.FP_MOVZ:
      case MIPS.FP_MOVN:
      case MIPS.FP_MADD:
        return this.coprocessor(si)

      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, new Uint8Array([]), `execution of ${inst.op}`,
        )
    }
  }

  private multiplyAccumulate(inst: MipsInst): void {
    const signed = inst.op === MIPS.MULT || inst.op === MIPS.MADD || inst.op === MIPS.MSUB
    const a = signed ? BigInt(this.read(inst.rs)) : BigInt(this.readU(inst.rs))
    const b = signed ? BigInt(this.read(inst.rt)) : BigInt(this.readU(inst.rt))
    let product = a * b
    if (inst.op === MIPS.MADD || inst.op === MIPS.MSUB) {
      const current = (BigInt(this.hi >>> 0) << 32n) | BigInt(this.lo >>> 0)
      const accumulated = BigInt.asIntN(64, current)
      product = inst.op === MIPS.MADD ? accumulated + product : accumulated - product
    }
    const wide = BigInt.asUintN(64, product)
    this.lo = Number(wide & MASK32) | 0
    this.hi = Number((wide >> 32n) & MASK32) | 0
  }

  private divide(inst: MipsInst): void {
    // Division by zero is architecturally unpredictable rather than a
    // fault, and the compiler puts an explicit trap before it. Leaving the
    // pair alone is the one choice that cannot invent a plausible answer.
    if (inst.op === MIPS.DIV) {
      const a = this.read(inst.rs)
      const b = this.read(inst.rt)
      if (b === 0) return
      // The one case where the quotient is not representable.
      if (a === -0x80000000 && b === -1) {
        this.lo = a
        this.hi = 0
        return
      }
      this.lo = (a / b) | 0
      this.hi = (a % b) | 0
      return
    }
    const a = this.readU(inst.rs)
    const b = this.readU(inst.rt)
    if (b === 0) return
    this.lo = Math.floor(a / b) | 0
    this.hi = (a % b) | 0
  }

  private load(inst: MipsInst): void {
    const at = this.address(inst)
    this.requireAligned(inst, at)
    this.access = at
    this.accessWidth = inst.width
    const value = this.memory.load(at, inst.width as AccessWidth, inst.signed)
    if (inst.op === MIPS.LL) this.reservation = at
    this.write(inst.rt, Number(BigInt.asIntN(32, value)))
  }

  private store(inst: MipsInst): void {
    const at = this.address(inst)
    this.requireAligned(inst, at)
    this.access = at
    this.accessWidth = inst.width
    this.memory.store(at, inst.width as AccessWidth, BigInt(this.readU(inst.rt)))
  }

  private storeConditional(inst: MipsInst): void {
    const at = this.address(inst)
    this.requireAligned(inst, at)
    this.access = at
    this.accessWidth = 4
    // One hart, so the reservation can only be lost by never having been
    // taken. Succeeding unconditionally would let a lock protect nothing.
    const held = this.reservation === at
    if (held) this.memory.store(at, 4, BigInt(this.readU(inst.rt)))
    this.reservation = null
    this.write(inst.rt, held ? 1 : 0)
  }

  /**
   * The unaligned word accesses, which move only the bytes of the word
   * that lie on one side of the address. A compiler emits them in pairs
   * for anything it cannot prove aligned.
   */
  private unaligned(inst: MipsInst): void {
    const at = this.address(inst)
    const aligned = at & ~3n
    const offset = Number(at & 3n)
    this.access = aligned
    this.accessWidth = 4
    const word = Number(this.memory.load(aligned, 4, false))
    const current = this.readU(inst.rt)

    switch (inst.op) {
      case MIPS.LWL: {
        // The addressed byte becomes the most significant one.
        const shift = (3 - offset) * 8
        const mask = shift === 0 ? 0xffffffff : (1 << (32 - shift)) - 1
        void mask
        return this.write(inst.rt, ((word << shift) | (current & ((1 << shift) - 1))) | 0)
      }
      case MIPS.LWR: {
        const shift = offset * 8
        const keep = shift === 0 ? 0 : (0xffffffff << (32 - shift)) >>> 0
        return this.write(inst.rt, ((word >>> shift) | (current & keep)) | 0)
      }
      case MIPS.SWL: {
        const shift = (3 - offset) * 8
        const mask = shift === 0 ? 0xffffffff : (1 << (32 - shift)) - 1
        const merged = ((word & ~mask) | ((current >>> shift) & mask)) >>> 0
        return this.memory.store(aligned, 4, BigInt(merged))
      }
      default: {
        const shift = offset * 8
        const mask = shift === 0 ? 0xffffffff : (0xffffffff << shift) >>> 0
        const merged = ((word & ~mask) | ((current << shift) & mask)) >>> 0
        return this.memory.store(aligned, 4, BigInt(merged))
      }
    }
  }

  private requireAligned(inst: MipsInst, at: bigint): void {
    if (inst.width > 1 && at % BigInt(inst.width) !== 0n) {
      throw new GuestFault(
        'read', at, inst.width,
        `${ISA_NAME}: misaligned ${inst.width}-byte access`,
      )
    }
  }

  private syscall(si: MipsStaticInst): void {
    if (!this.linux) {
      throw new UnsupportedSyscall(ISA_NAME, this.readU(2), 'no syscall layer')
    }
    const number = this.readU(2)
    // Setting the thread pointer is the one call this architecture keeps
    // to itself, because the pointer is not in the register file.
    if (number === SET_THREAD_AREA) {
      this.tls = BigInt(this.readU(4))
      this.write(2, 0)
      this.write(7, 0)
      return
    }
    const generic = MIPS_SYSCALL_NUMBERS[number]
    if (generic === undefined) {
      throw new UnsupportedSyscall(ISA_NAME, number, 'not in the o32 syscall table')
    }
    // The fifth and later arguments are on the stack rather than in
    // registers, which is the o32 calling convention showing through.
    //
    // They are read only for the calls that have them. The caller
    // reserves those stack slots, so a four-argument call has not, and
    // reading them anyway faults whenever the stack pointer happens to
    // be at the top of its mapping -- which is exactly where a
    // freestanding program's is.
    const args = [
      BigInt(this.readU(4)), BigInt(this.readU(5)), BigInt(this.readU(6)),
      BigInt(this.readU(7)), 0n, 0n,
    ]
    if (STACK_ARGUMENTS.has(generic)) {
      const stack = u64(BigInt(this.readU(29)))
      args[4] = this.memory.load(u64(stack + 16n), 4, false)
      args[5] = this.memory.load(u64(stack + 20n), 4, false)
    }
    const result = this.linux.dispatch(ISA_NAME, generic, args)
    if (result.exited) {
      this.exited = true
      this.exitCode = this.linux.exitCode
      return
    }
    // The error indication is a separate register rather than a negative
    // return value, which is this ABI's one real departure.
    const signed = BigInt.asIntN(32, result.value)
    if (signed < 0n) {
      this.write(2, Number(-signed))
      this.write(7, 1)
    } else {
      this.write(2, Number(BigInt.asIntN(32, result.value)))
      this.write(7, 0)
    }
    void si
  }

  // -------------------------------------------------------------------------
  // Coprocessor 1. Its own registers, its own condition bits, its own
  // control word, and no instruction that mixes its operands with the
  // core's except the moves.
  // -------------------------------------------------------------------------

  /** A floating-point register, at the width the instruction names. */
  private readFp(index: number, width: number): bigint {
    return width === 8 ? BigInt.asUintN(64, this.f[index]!) : BigInt.asUintN(32, this.f[index]!)
  }

  private writeFp(index: number, value: bigint, width: number): void {
    // A single-precision write leaves the upper half alone, because the
    // register is 64 bits wide and only half of it is being written.
    this.f[index] = width === 8
      ? BigInt.asUintN(64, value)
      : (this.f[index]! & ~0xffffffffn) | BigInt.asUintN(32, value)
  }

  private condition(index: number): boolean {
    return (this.fcsr & (1 << conditionBit(index))) !== 0
  }

  /**
   * Records the exceptions an operation raised.
   *
   * The control register holds them twice: as a *cause*, which says what
   * the instruction just executed did and is replaced each time, and as a
   * *flag*, which accumulates and is only cleared by a program writing
   * the register. Keeping only one of the two would be wrong in opposite
   * directions -- the cause alone loses history, the flag alone never
   * says what the last instruction did.
   */
  private raise(exceptions: number): void {
    this.fcsr = (this.fcsr & ~(0x3f << 12)) | (exceptions << 12) | (exceptions << 2)
  }

  private setCondition(index: number, value: boolean): void {
    const bit = 1 << conditionBit(index)
    this.fcsr = value ? this.fcsr | bit : this.fcsr & ~bit
  }

  private asNumber(bits: bigint, width: number): number {
    return width === 8 ? bitsToF64(bits) : bitsToF32(Number(bits))
  }

  private fromNumber(value: number, width: number): bigint {
    return width === 8 ? f64ToBits(value) : BigInt(f32ToBits(Math.fround(value)))
  }

  private coprocessor(si: MipsStaticInst): void {
    const inst = si.inst

    switch (inst.op) {
      case MIPS.FP_LOAD: {
        const at = this.address(inst)
        this.requireAligned(inst, at)
        this.access = at
        this.accessWidth = inst.width
        return this.writeFp(
          inst.rt, this.memory.load(at, inst.width as AccessWidth, false), inst.width,
        )
      }
      case MIPS.FP_STORE: {
        const at = this.address(inst)
        this.requireAligned(inst, at)
        this.access = at
        this.accessWidth = inst.width
        return this.memory.store(
          at, inst.width as AccessWidth, this.readFp(inst.rt, inst.width),
        )
      }

      case MIPS.MFC1:
        return this.write(inst.rt, Number(BigInt.asIntN(32, this.readFp(inst.rd, 4))))
      case MIPS.MFHC1:
        return this.write(
          inst.rt, Number(BigInt.asIntN(32, (this.f[inst.rd]! >> 32n) & MASK32)),
        )
      case MIPS.MTC1:
        return this.writeFp(inst.rd, BigInt(this.readU(inst.rt)), 4)
      case MIPS.MTHC1:
        this.f[inst.rd] = (this.f[inst.rd]! & MASK32) |
          (BigInt(this.readU(inst.rt)) << 32n)
        return

      case MIPS.CFC1:
        // Only the control and status register is readable; anything else
        // would be reporting a capability this does not have.
        if (inst.rd !== 31 && inst.rd !== 0) {
          throw new UnimplementedInstruction(
            ISA_NAME, si.addr, new Uint8Array([]), `read of coprocessor control ${inst.rd}`,
          )
        }
        // Register 0 is the implementation and revision, which a libc
        // reads to decide whether there is a unit at all.
        return this.write(inst.rt, inst.rd === 31 ? this.fcsr : FPU_IMPLEMENTATION)
      case MIPS.CTC1:
        if (inst.rd !== 31) {
          throw new UnimplementedInstruction(
            ISA_NAME, si.addr, new Uint8Array([]), `write of coprocessor control ${inst.rd}`,
          )
        }
        this.fcsr = this.read(inst.rt)
        return

      case MIPS.BC1:
        if (this.condition(inst.cc) === (inst.predicate === 1)) this.branchTo(inst.target)
        return

      case MIPS.FP_MOVCF:
        if (this.condition(inst.cc) === (inst.predicate === 1)) {
          this.writeFp(inst.rd, this.readFp(inst.rs, inst.fmt), inst.fmt)
        }
        return
      case MIPS.FP_MOVZ:
        if (this.read(inst.rt) === 0) {
          this.writeFp(inst.rd, this.readFp(inst.rs, inst.fmt), inst.fmt)
        }
        return
      case MIPS.FP_MOVN:
        if (this.read(inst.rt) !== 0) {
          this.writeFp(inst.rd, this.readFp(inst.rs, inst.fmt), inst.fmt)
        }
        return

      case MIPS.FP_MOV:
        return this.writeFp(inst.rd, this.readFp(inst.rs, inst.fmt), inst.fmt)
      case MIPS.FP_ABS:
      case MIPS.FP_NEG: {
        // Sign manipulation is defined on the bits rather than the value,
        // so it applies to a NaN as readily as to a number.
        const width = inst.fmt
        const signBit = 1n << BigInt(width * 8 - 1)
        const bits = this.readFp(inst.rs, width)
        return this.writeFp(
          inst.rd, inst.op === MIPS.FP_NEG ? bits ^ signBit : bits & ~signBit, width,
        )
      }

      case MIPS.FP_ADD:
      case MIPS.FP_SUB:
      case MIPS.FP_MUL:
      case MIPS.FP_DIV:
      case MIPS.FP_SQRT:
        return this.floatingArithmetic(si)

      case MIPS.FP_CMP: {
        const width = inst.fmt
        const a = this.readFp(inst.rd, width)
        const b = this.readFp(inst.rt, width)
        const unordered = width === 8
          ? isNan64(a) || isNan64(b)
          : isNan32(Number(a)) || isNan32(Number(b))
        const x = this.asNumber(a, width)
        const y = this.asNumber(b, width)
        return this.setCondition(
          inst.cc,
          comparisonHolds(inst.predicate, !unordered && x < y, !unordered && x === y, unordered),
        )
      }

      case MIPS.FP_CVT:
      case MIPS.FP_ROUND:
        return this.convert(si)

      case MIPS.FP_MADD: {
        // The product is added to the addend and the sum rounded once,
        // which is what makes this worth having rather than a multiply
        // followed by an add. Doing it as two rounded operations would be
        // wrong in the last bit whenever the product is inexact.
        const width = inst.fmt
        if ((this.fcsr & 3) !== 0) {
          throw new UnimplementedInstruction(
            ISA_NAME, si.addr, new Uint8Array([]),
            'multiply-add with a rounding mode other than nearest-even',
          )
        }
        const a = this.readFp(inst.rs, width)
        const b = this.readFp(inst.rt, width)
        let addend = this.readFp(inst.sa, width)
        const signBit = 1n << BigInt(width * 8 - 1)
        if ((inst.predicate & 1) !== 0) addend ^= signBit
        const format = width === 8 ? F64 : F32
        const exact = fusedMulAdd(
          width === 8 ? a : singleToDouble(a),
          width === 8 ? b : singleToDouble(b),
          width === 8 ? addend : singleToDouble(addend),
          format,
        )
        let bits: bigint
        if (exact === null) {
          // A NaN or an infinity, where the exact path does not apply.
          const value = this.asNumber(a, width) * this.asNumber(b, width) +
            this.asNumber(addend, width)
          bits = this.fromNumber(value, width)
        } else {
          bits = this.fromNumber(exact, width)
        }
        if ((inst.predicate & 2) !== 0) bits ^= signBit
        return this.writeFp(inst.rd, bits, width)
      }

      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, new Uint8Array([]), `coprocessor operation ${inst.op}`,
        )
    }
  }

  private floatingArithmetic(si: MipsStaticInst): void {
    const inst = si.inst
    const width = inst.fmt
    const mode = this.fcsr & 3
    if (mode !== 0) {
      // Only round-to-nearest is available from the host's arithmetic, so
      // any other mode is refused rather than quietly rounded the wrong
      // way. Conversions implement every mode exactly, further down.
      throw new UnimplementedInstruction(
        ISA_NAME, si.addr, new Uint8Array([]),
        `arithmetic with rounding mode ${mode} rather than nearest-even`,
      )
    }
    const aBits = this.readFp(inst.rs, width)
    const bBits = this.readFp(inst.rt, width)
    const a = this.asNumber(aBits, width)
    const b = this.asNumber(bBits, width)
    let result: number
    switch (inst.op) {
      case MIPS.FP_ADD: result = a + b; break
      case MIPS.FP_SUB: result = a - b; break
      case MIPS.FP_MUL: result = a * b; break
      case MIPS.FP_DIV: result = a / b; break
      default: result = Math.sqrt(a); break
    }
    // The exceptions are computed from the exact result rather than from
    // the rounded one, which is the only way to tell an operation that
    // was exact from one that merely looks it.
    this.raise(this.exceptionsOf(inst, aBits, bBits, result, width))
    this.writeFp(inst.rd, this.fromNumber(result, width), width)
  }

  /**
   * Which IEEE exceptions an operation raised, in the order the control
   * register numbers them: inexact, underflow, overflow, divide by zero,
   * invalid.
   */
  private exceptionsOf(
    inst: MipsInst,
    aBits: bigint,
    bBits: bigint,
    result: number,
    width: number,
  ): number {
    const format = width === 8 ? F64 : F32
    const wide = (bits: bigint): bigint => width === 8 ? bits : singleToDouble(bits)
    const a = this.asNumber(aBits, width)
    const b = this.asNumber(bBits, width)

    // An operation on a NaN, or one with no answer at all, is invalid.
    const nan = (v: number): boolean => Number.isNaN(v)
    if (inst.op === MIPS.FP_SQRT) {
      if (nan(a)) return INVALID
      if (a < 0) return INVALID
      const status = sqrtStatus(wide(aBits), result)
      return statusBits(status)
    }
    if (inst.op === MIPS.FP_DIV) {
      if (nan(a) || nan(b)) return INVALID
      if (b === 0) return a === 0 ? INVALID : DIVIDE_BY_ZERO
      if (!Number.isFinite(a) && !Number.isFinite(b)) return INVALID
      return statusBits(quotientStatus(wide(aBits), wide(bBits), result, format))
    }
    if (nan(a) || nan(b)) return INVALID
    if (inst.op === MIPS.FP_MUL) {
      if ((a === 0 && !Number.isFinite(b)) || (b === 0 && !Number.isFinite(a))) return INVALID
      return statusBits(statusOf(exactProduct(wide(aBits), wide(bBits)), result, format))
    }
    // Addition and subtraction, where two infinities of opposite sign
    // have no answer.
    if (!Number.isFinite(a) && !Number.isFinite(b) && Number.isNaN(result)) return INVALID
    const negated = inst.op === MIPS.FP_SUB
      ? wide(bBits) ^ (1n << 63n)
      : wide(bBits)
    return statusBits(statusOf(exactSum(wide(aBits), negated), result, format))
  }

  private convert(si: MipsStaticInst): void {
    const inst = si.inst
    const from = inst.fmt
    const to = inst.toFmt

    // From an integer format, where the source is a bit pattern read as a
    // two's-complement number rather than as a float.
    if (from === 1 || from === 2) {
      const raw = this.readFp(inst.rs, from === 1 ? 4 : 8)
      const value = Number(BigInt.asIntN(from === 1 ? 32 : 64, raw))
      return this.writeFp(inst.rd, this.fromNumber(value, to), to)
    }

    if (to === 4 || to === 8) {
      // Between the two floating formats.
      const value = this.asNumber(this.readFp(inst.rs, from), from)
      return this.writeFp(inst.rd, this.fromNumber(value, to), to)
    }

    // To an integer. The rounding direction is named by the instruction
    // for the round/trunc/ceil/floor family and taken from the control
    // register for the plain conversion.
    const mode = inst.op === MIPS.FP_ROUND
      ? ROUNDING_FROM_FCSR[inst.predicate]!
      : ROUNDING_FROM_FCSR[this.fcsr & 3]!
    const value = this.asNumber(this.readFp(inst.rs, from), from)
    const rounded = roundToIntegral(value, mode)
    // A value that does not fit produces the largest positive integer
    // rather than saturating towards the value's own sign, which is what
    // this architecture specifies and is easy to get wrong.
    if (!Number.isFinite(rounded) || rounded > 2147483647 || rounded < -2147483648) {
      return this.writeFp(inst.rd, 0x7fffffffn, 4)
    }
    return this.writeFp(inst.rd, BigInt.asUintN(32, BigInt(rounded)), 4)
  }
}

/** The exception bits, in the order the control register numbers them. */
const INEXACT = 1
const UNDERFLOW = 2
const OVERFLOW = 4
const DIVIDE_BY_ZERO = 8
const INVALID = 16

function statusBits(status: RoundingStatus): number {
  return (status.inexact ? INEXACT : 0) |
    (status.underflow ? UNDERFLOW : 0) |
    (status.overflow ? OVERFLOW : 0)
}

/** What coprocessor control register zero reports: a 32-bit FPU, revision 0. */
const FPU_IMPLEMENTATION = 0x00000900

/**
 * Widens a single-precision pattern to a double one.
 *
 * The exact multiply-add works in the double encoding whatever the
 * operands' own format is, because its job is to hold the product before
 * anything has been rounded; the single case is widened on the way in and
 * narrowed on the way out, both of which are exact.
 */
function singleToDouble(bits: bigint): bigint {
  return f64ToBits(bitsToF32(Number(bits)))
}

/** set_thread_area, which o32 numbers among its own calls. */
const SET_THREAD_AREA = 4283

/** The calls with more than four arguments, which is only the one. */
const STACK_ARGUMENTS = new Set<number>([Sys.MMAP])

/**
 * The floating-point condition bits are not contiguous.
 *
 * The first one is bit 23 of the control register and the other seven
 * start at bit 25, because the first was there before the others were
 * added and the bit next to it was already taken. Every read and write of
 * one goes through here so that is stated once.
 */
function conditionBit(index: number): number {
  return index === 0 ? 23 : 24 + index
}

/**
 * Turns a comparison into the predicate the encoding asked for.
 *
 * The four low bits of the function number are not a code for one of
 * sixteen comparisons; they are three independent questions and a flag.
 * Bit 2 asks whether less-than counts, bit 1 whether equal counts, bit 0
 * whether unordered counts, and bit 3 selects the signalling form, which
 * differs only in which exception an unordered comparison raises.
 */
function comparisonHolds(
  predicate: number,
  less: boolean,
  equal: boolean,
  unordered: boolean,
): boolean {
  return (unordered && (predicate & 1) !== 0) ||
    (equal && (predicate & 2) !== 0) ||
    (less && (predicate & 4) !== 0)
}

/**
 * MIPS numbers its rounding modes differently from the shared layer.
 *
 * Both lists start with round-to-nearest and both contain the same four
 * directions, but they disagree about which of the two directed modes
 * comes third -- so translating by name rather than by number is the
 * difference between rounding up and rounding down.
 */
const ROUNDING_FROM_FCSR = [
  RoundMode.RNE, RoundMode.RTZ, RoundMode.RUP, RoundMode.RDN,
]
