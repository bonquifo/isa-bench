/**
 * SPARC V8 interpreter.
 *
 * Two things here are not present in any other backend, and between them
 * they are most of the file.
 *
 * ## Register windows
 *
 * A SPARC program never sees the register file. It sees a window of 24
 * registers -- eight `in`, eight `local`, eight `out` -- plus eight
 * globals, and `save` rotates that window rather than pushing anything.
 * The rotation overlaps: the caller's `out` registers *are* the callee's
 * `in` registers, the same physical registers under two names, which is
 * how arguments are passed without touching memory.
 *
 * The interpreter keeps the physical file and resolves the window on
 * every access, so execution is exact: a caller's `%o0` and a callee's
 * `%i0` really are one register here, and two `%l0`s at different
 * depths really are two.
 *
 * What the *timing* model sees is window-relative, which is a
 * deliberate approximation rather than an oversight; image.ts explains
 * why the frozen contract cannot carry the exact answer and what is
 * done instead. Nothing in this file depends on that choice.
 *
 * ## The window overflow trap
 *
 * There are only eight windows. The ninth nested `save` has nowhere to
 * go, so it traps, and on Linux the kernel spills the oldest window to
 * its stack frame and lets the `save` proceed. `restore` past the
 * bottom traps the other way and fills.
 *
 * This is emulated here rather than trapped to guest code, because that
 * is what the reference does: qemu-user handles the trap internally, so
 * no handler instructions appear in its trace. What does appear is the
 * same instruction dumped twice with `wim` changed, because qemu
 * restarts the block after the trap -- a detail the fixture builder has
 * to know about and the interpreter does not, since here the spill
 * happens inside the one `save`.
 *
 * ## And the delay slot, which is easier here than on MIPS
 *
 * Every control transfer has one, but unlike MIPS the architecture names
 * the state: there is a `pc` and an `npc`, both visible, and a branch
 * writes `npc`. Sequencing is then just `pc = npc; npc = npc + 4`, with
 * no notion of "pending" anywhere. The annul bit is the one complication
 * -- it means "skip the delay instruction", but only when the branch is
 * untaken, except for an unconditional branch where it means always.
 */
import { GuestFault, ExecutionBudgetExceeded, IsaError, UnimplementedInstruction } from '../common/errors.ts'
import {
  F32,
  F64,
  NO_STATUS,
  bitsToF32,
  bitsToF64,
  exactOf,
  exactProduct,
  exactSum,
  f32ToBits,
  f64ToBits,
  isNan32,
  isNan64,
  quotientStatus,
  sqrtStatus,
  statusOf,
  type RoundingStatus,
} from '../common/fp.ts'
import { Sys, type LinuxSyscalls } from '../common/linux.ts'
import type { GuestMemory } from '../common/memory.ts'
import { RunState, type ArchState, type Interpreter, type RetireChunk } from '../common/trace.ts'
import { Cond, FpFormat, ISA_NAME, SPARC, type SparcInst } from './decode.ts'
import { Res } from './image.ts'
import type { SparcImage, SparcStaticInst } from './image.ts'

const DEFAULT_BUDGET = 2_000_000_000

/** Windows in the register file. Eight is what qemu's SPARC32 provides. */
export const NWINDOWS = 8
/** Physical window registers: sixteen per window. */
export const WINDOW_REGS = NWINDOWS * 16

/**
 * SPARC/Linux syscall numbers, which are the classic Unix ones.
 *
 * Measured rather than recalled: `qemu-sparc -strace` names them for a
 * program that issues each. The freestanding tier needs two.
 */
export const SPARC_SYSCALL_NUMBERS: Readonly<Record<number, number>> = {
  1: Sys.EXIT,
  3: Sys.READ,
  4: Sys.WRITE,
  6: Sys.CLOSE,
  17: Sys.BRK,
  19: Sys.LSEEK,
  20: Sys.GETPID,
  24: Sys.GETUID,
  47: Sys.GETGID,
  49: Sys.GETEUID,
  50: Sys.GETEGID,
  54: Sys.IOCTL,
  71: Sys.MMAP,
  73: Sys.MUNMAP,
  74: Sys.MPROTECT,
  75: Sys.MADVISE,
  // 121 and 188 were once `writev` and nothing: 188 is `exit_group`,
  // which is how a libc leaves, and treating it as a vector write would
  // have kept a finished program running. Checked against unistd_32.h
  // from linux-libc-dev-sparc64-cross, since nothing on this target had
  // made either call until it had a libc.
  121: Sys.WRITEV,
  188: Sys.EXIT_GROUP,
}

export interface SparcOptions {
  instructionBudget?: number
  linux?: LinuxSyscalls
  syscallNumbers?: Readonly<Record<number, number>>
}

export class SparcInterpreter implements Interpreter {
  readonly image: SparcImage
  private readonly memory: GuestMemory
  private readonly linux: LinuxSyscalls | null
  private readonly numbers: Readonly<Record<number, number>>

  /** g0..g7. g0 reads as zero and discards writes. */
  readonly globals = new Int32Array(8)
  /** The physical window file, resolved through `cwp` on every access. */
  readonly windows = new Int32Array(WINDOW_REGS)
  /** Thirty-two single-precision registers; a double is an even pair. */
  readonly fpr = new Uint32Array(32)

  cwp = 0
  /** Which windows may not be entered without spilling first. */
  wim = 0
  /** The multiply and divide extension register. */
  y = 0
  /** Integer condition codes, kept apart because branches read them apart. */
  n = false
  z = false
  v = false
  c = false
  /** Floating-point condition code: 0 equal, 1 less, 2 greater, 3 unordered. */
  fcc = 0
  /**
   * The floating-point status register, whose version field is not
   * zero.
   *
   * Bits 19 to 17 name the FPU implementation, and the reference
   * reports 1 there from the first instruction. A guest that stores
   * `%fsr` sees it, so starting at zero is a visible difference in a
   * field that has nothing to do with arithmetic. Measured, not chosen.
   */
  fsr = 0x0008_0000

  pc = 0
  npc = 4

  exitCode = 0
  retired = 0

  private exited = false
  private access = 0n
  private accessWidth = 0
  private taken = 0
  private readonly budget: number

  constructor(image: SparcImage, memory: GuestMemory, options: SparcOptions = {}) {
    this.image = image
    this.memory = memory
    this.linux = options.linux ?? null
    this.numbers = options.syscallNumbers ?? SPARC_SYSCALL_NUMBERS
    this.budget = options.instructionBudget ?? DEFAULT_BUDGET
    this.pc = Number(image.entry & 0xffffffffn)
    this.npc = (this.pc + 4) >>> 0
    // The window the process starts in is itself marked invalid, which
    // is what stops `save` wrapping all the way round and reusing the
    // entry frame without spilling it first. Read off the reference
    // rather than assumed: qemu starts with cwp 0 in `psr` and `wim` 1.
    this.wim = 1 << this.cwp
  }

  // ---------------------------------------------------------------------
  // The window.
  //
  // ins(w)    are physical [16w      .. 16w + 7]
  // locals(w) are physical [16w + 8  .. 16w + 15]
  // outs(w)   are ins(w - 1), which is what makes the caller's outs and
  //           the callee's ins the same registers after a `save`.
  // ---------------------------------------------------------------------

  /** Physical index of window-relative register `r` in window `w`. */
  private slot(r: number, w = this.cwp): number {
    if (r < 16) {
      // %o0..%o7 live in the next window down.
      return 16 * ((w - 1 + NWINDOWS) % NWINDOWS) + (r - 8)
    }
    if (r < 24) return 16 * w + 8 + (r - 16) // %l0..%l7
    return 16 * w + (r - 24)                 // %i0..%i7
  }

  /** Reads a window-relative register number, 0..31. */
  reg(r: number): number {
    if (r === 0) return 0
    if (r < 8) return this.globals[r]!
    return this.windows[this.slot(r)]!
  }

  /** Writes a window-relative register number; %g0 discards. */
  setReg(r: number, value: number): void {
    if (r === 0) return
    if (r < 8) { this.globals[r] = value | 0; return }
    this.windows[this.slot(r)] = value | 0
  }

  // ---------------------------------------------------------------------
  // The Interpreter contract.
  // ---------------------------------------------------------------------

  get programCounter(): bigint {
    return BigInt(this.pc >>> 0)
  }

  /**
   * Window-relative registers 0..31, then `y`, then the packed icc.
   *
   * Window-relative rather than physical because that is what the
   * reference reports: qemu prints `%g`, `%o`, `%l` and `%i` for the
   * current window, and a lockstep comparison has to be of the same
   * thing on both sides. The *timing* model gets physical numbers; this
   * is for the comparison.
   */
  gpr(index: number): bigint {
    if (index < 32) return BigInt(this.reg(index) >>> 0)
    switch (index) {
      case Res.Y: return BigInt(this.y >>> 0)
      case Res.N: return this.n ? 1n : 0n
      case Res.Z: return this.z ? 1n : 0n
      case Res.V: return this.v ? 1n : 0n
      case Res.C: return this.c ? 1n : 0n
      case Res.WINDOW: return BigInt(this.cwp)
      case Res.NPC: return BigInt(this.npc >>> 0)
      case Res.WIM: return BigInt(this.wim >>> 0)
      default: return 0n
    }
  }

  setGpr(index: number, value: bigint): void {
    const v = Number(BigInt.asUintN(32, value)) | 0
    if (index < 32) { this.setReg(index, v); return }
    switch (index) {
      case Res.Y: this.y = v; break
      case Res.N: this.n = v !== 0; break
      case Res.Z: this.z = v !== 0; break
      case Res.V: this.v = v !== 0; break
      case Res.C: this.c = v !== 0; break
      case Res.WINDOW: this.cwp = v % NWINDOWS; break
      case Res.NPC: this.npc = v >>> 0; break
      case Res.WIM: this.wim = v >>> 0; break
      default: break
    }
  }

  packedIcc(): number {
    return (this.n ? 8 : 0) | (this.z ? 4 : 0) | (this.v ? 2 : 0) | (this.c ? 1 : 0)
  }

  finalState(): ArchState {
    const gpr: bigint[] = []
    for (let r = 0; r < 32; r++) gpr.push(BigInt(this.reg(r) >>> 0))
    const fpr: bigint[] = []
    for (let f = 0; f < 32; f++) fpr.push(BigInt(this.fpr[f]!))
    return {
      gpr,
      fpr,
      status: {
        y: BigInt(this.y >>> 0),
        icc: BigInt(this.packedIcc()),
        fsr: BigInt(this.fsr >>> 0),
        wim: BigInt(this.wim >>> 0),
        cwp: BigInt(this.cwp),
      },
      pc: BigInt(this.pc >>> 0),
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
      const si = this.image.at(BigInt(this.pc >>> 0))
      const pc = this.pc
      this.access = 0n
      this.accessWidth = 0
      this.taken = 0
      // The architecture says where control goes next; an instruction
      // that is not a transfer simply lets it advance.
      let next = this.npc
      this.nextNpc = (this.npc + 4) >>> 0
      this.execute(si)
      next = this.nextPcAfter ?? next
      into.pc[n] = BigInt(pc >>> 0)
      into.nextPc[n] = BigInt(next >>> 0)
      into.effAddr[n] = this.access
      into.accessWidth[n] = this.accessWidth
      into.taken[n] = this.taken
      this.pc = next
      this.npc = this.nextNpc
      this.nextPcAfter = null
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

  /** Where npc goes after this instruction. */
  private nextNpc = 0
  /**
   * Set only when an annulled branch skips the delay instruction, which
   * is the one case where pc does not simply become the old npc.
   */
  private nextPcAfter: number | null = null

  // ---------------------------------------------------------------------
  // Flags.
  // ---------------------------------------------------------------------

  private setLogicIcc(result: number): void {
    this.n = result < 0
    this.z = result === 0
    this.v = false
    this.c = false
  }

  private setAddIcc(a: number, b: number, carryIn: number, result: number): void {
    this.n = result < 0
    this.z = result === 0
    // Carry out of bit 31, computed unsigned so the comparison is exact.
    const wide = (a >>> 0) + (b >>> 0) + carryIn
    this.c = wide > 0xffffffff
    // Overflow when both operands agreed about sign and the result did not.
    this.v = (((a ^ ~b) & (a ^ result)) & 0x80000000) !== 0
  }

  private setSubIcc(a: number, b: number, borrowIn: number, result: number): void {
    this.n = result < 0
    this.z = result === 0
    // SPARC's C after a subtract is a borrow, set when the subtraction
    // needed one.
    this.c = (a >>> 0) < (b >>> 0) + borrowIn
    this.v = (((a ^ b) & (a ^ result)) & 0x80000000) !== 0
  }

  /** Whether an integer condition holds now. */
  private condition(cond: number): boolean {
    switch (cond) {
      case Cond.N: return false
      case Cond.E: return this.z
      case Cond.LE: return this.z || (this.n !== this.v)
      case Cond.L: return this.n !== this.v
      case Cond.LEU: return this.c || this.z
      case Cond.CS: return this.c
      case Cond.NEG: return this.n
      case Cond.VS: return this.v
      case Cond.A: return true
      case Cond.NE: return !this.z
      case Cond.G: return !this.z && (this.n === this.v)
      case Cond.GE: return this.n === this.v
      case Cond.GU: return !this.c && !this.z
      case Cond.CC: return !this.c
      case Cond.POS: return !this.n
      case Cond.VC: return !this.v
      default: return false
    }
  }

  /**
   * Whether a floating-point condition holds, against `fcc`.
   *
   * The encoding is not the integer one with different names on it, and
   * assuming it was is how this was wrong the first time. Bit 3 selects
   * between "the condition holds" and "equal, plus the condition", and
   * the low three bits are a mask over the three mutually exclusive
   * answers a comparison can give -- less, greater, unordered -- so
   * `fbul` is less-or-unordered rather than anything to do with
   * unsigned. Nothing in the corpus branches on a float, so nothing
   * caught this until the randomised programs did.
   *
   *   0 fbn    4 fbl     8 fba    12 fbuge
   *   1 fbne   5 fbug    9 fbe    13 fble
   *   2 fblg   6 fbg    10 fbue   14 fbule
   *   3 fbul   7 fbu    11 fbge   15 fbo
   */
  private fpCondition(cond: number): boolean {
    const eq = this.fcc === 0
    const lt = this.fcc === 1
    const gt = this.fcc === 2
    const un = this.fcc === 3
    switch (cond) {
      case 0: return false                  // fbn
      case 1: return lt || gt || un         // fbne
      case 2: return lt || gt               // fblg
      case 3: return lt || un               // fbul
      case 4: return lt                     // fbl
      case 5: return gt || un               // fbug
      case 6: return gt                     // fbg
      case 7: return un                     // fbu
      case 8: return true                   // fba
      case 9: return eq                     // fbe
      case 10: return eq || un              // fbue
      case 11: return eq || gt              // fbge
      case 12: return eq || gt || un        // fbuge
      case 13: return eq || lt              // fble
      case 14: return eq || lt || un        // fbule
      default: return eq || lt || gt        // fbo
    }
  }

  // ---------------------------------------------------------------------
  // Operands.
  // ---------------------------------------------------------------------

  private operand2(inst: SparcInst): number {
    return inst.immediate ? inst.imm | 0 : this.reg(inst.rs2)
  }

  // ---------------------------------------------------------------------
  // Windows, and the traps that come with running out of them.
  // ---------------------------------------------------------------------

  private invalid(window: number): boolean {
    return (this.wim & (1 << window)) !== 0
  }

  /**
   * Spills the oldest window to its own stack frame.
   *
   * The convention is the Linux kernel's, which qemu-user implements
   * directly rather than by running a handler: the sixteen registers of
   * the window being given up -- its locals then its ins -- go to the
   * 64-byte save area at that window's `%sp`, which the ABI reserves in
   * every frame for exactly this. Whether this agrees with the
   * reference is not asserted here; it is decided by the lockstep tier,
   * because a fill that reads back what the spill wrote would otherwise
   * be self-consistently wrong.
   */
  private spill(): void {
    const victim = (this.cwp - 2 + 2 * NWINDOWS) % NWINDOWS
    // A window's stack pointer is its %o6, which is register 6 of the
    // window below it.
    const sp = this.windows[this.slot(14, victim)]! >>> 0
    for (let i = 0; i < 8; i++) {
      this.memory.store(BigInt(sp + i * 4), 4, BigInt(this.windows[16 * victim + 8 + i]! >>> 0))
    }
    for (let i = 0; i < 8; i++) {
      this.memory.store(BigInt(sp + 32 + i * 4), 4, BigInt(this.windows[16 * victim + i]! >>> 0))
    }
    this.wim = ((this.wim >>> 1) | (this.wim << (NWINDOWS - 1))) & ((1 << NWINDOWS) - 1)
  }

  /** Reads a window back from the frame the spill wrote it to. */
  private fill(): void {
    const target = (this.cwp + 1) % NWINDOWS
    const sp = this.windows[this.slot(14, target)]! >>> 0
    for (let i = 0; i < 8; i++) {
      this.windows[16 * target + 8 + i] = Number(this.memory.load(BigInt(sp + i * 4), 4, false)) | 0
    }
    for (let i = 0; i < 8; i++) {
      this.windows[16 * target + i] = Number(this.memory.load(BigInt(sp + 32 + i * 4), 4, false)) | 0
    }
    this.wim = ((this.wim << 1) | (this.wim >>> (NWINDOWS - 1))) & ((1 << NWINDOWS) - 1)
  }

  // ---------------------------------------------------------------------
  // Floating point. V8 has thirty-two single registers; a double is an
  // even-numbered pair, most significant word first.
  // ---------------------------------------------------------------------

  /**
   * Stores a floating-point result, substituting this architecture's
   * own quiet NaN for the host's when the answer is not a number.
   */
  private writeResult(
    rd: number, value: number, double: boolean, operands: readonly bigint[],
  ): void {
    if (Number.isNaN(value)) {
      const nan = SparcInterpreter.quietNan(operands, double)
      if (double) this.writeDouble(rd, nan)
      else this.fpr[rd] = Number(nan) >>> 0
      return
    }
    if (double) this.writeDouble(rd, f64ToBits(value))
    else this.fpr[rd] = f32ToBits(value)
  }

  private readDouble(f: number): bigint {
    const hi = BigInt(this.fpr[f & 30]!)
    const lo = BigInt(this.fpr[(f & 30) + 1]!)
    return (hi << 32n) | lo
  }

  private writeDouble(f: number, bits: bigint): void {
    this.fpr[f & 30] = Number((bits >> 32n) & 0xffffffffn)
    this.fpr[(f & 30) + 1] = Number(bits & 0xffffffffn)
  }

  // ---------------------------------------------------------------------

  private execute(si: SparcStaticInst): void {
    const inst = si.inst
    switch (inst.op) {
      // ---- Constants and arithmetic ------------------------------------
      case SPARC.SETHI:
        this.setReg(inst.rd, inst.imm | 0)
        return

      case SPARC.ADD: case SPARC.ADDX: {
        const a = this.reg(inst.rs1)
        const b = this.operand2(inst)
        const carry = inst.op === SPARC.ADDX && this.c ? 1 : 0
        const result = (a + b + carry) | 0
        if (inst.writesIcc) this.setAddIcc(a, b, carry, result)
        this.setReg(inst.rd, result)
        return
      }
      case SPARC.SUB: case SPARC.SUBX: {
        const a = this.reg(inst.rs1)
        const b = this.operand2(inst)
        const borrow = inst.op === SPARC.SUBX && this.c ? 1 : 0
        const result = (a - b - borrow) | 0
        if (inst.writesIcc) this.setSubIcc(a, b, borrow, result)
        this.setReg(inst.rd, result)
        return
      }
      case SPARC.AND: case SPARC.ANDN:
      case SPARC.OR: case SPARC.ORN:
      case SPARC.XOR: case SPARC.XNOR: {
        const a = this.reg(inst.rs1)
        const raw = this.operand2(inst)
        const negate = inst.op === SPARC.ANDN || inst.op === SPARC.ORN ||
          inst.op === SPARC.XNOR
        const b = negate ? ~raw : raw
        const result =
          inst.op === SPARC.AND || inst.op === SPARC.ANDN ? a & b :
          inst.op === SPARC.OR || inst.op === SPARC.ORN ? a | b :
          // `xnor` is xor with the operand complemented, which is the
          // same as complementing the result.
          a ^ b
        if (inst.writesIcc) this.setLogicIcc(result)
        this.setReg(inst.rd, result)
        return
      }

      case SPARC.UMUL: case SPARC.SMUL: {
        const a = BigInt(inst.op === SPARC.SMUL
          ? this.reg(inst.rs1) : this.reg(inst.rs1) >>> 0)
        const raw = this.operand2(inst)
        const b = BigInt(inst.op === SPARC.SMUL ? raw : raw >>> 0)
        const product = BigInt.asUintN(64, a * b)
        const low = Number(product & 0xffffffffn) | 0
        // The high half is not thrown away: it goes to %y, which is how
        // a 32-bit machine returns a 64-bit product.
        this.y = Number(product >> 32n) | 0
        if (inst.writesIcc) this.setLogicIcc(low)
        this.setReg(inst.rd, low)
        return
      }
      case SPARC.UDIV: case SPARC.SDIV: {
        const signed = inst.op === SPARC.SDIV
        const divisor = this.operand2(inst)
        if (divisor === 0) {
          // Division by zero traps on this architecture rather than
          // producing a defined value, and the trap is not modelled.
          throw new IsaError(`${ISA_NAME}: divide by zero at 0x${this.pc.toString(16)}`)
        }
        // The dividend is 64 bits: %y supplies the high half.
        const dividend = signed
          ? BigInt.asIntN(64, (BigInt(this.y >>> 0) << 32n) | BigInt(this.reg(inst.rs1) >>> 0))
          : (BigInt(this.y >>> 0) << 32n) | BigInt(this.reg(inst.rs1) >>> 0)
        const d = signed ? BigInt(divisor) : BigInt(divisor >>> 0)
        let quotient = dividend / d
        // The result saturates rather than wrapping, and sets overflow.
        let overflow = false
        if (signed) {
          if (quotient > 0x7fffffffn) { quotient = 0x7fffffffn; overflow = true }
          else if (quotient < -0x80000000n) { quotient = -0x80000000n; overflow = true }
        } else if (quotient > 0xffffffffn) { quotient = 0xffffffffn; overflow = true }
        const result = Number(BigInt.asIntN(32, quotient)) | 0
        if (inst.writesIcc) {
          this.n = result < 0
          this.z = result === 0
          this.v = overflow
          this.c = false
        }
        this.setReg(inst.rd, result)
        return
      }

      case SPARC.SLL: this.setReg(inst.rd, this.reg(inst.rs1) << (this.operand2(inst) & 31)); return
      case SPARC.SRL: this.setReg(inst.rd, this.reg(inst.rs1) >>> (this.operand2(inst) & 31)); return
      case SPARC.SRA: this.setReg(inst.rd, this.reg(inst.rs1) >> (this.operand2(inst) & 31)); return

      case SPARC.MULSCC: {
        // One step of the multiply the original hardware had no
        // instruction for. Kept because the compiler still emits it for
        // some constant multiplies.
        const rs1 = this.reg(inst.rs1)
        const shifted = ((rs1 >>> 1) | ((this.n !== this.v ? 1 : 0) << 31)) | 0
        const addend = (this.y & 1) !== 0 ? this.operand2(inst) : 0
        const result = (shifted + addend) | 0
        this.setAddIcc(shifted, addend, 0, result)
        this.y = ((this.y >>> 1) | ((rs1 & 1) << 31)) | 0
        this.setReg(inst.rd, result)
        return
      }

      case SPARC.TADDCC: case SPARC.TSUBCC:
      case SPARC.TADDCCTV: case SPARC.TSUBCCTV: {
        const a = this.reg(inst.rs1)
        const b = this.operand2(inst)
        const add = inst.op === SPARC.TADDCC || inst.op === SPARC.TADDCCTV
        const result = (add ? a + b : a - b) | 0
        if (add) this.setAddIcc(a, b, 0, result)
        else this.setSubIcc(a, b, 0, result)
        // The tagged forms also set overflow when either operand had a
        // tag, which is what makes them tagged.
        if (((a | b) & 3) !== 0) this.v = true
        if ((inst.op === SPARC.TADDCCTV || inst.op === SPARC.TSUBCCTV) && this.v) {
          throw new IsaError(`${ISA_NAME}: tagged overflow trap at 0x${this.pc.toString(16)}`)
        }
        this.setReg(inst.rd, result)
        return
      }

      case SPARC.RDY: this.setReg(inst.rd, this.y); return
      case SPARC.WRY: this.y = (this.reg(inst.rs1) ^ this.operand2(inst)) | 0; return

      // ---- Control -----------------------------------------------------
      case SPARC.BICC: case SPARC.FBFCC: {
        const taken = inst.op === SPARC.BICC
          ? this.condition(inst.cond)
          : this.fpCondition(inst.cond)
        if (taken) {
          this.nextNpc = inst.target
          this.taken = 1
          // An unconditional branch that annuls skips its delay slot
          // even though it was taken, which is the one case where the
          // bit does not mean "skip when untaken".
          if (inst.annul && inst.cond === Cond.A) {
            this.nextPcAfter = inst.target
            this.nextNpc = (inst.target + 4) >>> 0
          }
        } else if (inst.annul) {
          // Untaken and annulling: the delay instruction does not run,
          // so control skips over it.
          this.nextPcAfter = this.nextNpc
          this.nextNpc = (this.nextNpc + 4) >>> 0
        }
        return
      }

      case SPARC.CALL:
        // The return address is this instruction's own, not the next
        // one's, because `ret` adds eight to account for the delay slot.
        this.setReg(15, this.pc | 0)
        this.nextNpc = inst.target
        this.taken = 1
        return

      case SPARC.JMPL: {
        const target = (this.reg(inst.rs1) + this.operand2(inst)) >>> 0
        this.setReg(inst.rd, this.pc | 0)
        this.nextNpc = target
        this.taken = 1
        return
      }

      case SPARC.TICC: {
        if (!this.condition(inst.cond)) return
        const number = (this.reg(inst.rs1) + this.operand2(inst)) & 0x7f
        // Trap 0x10 is the system call on Linux; nothing else here is.
        if (number !== 0x10) {
          throw new IsaError(
            `${ISA_NAME}: trap ${number} at 0x${this.pc.toString(16)} is not a system call`,
          )
        }
        this.syscall()
        return
      }

      case SPARC.UNIMP:
        throw new IsaError(`${ISA_NAME}: unimp at 0x${this.pc.toString(16)}`)

      case SPARC.FLUSH:
        // A hint to an instruction cache this model does not have.
        return

      // ---- Windows -----------------------------------------------------
      case SPARC.SAVE: case SPARC.RESTORE: {
        const save = inst.op === SPARC.SAVE
        // Both operands are read in the *old* window and the result is
        // written in the new one, which is what lets `save %sp, -96, %sp`
        // set up a frame in one instruction.
        const a = this.reg(inst.rs1)
        const b = this.operand2(inst)
        const result = (a + b) | 0
        const next = save
          ? (this.cwp - 1 + NWINDOWS) % NWINDOWS
          : (this.cwp + 1) % NWINDOWS
        if (this.invalid(next)) {
          if (save) this.spill()
          else this.fill()
        }
        this.cwp = next
        this.setReg(inst.rd, result)
        return
      }

      // ---- Memory ------------------------------------------------------
      case SPARC.LD: case SPARC.LDUB: case SPARC.LDUH:
      case SPARC.LDSB: case SPARC.LDSH: {
        const address = this.effective(inst)
        const value = this.memory.load(BigInt(address), inst.width as 1 | 2 | 4, inst.signed)
        this.setReg(inst.rd, Number(BigInt.asIntN(32, value)) | 0)
        return
      }
      case SPARC.LDD: {
        const address = this.effective(inst)
        // A register pair, and the encoding must name the even one.
        this.setReg(inst.rd & 30, Number(this.memory.load(BigInt(address), 4, false)) | 0)
        this.setReg((inst.rd & 30) + 1, Number(this.memory.load(BigInt(address + 4), 4, false)) | 0)
        return
      }
      case SPARC.ST: case SPARC.STB: case SPARC.STH: {
        const address = this.effective(inst)
        this.memory.store(
          BigInt(address), inst.width as 1 | 2 | 4,
          BigInt(this.reg(inst.rd) >>> 0),
        )
        return
      }
      case SPARC.STD: {
        const address = this.effective(inst)
        this.memory.store(BigInt(address), 4, BigInt(this.reg(inst.rd & 30) >>> 0))
        this.memory.store(BigInt(address + 4), 4, BigInt(this.reg((inst.rd & 30) + 1) >>> 0))
        return
      }
      case SPARC.LDSTUB: {
        const address = this.effective(inst)
        const old = Number(this.memory.load(BigInt(address), 1, false))
        this.memory.store(BigInt(address), 1, 0xffn)
        this.setReg(inst.rd, old)
        return
      }
      case SPARC.SWAP: {
        const address = this.effective(inst)
        const old = Number(this.memory.load(BigInt(address), 4, false)) | 0
        this.memory.store(BigInt(address), 4, BigInt(this.reg(inst.rd) >>> 0))
        this.setReg(inst.rd, old)
        return
      }
      case SPARC.LDF: {
        const address = this.effective(inst)
        this.fpr[inst.rd] = Number(this.memory.load(BigInt(address), 4, false)) >>> 0
        return
      }
      case SPARC.LDDF: {
        const address = this.effective(inst)
        this.fpr[inst.rd & 30] = Number(this.memory.load(BigInt(address), 4, false)) >>> 0
        this.fpr[(inst.rd & 30) + 1] =
          Number(this.memory.load(BigInt(address + 4), 4, false)) >>> 0
        return
      }
      case SPARC.STF: {
        const address = this.effective(inst)
        this.memory.store(BigInt(address), 4, BigInt(this.fpr[inst.rd]!))
        return
      }
      case SPARC.STDF: {
        const address = this.effective(inst)
        this.memory.store(BigInt(address), 4, BigInt(this.fpr[inst.rd & 30]!))
        this.memory.store(BigInt(address + 4), 4, BigInt(this.fpr[(inst.rd & 30) + 1]!))
        return
      }
      case SPARC.LDFSR: {
        const address = this.effective(inst)
        this.fsr = Number(this.memory.load(BigInt(address), 4, false)) | 0
        this.fcc = (this.fsr >>> 10) & 3
        return
      }
      case SPARC.STFSR: {
        const address = this.effective(inst)
        this.memory.store(BigInt(address), 4, BigInt(this.currentFsr()))
        return
      }

      // ---- Floating point ----------------------------------------------
      default:
        this.executeFp(inst)
    }
  }

  private currentFsr(): number {
    return ((this.fsr & ~0x0c00) | (this.fcc << 10)) >>> 0
  }

  /**
   * Records the exceptions of the floating-point operation just
   * performed.
   *
   * Two fields, and they behave differently. `cexc` describes the last
   * instruction only and is replaced every time, including with zero.
   * `aexc` accumulates and is only ever cleared by writing the status
   * register. A guest that stores %fsr sees both, so an implementation
   * that tracked neither would differ from the reference on a dump
   * even while every arithmetic result matched -- which is exactly how
   * this came to be implemented.
   */
  private setExceptions(cexc: number): void {
    const bits = cexc & 0x1f
    const accrued = ((this.fsr >>> 5) & 0x1f) | bits
    this.fsr = ((this.fsr & ~0x3ff) | (accrued << 5) | bits) >>> 0
  }

  /**
   * The bit pattern an operation that produced a NaN must deliver.
   *
   * Every architecture picks a quiet NaN to produce when an operation
   * has no numeric answer, and they do not agree. This one is all
   * exponent bits and all mantissa bits set -- 0x7fffffff as a single,
   * and the same doubled as a double -- where x86 and ARM produce a
   * mantissa with only its top bit set, which is also what JavaScript
   * hands back from a NaN-producing expression. So a result computed on
   * the host has to be replaced rather than stored.
   *
   * A NaN that came *in* is propagated instead, quieted if it was
   * signalling, which is what the architecture says to do and what
   * keeps the payload a program may have put there.
   */
  private static quietNan(operands: readonly bigint[], double: boolean): bigint {
    const mask = double ? 0x7ff0_0000_0000_0000n : 0x7f80_0000n
    const payload = double ? 0x000f_ffff_ffff_ffffn : 0x007f_ffffn
    const quiet = double ? 0x0008_0000_0000_0000n : 0x0040_0000n
    for (const bits of operands) {
      if ((bits & mask) === mask && (bits & payload) !== 0n) return bits | quiet
    }
    return double ? 0x7fff_ffff_ffff_ffffn : 0x7fff_ffffn
  }

  /** IEEE status as the five bits this architecture keeps them in. */
  private static excOf(status: RoundingStatus, invalid = false, divZero = false): number {
    return (invalid ? 0x10 : 0) | (status.overflow ? 0x08 : 0) |
      (status.underflow ? 0x04 : 0) | (divZero ? 0x02 : 0) |
      (status.inexact ? 0x01 : 0)
  }

  private effective(inst: SparcInst): number {
    const address = (this.reg(inst.rs1) + this.operand2(inst)) >>> 0
    this.access = BigInt(address)
    this.accessWidth = inst.width
    if (inst.width > 1 && (address % Math.min(inst.width, 8)) !== 0) {
      // SPARC requires natural alignment and traps otherwise; there is
      // no unaligned access to fall back on.
      throw new GuestFault(
        'read', BigInt(address), inst.width, 'misaligned',
      )
    }
    return address
  }

  private executeFp(inst: SparcInst): void {
    const double = inst.fromFormat === FpFormat.DOUBLE ||
      inst.toFormat === FpFormat.DOUBLE

    if (inst.fromFormat === FpFormat.QUAD || inst.toFormat === FpFormat.QUAD) {
      // Quad precision is architectural but no SPARC implementation ever
      // had it in hardware, and nothing here emits it.
      throw new UnimplementedInstruction(
        ISA_NAME, BigInt(this.pc), wordBytes(inst.word), 'quad-precision floating point',
      )
    }

    switch (inst.op) {
      case SPARC.FMOV: this.fpr[inst.rd] = this.fpr[inst.rs2]!; return
      case SPARC.FNEG: this.fpr[inst.rd] = (this.fpr[inst.rs2]! ^ 0x80000000) >>> 0; return
      case SPARC.FABS: this.fpr[inst.rd] = (this.fpr[inst.rs2]! & 0x7fffffff) >>> 0; return

      case SPARC.FADD: case SPARC.FSUB: case SPARC.FMUL: case SPARC.FDIV: {
        // Both widths are computed as doubles and the single-precision
        // result rounded afterwards, which is exact for add, subtract
        // and multiply and correct for divide because a double has more
        // than twice the precision of a single.
        const format = double ? F64 : F32
        const aBits = double ? this.readDouble(inst.rs1) : widen(this.fpr[inst.rs1]!)
        const bBits = double ? this.readDouble(inst.rs2) : widen(this.fpr[inst.rs2]!)
        const a = bitsToF64(aBits)
        const b = bitsToF64(bBits)
        const wide = apply(inst.op, a, b)
        const result = double ? wide : Math.fround(wide)

        // The exceptions are recomputed from the exact result, because
        // the host's own status word is not reachable from JavaScript.
        let status: RoundingStatus = NO_STATUS
        let invalid = false
        let divZero = false
        switch (inst.op) {
          case SPARC.FADD:
            status = statusOf(exactSum(aBits, bBits), result, format); break
          case SPARC.FSUB:
            status = statusOf(exactSum(aBits, negate(bBits)), result, format); break
          case SPARC.FMUL:
            status = statusOf(exactProduct(aBits, bBits), result, format)
            invalid = (a === 0 && !Number.isFinite(b)) || (b === 0 && !Number.isFinite(a))
            break
          default:
            status = quotientStatus(aBits, bBits, result, format)
            divZero = b === 0 && a !== 0 && !Number.isNaN(a)
            invalid = (a === 0 && b === 0) ||
              (!Number.isFinite(a) && !Number.isFinite(b) && !Number.isNaN(a) && !Number.isNaN(b))
            break
        }
        this.setExceptions(SparcInterpreter.excOf(status, invalid, divZero))
        this.writeResult(inst.rd, result, double, [aBits, bBits])
        return
      }
      case SPARC.FSQRT: {
        const aBits = double ? this.readDouble(inst.rs2) : widen(this.fpr[inst.rs2]!)
        const a = bitsToF64(aBits)
        const wide = Math.sqrt(a)
        const result = double ? wide : Math.fround(wide)
        this.setExceptions(SparcInterpreter.excOf(
          sqrtStatus(aBits, result), a < 0,
        ))
        this.writeResult(inst.rd, result, double, [aBits])
        return
      }
      case SPARC.FSMULD: {
        const a = bitsToF32(this.fpr[inst.rs1]!)
        const b = bitsToF32(this.fpr[inst.rs2]!)
        // Single operands, double result: exact, because the product of
        // two 24-bit significands fits in 53. So it raises nothing, and
        // still has to say so, since cexc describes the last operation
        // rather than accumulating.
        this.setExceptions(0)
        this.writeResult(inst.rd, a * b, true,
          [widen(this.fpr[inst.rs1]!), widen(this.fpr[inst.rs2]!)])
        return
      }
      case SPARC.FTO: {
        const from = inst.fromFormat
        const to = inst.toFormat
        let value: number
        if (from === FpFormat.INT32) value = this.fpr[inst.rs2]! | 0
        else if (from === FpFormat.DOUBLE) value = bitsToF64(this.readDouble(inst.rs2))
        else value = bitsToF32(this.fpr[inst.rs2]!)

        if (to === FpFormat.INT32) {
          // Conversion to integer truncates toward zero on this
          // architecture regardless of the rounding mode. A value that
          // will not fit, or is not a number, is invalid rather than
          // merely inexact.
          const truncated = Math.trunc(value)
          const outOfRange = !Number.isFinite(value) ||
            truncated > 0x7fffffff || truncated < -0x80000000
          const clamped = Number.isNaN(truncated)
            ? 0x7fffffff
            : Math.min(Math.max(truncated, -0x80000000), 0x7fffffff)
          this.setExceptions(outOfRange ? 0x10 : (truncated !== value ? 0x01 : 0))
          this.fpr[inst.rd] = clamped >>> 0
        } else if (to === FpFormat.DOUBLE) {
          // Anything that fits in a single or a 32-bit integer is exact
          // as a double, so this widening never rounds.
          this.setExceptions(0)
          this.writeResult(inst.rd, value, true,
            from === FpFormat.SINGLE ? [widen(this.fpr[inst.rs2]!)] : [])
        } else {
          const rounded = Math.fround(value)
          this.setExceptions(SparcInterpreter.excOf(
            statusOf(from === FpFormat.INT32 ? { m: BigInt(value), e: 0 } : exactOfWide(value),
              rounded, F32),
          ))
          this.writeResult(inst.rd, rounded, false,
            from === FpFormat.DOUBLE ? [this.readDouble(inst.rs2)] : [])
        }
        return
      }
      case SPARC.FCMP: {
        let a: number
        let b: number
        if (double) {
          a = bitsToF64(this.readDouble(inst.rs1))
          b = bitsToF64(this.readDouble(inst.rs2))
        } else {
          a = bitsToF32(this.fpr[inst.rs1]!)
          b = bitsToF32(this.fpr[inst.rs2]!)
        }
        const unordered = double
          ? isNan64(this.readDouble(inst.rs1)) || isNan64(this.readDouble(inst.rs2))
          : isNan32(this.fpr[inst.rs1]!) || isNan32(this.fpr[inst.rs2]!)
        this.fcc = unordered ? 3 : a === b ? 0 : a < b ? 1 : 2
        return
      }
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, BigInt(this.pc), wordBytes(inst.word),
          `operation ${inst.op} has no semantics`,
        )
    }
  }

  private syscall(): void {
    if (!this.linux) {
      throw new IsaError(`${ISA_NAME}: system call with no emulation layer`)
    }
    const raw = this.globals[1]! >>> 0
    const mapped = this.numbers[raw]
    if (mapped === undefined) {
      throw new IsaError(
        `${ISA_NAME}: system call ${raw} at 0x${this.pc.toString(16)} is not mapped`,
      )
    }
    const args: bigint[] = []
    for (let i = 0; i < 6; i++) args.push(BigInt(this.reg(8 + i) >>> 0))
    const result = this.linux.dispatch(ISA_NAME, mapped, args)
    if (result.exited) {
      this.exited = true
      this.exitCode = this.linux.exitCode
      return
    }
    const value = BigInt.asIntN(32, result.value)
    // An error is reported by setting the carry flag and returning the
    // positive errno, which is this ABI's own convention and not the
    // negative-return one every other target here uses.
    if (value < 0n) {
      this.c = true
      this.setReg(8, Number(-value) | 0)
    } else {
      this.c = false
      this.setReg(8, Number(value) | 0)
    }
  }
}

function apply(op: number, a: number, b: number): number {
  switch (op) {
    case SPARC.FADD: return a + b
    case SPARC.FSUB: return a - b
    case SPARC.FMUL: return a * b
    default: return a / b
  }
}

/** A single-precision pattern as the double that holds the same value. */
function widen(bits: number): bigint {
  return f64ToBits(bitsToF32(bits))
}

/** The sign bit flipped, for expressing subtraction as addition. */
function negate(bits: bigint): bigint {
  return bits ^ 0x8000_0000_0000_0000n
}

/** The exact value of a double already in hand. */
function exactOfWide(value: number): { m: bigint; e: number } | null {
  if (!Number.isFinite(value)) return null
  return exactOf(f64ToBits(value))
}

function wordBytes(word: number): Uint8Array {
  return Uint8Array.from([
    (word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff,
  ])
}
