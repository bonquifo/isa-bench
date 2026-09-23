/**
 * POWER (powerpc64le) interpreter.
 *
 * Three things shape this file, and none of them is the instruction
 * count.
 *
 * ## The condition register is eight registers
 *
 * `cr` is eight independent four-bit fields, and every comparison names
 * which one it writes and every branch names which one it reads. So it
 * is stored as eight nibbles rather than one word, and the one word is
 * reassembled only where an instruction actually asks for it -- `mfcr`
 * and the state dump. Code here routinely has two conditions in flight,
 * and they are in different fields precisely so that neither waits.
 *
 * ## Carry is a register, not a flag
 *
 * `XER` holds the carry bit, and it is written by a specific handful of
 * instructions rather than as a side effect of arithmetic. `add` does
 * not touch it; `addc` sets it; `adde` reads *and* sets it. That is what
 * makes extended-precision arithmetic a chain through one resource, and
 * an implementation that set carry on every add would produce the right
 * answers and the wrong dependences.
 *
 * ## The floating-point registers are the top halves of the vector ones
 *
 * There is one register file here, not two. `f3` is the high doubleword
 * of `vs3` -- the same storage, which is why `lfd` into `f3` followed by
 * `xsadddp` on `vs3` is a dependence and not a coincidence. At `-O2`
 * clang emits the VSX forms for ordinary `double` arithmetic and never
 * emits `fadd` at all, so this is the common path rather than an
 * exotic one.
 */
import {
  ExecutionBudgetExceeded,
  IsaError,
  UnimplementedInstruction,
} from '../common/errors.ts'
import {
  F64,
  bitsToF32,
  bitsToF64,
  f32ToBits,
  f64ToBits,
  fusedMulAdd,
  isNan64,
} from '../common/fp.ts'
import { Sys, type LinuxSyscalls } from '../common/linux.ts'
import type { AccessWidth, GuestMemory } from '../common/memory.ts'
import { RunState, type ArchState, type Interpreter, type RetireChunk } from '../common/trace.ts'
import { File, ISA_NAME, PPC, type PpcInst } from './decode.ts'
import { Res, Spr, type PowerImage, type PowerStaticInst } from './image.ts'

const DEFAULT_BUDGET = 2_000_000_000

/**
 * PowerPC/Linux syscall numbers.
 *
 * Read out of the musl headers in the sysroot the fixtures are built
 * against, rather than recalled. Like SPARC and unlike the asm-generic
 * targets, this architecture numbers its calls from the classic Unix
 * table, so `write` is 4 rather than 64 and `exit_group` is 234 rather
 * than 94 -- close enough to the numbers of other architectures to look
 * right while being wrong.
 */
export const POWER_SYSCALL_NUMBERS: Readonly<Record<number, number>> = {
  1: Sys.EXIT,
  3: Sys.READ,
  4: Sys.WRITE,
  6: Sys.CLOSE,
  19: Sys.LSEEK,
  20: Sys.GETPID,
  24: Sys.GETUID,
  45: Sys.BRK,
  47: Sys.GETGID,
  49: Sys.GETEUID,
  50: Sys.GETEGID,
  54: Sys.IOCTL,
  90: Sys.MMAP,
  91: Sys.MUNMAP,
  125: Sys.MPROTECT,
  146: Sys.WRITEV,
  173: Sys.RT_SIGACTION,
  174: Sys.RT_SIGPROCMASK,
  205: Sys.MADVISE,
  207: Sys.GETTID,
  232: Sys.SET_TID_ADDRESS,
  234: Sys.EXIT_GROUP,
  246: Sys.CLOCK_GETTIME,
  286: Sys.OPENAT,
  296: Sys.READLINKAT,
  298: Sys.FACCESSAT,
  300: Sys.SET_ROBUST_LIST,
  325: Sys.PRLIMIT64,
  359: Sys.GETRANDOM,
  387: Sys.RSEQ,
}

/** Bits of a condition-register field, most significant first. */
const LT = 8
const GT = 4
const EQ = 2
const SO = 1

export interface PowerOptions {
  instructionBudget?: number
  linux?: LinuxSyscalls
  syscallNumbers?: Readonly<Record<number, number>>
}

/** A 128-bit register as its two doublewords, element 0 first. */
type Vector = readonly [bigint, bigint]

const M32 = 0xffff_ffffn
const M64 = 0xffff_ffff_ffff_ffffn
const ZERO_VECTOR: Vector = [0n, 0n]

/** The four words, leftmost first. */
function toWords(v: Vector): bigint[] {
  return [v[0] >> 32n, v[0] & M32, v[1] >> 32n, v[1] & M32]
}

function fromWords(words: readonly bigint[]): Vector {
  const w = words.map((word) => BigInt.asUintN(32, word))
  return [(w[0]! << 32n) | w[1]!, (w[2]! << 32n) | w[3]!]
}

/** The sixteen bytes, leftmost first. */
function toBytes(v: Vector): number[] {
  const out: number[] = []
  for (const half of v) {
    for (let i = 7; i >= 0; i--) out.push(Number((half >> BigInt(i * 8)) & 0xffn))
  }
  return out
}

function fromBytes(bytes: readonly number[]): Vector {
  let hi = 0n
  let lo = 0n
  for (let i = 0; i < 8; i++) hi = (hi << 8n) | BigInt(bytes[i]!)
  for (let i = 8; i < 16; i++) lo = (lo << 8n) | BigInt(bytes[i]!)
  return [hi, lo]
}

/** Applies an operation word by word, keeping the low 32 bits of each. */
function mapWords(a: Vector, b: Vector, f: (x: bigint, y: bigint) => bigint): Vector {
  const x = toWords(a)
  const y = toWords(b)
  return fromWords(x.map((value, i) => f(value, y[i]!)))
}

/** The same, by doubleword. */
function mapDoublewords(a: Vector, b: Vector, f: (x: bigint, y: bigint) => bigint): Vector {
  return [BigInt.asUintN(64, f(a[0], b[0])), BigInt.asUintN(64, f(a[1], b[1]))]
}

export class PowerInterpreter implements Interpreter {
  readonly image: PowerImage
  private readonly memory: GuestMemory
  private readonly linux: LinuxSyscalls | null
  private readonly numbers: Readonly<Record<number, number>>

  readonly gpr64 = new BigUint64Array(32)
  /**
   * The vector-scalar registers, as two halves.
   *
   * `vsrHi[n]` is doubleword 0, which is where a scalar double lives
   * and which *is* floating-point register n. Splitting them rather
   * than keeping 128-bit values means the scalar path -- which is all
   * the corpus uses -- never assembles a wide value it does not need.
   */
  readonly vsrHi = new BigUint64Array(64)
  readonly vsrLo = new BigUint64Array(64)
  /** Eight four-bit fields, one per resource. */
  readonly cr = new Uint8Array(8)

  lr = 0n
  ctr = 0n
  /** Carry, overflow and the sticky summary, which together are XER. */
  ca = false
  ov = false
  so = false
  /**
   * The same two bits again, for the low 32 of the result.
   *
   * POWER ISA 3.0 added `CA32` and `OV32`, which say what carry and
   * overflow would have been had the operation been 32 bits wide. They
   * are set by the same instructions as their 64-bit counterparts and
   * are visible in XER, so a backend that ignored them would differ
   * from the reference on the first `addc` it executed -- which is what
   * happened.
   */
  ca32 = false
  ov32 = false

  pc = 0n
  exitCode = 0
  retired = 0

  private exited = false
  private next = 0n
  private access = 0n
  private accessWidth = 0
  private taken = 0
  private readonly budget: number

  constructor(image: PowerImage, memory: GuestMemory, options: PowerOptions = {}) {
    this.image = image
    this.memory = memory
    this.linux = options.linux ?? null
    this.numbers = options.syscallNumbers ?? POWER_SYSCALL_NUMBERS
    this.budget = options.instructionBudget ?? DEFAULT_BUDGET
    this.pc = image.entry
  }

  // ---------------------------------------------------------------------
  // The Interpreter contract.
  // ---------------------------------------------------------------------

  get programCounter(): bigint {
    return this.pc
  }

  /**
   * r0..r31, then lr, ctr, xer, and the eight condition fields.
   *
   * The condition register is reported one field at a time rather than
   * packed, so that a mismatch says which condition differs -- and so
   * that the timing model and the comparison share one set of ids.
   */
  gpr(index: number): bigint {
    if (index < 32) return this.gpr64[index]!
    if (index >= Res.CR && index < Res.CR + 8) return BigInt(this.cr[index - Res.CR]!)
    switch (index) {
      case Res.LR: return this.lr
      case Res.CTR: return this.ctr
      case Res.XER: return this.packedXer()
      default: return 0n
    }
  }

  setGpr(index: number, value: bigint): void {
    const v = BigInt.asUintN(64, value)
    if (index < 32) { this.gpr64[index] = v; return }
    if (index >= Res.CR && index < Res.CR + 8) {
      this.cr[index - Res.CR] = Number(v & 0xfn)
      return
    }
    switch (index) {
      case Res.LR: this.lr = v; break
      case Res.CTR: this.ctr = v; break
      case Res.XER: this.unpackXer(v); break
      default: break
    }
  }

  packedCr(): number {
    let value = 0
    for (let f = 0; f < 8; f++) value |= (this.cr[f]! & 0xf) << (28 - f * 4)
    return value >>> 0
  }

  /** XER as the architecture lays it out: SO, OV, CA at the top. */
  packedXer(): bigint {
    return (this.so ? 1n << 31n : 0n) | (this.ov ? 1n << 30n : 0n) |
      (this.ca ? 1n << 29n : 0n) |
      (this.ov32 ? 1n << 19n : 0n) | (this.ca32 ? 1n << 18n : 0n)
  }

  private unpackXer(value: bigint): void {
    this.so = (value & (1n << 31n)) !== 0n
    this.ov = (value & (1n << 30n)) !== 0n
    this.ca = (value & (1n << 29n)) !== 0n
    this.ov32 = (value & (1n << 19n)) !== 0n
    this.ca32 = (value & (1n << 18n)) !== 0n
  }

  /** Records carry for both widths from one wide sum. */
  private setCarry(a: bigint, b: bigint, carryIn: bigint): void {
    this.ca = (a + b + carryIn) > 0xffff_ffff_ffff_ffffn
    this.ca32 = (BigInt.asUintN(32, a) + BigInt.asUintN(32, b) + carryIn) > 0xffff_ffffn
  }

  finalState(): ArchState {
    const gpr: bigint[] = []
    for (let r = 0; r < 32; r++) gpr.push(this.gpr64[r]!)
    const fpr: bigint[] = []
    // The floating-point registers are the high halves, which is what a
    // guest dumping `f0..f31` writes out.
    for (let f = 0; f < 32; f++) fpr.push(this.vsrHi[f]!)
    return {
      gpr,
      fpr,
      status: {
        lr: this.lr,
        ctr: this.ctr,
        cr: BigInt(this.packedCr()),
        xer: this.packedXer(),
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
      this.next = BigInt.asUintN(64, pc + 4n)
      this.execute(si)
      into.pc[n] = BigInt.asIntN(64, pc)
      into.nextPc[n] = BigInt.asIntN(64, this.next)
      into.effAddr[n] = BigInt.asIntN(64, this.access)
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

  // ---------------------------------------------------------------------
  // Registers.
  // ---------------------------------------------------------------------

  /**
   * A base register, where r0 means the number zero rather than the
   * register.
   *
   * Only in the addressing forms and in `addi`, not everywhere: `add
   * r3, r0, r4` really does read r0. Getting this wrong makes every
   * access to a global go to the wrong address once the linker starts
   * using r0 as scratch.
   */
  private base(r: number): bigint {
    return r === 0 ? 0n : this.gpr64[r]!
  }

  private setReg(r: number, value: bigint): void {
    this.gpr64[r] = BigInt.asUintN(64, value)
  }

  // ---------------------------------------------------------------------
  // The condition register.
  // ---------------------------------------------------------------------

  /** Writes a field from a signed comparison against zero. */
  private recordField(field: number, value: bigint, is32: boolean): void {
    const v = is32 ? BigInt.asIntN(32, value) : BigInt.asIntN(64, value)
    this.cr[field] = (v < 0n ? LT : v > 0n ? GT : EQ) | (this.so ? SO : 0)
  }

  private compare(field: number, a: bigint, b: bigint): void {
    this.cr[field] = (a < b ? LT : a > b ? GT : EQ) | (this.so ? SO : 0)
  }

  /** One bit of the condition register, by its index across all 32. */
  private crBit(index: number): number {
    return (this.cr[index >> 2]! >> (3 - (index & 3))) & 1
  }

  private setCrBit(index: number, value: number): void {
    const field = index >> 2
    const bit = 1 << (3 - (index & 3))
    this.cr[field] = value !== 0
      ? (this.cr[field]! | bit)
      : (this.cr[field]! & ~bit) & 0xf
  }

  // ---------------------------------------------------------------------
  // Masks. The rotate instructions are how this architecture shifts,
  // extracts and inserts, and the mask is given as two boundaries that
  // may be the wrong way round -- which means the mask wraps.
  // ---------------------------------------------------------------------

  private static mask64(mb: number, me: number): bigint {
    let mask = 0n
    if (mb <= me) {
      for (let i = mb; i <= me; i++) mask |= 1n << BigInt(63 - i)
    } else {
      for (let i = mb; i <= 63; i++) mask |= 1n << BigInt(63 - i)
      for (let i = 0; i <= me; i++) mask |= 1n << BigInt(63 - i)
    }
    return mask
  }

  private static rotl32(value: number, by: number): number {
    const n = by & 31
    return n === 0 ? value >>> 0 : (((value << n) | (value >>> (32 - n))) >>> 0)
  }

  /**
   * The element-wise vector operations.
   *
   * Every one of these is defined in the architecture's own element
   * numbering, which is big-endian whatever the machine's byte order:
   * element 0 is the leftmost word of the register, and that is
   * doubleword 0, which is `vsrHi`. The byte order of the machine only
   * affects how a register meets memory -- the loads and stores above --
   * and a little-endian compiler compensates for it there, with swaps and
   * inverted permute controls, rather than by any of these meaning
   * something different.
   */
  private vector(inst: PpcInst): void {
    const a = inst.ra >= 0 ? this.readVector(inst.ra) : ZERO_VECTOR
    const b = inst.rb >= 0 ? this.readVector(inst.rb) : ZERO_VECTOR
    let result: Vector

    switch (inst.op) {
      case PPC.VADDUWM: result = mapWords(a, b, (x, y) => x + y); break
      case PPC.VSUBUWM: result = mapWords(a, b, (x, y) => x - y); break
      // The low half of each product; the high half is a different
      // instruction.
      case PPC.VMULUWM: result = mapWords(a, b, (x, y) => x * y); break
      // Each element shifts by its own amount, taken modulo the width.
      case PPC.VSLW: result = mapWords(a, b, (x, y) => x << (y & 31n)); break
      case PPC.VSRW: result = mapWords(a, b, (x, y) => x >> (y & 31n)); break
      case PPC.VSRAW:
        result = mapWords(a, b, (x, y) => BigInt.asIntN(32, x) >> (y & 31n))
        break
      case PPC.VCMPEQUW: result = mapWords(a, b, (x, y) => (x === y ? M32 : 0n)); break
      case PPC.VCMPGTUW: result = mapWords(a, b, (x, y) => (x > y ? M32 : 0n)); break

      case PPC.VADDUDM: result = mapDoublewords(a, b, (x, y) => x + y); break
      case PPC.VSUBUDM: result = mapDoublewords(a, b, (x, y) => x - y); break
      case PPC.VSLD: result = mapDoublewords(a, b, (x, y) => x << (y & 63n)); break
      case PPC.VSRAD:
        result = mapDoublewords(a, b, (x, y) => BigInt.asIntN(64, x) >> (y & 63n))
        break
      case PPC.VCMPEQUD: result = mapDoublewords(a, b, (x, y) => (x === y ? M64 : 0n)); break
      case PPC.VCMPGTUD: result = mapDoublewords(a, b, (x, y) => (x > y ? M64 : 0n)); break

      case PPC.VPKUDUM:
        // The low word of each doubleword, A's two then B's two.
        result = fromWords([a[0] & M32, a[1] & M32, b[0] & M32, b[1] & M32])
        break
      case PPC.VUPKLSW:
        // "Low" is elements 2 and 3 in this numbering, sign-extended.
        result = [
          BigInt.asUintN(64, BigInt.asIntN(32, b[1] >> 32n)),
          BigInt.asUintN(64, BigInt.asIntN(32, b[1] & M32)),
        ]
        break
      case PPC.VPERM: {
        // Each result byte is chosen from the thirty-two bytes of A then
        // B, by the low five bits of the matching control byte.
        const control = toBytes(this.readVector(inst.rc))
        const source = [...toBytes(a), ...toBytes(b)]
        result = fromBytes(control.map((selector) => source[selector & 31]!))
        break
      }

      case PPC.XXMRGHW: {
        const [a0, a1] = toWords(a)
        const [b0, b1] = toWords(b)
        result = fromWords([a0!, b0!, a1!, b1!])
        break
      }
      case PPC.XXMRGLW: {
        const [, , a2, a3] = toWords(a)
        const [, , b2, b3] = toWords(b)
        result = fromWords([a2!, b2!, a3!, b3!])
        break
      }
      case PPC.XXSLDWI: {
        // The eight words of A then B, and four of them starting at the
        // shift. With a shift of zero this is a copy of A.
        const joined = [...toWords(a), ...toWords(b)]
        const shift = Number(inst.imm)
        result = fromWords(joined.slice(shift, shift + 4))
        break
      }
      case PPC.XXSEL: {
        // B where the mask is set, A where it is not.
        const c = this.readVector(inst.rc)
        result = [(a[0] & ~c[0]) | (b[0] & c[0]), (a[1] & ~c[1]) | (b[1] & c[1])]
        break
      }
      case PPC.XXSPLTW: {
        const word = toWords(b)[Number(inst.imm)]!
        result = fromWords([word, word, word, word])
        break
      }
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, this.pc, wordBytes(inst.word),
          `vector operation ${inst.op} has no semantics`,
        )
    }

    this.vsrHi[inst.rd] = BigInt.asUintN(64, result[0])
    this.vsrLo[inst.rd] = BigInt.asUintN(64, result[1])
  }

  private readVector(index: number): Vector {
    return [this.vsrHi[index]!, this.vsrLo[index]!]
  }

  private static rotl64(value: bigint, by: number): bigint {
    const n = BigInt(by & 63)
    if (n === 0n) return value
    return BigInt.asUintN(64, (value << n) | (value >> (64n - n)))
  }

  // ---------------------------------------------------------------------
  // Memory.
  // ---------------------------------------------------------------------

  private effective(inst: PpcInst): bigint {
    const base = inst.op === PPC.LOADU || inst.op === PPC.LOADUX ||
      inst.op === PPC.STOREU || inst.op === PPC.STOREUX
      // The update forms always use the register, never zero, because
      // they have to write it back.
      ? this.gpr64[inst.ra]!
      : this.base(inst.ra)
    const offset = inst.rb >= 0 ? this.gpr64[inst.rb]! : inst.imm
    const address = BigInt.asUintN(64, base + offset)
    this.access = address
    this.accessWidth = inst.width
    return address
  }

  // ---------------------------------------------------------------------

  private execute(si: PowerStaticInst): void {
    const inst = si.inst
    switch (inst.op) {
      // ---- Fixed-point arithmetic ------------------------------------
      case PPC.ADDI:
        this.setReg(inst.rd, this.base(inst.ra) + inst.imm)
        return
      case PPC.ADDIS:
        this.setReg(inst.rd, this.base(inst.ra) + (inst.imm << 16n))
        return
      case PPC.ADDIC: {
        const a = this.gpr64[inst.ra]!
        const b = BigInt.asUintN(64, inst.imm)
        this.setCarry(a, b, 0n)
        const result = BigInt.asUintN(64, a + b)
        this.setReg(inst.rd, result)
        if (inst.recordCr) this.recordField(0, result, false)
        return
      }
      case PPC.SUBFIC: {
        const a = BigInt.asUintN(64, ~this.gpr64[inst.ra]!)
        const b = BigInt.asUintN(64, inst.imm)
        this.setCarry(a, b, 1n)
        this.setReg(inst.rd, a + b + 1n)
        return
      }
      case PPC.MULLI:
        this.setReg(inst.rd, this.gpr64[inst.ra]! * inst.imm)
        return

      case PPC.ADD: case PPC.ADDC: case PPC.ADDE:
      case PPC.ADDME: case PPC.ADDZE: {
        const a = this.gpr64[inst.ra]!
        const b =
          inst.op === PPC.ADDME ? 0xffff_ffff_ffff_ffffn :
          inst.op === PPC.ADDZE ? 0n :
          this.gpr64[inst.rb]!
        const carry = inst.op === PPC.ADDE || inst.op === PPC.ADDME ||
          inst.op === PPC.ADDZE ? (this.ca ? 1n : 0n) : 0n
        const wide = a + b + carry
        const result = BigInt.asUintN(64, wide)
        if (inst.op !== PPC.ADD) this.setCarry(a, b, carry)
        this.finishArithmetic(inst, result, signedOverflowAdd(a, b, result))
        return
      }
      case PPC.SUBF: case PPC.SUBFC: case PPC.SUBFE:
      case PPC.SUBFME: case PPC.SUBFZE: {
        // Every one of these is "the second operand minus the first",
        // which is the opposite order from the name and is why `sub` is
        // a synonym with its operands swapped.
        const a = this.gpr64[inst.ra]!
        const b =
          inst.op === PPC.SUBFME ? 0xffff_ffff_ffff_ffffn :
          inst.op === PPC.SUBFZE ? 0n :
          this.gpr64[inst.rb]!
        const carry = inst.op === PPC.SUBFE || inst.op === PPC.SUBFME ||
          inst.op === PPC.SUBFZE ? (this.ca ? 1n : 0n) : 1n
        const complement = BigInt.asUintN(64, ~a)
        const wide = complement + b + carry
        const result = BigInt.asUintN(64, wide)
        if (inst.op !== PPC.SUBF) this.setCarry(complement, b, carry)
        this.finishArithmetic(inst, result, signedOverflowAdd(complement, b, result))
        return
      }
      case PPC.NEG: {
        const a = this.gpr64[inst.ra]!
        const result = BigInt.asUintN(64, ~a + 1n)
        this.finishArithmetic(inst, result, a === 1n << 63n)
        return
      }

      case PPC.MULLW: {
        const a = BigInt.asIntN(32, this.gpr64[inst.ra]!)
        const b = BigInt.asIntN(32, this.gpr64[inst.rb]!)
        this.finishArithmetic(inst, BigInt.asUintN(64, a * b), false)
        return
      }
      case PPC.MULLD:
        this.finishArithmetic(inst,
          BigInt.asUintN(64, this.gpr64[inst.ra]! * this.gpr64[inst.rb]!), false)
        return
      case PPC.MULHW: case PPC.MULHWU: {
        const signed = inst.op === PPC.MULHW
        const a = signed ? BigInt.asIntN(32, this.gpr64[inst.ra]!)
          : BigInt.asUintN(32, this.gpr64[inst.ra]!)
        const b = signed ? BigInt.asIntN(32, this.gpr64[inst.rb]!)
          : BigInt.asUintN(32, this.gpr64[inst.rb]!)
        // The high half of a 32x32 product, placed in the low word and
        // then sign- or zero-extended like any other 32-bit result.
        const high = BigInt.asUintN(32, (a * b) >> 32n)
        this.finishArithmetic(inst, BigInt.asUintN(64, high), false)
        return
      }
      case PPC.MULHD: case PPC.MULHDU: {
        const signed = inst.op === PPC.MULHD
        const a = signed ? BigInt.asIntN(64, this.gpr64[inst.ra]!) : this.gpr64[inst.ra]!
        const b = signed ? BigInt.asIntN(64, this.gpr64[inst.rb]!) : this.gpr64[inst.rb]!
        this.finishArithmetic(inst, BigInt.asUintN(64, (a * b) >> 64n), false)
        return
      }
      case PPC.DIVW: case PPC.DIVWU: case PPC.DIVD: case PPC.DIVDU: {
        const wide = inst.op === PPC.DIVD || inst.op === PPC.DIVDU
        const signed = inst.op === PPC.DIVW || inst.op === PPC.DIVD
        const bits = wide ? 64 : 32
        const a = signed ? BigInt.asIntN(bits, this.gpr64[inst.ra]!)
          : BigInt.asUintN(bits, this.gpr64[inst.ra]!)
        const b = signed ? BigInt.asIntN(bits, this.gpr64[inst.rb]!)
          : BigInt.asUintN(bits, this.gpr64[inst.rb]!)
        // Division by zero, and the one signed case that has no answer,
        // are architecturally undefined in the result register rather
        // than a trap. The overflow bit is what says so.
        if (b === 0n || (signed && a === -(1n << BigInt(bits - 1)) && b === -1n)) {
          this.finishArithmetic(inst, 0n, true)
          return
        }
        let quotient = a / b
        if (!wide) quotient = BigInt.asUintN(32, quotient)
        this.finishArithmetic(inst, BigInt.asUintN(64, quotient), false)
        return
      }

      // ---- Logic ------------------------------------------------------
      case PPC.AND: case PPC.ANDC: case PPC.OR: case PPC.ORC:
      case PPC.XOR: case PPC.NAND: case PPC.NOR: case PPC.EQV: {
        const a = this.gpr64[inst.rd]!
        const raw = this.gpr64[inst.rb]!
        const b = inst.op === PPC.ANDC || inst.op === PPC.ORC
          ? BigInt.asUintN(64, ~raw) : raw
        let result: bigint
        switch (inst.op) {
          case PPC.AND: case PPC.ANDC: result = a & b; break
          case PPC.OR: case PPC.ORC: result = a | b; break
          case PPC.XOR: result = a ^ b; break
          case PPC.NAND: result = BigInt.asUintN(64, ~(a & b)); break
          case PPC.NOR: result = BigInt.asUintN(64, ~(a | b)); break
          default: result = BigInt.asUintN(64, ~(a ^ b)); break
        }
        this.setReg(inst.ra, result)
        if (inst.recordCr) this.recordField(0, result, false)
        return
      }
      case PPC.ORI: case PPC.ORIS: case PPC.XORI: case PPC.XORIS:
      case PPC.ANDI: case PPC.ANDIS: {
        const a = this.gpr64[inst.rd]!
        const shifted = inst.op === PPC.ORIS || inst.op === PPC.XORIS ||
          inst.op === PPC.ANDIS ? inst.imm << 16n : inst.imm
        const result =
          inst.op === PPC.ORI || inst.op === PPC.ORIS ? a | shifted :
          inst.op === PPC.XORI || inst.op === PPC.XORIS ? a ^ shifted :
          a & shifted
        this.setReg(inst.ra, BigInt.asUintN(64, result))
        if (inst.recordCr) this.recordField(0, BigInt.asUintN(64, result), false)
        return
      }
      case PPC.EXTSB: case PPC.EXTSH: case PPC.EXTSW: {
        const bits = inst.op === PPC.EXTSB ? 8 : inst.op === PPC.EXTSH ? 16 : 32
        const result = BigInt.asUintN(64, BigInt.asIntN(bits, this.gpr64[inst.rd]!))
        this.setReg(inst.ra, result)
        if (inst.recordCr) this.recordField(0, result, false)
        return
      }
      case PPC.CNTLZW: case PPC.CNTLZD: case PPC.CNTTZD:
      case PPC.POPCNTW: case PPC.POPCNTD: {
        const value = this.gpr64[inst.rd]!
        let result: bigint
        switch (inst.op) {
          case PPC.CNTLZW: result = countLeadingZeros(BigInt.asUintN(32, value), 32); break
          case PPC.CNTLZD: result = countLeadingZeros(value, 64); break
          case PPC.CNTTZD: result = countTrailingZeros(value, 64); break
          case PPC.POPCNTW: result = popcount(BigInt.asUintN(32, value)); break
          default: result = popcount(value); break
        }
        this.setReg(inst.ra, result)
        if (inst.recordCr) this.recordField(0, result, false)
        return
      }

      // ---- Shifts and rotates -----------------------------------------
      case PPC.SLW: case PPC.SRW: case PPC.SLD: case PPC.SRD: {
        const wide = inst.op === PPC.SLD || inst.op === PPC.SRD
        const amount = this.gpr64[inst.rb]! & (wide ? 0x7fn : 0x3fn)
        const value = wide ? this.gpr64[inst.rd]! : BigInt.asUintN(32, this.gpr64[inst.rd]!)
        const limit = wide ? 64n : 32n
        // A shift by more than the width gives zero rather than
        // wrapping, which is why the amount field is one bit wider than
        // it needs to be.
        const result = amount >= limit ? 0n
          : inst.op === PPC.SLW || inst.op === PPC.SLD
            ? BigInt.asUintN(Number(limit), value << amount)
            : value >> amount
        this.setReg(inst.ra, BigInt.asUintN(64, result))
        if (inst.recordCr) this.recordField(0, BigInt.asUintN(64, result), false)
        return
      }
      case PPC.SRAW: case PPC.SRAWI: case PPC.SRAD: case PPC.SRADI: {
        const wide = inst.op === PPC.SRAD || inst.op === PPC.SRADI
        const immediate = inst.op === PPC.SRAWI || inst.op === PPC.SRADI
        const amount = immediate ? BigInt(inst.shift)
          : this.gpr64[inst.rb]! & (wide ? 0x7fn : 0x3fn)
        const bits = wide ? 64 : 32
        const value = BigInt.asIntN(bits, this.gpr64[inst.rd]!)
        const limit = BigInt(bits)
        const shift = amount >= limit ? limit - 1n : amount
        const result = value >> shift
        // Carry is set when a one was shifted out of a negative value,
        // which is what makes this a division that rounds toward zero
        // once the caller adds the carry back.
        this.ca = value < 0n && (value & ((1n << shift) - 1n)) !== 0n
        this.ca32 = this.ca
        const stored = BigInt.asUintN(64, wide ? result : BigInt.asIntN(32, result))
        this.setReg(inst.ra, stored)
        if (inst.recordCr) this.recordField(0, stored, false)
        return
      }
      case PPC.RLWINM: case PPC.RLWNM: case PPC.RLWIMI: {
        const amount = inst.shift >= 0 ? inst.shift : Number(this.gpr64[inst.rb]! & 31n)
        // `ROTL32` is not a 32-bit operation with a 32-bit result. It
        // rotates the low word and delivers it in *both* halves of a
        // 64-bit value, and the mask is then MASK(MB + 32, ME + 32)
        // over all 64 bits. When MB is greater than ME that mask wraps
        // through bit zero and so covers the whole high half -- which
        // is how a `rlwinm` can write sixty-four bits at once.
        //
        // Confining the mask to the low word gets the common case
        // right and this one wrong, and the common case is much more
        // common, so it survives a long way before failing.
        const word = BigInt(PowerInterpreter.rotl32(
          Number(BigInt.asUintN(32, this.gpr64[inst.rd]!)), amount))
        const rotated = (word << 32n) | word
        const mask = PowerInterpreter.mask64(inst.maskBegin + 32, inst.maskEnd + 32)
        const kept = inst.op === PPC.RLWIMI
          ? BigInt.asUintN(64, this.gpr64[inst.ra]! & ~mask)
          : 0n
        const result = BigInt.asUintN(64, (rotated & mask) | kept)
        this.setReg(inst.ra, result)
        if (inst.recordCr) this.recordField(0, result, false)
        return
      }
      case PPC.RLDICL: case PPC.RLDICR: case PPC.RLDIC:
      case PPC.RLDIMI: case PPC.RLDCL: case PPC.RLDCR: {
        const amount = inst.shift >= 0 ? inst.shift : Number(this.gpr64[inst.rb]! & 63n)
        const rotated = PowerInterpreter.rotl64(this.gpr64[inst.rd]!, amount)
        // `rldic` and `rldimi` end their mask where the shift left off,
        // which is how they insert a field without disturbing what is
        // above it.
        const end = inst.op === PPC.RLDIC || inst.op === PPC.RLDIMI
          ? 63 - amount : inst.maskEnd
        const begin = inst.op === PPC.RLDICR ? 0 : inst.maskBegin
        const mask = PowerInterpreter.mask64(begin,
          inst.op === PPC.RLDICR ? inst.maskEnd : end)
        const kept = inst.op === PPC.RLDIMI
          ? BigInt.asUintN(64, this.gpr64[inst.ra]! & ~mask) : 0n
        const result = BigInt.asUintN(64, (rotated & mask) | kept)
        this.setReg(inst.ra, result)
        if (inst.recordCr) this.recordField(0, result, false)
        return
      }

      // ---- Comparison and selection -----------------------------------
      case PPC.CMP: case PPC.CMPI: {
        const a = inst.is32 ? BigInt.asIntN(32, this.gpr64[inst.ra]!)
          : BigInt.asIntN(64, this.gpr64[inst.ra]!)
        const b = inst.op === PPC.CMPI ? inst.imm
          : inst.is32 ? BigInt.asIntN(32, this.gpr64[inst.rb]!)
            : BigInt.asIntN(64, this.gpr64[inst.rb]!)
        this.compare(inst.crField, a, b)
        return
      }
      case PPC.CMPL: case PPC.CMPLI: {
        const a = inst.is32 ? BigInt.asUintN(32, this.gpr64[inst.ra]!) : this.gpr64[inst.ra]!
        const b = inst.op === PPC.CMPLI ? inst.imm
          : inst.is32 ? BigInt.asUintN(32, this.gpr64[inst.rb]!) : this.gpr64[inst.rb]!
        this.compare(inst.crField, a, b)
        return
      }
      case PPC.ISEL:
        this.setReg(inst.rd, this.crBit(inst.bi) !== 0
          ? this.base(inst.ra) : this.gpr64[inst.rb]!)
        return

      case PPC.CRAND: case PPC.CROR: case PPC.CRXOR: case PPC.CRNAND:
      case PPC.CRNOR: case PPC.CREQV: case PPC.CRANDC: case PPC.CRORC: {
        const a = this.crBit(inst.ra)
        const b = this.crBit(inst.rb)
        let value: number
        switch (inst.op) {
          case PPC.CRAND: value = a & b; break
          case PPC.CROR: value = a | b; break
          case PPC.CRXOR: value = a ^ b; break
          case PPC.CRNAND: value = 1 - (a & b); break
          case PPC.CRNOR: value = 1 - (a | b); break
          case PPC.CREQV: value = 1 - (a ^ b); break
          case PPC.CRANDC: value = a & (1 - b); break
          default: value = a | (1 - b); break
        }
        this.setCrBit(inst.rd, value)
        return
      }
      case PPC.MCRF:
        this.cr[inst.rd >> 2] = this.cr[inst.ra >> 2]!
        return
      case PPC.MFCR: {
        // Each mask bit selects one four-bit field, cr0 in the top bit.
        const mask = Number(inst.imm)
        let keep = 0
        for (let f = 0; f < 8; f++) {
          if ((mask >> (7 - f)) & 1) keep |= 0xf << (28 - f * 4)
        }
        this.setReg(inst.rd, BigInt((this.packedCr() & keep) >>> 0))
        return
      }
      case PPC.MTCRF: {
        const value = Number(BigInt.asUintN(32, this.gpr64[inst.rd]!))
        const mask = Number(inst.imm)
        for (let f = 0; f < 8; f++) {
          if ((mask >> (7 - f)) & 1) this.cr[f] = (value >>> (28 - f * 4)) & 0xf
        }
        return
      }

      // ---- Branches ----------------------------------------------------
      case PPC.B:
        if (inst.link) this.lr = BigInt.asUintN(64, this.pc + 4n)
        this.next = inst.target
        this.taken = 1
        return
      case PPC.BC: case PPC.BCLR: case PPC.BCCTR: {
        // BO is five bits, read most significant first. Bit 0 says the
        // condition is not tested, bit 1 is the value to test for, bit 2
        // says the counter is not decremented, and bit 3 is what the
        // counter is compared against.
        const bo = inst.bo
        let counterOk = true
        if ((bo & 0x10) === 0 || (bo & 0x04) === 0) {
          // The counter is decremented unless bit 2 says otherwise, and
          // `bcctr` never decrements it because it is reading it.
          if ((bo & 0x04) === 0 && inst.op !== PPC.BCCTR) {
            this.ctr = BigInt.asUintN(64, this.ctr - 1n)
            counterOk = (this.ctr !== 0n) !== ((bo & 0x02) !== 0)
          }
        }
        const conditionOk = (bo & 0x10) !== 0 ||
          this.crBit(inst.bi) === ((bo & 0x08) !== 0 ? 1 : 0)
        const target = inst.op === PPC.BC ? inst.target
          : inst.op === PPC.BCLR ? (this.lr & ~3n)
            : (this.ctr & ~3n)
        // The link register is written whether or not the branch is
        // taken, which is what makes the "call that might not happen"
        // idiom work.
        if (inst.link) this.lr = BigInt.asUintN(64, this.pc + 4n)
        if (counterOk && conditionOk) {
          this.next = BigInt.asUintN(64, target)
          this.taken = 1
        }
        return
      }
      case PPC.SC:
        this.syscall()
        return
      case PPC.TRAP:
        throw new IsaError(`${ISA_NAME}: trap at 0x${this.pc.toString(16)}`)

      // ---- Special registers -------------------------------------------
      case PPC.MFSPR:
        this.setReg(inst.rd, this.readSpr(inst.spr))
        return
      case PPC.MTSPR:
        this.writeSpr(inst.spr, this.gpr64[inst.rd]!)
        return

      // ---- Memory -------------------------------------------------------
      case PPC.LOAD: case PPC.LOADU: case PPC.LOADX: case PPC.LOADUX: {
        const address = this.effective(inst)
        if (inst.destFile === File.FPR) {
          const raw = this.memory.load(address, inst.width as AccessWidth, false)
          // A single-precision load is widened on the way in, because
          // the register only holds doubles.
          this.vsrHi[inst.rd] = inst.width === 4
            ? f64ToBits(bitsToF32(Number(raw)))
            : raw
        } else {
          this.setReg(inst.rd,
            this.memory.load(address, inst.width as AccessWidth, inst.signed))
        }
        if (inst.op === PPC.LOADU || inst.op === PPC.LOADUX) this.setReg(inst.ra, address)
        return
      }
      case PPC.STORE: case PPC.STOREU: case PPC.STOREX: case PPC.STOREUX: {
        const address = this.effective(inst)
        if (inst.sourceFile === File.FPR) {
          const bits = this.vsrHi[inst.rd]!
          this.memory.store(address, inst.width as AccessWidth,
            inst.width === 4 ? BigInt(f32ToBits(bitsToF64(bits))) : bits)
        } else {
          this.memory.store(address, inst.width as AccessWidth, this.gpr64[inst.rd]!)
        }
        if (inst.op === PPC.STOREU || inst.op === PPC.STOREUX) this.setReg(inst.ra, address)
        return
      }
      case PPC.LXSIWZX: {
        // One word, zero-extended into doubleword 0. The architecture
        // leaves doubleword 1 undefined; zero is what the reference
        // leaves there, and nothing reads it.
        const address = this.effective(inst)
        this.vsrHi[inst.rd] = this.memory.load(address, 4, false)
        this.vsrLo[inst.rd] = 0n
        return
      }
      case PPC.LXVD2X: {
        // `lxvd2x` names the doublewords in register order rather than
        // memory order, which is the same on both byte orders precisely
        // because it is defined that way. Within each doubleword the
        // bytes are in the machine's order, which is why a little-endian
        // compiler follows it with `xxswapd`.
        const address = this.effective(inst)
        this.vsrHi[inst.rd] = this.memory.load(address, 8, false)
        this.vsrLo[inst.rd] = this.memory.load(address + 8n, 8, false)
        return
      }
      case PPC.STXVD2X: {
        const address = this.effective(inst)
        this.memory.store(address, 8, this.vsrHi[inst.rd]!)
        this.memory.store(address + 8n, 8, this.vsrLo[inst.rd]!)
        return
      }
      case PPC.STXSDX: {
        // Doubleword 0 only. Writing the whole register here would
        // overwrite eight bytes that belong to whatever is next.
        const address = this.effective(inst)
        this.memory.store(address, 8, this.vsrHi[inst.rd]!)
        return
      }
      case PPC.STFIWX: {
        // The low word of doubleword 0, unconverted: this is how an
        // integer produced by a float-to-integer conversion reaches memory.
        const address = this.effective(inst)
        this.memory.store(address, 4, this.vsrHi[inst.rd]! & 0xffff_ffffn)
        return
      }
      case PPC.LFIW: {
        // An integer word into a floating-point register, with no
        // conversion: whatever converts it comes next.
        const address = this.effective(inst)
        const raw = this.memory.load(address, 4, false)
        this.vsrHi[inst.rd] = inst.signed
          ? BigInt.asUintN(64, BigInt.asIntN(32, raw))
          : raw
        return
      }
      case PPC.LOADBR: {
        const address = this.effective(inst)
        const raw = this.memory.load(address, inst.width as AccessWidth, false)
        this.setReg(inst.rd, reverseBytes(raw, inst.width))
        return
      }
      case PPC.STOREBR: {
        const address = this.effective(inst)
        this.memory.store(address, inst.width as AccessWidth,
          reverseBytes(this.gpr64[inst.rd]!, inst.width))
        return
      }
      case PPC.LARX: {
        const address = this.effective(inst)
        this.setReg(inst.rd, this.memory.load(address, inst.width as AccessWidth, false))
        return
      }
      case PPC.STCX: {
        // One hart, so the reservation is never lost and the store
        // always succeeds. That is the truth of this model rather than
        // a simplification: nothing else can take the line.
        const address = this.effective(inst)
        this.memory.store(address, inst.width as AccessWidth, this.gpr64[inst.rd]!)
        this.cr[0] = EQ | (this.so ? SO : 0)
        return
      }

      case PPC.MFVSR:
        this.setReg(inst.rd, inst.width === 4
          ? BigInt.asUintN(32, this.vsrHi[inst.ra]!)
          : this.vsrHi[inst.ra]!)
        return
      case PPC.MTVSR: {
        const value = this.gpr64[inst.ra]!
        this.vsrHi[inst.rd] = inst.width === 8 ? value
          : inst.signed ? BigInt.asUintN(64, BigInt.asIntN(32, value))
            : BigInt.asUintN(32, value)
        this.vsrLo[inst.rd] = 0n
        return
      }

      // ---- Ordering and hints -------------------------------------------
      case PPC.SYNC: case PPC.ISYNC: case PPC.NOP_CACHE: case PPC.ICBI:
        return
      case PPC.DCBZ: {
        // The one cache instruction with an architectural effect: it
        // zeroes a block, and programs use it to avoid reading a line
        // they are about to overwrite.
        const address = BigInt.asUintN(64,
          (this.base(inst.ra) + this.gpr64[inst.rb]!) & ~127n)
        for (let i = 0n; i < 128n; i += 8n) this.memory.store(address + i, 8, 0n)
        this.access = address
        this.accessWidth = 8
        return
      }

      default:
        this.executeFp(si)
    }
  }

  /** Writes a result, and the two registers an arithmetic form may also write. */
  private finishArithmetic(inst: PpcInst, result: bigint, overflow: boolean): void {
    this.setReg(inst.rd, result)
    if (inst.recordOv) {
      this.ov = overflow
      this.ov32 = overflow
      if (overflow) this.so = true
    }
    if (inst.recordCr) this.recordField(0, result, false)
  }

  private readSpr(spr: number): bigint {
    switch (spr) {
      case Spr.LR: return this.lr
      case Spr.CTR: return this.ctr
      case Spr.XER: return this.packedXer()
      case Spr.VRSAVE: return 0n
      default:
        throw new IsaError(
          `${ISA_NAME}: read of special register ${spr} at 0x${this.pc.toString(16)}`,
        )
    }
  }

  private writeSpr(spr: number, value: bigint): void {
    switch (spr) {
      case Spr.LR: this.lr = value; return
      case Spr.CTR: this.ctr = value; return
      case Spr.XER: this.unpackXer(value); return
      case Spr.VRSAVE: return
      default:
        throw new IsaError(
          `${ISA_NAME}: write of special register ${spr} at 0x${this.pc.toString(16)}`,
        )
    }
  }

  // ---------------------------------------------------------------------
  // Floating point, which on this target means VSX.
  // ---------------------------------------------------------------------

  private executeFp(si: PowerStaticInst): void {
    const inst = si.inst
    switch (inst.op) {
      case PPC.XSADD: case PPC.XSSUB: case PPC.XSMUL: case PPC.XSDIV:
      case PPC.FADD: case PPC.FSUB: case PPC.FMUL: case PPC.FDIV: {
        const aBits = this.vsrHi[inst.ra]!
        const bBits = this.vsrHi[inst.rb >= 0 ? inst.rb : inst.rc]!
        const a = bitsToF64(aBits)
        const b = bitsToF64(bBits)
        const add = inst.op === PPC.XSADD || inst.op === PPC.FADD
        const sub = inst.op === PPC.XSSUB || inst.op === PPC.FSUB
        const mul = inst.op === PPC.XSMUL || inst.op === PPC.FMUL
        const value = add ? a + b : sub ? a - b : mul ? a * b : a / b
        this.writeFp(inst, value, [aBits, bBits])
        return
      }
      case PPC.XSSQRT: case PPC.FSQRT: {
        const aBits = this.vsrHi[inst.rb]!
        const value = Math.sqrt(bitsToF64(aBits))
        this.writeFp(inst, value, [aBits])
        return
      }
      case PPC.XSMADD: case PPC.XSMSUB: case PPC.XSNMADD: case PPC.XSNMSUB:
      case PPC.FMADD: case PPC.FMSUB: case PPC.FNMADD: case PPC.FNMSUB: {
        // The accumulate forms read their destination as the third
        // operand, which is what the `a` in `xsmaddadp` means.
        const aBits = this.vsrHi[inst.ra]!
        const bBits = this.vsrHi[inst.rb]!
        const cBits = this.vsrHi[inst.rc >= 0 ? inst.rc : inst.rd]!
        const negateAddend = inst.op === PPC.XSMSUB || inst.op === PPC.XSNMSUB ||
          inst.op === PPC.FMSUB || inst.op === PPC.FNMSUB
        const negateResult = inst.op === PPC.XSNMADD || inst.op === PPC.XSNMSUB ||
          inst.op === PPC.FNMADD || inst.op === PPC.FNMSUB
        // Fused means one rounding, at the end. Computing it as a
        // multiply and then an add rounds twice and differs in the last
        // bit often enough to fail on the first program that uses it,
        // so this goes through the shared exact implementation.
        const addend = negateAddend ? bBits ^ (1n << 63n) : bBits
        const fusedValue = fusedMulAdd(aBits, cBits, addend, F64)
        const value = fusedValue ?? Number.NaN
        this.writeFp(inst, negateResult ? -value : value, [aBits, bBits, cBits])
        return
      }
      case PPC.XSNEG:
        this.vsrHi[inst.rd] = this.vsrHi[inst.rb]! ^ (1n << 63n)
        return
      case PPC.FABS:
        this.vsrHi[inst.rd] = this.vsrHi[inst.rb]! & ~(1n << 63n)
        return
      case PPC.FNABS:
        this.vsrHi[inst.rd] = this.vsrHi[inst.rb]! | (1n << 63n)
        return
      case PPC.FNEG:
        this.vsrHi[inst.rd] = this.vsrHi[inst.rb]! ^ (1n << 63n)
        return
      case PPC.FMR:
        this.vsrHi[inst.rd] = this.vsrHi[inst.rb]!
        return
      case PPC.XSCPSGN:
        this.vsrHi[inst.rd] = (this.vsrHi[inst.ra]! & (1n << 63n)) |
          (this.vsrHi[inst.rb]! & ~(1n << 63n))
        return

      case PPC.XSCMP: case PPC.FCMPU: case PPC.FCMPO: {
        const aBits = this.vsrHi[inst.ra]!
        const bBits = this.vsrHi[inst.rb]!
        const unordered = isNan64(aBits) || isNan64(bBits)
        const a = bitsToF64(aBits)
        const b = bitsToF64(bBits)
        this.cr[inst.crField] = unordered ? SO : a < b ? LT : a > b ? GT : EQ
        return
      }

      case PPC.XSCVT: case PPC.FCFID:
      case PPC.FRSP: case PPC.XVCVT:
        this.convert(inst)
        return

      case PPC.XXLOGIC: {
        // The bitwise operations act on all 128 bits, and which one is
        // chosen by the opcode the decoder kept.
        const kind = (inst.shift - 130) / 8
        const ah = this.vsrHi[inst.ra]!
        const al = this.vsrLo[inst.ra]!
        const bh = this.vsrHi[inst.rb]!
        const bl = this.vsrLo[inst.rb]!
        const apply = (x: bigint, y: bigint): bigint => {
          switch (kind) {
            case 0: return x & y
            case 1: return x & ~y
            case 2: return x | y
            case 3: return x ^ y
            case 4: return BigInt.asUintN(64, ~(x | y))
            case 5: return x | ~y
            case 6: return BigInt.asUintN(64, ~(x & y))
            default: return BigInt.asUintN(64, ~(x ^ y))
          }
        }
        this.vsrHi[inst.rd] = BigInt.asUintN(64, apply(ah, bh))
        this.vsrLo[inst.rd] = BigInt.asUintN(64, apply(al, bl))
        return
      }
      case PPC.XXPERMDI: {
        // Two doublewords chosen from two registers, which is how a
        // swap, a splat and a merge are all spelled.
        const selector = Number(inst.imm)
        const high = (selector & 2) === 0 ? this.vsrHi[inst.ra]! : this.vsrLo[inst.ra]!
        const low = (selector & 1) === 0 ? this.vsrHi[inst.rb]! : this.vsrLo[inst.rb]!
        this.vsrHi[inst.rd] = high
        this.vsrLo[inst.rd] = low
        return
      }
      case PPC.VSPLTISW: {
        const value = BigInt.asUintN(32, inst.imm)
        const word = (value << 32n) | value
        this.vsrHi[inst.rd] = word
        this.vsrLo[inst.rd] = word
        return
      }

      case PPC.VADDUWM: case PPC.VSUBUWM: case PPC.VMULUWM:
      case PPC.VSLW: case PPC.VSRW: case PPC.VSRAW:
      case PPC.VCMPEQUW: case PPC.VCMPGTUW:
      case PPC.VADDUDM: case PPC.VSUBUDM: case PPC.VSLD: case PPC.VSRAD:
      case PPC.VCMPEQUD: case PPC.VCMPGTUD:
      case PPC.VPKUDUM: case PPC.VUPKLSW: case PPC.VPERM:
      case PPC.XXMRGHW: case PPC.XXMRGLW: case PPC.XXSLDWI:
      case PPC.XXSEL: case PPC.XXSPLTW:
        this.vector(inst)
        return

      case PPC.MFFS: case PPC.MTFSF:
        // The floating-point status and control register is not
        // modelled, and reading it is refused rather than answered with
        // a zero that would look like a valid answer.
        //
        // It holds two things. The sticky exception bits, which nothing
        // the compiler emits ever reads -- across every fixture here,
        // the only `mffs` is the one the harness used to execute. And
        // the rounding mode, which this interpreter does not implement:
        // every operation rounds to nearest, so a program that set a
        // different mode and carried on would get answers that were
        // quietly wrong rather than loudly refused.
        throw new UnimplementedInstruction(
          ISA_NAME, this.pc, wordBytes(inst.word),
          'the floating-point status register is not modelled; this ' +
          'backend rounds to nearest and does not report exceptions',
        )

      default:
        throw new UnimplementedInstruction(
          ISA_NAME, this.pc, wordBytes(inst.word),
          `operation ${inst.op} has no semantics`,
        )
    }
  }

  /**
   * The bit pattern an operation that produced a NaN must deliver.
   *
   * Every architecture picks one and they do not agree. This one is
   * positive with only the top mantissa bit set; SPARC's is negative
   * with all of them set; and JavaScript hands back whichever its host
   * produced, which for a square root of a negative number is the
   * negative one. So a result computed on the host has to be replaced
   * rather than stored.
   *
   * A NaN that came *in* is propagated instead, quieted if it was
   * signalling, which is what the architecture says and what keeps a
   * payload a program may have put there.
   */
  private static quietNan(operands: readonly bigint[]): bigint {
    for (const bits of operands) {
      if ((bits & 0x7ff0_0000_0000_0000n) === 0x7ff0_0000_0000_0000n &&
          (bits & 0x000f_ffff_ffff_ffffn) !== 0n) {
        return bits | 0x0008_0000_0000_0000n
      }
    }
    return 0x7ff8_0000_0000_0000n
  }

  /**
   * Stores a floating-point result.
   *
   * No exception bits are recorded, because the register that would
   * hold them is not modelled -- see the refusal of `mffs` above.
   */
  private writeFp(inst: PpcInst, value: number, operands: readonly bigint[]): void {
    this.vsrHi[inst.rd] = Number.isNaN(value)
      ? PowerInterpreter.quietNan(operands)
      : f64ToBits(value)
  }

  private convert(inst: PpcInst): void {
    const source = this.vsrHi[inst.rb]!
    switch (inst.shift) {
      // Integer to double, which is what a cast from `long` compiles to.
      case 376: // xscvsxddp
        this.vsrHi[inst.rd] = f64ToBits(Number(BigInt.asIntN(64, source)))
        return
      case 360: // xscvuxddp
        this.vsrHi[inst.rd] = f64ToBits(Number(BigInt.asUintN(64, source)))
        return
      case 248: { // xvcvsxwdp: two words in, two doubles out
        const hi = BigInt.asIntN(32, this.vsrHi[inst.rb]! >> 32n)
        const lo = BigInt.asIntN(32, this.vsrLo[inst.rb]! >> 32n)
        this.vsrHi[inst.rd] = f64ToBits(Number(hi))
        this.vsrLo[inst.rd] = f64ToBits(Number(lo))
        return
      }
      // Double to integer, truncating, which is what a cast back is.
      case 344: { // xscvdpsxds: double to a signed doubleword, truncating
        const value = bitsToF64(source)
        if (Number.isNaN(value)) { this.vsrHi[inst.rd] = 0x8000_0000_0000_0000n; return }
        const truncated = Math.trunc(value)
        // The saturating bounds are the architecture's, not the host's:
        // a double too large for a signed 64-bit integer delivers the
        // extreme rather than wrapping.
        // The bounds are written as powers of two because the extremes
        // themselves are not representable as doubles: the nearest
        // double to the largest signed 64-bit integer is one larger
        // than it, so comparing against the integer compares against
        // the wrong number.
        const clamped = truncated >= 2 ** 63
          ? 0x7fff_ffff_ffff_ffffn
          : truncated < -(2 ** 63)
            ? 0x8000_0000_0000_0000n
            : BigInt.asUintN(64, BigInt(truncated))
        this.vsrHi[inst.rd] = clamped
        return
      }
      case 88: case 72: { // xscvdpsxws, xscvdpuxws
        const value = bitsToF64(source)
        const signed = inst.shift === 88
        // A NaN has no integer value, and the architecture names the
        // result: the most negative word for the signed form, zero for
        // the unsigned one.
        const clamped = Number.isNaN(value)
          ? (signed ? -0x80000000 : 0)
          : signed
            ? Math.min(Math.max(Math.trunc(value), -0x80000000), 0x7fffffff)
            : Math.min(Math.max(Math.trunc(value), 0), 0xffffffff)
        // The result is word 1. Words 0, 2 and 3 are left undefined by
        // the architecture; hardware copies the result into word 0 as
        // well, and so does the reference, so this does too -- it keeps
        // the two comparable on the doubleword that holds a scalar, and
        // no program may rely on the difference.
        const word = BigInt.asUintN(32, BigInt(clamped))
        this.vsrHi[inst.rd] = (word << 32n) | word
        return
      }
      default:
        break
    }
    switch (inst.op) {
      case PPC.FCFID:
        this.vsrHi[inst.rd] = f64ToBits(Number(BigInt.asIntN(64, source)))
        return
      case PPC.FRSP:
        this.vsrHi[inst.rd] = f64ToBits(Math.fround(bitsToF64(source)))
        return
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, this.pc, wordBytes(inst.word),
          `conversion ${inst.shift} is not implemented`,
        )
    }
  }

  private syscall(): void {
    if (!this.linux) {
      throw new IsaError(`${ISA_NAME}: system call with no emulation layer`)
    }
    const raw = Number(BigInt.asUintN(32, this.gpr64[0]!))
    const mapped = this.numbers[raw]
    if (mapped === undefined) {
      throw new IsaError(
        `${ISA_NAME}: system call ${raw} at 0x${this.pc.toString(16)} is not mapped`,
      )
    }
    const args: bigint[] = []
    for (let i = 3; i <= 8; i++) args.push(this.gpr64[i]!)
    const result = this.linux.dispatch(ISA_NAME, mapped, args)
    if (result.exited) {
      this.exited = true
      this.exitCode = this.linux.exitCode
      return
    }
    const value = BigInt.asIntN(64, result.value)
    // An error is reported by setting the summary-overflow bit of cr0
    // and returning a positive errno, which is this ABI's convention
    // and not the negative return every asm-generic target uses.
    if (value < 0n) {
      this.cr[0] = (this.cr[0]! | SO) & 0xf
      this.setReg(3, -value)
    } else {
      this.cr[0] = this.cr[0]! & ~SO & 0xf
      this.setReg(3, value)
    }
  }
}

function signedOverflowAdd(a: bigint, b: bigint, result: bigint): boolean {
  const sa = BigInt.asIntN(64, a)
  const sb = BigInt.asIntN(64, b)
  const sr = BigInt.asIntN(64, result)
  return (sa < 0n) === (sb < 0n) && (sr < 0n) !== (sa < 0n)
}

function countLeadingZeros(value: bigint, width: number): bigint {
  for (let i = 0; i < width; i++) {
    if ((value >> BigInt(width - 1 - i)) & 1n) return BigInt(i)
  }
  return BigInt(width)
}

function countTrailingZeros(value: bigint, width: number): bigint {
  for (let i = 0; i < width; i++) {
    if ((value >> BigInt(i)) & 1n) return BigInt(i)
  }
  return BigInt(width)
}

function popcount(value: bigint): bigint {
  let n = 0n
  for (let v = value; v !== 0n; v >>= 1n) if ((v & 1n) === 1n) n += 1n
  return n
}

function reverseBytes(value: bigint, width: number): bigint {
  let out = 0n
  for (let i = 0; i < width; i++) {
    out = (out << 8n) | ((value >> BigInt(i * 8)) & 0xffn)
  }
  return out
}

function wordBytes(word: number): Uint8Array {
  return Uint8Array.from([
    word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff,
  ])
}
