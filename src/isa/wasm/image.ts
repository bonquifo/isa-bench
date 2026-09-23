/**
 * WebAssembly program image: the static half the timing model consumes.
 *
 * ## What plays the part of a register
 *
 * Nothing, directly. Every operand comes off an operand stack, so
 * `i32.add` reads "the top two" and writes "the top one" and the
 * instruction alone does not say which storage that is.
 *
 * What rescues this is that a valid module's **stack depth at every
 * instruction is statically determined**. It is a property of the code,
 * not of the run: the same instruction is reached at the same depth on
 * every path, because the validation rules that make a module valid are
 * exactly the rules that force this. So the analysis here is not an
 * approximation of a dynamic quantity -- it is the quantity, computed
 * once per function and cached with the decoded instructions.
 *
 * That gives a flat resource space: a stack slot is named by its depth,
 * a local by its index, a global by its index. `i32.add` at depth 5
 * reads slots 4 and 3 and writes slot 3, and two `i32.add`s at
 * different depths are genuinely independent, which is what a timing
 * model needs to know.
 *
 * ## The frame, and the approximation this does make
 *
 * Slots and locals are frame-relative, and the id space is not. A
 * callee's slot 0 and its caller's slot 0 are the same id when they are
 * different storage, and the same is true of `local 0`.
 *
 * This is the same shape of approximation as SPARC's register windows,
 * and it is handled the same way: **every instruction that names a slot
 * or a local reads `Res.FRAME`, and `call` and `return` write it.** The
 * dependence on the call is then real rather than missing, and the
 * aliasing error is confined to a call boundary that both sides carry.
 * For an in-order model whose output is model cycles -- a number this
 * project already declares is not measured -- that is a bounded
 * inaccuracy, and it is preferable to inventing a dynamic frame number
 * that the image, which is addressed by program counter, has nowhere to
 * put.
 *
 * ## Branch targets
 *
 * `br 2` means "leave two enclosing blocks", so where it lands is a fact
 * about the nesting rather than about the instruction. The analysis
 * walks each function once, maintaining the label stack the validator
 * would, and resolves every branch to a byte offset, the number of
 * values it carries, and the depth it carries them to. After that a
 * branch is three numbers and the interpreter needs no label stack at
 * all -- which is why `end` costs nothing here, and why an `end` that is
 * merely closing a block is a genuine no-op rather than bookkeeping.
 *
 * A branch out of the outermost label is a return. So is falling off the
 * end of the body. Both are marked as such during the walk, which is why
 * the interpreter never has to ask whether an `end` is the last one.
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
import { Flow, ISA_NAME, decode, nameOf, type WasmInst } from './decode.ts'
import { bodyAt, bodyOf, typeOf, type FuncBody, type WasmModule } from './module.ts'

/**
 * How many of each resource the id space has room for.
 *
 * A module that needs more is refused rather than wrapped around. The
 * alternative -- aliasing slot 64 onto slot 0 -- would make two
 * independent values look like a dependence, which is a wrong answer
 * that nothing would report.
 */
export const GLOBAL_SLOTS = 32
export const STACK_SLOTS = 64
export const LOCAL_SLOTS = 256

/**
 * Architectural resource ids.
 *
 * Globals come first, and deliberately. They are the only state here
 * that outlives a function call -- clang puts the shadow stack pointer
 * in one -- so they are the closest thing this architecture has to
 * registers, and putting them at the bottom of the space is what lets
 * `gpr(n)` and the final-state comparison agree on what a register is.
 */
export const Res = {
  GLOBAL: 0,
  STACK: GLOBAL_SLOTS,
  LOCAL: GLOBAL_SLOTS + STACK_SLOTS,
  /** The current activation. See the note at the top. */
  FRAME: GLOBAL_SLOTS + STACK_SLOTS + LOCAL_SLOTS,
  /** The size of linear memory, which `memory.grow` changes. */
  MEMORY: GLOBAL_SLOTS + STACK_SLOTS + LOCAL_SLOTS + 1,
} as const

export const REG_COUNT = Res.MEMORY + 1

const NAMES: readonly string[] = (() => {
  const names: string[] = []
  for (let i = 0; i < GLOBAL_SLOTS; i++) names[Res.GLOBAL + i] = `g${i}`
  for (let i = 0; i < STACK_SLOTS; i++) names[Res.STACK + i] = `s${i}`
  for (let i = 0; i < LOCAL_SLOTS; i++) names[Res.LOCAL + i] = `l${i}`
  names[Res.FRAME] = 'frame'
  names[Res.MEMORY] = 'mem'
  return names
})()

export const WASM_NAMING: RegisterNaming = {
  count: REG_COUNT,
  name(id: number): string {
    return NAMES[id] ?? `?${id}`
  },
}

/** Where a branch goes, resolved. */
export interface Branch {
  /** Byte offset of the target instruction; meaningless for a return. */
  target: number
  /** Values carried from the top of the stack to the target. */
  keep: number
  /** Stack depth at the target, below the carried values. */
  targetDepth: number
  /** Leaving the outermost label, which is a return rather than a jump. */
  isReturn: boolean
}

export interface WasmStaticInst extends StaticInst {
  readonly inst: WasmInst
  /** Operand-stack depth before this instruction executes. */
  readonly depth: number
  /** Values taken, after the function types of calls are accounted for. */
  readonly effPop: number
  readonly effPush: number
  /** Where control goes when this instruction redirects it. */
  readonly branch: Branch | null
  /** `br_table`'s cases, the default last. */
  readonly table: readonly Branch[]
  /** Function index for `call`; type index for `call_indirect`. */
  readonly callee: number
}

// ---- The per-function walk -------------------------------------------

interface Label {
  blockType: number
  /** Stack depth outside the block. */
  entryDepth: number
  /** Where a branch to this label lands; -1 until the `end` is seen. */
  target: number
  /** Values a branch to this label carries. */
  arity: number
  isReturn: boolean
  /** Branches waiting for the `end` that resolves them. */
  pending: Branch[]
  /** The `if`'s own false-path branch, which `else` re-targets. */
  ifBranch: Branch | null
}

/** Values a block takes from the stack, which only a type index can name. */
function blockParams(module: WasmModule, blockType: number): number {
  return blockType >= 0 ? (module.types[blockType]?.params.length ?? 0) : 0
}

/**
 * Values a block leaves on it.
 *
 * The encoding is three cases in one signed number: -64 is "no result",
 * any other negative is a single value type, and non-negative is an
 * index into the type section. Reading it as a byte gets the first two
 * right and the third wrong.
 */
function blockResults(module: WasmModule, blockType: number): number {
  if (blockType >= 0) return module.types[blockType]?.results.length ?? 0
  return blockType === -64 ? 0 : 1
}

export interface FuncAnalysis {
  body: FuncBody
  sites: Map<number, WasmStaticInst>
}

function refuseRange(what: string, index: number, limit: number, at: number): never {
  throw new IsaError(
    `${ISA_NAME}: ${what} ${index} at offset ${at} is outside the ${limit} ` +
    'this backend has resource ids for; aliasing it would invent a dependence',
  )
}

interface Site {
  inst: WasmInst
  at: number
  depth: number
  effPop: number
  effPush: number
  branch: Branch | null
  table: Branch[]
  callee: number
}

/**
 * Decodes and analyses one function body in a single forward pass.
 *
 * Forward, rather than to a fixed point, because the structure makes it
 * possible: a branch can only go to a label that is already open, so the
 * only unknown is where a not-yet-seen `end` will be, and that is
 * patched when it arrives.
 *
 * The static instructions are built *after* the walk rather than during
 * it, and that is not tidiness. A forward branch's target is not known
 * when the branch is decoded -- the `end` that resolves it has not been
 * reached -- so building the instruction there would record `no address`
 * for every branch that goes forwards, which is most of them, and a
 * timing model would see a jump it could not predict where the answer
 * was sitting in the same function.
 */
function analyse(module: WasmModule, body: FuncBody): FuncAnalysis {
  const bytes = module.bytes
  const read = (base: number) => (offset: number): number => bytes[base + offset] ?? 0

  const sites = new Map<number, WasmStaticInst>()
  const walked: Site[] = []
  const results = module.types[body.typeIndex]?.results.length ?? 0

  const labels: Label[] = [{
    blockType: -64,
    entryDepth: 0,
    target: -1,
    arity: results,
    isReturn: true,
    pending: [],
    ifBranch: null,
  }]

  let depth = 0
  let unreachable = false
  let at = body.start

  /** A branch to the label `relative` levels out. */
  const branchTo = (relative: number, offset: number): Branch => {
    const label = labels[labels.length - 1 - relative]
    if (!label) {
      throw new IsaError(
        `${ISA_NAME}: br ${relative} at offset ${offset} leaves more blocks ` +
        'than are open',
      )
    }
    const branch: Branch = {
      target: label.target,
      keep: label.arity,
      targetDepth: label.entryDepth,
      isReturn: label.isReturn,
    }
    if (label.target < 0 && !label.isReturn) label.pending.push(branch)
    return branch
  }

  while (at < body.end) {
    const inst = decode(read(at), BigInt(at))
    const depthBefore = depth

    let effPop = inst.pop
    let effPush = inst.push
    let branch: Branch | null = null
    let table: Branch[] = []
    let callee = -1

    switch (inst.flow) {
      case Flow.OPEN: {
        const params = blockParams(module, inst.blockType)
        const isLoop = inst.op === 0x03
        const isIf = inst.op === 0x04
        if (isIf) depth -= 1
        const entryDepth = depth - params
        const label: Label = {
          blockType: inst.blockType,
          entryDepth,
          // A loop's target is its own body, which is known immediately;
          // this is the only backward branch the format has.
          target: isLoop ? at + inst.length : -1,
          arity: isLoop ? params : blockResults(module, inst.blockType),
          isReturn: false,
          pending: [],
          ifBranch: null,
        }
        if (isIf) {
          // The false path. Where it lands is not known yet: an `else`
          // will claim it, and without one it falls to the `end`.
          const falsePath: Branch = {
            target: -1, keep: params, targetDepth: entryDepth, isReturn: false,
          }
          label.ifBranch = falsePath
          label.pending.push(falsePath)
          branch = falsePath
        }
        labels.push(label)
        effPop = isIf ? 1 : 0
        effPush = 0
        break
      }
      case Flow.CLOSE: {
        const label = labels[labels.length - 1]!
        if (inst.op === 0x05) { // else
          const params = blockParams(module, label.blockType)
          const blockRes = blockResults(module, label.blockType)
          // Falling into `else` from the then-arm jumps past the `end`.
          const over: Branch = {
            target: -1, keep: blockRes, targetDepth: label.entryDepth, isReturn: false,
          }
          label.pending.push(over)
          branch = over
          // And the `if` that opened this now knows where its false path
          // goes: the first instruction of the else-arm.
          if (label.ifBranch) {
            label.ifBranch.target = at + inst.length
            const index = label.pending.indexOf(label.ifBranch)
            if (index >= 0) label.pending.splice(index, 1)
            label.ifBranch = null
          }
          depth = label.entryDepth + params
          unreachable = false
        } else { // end
          labels.pop()
          for (const waiting of label.pending) waiting.target = at + inst.length
          depth = label.entryDepth + blockResults(module, label.blockType)
          unreachable = false
          if (labels.length === 0) {
            // The body's last `end`. Falling off it returns.
            branch = { target: -1, keep: results, targetDepth: 0, isReturn: true }
            depth = results
          }
        }
        break
      }
      case Flow.JUMP:
        branch = branchTo(Number(inst.imm), at)
        unreachable = true
        break
      case Flow.BRANCH:
        depth -= 1
        effPop = 1
        branch = branchTo(Number(inst.imm), at)
        break
      case Flow.RET:
        branch = {
          target: -1, keep: results, targetDepth: 0, isReturn: true,
        }
        unreachable = true
        break
      case Flow.CALL: {
        callee = Number(inst.imm)
        const type = typeOf(module, callee)
        effPop = type.params.length
        effPush = type.results.length
        depth += effPush - effPop
        break
      }
      case Flow.INDIRECT: {
        if (inst.op === 0x0e) { // br_table
          depth -= 1
          effPop = 1
          table = inst.targets.map((relative) => branchTo(relative, at))
          unreachable = true
        } else { // call_indirect
          callee = Number(inst.imm)
          const type = module.types[callee] ?? { params: [], results: [] }
          // The table index is popped on top of the arguments.
          effPop = type.params.length + 1
          effPush = type.results.length
          depth += effPush - effPop
        }
        break
      }
      case Flow.TRAP:
        unreachable = true
        break
      default:
        depth += effPush - effPop
        break
    }

    if (depth < 0) {
      if (!unreachable) {
        throw new IsaError(
          `${ISA_NAME}: operand stack underflows at offset ${at} (${nameOf(inst.op)})`,
        )
      }
      depth = 0
    }

    walked.push({
      inst, at, depth: depthBefore, effPop, effPush, branch, table, callee,
    })
    at += inst.length
  }

  // Every pending branch now has its target, so the instructions can be
  // built with it.
  for (const site of walked) {
    sites.set(site.at, toStatic(
      module, site.inst, site.at, site.depth, site.effPop, site.effPush,
      site.branch, site.table, site.callee,
    ))
  }

  return { body, sites }
}

// ---- One instruction, as the timing model sees it --------------------

const CONTROL_OF: Readonly<Record<number, ControlKind>> = {
  [Flow.SEQ]: ControlKind.SEQ,
  [Flow.OPEN]: ControlKind.SEQ,
  [Flow.CLOSE]: ControlKind.SEQ,
  [Flow.BRANCH]: ControlKind.COND,
  [Flow.JUMP]: ControlKind.JUMP,
  [Flow.CALL]: ControlKind.CALL,
  [Flow.INDIRECT]: ControlKind.INDIRECT,
  [Flow.RET]: ControlKind.RET,
  [Flow.TRAP]: ControlKind.TRAP,
}

/** Opcodes whose class is not implied by what they do to the stack. */
const MUL_OPS = new Set([0x6c, 0x7e])
const DIV_OPS = new Set([0x6d, 0x6e, 0x6f, 0x70, 0x7f, 0x80, 0x81, 0x82])
const FP_DIV_OPS = new Set([0x95, 0x9f, 0xa3, 0xad])
const FP_MUL_OPS = new Set([0x94, 0xa2])

function isFloat(op: number): boolean {
  const name = nameOf(op)
  return name.startsWith('f32.') || name.startsWith('f64.') ||
    name.includes('_f32') || name.includes('_f64')
}

function classOf(inst: WasmInst): InstClass {
  if (inst.store) return InstClass.ST
  if (inst.width > 0) return InstClass.LD
  if (inst.flow !== Flow.SEQ) {
    // `block`, `loop` and `end` carry no work: they exist to delimit
    // regions the branches name, and once those are resolved there is
    // nothing left for them to do.
    return inst.flow === Flow.OPEN || inst.flow === Flow.CLOSE
      ? InstClass.NOP
      : InstClass.BR
  }
  if (MUL_OPS.has(inst.op)) return InstClass.MUL
  if (DIV_OPS.has(inst.op)) return InstClass.DIV
  if (isFloat(inst.op)) return InstClass.FP
  if (inst.op === 0x01) return InstClass.NOP
  // The moves: constants, and anything that shuffles a named location on
  // or off the stack without computing.
  if (inst.op === 0x41 || inst.op === 0x42 || inst.op === 0x43 || inst.op === 0x44 ||
    (inst.op >= 0x20 && inst.op <= 0x24) || inst.op === 0x1a) {
    return InstClass.MOV
  }
  return InstClass.ALU
}

function latencyOf(inst: WasmInst): LatencyClass {
  if (inst.width > 0 && !inst.store) return LatencyClass.LOAD
  if (DIV_OPS.has(inst.op)) return LatencyClass.DIV
  if (MUL_OPS.has(inst.op)) return LatencyClass.MUL
  if (FP_DIV_OPS.has(inst.op)) return LatencyClass.FP_DIV
  if (FP_MUL_OPS.has(inst.op)) return LatencyClass.FP_MUL
  if (isFloat(inst.op)) return LatencyClass.FP_ADD
  return LatencyClass.FIXED
}

export function render(inst: WasmInst): string {
  const name = nameOf(inst.op)
  switch (inst.op) {
    case 0x02: case 0x03: case 0x04:
      return inst.blockType === -64 ? name : `${name} ${inst.blockType}`
    case 0x0e:
      return `br_table ${inst.targets.join(' ')}`
    case 0x11:
      return `call_indirect ${inst.imm}`
    case 0x43: case 0x44:
      return `${name} 0x${inst.imm.toString(16)}`
    default:
      break
  }
  if (inst.width > 0 && inst.op < 0x100) return `${name} ${inst.imm}`
  if (inst.pop === 0 && inst.push === 0 && inst.flow === Flow.SEQ) return name
  switch (name) {
    case 'local.get': case 'local.set': case 'local.tee':
    case 'global.get': case 'global.set':
    case 'call': case 'br': case 'br_if':
    case 'i32.const': case 'i64.const':
      return `${name} ${inst.imm}`
    default:
      return name
  }
}

function toStatic(
  module: WasmModule, inst: WasmInst, at: number, depth: number,
  effPop: number, effPush: number,
  branch: Branch | null, table: readonly Branch[], callee: number,
): WasmStaticInst {
  const reads: number[] = []
  const writes: number[] = []
  const addRead = (id: number): void => { if (!reads.includes(id)) reads.push(id) }
  const addWrite = (id: number): void => { if (!writes.includes(id)) writes.push(id) }

  const slot = (index: number): number => {
    if (index >= STACK_SLOTS) refuseRange('operand stack slot', index, STACK_SLOTS, at)
    return Res.STACK + index
  }

  // The values this instruction takes, named by where they sit.
  for (let i = 1; i <= effPop; i++) {
    const index = depth - i
    if (index >= 0) addRead(slot(index))
  }
  // And the ones it leaves, which start where the taken ones did.
  const base = depth - effPop
  for (let i = 0; i < effPush; i++) {
    const index = base + i
    if (index >= 0) addWrite(slot(index))
  }
  // A branch carries values down the stack, so it writes where they land.
  if (branch && branch.keep > 0 && !branch.isReturn) {
    for (let i = 0; i < branch.keep; i++) {
      const index = branch.targetDepth + i
      if (index >= 0) addWrite(slot(index))
      const from = depth - effPop - branch.keep + i
      if (from >= 0) addRead(slot(from))
    }
  }

  const name = nameOf(inst.op)
  const index = Number(inst.imm)
  switch (name) {
    case 'local.get':
      if (index >= LOCAL_SLOTS) refuseRange('local', index, LOCAL_SLOTS, at)
      addRead(Res.LOCAL + index)
      break
    case 'local.set': case 'local.tee':
      if (index >= LOCAL_SLOTS) refuseRange('local', index, LOCAL_SLOTS, at)
      addWrite(Res.LOCAL + index)
      break
    case 'global.get':
      if (index >= GLOBAL_SLOTS) refuseRange('global', index, GLOBAL_SLOTS, at)
      addRead(Res.GLOBAL + index)
      break
    case 'global.set':
      if (index >= GLOBAL_SLOTS) refuseRange('global', index, GLOBAL_SLOTS, at)
      addWrite(Res.GLOBAL + index)
      break
    case 'memory.size':
      addRead(Res.MEMORY)
      break
    case 'memory.grow':
      addRead(Res.MEMORY); addWrite(Res.MEMORY)
      break
    default:
      break
  }

  // See the note at the top: slots and locals are frame-relative and the
  // id space is not, so the call that changes frames is a dependence
  // both sides carry.
  //
  // This catches a global too, which is module-wide and outlives every
  // call -- but only because an instruction that reads one also writes
  // the operand-stack slot it lands in, and that slot *is*
  // frame-relative. Every value on this machine passes through the
  // stack, so there is no instruction that touches a global and nothing
  // else, and a rule that excluded globals would be a distinction with
  // no case to apply to.
  if (reads.length > 0 || writes.length > 0) addRead(Res.FRAME)
  if (inst.flow === Flow.CALL || inst.flow === Flow.RET ||
    (branch?.isReturn ?? false) || inst.op === 0x11) {
    addRead(Res.FRAME); addWrite(Res.FRAME)
  }

  // A call to an imported function is a call into the host -- WASI is
  // this platform's system interface -- and the host runs it to
  // completion inside the one instruction. It is a system call, not a
  // call: nothing in the module ever returns from it, so pushing a return
  // address for it left the stack one deep for the rest of the run.
  const hostCall = inst.flow === Flow.CALL && callee >= 0 &&
    callee < module.importedFuncs.length
  // `call_indirect` shares its flow with `br_table` -- both go somewhere
  // only execution knows -- but it is a call, and whatever it calls
  // returns to it. As an indirect jump it pushed nothing, and every return
  // from a function reached through a table was a return-stack miss.
  const indirectCall = inst.op === 0x11
  const control = branch?.isReturn ?? false
    ? ControlKind.RET
    : hostCall ? ControlKind.TRAP
      : indirectCall ? ControlKind.CALL
        : CONTROL_OF[inst.flow] ?? ControlKind.SEQ
  const known = branch && !branch.isReturn && branch.target >= 0

  const readsMem = inst.width > 0 && !inst.store
  const writesMem = inst.store

  return {
    addr: BigInt(at),
    bytes: inst.length,
    mnemonic: render(inst),
    cls: classOf(inst),
    latencyClass: latencyOf(inst),
    uops: 1,
    reads,
    writes,
    control,
    staticTarget: known ? BigInt(branch.target) : hostCall ? NO_ADDRESS : callTarget(module, inst, callee),
    readsMem,
    writesMem,
    accessWidth: readsMem || writesMem ? inst.width : 0,
    // `memory.grow` moves the ground every other access stands on, and
    // `unreachable` ends the run.
    serializing: inst.op === 0x40 || inst.flow === Flow.TRAP || hostCall,
    origin: OperationOrigin.SEMANTIC,
    inst,
    depth,
    effPop,
    effPush,
    branch,
    table,
    callee,
  }
}

/** A direct call's target, which is a function's first instruction. */
function callTarget(module: WasmModule, inst: WasmInst, callee: number): bigint {
  if (inst.flow !== Flow.CALL || callee < 0) return NO_ADDRESS
  const body = bodyOf(module, callee)
  return body ? BigInt(body.start) : NO_ADDRESS
}

// ---- The image -------------------------------------------------------

export class WasmImage implements ProgramImage {
  readonly isa = ISA_NAME
  readonly entry: bigint
  readonly naming = WASM_NAMING
  readonly codeBytes: number
  readonly module: WasmModule
  private readonly analyses = new Map<number, FuncAnalysis>()
  private readonly failed = new Set<number>()

  constructor(module: WasmModule, entry: bigint) {
    this.module = module
    this.entry = entry
    this.codeBytes = module.bodies.reduce((total, body) => total + (body.end - body.start), 0)
  }

  /** The analysis for the function containing an offset, computed once. */
  analysisFor(body: FuncBody): FuncAnalysis {
    const hit = this.analyses.get(body.start)
    if (hit) return hit
    const made = analyse(this.module, body)
    this.analyses.set(body.start, made)
    return made
  }

  at(addr: bigint): WasmStaticInst {
    const offset = Number(addr)
    const body = bodyAt(this.module, offset)
    if (!body) {
      throw new IsaError(
        `${ISA_NAME}: offset 0x${offset.toString(16)} is not inside any function body`,
      )
    }
    const found = this.analysisFor(body).sites.get(offset)
    if (!found) {
      // Inside a body but not at an instruction boundary, which on a
      // variable-length encoding means something computed an offset
      // wrongly rather than that the program jumped somewhere odd --
      // there is no way for a guest to name an address here at all.
      throw new IsaError(
        `${ISA_NAME}: offset 0x${offset.toString(16)} is not an instruction boundary`,
      )
    }
    return found
  }

  speculativeAt(addr: bigint): WasmStaticInst | null {
    const key = Number(addr)
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

  /** Every instruction of a function, in encoding order. */
  instructionsOf(body: FuncBody): readonly WasmStaticInst[] {
    const sites = [...this.analysisFor(body).sites.values()]
    return sites.sort((a, b) => Number(a.addr - b.addr))
  }
}
