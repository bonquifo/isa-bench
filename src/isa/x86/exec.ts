/**
 * x86-64 interpreter.
 *
 * Three things here are different in kind from the other backends, rather
 * than different in detail.
 *
 * **Almost everything writes the flags.** On RISC-V nothing does; on AArch64
 * the flag-setting forms are a minority with their own encodings. Here the
 * arithmetic, the logic, the shifts and the bit tests all write six flags as
 * a side effect, and the next instruction is usually a branch that reads
 * them. Computing them approximately would be worse than not computing them
 * at all, so each one is computed from its definition.
 *
 * **Some of those flags are architecturally undefined.** After a divide,
 * after a multiply, and after a shift by anything other than one, the
 * manual says the value of particular flags is not specified. A real
 * processor still puts *something* there, and the reference for this target
 * is a real processor, so a comparison that insisted on every bit would be
 * comparing against unspecified behaviour. The interpreter therefore
 * publishes which bits it does not claim, through `undefinedBits`, and the
 * differential suite ignores exactly those. What is left is everything the
 * architecture actually promises.
 *
 * **A partial register write is not a full one.** Writing a 32-bit result
 * zeroes the upper half of the register; writing an 8- or 16-bit result
 * leaves the rest of it alone. Those are different rules for what looks
 * like the same instruction, and getting them the wrong way round produces
 * a value that is right in its low bits and wrong above them.
 */
import { s64, sext, u64, zext } from '../common/bits64.ts'
import {
  ExecutionBudgetExceeded,
  GuestFault,
  IsaError,
  UnimplementedInstruction,
  UnsupportedSyscall,
} from '../common/errors.ts'
import {
  bitsToF32,
  bitsToF64,
  f32ToBits,
  f64ToBits,
  isNan64,
} from '../common/fp.ts'
import { X86_SYSCALL_NUMBERS, type LinuxSyscalls } from '../common/linux.ts'
import type { AccessWidth, GuestMemory } from '../common/memory.ts'
import { RunState, type ArchState, type Interpreter, type RetireChunk } from '../common/trace.ts'
import { Cond, File, ISA_NAME, NO_REG, X86, type MemOperand, type X86Inst } from './decode.ts'
import type { X86Image, X86StaticInst } from './image.ts'
import {
  INDEFINITE,
  X87Stack,
  add87,
  compare87,
  decode80,
  div87,
  encode80,
  fromIeee,
  fromInteger,
  makeFinite,
  mul87,
  negate,
  toIeee,
  toInteger,
  type X87Value,
} from './x87.ts'

const DEFAULT_BUDGET = 2_000_000_000
const MASK128 = (1n << 128n) - 1n
const maskOf = (bytes: number): bigint => (1n << BigInt(bytes * 8)) - 1n

/** Bit positions in RFLAGS, for the flags a program can act on. */
export const Flag = {
  CF: 0x001n,
  PF: 0x004n,
  AF: 0x010n,
  ZF: 0x040n,
  SF: 0x080n,
  OF: 0x800n,
} as const

const ALL_FLAGS = Flag.CF | Flag.PF | Flag.AF | Flag.ZF | Flag.SF | Flag.OF

/** Register numbers whose names read better than their indices. */
const RAX = 0
const RCX = 1
const RDX = 2
const RSP = 4
const RSI = 6
const RDI = 7
const R11 = 11

export interface X86Options {
  initialRegisters?: readonly bigint[]
  instructionBudget?: number
  syscalls?: LinuxSyscalls
}

export class X86Interpreter implements Interpreter {
  readonly image: X86Image
  private readonly memory: GuestMemory
  private readonly r = new BigInt64Array(16)
  private readonly xmm: bigint[] = Array.from({ length: 16 }, () => 0n)
  private flags = 0n
  /**
   * Flags whose value this interpreter does not claim, because the
   * architecture does not define them after whatever last touched them.
   *
   * This is sticky, and has to be. An instruction that leaves a flag
   * undefined puts an unknown value there; the next instruction that
   * merely *preserves* that flag passes the unknown value on, so the flag
   * is still unknown. Clearing the set on every instruction would claim
   * the value back a step later without anything having produced it.
   * Nothing here is ever a licence to be wrong about a flag that is
   * defined: `defines` is what clears a bit, and only an instruction that
   * computes the flag calls it.
   */
  private unspecified = 0n
  /** Thread pointer. Set through arch_prctl and read through the fs prefix. */
  private fsBase = 0n
  /** The floating-point stack, which only a libc's printf reaches. */
  private readonly x87 = new X87Stack()
  private rip: bigint
  private next = 0n
  private exited = false
  private access = 0n
  private accessWidth = 0
  private taken = 0
  /** The whole range a repeated string instruction read and wrote. */
  private bulkRead = { addr: 0n, bytes: 0 }
  private bulkWrite = { addr: 0n, bytes: 0 }
  private readonly budget: number
  private readonly linux: LinuxSyscalls | undefined
  exitCode = 0
  retired = 0

  constructor(image: X86Image, memory: GuestMemory, options: X86Options = {}) {
    this.image = image
    this.memory = memory
    this.rip = image.entry
    this.budget = options.instructionBudget ?? DEFAULT_BUDGET
    this.linux = options.syscalls
    const initial = options.initialRegisters
    if (initial) {
      for (let i = 0; i < 16 && i < initial.length; i++) this.r[i] = initial[i]!
      if (initial.length > 16) this.flags = BigInt.asUintN(32, initial[16]!) & ALL_FLAGS
    }
  }

  setGpr(index: number, value: bigint): void {
    if (index < 16) this.r[index] = value
    else if (index === 16) this.flags = BigInt.asUintN(32, value) & ALL_FLAGS
  }

  gpr(index: number): bigint {
    if (index < 16) return this.r[index]!
    if (index === 16) return this.flags
    return 0n
  }

  /**
   * Bits of a register the architecture leaves unspecified right now.
   *
   * Only the flags register has any, and only because several instructions
   * are defined to leave particular flags undefined rather than unchanged.
   */
  undefinedBits(index: number): bigint {
    return index === 16 ? this.unspecified : 0n
  }

  fpr(index: number): bigint {
    return this.xmm[index]!
  }

  get programCounter(): bigint {
    return this.rip
  }

  finalState(): ArchState {
    return {
      gpr: Array.from(this.r),
      fpr: [...this.xmm],
      status: { rflags: this.flags, fsBase: this.fsBase },
      pc: this.rip,
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
      const si = this.image.at(this.rip)
      const rip = this.rip
      this.access = 0n
      this.accessWidth = 0
      this.taken = 0
      this.bulkRead.bytes = 0
      this.bulkWrite.bytes = 0
      this.next = rip + BigInt(si.inst.length)
      this.execute(si)
      into.pc[n] = rip
      into.nextPc[n] = this.next
      into.effAddr[n] = this.access
      into.accessWidth[n] = this.accessWidth
      into.taken[n] = this.taken
      into.bulkReadAddr[n] = this.bulkRead.addr
      into.bulkReadBytes[n] = this.bulkRead.bytes
      into.bulkWriteAddr[n] = this.bulkWrite.addr
      into.bulkWriteBytes[n] = this.bulkWrite.bytes
      this.rip = this.next
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
  // Registers. A write narrower than the register is not a write to the
  // register: which of the other bits survive depends on how narrow.
  // -------------------------------------------------------------------------

  private readReg(index: number, size: number, high: boolean): bigint {
    const full = u64(this.r[index]!)
    if (high) return (full >> 8n) & 0xffn
    return size === 8 ? full : full & maskOf(size)
  }

  private writeReg(index: number, size: number, high: boolean, value: bigint): void {
    const full = u64(this.r[index]!)
    let next: bigint
    if (high) {
      next = (full & ~0xff00n) | ((value & 0xffn) << 8n)
    } else if (size === 8) {
      next = u64(value)
    } else if (size === 4) {
      // The one case that does not preserve: a 32-bit result clears the
      // upper half rather than leaving it.
      next = value & 0xffffffffn
    } else {
      const mask = maskOf(size)
      next = (full & ~mask) | (value & mask)
    }
    this.r[index] = s64(next)
  }

  private effectiveAddress(mem: MemOperand): bigint {
    let address = mem.disp
    if (mem.base !== NO_REG) address += u64(this.r[mem.base]!)
    if (mem.index !== NO_REG) address += u64(this.r[mem.index]!) * BigInt(mem.scale)
    if (mem.fsRelative) address += this.fsBase
    return u64(address)
  }

  /** The r/m operand, whichever of the two things it is. */
  private readRm(inst: X86Inst): bigint {
    if (inst.mem === null) {
      return inst.rmFile === File.XMM
        ? this.xmm[inst.rm]! & maskOf(inst.size)
        : this.readReg(inst.rm, inst.size, inst.rmHigh)
    }
    const at = this.effectiveAddress(inst.mem)
    this.access = at
    this.accessWidth = inst.size
    return this.loadWide(at, inst.size)
  }

  private writeRm(inst: X86Inst, value: bigint): void {
    if (inst.mem === null) {
      if (inst.rmFile === File.XMM) {
        this.xmm[inst.rm] = value & MASK128
      } else {
        this.writeReg(inst.rm, inst.size, inst.rmHigh, value)
      }
      return
    }
    const at = this.effectiveAddress(inst.mem)
    this.access = at
    this.accessWidth = inst.size
    this.storeWide(at, inst.size, value)
  }

  private readRegOperand(inst: X86Inst): bigint {
    return inst.regFile === File.XMM
      ? this.xmm[inst.reg]!
      : this.readReg(inst.reg, inst.size, inst.regHigh)
  }

  private writeRegOperand(inst: X86Inst, value: bigint): void {
    if (inst.regFile === File.XMM) this.xmm[inst.reg] = value & MASK128
    else this.writeReg(inst.reg, inst.size, inst.regHigh, value)
  }

  /** Loads a value of any operand size, including the 128-bit vector one. */
  private loadWide(at: bigint, size: number): bigint {
    if (size === 16) {
      const low = this.memory.load(at, 8, false)
      const high = this.memory.load(u64(at + 8n), 8, false)
      return (u64(high) << 64n) | u64(low)
    }
    return this.memory.load(at, size as AccessWidth, false)
  }

  private storeWide(at: bigint, size: number, value: bigint): void {
    if (size === 16) {
      this.memory.store(at, 8, value & 0xffffffffffffffffn)
      this.memory.store(u64(at + 8n), 8, (value >> 64n) & 0xffffffffffffffffn)
      return
    }
    this.memory.store(at, size as AccessWidth, value & maskOf(size))
  }

  // -------------------------------------------------------------------------
  // Flags.
  // -------------------------------------------------------------------------

  private setFlag(flag: bigint, on: boolean): void {
    this.flags = on ? this.flags | flag : this.flags & ~flag
  }

  /** These flags now hold a value the architecture specifies. */
  private defines(flags: bigint): void {
    this.unspecified &= ~flags
  }

  /** These flags now hold whatever the implementation felt like. */
  private undefines(flags: bigint): void {
    this.unspecified |= flags
  }

  private flagSet(flag: bigint): boolean {
    return (this.flags & flag) !== 0n
  }

  /** Parity of the low byte, which is what PF has always meant. */
  private writeLogicFlags(result: bigint, size: number): void {
    this.setFlag(Flag.CF, false)
    this.setFlag(Flag.OF, false)
    this.writeResultFlags(result, size)
    // The manual leaves the adjust flag undefined for the logical ones.
    this.defines(Flag.CF | Flag.OF)
    this.undefines(Flag.AF)
  }

  private writeResultFlags(result: bigint, size: number): void {
    const masked = result & maskOf(size)
    this.setFlag(Flag.ZF, masked === 0n)
    this.setFlag(Flag.SF, (masked >> BigInt(size * 8 - 1)) === 1n)
    let parity = Number(masked & 0xffn)
    parity ^= parity >> 4
    parity ^= parity >> 2
    parity ^= parity >> 1
    this.setFlag(Flag.PF, (parity & 1) === 0)
  }

  /**
   * Addition, with the carry in, computing every flag from its definition.
   *
   * The overflow flag is not the carry flag: one is about the unsigned
   * interpretation and the other about the signed one, and an addition can
   * set either, both or neither.
   */
  private add(a: bigint, b: bigint, carryIn: bigint, size: number): bigint {
    const bits = BigInt(size * 8)
    const mask = maskOf(size)
    const sum = (a & mask) + (b & mask) + carryIn
    const result = sum & mask
    const sign = 1n << (bits - 1n)
    this.setFlag(Flag.CF, (sum >> bits) !== 0n)
    this.setFlag(Flag.AF, (((a & 0xfn) + (b & 0xfn) + carryIn) & 0x10n) !== 0n)
    const sameSign = ((a ^ b) & sign) === 0n
    this.setFlag(Flag.OF, sameSign && ((a ^ result) & sign) !== 0n)
    this.writeResultFlags(result, size)
    this.defines(ALL_FLAGS)
    return result
  }

  private subtract(a: bigint, b: bigint, borrowIn: bigint, size: number): bigint {
    const bits = BigInt(size * 8)
    const mask = maskOf(size)
    const left = a & mask
    const right = b & mask
    const result = (left - right - borrowIn) & mask
    const sign = 1n << (bits - 1n)
    this.setFlag(Flag.CF, left < right + borrowIn)
    this.setFlag(Flag.AF, (left & 0xfn) < (right & 0xfn) + borrowIn)
    const differentSign = ((left ^ right) & sign) !== 0n
    this.setFlag(Flag.OF, differentSign && ((left ^ result) & sign) !== 0n)
    this.writeResultFlags(result, size)
    this.defines(ALL_FLAGS)
    return result
  }

  private conditionHolds(cond: number): boolean {
    const cf = this.flagSet(Flag.CF)
    const zf = this.flagSet(Flag.ZF)
    const sf = this.flagSet(Flag.SF)
    const of = this.flagSet(Flag.OF)
    const pf = this.flagSet(Flag.PF)
    switch (cond) {
      case Cond.O: return of
      case Cond.NO: return !of
      case Cond.B: return cf
      case Cond.AE: return !cf
      case Cond.E: return zf
      case Cond.NE: return !zf
      case Cond.BE: return cf || zf
      case Cond.A: return !cf && !zf
      case Cond.S: return sf
      case Cond.NS: return !sf
      case Cond.P: return pf
      case Cond.NP: return !pf
      case Cond.L: return sf !== of
      case Cond.GE: return sf === of
      case Cond.LE: return zf || sf !== of
      default: return !zf && sf === of
    }
  }

  // -------------------------------------------------------------------------
  // The stack.
  // -------------------------------------------------------------------------

  private push(value: bigint, size: number): void {
    const at = u64(u64(this.r[RSP]!) - BigInt(size))
    this.r[RSP] = s64(at)
    this.access = at
    this.accessWidth = size
    this.memory.store(at, size as AccessWidth, value & maskOf(size))
  }

  private pop(size: number): bigint {
    const at = u64(this.r[RSP]!)
    this.access = at
    this.accessWidth = size
    const value = this.memory.load(at, size as AccessWidth, false)
    this.r[RSP] = s64(u64(at + BigInt(size)))
    return value
  }

  // -------------------------------------------------------------------------
  // Execution.
  // -------------------------------------------------------------------------

  private execute(si: X86StaticInst): void {
    const inst = si.inst
    const size = inst.size

    switch (inst.op) {
      case X86.NOP:
        return

      case X86.MOV: {
        if (inst.accumulatorForm) return this.writeReg(RAX, size, false, inst.imm)
        const value = inst.hasImm
          ? inst.imm
          : inst.regIsDestination ? this.readRm(inst) : this.readRegOperand(inst)
        if (inst.regIsDestination) return this.writeRegOperand(inst, value)
        return this.writeRm(inst, value)
      }

      case X86.MOVZX:
        return this.writeRegOperand(inst, this.readNarrow(inst, false))
      case X86.MOVSX:
        return this.writeRegOperand(inst, this.readNarrow(inst, true))

      case X86.LEA:
        // The one instruction that computes an address without touching
        // memory, which is why a compiler uses it for arithmetic.
        return this.writeRegOperand(inst, zext(this.effectiveAddress(inst.mem!), size * 8))

      case X86.ADD:
      case X86.OR:
      case X86.ADC:
      case X86.SBB:
      case X86.AND:
      case X86.SUB:
      case X86.XOR:
      case X86.CMP:
      case X86.TEST:
        return this.arithmetic(inst)

      case X86.NOT: {
        // The one arithmetic instruction that writes no flags at all.
        const value = this.readRm(inst)
        return this.writeRm(inst, ~value & maskOf(size))
      }

      case X86.NEG: {
        const value = this.readRm(inst)
        const result = this.subtract(0n, value, 0n, size)
        // Unlike a subtract from zero, neg defines CF as "the operand was
        // not zero" -- which is the same thing, said differently.
        this.setFlag(Flag.CF, (value & maskOf(size)) !== 0n)
        return this.writeRm(inst, result)
      }

      case X86.INC:
      case X86.DEC: {
        // Increment and decrement leave the carry flag alone, which is what
        // makes them usable inside a multi-word addition.
        const carry = this.flagSet(Flag.CF)
        const value = this.readRm(inst)
        const result = inst.op === X86.INC
          ? this.add(value, 1n, 0n, size)
          : this.subtract(value, 1n, 0n, size)
        this.setFlag(Flag.CF, carry)
        return this.writeRm(inst, result)
      }

      case X86.XCHG: {
        const left = this.readRm(inst)
        const right = this.readRegOperand(inst)
        this.writeRm(inst, right)
        return this.writeRegOperand(inst, left)
      }

      case X86.ROL:
      case X86.ROR:
      case X86.RCL:
      case X86.RCR:
      case X86.SHL:
      case X86.SHR:
      case X86.SAR:
        return this.shift(inst)

      case X86.SHLD:
      case X86.SHRD:
        return this.doubleShift(inst)

      case X86.IMUL1:
      case X86.MUL:
        return this.widenMultiply(inst)
      case X86.IMUL2:
        return this.multiply(inst)
      case X86.DIV:
      case X86.IDIV:
        return this.divide(inst)

      case X86.CWDE: {
        // Sign-extends the accumulator in place: al to ax, ax to eax, eax
        // to rax, chosen by the operand size.
        const from = size === 8 ? 4 : size === 4 ? 2 : 1
        const value = sext(this.readReg(RAX, from, false), from * 8)
        return this.writeReg(RAX, size, false, value)
      }

      case X86.LAHF: {
        // sf zf 0 af 0 pf 1 cf, which is the low byte of the flag word with
        // bit 1 forced set, moved into ah.
        const low = (this.flags & 0xd5n) | 0x02n
        return this.writeReg(RAX, 1, true, low)
      }

      case X86.CDQ: {
        // Sign-extends the accumulator into rDX, which is what a signed
        // divide needs as its high half.
        const value = this.readReg(RAX, size, false)
        const negative = (value >> BigInt(size * 8 - 1)) === 1n
        return this.writeReg(RDX, size, false, negative ? maskOf(size) : 0n)
      }

      case X86.JCC:
        if (this.conditionHolds(inst.cond)) {
          this.next = inst.target
          this.taken = 1
        }
        return

      case X86.SETCC:
        return this.writeRm(inst, this.conditionHolds(inst.cond) ? 1n : 0n)

      case X86.CMOVCC:
        // A conditional move always reads its source, and writes the
        // destination either way: the 32-bit form zeroes the upper half
        // even when the condition fails.
        return this.writeRegOperand(
          inst,
          this.conditionHolds(inst.cond) ? this.readRm(inst) : this.readRegOperand(inst),
        )

      case X86.JMP:
        this.next = inst.target
        this.taken = 1
        return

      case X86.JMP_INDIRECT:
        this.next = u64(this.readRm(inst))
        this.taken = 1
        return

      case X86.CALL:
        this.push(this.next, 8)
        this.next = inst.target
        this.taken = 1
        return

      case X86.CALL_INDIRECT: {
        const target = u64(this.readRm(inst))
        this.push(this.next, 8)
        this.next = target
        this.taken = 1
        return
      }

      case X86.RET:
        this.next = u64(this.pop(8))
        this.taken = 1
        return

      case X86.PUSH: {
        const value = inst.hasImm
          ? u64(inst.imm)
          : inst.reg !== NO_REG ? u64(this.r[inst.reg]!) : this.readRm(inst)
        return this.push(value, 8)
      }

      case X86.POP: {
        const value = this.pop(8)
        if (inst.reg !== NO_REG) {
          this.r[inst.reg] = s64(value)
          return
        }
        return this.writeRm(inst, value)
      }

      case X86.LEAVE: {
        // Unwinds a frame: the stack pointer to the frame pointer, then the
        // caller's frame pointer off the stack.
        this.r[RSP] = this.r[5]!
        this.r[5] = s64(this.pop(8))
        return
      }

      case X86.BT:
      case X86.BTS:
      case X86.BTR:
      case X86.BTC:
        return this.bitTest(inst)

      case X86.BSF:
      case X86.BSR:
      case X86.TZCNT:
      case X86.LZCNT:
      case X86.POPCNT:
        return this.bitScan(inst)

      case X86.BSWAP: {
        const value = this.readReg(inst.rm, size, false)
        let swapped = 0n
        for (let i = 0; i < size; i++) {
          swapped = (swapped << 8n) | ((value >> BigInt(i * 8)) & 0xffn)
        }
        return this.writeReg(inst.rm, size, false, swapped)
      }

      case X86.CMPXCHG: {
        // Compares against the accumulator and swaps only on equality,
        // which is what makes it the primitive a lock is built from.
        const current = this.readRm(inst)
        const expected = this.readReg(RAX, size, false)
        this.subtract(expected, current, 0n, size)
        if ((expected & maskOf(size)) === (current & maskOf(size))) {
          this.writeRm(inst, this.readRegOperand(inst))
        } else {
          this.writeReg(RAX, size, false, current)
        }
        return
      }

      case X86.XADD: {
        const left = this.readRm(inst)
        const right = this.readRegOperand(inst)
        const sum = this.add(left, right, 0n, size)
        this.writeRegOperand(inst, left)
        return this.writeRm(inst, sum)
      }

      case X86.MOVS:
      case X86.STOS:
        return this.stringOperation(inst)

      case X86.X87_LOAD:
      case X86.X87_STORE:
      case X86.X87_ARITH:
      case X86.X87_COMPARE:
      case X86.X87_CONST:
      case X86.X87_UNARY:
      case X86.X87_XCH:
      case X86.X87_LDCW:
      case X86.X87_STCW:
      case X86.X87_FREE:
        return this.executeX87(si)

      case X86.SYSCALL:
        return this.syscall(si)

      case X86.INT3:
        throw new IsaError(`${ISA_NAME}: int3 at 0x${si.addr.toString(16)}`)
      case X86.UD2:
        throw new IsaError(`${ISA_NAME}: ud2 at 0x${si.addr.toString(16)}`)

      default:
        return this.executeVector(si)
    }
  }

  /** The source of a widening move, read at its own size. */
  private readNarrow(inst: X86Inst, signed: boolean): bigint {
    const from = inst.sourceSize
    if (inst.mem === null) {
      const raw = inst.rmFile === File.XMM
        ? this.xmm[inst.rm]! & maskOf(from)
        : this.readReg(inst.rm, from, inst.rmHigh)
      return signed ? zext(sext(raw, from * 8), inst.size * 8) : raw
    }
    const at = this.effectiveAddress(inst.mem)
    this.access = at
    this.accessWidth = from
    const raw = this.memory.load(at, from as AccessWidth, false)
    return signed ? zext(sext(raw, from * 8), inst.size * 8) : raw
  }

  private arithmetic(inst: X86Inst): void {
    const size = inst.size
    // Which operand is which depends on the direction bit, and for the
    // accumulator forms there is no encoded register at all.
    let left: bigint
    let right: bigint
    if (inst.accumulatorForm) {
      left = this.readReg(RAX, size, false)
      right = inst.imm
    } else if (inst.hasImm) {
      left = this.readRm(inst)
      right = inst.imm
    } else if (inst.regIsDestination) {
      left = this.readRegOperand(inst)
      right = this.readRm(inst)
    } else {
      left = this.readRm(inst)
      right = this.readRegOperand(inst)
    }

    let result: bigint
    switch (inst.op) {
      case X86.ADD: result = this.add(left, right, 0n, size); break
      case X86.ADC: result = this.add(left, right, this.flagSet(Flag.CF) ? 1n : 0n, size); break
      case X86.SUB:
      case X86.CMP: result = this.subtract(left, right, 0n, size); break
      case X86.SBB:
        result = this.subtract(left, right, this.flagSet(Flag.CF) ? 1n : 0n, size)
        break
      case X86.AND:
      case X86.TEST:
        result = (left & right) & maskOf(size)
        this.writeLogicFlags(result, size)
        break
      case X86.OR:
        result = (left | right) & maskOf(size)
        this.writeLogicFlags(result, size)
        break
      default:
        result = (left ^ right) & maskOf(size)
        this.writeLogicFlags(result, size)
        break
    }

    // Compare and test compute a result only to set the flags by it.
    if (inst.op === X86.CMP || inst.op === X86.TEST) return
    if (inst.accumulatorForm) return this.writeReg(RAX, size, false, result)
    if (inst.regIsDestination && !inst.hasImm) return this.writeRegOperand(inst, result)
    return this.writeRm(inst, result)
  }

  private shift(inst: X86Inst): void {
    const size = inst.size
    const bits = size * 8
    // The count is taken modulo the register width, and modulo 64 rather
    // than 32 only for the 64-bit forms.
    const raw = inst.shiftByCl ? this.readReg(RCX, 1, false) : inst.imm
    const count = Number(raw & (size === 8 ? 0x3fn : 0x1fn))
    const value = this.readRm(inst) & maskOf(size)
    if (count === 0) return

    const mask = maskOf(size)
    const sign = 1n << BigInt(bits - 1)
    let result: bigint
    let carry: boolean
    switch (inst.op) {
      case X86.SHL: {
        const wide = value << BigInt(count)
        result = wide & mask
        carry = ((wide >> BigInt(bits)) & 1n) === 1n
        this.setFlag(Flag.OF, (((result & sign) !== 0n) !== carry))
        break
      }
      case X86.SHR: {
        result = value >> BigInt(count)
        carry = ((value >> BigInt(count - 1)) & 1n) === 1n
        this.setFlag(Flag.OF, (value & sign) !== 0n)
        break
      }
      case X86.SAR: {
        const signed = sext(value, bits)
        result = zext(signed >> BigInt(count), bits)
        carry = ((signed >> BigInt(count - 1)) & 1n) === 1n
        this.setFlag(Flag.OF, false)
        break
      }
      case X86.ROL: {
        const n = BigInt(count % bits)
        result = ((value << n) | (value >> BigInt(bits - Number(n)))) & mask
        carry = (result & 1n) === 1n
        this.setFlag(Flag.OF, (((result & sign) !== 0n) !== carry))
        break
      }
      case X86.ROR: {
        const n = BigInt(count % bits)
        result = ((value >> n) | (value << BigInt(bits - Number(n)))) & mask
        carry = (result & sign) !== 0n
        const second = (result >> BigInt(bits - 2)) & 1n
        this.setFlag(Flag.OF, carry !== (second === 1n))
        break
      }
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, 0n, inst.bytes, 'rotate through carry',
        )
    }
    this.setFlag(Flag.CF, carry)
    if (inst.op === X86.ROL || inst.op === X86.ROR) {
      // A rotate writes the carry and the overflow flag and leaves the
      // other four exactly as they were -- including, if they were
      // undefined, still undefined.
      this.defines(Flag.CF)
      if (count === 1) this.defines(Flag.OF)
      else this.undefines(Flag.OF)
    } else {
      this.writeResultFlags(result, size)
      this.defines(Flag.CF | Flag.SF | Flag.ZF | Flag.PF)
      // The overflow flag is defined only for a count of one, and the
      // adjust flag never is.
      if (count === 1) this.defines(Flag.OF)
      else this.undefines(Flag.OF)
      this.undefines(Flag.AF)
    }
    this.writeRm(inst, result)
  }

  private doubleShift(inst: X86Inst): void {
    const size = inst.size
    const bits = size * 8
    const raw = inst.shiftByCl ? this.readReg(RCX, 1, false) : inst.imm
    const count = Number(raw & (size === 8 ? 0x3fn : 0x1fn))
    if (count === 0) return
    const destination = this.readRm(inst) & maskOf(size)
    const source = this.readRegOperand(inst) & maskOf(size)
    const mask = maskOf(size)
    let result: bigint
    let carry: boolean
    if (inst.op === X86.SHLD) {
      result = ((destination << BigInt(count)) |
        (source >> BigInt(bits - count))) & mask
      carry = ((destination >> BigInt(bits - count)) & 1n) === 1n
    } else {
      result = ((destination >> BigInt(count)) |
        (source << BigInt(bits - count))) & mask
      carry = ((destination >> BigInt(count - 1)) & 1n) === 1n
    }
    this.setFlag(Flag.CF, carry)
    this.writeResultFlags(result, size)
    this.defines(Flag.CF | Flag.SF | Flag.ZF | Flag.PF)
    if (count === 1) {
      // For a count of one the overflow flag means "the sign changed",
      // which is a different definition from the one a single-register
      // shift uses and the only count it is defined for.
      const sign = 1n << BigInt(bits - 1)
      this.setFlag(Flag.OF, ((destination ^ result) & sign) !== 0n)
      this.defines(Flag.OF)
    } else {
      this.undefines(Flag.OF)
    }
    this.undefines(Flag.AF)
    this.writeRm(inst, result)
  }

  /**
   * The widening multiply, whose result is twice as wide as its operands
   * and lands in a fixed register pair rather than where it was asked for.
   */
  private widenMultiply(inst: X86Inst): void {
    const size = inst.size
    const bits = BigInt(size * 8)
    const operand = this.readRm(inst)
    const accumulator = this.readReg(RAX, size, false)
    let product: bigint
    let overflow: boolean
    if (inst.op === X86.MUL) {
      product = (operand & maskOf(size)) * (accumulator & maskOf(size))
      overflow = (product >> bits) !== 0n
    } else {
      product = sext(operand, size * 8) * sext(accumulator, size * 8)
      overflow = sext(product & maskOf(size), size * 8) !== product
    }
    const low = product & maskOf(size)
    const high = (product >> bits) & maskOf(size)
    if (size === 1) {
      // The byte form is the exception: the whole 16-bit product goes to ax
      // rather than being split between ah and al as a pair.
      this.writeReg(RAX, 2, false, product & 0xffffn)
    } else {
      this.writeReg(RAX, size, false, low)
      this.writeReg(RDX, size, false, high)
    }
    this.setFlag(Flag.CF, overflow)
    this.setFlag(Flag.OF, overflow)
    this.defines(Flag.CF | Flag.OF)
    // Everything else is left unspecified by the architecture.
    this.undefines(Flag.SF | Flag.ZF | Flag.AF | Flag.PF)
  }

  private multiply(inst: X86Inst): void {
    const size = inst.size
    const left = sext(this.readRm(inst), size * 8)
    const right = inst.hasImm ? inst.imm : sext(this.readRegOperand(inst), size * 8)
    const product = left * right
    const truncated = product & maskOf(size)
    const overflow = sext(truncated, size * 8) !== product
    this.setFlag(Flag.CF, overflow)
    this.setFlag(Flag.OF, overflow)
    this.defines(Flag.CF | Flag.OF)
    this.undefines(Flag.SF | Flag.ZF | Flag.AF | Flag.PF)
    this.writeRegOperand(inst, truncated)
  }

  private divide(inst: X86Inst): void {
    const size = inst.size
    const bits = BigInt(size * 8)
    const divisor = this.readRm(inst)
    if ((divisor & maskOf(size)) === 0n) {
      throw new GuestFault('read', 0n, size, `${ISA_NAME}: divide by zero`)
    }
    // The dividend is twice the operand width, assembled from the pair.
    const low = this.readReg(RAX, size, false)
    const high = size === 1 ? this.readReg(RAX, 2, false) >> 8n : this.readReg(RDX, size, false)
    let quotient: bigint
    let remainder: bigint
    if (inst.op === X86.DIV) {
      const dividend = (high << bits) | low
      const d = divisor & maskOf(size)
      quotient = dividend / d
      remainder = dividend % d
      if (quotient > maskOf(size)) {
        throw new GuestFault('read', 0n, size, `${ISA_NAME}: unsigned divide overflow`)
      }
    } else {
      const dividend = BigInt.asIntN(size * 16, (high << bits) | low)
      const d = sext(divisor, size * 8)
      quotient = dividend / d
      remainder = dividend % d
      const limit = 1n << (bits - 1n)
      if (quotient >= limit || quotient < -limit) {
        throw new GuestFault('read', 0n, size, `${ISA_NAME}: signed divide overflow`)
      }
    }
    if (size === 1) {
      this.writeReg(RAX, 1, false, quotient & 0xffn)
      this.writeReg(RAX, 1, true, remainder & 0xffn)
    } else {
      this.writeReg(RAX, size, false, quotient & maskOf(size))
      this.writeReg(RDX, size, false, remainder & maskOf(size))
    }
    // A divide is defined to leave every flag unspecified.
    this.undefines(ALL_FLAGS)
  }

  private bitTest(inst: X86Inst): void {
    const size = inst.size
    const bits = BigInt(size * 8)
    const offset = inst.hasImm ? inst.imm : sext(this.readRegOperand(inst), size * 8)
    if (inst.mem === null) {
      const index = ((offset % bits) + bits) % bits
      const value = this.readRm(inst)
      this.setFlag(Flag.CF, ((value >> index) & 1n) === 1n)
      if (inst.op !== X86.BT) this.writeRm(inst, this.applyBit(inst.op, value, index))
    } else {
      // With a memory operand the offset is not taken modulo anything: it
      // addresses a bit in a bit string that can be arbitrarily long.
      const base = this.effectiveAddress(inst.mem)
      const byteOffset = offset >> 3n
      const at = u64(base + byteOffset)
      this.access = at
      this.accessWidth = 1
      const index = ((offset % 8n) + 8n) % 8n
      const value = this.memory.load(at, 1, false)
      this.setFlag(Flag.CF, ((value >> index) & 1n) === 1n)
      if (inst.op !== X86.BT) {
        this.memory.store(at, 1, this.applyBit(inst.op, value, index) & 0xffn)
      }
    }
    // The zero flag is untouched, so whatever it was it still is.
    this.defines(Flag.CF)
    this.undefines(Flag.OF | Flag.SF | Flag.AF | Flag.PF)
  }

  private applyBit(op: number, value: bigint, index: bigint): bigint {
    if (op === X86.BTS) return value | (1n << index)
    if (op === X86.BTR) return value & ~(1n << index)
    return value ^ (1n << index)
  }

  private bitScan(inst: X86Inst): void {
    const size = inst.size
    const bits = size * 8
    const value = this.readRm(inst) & maskOf(size)

    if (inst.op === X86.POPCNT) {
      let count = 0n
      for (let i = 0; i < bits; i++) if (((value >> BigInt(i)) & 1n) === 1n) count += 1n
      this.setFlag(Flag.ZF, value === 0n)
      this.setFlag(Flag.CF, false)
      this.setFlag(Flag.OF, false)
      this.setFlag(Flag.SF, false)
      this.setFlag(Flag.PF, false)
      this.defines(Flag.CF | Flag.OF | Flag.SF | Flag.ZF | Flag.PF)
      this.undefines(Flag.AF)
      return this.writeRegOperand(inst, count)
    }

    const trailing = (): number => {
      for (let i = 0; i < bits; i++) if (((value >> BigInt(i)) & 1n) === 1n) return i
      return bits
    }
    const leading = (): number => {
      for (let i = bits - 1; i >= 0; i--) if (((value >> BigInt(i)) & 1n) === 1n) return i
      return bits
    }

    if (inst.op === X86.TZCNT || inst.op === X86.LZCNT) {
      const count = inst.op === X86.TZCNT ? trailing() : bits - 1 - leading()
      this.setFlag(Flag.CF, value === 0n)
      this.setFlag(Flag.ZF, count === 0)
      this.defines(Flag.CF | Flag.ZF)
      this.undefines(Flag.OF | Flag.SF | Flag.AF | Flag.PF)
      return this.writeRegOperand(inst, BigInt(count))
    }

    // bsf and bsr leave the destination untouched when the source is zero,
    // which is the whole reason tzcnt was added later.
    this.setFlag(Flag.ZF, value === 0n)
    this.defines(Flag.ZF)
    this.undefines(Flag.CF | Flag.OF | Flag.SF | Flag.AF | Flag.PF)
    if (value === 0n) return
    const index = inst.op === X86.BSF ? trailing() : leading()
    return this.writeRegOperand(inst, BigInt(index))
  }

  /**
   * The string operations, with the repeat prefix applied here rather than
   * by re-executing the instruction.
   *
   * A repeated move is one instruction that retires once, so modelling it
   * as a loop inside the interpreter is what keeps the retired trace and
   * the reference's instruction count agreeing.
   */
  private stringOperation(inst: X86Inst): void {
    const size = inst.size
    const step = BigInt(size)
    let count = inst.rep === 0 ? 1n : u64(this.r[RCX]!)
    if (inst.rep !== 0 && count === 0n) return
    let source = u64(this.r[RSI]!)
    let destination = u64(this.r[RDI]!)
    // One instruction that may move thousands of bytes. The whole of what
    // it read and wrote is reported as a range rather than as its first
    // element, or a timing model would see a `rep movsq` of a page as one
    // eight-byte store. The ranges count upwards because nothing can set
    // the direction flag: `std` is not an instruction the decoder accepts.
    const total = Number(count) * size
    if (inst.op === X86.MOVS) this.bulkRead = { addr: source, bytes: total }
    this.bulkWrite = { addr: destination, bytes: total }
    while (count > 0n) {
      if (inst.op === X86.MOVS) {
        const value = this.memory.load(source, size as AccessWidth, false)
        this.memory.store(destination, size as AccessWidth, value)
        source = u64(source + step)
      } else {
        this.memory.store(destination, size as AccessWidth, this.readReg(RAX, size, false))
      }
      destination = u64(destination + step)
      count -= 1n
    }
    this.r[RSI] = s64(source)
    this.r[RDI] = s64(destination)
    if (inst.rep !== 0) this.r[RCX] = 0n
  }

  private syscall(si: X86StaticInst): void {
    if (!this.linux) {
      throw new UnsupportedSyscall(ISA_NAME, Number(u64(this.r[RAX]!)), 'no syscall layer')
    }
    const number = Number(u64(this.r[RAX]!))

    // Thread-local storage is the one call that is genuinely x86-specific:
    // it sets the base the fs prefix adds, which no other target has.
    if (number === ARCH_PRCTL) {
      const code = Number(u64(this.r[RDI]!))
      if (code !== ARCH_SET_FS) {
        throw new UnsupportedSyscall(ISA_NAME, number, `arch_prctl code 0x${code.toString(16)}`)
      }
      this.fsBase = u64(this.r[RSI]!)
      this.afterSyscall(si, 0n)
      return
    }

    const generic = X86_SYSCALL_NUMBERS[number]
    if (generic === undefined) {
      throw new UnsupportedSyscall(ISA_NAME, number, 'not in the x86-64 syscall table')
    }
    const args = [
      u64(this.r[RDI]!), u64(this.r[RSI]!), u64(this.r[RDX]!),
      u64(this.r[10]!), u64(this.r[8]!), u64(this.r[9]!),
    ]
    const result = this.linux.dispatch(ISA_NAME, generic, args)
    if (result.exited) {
      this.exited = true
      this.exitCode = this.linux.exitCode
      return
    }
    this.afterSyscall(si, result.value)
  }

  /**
   * A syscall is not a call: the instruction itself clobbers rcx and r11,
   * because that is where the processor keeps the return address and the
   * flags while it is in the kernel. A program that assumed otherwise would
   * be wrong on real hardware, so an interpreter that preserved them would
   * be the thing that is wrong.
   */
  private afterSyscall(si: X86StaticInst, value: bigint): void {
    this.r[RAX] = s64(value)
    this.r[RCX] = s64(si.addr + BigInt(si.inst.length))
    this.r[R11] = s64(this.flags | 0x202n)
  }

  // -------------------------------------------------------------------------
  // SSE and SSE2.
  // -------------------------------------------------------------------------

  private executeVector(si: X86StaticInst): void {
    const inst = si.inst
    switch (inst.op) {
      case X86.MOV_XMM: {
        // A whole-register move, at whichever width the encoding chose.
        const value = inst.regIsDestination ? this.readRm(inst) : this.readRegOperand(inst)
        if (inst.regIsDestination) return this.writeRegOperand(inst, value)
        return this.writeRm(inst, value)
      }

      case X86.MOV_XMM_SCALAR: {
        // Moving a scalar between registers keeps the rest of the
        // destination; moving one from memory zeroes it.
        const width = inst.sourceSize
        if (inst.regIsDestination) {
          if (inst.mem === null) {
            const value = this.xmm[inst.rm]! & maskOf(width)
            this.xmm[inst.reg] = (this.xmm[inst.reg]! & ~maskOf(width)) | value
            return
          }
          const at = this.effectiveAddress(inst.mem)
          this.access = at
          this.accessWidth = width
          this.xmm[inst.reg] = this.memory.load(at, width as AccessWidth, false)
          return
        }
        const value = this.xmm[inst.reg]! & maskOf(width)
        if (inst.mem === null) {
          this.xmm[inst.rm] = (this.xmm[inst.rm]! & ~maskOf(width)) | value
          return
        }
        const at = this.effectiveAddress(inst.mem)
        this.access = at
        this.accessWidth = width
        this.memory.store(at, width as AccessWidth, value)
        return
      }

      case X86.MOVD: {
        const width = inst.size
        if (inst.regIsDestination) {
          const value = inst.mem === null
            ? this.readReg(inst.rm, width, false)
            : this.readMemory(inst.mem, width)
          this.xmm[inst.reg] = value & maskOf(width)
          return
        }
        const value = this.xmm[inst.reg]! & maskOf(width)
        if (inst.mem === null) return this.writeReg(inst.rm, width, false, value)
        return this.writeMemory(inst.mem, width, value)
      }

      case X86.MOVQ_XMM: {
        if (inst.regIsDestination) {
          const value = inst.mem === null
            ? this.xmm[inst.rm]! & maskOf(8)
            : this.readMemory(inst.mem, 8)
          this.xmm[inst.reg] = value
          return
        }
        const value = this.xmm[inst.reg]! & maskOf(8)
        if (inst.mem === null) {
          this.xmm[inst.rm] = value
          return
        }
        return this.writeMemory(inst.mem, 8, value)
      }

      case X86.MOV_HALF: {
        // The memory forms: one half of the register, the other untouched.
        const shift = inst.cond === 1 ? 64n : 0n
        const mask = maskOf(8) << shift
        if (inst.regIsDestination) {
          const value = this.readMemory(inst.mem!, 8)
          this.xmm[inst.reg] = (this.xmm[inst.reg]! & ~mask & MASK128) | (value << shift)
          return
        }
        return this.writeMemory(inst.mem!, 8, (this.xmm[inst.reg]! >> shift) & maskOf(8))
      }

      case X86.MOV_HALF_REG: {
        // movhlps takes the high half of the source to the low half of the
        // destination; movlhps does the opposite. Neither touches the half
        // it is not writing.
        const toHigh = inst.cond === 1
        const source = toHigh
          ? this.xmm[inst.rm]! & maskOf(8)
          : (this.xmm[inst.rm]! >> 64n) & maskOf(8)
        const kept = toHigh ? this.xmm[inst.reg]! & maskOf(8) : this.xmm[inst.reg]! & ~maskOf(8)
        this.xmm[inst.reg] = toHigh ? kept | (source << 64n) : (kept & MASK128) | source
        return
      }

      case X86.PXOR:
      case X86.PAND:
      case X86.POR:
      case X86.ANDP:
      case X86.ANDNP:
      case X86.ORP:
      case X86.XORP: {
        const a = this.xmm[inst.reg]!
        const b = this.readRm(inst)
        let result: bigint
        switch (inst.op) {
          case X86.PXOR:
          case X86.XORP: result = a ^ b; break
          case X86.PAND:
          case X86.ANDP: result = a & b; break
          case X86.ANDNP: result = ~a & b; break
          default: result = a | b; break
        }
        this.xmm[inst.reg] = result & MASK128
        return
      }

      case X86.PADD:
      case X86.PSUB:
      case X86.PCMPGT:
      case X86.PCMPEQ:
      case X86.PMULUDQ:
      case X86.PUNPCKL:
        return this.packed(inst)

      case X86.PSHUFD: {
        const source = this.readRm(inst)
        const selector = Number(inst.imm)
        let result = 0n
        for (let lane = 0; lane < 4; lane++) {
          const from = (selector >> (lane * 2)) & 3
          const value = (source >> BigInt(from * 32)) & 0xffffffffn
          result |= value << BigInt(lane * 32)
        }
        this.xmm[inst.reg] = result
        return
      }

      case X86.ADDSD:
      case X86.SUBSD:
      case X86.MULSD:
      case X86.DIVSD:
      case X86.SQRTSD:
      case X86.MINSD:
      case X86.MAXSD:
        return this.scalarFloat(inst)

      case X86.UCOMIS:
        return this.compareFloat(inst)

      case X86.CVTTS2SI: {
        const width = inst.sourceSize
        const bits = inst.mem === null
          ? this.xmm[inst.rm]! & maskOf(width)
          : this.readMemory(inst.mem, width)
        const value = width === 8 ? bitsToF64(bits) : bitsToF32(Number(bits))
        const truncated = Math.trunc(value)
        // An out-of-range conversion produces the "integer indefinite"
        // value rather than a saturated one.
        const limit = 1n << BigInt(inst.size * 8 - 1)
        if (!Number.isFinite(truncated) || BigInt(Math.trunc(truncated)) >= limit ||
            BigInt(Math.trunc(truncated)) < -limit) {
          return this.writeReg(inst.reg, inst.size, false, limit)
        }
        return this.writeReg(inst.reg, inst.size, false, BigInt(truncated) & maskOf(inst.size))
      }

      case X86.CVTSI2S: {
        const source = inst.mem === null
          ? this.readReg(inst.rm, inst.size, false)
          : this.readMemory(inst.mem, inst.size)
        const value = Number(sext(source, inst.size * 8))
        const width = inst.sourceSize
        const bits = width === 8 ? f64ToBits(value) : BigInt(f32ToBits(Math.fround(value)))
        this.xmm[inst.reg] = (this.xmm[inst.reg]! & ~maskOf(width)) | bits
        return
      }

      case X86.CVTS2S: {
        const from = inst.sourceSize
        const bits = inst.mem === null
          ? this.xmm[inst.rm]! & maskOf(from)
          : this.readMemory(inst.mem, from)
        const value = from === 8 ? bitsToF64(bits) : bitsToF32(Number(bits))
        const to = from === 8 ? 4 : 8
        const out = to === 8 ? f64ToBits(value) : BigInt(f32ToBits(Math.fround(value)))
        this.xmm[inst.reg] = (this.xmm[inst.reg]! & ~maskOf(to)) | out
        return
      }

      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, inst.bytes, `execution of ${inst.op}`,
        )
    }
  }

  // -------------------------------------------------------------------------
  // The x87 stack.
  // -------------------------------------------------------------------------

  /** st(i), with an empty slot reported rather than read as a zero. */
  private stack(index: number, si: X86StaticInst): X87Value {
    const value = this.x87.get(index)
    if (value === null) {
      throw new IsaError(
        `${ISA_NAME}: x87 stack underflow at 0x${si.addr.toString(16)}`,
      )
    }
    return value
  }

  /** Reads an x87 memory operand, whatever width and kind it is. */
  private readX87Operand(inst: X86Inst): X87Value {
    const at = this.effectiveAddress(inst.mem!)
    this.access = at
    this.accessWidth = inst.sourceSize
    if (inst.sourceSize === 10) {
      const low = this.memory.load(at, 8, false)
      const high = this.memory.load(u64(at + 8n), 2, false)
      return decode80(low, high)
    }
    const raw = this.memory.load(at, inst.sourceSize as AccessWidth, false)
    if (inst.signed) return fromInteger(sext(raw, inst.sourceSize * 8))
    return fromIeee(raw, inst.sourceSize)
  }

  private executeX87(si: X86StaticInst): void {
    const inst = si.inst
    const precision = this.x87.precision
    const mode = this.x87.rounding

    switch (inst.op) {
      case X86.X87_LOAD: {
        const value = inst.mem === null
          ? this.stack(inst.reg, si)
          : this.readX87Operand(inst)
        this.x87.push(value)
        return
      }

      case X86.X87_CONST:
        this.x87.push(inst.cond === 1 ? makeFinite(1, 1n, 0) : makeFinite(1, 0n, 0))
        return

      case X86.X87_STORE: {
        const value = this.stack(0, si)
        if (inst.mem === null) {
          this.x87.set(inst.reg, value)
        } else if (inst.sourceSize === 10) {
          const encoded = encode80(value)
          const at = this.effectiveAddress(inst.mem)
          this.access = at
          this.accessWidth = 10
          this.memory.store(at, 8, encoded.low)
          this.memory.store(u64(at + 8n), 2, encoded.high)
        } else if (inst.signed) {
          // A value that does not fit stores the "integer indefinite"
          // rather than saturating, which is what makes an overflowing
          // conversion detectable afterwards.
          const bits = inst.sourceSize * 8
          const integer = toInteger(value, bits, mode)
          const stored = integer === null ? -(1n << BigInt(bits - 1)) : integer
          const at = this.effectiveAddress(inst.mem)
          this.access = at
          this.accessWidth = inst.sourceSize
          this.memory.store(at, inst.sourceSize as AccessWidth, stored & maskOf(inst.sourceSize))
        } else {
          const at = this.effectiveAddress(inst.mem)
          this.access = at
          this.accessWidth = inst.sourceSize
          this.memory.store(
            at, inst.sourceSize as AccessWidth, toIeee(value, inst.sourceSize, mode),
          )
        }
        if (inst.accumulatorForm) this.x87.pop()
        return
      }

      case X86.X87_ARITH: {
        const other = inst.mem === null ? this.stack(inst.reg, si) : this.readX87Operand(inst)
        const destinationIndex = inst.regIsDestination ? inst.reg : 0
        const destination = this.stack(destinationIndex, si)
        const left = inst.regIsDestination ? destination : this.stack(0, si)
        const right = inst.regIsDestination ? this.stack(0, si) : other
        const result = this.x87Arith(inst.cond, left, right, precision, mode)
        this.x87.set(destinationIndex, result)
        if (inst.accumulatorForm) this.x87.pop()
        return
      }

      case X86.X87_COMPARE: {
        const other = inst.mem === null ? this.stack(inst.reg, si) : this.readX87Operand(inst)
        const order = compare87(this.stack(0, si), other)
        if (inst.cond === 8) {
          // The modern form writes the integer flags directly, with the
          // unordered case as a pattern of its own rather than a false.
          this.setFlag(Flag.OF, false)
          this.setFlag(Flag.SF, false)
          this.setFlag(Flag.AF, false)
          this.setFlag(Flag.ZF, order === null || order === 0)
          this.setFlag(Flag.PF, order === null)
          this.setFlag(Flag.CF, order === null || order < 0)
          this.defines(ALL_FLAGS)
        }
        if (inst.accumulatorForm || inst.cond === 3) this.x87.pop()
        return
      }

      case X86.X87_UNARY: {
        const value = this.stack(0, si)
        this.x87.set(0, inst.cond === 0
          ? negate(value)
          : { ...value, sign: 1 })
        return
      }

      case X86.X87_XCH: {
        const top = this.stack(0, si)
        this.x87.set(0, this.stack(inst.reg, si))
        this.x87.set(inst.reg, top)
        return
      }

      case X86.X87_LDCW: {
        const at = this.effectiveAddress(inst.mem!)
        this.access = at
        this.accessWidth = 2
        this.x87.control = Number(this.memory.load(at, 2, false))
        return
      }

      case X86.X87_STCW: {
        const at = this.effectiveAddress(inst.mem!)
        this.access = at
        this.accessWidth = 2
        this.memory.store(at, 2, BigInt(this.x87.control))
        return
      }

      default:
        // X87_FREE: marks a slot empty without changing the top, which
        // matters only to something that checks for overflow.
        return
    }
  }

  private x87Arith(
    operation: number,
    left: X87Value,
    right: X87Value,
    precision: number,
    mode: number,
  ): X87Value {
    switch (operation) {
      case 0: return add87(left, right, precision, mode)
      case 1: return mul87(left, right, precision, mode)
      case 4: return add87(left, negate(right), precision, mode)
      case 5: return add87(right, negate(left), precision, mode)
      case 6: return div87(left, right, precision, mode).value
      case 7: return div87(right, left, precision, mode).value
      default: return INDEFINITE
    }
  }

  private readMemory(mem: MemOperand, size: number): bigint {
    const at = this.effectiveAddress(mem)
    this.access = at
    this.accessWidth = size
    return this.loadWide(at, size)
  }

  private writeMemory(mem: MemOperand, size: number, value: bigint): void {
    const at = this.effectiveAddress(mem)
    this.access = at
    this.accessWidth = size
    this.storeWide(at, size, value)
  }

  /** The lanewise integer operations, all of which share this shape. */
  private packed(inst: X86Inst): void {
    const element = inst.sourceSize
    const a = this.xmm[inst.reg]!
    const b = this.readRm(inst)
    const mask = maskOf(element)
    const lanes = 16 / element
    let result = 0n

    if (inst.op === X86.PMULUDQ) {
      // Multiplies the even 32-bit lanes into 64-bit ones, which is the
      // operation a compiler builds a 64-bit-to-double conversion from.
      for (let lane = 0; lane < 2; lane++) {
        const left = (a >> BigInt(lane * 64)) & 0xffffffffn
        const right = (b >> BigInt(lane * 64)) & 0xffffffffn
        result |= (left * right) << BigInt(lane * 64)
      }
      this.xmm[inst.reg] = result
      return
    }

    if (inst.op === X86.PUNPCKL) {
      // Interleaves the low half of each source, which turns two vectors of
      // narrow values into one of wide ones.
      const half = lanes / 2
      for (let lane = 0; lane < half; lane++) {
        const left = (a >> BigInt(lane * element * 8)) & mask
        const right = (b >> BigInt(lane * element * 8)) & mask
        result |= left << BigInt(lane * 2 * element * 8)
        result |= right << BigInt((lane * 2 + 1) * element * 8)
      }
      this.xmm[inst.reg] = result
      return
    }

    for (let lane = 0; lane < lanes; lane++) {
      const shift = BigInt(lane * element * 8)
      const left = (a >> shift) & mask
      const right = (b >> shift) & mask
      let value: bigint
      switch (inst.op) {
        case X86.PADD: value = (left + right) & mask; break
        case X86.PSUB: value = (left - right) & mask; break
        case X86.PCMPEQ: value = left === right ? mask : 0n; break
        default:
          value = sext(left, element * 8) > sext(right, element * 8) ? mask : 0n
          break
      }
      result |= value << shift
    }
    this.xmm[inst.reg] = result
  }

  private scalarFloat(inst: X86Inst): void {
    const width = inst.sourceSize
    const aBits = this.xmm[inst.reg]! & maskOf(width)
    const bBits = inst.mem === null
      ? this.xmm[inst.rm]! & maskOf(width)
      : this.readMemory(inst.mem, width)
    const a = width === 8 ? bitsToF64(aBits) : bitsToF32(Number(aBits))
    const b = width === 8 ? bitsToF64(bBits) : bitsToF32(Number(bBits))
    let value: number
    switch (inst.op) {
      case X86.ADDSD: value = a + b; break
      case X86.SUBSD: value = a - b; break
      case X86.MULSD: value = a * b; break
      case X86.DIVSD: value = a / b; break
      case X86.SQRTSD: value = Math.sqrt(b); break
      // The minimum and maximum return the second operand whenever the
      // comparison is not strictly true, which is how they behave with a
      // NaN and with two zeroes of opposite sign.
      case X86.MINSD: value = b < a ? b : a; break
      default: value = b > a ? b : a; break
    }
    if ((inst.op === X86.MINSD || inst.op === X86.MAXSD) &&
        (Number.isNaN(a) || Number.isNaN(b))) {
      value = b
    }
    const bits = width === 8 ? f64ToBits(value) : BigInt(f32ToBits(Math.fround(value)))
    this.xmm[inst.reg] = (this.xmm[inst.reg]! & ~maskOf(width)) | bits
  }

  private compareFloat(inst: X86Inst): void {
    const width = inst.sourceSize
    const aBits = this.xmm[inst.reg]! & maskOf(width)
    const bBits = inst.mem === null
      ? this.xmm[inst.rm]! & maskOf(width)
      : this.readMemory(inst.mem, width)
    const a = width === 8 ? bitsToF64(aBits) : bitsToF32(Number(aBits))
    const b = width === 8 ? bitsToF64(bBits) : bitsToF32(Number(bBits))
    const unordered = Number.isNaN(a) || Number.isNaN(b)
    // A floating-point comparison writes the integer flags, and reports
    // "unordered" as a pattern of its own rather than as false.
    this.setFlag(Flag.OF, false)
    this.setFlag(Flag.SF, false)
    this.setFlag(Flag.AF, false)
    this.setFlag(Flag.ZF, unordered || a === b)
    this.setFlag(Flag.PF, unordered)
    this.setFlag(Flag.CF, unordered || a < b)
    this.defines(ALL_FLAGS)
    void isNan64
  }
}

/** arch_prctl, and the one code of it that is implemented. */
const ARCH_PRCTL = 158
const ARCH_SET_FS = 0x1002
