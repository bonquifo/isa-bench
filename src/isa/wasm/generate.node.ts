/**
 * Random module generator, for the differential tier.
 *
 * ## Why this emits bytes rather than C
 *
 * Every other target here generates C and lets clang choose the
 * encoding, because the thing being tested is a real toolchain's output
 * and because writing the encoding by hand is how you end up testing
 * your own misunderstanding.
 *
 * That argument does not carry over. The five compiled modules in the
 * corpus contain 48 of the 180 opcodes this backend implements: clang
 * emitting ordinary C never produces `i64.rotl`, `f64.copysign`,
 * `i32.reinterpret_f32`, the saturating truncations, `select`,
 * `br_table` or `memory.grow`. Testing 48 and asserting the other 132
 * by inspection is exactly the failure this project exists to avoid.
 *
 * ## Why emitting the bytes is not circular
 *
 * The obvious objection is that a generator using this backend's own
 * opcode numbers, checked against an interpreter using the same
 * numbers, proves nothing.
 *
 * It is not so. The reference executes the *byte*. If this backend
 * believes 0x7c is `i64.add` when it is really something else, the
 * generator emits 0x7c meaning add, the engine does whatever 0x7c
 * actually is, and the two disagree. The tier therefore checks the whole
 * mapping from opcode to behaviour, which is the thing that matters --
 * and it is a stronger check than the decode tier, which only says what
 * LLVM calls a byte.
 *
 * What it cannot catch is a table and a semantics wrong in the same
 * compensating way. For families generated contiguously from one line of
 * code, that is not a realistic failure.
 *
 * ## Staying in the tested space
 *
 * The generator only produces programs that do not trap: divisors are
 * forced positive and odd, addresses are masked into the first page, and
 * the trapping conversions are fed values that were integers a moment
 * ago. Traps are worth comparing too -- they are specified behaviour --
 * but they end a run, and a run that ends on its third instruction tests
 * three instructions. They get their own generator, below.
 */

export const Type = { I32: 0x7f, I64: 0x7e, F32: 0x7d, F64: 0x7c } as const
export type Type = (typeof Type)[keyof typeof Type]

const ALL_TYPES: readonly Type[] = [Type.I32, Type.I64, Type.F32, Type.F64]

// ---- Encoding --------------------------------------------------------

function uleb(value: number): number[] {
  const out: number[] = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    out.push(byte)
  } while (v !== 0)
  return out
}

function sleb(value: number): number[] {
  const out: number[] = []
  let v = value | 0
  for (;;) {
    const byte = v & 0x7f
    v >>= 7
    const signBit = (byte & 0x40) !== 0
    if ((v === 0 && !signBit) || (v === -1 && signBit)) { out.push(byte); break }
    out.push(byte | 0x80)
  }
  return out
}

function sleb64(value: bigint): number[] {
  const out: number[] = []
  let v = BigInt.asIntN(64, value)
  for (;;) {
    const byte = Number(v & 0x7fn)
    v >>= 7n
    const signBit = (byte & 0x40) !== 0
    if ((v === 0n && !signBit) || (v === -1n && signBit)) { out.push(byte); break }
    out.push(byte | 0x80)
  }
  return out
}

function f32Bytes(bits: number): number[] {
  return [bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]
}
function f64Bytes(bits: bigint): number[] {
  const out: number[] = []
  for (let i = 0n; i < 8n; i++) out.push(Number((bits >> (i * 8n)) & 0xffn))
  return out
}

/**
 * Appends one byte list to another.
 *
 * `target.push(...source)` reads better and breaks: the spread becomes
 * one argument per byte, and the probe module below is well past the
 * engine's argument limit. It fails as a stack overflow inside the
 * encoder, which points nowhere near the actual cause.
 */
function append(target: number[], source: readonly number[]): number[] {
  for (let i = 0; i < source.length; i++) target.push(source[i]!)
  return target
}

function vec(items: readonly (readonly number[])[]): number[] {
  const out = uleb(items.length)
  for (const item of items) append(out, item)
  return out
}

function section(id: number, payload: readonly number[]): number[] {
  const out = [id]
  append(out, uleb(payload.length))
  return append(out, payload)
}

// ---- Determinism -----------------------------------------------------

/** xorshift32: small, seedable, and identical on every machine. */
function rng(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state >>> 0
  }
}

// ---- The operation catalogue -----------------------------------------

interface Operation {
  op: number
  params: readonly Type[]
  result: Type
  /**
   * The second operand must be made safe before use. Only division and
   * remainder need it, and what they need is "positive and odd", which
   * excludes both zero and the one quotient that does not fit.
   */
  guardDivisor?: boolean
  /** The operand must come from an integer, or the truncation traps. */
  fromInteger?: 'signed' | 'unsigned'
}

function run(base: number, count: number, params: readonly Type[], result: Type,
  extra: Partial<Operation> = {}): Operation[] {
  return Array.from({ length: count }, (_, i) => ({ op: base + i, params, result, ...extra }))
}

const I32 = Type.I32, I64 = Type.I64, F32 = Type.F32, F64 = Type.F64

const OPERATIONS: readonly Operation[] = [
  // Integer comparisons, which all produce a boolean in an i32.
  { op: 0x45, params: [I32], result: I32 },
  ...run(0x46, 10, [I32, I32], I32),
  { op: 0x50, params: [I64], result: I32 },
  ...run(0x51, 10, [I64, I64], I32),
  ...run(0x5b, 6, [F32, F32], I32),
  ...run(0x61, 6, [F64, F64], I32),

  // i32 arithmetic. The four division forms carry a guard.
  ...run(0x67, 3, [I32], I32),
  ...run(0x6a, 3, [I32, I32], I32),
  ...run(0x6d, 4, [I32, I32], I32, { guardDivisor: true }),
  ...run(0x71, 8, [I32, I32], I32),

  ...run(0x79, 3, [I64], I64),
  ...run(0x7c, 3, [I64, I64], I64),
  ...run(0x7f, 4, [I64, I64], I64, { guardDivisor: true }),
  ...run(0x83, 8, [I64, I64], I64),

  ...run(0x8b, 7, [F32], F32),
  ...run(0x92, 7, [F32, F32], F32),
  ...run(0x99, 7, [F64], F64),
  ...run(0xa0, 7, [F64, F64], F64),

  // Conversions. The trapping truncations take their operand from an
  // integer so that the value is one they can represent.
  { op: 0xa7, params: [I64], result: I32 },
  { op: 0xa8, params: [F32], result: I32, fromInteger: 'signed' },
  { op: 0xa9, params: [F32], result: I32, fromInteger: 'unsigned' },
  { op: 0xaa, params: [F64], result: I32, fromInteger: 'signed' },
  { op: 0xab, params: [F64], result: I32, fromInteger: 'unsigned' },
  { op: 0xac, params: [I32], result: I64 },
  { op: 0xad, params: [I32], result: I64 },
  { op: 0xae, params: [F32], result: I64, fromInteger: 'signed' },
  { op: 0xaf, params: [F32], result: I64, fromInteger: 'unsigned' },
  { op: 0xb0, params: [F64], result: I64, fromInteger: 'signed' },
  { op: 0xb1, params: [F64], result: I64, fromInteger: 'unsigned' },
  { op: 0xb2, params: [I32], result: F32 },
  { op: 0xb3, params: [I32], result: F32 },
  { op: 0xb4, params: [I64], result: F32 },
  { op: 0xb5, params: [I64], result: F32 },
  { op: 0xb6, params: [F64], result: F32 },
  { op: 0xb7, params: [I32], result: F64 },
  { op: 0xb8, params: [I32], result: F64 },
  { op: 0xb9, params: [I64], result: F64 },
  { op: 0xba, params: [I64], result: F64 },
  { op: 0xbb, params: [F32], result: F64 },
  { op: 0xbc, params: [F32], result: I32 },
  { op: 0xbd, params: [F64], result: I64 },
  { op: 0xbe, params: [I32], result: F32 },
  { op: 0xbf, params: [I64], result: F64 },
  { op: 0xc0, params: [I32], result: I32 },
  { op: 0xc1, params: [I32], result: I32 },
  { op: 0xc2, params: [I64], result: I64 },
  { op: 0xc3, params: [I64], result: I64 },
  { op: 0xc4, params: [I64], result: I64 },

  // The saturating truncations, which need no guard: that is the point
  // of them.
  { op: 0x100, params: [F32], result: I32 },
  { op: 0x101, params: [F32], result: I32 },
  { op: 0x102, params: [F64], result: I32 },
  { op: 0x103, params: [F64], result: I32 },
  { op: 0x104, params: [F32], result: I64 },
  { op: 0x105, params: [F32], result: I64 },
  { op: 0x106, params: [F64], result: I64 },
  { op: 0x107, params: [F64], result: I64 },
]

/** Loads and stores, as (opcode, type, width, natural alignment). */
const LOADS: readonly [number, Type, number][] = [
  [0x28, I32, 4], [0x29, I64, 8], [0x2a, F32, 4], [0x2b, F64, 8],
  [0x2c, I32, 1], [0x2d, I32, 1], [0x2e, I32, 2], [0x2f, I32, 2],
  [0x30, I64, 1], [0x31, I64, 1], [0x32, I64, 2], [0x33, I64, 2],
  [0x34, I64, 4], [0x35, I64, 4],
]
const STORES: readonly [number, Type, number][] = [
  [0x36, I32, 4], [0x37, I64, 8], [0x38, F32, 4], [0x39, F64, 8],
  [0x3a, I32, 1], [0x3b, I32, 2],
  [0x3c, I64, 1], [0x3d, I64, 2], [0x3e, I64, 4],
]

/** Constants worth reaching: the edges, the signs of zero, and a NaN. */
const I32_SEEDS = [0, 1, -1, 2, -2147483648, 2147483647, 0x5a5a5a5a | 0, 255, -129]
const I64_SEEDS = [
  0n, 1n, -1n, 0x7fff_ffff_ffff_ffffn, -(2n ** 63n),
  0x0123_4567_89ab_cdefn, 0xffff_ffffn, -4294967296n,
]
/**
 * f32 bit patterns: 0, -0, 1, -1, the infinities, both signs of NaN, a
 * subnormal and an ordinary value.
 *
 * The *negative* NaN is here because leaving it out hid a real bug. A
 * NaN's sign is a bit rather than an ordering -- it compares false
 * against zero either way -- so an implementation that tested `b < 0`
 * instead of reading the bit got `copysign` wrong and this probe said
 * nothing, because every NaN it tried was positive.
 */
const F32_SEEDS = [
  0x0000_0000, 0x8000_0000, 0x3f80_0000, 0xbf80_0000,
  0x7f80_0000, 0xff80_0000, 0x7fc0_1234, 0xffc0_1234,
  0x0000_0001, 0x4048_f5c3,
]
const F64_SEEDS = [
  0x0000_0000_0000_0000n, 0x8000_0000_0000_0000n,
  0x3ff0_0000_0000_0000n, 0xbff0_0000_0000_0000n,
  0x7ff0_0000_0000_0000n, 0xfff0_0000_0000_0000n,
  0x7ff8_0000_0000_1234n, 0xfff8_0000_0000_1234n,
  0x0000_0000_0000_0001n, 0x4009_21fb_5444_2d18n,
]

// ---- The builder -----------------------------------------------------

/** Locals available to draw operands from, by type. */
type Pool = Record<number, number[]>

const LOCALS_PER_TYPE = 6
const ADDRESS_MASK = 0xff_f0
const SCRATCH_BASE = 0x8000

interface Emitter {
  code: number[]
  used: Set<number>
}

function emit(out: Emitter, op: number, ...rest: number[]): void {
  out.used.add(op)
  if (op >= 0x100) out.code.push(0xfc, ...uleb(op - 0x100))
  else out.code.push(op)
  out.code.push(...rest)
}

function constI32(out: Emitter, value: number): void {
  emit(out, 0x41, ...sleb(value))
}
function constI64(out: Emitter, value: bigint): void {
  emit(out, 0x42, ...sleb64(value))
}
function getLocal(out: Emitter, index: number): void {
  emit(out, 0x20, ...uleb(index))
}
function setLocal(out: Emitter, index: number): void {
  emit(out, 0x21, ...uleb(index))
}

/** An address that is certainly inside the first page. */
function address(out: Emitter, source: number): void {
  getLocal(out, source)
  constI32(out, ADDRESS_MASK)
  emit(out, 0x71) // i32.and
}

export interface GeneratedModule {
  bytes: Uint8Array
  /** The export to call. */
  entry: string
  params: readonly Type[]
  results: readonly Type[]
  /** Opcodes the module's code contains. */
  opcodes: ReadonlySet<number>
  seed: number
}

export interface GenerateOptions {
  /** Statements in the entry function. */
  statements?: number
  /** Include shapes that grow memory, which changes its size. */
  allowGrow?: boolean
}

/**
 * One pseudo-random module.
 *
 * The shape is fixed and only the contents vary: four helper functions,
 * one table, one memory, four globals, and an exported `kernel` that
 * takes one value of each type and returns an i64. Fixing the shape is
 * what lets the caller compare linear memory byte for byte without
 * first working out what the module decided to do.
 */
export function generateModule(seed: number, options: GenerateOptions = {}): GeneratedModule {
  const next = rng(seed)
  const pick = <T>(items: readonly T[]): T => items[next() % items.length]!
  const statements = options.statements ?? 60

  const used = new Set<number>()

  // Locals: the four parameters, then a pool of each type, then three
  // scratch i32s the control-flow shapes need.
  const pool: Pool = {}
  let nextLocal = 4
  const paramOf: Record<number, number> = {
    [I32]: 0, [I64]: 1, [F32]: 2, [F64]: 3,
  }
  for (const type of ALL_TYPES) {
    pool[type] = []
    for (let i = 0; i < LOCALS_PER_TYPE; i++) pool[type]!.push(nextLocal++)
  }
  const counter = nextLocal++
  const localCount = nextLocal

  const out: Emitter = { code: [], used }
  const any = (type: Type): number => pick(pool[type]!)

  // ---- Seeding, so nothing starts as a uniform zero -------------------
  for (const type of ALL_TYPES) {
    for (const local of pool[type]!) {
      switch (type) {
        case I32:
          constI32(out, pick(I32_SEEDS))
          getLocal(out, paramOf[I32]!)
          emit(out, 0x73) // i32.xor
          break
        case I64:
          constI64(out, pick(I64_SEEDS))
          getLocal(out, paramOf[I64]!)
          emit(out, 0x85) // i64.xor
          break
        case F32:
          emit(out, 0x43, ...f32Bytes(pick(F32_SEEDS)))
          getLocal(out, paramOf[F32]!)
          emit(out, 0x92) // f32.add
          break
        default:
          emit(out, 0x44, ...f64Bytes(pick(F64_SEEDS)))
          getLocal(out, paramOf[F64]!)
          emit(out, 0xa0) // f64.add
          break
      }
      setLocal(out, local)
    }
  }

  /** Pushes one operand of a type, guarded or converted as asked. */
  const operand = (type: Type, operation: Operation, position: number): void => {
    if (operation.fromInteger && position === 0) {
      // Build the value from an integer small enough that neither the
      // conversion to float nor the truncation back can be out of range.
      const source = any(I32)
      getLocal(out, source)
      constI32(out, 8)
      emit(out, operation.fromInteger === 'signed' ? 0x75 : 0x76) // shr_s / shr_u
      if (type === F32) emit(out, operation.fromInteger === 'signed' ? 0xb2 : 0xb3)
      else emit(out, operation.fromInteger === 'signed' ? 0xb7 : 0xb8)
      return
    }
    getLocal(out, any(type))
    if (operation.guardDivisor && position === 1) {
      // Positive and odd: not zero, and not the minus one that makes the
      // most negative dividend overflow.
      if (type === I32) {
        constI32(out, 0x7fff_ffff)
        emit(out, 0x71) // and
        constI32(out, 1)
        emit(out, 0x72) // or
      } else {
        constI64(out, 0x7fff_ffff_ffff_ffffn)
        emit(out, 0x83)
        constI64(out, 1n)
        emit(out, 0x84)
      }
    }
  }

  const arithmetic = (): void => {
    const operation = pick(OPERATIONS)
    operation.params.forEach((type, i) => { operand(type, operation, i) })
    emit(out, operation.op)
    setLocal(out, any(operation.result))
  }

  const loadStore = (): void => {
    if (next() % 2 === 0) {
      const [op, type, width] = pick(LOADS)
      address(out, any(I32))
      emit(out, op, ...uleb(Math.min(next() % 4, Math.log2(width))), ...uleb(next() % 8))
      setLocal(out, any(type))
    } else {
      const [op, type, width] = pick(STORES)
      address(out, any(I32))
      getLocal(out, any(type))
      emit(out, op, ...uleb(Math.min(next() % 4, Math.log2(width))), ...uleb(next() % 8))
    }
  }

  const globals = (): void => {
    const index = next() % 4
    const type = ALL_TYPES[index]!
    if (next() % 2 === 0) {
      emit(out, 0x23, ...uleb(index)) // global.get
      setLocal(out, any(type))
    } else {
      getLocal(out, any(type))
      emit(out, 0x24, ...uleb(index)) // global.set
    }
  }

  const selectOrDrop = (): void => {
    const choice = next() % 3
    if (choice === 2) {
      getLocal(out, any(pick(ALL_TYPES)))
      emit(out, 0x1a) // drop
      return
    }
    const type = pick(ALL_TYPES)
    getLocal(out, any(type))
    getLocal(out, any(type))
    getLocal(out, any(I32))
    // Two encodings of the same operation: the original, whose type is
    // inferred, and the one that carries a type vector. Both exist in
    // the wild and they are different bytes, so both are generated.
    if (choice === 0) emit(out, 0x1b)
    else emit(out, 0x1c, 0x01, type)
    setLocal(out, any(type))
  }

  const conditional = (): void => {
    const target = any(I32)
    getLocal(out, any(I32))
    constI32(out, 1)
    emit(out, 0x71) // and
    emit(out, 0x04, 0x7f) // if (result i32)
    getLocal(out, any(I32))
    constI32(out, 3)
    emit(out, 0x6a) // add
    emit(out, 0x05) // else
    getLocal(out, any(I32))
    emit(out, 0x67) // clz
    emit(out, 0x0b) // end
    setLocal(out, target)
  }

  const blockWithBranch = (): void => {
    emit(out, 0x02, 0x40) // block (void)
    getLocal(out, any(I32))
    emit(out, 0x45) // eqz
    emit(out, 0x0d, 0x00) // br_if 0
    getLocal(out, any(I32))
    constI32(out, 7)
    emit(out, 0x6c) // mul
    setLocal(out, any(I32))
    emit(out, 0x0b) // end
  }

  const countedLoop = (): void => {
    constI32(out, 1 + (next() % 5))
    setLocal(out, counter)
    emit(out, 0x02, 0x40) // block
    emit(out, 0x03, 0x40) // loop
    getLocal(out, counter)
    emit(out, 0x45) // eqz
    emit(out, 0x0d, 0x01) // br_if 1 -- leave the block
    getLocal(out, any(I64))
    constI64(out, 0x9e37_79b9_7f4a_7c15n)
    emit(out, 0x7e) // i64.mul
    setLocal(out, any(I64))
    getLocal(out, counter)
    constI32(out, 1)
    emit(out, 0x6b) // sub
    setLocal(out, counter)
    emit(out, 0x0c, 0x00) // br 0
    emit(out, 0x0b) // end loop
    emit(out, 0x0b) // end block
  }

  const table = (): void => {
    const target = any(I32)
    emit(out, 0x02, 0x40) // block: default
    emit(out, 0x02, 0x40) // block: case 1
    emit(out, 0x02, 0x40) // block: case 0
    getLocal(out, any(I32))
    constI32(out, 3)
    emit(out, 0x70) // rem_u
    emit(out, 0x0e, 0x02, 0x00, 0x01, 0x02) // br_table 0 1, default 2
    emit(out, 0x0b) // end case 0
    getLocal(out, any(I32))
    constI32(out, 11)
    emit(out, 0x6a)
    setLocal(out, target)
    emit(out, 0x0c, 0x01) // br 1 -- past the default
    emit(out, 0x0b) // end case 1
    getLocal(out, any(I32))
    constI32(out, 22)
    emit(out, 0x73) // xor
    setLocal(out, target)
    emit(out, 0x0c, 0x00) // br 0
    emit(out, 0x0b) // end default
    getLocal(out, any(I32))
    constI32(out, 33)
    emit(out, 0x6b)
    setLocal(out, target)
  }

  const calls = (): void => {
    const kind = next() % 3
    if (kind === 0) {
      getLocal(out, any(I32))
      emit(out, 0x10, 0x01) // call helperA
      setLocal(out, any(I32))
    } else if (kind === 1) {
      getLocal(out, any(I32))
      getLocal(out, any(I32))
      constI32(out, 1)
      emit(out, 0x71) // and -- a table slot that exists
      emit(out, 0x11, 0x01, 0x00) // call_indirect type 1, table 0
      setLocal(out, any(I32))
    } else {
      emit(out, 0x10, 0x03) // call helperVoid
    }
  }

  const memoryOps = (): void => {
    if (options.allowGrow && next() % 4 === 0) {
      constI32(out, next() % 2)
      emit(out, 0x40, 0x00) // memory.grow
      setLocal(out, any(I32))
    } else {
      emit(out, 0x3f, 0x00) // memory.size
      setLocal(out, any(I32))
    }
  }

  const bulk = (): void => {
    if (next() % 2 === 0) {
      address(out, any(I32)) // destination
      address(out, any(I32)) // source
      constI32(out, next() % 32)
      emit(out, 0x10a, 0x00, 0x00) // memory.copy
    } else {
      address(out, any(I32))
      getLocal(out, any(I32))
      constI32(out, next() % 32)
      emit(out, 0x10b, 0x00) // memory.fill
    }
  }

  const KINDS = [
    arithmetic, arithmetic, arithmetic, arithmetic, arithmetic,
    loadStore, loadStore, loadStore,
    globals, selectOrDrop, conditional, blockWithBranch,
    countedLoop, table, calls, memoryOps, bulk,
    () => { emit(out, 0x01) }, // nop
  ]

  for (let i = 0; i < statements; i++) pick(KINDS)()

  // ---- Epilogue: everything computed reaches memory -------------------
  //
  // Without this the comparison would only see a single returned value,
  // and a backend could get sixty statements wrong and the last one
  // right. Writing each local to a fixed address makes the whole
  // computation observable in the byte-for-byte memory check.
  let at = SCRATCH_BASE
  for (const type of ALL_TYPES) {
    for (const local of pool[type]!) {
      constI32(out, at)
      getLocal(out, local)
      emit(out, type === I32 ? 0x36 : type === I64 ? 0x37 : type === F32 ? 0x38 : 0x39,
        0x00, 0x00)
      at += 8
    }
  }
  for (let index = 0; index < 4; index++) {
    constI32(out, at)
    emit(out, 0x23, ...uleb(index))
    emit(out, index === 0 ? 0x36 : index === 1 ? 0x37 : index === 2 ? 0x38 : 0x39, 0x00, 0x00)
    at += 8
  }

  // And a single folded value, so a caller that only looks at the result
  // still sees something that depends on most of the run.
  constI64(out, 0n)
  for (const local of pool[I64]!) {
    getLocal(out, local)
    emit(out, 0x85) // xor
  }
  for (const local of pool[I32]!) {
    getLocal(out, local)
    emit(out, 0xac) // i64.extend_i32_s
    emit(out, 0x7c) // add
  }
  for (const local of pool[F64]!) {
    getLocal(out, local)
    emit(out, 0xbd) // i64.reinterpret_f64
    emit(out, 0x85) // xor
  }
  for (const local of pool[F32]!) {
    getLocal(out, local)
    emit(out, 0xbc) // i32.reinterpret_f32
    emit(out, 0xad) // i64.extend_i32_u
    emit(out, 0x85)
  }
  emit(out, 0x0f) // return
  out.code.push(0x0b) // end

  // The declared locals, in index order and with their own types. The
  // format groups them by run, and the order has to match the indices
  // the body above has already committed to.
  const declaredLocals = [
    ...uleb(5),
    ...uleb(LOCALS_PER_TYPE), I32,
    ...uleb(LOCALS_PER_TYPE), I64,
    ...uleb(LOCALS_PER_TYPE), F32,
    ...uleb(LOCALS_PER_TYPE), F64,
    ...uleb(1), I32, // the loop counter
  ]
  if (localCount !== 4 + LOCALS_PER_TYPE * 4 + 1) {
    throw new Error(`wasm generator: ${localCount} locals do not match the declaration`)
  }

  const bytes = assemble({
    declaredLocals,
    body: out.code,
    allowGrow: options.allowGrow ?? false,
  })
  return {
    bytes,
    entry: 'kernel',
    params: [I32, I64, F32, F64],
    results: [I64],
    opcodes: used,
    seed,
  }
}

interface Assembly {
  /** The locals declaration, already encoded. */
  declaredLocals: number[]
  body: number[]
  allowGrow: boolean
}

/** Wraps a generated body in the fixed module around it. */
function assemble(parts: Assembly): Uint8Array {
  const types = [
    [0x60, ...vec([[I32], [I64], [F32], [F64]]), ...vec([[I64]])], // 0: kernel
    [0x60, ...vec([[I32]]), ...vec([[I32]])],                      // 1: helper
    [0x60, ...vec([]), ...vec([])],                                // 2: void
  ]

  // helperA: x * 3 ^ (x >>> 2)
  const helperA = [
    0x00,
    0x20, 0x00, 0x41, 0x03, 0x6c,
    0x20, 0x00, 0x41, 0x02, 0x76,
    0x73,
    0x0b,
  ]
  // helperB: x - 7, and an early return so that opcode is exercised in
  // a function that is actually called both ways.
  const helperB = [
    0x00,
    0x20, 0x00, 0x41, 0x07, 0x6b,
    0x0f,
    0x0b,
  ]
  // helperVoid: bump the i32 global.
  const helperVoid = [
    0x00,
    0x23, 0x00, 0x41, 0x01, 0x6a, 0x24, 0x00,
    0x0b,
  ]

  const kernel = append([...parts.declaredLocals], parts.body)
  const maxPages = parts.allowGrow ? 4 : 1
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  append(bytes, section(1, vec(types)))
  append(bytes, section(3, vec([[0x00], [0x01], [0x01], [0x02]])))
  append(bytes, section(4, vec([append([0x70, 0x00], uleb(2))])))
  append(bytes, section(5, vec([append(append([0x01], uleb(1)), uleb(maxPages))])))
  append(bytes, section(6, vec([
    append(append([I32, 0x01, 0x41], sleb(0x1234)), [0x0b]),
    append(append([I64, 0x01, 0x42], sleb64(0x5555_aaaa_3333_ccccn)), [0x0b]),
    append(append([F32, 0x01, 0x43], f32Bytes(0x4048_f5c3)), [0x0b]),
    append(append([F64, 0x01, 0x44], f64Bytes(0x4009_21fb_5444_2d18n)), [0x0b]),
  ])))
  append(bytes, section(7, vec([
    append(append(name('kernel'), [0x00]), uleb(0)),
    append(append(name('memory'), [0x02]), uleb(0)),
  ])))
  append(bytes, section(9, vec([
    append([0x00, 0x41, 0x00, 0x0b], vec([[0x01], [0x02]])),
  ])))
  append(bytes, section(10, vec([
    withSize(kernel), withSize(helperA), withSize(helperB), withSize(helperVoid),
  ])))
  append(bytes, section(11, vec([
    append(append(append([0x00, 0x41], sleb(0x100)), [0x0b]), vec(
      Array.from({ length: 64 }, (_, i) => [(i * 37 + 11) & 0xff]),
    )),
  ])))
  return Uint8Array.from(bytes)
}

function name(text: string): number[] {
  const raw = [...new TextEncoder().encode(text)]
  return append(uleb(raw.length), raw)
}

function withSize(body: readonly number[]): number[] {
  return append(uleb(body.length), body)
}

// ---- The systematic probe --------------------------------------------

/**
 * One module that applies every operation to every pair of edge values.
 *
 * The random generator above finds that something is wrong; this finds
 * *what*. Each result goes to its own address, so a single differing
 * byte names the operation and both its operands, and the answer to
 * "which opcode is broken" is a lookup rather than a bisection.
 *
 * This is the same idea as the 6502's per-opcode vectors, and it is here
 * for the same reason: a whole-program comparison tells you that the
 * program is wrong and a per-operation one tells you why.
 */
export interface ProbeEntry {
  op: number
  address: number
  width: number
  /** Operand bit patterns, in the order the operation takes them. */
  operands: bigint[]
}

export interface OpcodeProbe {
  bytes: Uint8Array
  entry: string
  layout: readonly ProbeEntry[]
  opcodes: ReadonlySet<number>
}

function seedsFor(type: Type): bigint[] {
  switch (type) {
    case I32: return I32_SEEDS.map((v) => BigInt.asUintN(32, BigInt(v)))
    case I64: return I64_SEEDS.map((v) => BigInt.asUintN(64, v))
    case F32: return F32_SEEDS.map((v) => BigInt(v >>> 0))
    default: return F64_SEEDS.map((v) => v)
  }
}

function pushConstant(out: Emitter, type: Type, bits: bigint): void {
  switch (type) {
    case I32: emit(out, 0x41, ...sleb(Number(BigInt.asIntN(32, bits)))); return
    case I64: emit(out, 0x42, ...sleb64(BigInt.asIntN(64, bits))); return
    case F32: emit(out, 0x43, ...f32Bytes(Number(bits & 0xffff_ffffn))); return
    default: emit(out, 0x44, ...f64Bytes(bits)); return
  }
}

function widthOf(type: Type): number {
  return type === I32 || type === F32 ? 4 : 8
}
function storeOf(type: Type): number {
  return type === I32 ? 0x36 : type === I64 ? 0x37 : type === F32 ? 0x38 : 0x39
}

export function generateOpcodeProbe(): OpcodeProbe {
  const used = new Set<number>()
  const out: Emitter = { code: [], used }
  const layout: ProbeEntry[] = []
  let at = 16

  // ---- The memory accesses, swept rather than sampled ---------------
  //
  // There are twenty-three of them and they vary along three axes at
  // once -- width, signedness and the width of the result -- which is
  // exactly the shape of thing a random generator covers eventually and
  // a sweep covers now. An `i64.load16_s` that sign-extended into
  // thirty-two bits instead of sixty-four would be right for every
  // positive value and wrong for every negative one.
  //
  // Every load reads from the same three known patterns at eight
  // successive offsets, so a partial load's byte selection is covered as
  // well as its extension.
  const SOURCE = 8
  const PATTERNS = [0x0123_4567_89ab_cdefn, 0xfedc_ba98_7654_3210n, 0x8000_0000_0000_0080n]
  PATTERNS.forEach((pattern, i) => {
    emit(out, 0x41, ...sleb(SOURCE + i * 8))
    emit(out, 0x42, ...sleb64(BigInt.asIntN(64, pattern)))
    emit(out, 0x37, 0x00, 0x00) // i64.store
  })
  at = SOURCE + PATTERNS.length * 8 + 8

  for (const [op, type] of LOADS) {
    for (let offset = 0; offset < 8; offset++) {
      // Destination first, then the address to read from: a store pops
      // its value and then its address, so the address it will use has
      // to be underneath.
      emit(out, 0x41, ...sleb(at))
      emit(out, 0x41, ...sleb(SOURCE))
      emit(out, op, 0x00, ...uleb(offset))
      emit(out, storeOf(type), 0x00, 0x00)
      layout.push({ op, address: at, width: widthOf(type), operands: [BigInt(offset)] })
      at += 8
    }
  }

  // The stores need no read-back: what they wrote is in the memory the
  // comparison already covers, so the seed value and the address are the
  // whole of the case.
  for (const [op, type, width] of STORES) {
    for (const seed of seedsFor(type)) {
      emit(out, 0x41, ...sleb(at))
      pushConstant(out, type, seed)
      emit(out, op, 0x00, 0x00)
      layout.push({ op, address: at, width, operands: [seed] })
      at += 8
    }
  }

  for (const operation of OPERATIONS) {
    const lists = operation.params.map((type) => seedsFor(type))
    const counts = lists.map((list) => list.length)
    const total = counts.reduce((a, b) => a * b, 1)
    for (let index = 0; index < total; index++) {
      // Every combination, in a fixed order so the address is a
      // deterministic function of the operation and its operands.
      const chosen: bigint[] = []
      let rest = index
      for (let p = 0; p < lists.length; p++) {
        chosen.push(lists[p]![rest % counts[p]!]!)
        rest = Math.floor(rest / counts[p]!)
      }

      const width = widthOf(operation.result)
      emit(out, 0x41, ...sleb(at)) // the destination address

      operation.params.forEach((type, position) => {
        const bits = chosen[position]!
        if (operation.fromInteger && position === 0) {
          // Fed through the same narrowing the random generator uses, so
          // the trapping conversions get a value they can represent.
          emit(out, 0x41, ...sleb(Number(BigInt.asIntN(32, bits))))
          emit(out, 0x41, 0x08)
          emit(out, operation.fromInteger === 'signed' ? 0x75 : 0x76)
          if (type === F32) emit(out, operation.fromInteger === 'signed' ? 0xb2 : 0xb3)
          else emit(out, operation.fromInteger === 'signed' ? 0xb7 : 0xb8)
          return
        }
        pushConstant(out, type, bits)
        if (operation.guardDivisor && position === 1) {
          if (type === I32) {
            emit(out, 0x41, ...sleb(0x7fff_ffff)); emit(out, 0x71)
            emit(out, 0x41, 0x01); emit(out, 0x72)
          } else {
            emit(out, 0x42, ...sleb64(0x7fff_ffff_ffff_ffffn)); emit(out, 0x83)
            emit(out, 0x42, 0x01); emit(out, 0x84)
          }
        }
      })

      emit(out, operation.op)
      emit(out, storeOf(operation.result), 0x00, 0x00)
      layout.push({ op: operation.op, address: at, width, operands: chosen })
      at += 8
    }
  }
  out.code.push(0x0b) // end

  const pages = Math.ceil((at + 64) / 65536)
  const bytes = assembleProbe(out.code, pages)
  return { bytes, entry: 'probe', layout, opcodes: used }
}

function assembleProbe(body: readonly number[], pages: number): Uint8Array {
  const types = [append(append([0x60], vec([])), vec([]))]
  const code = append(vec([]), body)
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  append(bytes, section(1, vec(types)))
  append(bytes, section(3, vec([[0x00]])))
  append(bytes, section(5, vec([append([0x00], uleb(pages))])))
  append(bytes, section(7, vec([
    append(append(name('probe'), [0x00]), uleb(0)),
    append(append(name('memory'), [0x02]), uleb(0)),
  ])))
  append(bytes, section(10, vec([withSize(code)])))
  return Uint8Array.from(bytes)
}

// ---- Programs that are meant to stop ---------------------------------

/**
 * Modules that trap, one specified reason each.
 *
 * Worth having as its own set rather than folded into the random
 * generator, because a trap ends the run: a program that traps on its
 * third instruction has tested three instructions. Here that is the
 * point, so each case is as small as the thing it is checking.
 *
 * What is being checked is not that this backend refuses them -- it is
 * that it refuses *the same programs* the reference does, for the same
 * reason. A trap is a result, and an implementation that trapped on one
 * more or one fewer program than the standard requires would be wrong in
 * a way that no amount of comparing correct answers would reveal.
 */
export interface TrapCase {
  name: string
  bytes: Uint8Array
  /** The category `trapCategory` should put both engines' messages in. */
  expect: string
}

/** A module with a table, a memory, and a body under the caller's control. */
function trapModule(body: readonly number[]): Uint8Array {
  const types = [
    append(append([0x60], vec([])), vec([])),           // 0: () -> ()
    append(append([0x60], vec([[I32]])), vec([[I32]])), // 1: (i32) -> i32
  ]
  // helper(x) = x + 1
  const helper = [0x00, 0x20, 0x00, 0x41, 0x01, 0x6a, 0x0b]
  // recurse(x) = recurse(x) + 1, which never returns
  const recurse = [0x00, 0x20, 0x00, 0x10, 0x02, 0x41, 0x01, 0x6a, 0x0b]
  const probe = append(vec([]), body)

  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  append(bytes, section(1, vec(types)))
  append(bytes, section(3, vec([[0x00], [0x01], [0x01]])))
  append(bytes, section(4, vec([append([0x70, 0x00], uleb(1))])))
  append(bytes, section(5, vec([append([0x00], uleb(1))])))
  append(bytes, section(7, vec([
    append(append(name('probe'), [0x00]), uleb(0)),
    append(append(name('memory'), [0x02]), uleb(0)),
  ])))
  append(bytes, section(9, vec([append([0x00, 0x41, 0x00, 0x0b], vec([[0x01]]))])))
  append(bytes, section(10, vec([
    withSize(probe), withSize(helper), withSize(recurse),
  ])))
  return Uint8Array.from(bytes)
}

export function generateTrapCases(): TrapCase[] {
  const i32 = (value: number): number[] => append([0x41], sleb(value))
  const i64 = (value: bigint): number[] => append([0x42], sleb64(value))
  const f64 = (value: bigint): number[] => append([0x44], f64Bytes(value))
  const end = [0x0b]

  const cases: TrapCase[] = [
    {
      name: 'unreachable',
      bytes: trapModule([0x00, ...end]),
      expect: 'unreachable',
    },
    {
      name: 'i32.div_s by zero',
      bytes: trapModule([...i32(1), ...i32(0), 0x6d, 0x1a, ...end]),
      expect: 'divide-by-zero',
    },
    {
      name: 'i32.rem_u by zero',
      bytes: trapModule([...i32(1), ...i32(0), 0x70, 0x1a, ...end]),
      expect: 'divide-by-zero',
    },
    {
      name: 'i64.div_u by zero',
      bytes: trapModule([...i64(1n), ...i64(0n), 0x80, 0x1a, ...end]),
      expect: 'divide-by-zero',
    },
    {
      // The one quotient that does not fit, which is a trap rather than
      // the wrap every other overflow here gets.
      name: 'i32.div_s overflow',
      bytes: trapModule([...i32(-2147483648), ...i32(-1), 0x6d, 0x1a, ...end]),
      expect: 'overflow',
    },
    {
      name: 'i64.div_s overflow',
      bytes: trapModule([...i64(-(2n ** 63n)), ...i64(-1n), 0x7f, 0x1a, ...end]),
      expect: 'overflow',
    },
    {
      name: 'i32.trunc_f64_s of a NaN',
      bytes: trapModule([...f64(0x7ff8_0000_0000_0000n), 0xaa, 0x1a, ...end]),
      expect: 'bad-conversion',
    },
    {
      name: 'i32.trunc_f64_s out of range',
      bytes: trapModule([...f64(0x41e0_0000_0000_0000n), 0xaa, 0x1a, ...end]),
      expect: 'bad-conversion',
    },
    {
      name: 'i64.trunc_f64_u of a negative',
      bytes: trapModule([...f64(0xbff0_0000_0000_0000n), 0xb1, 0x1a, ...end]),
      expect: 'bad-conversion',
    },
    {
      name: 'load past the end of memory',
      bytes: trapModule([...i32(65533), ...[0x28, 0x00, 0x00], 0x1a, ...end]),
      expect: 'out-of-bounds',
    },
    {
      name: 'store past the end of memory',
      bytes: trapModule([...i32(65536), ...i32(1), ...[0x36, 0x00, 0x00], ...end]),
      expect: 'out-of-bounds',
    },
    {
      // The offset is added before the bounds check, so an address that
      // is itself fine can still be out of range.
      name: 'in-range address with an out-of-range offset',
      bytes: trapModule([...i32(0), ...[0x28, 0x00, ...uleb(65533)], 0x1a, ...end]),
      expect: 'out-of-bounds',
    },
    {
      name: 'memory.fill past the end',
      bytes: trapModule([...i32(65500), ...i32(0), ...i32(1000), 0xfc, 0x0b, 0x00, ...end]),
      expect: 'out-of-bounds',
    },
    {
      name: 'call_indirect through the wrong type',
      bytes: trapModule([...i32(0), 0x11, 0x00, 0x00, ...end]),
      expect: 'indirect-call',
    },
    {
      name: 'call_indirect past the end of the table',
      bytes: trapModule([...i32(0), ...i32(99), 0x11, 0x01, 0x00, 0x1a, ...end]),
      expect: 'indirect-call',
    },
    {
      name: 'recursion without a base case',
      bytes: trapModule([...i32(0), 0x10, 0x02, 0x1a, ...end]),
      expect: 'stack',
    },
    {
      // The control. Without one, a backend that trapped on everything
      // would pass every case above.
      name: 'a program that does not trap',
      bytes: trapModule([...i32(2), ...i32(3), 0x6a, 0x1a, ...end]),
      expect: '',
    },
  ]
  return cases
}

// ---- A module built to order -----------------------------------------

export interface CustomModule {
  /** Code for the exported `probe`, ending in its own `end`. */
  body: readonly number[]
  /** Declared locals, in index order. */
  localTypes?: readonly Type[]
  globalCount?: number
  memoryPages?: number
  /** A one-entry function table, for the indirect-call cases. */
  table?: boolean
}

/**
 * A module with exactly the shape a test asks for.
 *
 * The generators above make programs to *compare*; this makes programs
 * to *refuse*, which needs the opposite kind of control -- a hundred and
 * thirty globals, or a call to an import that does not exist, or an
 * opcode that is not one. Written by hand for the same reason the trap
 * cases are: each is as small as the thing it is checking.
 */
export function customModule(options: CustomModule): Uint8Array {
  const localTypes = options.localTypes ?? []
  const globalCount = options.globalCount ?? 0
  const pages = options.memoryPages ?? 1

  const types = [
    append(append([0x60], vec([])), vec([])),           // 0: () -> ()
    append(append([0x60], vec([[I32]])), vec([[I32]])), // 1: (i32) -> i32
  ]
  const helper = [0x00, 0x20, 0x00, 0x41, 0x01, 0x6a, 0x0b]

  // Locals are declared one run per entry, which is always valid and
  // keeps the indices exactly where the caller expects them.
  const declared = vec(localTypes.map((type) => [0x01, type]))
  const probe = append([...declared], options.body)

  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  append(bytes, section(1, vec(types)))
  append(bytes, section(3, vec([[0x00], [0x01]])))
  if (options.table) {
    append(bytes, section(4, vec([append([0x70, 0x00], uleb(1))])))
  }
  append(bytes, section(5, vec([append([0x00], uleb(pages))])))
  if (globalCount > 0) {
    append(bytes, section(6, vec(
      Array.from({ length: globalCount }, (_, i) =>
        append(append([I32, 0x01, 0x41], sleb(i)), [0x0b])),
    )))
  }
  append(bytes, section(7, vec([
    append(append(name('probe'), [0x00]), uleb(0)),
    append(append(name('memory'), [0x02]), uleb(0)),
  ])))
  if (options.table) {
    append(bytes, section(9, vec([append([0x00, 0x41, 0x00, 0x0b], vec([[0x01]]))])))
  }
  append(bytes, section(10, vec([withSize(probe), withSize(helper)])))
  return Uint8Array.from(bytes)
}

/** A module importing one function from a named interface. */
export function importingModule(
  moduleName: string, importName: string, body: readonly number[],
): Uint8Array {
  const types = [
    append(append([0x60], vec([])), vec([])),                    // 0: () -> ()
    append(append([0x60], vec([[I32], [I32], [I32], [I32]])), vec([[I32]])), // 1
  ]
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  append(bytes, section(1, vec(types)))
  append(bytes, section(2, vec([
    append(append(append(name(moduleName), name(importName)), [0x00]), uleb(1)),
  ])))
  append(bytes, section(3, vec([[0x00]])))
  append(bytes, section(5, vec([append([0x00], uleb(1))])))
  append(bytes, section(7, vec([
    append(append(name('probe'), [0x00]), uleb(1)),
    append(append(name('memory'), [0x02]), uleb(0)),
  ])))
  append(bytes, section(10, vec([withSize(append(vec([]), body))])))
  return Uint8Array.from(bytes)
}
