/**
 * AArch64 interpreter.
 *
 * Structurally the same as the RV64 one — bigint registers, raw bit patterns
 * for floating point, a shared Linux layer behind the syscall instruction —
 * and semantically different in four places that matter. Each is a case
 * where an interpreter written by analogy with RISC-V would be wrong and
 * would look right:
 *
 *   Condition flags. Almost every arithmetic instruction has a flag-setting
 *   twin, and carry and overflow are different questions that only disagree
 *   on operands straddling a boundary.
 *
 *   Register 31. It reads as zero in most instructions and as the stack
 *   pointer in a few, decided per instruction rather than per encoding.
 *
 *   NaN propagation. RISC-V returns a canonical NaN from every operation
 *   that produces one. AArch64, with the default FPCR, propagates an input
 *   NaN's payload after quieting it.
 *
 *   Float to integer conversion. RISC-V converts a NaN to the maximum of the
 *   target type. AArch64 converts it to zero.
 */
import { sext, u64, zext } from '../common/bits64.ts'
import {
  ExecutionBudgetExceeded,
  GuestFault,
  IsaError,
  UnimplementedInstruction,
} from '../common/errors.ts'
import {
  F32,
  F64,
  bitsToF32,
  bitsToF64,
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
  sqrtStatus,
  statusOf,
  type FloatFormat,
} from '../common/fp.ts'
import type { LinuxSyscalls } from '../common/linux.ts'
import type { AccessWidth, GuestMemory } from '../common/memory.ts'
import { RunState, type ArchState, type Interpreter, type RetireChunk } from '../common/trace.ts'
import {
  A64,
  A64_NAME,
  ISA_NAME,
  DC_ZVA_BYTES,
  Index,
  Round,
  Shift,
  decodeBitMasks,
  decodeFpImmediate,
  rdIsStackPointer,
  rnIsStackPointer,
  type A64Op,
} from './decode.ts'
import type { A64Image, A64StaticInst } from './image.ts'

/** FPSR exception bits. Note the order differs from RISC-V's fcsr. */
export const FpFlag = {
  IOC: 0x01,
  DZC: 0x02,
  OFC: 0x04,
  UFC: 0x08,
  IXC: 0x10,
} as const

const ROUNDING_FLAGS = FpFlag.IXC | FpFlag.OFC | FpFlag.UFC

const SIGN64 = 0x8000000000000000n
const MASK128 = (1n << 128n) - 1n

/** All ones across a given number of bytes. */
const maskOf = (bytes: number): bigint => (1n << BigInt(bytes * 8)) - 1n

export interface A64Options {
  initialRegisters?: readonly bigint[]
  instructionBudget?: number
  syscalls?: LinuxSyscalls
  initialSp?: bigint
}

const DEFAULT_BUDGET = 200_000_000

interface Flags {
  n: boolean
  z: boolean
  c: boolean
  v: boolean
}

export class A64Interpreter implements Interpreter {
  readonly image: A64Image
  private readonly memory: GuestMemory
  private readonly x = new BigInt64Array(31)
  private readonly v: bigint[] = Array.from({ length: 32 }, () => 0n)
  private sp = 0n
  private flags: Flags = { n: false, z: false, c: false, v: false }
  private fpsr = 0
  private fpcr = 0
  /** Thread pointer. A libc sets it up; nothing here interprets it. */
  private tpidr = 0n
  private pc: bigint
  private exited = false
  private reservation: bigint | null = null
  private readonly budget: number
  private readonly linux: LinuxSyscalls | undefined
  exitCode = 0
  retired = 0

  constructor(image: A64Image, memory: GuestMemory, options: A64Options = {}) {
    this.image = image
    this.memory = memory
    this.pc = image.entry
    this.budget = options.instructionBudget ?? DEFAULT_BUDGET
    this.linux = options.syscalls
    if (options.initialSp !== undefined) this.sp = options.initialSp
  }

  setGpr(index: number, value: bigint): void {
    if (index < 31) this.x[index] = value
    else if (index === 31) this.sp = value
    else if (index === 32) this.flags = flagsFromNzcv(Number(BigInt.asUintN(32, value)))
  }

  gpr(index: number): bigint {
    if (index < 31) return this.x[index]!
    if (index === 31) return this.sp
    if (index === 32) return BigInt(nzcvOf(this.flags))
    return 0n
  }

  fpr(index: number): bigint {
    return this.v[index]!
  }

  get programCounter(): bigint {
    return this.pc
  }

  finalState(): ArchState {
    return {
      gpr: [...Array.from(this.x), this.sp],
      fpr: [...this.v],
      status: {
        nzcv: BigInt(nzcvOf(this.flags)),
        fpsr: BigInt(this.fpsr),
        fpcr: BigInt(this.fpcr),
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
      this.next = pc + 4n
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

  private next = 0n
  private access = 0n
  private accessWidth = 0
  private taken = 0

  // -------------------------------------------------------------------------
  // Register access. Encoding 31 is the zero register almost everywhere and
  // the stack pointer in a handful of instructions, so which one is meant is
  // a property of the instruction rather than of the field.
  // -------------------------------------------------------------------------

  private readXU(index: number, width: number, spForms = false): bigint {
    const raw = index === 31 ? (spForms ? this.sp : 0n) : this.x[index]!
    return width === 8 ? u64(raw) : zext(raw, 32)
  }

  private writeX(index: number, value: bigint, width: number, spForms = false): void {
    // A 32-bit result zeroes the upper half rather than sign-extending it,
    // which is the opposite of RV64's W forms.
    const stored = width === 8 ? value : zext(value, 32)
    if (index === 31) {
      if (spForms) this.sp = BigInt.asIntN(64, stored)
      return
    }
    this.x[index] = stored
  }

  private readV(index: number): bigint {
    return this.v[index]!
  }

  /** A scalar write zeroes everything above the value it wrote. */
  private writeV(index: number, value: bigint, bytes: number): void {
    this.v[index] = BigInt.asUintN(bytes * 8, value) & MASK128
  }

  private flag(mask: number): void {
    this.fpsr |= mask
  }

  private needsStatus(): boolean {
    return (this.fpsr & ROUNDING_FLAGS) !== ROUNDING_FLAGS
  }

  private applyStatus(status: { inexact: boolean; overflow: boolean; underflow: boolean }): void {
    if (status.inexact) this.fpsr |= FpFlag.IXC
    if (status.overflow) this.fpsr |= FpFlag.OFC
    if (status.underflow) this.fpsr |= FpFlag.UFC
  }

  // -------------------------------------------------------------------------

  private execute(si: A64StaticInst): void {
    const inst = si.inst
    const width = inst.sf ? 8 : 4
    switch (inst.op) {
      case A64.ADR:
      case A64.ADRP:
        return this.writeX(inst.rd, si.addr + inst.imm, 8)

      case A64.ADD:
      case A64.SUB: {
        const a = this.readXU(inst.rn, width, rnIsStackPointer(inst))
        const b = this.secondOperand(inst, width)
        const subtract = inst.op === A64.SUB
        const { result, flags } = addWithCarry(a, subtract ? ~b : b, subtract, width)
        if (inst.setFlags) this.flags = flags
        return this.writeX(inst.rd, result, width, rdIsStackPointer(inst))
      }

      case A64.ADC:
      case A64.SBC: {
        const a = this.readXU(inst.rn, width)
        const b = this.readXU(inst.rm, width)
        const subtract = inst.op === A64.SBC
        const { result, flags } = addWithCarry(a, subtract ? ~b : b, this.flags.c, width)
        if (inst.setFlags) this.flags = flags
        return this.writeX(inst.rd, result, width)
      }

      case A64.AND:
      case A64.ORR:
      case A64.EOR:
      case A64.BIC:
      case A64.ORN:
      case A64.EON: {
        const a = this.readXU(inst.rn, width)
        const b = this.secondOperand(inst, width)
        let result: bigint
        switch (inst.op) {
          case A64.AND: result = a & b; break
          case A64.ORR: result = a | b; break
          case A64.EOR: result = a ^ b; break
          case A64.BIC: result = a & ~b; break
          case A64.ORN: result = a | ~b; break
          default: result = a ^ ~b; break
        }
        result = zext(result, width * 8)
        if (inst.setFlags) {
          this.flags = {
            n: (result >> BigInt(width * 8 - 1)) === 1n,
            z: result === 0n,
            c: false,
            v: false,
          }
        }
        return this.writeX(inst.rd, result, width, rdIsStackPointer(inst))
      }

      case A64.MOVZ:
        return this.writeX(inst.rd, inst.imm << BigInt(inst.shiftAmount), width)
      case A64.MOVN:
        return this.writeX(inst.rd, zext(~(inst.imm << BigInt(inst.shiftAmount)), width * 8), width)
      case A64.MOVK: {
        const keep = ~(0xffffn << BigInt(inst.shiftAmount))
        const current = this.readXU(inst.rd, width)
        return this.writeX(inst.rd, (current & keep) | (inst.imm << BigInt(inst.shiftAmount)), width)
      }

      case A64.SBFM:
      case A64.UBFM:
      case A64.BFM:
        return this.bitfield(inst.op, inst.rd, inst.rn, inst.imm, width)

      case A64.EXTR: {
        const size = BigInt(width * 8)
        const high = this.readXU(inst.rn, width)
        const low = this.readXU(inst.rm, width)
        const shift = inst.imm
        const joined = (high << size) | low
        return this.writeX(inst.rd, zext(joined >> shift, width * 8), width)
      }

      case A64.CCMP:
      case A64.CCMN: {
        if (conditionHolds(inst.cond, this.flags)) {
          const a = this.readXU(inst.rn, width)
          const b = inst.rm >= 0 ? this.readXU(inst.rm, width) : inst.imm
          const subtract = inst.op === A64.CCMP
          const { flags } = addWithCarry(a, subtract ? ~b : b, subtract, width)
          this.flags = flags
        } else {
          this.flags = flagsFromNzcv(inst.nzcv << 28)
        }
        return
      }

      case A64.CSEL:
      case A64.CSINC:
      case A64.CSINV:
      case A64.CSNEG: {
        const hold = conditionHolds(inst.cond, this.flags)
        if (hold) return this.writeX(inst.rd, this.readXU(inst.rn, width), width)
        const other = this.readXU(inst.rm, width)
        let result: bigint
        switch (inst.op) {
          case A64.CSINC: result = other + 1n; break
          case A64.CSINV: result = ~other; break
          case A64.CSNEG: result = -other; break
          default: result = other; break
        }
        return this.writeX(inst.rd, zext(result, width * 8), width)
      }

      case A64.RBIT:
      case A64.REV16:
      case A64.REV32:
      case A64.REV:
      case A64.CLZ:
      case A64.CLS:
        return this.writeX(inst.rd, oneSource(inst.op, this.readXU(inst.rn, width), width), width)

      case A64.UDIV:
      case A64.SDIV: {
        const bitsWide = width * 8
        const divisor = inst.op === A64.SDIV
          ? sext(this.readXU(inst.rm, width), bitsWide)
          : zext(this.readXU(inst.rm, width), bitsWide)
        if (divisor === 0n) return this.writeX(inst.rd, 0n, width)
        if (inst.op === A64.SDIV) {
          const dividend = sext(this.readXU(inst.rn, width), bitsWide)
          const min = -(1n << BigInt(bitsWide - 1))
          if (dividend === min && divisor === -1n) return this.writeX(inst.rd, min, width)
          return this.writeX(inst.rd, dividend / divisor, width)
        }
        const dividend = zext(this.readXU(inst.rn, width), bitsWide)
        return this.writeX(inst.rd, dividend / divisor, width)
      }

      case A64.LSLV:
      case A64.LSRV:
      case A64.ASRV:
      case A64.RORV: {
        const bitsWide = BigInt(width * 8)
        const amount = zext(this.readXU(inst.rm, width), width === 8 ? 6 : 5)
        const value = this.readXU(inst.rn, width)
        let result: bigint
        switch (inst.op) {
          case A64.LSLV: result = value << amount; break
          case A64.LSRV: result = value >> amount; break
          case A64.ASRV: result = sext(value, width * 8) >> amount; break
          default:
            result = amount === 0n
              ? value
              : (value >> amount) | (value << (bitsWide - amount))
            break
        }
        return this.writeX(inst.rd, zext(result, width * 8), width)
      }

      case A64.MADD:
      case A64.MSUB: {
        const a = this.readXU(inst.rn, width)
        const b = this.readXU(inst.rm, width)
        const c = this.readXU(inst.ra, width)
        const product = a * b
        const result = inst.op === A64.MADD ? c + product : c - product
        return this.writeX(inst.rd, zext(result, width * 8), width)
      }

      case A64.SMADDL:
      case A64.SMSUBL:
      case A64.UMADDL:
      case A64.UMSUBL: {
        const signedForm = inst.op === A64.SMADDL || inst.op === A64.SMSUBL
        const a = signedForm ? sext(this.readXU(inst.rn, 4), 32) : zext(this.readXU(inst.rn, 4), 32)
        const b = signedForm ? sext(this.readXU(inst.rm, 4), 32) : zext(this.readXU(inst.rm, 4), 32)
        const c = this.readXU(inst.ra, 8)
        const subtract = inst.op === A64.SMSUBL || inst.op === A64.UMSUBL
        return this.writeX(inst.rd, zext(subtract ? c - a * b : c + a * b, 64), 8)
      }

      case A64.SMULH: {
        const a = sext(this.readXU(inst.rn, 8), 64)
        const b = sext(this.readXU(inst.rm, 8), 64)
        return this.writeX(inst.rd, zext((a * b) >> 64n, 64), 8)
      }
      case A64.UMULH: {
        const a = zext(this.readXU(inst.rn, 8), 64)
        const b = zext(this.readXU(inst.rm, 8), 64)
        return this.writeX(inst.rd, zext((a * b) >> 64n, 64), 8)
      }

      case A64.B:
        this.next = si.addr + inst.imm
        return
      case A64.BL:
        this.writeX(30, si.addr + 4n, 8)
        this.next = si.addr + inst.imm
        return
      case A64.B_COND: {
        const hold = conditionHolds(inst.cond, this.flags)
        this.taken = hold ? 1 : 0
        if (hold) this.next = si.addr + inst.imm
        return
      }
      case A64.CBZ:
      case A64.CBNZ: {
        const value = this.readXU(inst.rd, width)
        const hold = inst.op === A64.CBZ ? value === 0n : value !== 0n
        this.taken = hold ? 1 : 0
        if (hold) this.next = si.addr + inst.imm
        return
      }
      case A64.TBZ:
      case A64.TBNZ: {
        const value = this.readXU(inst.rd, 8)
        const set = ((value >> BigInt(inst.shiftAmount)) & 1n) === 1n
        const hold = inst.op === A64.TBNZ ? set : !set
        this.taken = hold ? 1 : 0
        if (hold) this.next = si.addr + inst.imm
        return
      }
      case A64.BR:
        this.next = this.readXU(inst.rn, 8)
        return
      case A64.BLR: {
        const target = this.readXU(inst.rn, 8)
        this.writeX(30, si.addr + 4n, 8)
        this.next = target
        return
      }
      case A64.RET:
        this.next = this.readXU(inst.rn < 0 ? 30 : inst.rn, 8)
        return

      case A64.SVC:
        return this.syscall()
      case A64.BRK:
        throw new IsaError(`${ISA_NAME}: guest executed brk at 0x${si.addr.toString(16)}`)
      case A64.NOP:
      case A64.BARRIER:
        return
      case A64.CLREX:
        this.reservation = null
        return

      case A64.MRS:
        return this.writeX(inst.rd, this.readSystemRegister(si), 8)
      case A64.MSR:
        return this.writeSystemRegister(si, this.readXU(inst.rd, 8))

      case A64.LOAD:
      case A64.STORE:
      case A64.LOAD_PAIR:
      case A64.STORE_PAIR:
      case A64.LOAD_LITERAL:
      case A64.LOAD_EXCLUSIVE:
      case A64.STORE_EXCLUSIVE:
        return this.memoryAccess(si)

      case A64.LD1_LANE:
        return this.loadLane(si)

      case A64.DC_ZVA: {
        // Zeroes the block containing the address, not the block starting
        // at it: the low bits of the operand are ignored rather than
        // faulting, which is what makes an unaligned pointer safe to pass.
        const at = u64(this.readXU(inst.rn, 8) & ~BigInt(DC_ZVA_BYTES - 1))
        this.access = at
        this.accessWidth = DC_ZVA_BYTES
        for (let offset = 0; offset < DC_ZVA_BYTES; offset += 8) {
          this.memory.store(u64(at + BigInt(offset)), 8, 0n)
        }
        return
      }

      default:
        return this.executeFloat(si)
    }
  }

  /** The second operand of a data-processing instruction, already transformed. */
  private secondOperand(inst: A64StaticInst['inst'], width: number): bigint {
    if (inst.rm < 0) return inst.imm
    const bitsWide = BigInt(width * 8)
    if (inst.extendType >= 0) {
      // Extend a narrow slice of the register, then shift it left.
      const raw = this.readXU(inst.rm, 8)
      const sizes = [8, 16, 32, 64, 8, 16, 32, 64]
      const signedExtend = inst.extendType >= 4
      const from = sizes[inst.extendType]!
      const narrowed = signedExtend ? sext(raw, from) : zext(raw, from)
      return zext(narrowed << BigInt(inst.shiftAmount), width * 8)
    }
    const value = this.readXU(inst.rm, width)
    const amount = BigInt(inst.shiftAmount)
    switch (inst.shiftType) {
      case Shift.LSR: return zext(value >> amount, width * 8)
      case Shift.ASR: return zext(sext(value, width * 8) >> amount, width * 8)
      case Shift.ROR:
        return amount === 0n
          ? value
          : zext((value >> amount) | (value << (bitsWide - amount)), width * 8)
      default: return zext(value << amount, width * 8)
    }
  }

  /**
   * The bitfield family, in the architecture's own terms: rotate, select
   * with the wrap mask, then decide everything above the field with the top
   * mask. What fills that region is the only difference between the three —
   * zero for UBFM, the sign for SBFM, the old destination for BFM.
   */
  private bitfield(op: A64Op, rd: number, rn: number, packed: bigint, width: number): void {
    const bitsWide = width * 8
    const immr = Number(packed & 0xffn)
    const imms = Number((packed >> 8n) & 0xffn)
    const n = Number((packed >> 16n) & 1n)
    const masks = decodeBitMasks(n, imms, immr, false, width === 8)
    if (masks === null) {
      throw new UnimplementedInstruction(
        ISA_NAME, 0n, new Uint8Array([]), `bitfield with a reserved encoding`,
      )
    }
    const size = BigInt(bitsWide)
    const source = zext(this.readXU(rn, width), bitsWide)
    const r = BigInt(immr & (bitsWide - 1))
    const rotated = r === 0n
      ? source
      : ((source >> r) | (source << (size - r))) & ((1n << size) - 1n)

    const bot = op === A64.BFM
      ? (zext(this.readXU(rd, width), bitsWide) & ~masks.wmask) | (rotated & masks.wmask)
      : rotated & masks.wmask
    let top: bigint
    if (op === A64.UBFM) top = 0n
    else if (op === A64.BFM) top = zext(this.readXU(rd, width), bitsWide)
    else top = ((source >> BigInt(imms & (bitsWide - 1))) & 1n) === 1n ? (1n << size) - 1n : 0n

    const result = (top & ~masks.tmask) | (bot & masks.tmask)
    return this.writeX(rd, zext(result, bitsWide), width)
  }

  private readSystemRegister(si: A64StaticInst): bigint {
    switch (si.inst.sysreg) {
      case 'nzcv': return BigInt(nzcvOf(this.flags))
      case 'fpsr': return BigInt(this.fpsr)
      case 'fpcr': return BigInt(this.fpcr)
      case 'tpidr_el0':
      case 'tpidrro_el0': return this.tpidr
      // The block size a `dc zva` clears, as a power-of-two count of
      // 32-bit words, with bit 4 clear to say the instruction is permitted.
      case 'dczid_el0': return BigInt(Math.log2(DC_ZVA_BYTES / 4))
      // Frozen, for the same reason clock_gettime is: a run must reproduce.
      case 'cntvct_el0': return 0n
      case 'cntfrq_el0': return 1000000n
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, new Uint8Array([]), `read of system register ${si.inst.sysreg}`,
        )
    }
  }

  private writeSystemRegister(si: A64StaticInst, value: bigint): void {
    switch (si.inst.sysreg) {
      case 'nzcv':
        this.flags = flagsFromNzcv(Number(BigInt.asUintN(32, value)))
        return
      case 'fpsr':
        this.fpsr = Number(value & 0xffffffffn)
        return
      case 'fpcr':
        this.fpcr = Number(value & 0xffffffffn)
        return
      case 'tpidr_el0':
        this.tpidr = BigInt.asIntN(64, value)
        return
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, new Uint8Array([]), `write of system register ${si.inst.sysreg}`,
        )
    }
  }

  private syscall(): void {
    if (!this.linux) {
      throw new IsaError(
        `${ISA_NAME}: guest made a system call but this program was loaded without ` +
        'Linux emulation',
      )
    }
    const args = [
      u64(this.x[0]!), u64(this.x[1]!), u64(this.x[2]!),
      u64(this.x[3]!), u64(this.x[4]!), u64(this.x[5]!),
    ]
    const result = this.linux.dispatch(ISA_NAME, Number(this.x[8]!), args)
    if (result.exited) {
      this.exited = true
      this.exitCode = this.linux.exitCode
      return
    }
    this.x[0] = BigInt.asIntN(64, result.value)
  }

  // -------------------------------------------------------------------------
  // Memory.
  // -------------------------------------------------------------------------

  private memoryAccess(si: A64StaticInst): void {
    const inst = si.inst
    if (inst.op === A64.LOAD_LITERAL) {
      const at = si.addr + inst.imm
      return this.loadInto(inst.rd, at, inst.width, inst.signed, inst.fpTransfer, inst.sf)
    }

    const base = this.readXU(inst.rn, 8, rnIsStackPointer(inst))
    let offset: bigint
    if (inst.rm >= 0) {
      const sizes = [8, 16, 32, 64, 8, 16, 32, 64]
      const from = sizes[inst.extendType]!
      const raw = this.readXU(inst.rm, 8)
      const extended = inst.extendType >= 4 ? sext(raw, from) : zext(raw, from)
      offset = extended << BigInt(inst.shiftAmount)
    } else {
      offset = inst.imm
    }

    const effective = inst.indexMode === Index.POST ? base : u64(base + offset)

    if (inst.op === A64.LOAD_EXCLUSIVE) {
      this.requireAligned(si, effective, inst.width)
      this.reservation = effective
      this.loadInto(inst.rd, effective, inst.width, false, false, inst.sf)
    } else if (inst.op === A64.STORE_EXCLUSIVE) {
      this.requireAligned(si, effective, inst.width)
      if (this.reservation !== effective) {
        this.access = effective
        this.accessWidth = inst.width
        this.writeX(inst.rm, 1n, 4)
        return
      }
      this.reservation = null
      this.storeFrom(inst.rd, effective, inst.width, false)
      this.writeX(inst.rm, 0n, 4)
    } else if (inst.op === A64.LOAD_PAIR) {
      this.loadInto(inst.rd, effective, inst.width, inst.signed, inst.fpTransfer, inst.sf)
      this.loadInto(
        inst.rt2, u64(effective + BigInt(inst.width)), inst.width, inst.signed,
        inst.fpTransfer, inst.sf,
      )
    } else if (inst.op === A64.STORE_PAIR) {
      this.storeFrom(inst.rd, effective, inst.width, inst.fpTransfer)
      this.storeFrom(inst.rt2, u64(effective + BigInt(inst.width)), inst.width, inst.fpTransfer)
    } else if (inst.op === A64.LOAD) {
      this.loadInto(inst.rd, effective, inst.width, inst.signed, inst.fpTransfer, inst.sf)
    } else {
      this.storeFrom(inst.rd, effective, inst.width, inst.fpTransfer)
    }

    if (inst.indexMode !== Index.OFFSET) {
      this.writeX(inst.rn, u64(base + offset), 8, rnIsStackPointer(inst))
    }
  }

  /** One lane of a vector register, as an unsigned value. */
  private lane(register: number, esize: number, index: number): bigint {
    return (this.v[register]! >> BigInt(index * esize * 8)) & maskOf(esize)
  }

  /** Replaces one lane, leaving the rest of the register alone. */
  private setLane(register: number, esize: number, index: number, value: bigint): void {
    const shift = BigInt(index * esize * 8)
    const mask = maskOf(esize) << shift
    this.v[register] = (this.v[register]! & ~mask & MASK128) | ((value & maskOf(esize)) << shift)
  }

  /**
   * Builds a vector lane by lane.
   *
   * Every lane is truncated to the element size, so an operation that
   * overflows wraps within its own lane rather than carrying into the next
   * one -- which is the whole point of a vector add.
   */
  private buildVector(
    destination: number,
    bytes: number,
    esize: number,
    of: (index: number) => bigint,
  ): void {
    let value = 0n
    const mask = maskOf(esize)
    for (let index = 0; index * esize < bytes; index++) {
      value |= (of(index) & mask) << BigInt(index * esize * 8)
    }
    this.v[destination] = BigInt.asUintN(bytes * 8, value)
  }

  /** A single-lane load, which leaves the other lanes of the register alone. */
  private loadLane(si: A64StaticInst): void {
    const inst = si.inst
    const at = u64(this.readXU(inst.rn, 8, true))
    this.access = at
    this.accessWidth = inst.esize
    const value = this.memory.load(at, inst.esize as AccessWidth, false)
    this.setLane(inst.rd, inst.esize, inst.index, value)
    if (inst.indexMode === Index.POST) {
      const step = inst.rm < 0 ? inst.imm : this.readXU(inst.rm, 8)
      this.writeX(inst.rn, u64(at + step), 8, true)
    }
  }

  private loadInto(
    register: number,
    at: bigint,
    width: number,
    signed: boolean,
    toVector: boolean,
    sf: boolean,
  ): void {
    this.access = at
    this.accessWidth = width
    if (toVector) {
      if (width === 16) {
        const low = this.memory.load(at, 8, false)
        const high = this.memory.load(u64(at + 8n), 8, false)
        this.v[register] = (u64(high) << 64n) | u64(low)
        return
      }
      this.writeV(register, this.memory.load(at, width as AccessWidth, false), width)
      return
    }
    const value = this.memory.load(at, width as AccessWidth, signed)
    this.writeX(register, value, sf ? 8 : 4)
  }

  private storeFrom(register: number, at: bigint, width: number, fromVector: boolean): void {
    this.access = at
    this.accessWidth = width
    if (fromVector) {
      const value = this.readV(register)
      if (width === 16) {
        this.memory.store(at, 8, value & 0xffffffffffffffffn)
        this.memory.store(u64(at + 8n), 8, value >> 64n)
        return
      }
      this.memory.store(at, width as AccessWidth, value)
      return
    }
    this.memory.store(at, width as AccessWidth, this.readXU(register, 8))
  }

  private requireAligned(si: A64StaticInst, address: bigint, width: number): void {
    if (address % BigInt(width) !== 0n) {
      throw new GuestFault(
        'write', address, width, `misaligned exclusive access at 0x${si.addr.toString(16)}`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // Floating point.
  // -------------------------------------------------------------------------

  /** Reads a scalar operand, widened to a double bit pattern for the maths. */
  private readFp(index: number, size: number): bigint {
    const raw = this.v[index]!
    return size === 8 ? BigInt.asUintN(64, raw) : BigInt.asUintN(32, raw)
  }

  private writeFp(index: number, bits: bigint, size: number): void {
    this.writeV(index, bits, size)
  }

  private asDouble(bits: bigint, size: number): number {
    return size === 8 ? bitsToF64(bits) : bitsToF32(Number(bits))
  }

  private fromDouble(value: number, size: number): bigint {
    return size === 8 ? f64ToBits(value) : BigInt(f32ToBits(Math.fround(value)))
  }

  private isNan(bits: bigint, size: number): boolean {
    return size === 8 ? isNan64(bits) : isNan32(Number(bits))
  }

  private isSignaling(bits: bigint, size: number): boolean {
    return size === 8 ? isSignaling64(bits) : isSignaling32(Number(bits))
  }

  /** Quiets a NaN by setting the top fraction bit, as the architecture does. */
  private quiet(bits: bigint, size: number): bigint {
    return size === 8 ? bits | 0x8000000000000n : bits | 0x400000n
  }

  private defaultNan(size: number): bigint {
    return size === 8 ? 0x7ff8000000000000n : 0x7fc00000n
  }

  /**
   * The architecture's NaN handling with the default control register: a
   * signalling operand is quieted and returned, and otherwise the first quiet
   * NaN is returned unchanged. RISC-V replaces every NaN result with one
   * canonical value, so this is the opposite convention and payloads survive.
   */
  private processNans(operands: readonly bigint[], size: number): bigint | null {
    for (const bits of operands) {
      if (this.isSignaling(bits, size)) {
        this.flag(FpFlag.IOC)
        return this.quiet(bits, size)
      }
    }
    for (const bits of operands) if (this.isNan(bits, size)) return bits
    return null
  }

  private format(size: number): FloatFormat {
    return size === 8 ? F64 : F32
  }

  private executeFloat(si: A64StaticInst): void {
    const inst = si.inst
    const size = inst.fpSize
    switch (inst.op) {
      case A64.DUP_GENERAL: {
        const element = this.readXU(inst.rn, 8)
        return this.buildVector(inst.rd, inst.fpSize, inst.esize, () => element)
      }

      case A64.DUP_ELEMENT: {
        const element = this.lane(inst.rn, inst.esize, inst.index)
        return this.buildVector(inst.rd, inst.fpSize, inst.esize, () => element)
      }

      case A64.INS_GENERAL:
        return this.setLane(inst.rd, inst.esize, inst.index, this.readXU(inst.rn, 8))

      case A64.UMOV:
        return this.writeX(
          inst.rd, this.lane(inst.rn, inst.esize, inst.index), inst.sf ? 8 : 4,
        )

      case A64.ORR_VEC:
      case A64.AND_VEC:
      case A64.EOR_VEC: {
        const a = this.v[inst.rn]!
        const b = this.v[inst.rm]!
        const combined = inst.op === A64.ORR_VEC ? a | b
          : inst.op === A64.AND_VEC ? a & b
            : a ^ b
        this.v[inst.rd] = BigInt.asUintN(inst.fpSize * 8, combined)
        return
      }

      case A64.ADD_VEC:
        return this.buildVector(inst.rd, inst.fpSize, inst.esize, (i) =>
          this.lane(inst.rn, inst.esize, i) + this.lane(inst.rm, inst.esize, i))

      case A64.MUL_VEC:
        return this.buildVector(inst.rd, inst.fpSize, inst.esize, (i) =>
          this.lane(inst.rn, inst.esize, i) * this.lane(inst.rm, inst.esize, i))

      case A64.MUL_ELEMENT: {
        const by = this.lane(inst.rm, inst.esize, inst.index)
        return this.buildVector(inst.rd, inst.fpSize, inst.esize, (i) =>
          this.lane(inst.rn, inst.esize, i) * by)
      }

      case A64.SADDL:
      case A64.SADDW: {
        // The destination element is twice the source element. `part`
        // chooses which half of the narrow register the sources come from,
        // which is the only difference between saddl and saddl2.
        const narrow = inst.esize / 2
        const lanes = 16 / inst.esize
        const first = inst.part ? lanes : 0
        return this.buildVector(inst.rd, 16, inst.esize, (i) => {
          const a = inst.op === A64.SADDW
            ? sext(this.lane(inst.rn, inst.esize, i), inst.esize * 8)
            : sext(this.lane(inst.rn, narrow, first + i), narrow * 8)
          const b = sext(this.lane(inst.rm, narrow, first + i), narrow * 8)
          return a + b
        })
      }

      case A64.USHL:
        // The shift amount is the low byte of the corresponding lane, read
        // as a signed value: a negative one shifts right instead.
        return this.buildVector(inst.rd, inst.fpSize, inst.esize, (i) => {
          const value = this.lane(inst.rn, inst.esize, i)
          const amount = Number(sext(this.lane(inst.rm, inst.esize, i) & 0xffn, 8))
          if (amount >= 0) return amount >= inst.esize * 8 ? 0n : value << BigInt(amount)
          return -amount >= inst.esize * 8 ? 0n : value >> BigInt(-amount)
        })

      case A64.XTN: {
        // Truncates each element to half its width. The result is 64 bits;
        // `part` says whether it replaces the low half of the destination
        // or is appended above a half that is left alone.
        let packed = 0n
        for (let i = 0; i * inst.esize < 8; i++) {
          const narrowed = this.lane(inst.rn, inst.esize * 2, i) & maskOf(inst.esize)
          packed |= narrowed << BigInt(i * inst.esize * 8)
        }
        packed = BigInt.asUintN(64, packed)
        this.v[inst.rd] = inst.part
          ? (packed << 64n) | (this.v[inst.rd]! & maskOf(8))
          : packed
        return
      }

      case A64.UZP1: {
        // Takes every other element of the two sources laid end to end.
        const lanes = inst.fpSize / inst.esize
        return this.buildVector(inst.rd, inst.fpSize, inst.esize, (i) => {
          const at = i * 2
          return at < lanes
            ? this.lane(inst.rn, inst.esize, at)
            : this.lane(inst.rm, inst.esize, at - lanes)
        })
      }

      case A64.ADDV: {
        let total = 0n
        for (let i = 0; i * inst.esize < inst.fpSize; i++) {
          total += this.lane(inst.rn, inst.esize, i)
        }
        return this.writeV(inst.rd, total, inst.esize)
      }

      case A64.ADDP_SCALAR:
        return this.writeV(
          inst.rd, this.lane(inst.rn, 8, 0) + this.lane(inst.rn, 8, 1), 8,
        )

      case A64.MOVI:
        // Writes the whole register, so the width is the one the encoding
        // gave rather than a scalar size.
        this.v[inst.rd] = BigInt.asUintN(inst.fpSize * 8, inst.imm)
        return

      case A64.FMOV_REG:
        return this.writeFp(inst.rd, this.readFp(inst.rn, size), size)
      case A64.FMOV_IMM: {
        const value = decodeFpImmediate(Number(inst.imm))
        return this.writeFp(inst.rd, this.fromDouble(value, size), size)
      }
      case A64.FMOV_TO_GP:
        return this.writeX(inst.rd, this.readFp(inst.rn, size), inst.sf ? 8 : 4)
      case A64.FMOV_FROM_GP:
        return this.writeFp(inst.rd, this.readXU(inst.rn, inst.sf ? 8 : 4), size)

      case A64.FABS:
      case A64.FNEG: {
        const bits = this.readFp(inst.rn, size)
        const signBit = size === 8 ? SIGN64 : 0x80000000n
        const result = inst.op === A64.FABS ? bits & ~signBit : bits ^ signBit
        return this.writeFp(inst.rd, result, size)
      }

      case A64.FSQRT: {
        const bits = this.readFp(inst.rn, size)
        const nan = this.processNans([bits], size)
        if (nan !== null) return this.writeFp(inst.rd, nan, size)
        const value = this.asDouble(bits, size)
        if (value < 0) {
          this.flag(FpFlag.IOC)
          return this.writeFp(inst.rd, this.defaultNan(size), size)
        }
        const result = size === 8 ? Math.sqrt(value) : Math.fround(Math.sqrt(value))
        if (this.needsStatus()) this.applyStatus(sqrtStatus(f64ToBits(value), result))
        return this.writeFp(inst.rd, this.fromDouble(result, size), size)
      }

      case A64.FCVT: {
        const from = size
        const to = inst.width
        const bits = this.readFp(inst.rn, from)
        if (this.isNan(bits, from)) {
          if (this.isSignaling(bits, from)) this.flag(FpFlag.IOC)
          // The payload is carried across, shifted to the new significand.
          const payload = from === 8
            ? Number((BigInt.asUintN(64, bits) >> 29n) & 0x3fffffn)
            : Number(BigInt.asUintN(32, bits) & 0x7fffffn)
          const moved = to === 4
            ? BigInt(0x7f800000 | 0x400000 | payload)
            : (0x7ff8000000000000n | (BigInt(payload & 0x3fffff) << 29n))
          return this.writeFp(inst.rd, moved, to)
        }
        const value = this.asDouble(bits, from)
        const narrowed = to === 4 ? Math.fround(value) : value
        if (to === 4 && this.needsStatus()) {
          this.applyStatus(statusOf(exactOf(f64ToBits(value)), narrowed, F32))
        }
        return this.writeFp(inst.rd, this.fromDouble(narrowed, to), to)
      }

      case A64.FRINT: {
        const bits = this.readFp(inst.rn, size)
        const nan = this.processNans([bits], size)
        if (nan !== null) return this.writeFp(inst.rd, nan, size)
        const value = this.asDouble(bits, size)
        if (!Number.isFinite(value) || Number.isInteger(value)) {
          return this.writeFp(inst.rd, bits, size)
        }
        const mode = inst.rounding === Round.CURRENT || inst.rounding === Round.EXACT
          ? Round.NEAREST_EVEN
          : inst.rounding
        const rounded = roundToIntegralValue(value, mode)
        if (inst.rounding === Round.EXACT) this.flag(FpFlag.IXC)
        return this.writeFp(inst.rd, this.fromDouble(rounded, size), size)
      }

      case A64.FADD:
      case A64.FSUB:
      case A64.FMUL:
      case A64.FDIV:
      case A64.FNMUL:
        return this.arithmetic(si)

      case A64.FMAX:
      case A64.FMIN:
      case A64.FMAXNM:
      case A64.FMINNM:
        return this.minMax(si)

      case A64.FCMP:
        return this.compare(si, false)
      case A64.FCCMP: {
        if (!conditionHolds(inst.cond, this.flags)) {
          this.flags = flagsFromNzcv(inst.nzcv << 28)
          return
        }
        return this.compare(si, false)
      }

      case A64.FCSEL: {
        const source = conditionHolds(inst.cond, this.flags) ? inst.rn : inst.rm
        return this.writeFp(inst.rd, this.readFp(source, size), size)
      }

      case A64.FMADD:
      case A64.FMSUB:
      case A64.FNMADD:
      case A64.FNMSUB:
        return this.fusedMultiplyAdd(si)

      case A64.FCVT_TO_INT:
        return this.floatToInt(si)
      case A64.FCVT_FROM_INT:
        return this.intToFloat(si)

      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, new Uint8Array([]),
          `no execute case for ${A64_NAME[inst.op] ?? inst.op}`,
        )
    }
  }

  private arithmetic(si: A64StaticInst): void {
    const inst = si.inst
    const size = inst.fpSize
    const aBits = this.readFp(inst.rn, size)
    const bBits = this.readFp(inst.rm, size)
    const nan = this.processNans([aBits, bBits], size)
    if (nan !== null) {
      // The negating multiply negates whatever it produced, and flipping the
      // sign of a NaN is a bit operation the architecture still performs.
      const signBit = size === 8 ? SIGN64 : 0x80000000n
      return this.writeFp(inst.rd, inst.op === A64.FNMUL ? nan ^ signBit : nan, size)
    }

    const a = this.asDouble(aBits, size)
    const b = this.asDouble(bBits, size)
    const wideA = f64ToBits(a)
    const wideB = f64ToBits(b)
    const format = this.format(size)
    const round = (value: number): number => (size === 8 ? value : Math.fround(value))
    let value: number
    let status = { inexact: false, overflow: false, underflow: false }

    switch (inst.op) {
      case A64.FADD:
        if (!Number.isFinite(a) && a === -b) this.flag(FpFlag.IOC)
        value = round(a + b)
        status = statusOf(exactSum(wideA, wideB), value, format)
        break
      case A64.FSUB:
        if (!Number.isFinite(a) && a === b) this.flag(FpFlag.IOC)
        value = round(a - b)
        status = statusOf(exactSum(wideA, negateBits(wideB)), value, format)
        break
      case A64.FDIV:
        if (a === 0 && b === 0) this.flag(FpFlag.IOC)
        else if (!Number.isFinite(a) && !Number.isFinite(b)) this.flag(FpFlag.IOC)
        else if (b === 0) this.flag(FpFlag.DZC)
        value = round(a / b)
        status = quotientStatus(wideA, wideB, value, format)
        break
      default: {
        // FMUL and FNMUL, which differ only in the sign of the result.
        if ((a === 0 && !Number.isFinite(b)) || (b === 0 && !Number.isFinite(a))) {
          this.flag(FpFlag.IOC)
        }
        value = round(a * b)
        status = statusOf(exactProduct(wideA, wideB), value, format)
        if (inst.op === A64.FNMUL) value = -value
        break
      }
    }

    if (Number.isNaN(value)) return this.writeFp(inst.rd, this.defaultNan(size), size)
    if (this.needsStatus()) this.applyStatus(status)
    return this.writeFp(inst.rd, this.fromDouble(value, size), size)
  }

  /**
   * fmin and fmax propagate a NaN operand; fminnm and fmaxnm ignore one.
   *
   * The rule is narrower than it first appears, and the narrowness is the
   * whole content. The numeric forms substitute an infinity for a *quiet*
   * NaN, and only when it is the single one: a signalling NaN is still
   * propagated, and two quiet NaNs still propagate the first. An
   * implementation that treated "is a NaN" as the test is wrong on exactly
   * the operands a casual test does not try.
   */
  private minMax(si: A64StaticInst): void {
    const inst = si.inst
    const size = inst.fpSize
    let aBits = this.readFp(inst.rn, size)
    let bBits = this.readFp(inst.rm, size)
    const numeric = inst.op === A64.FMAXNM || inst.op === A64.FMINNM
    const wantMax = inst.op === A64.FMAX || inst.op === A64.FMAXNM

    if (numeric) {
      const aQuiet = this.isNan(aBits, size) && !this.isSignaling(aBits, size)
      const bQuiet = this.isNan(bBits, size) && !this.isSignaling(bBits, size)
      // The substituted infinity is the one that loses, so the other operand
      // is the answer.
      const losing = wantMax ? this.negativeInfinity(size) : this.positiveInfinity(size)
      if (aQuiet && !bQuiet) aBits = losing
      else if (bQuiet && !aQuiet) bBits = losing
    }

    const nan = this.processNans([aBits, bBits], size)
    if (nan !== null) return this.writeFp(inst.rd, nan, size)

    const a = this.asDouble(aBits, size)
    const b = this.asDouble(bBits, size)
    if (a === 0 && b === 0) {
      const aNegative = size === 8
        ? (aBits & SIGN64) !== 0n
        : (aBits & 0x80000000n) !== 0n
      const pick = wantMax ? (aNegative ? bBits : aBits) : (aNegative ? aBits : bBits)
      return this.writeFp(inst.rd, pick, size)
    }
    return this.writeFp(inst.rd, (wantMax ? a > b : a < b) ? aBits : bBits, size)
  }

  private positiveInfinity(size: number): bigint {
    return size === 8 ? 0x7ff0000000000000n : 0x7f800000n
  }

  private negativeInfinity(size: number): bigint {
    return size === 8 ? 0xfff0000000000000n : 0xff800000n
  }

  /**
   * A floating-point comparison writes the condition flags rather than a
   * register, and an unordered result is its own flag pattern rather than a
   * false: C and V both set, which no ordered comparison produces.
   */
  private compare(si: A64StaticInst, _unused: boolean): void {
    const inst = si.inst
    const size = inst.fpSize
    const aBits = this.readFp(inst.rn, size)
    // Bit 3 of the encoding's low field selects comparison against zero.
    const againstZero = (Number(inst.imm) & 0x08) !== 0
    const bBits = againstZero ? 0n : this.readFp(inst.rm, size)
    const signalling = (si.inst.raw & 0x10) !== 0

    const aNan = this.isNan(aBits, size)
    const bNan = this.isNan(bBits, size)
    if (aNan || bNan) {
      if (signalling || this.isSignaling(aBits, size) || this.isSignaling(bBits, size)) {
        this.flag(FpFlag.IOC)
      }
      this.flags = { n: false, z: false, c: true, v: true }
      return
    }
    const a = this.asDouble(aBits, size)
    const b = this.asDouble(bBits, size)
    if (a === b) this.flags = { n: false, z: true, c: true, v: false }
    else if (a < b) this.flags = { n: true, z: false, c: false, v: false }
    else this.flags = { n: false, z: false, c: true, v: false }
  }

  private fusedMultiplyAdd(si: A64StaticInst): void {
    const inst = si.inst
    const size = inst.fpSize
    const aBits = this.readFp(inst.rn, size)
    const bBits = this.readFp(inst.rm, size)
    const cBits = this.readFp(inst.ra, size)

    // The architecture defines these as addend + product, with the negations
    // applied to the *operands*:
    //   fmadd    a + n*m        fmsub    a + (-n)*m
    //   fnmadd  -a + (-n)*m     fnmsub  -a + n*m
    // RISC-V spells the same four names differently — there fnmsub negates
    // the product and fmsub the addend — so the mapping cannot be shared.
    const negateProduct = inst.op === A64.FMSUB || inst.op === A64.FNMADD
    const negateAddend = inst.op === A64.FNMADD || inst.op === A64.FNMSUB

    // The negations apply before anything else, so a propagated NaN is the
    // negated one. The order matters too: the architecture examines the
    // addend first and the two multiplicands after it.
    const signBit = size === 8 ? SIGN64 : 0x80000000n
    const flip = (bits: bigint): bigint => bits ^ signBit
    const nan = this.processNans(
      [negateAddend ? flip(cBits) : cBits, negateProduct ? flip(aBits) : aBits, bBits],
      size,
    )
    if (nan !== null) return this.writeFp(inst.rd, nan, size)

    const wide = (bits: bigint): bigint => f64ToBits(this.asDouble(bits, size))
    const first = negateProduct ? negateBits(wide(aBits)) : wide(aBits)
    const addend = negateAddend ? negateBits(wide(cBits)) : wide(cBits)
    const second = wide(bBits)

    const result = fusedMulAdd(first, second, addend, this.format(size))
    if (result === null) {
      this.flag(FpFlag.IOC)
      return this.writeFp(inst.rd, this.defaultNan(size), size)
    }
    if (this.needsStatus()) {
      const product = exactProduct(first, second)
      const c = exactOf(addend)
      if (product !== null && c !== null) {
        const scale = Math.min(product.e, c.e)
        this.applyStatus(statusOf(
          {
            m: (product.m << BigInt(product.e - scale)) + (c.m << BigInt(c.e - scale)),
            e: scale,
          },
          result,
          this.format(size),
        ))
      }
    }
    return this.writeFp(inst.rd, this.fromDouble(result, size), size)
  }

  /**
   * Float to integer. AArch64 converts a NaN to zero, where RISC-V converts
   * it to the maximum of the target type; both saturate out-of-range values
   * and raise invalid.
   */
  private floatToInt(si: A64StaticInst): void {
    const inst = si.inst
    const size = inst.fpSize
    const bits = this.readFp(inst.rn, size)
    const width = inst.sf ? 64 : 32
    const low = inst.signed ? -(1n << BigInt(width - 1)) : 0n
    const high = inst.signed ? (1n << BigInt(width - 1)) - 1n : (1n << BigInt(width)) - 1n

    if (this.isNan(bits, size)) {
      this.flag(FpFlag.IOC)
      return this.writeX(inst.rd, 0n, inst.sf ? 8 : 4)
    }
    const scaled = inst.fbits === 0
      ? this.asDouble(bits, size)
      : this.asDouble(bits, size) * 2 ** inst.fbits
    const value = scaled
    const rounded = roundToIntegralValue(value, inst.rounding)
    if (!Number.isFinite(rounded)) {
      this.flag(FpFlag.IOC)
      return this.writeX(inst.rd, rounded > 0 ? high : low, inst.sf ? 8 : 4)
    }
    const exact = BigInt(rounded)
    if (exact < low || exact > high) {
      this.flag(FpFlag.IOC)
      return this.writeX(inst.rd, exact < low ? low : high, inst.sf ? 8 : 4)
    }
    if (rounded !== value) this.flag(FpFlag.IXC)
    return this.writeX(inst.rd, exact, inst.sf ? 8 : 4)
  }

  private intToFloat(si: A64StaticInst): void {
    const inst = si.inst
    const width = inst.sf ? 8 : 4
    const raw = this.readXU(inst.rn, width)
    const value = inst.signed ? sext(raw, width * 8) : zext(raw, width * 8)
    // A fixed-point conversion divides by two to the fractional bit count,
    // which is exact and so cannot itself introduce a rounding error.
    const exact = Number(value) / (inst.fbits === 0 ? 1 : 2 ** inst.fbits)
    const converted = inst.fpSize === 8 ? exact : Math.fround(exact)
    if (this.needsStatus() && inst.fbits === 0 && BigInt(Math.trunc(converted)) !== value) {
      this.flag(FpFlag.IXC)
    }
    return this.writeFp(inst.rd, this.fromDouble(converted, inst.fpSize), inst.fpSize)
  }
}

function negateBits(bits: bigint): bigint {
  return BigInt.asUintN(64, bits ^ SIGN64)
}

/**
 * The architecture's AddWithCarry, which is the single primitive behind add,
 * subtract, compare and the carry-propagating forms. Subtraction is addition
 * of the inverted operand with a carry in, which is why borrow appears as a
 * *clear* carry flag rather than a set one.
 */
function addWithCarry(x: bigint, y: bigint, carryIn: boolean, width: number): {
  result: bigint
  flags: Flags
} {
  const bitsWide = BigInt(width * 8)
  const mask = (1n << bitsWide) - 1n
  const a = x & mask
  const b = y & mask
  const carry = carryIn ? 1n : 0n
  const unsignedSum = a + b + carry
  const result = unsignedSum & mask
  const signedSum = BigInt.asIntN(width * 8, a) + BigInt.asIntN(width * 8, b) + carry
  return {
    result,
    flags: {
      n: (result >> (bitsWide - 1n)) === 1n,
      z: result === 0n,
      c: unsignedSum > mask,
      v: BigInt.asIntN(width * 8, result) !== signedSum,
    },
  }
}

function nzcvOf(flags: Flags): number {
  return (
    (flags.n ? 0x80000000 : 0) |
    (flags.z ? 0x40000000 : 0) |
    (flags.c ? 0x20000000 : 0) |
    (flags.v ? 0x10000000 : 0)
  ) >>> 0
}

function flagsFromNzcv(value: number): Flags {
  return {
    n: (value & 0x80000000) !== 0,
    z: (value & 0x40000000) !== 0,
    c: (value & 0x20000000) !== 0,
    v: (value & 0x10000000) !== 0,
  }
}

/** The fourteen testable condition codes, plus the two that always hold. */
export function conditionHolds(cond: number, flags: Flags): boolean {
  const base = cond >> 1
  let result: boolean
  switch (base) {
    case 0: result = flags.z; break
    case 1: result = flags.c; break
    case 2: result = flags.n; break
    case 3: result = flags.v; break
    case 4: result = flags.c && !flags.z; break
    case 5: result = flags.n === flags.v; break
    case 6: result = flags.n === flags.v && !flags.z; break
    default: result = true; break
  }
  // The low bit inverts every condition except the always-true one.
  return (cond & 1) === 1 && cond !== 0b1111 ? !result : result
}

function oneSource(op: A64Op, value: bigint, width: number): bigint {
  const bitsWide = width * 8
  const masked = zext(value, bitsWide)
  switch (op) {
    case A64.RBIT: {
      let result = 0n
      for (let i = 0; i < bitsWide; i++) {
        if (((masked >> BigInt(i)) & 1n) === 1n) result |= 1n << BigInt(bitsWide - 1 - i)
      }
      return result
    }
    case A64.REV16: {
      let result = 0n
      for (let i = 0; i < bitsWide / 16; i++) {
        const half = (masked >> BigInt(i * 16)) & 0xffffn
        const swapped = ((half & 0xffn) << 8n) | (half >> 8n)
        result |= swapped << BigInt(i * 16)
      }
      return result
    }
    case A64.REV32: {
      let result = 0n
      for (let i = 0; i < bitsWide / 32; i++) {
        const word = (masked >> BigInt(i * 32)) & 0xffffffffn
        result |= reverseBytes(word, 4) << BigInt(i * 32)
      }
      return result
    }
    case A64.REV:
      return reverseBytes(masked, width)
    case A64.CLZ: {
      for (let i = bitsWide - 1; i >= 0; i--) {
        if (((masked >> BigInt(i)) & 1n) === 1n) return BigInt(bitsWide - 1 - i)
      }
      return BigInt(bitsWide)
    }
    default: {
      // CLS counts leading bits that match the sign, excluding the sign.
      const sign = (masked >> BigInt(bitsWide - 1)) & 1n
      let count = 0
      for (let i = bitsWide - 2; i >= 0; i--) {
        if (((masked >> BigInt(i)) & 1n) !== sign) break
        count += 1
      }
      return BigInt(count)
    }
  }
}

function reverseBytes(value: bigint, bytes: number): bigint {
  let result = 0n
  for (let i = 0; i < bytes; i++) {
    result = (result << 8n) | ((value >> BigInt(i * 8)) & 0xffn)
  }
  return result
}

function roundToIntegralValue(value: number, mode: number): number {
  const rounded = roundMagnitude(value, mode)
  // Rounding -0.4 towards zero gives -0, not +0. For a conversion to an
  // integer the distinction is invisible; for frint it is the answer.
  return rounded === 0 && (value < 0 || Object.is(value, -0)) ? -0 : rounded
}

function roundMagnitude(value: number, mode: number): number {
  switch (mode) {
    case Round.ZERO: return Math.trunc(value)
    case Round.NEG_INF: return Math.floor(value)
    case Round.POS_INF: return Math.ceil(value)
    case Round.NEAREST_AWAY: {
      const floor = Math.floor(value)
      const fraction = value - floor
      if (fraction > 0.5) return floor + 1
      if (fraction < 0.5) return floor
      return value < 0 ? floor : floor + 1
    }
    default: {
      const floor = Math.floor(value)
      const fraction = value - floor
      if (fraction > 0.5) return floor + 1
      if (fraction < 0.5) return floor
      return floor % 2 === 0 ? floor : floor + 1
    }
  }
}
