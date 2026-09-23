/**
 * Running a module twice: here, and in the engine the tests run inside.
 *
 * This is the piece that makes this target's verification different from
 * every other one in the project. The other backends compare against an
 * emulator or a processor that has to be driven in a container, so their
 * oracle's answers are captured once and committed, and a test reads the
 * recording. Here the oracle is `WebAssembly`, which is *already in the
 * test process* -- so the comparison is live, on modules generated from
 * a seed at the moment the test runs, and nothing can go stale between
 * capturing and checking.
 *
 * What gets compared is deliberately more than a return value:
 *
 *   - the values the exported function returned, as raw bits, so a
 *     float is compared as a pattern and never as a number;
 *   - **all of linear memory, byte for byte**, which on this target is
 *     the whole of the guest's observable state -- there is no register
 *     file to dump, and the engine hands the memory over directly;
 *   - whether the program trapped, and which kind of trap it was.
 *
 * That last one matters. A trap is a *specified* result here, not a
 * failure of the implementation, so "both sides refused this program for
 * the same reason" is a real thing to check and not an excused
 * difference. The two engines word their messages differently, so the
 * comparison is on the category rather than the text.
 */
import { createRetireChunk, RunState } from '../common/trace.ts'
import { loadWasm } from './load.ts'
import { exportedFunctions } from './load.ts'
import { parseModule, typeOf, ValType } from './module.ts'

export interface RunResult {
  /** Raw bits of each returned value; empty when the function returns none. */
  results: bigint[]
  memory: Uint8Array
  /** The trap category, or '' when the program ran to completion. */
  trap: string
  /** The message behind the category, for a failure that needs explaining. */
  detail: string
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
  retired: number
}

/**
 * What a trap was, in terms both engines can be compared on.
 *
 * The standard says which programs trap but not what an engine should
 * say about it, so the words differ: one says "memory access out of
 * bounds" and the other "out of bounds memory access", and a third would
 * say something else again. The category is the part that is specified.
 */
export function trapCategory(message: string): string {
  const text = message.toLowerCase()
  if (text.includes('unreachable')) return 'unreachable'
  // "divide by zero" here, "remainder by zero" in V8 when the operation
  // was a remainder -- the same trap, named after whichever instruction
  // raised it.
  if (text.includes('by zero')) return 'divide-by-zero'
  if (text.includes('unrepresentable') || text.includes('invalid conversion')) {
    // V8 calls a NaN or out-of-range float conversion "unrepresentable"
    // and a too-large quotient "divide result unrepresentable"; the
    // second is an overflow of the division rather than a conversion.
    return text.includes('divide') ? 'overflow' : 'bad-conversion'
  }
  if (text.includes('integer overflow')) return 'overflow'
  // Anything about the table or its elements is the indirect call
  // failing, whether the slot was past the end, empty, or the wrong
  // type. Checked before the general out-of-bounds arm, which would
  // otherwise claim "table index is out of bounds" for memory.
  if (text.includes('table') || text.includes('element') ||
    text.includes('signature mismatch') || text.includes('type mismatch') ||
    text.includes('null function')) {
    return 'indirect-call'
  }
  if (text.includes('out of bounds') || text.includes('out-of-bounds')) {
    return 'out-of-bounds'
  }
  if (text.includes('call stack') || text.includes('stack exhausted') ||
    text.includes('stack size exceeded')) {
    return 'stack'
  }
  if (text.includes('budget')) return 'budget'
  return 'other'
}

const bits = new DataView(new ArrayBuffer(8))

/** A raw bit pattern as the value the engine's calling convention wants. */
export function toEngineValue(type: number, raw: bigint): number | bigint {
  switch (type) {
    case ValType.I32: return Number(BigInt.asIntN(32, raw))
    case ValType.I64: return BigInt.asIntN(64, raw)
    case ValType.F32:
      bits.setUint32(0, Number(raw & 0xffff_ffffn), true)
      return bits.getFloat32(0, true)
    default:
      bits.setBigUint64(0, BigInt.asUintN(64, raw), true)
      return bits.getFloat64(0, true)
  }
}

/** And back, so a float is compared as a pattern rather than as a number. */
export function fromEngineValue(type: number, value: unknown): bigint {
  switch (type) {
    case ValType.I32: return BigInt.asUintN(32, BigInt(value as number))
    case ValType.I64: return BigInt.asUintN(64, value as bigint)
    case ValType.F32:
      bits.setFloat32(0, value as number, true)
      return BigInt(bits.getUint32(0, true))
    default:
      bits.setFloat64(0, value as number, true)
      return bits.getBigUint64(0, true)
  }
}

export interface InvokeOptions {
  /** Export to call; omitted means run from the module's own entry point. */
  entry?: string
  args?: readonly bigint[]
  instructionBudget?: number
}

const EMPTY = new Uint8Array()

/** Runs a module in the host's engine. */
export function runInEngine(bytes: Uint8Array, options: InvokeOptions = {}): RunResult {
  const module = parseModule(bytes)
  const memoryExport = module.exports.find((entry) => entry.kind === 2)
  const blank: RunResult = {
    results: [], memory: EMPTY, trap: '', detail: '',
    stdout: EMPTY, stderr: EMPTY, exitCode: 0, retired: 0,
  }
  try {
    // `bytes` may be backed by any ArrayBufferLike; the engine's typing
    // insists on a plain one, so this copies rather than asserts.
    const source = new Uint8Array(bytes)
    const instance = new WebAssembly.Instance(new WebAssembly.Module(source), {})
    let results: bigint[] = []
    if (options.entry !== undefined) {
      const index = exportedFunctions(module).get(options.entry)
      if (index === undefined) throw new Error(`no export named ${options.entry}`)
      const type = typeOf(module, index)
      const fn = instance.exports[options.entry] as (...a: unknown[]) => unknown
      const returned = fn(...type.params.map(
        (t, i) => toEngineValue(t, options.args?.[i] ?? 0n)))
      if (type.results.length === 1) {
        results = [fromEngineValue(type.results[0]!, returned)]
      } else if (type.results.length > 1) {
        results = (returned as unknown[]).map(
          (value, i) => fromEngineValue(type.results[i]!, value))
      }
    }
    const memory = memoryExport
      ? new Uint8Array((instance.exports[memoryExport.name] as WebAssembly.Memory).buffer).slice()
      : EMPTY
    return { ...blank, results, memory }
  } catch (error) {
    const detail = (error as Error).message
    return { ...blank, trap: trapCategory(detail), detail }
  }
}

/** Runs the same module here. */
export function runInInterpreter(bytes: Uint8Array, options: InvokeOptions = {}): RunResult {
  const loaded = loadWasm(bytes, {
    instructionBudget: options.instructionBudget ?? 200_000_000,
  })
  const { interpreter } = loaded
  const blank: RunResult = {
    results: [], memory: EMPTY, trap: '', detail: '',
    stdout: EMPTY, stderr: EMPTY, exitCode: 0, retired: 0,
  }
  try {
    if (options.entry !== undefined) {
      const index = exportedFunctions(loaded.module).get(options.entry)
      if (index === undefined) throw new Error(`no export named ${options.entry}`)
      interpreter.invoke(index, options.args ?? [])
    }
    const chunk = createRetireChunk(8192)
    let state: RunState = RunState.MORE
    while (state === RunState.MORE) state = interpreter.run(chunk)
    return {
      ...blank,
      results: [...interpreter.results()],
      memory: interpreter.memoryBytes().slice(),
      stdout: interpreter.stdout(),
      stderr: interpreter.stderr(),
      exitCode: interpreter.exitCode,
      retired: interpreter.retired,
    }
  } catch (error) {
    const detail = (error as Error).message
    return {
      ...blank,
      trap: trapCategory(detail),
      detail,
      stdout: interpreter.stdout(),
      stderr: interpreter.stderr(),
      retired: interpreter.retired,
    }
  }
}

/**
 * Every way the two runs differ, in the order they would be noticed.
 *
 * Returns a list rather than a boolean, and names the first differing
 * address rather than saying that memory differs, because a diagnostic
 * that only says "wrong" makes the next step a bisection.
 */
export function differences(reference: RunResult, actual: RunResult): string[] {
  const problems: string[] = []

  if (reference.trap !== actual.trap) {
    problems.push(
      `trap: reference ${reference.trap || 'none'} (${reference.detail || '-'}), ` +
      `ours ${actual.trap || 'none'} (${actual.detail || '-'})`,
    )
    // Once one side has stopped early there is nothing useful to compare.
    return problems
  }
  if (reference.trap) return problems

  if (reference.results.length !== actual.results.length ||
    reference.results.some((value, i) => value !== actual.results[i])) {
    problems.push(
      `result: reference [${reference.results.map(hex).join(', ')}], ` +
      `ours [${actual.results.map(hex).join(', ')}]`,
    )
  }

  if (reference.memory.length !== actual.memory.length) {
    problems.push(
      `memory size: reference ${reference.memory.length}, ours ${actual.memory.length}`,
    )
    return problems
  }
  let differing = 0
  for (let at = 0; at < reference.memory.length; at++) {
    if (reference.memory[at] === actual.memory[at]) continue
    if (differing === 0) {
      const from = at & ~7
      problems.push(
        `memory at 0x${at.toString(16)}: ` +
        `reference ${bytesAt(reference.memory, from)}, ours ${bytesAt(actual.memory, from)}`,
      )
    }
    differing += 1
  }
  if (differing > 1) problems.push(`${differing} bytes of memory differ in total`)

  return problems
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`
}

function bytesAt(memory: Uint8Array, from: number): string {
  return [...memory.slice(from, from + 8)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
}
