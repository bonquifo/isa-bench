/**
 * WebAssembly interpreter.
 *
 * ## A trap is not a fault
 *
 * Every other backend here has one category of bad outcome: something
 * the implementation does not cover, which throws loudly because a
 * quietly plausible answer is the worst thing this project can produce.
 *
 * This architecture has a second category that is nothing like it. A
 * division by zero, an access past the end of linear memory, an
 * `unreachable`, a `call_indirect` through the wrong type -- these are
 * *specified* outcomes. The standard says the program traps, every
 * engine agrees on exactly which programs trap, and a conforming
 * implementation must trap on the same ones. So `WasmTrap` is separate
 * from `UnimplementedInstruction`: the first is the right answer and the
 * differential tier checks that both sides produce it, and the second is
 * still a gap in this backend.
 *
 * Conflating them would lose the one property worth having here, which
 * is that "this program traps" is a result that can be compared.
 *
 * ## The stack is real, the depths are not needed at run time
 *
 * The image resolved every branch to a target, a count of values to
 * carry and a depth to carry them to, so there is no label stack here
 * and `end` is genuinely free. What remains dynamic is the operand stack
 * itself, the locals, and the frames -- and since the image's depths are
 * frame-relative, each frame records where its region of the shared
 * stack begins.
 *
 * ## Floating point
 *
 * The host's doubles are the implementation, which is exact for f64 and,
 * for f32, exact via `Math.fround` because a single rounding of a
 * double-precision sum of two single-precision values is the
 * single-precision sum. What is *not* free is everything around the
 * edges: `min` and `max` are not JavaScript's, `nearest` rounds halves
 * to even rather than away from zero, and a NaN's payload is observable
 * once it reaches memory. Those are written out rather than inherited.
 */
import { ExecutionBudgetExceeded, IsaError, UnimplementedInstruction } from '../common/errors.ts'
import {
  type ArchState,
  type Interpreter,
  type RetireChunk,
  RunState,
} from '../common/trace.ts'
import { Flow, ISA_NAME, nameOf } from './decode.ts'
import { GLOBAL_SLOTS, Res, type WasmImage, type WasmStaticInst } from './image.ts'
import { PAGE_BYTES, bodyOf, typeOf, type WasmModule } from './module.ts'
import { callWasi, type WasiHost } from './wasi.ts'

/**
 * A specified runtime failure: the program is valid and the standard
 * says it stops here. Distinct from the errors that mean this backend is
 * incomplete -- see the note at the top.
 */
export class WasmTrap extends IsaError {
  readonly reason: string

  constructor(reason: string, at: number) {
    super(`${ISA_NAME}: trap at offset 0x${at.toString(16)}: ${reason}`)
    this.name = 'WasmTrap'
    this.reason = reason
  }
}

const DEFAULT_BUDGET = 200_000_000
const STACK_CAPACITY = 4096
const LOCAL_CAPACITY = 1 << 16
const MAX_FRAMES = 2048
/** Pages a module with no declared maximum may reach: 64 MiB. */
const DEFAULT_MAX_PAGES = 1024

export interface WasmOptions {
  instructionBudget?: number
}

interface Frame {
  /** Where to resume in the caller; -1 for the outermost activation. */
  returnPc: number
  /** Base of this activation's locals in the shared array. */
  localBase: number
  /** Base of this activation's operand stack, which image depths are from. */
  stackBase: number
  /** Where the caller's locals ended, restored on return. */
  localTop: number
}

const scratch = new DataView(new ArrayBuffer(8))

function f32FromBits(bits: number): number {
  scratch.setUint32(0, bits >>> 0, true)
  return scratch.getFloat32(0, true)
}
function f32ToBits(value: number): number {
  scratch.setFloat32(0, value, true)
  return scratch.getUint32(0, true)
}
function f64FromBits(bits: bigint): number {
  scratch.setBigUint64(0, BigInt.asUintN(64, bits), true)
  return scratch.getFloat64(0, true)
}
function f64ToBits(value: number): bigint {
  scratch.setFloat64(0, value, true)
  return scratch.getBigUint64(0, true)
}

/**
 * Rounds to the nearest integer, halves to even.
 *
 * `Math.round` rounds halves up, which differs from this on every
 * halfway case and on the sign of zero for one of them. The difference
 * is invisible until a program rounds 2.5 and 3.5 and expects 2 and 4.
 */
function nearest(x: number): number {
  if (!Number.isFinite(x) || Number.isInteger(x)) return x
  const below = Math.floor(x)
  const above = Math.ceil(x)
  const fraction = x - below
  if (fraction > 0.5) return above
  if (fraction < 0.5) return below
  return below % 2 === 0 ? below : above
}

/**
 * The NaN an arithmetic operation produces when it has no answer.
 *
 * The standard does not say which NaN: `nans` permits any of them, and
 * engines differ -- on x86 the default is `0xfff8...`, with the sign bit
 * set, and on AArch64 it is `0x7ff8...` without.
 *
 * So this is computed rather than written down. Every other floating
 * point operation here is the host's own, which means it produces
 * whatever this machine produces, and the reference engine gets its
 * answer from the same hardware. Taking the host's default for the
 * remaining cases is what keeps the two byte-identical on any machine,
 * and it is a conforming choice on all of them.
 *
 * The literal `NaN` would not do: it is `0x7ff8...` everywhere, which is
 * wrong on exactly the platform these tests usually run on.
 */
const DEFAULT_NAN = (() => {
  const zero = new Float64Array(1)[0]!
  return zero / zero
})()

/**
 * `min` and `max` as this architecture defines them, which is not what
 * the host's `Math` does on either of the two cases that matter.
 *
 * A NaN operand makes the result a NaN, where `Math.min` returns NaN
 * only sometimes and `Math.max` disagrees again. And the zeros are
 * ordered: `min(+0, -0)` is `-0` and `max(+0, -0)` is `+0`, while `<`
 * and `>` consider them equal and would return whichever came first.
 */
function wasmMin(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return DEFAULT_NAN
  if (a === 0 && b === 0) return Object.is(a, -0) || Object.is(b, -0) ? -0 : 0
  return a < b ? a : b
}
function wasmMax(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return DEFAULT_NAN
  // Either one being positive makes the answer positive, which is the
  // mirror of `min` and not the same test with the sign flipped.
  if (a === 0 && b === 0) return Object.is(a, -0) && Object.is(b, -0) ? -0 : 0
  return a > b ? a : b
}

function clz32(value: number): number {
  return Math.clz32(value >>> 0)
}
function ctz32(value: number): number {
  const v = value >>> 0
  return v === 0 ? 32 : 31 - Math.clz32(v & -v)
}
function popcnt32(value: number): number {
  let v = value >>> 0
  let count = 0
  while (v !== 0) { v &= v - 1; count++ }
  return count
}
function clz64(value: bigint): bigint {
  if (value === 0n) return 64n
  let count = 0n
  let v = value
  while ((v & (1n << 63n)) === 0n) { v <<= 1n; count++ }
  return count
}
function ctz64(value: bigint): bigint {
  if (value === 0n) return 64n
  let count = 0n
  let v = value
  while ((v & 1n) === 0n) { v >>= 1n; count++ }
  return count
}
function popcnt64(value: bigint): bigint {
  let v = value
  let count = 0n
  while (v !== 0n) { v &= v - 1n; count++ }
  return count
}

export class WasmInterpreter implements Interpreter {
  readonly image: WasmImage
  readonly module: WasmModule

  exitCode = 0
  retired = 0

  private pc = 0
  private exited = false
  private readonly budget: number

  private readonly stack = new BigUint64Array(STACK_CAPACITY)
  private sp = 0
  private readonly localStore = new BigUint64Array(LOCAL_CAPACITY)
  private localTop = 0
  private readonly frames: Frame[] = []

  readonly globals: BigUint64Array
  readonly table: Int32Array

  private memory: Uint8Array
  private view: DataView
  private pages: number
  private readonly maxPages: number

  private readonly outBytes: number[] = []
  private readonly errBytes: number[] = []

  /** Results of the outermost call, once it has returned. */
  private returned: bigint[] = []

  private access = 0n
  private accessWidth = 0
  private taken = 0
  private nextPcOverride = -1

  constructor(image: WasmImage, options: WasmOptions = {}) {
    this.image = image
    this.module = image.module
    this.budget = options.instructionBudget ?? DEFAULT_BUDGET

    const module = this.module
    if (module.globals.length > GLOBAL_SLOTS) {
      throw new IsaError(
        `${ISA_NAME}: module declares ${module.globals.length} globals, more than ` +
        `the ${GLOBAL_SLOTS} this backend has resource ids for`,
      )
    }
    this.globals = new BigUint64Array(GLOBAL_SLOTS)
    module.globals.forEach((global, i) => { this.globals[i] = global.init })

    this.pages = module.memoryPages
    this.maxPages = module.memoryMax > 0 ? module.memoryMax : DEFAULT_MAX_PAGES
    this.memory = new Uint8Array(this.pages * PAGE_BYTES)
    this.view = new DataView(this.memory.buffer)
    for (const segment of module.data) {
      if (segment.offset + segment.bytes.length > this.memory.length) {
        throw new IsaError(
          `${ISA_NAME}: data segment at 0x${segment.offset.toString(16)} does not fit ` +
          `in ${this.pages} page(s) of memory`,
        )
      }
      this.memory.set(segment.bytes, segment.offset)
    }

    this.table = new Int32Array(Math.max(module.tableSize, 1)).fill(-1)
    for (const segment of module.elements) {
      segment.functions.forEach((func, i) => {
        const at = segment.offset + i
        if (at < this.table.length) this.table[at] = func
      })
    }

    this.pc = Number(image.entry)
    this.pushFrameFor(this.functionAt(this.pc), -1, 0)
  }

  // ---- Entry points --------------------------------------------------

  /** The function whose body starts at an offset. */
  private functionAt(offset: number): number {
    const body = this.module.bodies.find((candidate) => candidate.start === offset)
    if (!body) {
      throw new IsaError(`${ISA_NAME}: 0x${offset.toString(16)} is not a function entry`)
    }
    return body.index
  }

  /**
   * Redirects the run to an exported function with explicit arguments.
   *
   * The differential tier needs this: comparing against an engine means
   * calling the same export with the same values, and a module compiled
   * freestanding has no single entry point that would do it.
   */
  invoke(funcIndex: number, args: readonly bigint[]): void {
    const body = bodyOf(this.module, funcIndex)
    if (!body) {
      throw new IsaError(`${ISA_NAME}: function ${funcIndex} is not defined in this module`)
    }
    this.frames.length = 0
    this.sp = 0
    this.localTop = 0
    this.exited = false
    this.returned = []
    for (const arg of args) this.push(arg)
    this.pc = body.start
    this.pushFrameFor(funcIndex, -1, args.length)
  }

  /** What the outermost call left behind, once it has returned. */
  results(): readonly bigint[] {
    return this.returned
  }

  memoryBytes(): Uint8Array {
    return this.memory
  }

  memoryPages(): number {
    return this.pages
  }

  // ---- Frames --------------------------------------------------------

  private pushFrameFor(funcIndex: number, returnPc: number, argCount: number): void {
    if (this.frames.length >= MAX_FRAMES) {
      // Recursion without a base case is the usual cause, and the
      // standard calls exhausting the engine's stack a trap.
      throw new WasmTrap('call stack exhausted', this.pc)
    }
    const body = bodyOf(this.module, funcIndex)
    if (!body) {
      throw new IsaError(`${ISA_NAME}: function ${funcIndex} has no body`)
    }
    const localBase = this.localTop
    if (localBase + body.localCount > LOCAL_CAPACITY) {
      throw new WasmTrap('locals exhausted', this.pc)
    }
    // Every local starts at zero -- the standard requires that rather
    // than leaving it undefined -- and the arguments then land in the
    // first ones. Zeroing first rather than only the declared locals
    // matters because this array is reused across activations.
    for (let i = 0; i < body.localCount; i++) this.localStore[localBase + i] = 0n
    for (let i = 0; i < argCount; i++) {
      this.localStore[localBase + i] = this.stack[this.sp - argCount + i]!
    }
    this.sp -= argCount
    this.frames.push({
      returnPc,
      localBase,
      stackBase: this.sp,
      localTop: this.localTop,
    })
    this.localTop = localBase + body.localCount
  }

  private get frame(): Frame {
    const top = this.frames[this.frames.length - 1]
    if (!top) throw new IsaError(`${ISA_NAME}: no active frame`)
    return top
  }

  // ---- The stack -----------------------------------------------------

  private push(bits: bigint): void {
    if (this.sp >= STACK_CAPACITY) throw new WasmTrap('operand stack exhausted', this.pc)
    this.stack[this.sp++] = BigInt.asUintN(64, bits)
  }
  private pop(): bigint {
    if (this.sp === 0) throw new IsaError(`${ISA_NAME}: operand stack underflow`)
    return this.stack[--this.sp]!
  }
  private popU32(): number {
    return Number(this.pop() & 0xffff_ffffn) >>> 0
  }
  private popI32(): number {
    return this.popU32() | 0
  }
  private pushI32(value: number): void {
    this.push(BigInt(value >>> 0))
  }
  private pushBool(value: boolean): void {
    this.pushI32(value ? 1 : 0)
  }
  private popF32(): number {
    return f32FromBits(this.popU32())
  }
  private pushF32(value: number): void {
    this.push(BigInt(f32ToBits(value)))
  }
  private popF64(): number {
    return f64FromBits(this.pop())
  }
  private pushF64(value: number): void {
    this.push(f64ToBits(value))
  }

  // ---- Interpreter contract ------------------------------------------

  get programCounter(): bigint {
    return BigInt(this.pc)
  }

  /**
   * The globals, which is what stands in for a register file here.
   *
   * There is nothing else it could be: locals and stack slots belong to
   * an activation and do not exist between calls, and a global is the
   * one location a compiler keeps something in across them -- clang puts
   * the shadow stack pointer in global 0.
   */
  gpr(index: number): bigint {
    if (index >= Res.GLOBAL && index < Res.GLOBAL + GLOBAL_SLOTS) {
      return this.globals[index - Res.GLOBAL]!
    }
    if (index === Res.MEMORY) return BigInt(this.pages)
    if (index === Res.FRAME) return BigInt(this.frames.length)
    return 0n
  }

  finalState(): ArchState {
    const gpr: bigint[] = []
    for (let i = 0; i < GLOBAL_SLOTS; i++) gpr.push(this.globals[i]!)
    return {
      gpr,
      // No floating-point file: an f64 lives in a stack slot or a local,
      // both of which are gone by the time a function returns.
      fpr: [],
      status: {
        pages: BigInt(this.pages),
        frames: BigInt(this.frames.length),
        results: BigInt(this.returned.length),
      },
      pc: BigInt(this.pc),
    }
  }

  stdout(): Uint8Array {
    return Uint8Array.from(this.outBytes)
  }
  stderr(): Uint8Array {
    return Uint8Array.from(this.errBytes)
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
      this.nextPcOverride = -1

      this.execute(si)

      const next = this.exited
        ? pc
        : this.nextPcOverride >= 0 ? this.nextPcOverride : pc + si.bytes
      if (!this.exited) this.pc = next

      into.pc[n] = BigInt(pc)
      into.nextPc[n] = BigInt(next)
      into.effAddr[n] = this.access
      into.accessWidth[n] = this.accessWidth
      into.taken[n] = this.taken
      n += 1
      this.retired += 1
      if (this.retired > this.budget) {
        throw new ExecutionBudgetExceeded(ISA_NAME, this.retired)
      }
    }
    into.count = n
    return this.exited ? RunState.EXITED : RunState.MORE
  }

  // ---- Control -------------------------------------------------------

  private branchTo(branch: { target: number; keep: number; targetDepth: number }): void {
    const from = this.sp - branch.keep
    const to = this.frame.stackBase + branch.targetDepth
    for (let i = 0; i < branch.keep; i++) this.stack[to + i] = this.stack[from + i]!
    this.sp = to + branch.keep
    this.nextPcOverride = branch.target
  }

  private returnFromFrame(keep: number): void {
    const frame = this.frames.pop()
    if (!frame) throw new IsaError(`${ISA_NAME}: return with no frame`)
    const from = this.sp - keep
    for (let i = 0; i < keep; i++) this.stack[frame.stackBase + i] = this.stack[from + i]!
    this.sp = frame.stackBase + keep
    this.localTop = frame.localTop

    if (frame.returnPc < 0) {
      // The outermost activation. Whatever it left is the result.
      this.returned = []
      for (let i = 0; i < keep; i++) this.returned.push(this.stack[frame.stackBase + i]!)
      if (keep > 0 && this.exitCode === 0) {
        this.exitCode = Number(BigInt.asIntN(32, this.returned[0]!)) & 0xff
      }
      this.exited = true
      return
    }
    this.nextPcOverride = frame.returnPc
  }

  private callFunction(si: WasmStaticInst, funcIndex: number): void {
    const type = typeOf(this.module, funcIndex)
    if (funcIndex < this.module.importedFuncs.length) {
      this.callImport(si, funcIndex)
      return
    }
    this.pushFrameFor(funcIndex, this.pc + si.bytes, type.params.length)
    this.nextPcOverride = bodyOf(this.module, funcIndex)!.start
  }

  /**
   * The host side of an import.
   *
   * One interface, not several: `wasi_snapshot_preview1`, which is what
   * a real toolchain links against. An import from anywhere else, or one
   * this backend has not built, is refused rather than answered -- a
   * libc told that a call it does not have succeeded carries on and goes
   * wrong somewhere else entirely.
   */
  private callImport(si: WasmStaticInst, funcIndex: number): void {
    const imported = this.module.importedFuncs[funcIndex]!
    const type = typeOf(this.module, funcIndex)
    const args: bigint[] = new Array<bigint>(type.params.length).fill(0n)
    for (let i = type.params.length - 1; i >= 0; i--) args[i] = this.pop()

    const result = imported.module === 'wasi_snapshot_preview1'
      ? callWasi(imported.name, args, this.wasiHost())
      : undefined

    if (result === undefined) {
      throw new UnimplementedInstruction(
        ISA_NAME, si.addr, Uint8Array.from([0x10]),
        `import ${imported.module}.${imported.name} has no host implementation`,
      )
    }
    if (type.results.length > 0) this.pushI32(result ?? 0)
  }

  /** The machine, as the host-call layer needs to see it. */
  private wasiHost(): WasiHost {
    return {
      read: (pointer, length) =>
        pointer < 0 || pointer + length > this.memory.length
          ? null
          : this.memory.subarray(pointer, pointer + length),
      readU32: (pointer) => this.view.getUint32(pointer, true),
      writeU8: (pointer, value) => { this.view.setUint8(pointer, value) },
      writeU16: (pointer, value) => { this.view.setUint16(pointer, value, true) },
      writeU32: (pointer, value) => { this.view.setUint32(pointer, value, true) },
      writeU64: (pointer, value) => { this.view.setBigUint64(pointer, value, true) },
      emit: (fd, bytes) => {
        const sink = fd === 2 ? this.errBytes : this.outBytes
        for (const byte of bytes) sink.push(byte)
      },
      exit: (code) => {
        this.exitCode = code
        this.exited = true
      },
    }
  }

  // ---- Memory --------------------------------------------------------

  private checkBounds(address: number, width: number, si: WasmStaticInst): void {
    if (address + width > this.memory.length || address < 0) {
      throw new WasmTrap(
        `out of bounds memory access: ${width} byte(s) at 0x${address.toString(16)} ` +
        `with ${this.memory.length} mapped`,
        Number(si.addr),
      )
    }
  }

  private effectiveAddress(si: WasmStaticInst): number {
    const base = this.popU32()
    // The offset is added as a 33-bit quantity and the result is bounds
    // checked, so a base near 2^32 with a large offset traps rather than
    // wrapping to a valid address.
    return base + Number(si.inst.imm)
  }

  private growMemory(delta: number): number {
    const before = this.pages
    if (delta === 0) return before
    const after = before + delta
    if (after > this.maxPages || after > 65536) return -1
    const grown = new Uint8Array(after * PAGE_BYTES)
    grown.set(this.memory)
    this.memory = grown
    this.view = new DataView(grown.buffer)
    this.pages = after
    return before
  }

  // ---- Execution -----------------------------------------------------

  private execute(si: WasmStaticInst): void {
    const inst = si.inst

    switch (inst.flow) {
      case Flow.OPEN:
        // `block` and `loop` are nothing at run time; the image already
        // turned every branch that names them into an offset.
        if (inst.op === 0x04) { // if
          const condition = this.popI32()
          if (condition === 0) {
            this.taken = 1
            this.branchTo(si.branch!)
          }
        }
        return
      case Flow.CLOSE:
        if (si.branch) {
          // Either the body's last `end`, which returns, or an `else`
          // reached by falling out of the then-arm.
          if (si.branch.isReturn) this.returnFromFrame(si.branch.keep)
          else this.branchTo(si.branch)
        }
        return
      case Flow.JUMP:
        this.taken = 1
        if (si.branch!.isReturn) this.returnFromFrame(si.branch!.keep)
        else this.branchTo(si.branch!)
        return
      case Flow.BRANCH: {
        const condition = this.popI32()
        if (condition !== 0) {
          this.taken = 1
          if (si.branch!.isReturn) this.returnFromFrame(si.branch!.keep)
          else this.branchTo(si.branch!)
        }
        return
      }
      case Flow.RET:
        this.taken = 1
        this.returnFromFrame(si.branch!.keep)
        return
      case Flow.CALL:
        this.callFunction(si, si.callee)
        return
      case Flow.TRAP:
        throw new WasmTrap('unreachable executed', Number(si.addr))
      case Flow.INDIRECT: {
        if (inst.op === 0x0e) { // br_table
          const index = this.popU32()
          const cases = si.table
          const chosen = cases[Math.min(index, cases.length - 1)]!
          this.taken = 1
          if (chosen.isReturn) this.returnFromFrame(chosen.keep)
          else this.branchTo(chosen)
          return
        }
        // call_indirect: the type is checked against the table entry,
        // and a mismatch traps. This is the check that makes an indirect
        // call safe, so skipping it would not be an optimisation.
        const slot = this.popU32()
        if (slot >= this.table.length) {
          throw new WasmTrap(`undefined element ${slot}`, Number(si.addr))
        }
        const target = this.table[slot]!
        if (target < 0) {
          throw new WasmTrap(`uninitialized element ${slot}`, Number(si.addr))
        }
        const wanted = this.module.types[si.callee]
        const actual = typeOf(this.module, target)
        if (!wanted || !sameType(wanted, actual)) {
          throw new WasmTrap('indirect call type mismatch', Number(si.addr))
        }
        this.callFunction(si, target)
        return
      }
      default:
        break
    }

    this.executeSequential(si)
  }

  private executeSequential(si: WasmStaticInst): void {
    const inst = si.inst
    const op = inst.op

    // Loads and stores first: they are the only instructions with an
    // effective address, and the trace needs it.
    if (inst.width > 0 && op < 0x100) {
      if (inst.store) { this.executeStore(si); return }
      this.executeLoad(si)
      return
    }

    switch (op) {
      case 0x01: return // nop
      case 0x1a: this.pop(); return // drop
      case 0x1b: case 0x1c: { // select
        const condition = this.popI32()
        const second = this.pop()
        const first = this.pop()
        this.push(condition !== 0 ? first : second)
        return
      }
      case 0x20: this.push(this.localStore[this.frame.localBase + Number(inst.imm)]!); return
      case 0x21: this.localStore[this.frame.localBase + Number(inst.imm)] = this.pop(); return
      case 0x22: {
        const value = this.pop()
        this.localStore[this.frame.localBase + Number(inst.imm)] = value
        this.push(value)
        return
      }
      case 0x23: this.push(this.globals[Number(inst.imm)]!); return
      case 0x24: this.globals[Number(inst.imm)] = this.pop(); return
      case 0x3f: this.pushI32(this.pages); return
      case 0x40: this.pushI32(this.growMemory(this.popI32())); return
      case 0x41: this.push(BigInt.asUintN(64, inst.imm)); return
      case 0x42: this.push(BigInt.asUintN(64, inst.imm)); return
      case 0x43: this.push(inst.imm); return
      case 0x44: this.push(inst.imm); return
      default: break
    }

    // The opcode ranges, which interleave: the two integer families
    // have their comparisons in one run and their arithmetic in another,
    // with the float comparisons in between. Dispatching on a single
    // span per family sends `i64.eq` to the i32 code, which is the kind
    // of mistake that produces a plausible number.
    if (op >= 0x45 && op <= 0x4f) { this.executeI32(si); return }
    if (op >= 0x50 && op <= 0x5a) { this.executeI64(si); return }
    if (op >= 0x5b && op <= 0x66) { this.executeFloatCompare(si); return }
    if (op >= 0x67 && op <= 0x78) { this.executeI32(si); return }
    if (op >= 0x79 && op <= 0x8a) { this.executeI64(si); return }
    if (op >= 0x8b && op <= 0xa6) { this.executeFloat(si); return }
    if (op >= 0xa7 && op <= 0xc4) { this.executeConversion(si); return }
    if (op >= 0x100) { this.executePrefixed(si); return }

    throw new UnimplementedInstruction(
      ISA_NAME, si.addr, Uint8Array.from([op & 0xff]),
      `${nameOf(op)} has no semantics in this backend`,
    )
  }

  private executeLoad(si: WasmStaticInst): void {
    const inst = si.inst
    const address = this.effectiveAddress(si)
    this.checkBounds(address, inst.width, si)
    this.access = BigInt(address)
    this.accessWidth = inst.width
    // A full-width load moves the pattern and nothing else, so `i32` and
    // `f32` are the same act here, as are `i64` and `f64`.
    if (inst.op === 0x28 || inst.op === 0x2a) {
      this.pushI32(this.view.getUint32(address, true))
      return
    }
    if (inst.op === 0x29 || inst.op === 0x2b) {
      this.push(this.view.getBigUint64(address, true))
      return
    }
    // The narrow loads: 0x2c..0x2f widen to i32, 0x30..0x35 to i64.
    const wide = inst.op >= 0x30
    let value: bigint
    switch (inst.width) {
      case 1:
        value = BigInt(inst.signed ? this.view.getInt8(address) : this.view.getUint8(address))
        break
      case 2:
        value = BigInt(inst.signed
          ? this.view.getInt16(address, true)
          : this.view.getUint16(address, true))
        break
      default:
        value = BigInt(inst.signed
          ? this.view.getInt32(address, true)
          : this.view.getUint32(address, true))
        break
    }
    this.push(wide ? BigInt.asUintN(64, value) : BigInt.asUintN(32, value))
  }

  private executeStore(si: WasmStaticInst): void {
    const inst = si.inst
    const value = this.pop()
    const address = this.effectiveAddress(si)
    this.checkBounds(address, inst.width, si)
    this.access = BigInt(address)
    this.accessWidth = inst.width
    switch (inst.width) {
      case 1: this.view.setUint8(address, Number(value & 0xffn)); return
      case 2: this.view.setUint16(address, Number(value & 0xffffn), true); return
      case 4: this.view.setUint32(address, Number(value & 0xffff_ffffn), true); return
      default: this.view.setBigUint64(address, value, true); return
    }
  }

  private executeI32(si: WasmStaticInst): void {
    const op = si.inst.op
    if (op === 0x45) { this.pushBool(this.popI32() === 0); return }
    if (op >= 0x46 && op <= 0x4f) {
      const b = this.popI32()
      const a = this.popI32()
      switch (op - 0x46) {
        case 0: this.pushBool(a === b); return
        case 1: this.pushBool(a !== b); return
        case 2: this.pushBool(a < b); return
        case 3: this.pushBool((a >>> 0) < (b >>> 0)); return
        case 4: this.pushBool(a > b); return
        case 5: this.pushBool((a >>> 0) > (b >>> 0)); return
        case 6: this.pushBool(a <= b); return
        case 7: this.pushBool((a >>> 0) <= (b >>> 0)); return
        case 8: this.pushBool(a >= b); return
        default: this.pushBool((a >>> 0) >= (b >>> 0)); return
      }
    }
    if (op >= 0x67 && op <= 0x69) {
      const a = this.popI32()
      this.pushI32(op === 0x67 ? clz32(a) : op === 0x68 ? ctz32(a) : popcnt32(a))
      return
    }
    const b = this.popI32()
    const a = this.popI32()
    switch (op) {
      case 0x6a: this.pushI32(a + b); return
      case 0x6b: this.pushI32(a - b); return
      case 0x6c: this.pushI32(Math.imul(a, b)); return
      case 0x6d:
        if (b === 0) throw new WasmTrap('integer divide by zero', Number(si.addr))
        // The one quotient that does not fit, which the standard names
        // as a trap rather than letting it wrap to itself.
        if (a === -2147483648 && b === -1) {
          throw new WasmTrap('integer overflow', Number(si.addr))
        }
        this.pushI32((a / b) | 0)
        return
      case 0x6e:
        if (b === 0) throw new WasmTrap('integer divide by zero', Number(si.addr))
        this.pushI32(((a >>> 0) / (b >>> 0)) >>> 0)
        return
      case 0x6f:
        if (b === 0) throw new WasmTrap('integer divide by zero', Number(si.addr))
        // Unlike the divide, this one is defined: the remainder is zero.
        this.pushI32(a === -2147483648 && b === -1 ? 0 : (a % b) | 0)
        return
      case 0x70:
        if (b === 0) throw new WasmTrap('integer divide by zero', Number(si.addr))
        this.pushI32(((a >>> 0) % (b >>> 0)) >>> 0)
        return
      case 0x71: this.pushI32(a & b); return
      case 0x72: this.pushI32(a | b); return
      case 0x73: this.pushI32(a ^ b); return
      case 0x74: this.pushI32(a << (b & 31)); return
      case 0x75: this.pushI32(a >> (b & 31)); return
      case 0x76: this.pushI32(a >>> (b & 31)); return
      case 0x77: {
        const shift = b & 31
        this.pushI32(shift === 0 ? a : (a << shift) | (a >>> (32 - shift)))
        return
      }
      case 0x78: {
        const shift = b & 31
        this.pushI32(shift === 0 ? a : (a >>> shift) | (a << (32 - shift)))
        return
      }
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, Uint8Array.from([op]), `${nameOf(op)} is not implemented`,
        )
    }
  }

  private executeI64(si: WasmStaticInst): void {
    const op = si.inst.op
    if (op === 0x50) { this.pushBool(this.pop() === 0n); return }
    if (op >= 0x51 && op <= 0x5a) {
      const ub = this.pop()
      const ua = this.pop()
      const a = BigInt.asIntN(64, ua)
      const b = BigInt.asIntN(64, ub)
      switch (op - 0x51) {
        case 0: this.pushBool(a === b); return
        case 1: this.pushBool(a !== b); return
        case 2: this.pushBool(a < b); return
        case 3: this.pushBool(ua < ub); return
        case 4: this.pushBool(a > b); return
        case 5: this.pushBool(ua > ub); return
        case 6: this.pushBool(a <= b); return
        case 7: this.pushBool(ua <= ub); return
        case 8: this.pushBool(a >= b); return
        default: this.pushBool(ua >= ub); return
      }
    }
    if (op >= 0x79 && op <= 0x7b) {
      const a = this.pop()
      this.push(op === 0x79 ? clz64(a) : op === 0x7a ? ctz64(a) : popcnt64(a))
      return
    }
    const bRaw = this.pop()
    const aRaw = this.pop()
    const a = BigInt.asIntN(64, aRaw)
    const b = BigInt.asIntN(64, bRaw)
    const wrap = (value: bigint): void => { this.push(BigInt.asUintN(64, value)) }
    switch (op) {
      case 0x7c: wrap(a + b); return
      case 0x7d: wrap(a - b); return
      case 0x7e: wrap(a * b); return
      case 0x7f:
        if (b === 0n) throw new WasmTrap('integer divide by zero', Number(si.addr))
        if (a === -(2n ** 63n) && b === -1n) {
          throw new WasmTrap('integer overflow', Number(si.addr))
        }
        wrap(a / b)
        return
      case 0x80:
        if (bRaw === 0n) throw new WasmTrap('integer divide by zero', Number(si.addr))
        wrap(aRaw / bRaw)
        return
      case 0x81:
        if (b === 0n) throw new WasmTrap('integer divide by zero', Number(si.addr))
        wrap(a === -(2n ** 63n) && b === -1n ? 0n : a % b)
        return
      case 0x82:
        if (bRaw === 0n) throw new WasmTrap('integer divide by zero', Number(si.addr))
        wrap(aRaw % bRaw)
        return
      case 0x83: wrap(aRaw & bRaw); return
      case 0x84: wrap(aRaw | bRaw); return
      case 0x85: wrap(aRaw ^ bRaw); return
      case 0x86: wrap(aRaw << (bRaw & 63n)); return
      case 0x87: wrap(a >> (bRaw & 63n)); return
      case 0x88: wrap(aRaw >> (bRaw & 63n)); return
      case 0x89: {
        const shift = bRaw & 63n
        wrap(shift === 0n ? aRaw : (aRaw << shift) | (aRaw >> (64n - shift)))
        return
      }
      case 0x8a: {
        const shift = bRaw & 63n
        wrap(shift === 0n ? aRaw : (aRaw >> shift) | (aRaw << (64n - shift)))
        return
      }
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, Uint8Array.from([op]), `${nameOf(op)} is not implemented`,
        )
    }
  }

  /** The twelve comparisons: f32 at 0x5b, f64 at 0x61, six each. */
  private executeFloatCompare(si: WasmStaticInst): void {
    const op = si.inst.op
    const isF32 = op < 0x61
    const b = isF32 ? this.popF32() : this.popF64()
    const a = isF32 ? this.popF32() : this.popF64()
    switch (op - (isF32 ? 0x5b : 0x61)) {
      case 0: this.pushBool(a === b); return
      case 1: this.pushBool(a !== b); return
      case 2: this.pushBool(a < b); return
      case 3: this.pushBool(a > b); return
      case 4: this.pushBool(a <= b); return
      default: this.pushBool(a >= b); return
    }
  }

  private executeFloat(si: WasmStaticInst): void {
    const op = si.inst.op
    // 0x8b..0x91 are f32 unary, 0x92..0x98 f32 binary,
    // 0x99..0x9f f64 unary, 0xa0..0xa6 f64 binary.
    const isF32 = op <= 0x98
    const unary = (op >= 0x8b && op <= 0x91) || (op >= 0x99 && op <= 0x9f)

    if (unary) {
      const a = isF32 ? this.popF32() : this.popF64()
      const base = isF32 ? 0x8b : 0x99
      const value = applyUnary(op - base, a)
      if (isF32) this.pushF32(Math.fround(value))
      else this.pushF64(value)
      return
    }

    const b = isF32 ? this.popF32() : this.popF64()
    const a = isF32 ? this.popF32() : this.popF64()
    const base = isF32 ? 0x92 : 0xa0
    const value = applyBinary(op - base, a, b)
    if (isF32) this.pushF32(Math.fround(value))
    else this.pushF64(value)
  }

  private executeConversion(si: WasmStaticInst): void {
    const op = si.inst.op
    const at = Number(si.addr)
    switch (op) {
      case 0xa7: this.pushI32(Number(this.pop() & 0xffff_ffffn) | 0); return
      case 0xa8: this.pushI32(truncF(this.popF32(), at, true)); return
      case 0xa9: this.pushI32(truncF(this.popF32(), at, false)); return
      case 0xaa: this.pushI32(truncF(this.popF64(), at, true)); return
      case 0xab: this.pushI32(truncF(this.popF64(), at, false)); return
      case 0xac: this.push(BigInt.asUintN(64, BigInt(this.popI32()))); return
      case 0xad: this.push(BigInt(this.popU32())); return
      case 0xae: this.push(BigInt.asUintN(64, truncF64ToI64(this.popF32(), at, true))); return
      case 0xaf: this.push(truncF64ToI64(this.popF32(), at, false)); return
      case 0xb0: this.push(BigInt.asUintN(64, truncF64ToI64(this.popF64(), at, true))); return
      case 0xb1: this.push(truncF64ToI64(this.popF64(), at, false)); return
      case 0xb2: this.pushF32(Math.fround(this.popI32())); return
      case 0xb3: this.pushF32(Math.fround(this.popU32())); return
      case 0xb4: this.pushF32(Math.fround(Number(BigInt.asIntN(64, this.pop())))); return
      case 0xb5: this.pushF32(Math.fround(Number(this.pop()))); return
      case 0xb6: this.pushF32(Math.fround(this.popF64())); return
      case 0xb7: this.pushF64(this.popI32()); return
      case 0xb8: this.pushF64(this.popU32()); return
      case 0xb9: this.pushF64(Number(BigInt.asIntN(64, this.pop()))); return
      case 0xba: this.pushF64(Number(this.pop())); return
      case 0xbb: this.pushF64(this.popF32()); return
      // The reinterpretations move no bits at all, which is exactly what
      // the representation here makes them: the stack already holds the
      // pattern.
      case 0xbc: this.push(BigInt(this.popU32())); return
      case 0xbd: this.push(this.pop()); return
      case 0xbe: this.push(BigInt(this.popU32())); return
      case 0xbf: this.push(this.pop()); return
      case 0xc0: this.pushI32((this.popI32() << 24) >> 24); return
      case 0xc1: this.pushI32((this.popI32() << 16) >> 16); return
      case 0xc2: this.push(BigInt.asUintN(64, BigInt.asIntN(8, this.pop()))); return
      case 0xc3: this.push(BigInt.asUintN(64, BigInt.asIntN(16, this.pop()))); return
      case 0xc4: this.push(BigInt.asUintN(64, BigInt.asIntN(32, this.pop()))); return
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, Uint8Array.from([op]), `${nameOf(op)} is not implemented`,
        )
    }
  }

  private executePrefixed(si: WasmStaticInst): void {
    const sub = si.inst.op - 0x100
    if (sub < 8) {
      // The saturating conversions, in the order the sub-opcode numbers
      // them: the destination width is the high bit, the source width
      // the middle one, and signedness the low one.
      const value = (sub & 2) === 0 ? this.popF32() : this.popF64()
      const wide = sub >= 4
      const signed = (sub & 1) === 0
      if (wide) this.push(BigInt.asUintN(64, saturate64(value, signed)))
      else this.pushI32(saturate32(value, signed))
      return
    }
    switch (sub) {
      case 10: { // memory.copy
        const length = this.popU32()
        const source = this.popU32()
        const dest = this.popU32()
        this.checkBounds(source, length, si)
        this.checkBounds(dest, length, si)
        this.memory.copyWithin(dest, source, source + length)
        this.access = BigInt(dest)
        this.accessWidth = 1
        return
      }
      case 11: { // memory.fill
        const length = this.popU32()
        const value = this.popU32() & 0xff
        const dest = this.popU32()
        this.checkBounds(dest, length, si)
        this.memory.fill(value, dest, dest + length)
        this.access = BigInt(dest)
        this.accessWidth = 1
        return
      }
      default:
        throw new UnimplementedInstruction(
          ISA_NAME, si.addr, Uint8Array.from([0xfc]),
          `${nameOf(si.inst.op)} is not implemented`,
        )
    }
  }
}

function sameType(
  a: { params: number[]; results: number[] },
  b: { params: number[]; results: number[] },
): boolean {
  return a.params.length === b.params.length &&
    a.results.length === b.results.length &&
    a.params.every((type, i) => type === b.params[i]) &&
    a.results.every((type, i) => type === b.results[i])
}

function applyUnary(which: number, a: number): number {
  switch (which) {
    case 0: return Math.abs(a)
    case 1: return -a
    case 2: return Math.ceil(a)
    case 3: return Math.floor(a)
    case 4: return Math.trunc(a)
    case 5: return nearest(a)
    default: return Math.sqrt(a)
  }
}

/** A NaN made quiet, which is what every propagation rule delivers. */
function quiet(value: number): number {
  scratch.setFloat64(0, value, true)
  scratch.setUint8(6, scratch.getUint8(6) | 0x08)
  return scratch.getFloat64(0, true)
}

function applyBinary(which: number, a: number, b: number): number {
  switch (which) {
    case 4: return wasmMin(a, b)
    case 5: return wasmMax(a, b)
    // Not arithmetic: it moves a sign bit and never invents a NaN, so
    // it must not go through the propagation below, which would drop
    // the sign it exists to copy.
    case 6: return copysign(a, b)
    default: break
  }

  // Which NaN comes out of an operation that has one going in is left
  // open by the standard, and leaving it to the host is not good enough:
  // `a + b` and `a * b` commute, so the engine running *this* code is
  // free to reorder them, and with two NaN operands of different signs
  // that changes the answer. A simulator whose output depends on its
  // host's instruction scheduling is not a simulator.
  //
  // So the rule is stated: the first NaN operand, made quiet. That is
  // what the hardware does and what the reference engine reports.
  if (Number.isNaN(a)) return quiet(a)
  if (Number.isNaN(b)) return quiet(b)

  switch (which) {
    case 0: return a + b
    case 1: return a - b
    case 2: return a * b
    default: return a / b
  }
}

/**
 * `copysign`, which copies a *bit* and not an ordering.
 *
 * Writing this as `b < 0 ? -abs(a) : abs(a)` is right for every value
 * except the ones where it matters: a NaN compares false against zero
 * whichever way its sign bit is set, so a negative NaN would silently
 * produce a positive result. The bit has to be read as a bit.
 */
function copysign(a: number, b: number): number {
  scratch.setFloat64(0, b, true)
  const negative = (scratch.getUint8(7) & 0x80) !== 0
  scratch.setFloat64(0, a, true)
  scratch.setUint8(7, (scratch.getUint8(7) & 0x7f) | (negative ? 0x80 : 0))
  return scratch.getFloat64(0, true)
}

/**
 * A trapping truncation to 32 bits.
 *
 * Two ways to fail -- a NaN has no integer value at all, and a finite
 * value out of range has one that does not fit -- and they are the *same
 * trap*, because the standard makes no distinction: `trunc` traps when
 * its operand is not representable, however it got that way. Reporting
 * the second as an overflow reads better and puts it in a different
 * category from the reference's, which is the sort of difference that
 * turns a passing comparison into an argument about wording.
 *
 * The saturating forms in the 0xFC space answer both questions with a
 * value instead: zero for a NaN, and the nearer bound for the rest.
 */
const NOT_AN_INTEGER = 'invalid conversion to integer'

function truncF(value: number, at: number, signed: boolean): number {
  if (Number.isNaN(value)) throw new WasmTrap(NOT_AN_INTEGER, at)
  const truncated = Math.trunc(value)
  if (signed) {
    if (truncated < -2147483648 || truncated > 2147483647) {
      throw new WasmTrap(NOT_AN_INTEGER, at)
    }
    return truncated | 0
  }
  if (truncated < 0 || truncated > 4294967295) throw new WasmTrap(NOT_AN_INTEGER, at)
  return truncated >>> 0
}

function truncF64ToI64(value: number, at: number, signed: boolean): bigint {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    throw new WasmTrap(NOT_AN_INTEGER, at)
  }
  const truncated = Math.trunc(value)
  if (signed) {
    if (truncated < -(2 ** 63) || truncated >= 2 ** 63) {
      throw new WasmTrap(NOT_AN_INTEGER, at)
    }
    return BigInt(truncated)
  }
  if (truncated < 0 || truncated >= 2 ** 64) throw new WasmTrap(NOT_AN_INTEGER, at)
  return BigInt(truncated)
}

function saturate32(value: number, signed: boolean): number {
  if (Number.isNaN(value)) return 0
  const truncated = Math.trunc(value)
  if (signed) {
    if (truncated < -2147483648) return -2147483648
    if (truncated > 2147483647) return 2147483647
    return truncated | 0
  }
  if (truncated < 0) return 0
  if (truncated > 4294967295) return -1
  return truncated >>> 0
}

function saturate64(value: number, signed: boolean): bigint {
  if (Number.isNaN(value)) return 0n
  const truncated = Math.trunc(value)
  if (signed) {
    if (truncated < -(2 ** 63)) return -(2n ** 63n)
    if (truncated >= 2 ** 63) return 2n ** 63n - 1n
    return BigInt(truncated)
  }
  if (truncated < 0) return 0n
  if (truncated >= 2 ** 64) return 2n ** 64n - 1n
  return BigInt(truncated)
}
