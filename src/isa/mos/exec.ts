/**
 * MOS 6502 interpreter.
 *
 * The smallest instruction set here and the one with the most folklore
 * attached, which makes it the one where it matters most that the
 * behaviour comes from an oracle rather than from memory. Four things in
 * this file are the ones an implementation written from a reference card
 * gets wrong, and all four are checked instruction-by-instruction against
 * the SingleStepTests per-opcode vectors.
 *
 * **Decimal mode.** `sed` does not switch the adder into a different
 * mode; it inserts a correction after it, and the correction happens
 * *between* the flags being computed and the result being stored. So on
 * this processor an `adc` in decimal mode sets N and V from a value that
 * is never written anywhere, and sets Z from the binary result as though
 * decimal mode were off. This is not a defect being emulated for
 * compatibility -- it is what the flags mean on an NMOS 6502, and every
 * published account of it exists because people got it wrong.
 *
 * **`sbc` in decimal mode sets its flags in binary.** All four of them.
 * Only the accumulator is corrected. The asymmetry with `adc` is real.
 *
 * **Indirection wraps, and it wraps differently in each mode.** A zero
 * page pointer read at $FF takes its high byte from $00, not $0100. An
 * indirect `jmp` through $xxFF takes its high byte from $xx00, not the
 * next page. The first is by design; the second is a defect; the
 * architecture has both and so does this.
 *
 * **The break flag is not a flag.** There is no bit four in the status
 * register. What exists is a value pushed onto the stack, and whether
 * bit four is set in it depends on whether the push came from software
 * or from an interrupt. Bit five in that value is always set.
 */
import { ExecutionBudgetExceeded, IsaError } from '../common/errors.ts'
import { RunState, type ArchState, type Interpreter, type RetireChunk } from '../common/trace.ts'
import { Vector, type MosBus } from './bus.ts'
import { Flag, ISA_NAME, MOS, Mode, type MosInst } from './decode.ts'
import type { MosImage, MosStaticInst } from './image.ts'

const DEFAULT_BUDGET = 2_000_000_000

/** What a device may ask of the machine it is plugged into. */
export interface MosHost {
  /** Stop the run and report this exit status. */
  exit(code: number): void
  /** A byte the guest sent to a stream; 1 is stdout and 2 is stderr. */
  emit(stream: 1 | 2, byte: number): void
}

export interface MosOptions {
  /**
   * Where to begin. Omitted means the reset vector, which is how the
   * hardware starts and how a flat image with no ELF headers must.
   */
  entry?: number
  instructionBudget?: number
  /** Initial stack pointer; the hardware leaves this undefined. */
  initialSp?: number
}

export class MosInterpreter implements Interpreter {
  readonly image: MosImage
  readonly bus: MosBus

  a = 0
  x = 0
  y = 0
  s = 0xfd
  /**
   * Bit five is not a flag and always reads as one; the rest start clear.
   *
   * Both values were measured from the reference rather than assumed. A
   * real 6502 sets the interrupt disable during its reset sequence, but
   * this platform has no reset sequence -- the simulator loads the image
   * and enters the program with a cleared status register -- so a guest
   * that pushes the status word at startup sees I clear, and this has to
   * agree. The stack pointer is $FD, which is where a hardware reset
   * would also leave it after pushing three bytes from zero.
   */
  p: number = Flag.UNUSED
  pc = 0

  exitCode = 0
  retired = 0

  private exited = false
  private next = 0
  private access = 0n
  private accessWidth = 0
  private taken = 0
  private readonly budget: number
  private readonly out: number[] = []
  private readonly err: number[] = []

  readonly host: MosHost = {
    exit: (code: number): void => {
      this.exited = true
      this.exitCode = code & 0xff
    },
    emit: (stream: 1 | 2, byte: number): void => {
      (stream === 1 ? this.out : this.err).push(byte & 0xff)
    },
  }

  constructor(image: MosImage, bus: MosBus, options: MosOptions = {}) {
    this.image = image
    this.bus = bus
    this.budget = options.instructionBudget ?? DEFAULT_BUDGET
    if (options.initialSp !== undefined) this.s = options.initialSp & 0xff
    this.pc = (options.entry ?? bus.readWord(Vector.RESET)) & 0xffff
  }

  get programCounter(): bigint {
    return BigInt(this.pc)
  }

  gpr(index: number): bigint {
    switch (index) {
      case 0: return BigInt(this.a)
      case 1: return BigInt(this.x)
      case 2: return BigInt(this.y)
      case 3: return BigInt(this.s)
      case 4: return BigInt(this.p)
      default: return 0n
    }
  }

  setGpr(index: number, value: bigint): void {
    const v = Number(value & 0xffn)
    switch (index) {
      case 0: this.a = v; break
      case 1: this.x = v; break
      case 2: this.y = v; break
      case 3: this.s = v; break
      case 4: this.p = v | Flag.UNUSED; break
      default: break
    }
  }

  finalState(): ArchState {
    return {
      gpr: [BigInt(this.a), BigInt(this.x), BigInt(this.y), BigInt(this.s)],
      fpr: [],
      status: { p: BigInt(this.p) },
      pc: BigInt(this.pc),
    }
  }

  stdout(): Uint8Array {
    return Uint8Array.from(this.out)
  }

  stderr(): Uint8Array {
    return Uint8Array.from(this.err)
  }

  run(into: RetireChunk): RunState {
    const capacity = into.pc.length
    let n = 0
    while (n < capacity && !this.exited) {
      const si = this.image.at(BigInt(this.pc))
      const pc = this.pc
      this.access = 0n
      this.accessWidth = 0
      this.taken = 0
      this.next = (pc + si.inst.length) & 0xffff
      this.execute(si)
      into.pc[n] = BigInt(pc)
      into.nextPc[n] = BigInt(this.next)
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

  /**
   * One instruction, for the per-opcode conformance vectors.
   *
   * Those vectors are the closest thing this target has to a lockstep
   * oracle: they set the whole machine to an arbitrary state, run
   * exactly one instruction, and say what the whole machine should then
   * be. Driving that through `run` would mean allocating a chunk per
   * case, ten thousand times per opcode.
   */
  step(): void {
    const si = this.image.at(BigInt(this.pc))
    this.access = 0n
    this.accessWidth = 0
    this.taken = 0
    this.next = (this.pc + si.inst.length) & 0xffff
    this.execute(si)
    this.pc = this.next
    this.retired += 1
  }

  // ---------------------------------------------------------------------
  // Flags.
  // ---------------------------------------------------------------------

  private flag(bit: number): boolean {
    return (this.p & bit) !== 0
  }

  private setFlag(bit: number, on: boolean): void {
    if (on) this.p |= bit
    else this.p &= ~bit & 0xff
  }

  private setNZ(value: number): void {
    this.p = (this.p & ~(Flag.N | Flag.Z) & 0xff) |
      (value & 0x80) | (value === 0 ? Flag.Z : 0)
  }

  // ---------------------------------------------------------------------
  // Memory. Every store may have landed on an instruction: on a machine
  // with three registers, rewriting the operand of a `jmp` or an `lda` is
  // an ordinary way to index, and the compiler's own runtime does it.
  // ---------------------------------------------------------------------

  private read(address: number): number {
    return this.bus.read(address & 0xffff)
  }

  private write(address: number, value: number): void {
    const a = address & 0xffff
    this.bus.write(a, value)
    this.image.invalidate(a)
  }

  private push(value: number): void {
    this.noteStack(0x0100 | this.s)
    this.write(0x0100 | this.s, value)
    this.s = (this.s - 1) & 0xff
  }

  private pull(): number {
    this.s = (this.s + 1) & 0xff
    this.noteStack(0x0100 | this.s)
    return this.read(0x0100 | this.s)
  }

  /**
   * Widens this instruction's reported access to cover a stack byte.
   *
   * `jsr`, `rts`, `pha` and the rest move one to three bytes through the
   * stack page, and those bytes are real memory traffic: this machine
   * has no link register. Left unreported, a timing model saw them as
   * accesses of no width at address zero.
   */
  private noteStack(address: number): void {
    if (this.accessWidth === 0) {
      this.access = BigInt(address)
      this.accessWidth = 1
      return
    }
    const low = Math.min(Number(this.access), address)
    const high = Math.max(Number(this.access) + this.accessWidth - 1, address)
    // A push or pull that wrapped around the stack page is not one range;
    // the first byte stands for it.
    if (high - low >= 3) return
    this.access = BigInt(low)
    this.accessWidth = high - low + 1
  }

  // ---------------------------------------------------------------------
  // Addressing.
  // ---------------------------------------------------------------------

  /**
   * The address an instruction works on.
   *
   * Two wraps live here and they are not the same wrap. A zero page
   * pointer is two bytes that both have to be in page zero, so the high
   * byte of a pointer at $FF comes from $00. An absolute index simply
   * wraps at the top of the address space.
   */
  private effective(inst: MosInst): number {
    switch (inst.mode) {
      case Mode.ZERO_PAGE:
        return inst.operand
      case Mode.ZERO_PAGE_X:
        return (inst.operand + this.x) & 0xff
      case Mode.ZERO_PAGE_Y:
        return (inst.operand + this.y) & 0xff
      case Mode.ABSOLUTE:
        return inst.operand
      case Mode.ABSOLUTE_X:
        return (inst.operand + this.x) & 0xffff
      case Mode.ABSOLUTE_Y:
        return (inst.operand + this.y) & 0xffff
      case Mode.INDEXED_INDIRECT: {
        const pointer = (inst.operand + this.x) & 0xff
        return this.read(pointer) | (this.read((pointer + 1) & 0xff) << 8)
      }
      case Mode.INDIRECT_INDEXED: {
        const base = this.read(inst.operand) |
          (this.read((inst.operand + 1) & 0xff) << 8)
        return (base + this.y) & 0xffff
      }
      default:
        throw new IsaError(
          `${ISA_NAME}: addressing mode ${inst.mode} has no effective address`,
        )
    }
  }

  /** The byte an instruction operates on, recording the access for timing. */
  private operand(inst: MosInst): number {
    if (inst.mode === Mode.IMMEDIATE) return inst.operand
    if (inst.mode === Mode.ACCUMULATOR) return this.a
    const address = this.effective(inst)
    this.access = BigInt(address)
    this.accessWidth = 1
    return this.read(address)
  }

  // ---------------------------------------------------------------------
  // Arithmetic. The two instructions decimal mode changes, and it changes
  // them differently.
  // ---------------------------------------------------------------------

  private adc(m: number): void {
    const a = this.a
    const carry = this.flag(Flag.C) ? 1 : 0
    if (this.flag(Flag.D)) {
      // The correction is applied nibble by nibble, and the flags are
      // read off in the middle of it.
      let low = (a & 0x0f) + (m & 0x0f) + carry
      if (low >= 0x0a) low = ((low + 0x06) & 0x0f) + 0x10
      let sum = (a & 0xf0) + (m & 0xf0) + low
      // N and V describe a value that is never stored anywhere: the sum
      // after the low nibble is corrected and before the high one is.
      const intermediate = sum & 0xff
      this.setFlag(Flag.N, (intermediate & 0x80) !== 0)
      this.setFlag(Flag.V, ((a ^ intermediate) & (m ^ intermediate) & 0x80) !== 0)
      if (sum >= 0xa0) sum += 0x60
      this.setFlag(Flag.C, sum >= 0x100)
      // Z alone ignores decimal mode entirely.
      this.setFlag(Flag.Z, ((a + m + carry) & 0xff) === 0)
      this.a = sum & 0xff
      return
    }
    const sum = a + m + carry
    this.a = sum & 0xff
    this.setFlag(Flag.C, sum > 0xff)
    // Overflow is when both operands agreed about their sign and the
    // result disagreed with them.
    this.setFlag(Flag.V, ((a ^ this.a) & (m ^ this.a) & 0x80) !== 0)
    this.setNZ(this.a)
  }

  private sbc(m: number): void {
    const a = this.a
    const carry = this.flag(Flag.C) ? 1 : 0
    // Every flag is the binary subtraction's, in both modes. Decimal mode
    // corrects the accumulator and nothing else.
    const difference = a - m - (1 - carry)
    const binary = difference & 0xff
    this.setFlag(Flag.C, difference >= 0)
    this.setFlag(Flag.V, ((a ^ m) & (a ^ binary) & 0x80) !== 0)
    this.setNZ(binary)
    if (this.flag(Flag.D)) {
      let low = (a & 0x0f) - (m & 0x0f) + carry - 1
      if (low < 0) low = ((low - 0x06) & 0x0f) - 0x10
      let value = (a & 0xf0) - (m & 0xf0) + low
      if (value < 0) value -= 0x60
      this.a = value & 0xff
      return
    }
    this.a = binary
  }

  private compare(register: number, m: number): void {
    this.setFlag(Flag.C, register >= m)
    this.setNZ((register - m) & 0xff)
  }

  /** A shift or rotate, which is the same instruction in two places. */
  private shift(inst: MosInst, compute: (value: number) => number): void {
    if (inst.mode === Mode.ACCUMULATOR) {
      this.a = compute(this.a)
      return
    }
    const address = this.effective(inst)
    this.access = BigInt(address)
    this.accessWidth = 1
    this.write(address, compute(this.read(address)))
  }

  private branch(condition: boolean, inst: MosInst): void {
    if (!condition) return
    this.next = inst.target
    this.taken = 1
  }

  // ---------------------------------------------------------------------

  private execute(si: MosStaticInst): void {
    const inst = si.inst
    switch (inst.op) {
      // Loads and stores.
      case MOS.LDA: this.a = this.operand(inst); this.setNZ(this.a); return
      case MOS.LDX: this.x = this.operand(inst); this.setNZ(this.x); return
      case MOS.LDY: this.y = this.operand(inst); this.setNZ(this.y); return
      case MOS.STA: case MOS.STX: case MOS.STY: {
        const address = this.effective(inst)
        this.access = BigInt(address)
        this.accessWidth = 1
        this.write(address, inst.op === MOS.STA ? this.a :
          inst.op === MOS.STX ? this.x : this.y)
        return
      }

      // Between registers. `txs` is the one that leaves the flags alone,
      // which is what makes it usable next to a comparison.
      case MOS.TAX: this.x = this.a; this.setNZ(this.x); return
      case MOS.TAY: this.y = this.a; this.setNZ(this.y); return
      case MOS.TXA: this.a = this.x; this.setNZ(this.a); return
      case MOS.TYA: this.a = this.y; this.setNZ(this.a); return
      case MOS.TSX: this.x = this.s; this.setNZ(this.x); return
      case MOS.TXS: this.s = this.x; return

      // The stack. What `php` pushes is not the status register: bits
      // four and five do not exist in it, and both are set in the value
      // that reaches memory.
      case MOS.PHA: this.push(this.a); return
      case MOS.PHP: this.push(this.p | Flag.B | Flag.UNUSED); return
      case MOS.PLA: this.a = this.pull(); this.setNZ(this.a); return
      case MOS.PLP: this.p = (this.pull() & ~Flag.B & 0xff) | Flag.UNUSED; return

      // Arithmetic and logic.
      case MOS.ADC: this.adc(this.operand(inst)); return
      case MOS.SBC: this.sbc(this.operand(inst)); return
      case MOS.AND: this.a &= this.operand(inst); this.setNZ(this.a); return
      case MOS.ORA: this.a |= this.operand(inst); this.setNZ(this.a); return
      case MOS.EOR: this.a ^= this.operand(inst); this.setNZ(this.a); return
      case MOS.CMP: this.compare(this.a, this.operand(inst)); return
      case MOS.CPX: this.compare(this.x, this.operand(inst)); return
      case MOS.CPY: this.compare(this.y, this.operand(inst)); return
      case MOS.BIT: {
        // The only instruction that copies two bits of memory straight
        // into the flags without the accumulator being involved in them.
        const m = this.operand(inst)
        this.setFlag(Flag.Z, (this.a & m) === 0)
        this.setFlag(Flag.N, (m & 0x80) !== 0)
        this.setFlag(Flag.V, (m & 0x40) !== 0)
        return
      }
      case MOS.INC: this.shift(inst, (v) => {
        const r = (v + 1) & 0xff; this.setNZ(r); return r
      }); return
      case MOS.DEC: this.shift(inst, (v) => {
        const r = (v - 1) & 0xff; this.setNZ(r); return r
      }); return
      case MOS.INX: this.x = (this.x + 1) & 0xff; this.setNZ(this.x); return
      case MOS.INY: this.y = (this.y + 1) & 0xff; this.setNZ(this.y); return
      case MOS.DEX: this.x = (this.x - 1) & 0xff; this.setNZ(this.x); return
      case MOS.DEY: this.y = (this.y - 1) & 0xff; this.setNZ(this.y); return

      // Shifts and rotates.
      case MOS.ASL: this.shift(inst, (v) => {
        this.setFlag(Flag.C, (v & 0x80) !== 0)
        const r = (v << 1) & 0xff; this.setNZ(r); return r
      }); return
      case MOS.LSR: this.shift(inst, (v) => {
        this.setFlag(Flag.C, (v & 0x01) !== 0)
        const r = v >> 1; this.setNZ(r); return r
      }); return
      case MOS.ROL: this.shift(inst, (v) => {
        const carry = this.flag(Flag.C) ? 1 : 0
        this.setFlag(Flag.C, (v & 0x80) !== 0)
        const r = ((v << 1) | carry) & 0xff; this.setNZ(r); return r
      }); return
      case MOS.ROR: this.shift(inst, (v) => {
        const carry = this.flag(Flag.C) ? 0x80 : 0
        this.setFlag(Flag.C, (v & 0x01) !== 0)
        const r = (v >> 1) | carry; this.setNZ(r); return r
      }); return

      // Control.
      case MOS.JMP:
        if (inst.mode === Mode.INDIRECT) {
          // The defect: the pointer's high byte is fetched without the
          // low byte's carry, so a pointer at $xxFF reads its high byte
          // from $xx00. Programs were built around this.
          const low = inst.operand
          const high = (low & 0xff00) | ((low + 1) & 0x00ff)
          this.next = this.read(low) | (this.read(high) << 8)
          this.access = BigInt(low)
          // Both bytes of the pointer, unless the defect split them.
          this.accessWidth = high === low + 1 ? 2 : 1
        } else {
          this.next = inst.target
        }
        return
      case MOS.JSR: {
        // What is pushed is the address of the instruction's last byte,
        // not of the next instruction, which is why `rts` adds one.
        const returnTo = (this.pc + 2) & 0xffff
        this.push((returnTo >> 8) & 0xff)
        this.push(returnTo & 0xff)
        this.next = inst.target
        return
      }
      case MOS.RTS: {
        const low = this.pull()
        const high = this.pull()
        this.next = ((high << 8) | low) + 1 & 0xffff
        return
      }
      case MOS.RTI: {
        this.p = (this.pull() & ~Flag.B & 0xff) | Flag.UNUSED
        const low = this.pull()
        const high = this.pull()
        // Unlike `rts`, the address is used as it is: an interrupt
        // pushed the address it was going to run next.
        this.next = ((high << 8) | low) & 0xffff
        return
      }
      case MOS.BRK: {
        // `brk` is one byte but skips two, so the byte after it is
        // available to say which break this was.
        const returnTo = (this.pc + 2) & 0xffff
        this.push((returnTo >> 8) & 0xff)
        this.push(returnTo & 0xff)
        this.push(this.p | Flag.B | Flag.UNUSED)
        this.setFlag(Flag.I, true)
        this.next = this.bus.readWord(Vector.IRQ)
        return
      }

      case MOS.BPL: this.branch(!this.flag(Flag.N), inst); return
      case MOS.BMI: this.branch(this.flag(Flag.N), inst); return
      case MOS.BVC: this.branch(!this.flag(Flag.V), inst); return
      case MOS.BVS: this.branch(this.flag(Flag.V), inst); return
      case MOS.BCC: this.branch(!this.flag(Flag.C), inst); return
      case MOS.BCS: this.branch(this.flag(Flag.C), inst); return
      case MOS.BNE: this.branch(!this.flag(Flag.Z), inst); return
      case MOS.BEQ: this.branch(this.flag(Flag.Z), inst); return

      case MOS.CLC: this.setFlag(Flag.C, false); return
      case MOS.SEC: this.setFlag(Flag.C, true); return
      case MOS.CLI: this.setFlag(Flag.I, false); return
      case MOS.SEI: this.setFlag(Flag.I, true); return
      case MOS.CLD: this.setFlag(Flag.D, false); return
      case MOS.SED: this.setFlag(Flag.D, true); return
      case MOS.CLV: this.setFlag(Flag.V, false); return

      case MOS.NOP: return

      default:
        // The decoder refuses everything it does not implement, so
        // reaching here means the two tables disagree.
        throw new IsaError(
          `${ISA_NAME}: decoded operation ${inst.op} has no semantics ` +
          `(opcode ${inst.opcode.toString(16)} at 0x${this.pc.toString(16)})`,
        )
    }
  }
}
