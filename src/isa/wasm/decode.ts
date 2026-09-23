/**
 * WebAssembly decoder.
 *
 * The only target here that is not a processor, and the differences
 * that follow are not cosmetic.
 *
 * **There are no registers.** Every operand comes off a stack and every
 * result goes back onto it. So an instruction's identity does not tell
 * you what it touches -- `i32.add` reads "the top two" and writes "the
 * top one", and which storage that is depends on how deep the stack is
 * at that point. What makes this tractable, and what the whole resource
 * mapping in image.ts rests on, is that a valid module's stack depth at
 * every instruction is *statically determined*. The depth is a property
 * of the code, not of the run, so the analysis can be exact rather than
 * approximate.
 *
 * **Control flow is structured, not addressed.** There is no jump to an
 * address: `br 2` means "leave two enclosing blocks". Where that lands
 * depends on the block nesting, which is why branch targets are
 * resolved by walking the function rather than read out of the
 * instruction. A `br` out of a `loop` goes backwards to the loop's
 * head; the identical instruction in a `block` goes forwards to its
 * end. The opcode does not distinguish them.
 *
 * **Immediates are variable-length, and the length is not implied.**
 * Everything is LEB128, and the encoder is free to pad -- clang emits
 * five bytes for a call index of 1 so the linker can patch it. A
 * decoder that assumed the minimal encoding would be right about the
 * value and wrong about where the next instruction starts.
 *
 * The operation identity here is simply the opcode byte, extended for
 * the two prefix spaces. That is not laziness: unlike every other
 * target in this project, the byte *is* the instruction, with no fields
 * inside it to decode, so a separate enumeration would be a second name
 * for the same number and a second place to get it wrong.
 */
import { UnimplementedInstruction } from '../common/errors.ts'

export const ISA_NAME = 'wasm'

/** What an instruction carries after its opcode. */
export const Imm = {
  NONE: 0,
  /** An unsigned LEB128, such as a local or function index. */
  U32: 1,
  /** A signed LEB128. */
  I32: 2,
  I64: 3,
  F32: 4,
  F64: 5,
  /** Alignment and offset, two unsigned LEB128s. */
  MEMARG: 6,
  /** A block's result type: a signed LEB that may name a type index. */
  BLOCKTYPE: 7,
  /** A vector of labels and then the default. */
  BRTABLE: 8,
  /** Type index then table index. */
  CALL_INDIRECT: 9,
  /** A vector of value types, for the typed `select`. */
  SELECT_T: 10,
  /** A single byte naming a reference type. */
  REFTYPE: 11,
  /** Two unsigned LEB128s, as `memory.copy` takes. */
  TWO_U32: 12,
} as const
export type ImmKind = (typeof Imm)[keyof typeof Imm]

export const Flow = {
  SEQ: 0,
  /** `block`, `loop`, `if`: opens a region the branches name. */
  OPEN: 1,
  /** `end`, `else`: closes one. */
  CLOSE: 2,
  BRANCH: 3,
  JUMP: 4,
  CALL: 5,
  INDIRECT: 6,
  RET: 7,
  TRAP: 8,
} as const
export type FlowKind = (typeof Flow)[keyof typeof Flow]

interface Entry {
  name: string
  /** Values taken off the stack. */
  pop: number
  /** Values put back. */
  push: number
  imm: ImmKind
  flow?: FlowKind
  /** Bytes touched, for a load or a store. */
  width?: number
  signed?: boolean
  store?: boolean
}

const TABLE: Record<number, Entry> = {}

function op(code: number, name: string, pop: number, push: number,
  imm: ImmKind = Imm.NONE, extra: Partial<Entry> = {}): void {
  TABLE[code] = { name, pop, push, imm, ...extra }
}

// ---- Control ---------------------------------------------------------
op(0x00, 'unreachable', 0, 0, Imm.NONE, { flow: Flow.TRAP })
op(0x01, 'nop', 0, 0)
op(0x02, 'block', 0, 0, Imm.BLOCKTYPE, { flow: Flow.OPEN })
op(0x03, 'loop', 0, 0, Imm.BLOCKTYPE, { flow: Flow.OPEN })
op(0x04, 'if', 1, 0, Imm.BLOCKTYPE, { flow: Flow.OPEN })
op(0x05, 'else', 0, 0, Imm.NONE, { flow: Flow.CLOSE })
op(0x0b, 'end', 0, 0, Imm.NONE, { flow: Flow.CLOSE })
op(0x0c, 'br', 0, 0, Imm.U32, { flow: Flow.JUMP })
op(0x0d, 'br_if', 1, 0, Imm.U32, { flow: Flow.BRANCH })
op(0x0e, 'br_table', 1, 0, Imm.BRTABLE, { flow: Flow.INDIRECT })
op(0x0f, 'return', 0, 0, Imm.NONE, { flow: Flow.RET })
op(0x10, 'call', 0, 0, Imm.U32, { flow: Flow.CALL })
op(0x11, 'call_indirect', 1, 0, Imm.CALL_INDIRECT, { flow: Flow.INDIRECT })

// ---- Parametric ------------------------------------------------------
op(0x1a, 'drop', 1, 0)
op(0x1b, 'select', 3, 1)
op(0x1c, 'select', 3, 1, Imm.SELECT_T)

// ---- Variables -------------------------------------------------------
op(0x20, 'local.get', 0, 1, Imm.U32)
op(0x21, 'local.set', 1, 0, Imm.U32)
op(0x22, 'local.tee', 1, 1, Imm.U32)
op(0x23, 'global.get', 0, 1, Imm.U32)
op(0x24, 'global.set', 1, 0, Imm.U32)
op(0x25, 'table.get', 1, 1, Imm.U32)
op(0x26, 'table.set', 2, 0, Imm.U32)

// ---- Memory ----------------------------------------------------------
const LOADS: [number, string, number, boolean][] = [
  [0x28, 'i32.load', 4, false], [0x29, 'i64.load', 8, false],
  [0x2a, 'f32.load', 4, false], [0x2b, 'f64.load', 8, false],
  [0x2c, 'i32.load8_s', 1, true], [0x2d, 'i32.load8_u', 1, false],
  [0x2e, 'i32.load16_s', 2, true], [0x2f, 'i32.load16_u', 2, false],
  [0x30, 'i64.load8_s', 1, true], [0x31, 'i64.load8_u', 1, false],
  [0x32, 'i64.load16_s', 2, true], [0x33, 'i64.load16_u', 2, false],
  [0x34, 'i64.load32_s', 4, true], [0x35, 'i64.load32_u', 4, false],
]
for (const [code, name, width, signed] of LOADS) {
  op(code, name, 1, 1, Imm.MEMARG, { width, signed })
}
const STORES: [number, string, number][] = [
  [0x36, 'i32.store', 4], [0x37, 'i64.store', 8],
  [0x38, 'f32.store', 4], [0x39, 'f64.store', 8],
  [0x3a, 'i32.store8', 1], [0x3b, 'i32.store16', 2],
  [0x3c, 'i64.store8', 1], [0x3d, 'i64.store16', 2], [0x3e, 'i64.store32', 4],
]
for (const [code, name, width] of STORES) {
  op(code, name, 2, 0, Imm.MEMARG, { width, store: true })
}
op(0x3f, 'memory.size', 0, 1, Imm.U32)
op(0x40, 'memory.grow', 1, 1, Imm.U32)

// ---- Constants -------------------------------------------------------
op(0x41, 'i32.const', 0, 1, Imm.I32)
op(0x42, 'i64.const', 0, 1, Imm.I64)
op(0x43, 'f32.const', 0, 1, Imm.F32)
op(0x44, 'f64.const', 0, 1, Imm.F64)

/**
 * The comparisons and the arithmetic, which are four near-identical
 * families and are written out as such.
 *
 * Generated rather than listed for the reason the other targets'
 * generated tables exist: this is one fact repeated sixty times, and
 * writing it out by hand is how a typo gets into the table that is
 * meant to catch typos. The opcode numbering is contiguous within each
 * family, which is what makes it safe to generate.
 */
function family(base: number, prefix: string, names: readonly string[],
  pop: number, push: number): void {
  names.forEach((name, i) => { op(base + i, `${prefix}.${name}`, pop, push) })
}

// i32 tests and comparisons: eqz takes one, the rest take two.
op(0x45, 'i32.eqz', 1, 1)
family(0x46, 'i32', ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u',
  'le_s', 'le_u', 'ge_s', 'ge_u'], 2, 1)
op(0x50, 'i64.eqz', 1, 1)
family(0x51, 'i64', ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u',
  'le_s', 'le_u', 'ge_s', 'ge_u'], 2, 1)
family(0x5b, 'f32', ['eq', 'ne', 'lt', 'gt', 'le', 'ge'], 2, 1)
family(0x61, 'f64', ['eq', 'ne', 'lt', 'gt', 'le', 'ge'], 2, 1)

// i32 arithmetic: three unary, then the binary run.
family(0x67, 'i32', ['clz', 'ctz', 'popcnt'], 1, 1)
family(0x6a, 'i32', ['add', 'sub', 'mul', 'div_s', 'div_u', 'rem_s', 'rem_u',
  'and', 'or', 'xor', 'shl', 'shr_s', 'shr_u', 'rotl', 'rotr'], 2, 1)
family(0x79, 'i64', ['clz', 'ctz', 'popcnt'], 1, 1)
family(0x7c, 'i64', ['add', 'sub', 'mul', 'div_s', 'div_u', 'rem_s', 'rem_u',
  'and', 'or', 'xor', 'shl', 'shr_s', 'shr_u', 'rotl', 'rotr'], 2, 1)
family(0x8b, 'f32', ['abs', 'neg', 'ceil', 'floor', 'trunc', 'nearest', 'sqrt'], 1, 1)
family(0x92, 'f32', ['add', 'sub', 'mul', 'div', 'min', 'max', 'copysign'], 2, 1)
family(0x99, 'f64', ['abs', 'neg', 'ceil', 'floor', 'trunc', 'nearest', 'sqrt'], 1, 1)
family(0xa0, 'f64', ['add', 'sub', 'mul', 'div', 'min', 'max', 'copysign'], 2, 1)

// ---- Conversions -----------------------------------------------------
const CONVERSIONS: [number, string][] = [
  [0xa7, 'i32.wrap_i64'],
  [0xa8, 'i32.trunc_f32_s'], [0xa9, 'i32.trunc_f32_u'],
  [0xaa, 'i32.trunc_f64_s'], [0xab, 'i32.trunc_f64_u'],
  [0xac, 'i64.extend_i32_s'], [0xad, 'i64.extend_i32_u'],
  [0xae, 'i64.trunc_f32_s'], [0xaf, 'i64.trunc_f32_u'],
  [0xb0, 'i64.trunc_f64_s'], [0xb1, 'i64.trunc_f64_u'],
  [0xb2, 'f32.convert_i32_s'], [0xb3, 'f32.convert_i32_u'],
  [0xb4, 'f32.convert_i64_s'], [0xb5, 'f32.convert_i64_u'],
  [0xb6, 'f32.demote_f64'],
  [0xb7, 'f64.convert_i32_s'], [0xb8, 'f64.convert_i32_u'],
  [0xb9, 'f64.convert_i64_s'], [0xba, 'f64.convert_i64_u'],
  [0xbb, 'f64.promote_f32'],
  [0xbc, 'i32.reinterpret_f32'], [0xbd, 'i64.reinterpret_f64'],
  [0xbe, 'f32.reinterpret_i32'], [0xbf, 'f64.reinterpret_i64'],
  [0xc0, 'i32.extend8_s'], [0xc1, 'i32.extend16_s'],
  [0xc2, 'i64.extend8_s'], [0xc3, 'i64.extend16_s'], [0xc4, 'i64.extend32_s'],
]
for (const [code, name] of CONVERSIONS) op(code, name, 1, 1)

/**
 * The 0xFC prefix space, whose opcode is a second LEB after the byte.
 *
 * Only the saturating conversions and the bulk-memory operations are
 * here, because they are what a compiler emits; the rest of the space
 * is refused.
 */
const PREFIXED: Record<number, Entry> = {}
function prefixed(sub: number, name: string, pop: number, push: number,
  imm: ImmKind = Imm.NONE, extra: Partial<Entry> = {}): void {
  PREFIXED[sub] = { name, pop, push, imm, ...extra }
}
const SATURATING = [
  'i32.trunc_sat_f32_s', 'i32.trunc_sat_f32_u',
  'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u',
  'i64.trunc_sat_f32_s', 'i64.trunc_sat_f32_u',
  'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u',
]
SATURATING.forEach((name, i) => { prefixed(i, name, 1, 1) })
prefixed(10, 'memory.copy', 3, 0, Imm.TWO_U32, { store: true, width: 1 })
prefixed(11, 'memory.fill', 3, 0, Imm.U32, { store: true, width: 1 })

/** Every opcode this decoder implements, for the tests that need the list. */
export const IMPLEMENTED_OPCODES: readonly number[] =
  Object.keys(TABLE).map(Number).sort((a, b) => a - b)

export function nameOf(code: number): string {
  if (code >= 0x100) return PREFIXED[code - 0x100]?.name ?? `?fc${code - 0x100}`
  return TABLE[code]?.name ?? `?${code.toString(16)}`
}

export interface WasmInst {
  /** The opcode byte, or 0x100 plus the sub-opcode for the prefix space. */
  op: number
  /** Total encoded length, opcode and immediates together. */
  length: number
  /** The first immediate: an index, a constant, or a memory offset. */
  imm: bigint
  /** A memory access's alignment hint, which is advisory only. */
  align: number
  /** A second index, where the instruction carries one. */
  imm2: number
  /** Branch depths, for `br_table`; the last is the default. */
  targets: readonly number[]
  /** A block's declared result count, as far as the opcode says. */
  blockType: number
  pop: number
  push: number
  flow: FlowKind
  width: number
  signed: boolean
  store: boolean
}

/** Reads an unsigned LEB128, returning the value and how long it was. */
function leb(read: (offset: number) => number, at: number):
{ value: bigint; length: number } {
  let value = 0n
  let shift = 0n
  let length = 0
  for (;;) {
    const byte = read(at + length)
    length += 1
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7n
    // The encoder may pad, but not without limit: ten bytes is the most
    // a 64-bit value can occupy.
    if (length > 10) break
  }
  return { value, length }
}

/** Reads a signed LEB128, which sign-extends from wherever it stopped. */
function sleb(read: (offset: number) => number, at: number, bits: number):
{ value: bigint; length: number } {
  let value = 0n
  let shift = 0n
  let length = 0
  let byte = 0
  do {
    byte = read(at + length)
    length += 1
    value |= BigInt(byte & 0x7f) << shift
    shift += 7n
  } while ((byte & 0x80) !== 0 && length <= 10)
  if (shift < BigInt(bits) && (byte & 0x40) !== 0) {
    value |= ~0n << shift
  }
  return { value: BigInt.asIntN(bits, value), length }
}

export function decode(read: (offset: number) => number, address: bigint): WasmInst {
  const code = read(0) & 0xff
  let entry = TABLE[code]
  let op = code
  let at = 1

  if (code === 0xfc) {
    const sub = leb(read, 1)
    at = 1 + sub.length
    const found = PREFIXED[Number(sub.value)]
    if (!found) {
      return refuse(address, [code], `prefixed opcode 0xfc ${sub.value}`)
    }
    entry = found
    op = 0x100 + Number(sub.value)
  } else if (!entry) {
    return refuse(address, [code], `opcode 0x${code.toString(16)}`)
  }

  const inst: WasmInst = {
    op,
    length: 0,
    imm: 0n,
    align: 0,
    imm2: 0,
    targets: [],
    blockType: 0,
    pop: entry!.pop,
    push: entry!.push,
    flow: entry!.flow ?? Flow.SEQ,
    width: entry!.width ?? 0,
    signed: entry!.signed ?? false,
    store: entry!.store ?? false,
  }

  switch (entry!.imm) {
    case Imm.NONE:
      break
    case Imm.U32: {
      const value = leb(read, at)
      inst.imm = value.value
      at += value.length
      break
    }
    case Imm.TWO_U32: {
      const first = leb(read, at)
      at += first.length
      const second = leb(read, at)
      at += second.length
      inst.imm = first.value
      inst.imm2 = Number(second.value)
      break
    }
    case Imm.I32: {
      const value = sleb(read, at, 32)
      inst.imm = value.value
      at += value.length
      break
    }
    case Imm.I64: {
      const value = sleb(read, at, 64)
      inst.imm = value.value
      at += value.length
      break
    }
    case Imm.F32: {
      let bits = 0
      for (let i = 0; i < 4; i++) bits |= (read(at + i) & 0xff) << (i * 8)
      inst.imm = BigInt(bits >>> 0)
      at += 4
      break
    }
    case Imm.F64: {
      let bits = 0n
      for (let i = 0; i < 8; i++) bits |= BigInt(read(at + i) & 0xff) << BigInt(i * 8)
      inst.imm = bits
      at += 8
      break
    }
    case Imm.MEMARG: {
      const align = leb(read, at)
      at += align.length
      const offset = leb(read, at)
      at += offset.length
      inst.align = Number(align.value)
      inst.imm = offset.value
      break
    }
    case Imm.BLOCKTYPE: {
      // Either 0x40 for "no result", a single value type, or a signed
      // index into the type section. The three are told apart by value,
      // which is why this is a signed read rather than a byte.
      const value = sleb(read, at, 33)
      at += value.length
      inst.blockType = Number(value.value)
      break
    }
    case Imm.BRTABLE: {
      const count = leb(read, at)
      at += count.length
      const targets: number[] = []
      for (let i = 0; i < Number(count.value); i++) {
        const target = leb(read, at)
        at += target.length
        targets.push(Number(target.value))
      }
      const fallback = leb(read, at)
      at += fallback.length
      targets.push(Number(fallback.value))
      inst.targets = targets
      break
    }
    case Imm.CALL_INDIRECT: {
      const type = leb(read, at)
      at += type.length
      const table = leb(read, at)
      at += table.length
      inst.imm = type.value
      inst.imm2 = Number(table.value)
      break
    }
    case Imm.SELECT_T: {
      const count = leb(read, at)
      at += count.length
      at += Number(count.value)
      break
    }
    case Imm.REFTYPE:
      at += 1
      break
    default:
      break
  }

  inst.length = at
  return inst
}

function refuse(address: bigint, bytes: readonly number[], detail: string): never {
  throw new UnimplementedInstruction(
    ISA_NAME, address, Uint8Array.from(bytes), detail,
  )
}
