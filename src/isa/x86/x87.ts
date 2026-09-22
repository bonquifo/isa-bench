/**
 * The x87 floating-point stack, and the 80-bit format it works in.
 *
 * This exists for one reason: on x86-64 a `long double` is this format,
 * and a libc's `printf` converts through `long double` before it prints a
 * `%f`. So a program that prints a floating-point number runs x87 code,
 * even though nothing else on this target does and the compiler never
 * emits it for ordinary arithmetic.
 *
 * Two things make it unlike the other floating-point code in this project.
 *
 * **The significand's leading bit is stored.** Every other IEEE format
 * leaves the leading one implicit and infers it from the exponent. Here it
 * is bit 63 of the stored significand, which means the encoding can
 * represent values the format cannot -- an "unnormal", with a zero leading
 * bit and a non-zero exponent -- and a decoder that assumes the bit is
 * implicit reads every one of them wrongly.
 *
 * **The precision is not a property of the format.** A control-register
 * field says whether arithmetic rounds to 64, 53 or 24 significant bits,
 * and a libc changes it mid-computation. So rounding takes the precision
 * as an argument rather than reading it off the type, and `fldcw` is not
 * an instruction that can be treated as a no-op.
 *
 * Everything here is exact: values are a signed significand and an
 * exponent, arithmetic is done on those with BigInt, and rounding happens
 * once at the end. Doing it in the host's doubles would be wrong in the
 * last few bits of every operation, which is exactly the part a digit
 * generator is looking at.
 */

/** The number of significand bits the three precision settings keep. */
const PRECISION_BY_CONTROL = [24, 0, 53, 64]

/** Exponent of the least significant bit of the smallest subnormal. */
const MIN_SUBNORMAL_EXP = -16445
/** Unbiased exponent of the largest finite value. */
const MAX_EXP = 16383
const EXP_BIAS = 16383

/** Rounding modes, in the order the control word numbers them. */
export const Round87 = { NEAREST: 0, DOWN: 1, UP: 2, ZERO: 3 } as const

export type Kind = 'finite' | 'zero' | 'inf' | 'nan'

/** A value on the stack, held exactly rather than as an encoding. */
export interface X87Value {
  kind: Kind
  /** 1 or -1. Meaningful for every kind but nan, where it is carried. */
  sign: number
  /** Unsigned significand for 'finite'; the payload for 'nan'. */
  m: bigint
  /** Exponent of the least significant bit of `m`. */
  e: number
}

export const ZERO: X87Value = { kind: 'zero', sign: 1, m: 0n, e: 0 }
export const INDEFINITE: X87Value = {
  kind: 'nan', sign: -1, m: 0xc000000000000000n, e: 0,
}

export function makeFinite(sign: number, m: bigint, e: number): X87Value {
  if (m === 0n) return { kind: 'zero', sign, m: 0n, e: 0 }
  return { kind: 'finite', sign, m, e }
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length
}

/**
 * Decodes the 80-bit encoding.
 *
 * The leading significand bit is stored rather than implied, so a value
 * whose exponent says "normal" but whose leading bit is clear is not a
 * number this format defines. Those are reported as NaN rather than
 * silently normalised, because pretending to read them would be inventing
 * a value.
 */
export function decode80(low: bigint, high: bigint): X87Value {
  const sign = (high & 0x8000n) !== 0n ? -1 : 1
  const exponent = Number(high & 0x7fffn)
  const significand = low & 0xffffffffffffffffn
  if (exponent === 0x7fff) {
    const withoutLeading = significand & 0x7fffffffffffffffn
    if (withoutLeading === 0n && (significand & 0x8000000000000000n) !== 0n) {
      return { kind: 'inf', sign, m: 0n, e: 0 }
    }
    return { kind: 'nan', sign, m: significand, e: 0 }
  }
  if (significand === 0n) {
    return exponent === 0 ? { kind: 'zero', sign, m: 0n, e: 0 } : INDEFINITE
  }
  if (exponent === 0) {
    // Subnormal: the exponent is the smallest normal one, not zero.
    return { kind: 'finite', sign, m: significand, e: -EXP_BIAS - 62 }
  }
  if ((significand & 0x8000000000000000n) === 0n) return INDEFINITE
  return { kind: 'finite', sign, m: significand, e: exponent - EXP_BIAS - 63 }
}

/** Encodes back, as the low 64 bits and the high 16. */
export function encode80(value: X87Value): { low: bigint; high: bigint } {
  const signBit = value.sign < 0 ? 0x8000n : 0n
  if (value.kind === 'zero') return { low: 0n, high: signBit }
  if (value.kind === 'inf') return { low: 0x8000000000000000n, high: signBit | 0x7fffn }
  if (value.kind === 'nan') return { low: value.m, high: signBit | 0x7fffn }

  // Line the significand up so its leading bit sits at bit 63.
  const shift = 64 - bitLength(value.m)
  let m = value.m << BigInt(shift)
  let exponent = value.e - shift + 63 + EXP_BIAS
  if (exponent <= 0) {
    // Subnormal, which this format stores with a zero exponent field and
    // whatever is left of the significand after shifting it down.
    const down = 1 - exponent
    if (down >= 64) return { low: 0n, high: signBit }
    m >>= BigInt(down)
    exponent = 0
  }
  if (exponent >= 0x7fff) return { low: 0x8000000000000000n, high: signBit | 0x7fffn }
  return { low: m & 0xffffffffffffffffn, high: signBit | BigInt(exponent) }
}

/** The precision the control word asks for, in significand bits. */
export function precisionOf(control: number): number {
  return PRECISION_BY_CONTROL[(control >> 8) & 3] || 64
}

export function roundingOf(control: number): number {
  return (control >> 10) & 3
}

/**
 * Rounds an exact value to the given precision.
 *
 * `sticky` says whether bits below `m` were discarded on the way in, which
 * a division cannot avoid and which changes a tie into a not-tie.
 */
export function round87(
  sign: number,
  m: bigint,
  e: number,
  precision: number,
  mode: number,
  sticky = false,
): X87Value {
  if (m === 0n) return { kind: 'zero', sign, m: 0n, e: 0 }
  const length = bitLength(m)
  // Whichever demand is stricter wins: keeping `precision` significant
  // bits, or not going below the format's fixed floor.
  const shift = Math.max(length - precision, MIN_SUBNORMAL_EXP - e)
  let value = m
  let exponent = e
  if (shift > 0) {
    const dropped = m & ((1n << BigInt(shift)) - 1n)
    value = m >> BigInt(shift)
    exponent = e + shift
    const half = 1n << BigInt(shift - 1)
    const anyBelow = (dropped & (half - 1n)) !== 0n || sticky
    const roundUp = decideRound(mode, sign, dropped >= half, dropped === half && !anyBelow,
      (dropped & ~half) !== 0n || sticky, (value & 1n) === 1n)
    if (roundUp) value += 1n
  } else if (shift < 0) {
    value = m << BigInt(-shift)
    exponent = e + shift
    if (sticky && roundsAwayOnSticky(mode, sign)) value += 1n
  } else if (sticky && roundsAwayOnSticky(mode, sign)) {
    value += 1n
  }

  if (value === 0n) return { kind: 'zero', sign, m: 0n, e: 0 }
  // Rounding up can carry into an extra bit, which costs an exponent.
  if (bitLength(value) > precision && (value & 1n) === 0n) {
    value >>= 1n
    exponent += 1
  }
  const topExponent = exponent + bitLength(value) - 1
  if (topExponent > MAX_EXP) {
    return overflowResult(mode, sign)
  }
  return { kind: 'finite', sign, m: value, e: exponent }
}

function roundsAwayOnSticky(mode: number, sign: number): boolean {
  if (mode === Round87.UP) return sign > 0
  if (mode === Round87.DOWN) return sign < 0
  return false
}

function decideRound(
  mode: number,
  sign: number,
  atLeastHalf: boolean,
  exactlyHalf: boolean,
  anythingDropped: boolean,
  oddKept: boolean,
): boolean {
  switch (mode) {
    case Round87.NEAREST:
      if (!atLeastHalf) return false
      // A tie goes to the even neighbour; anything above a tie goes up.
      return exactlyHalf ? oddKept : true
    case Round87.ZERO:
      return false
    case Round87.UP:
      return sign > 0 && (atLeastHalf || anythingDropped)
    default:
      return sign < 0 && (atLeastHalf || anythingDropped)
  }
}

/** What an overflow becomes, which the rounding mode decides. */
function overflowResult(mode: number, sign: number): X87Value {
  const towardZero = mode === Round87.ZERO ||
    (mode === Round87.UP && sign < 0) ||
    (mode === Round87.DOWN && sign > 0)
  if (!towardZero) return { kind: 'inf', sign, m: 0n, e: 0 }
  // The largest finite value, which is what rounding towards zero gives.
  return { kind: 'finite', sign, m: (1n << 64n) - 1n, e: MAX_EXP - 63 }
}

const isNan = (v: X87Value): boolean => v.kind === 'nan'

/** Propagates a NaN operand, or returns null when neither is one. */
function propagate(a: X87Value, b: X87Value): X87Value | null {
  if (isNan(a) && isNan(b)) {
    // The one with the larger payload wins; a tie goes to the first.
    return b.m > a.m ? quiet(b) : quiet(a)
  }
  if (isNan(a)) return quiet(a)
  if (isNan(b)) return quiet(b)
  return null
}

function quiet(v: X87Value): X87Value {
  return { ...v, m: v.m | 0x4000000000000000n }
}

export function add87(
  a: X87Value,
  b: X87Value,
  precision: number,
  mode: number,
): X87Value {
  const nan = propagate(a, b)
  if (nan) return nan
  if (a.kind === 'inf' && b.kind === 'inf') {
    return a.sign === b.sign ? a : INDEFINITE
  }
  if (a.kind === 'inf') return a
  if (b.kind === 'inf') return b
  if (a.kind === 'zero' && b.kind === 'zero') {
    // Two zeroes give a negative zero only when both are negative, except
    // when rounding down, where the sum of opposite zeroes is negative.
    if (a.sign === b.sign) return a
    return { kind: 'zero', sign: mode === Round87.DOWN ? -1 : 1, m: 0n, e: 0 }
  }
  if (a.kind === 'zero') return round87(b.sign, b.m, b.e, precision, mode)
  if (b.kind === 'zero') return round87(a.sign, a.m, a.e, precision, mode)

  const e = Math.min(a.e, b.e)
  const sum = BigInt(a.sign) * (a.m << BigInt(a.e - e)) +
    BigInt(b.sign) * (b.m << BigInt(b.e - e))
  if (sum === 0n) {
    return { kind: 'zero', sign: mode === Round87.DOWN ? -1 : 1, m: 0n, e: 0 }
  }
  const sign = sum < 0n ? -1 : 1
  return round87(sign, sum < 0n ? -sum : sum, e, precision, mode)
}

export function negate(v: X87Value): X87Value {
  if (v.kind === 'nan') return v
  return { ...v, sign: -v.sign }
}

export function mul87(
  a: X87Value,
  b: X87Value,
  precision: number,
  mode: number,
): X87Value {
  const nan = propagate(a, b)
  if (nan) return nan
  const sign = a.sign * b.sign
  if (a.kind === 'inf' || b.kind === 'inf') {
    if (a.kind === 'zero' || b.kind === 'zero') return INDEFINITE
    return { kind: 'inf', sign, m: 0n, e: 0 }
  }
  if (a.kind === 'zero' || b.kind === 'zero') {
    return { kind: 'zero', sign, m: 0n, e: 0 }
  }
  return round87(sign, a.m * b.m, a.e + b.e, precision, mode)
}

export function div87(
  a: X87Value,
  b: X87Value,
  precision: number,
  mode: number,
): { value: X87Value; dividedByZero: boolean } {
  const nan = propagate(a, b)
  if (nan) return { value: nan, dividedByZero: false }
  const sign = a.sign * b.sign
  if (a.kind === 'inf' && b.kind === 'inf') {
    return { value: INDEFINITE, dividedByZero: false }
  }
  if (a.kind === 'inf') return { value: { kind: 'inf', sign, m: 0n, e: 0 }, dividedByZero: false }
  if (b.kind === 'inf') return { value: { kind: 'zero', sign, m: 0n, e: 0 }, dividedByZero: false }
  if (b.kind === 'zero') {
    if (a.kind === 'zero') return { value: INDEFINITE, dividedByZero: false }
    return { value: { kind: 'inf', sign, m: 0n, e: 0 }, dividedByZero: true }
  }
  if (a.kind === 'zero') {
    return { value: { kind: 'zero', sign, m: 0n, e: 0 }, dividedByZero: false }
  }

  // Enough quotient bits to round by: the precision, a guard bit, and a
  // sticky bit standing for everything below it.
  const wanted = precision + 2
  const shift = wanted - (bitLength(a.m) - bitLength(b.m))
  const scaled = shift > 0 ? a.m << BigInt(shift) : a.m >> BigInt(-shift)
  const quotient = scaled / b.m
  const remainder = scaled % b.m
  const exponent = a.e - b.e - shift
  return {
    value: round87(sign, quotient, exponent, precision, mode, remainder !== 0n),
    dividedByZero: false,
  }
}

/** -1, 0, 1, or null when the two are unordered. */
export function compare87(a: X87Value, b: X87Value): number | null {
  if (isNan(a) || isNan(b)) return null
  if (a.kind === 'inf' && b.kind === 'inf') return a.sign === b.sign ? 0 : (a.sign > 0 ? 1 : -1)
  if (a.kind === 'inf') return a.sign > 0 ? 1 : -1
  if (b.kind === 'inf') return b.sign > 0 ? -1 : 1
  const azero = a.kind === 'zero'
  const bzero = b.kind === 'zero'
  if (azero && bzero) return 0
  if (azero) return b.sign > 0 ? -1 : 1
  if (bzero) return a.sign > 0 ? 1 : -1
  if (a.sign !== b.sign) return a.sign > 0 ? 1 : -1
  const e = Math.min(a.e, b.e)
  const am = a.m << BigInt(a.e - e)
  const bm = b.m << BigInt(b.e - e)
  if (am === bm) return 0
  const bigger = am > bm ? 1 : -1
  return a.sign > 0 ? bigger : -bigger
}

/** Converts a two's-complement integer of any width into a value. */
export function fromInteger(value: bigint): X87Value {
  if (value === 0n) return ZERO
  const sign = value < 0n ? -1 : 1
  return { kind: 'finite', sign, m: value < 0n ? -value : value, e: 0 }
}

/**
 * Converts to an integer of `bits` width, rounding as the control word
 * says. Returns null when the value does not fit, which the caller turns
 * into the "integer indefinite" the architecture stores instead.
 */
export function toInteger(v: X87Value, bits: number, mode: number): bigint | null {
  if (v.kind === 'nan' || v.kind === 'inf') return null
  if (v.kind === 'zero') return 0n
  let magnitude: bigint
  if (v.e >= 0) {
    magnitude = v.m << BigInt(v.e)
  } else {
    const shift = BigInt(-v.e)
    const whole = v.m >> shift
    const fraction = v.m & ((1n << shift) - 1n)
    magnitude = whole
    if (fraction !== 0n) {
      const half = 1n << (shift - 1n)
      const up = decideRound(mode, v.sign, fraction >= half,
        fraction === half, fraction !== 0n, (whole & 1n) === 1n)
      if (up) magnitude += 1n
    }
  }
  const result = v.sign < 0 ? -magnitude : magnitude
  const limit = 1n << BigInt(bits - 1)
  if (result >= limit || result < -limit) return null
  return result
}

/** The 32- and 64-bit IEEE formats, as seen from here. */
export function fromIeee(bits: bigint, width: number): X87Value {
  const exponentBits = width === 4 ? 8 : 11
  const fractionBits = width === 4 ? 23 : 52
  const bias = width === 4 ? 127 : 1023
  const sign = (bits >> BigInt(width * 8 - 1)) === 1n ? -1 : 1
  const exponent = Number((bits >> BigInt(fractionBits)) & ((1n << BigInt(exponentBits)) - 1n))
  const fraction = bits & ((1n << BigInt(fractionBits)) - 1n)
  if (exponent === (1 << exponentBits) - 1) {
    if (fraction === 0n) return { kind: 'inf', sign, m: 0n, e: 0 }
    // Widening a NaN keeps its payload in the top of the new significand.
    const payload = (fraction << BigInt(63 - fractionBits)) | 0x8000000000000000n
    return { kind: 'nan', sign, m: payload, e: 0 }
  }
  if (exponent === 0) {
    if (fraction === 0n) return { kind: 'zero', sign, m: 0n, e: 0 }
    return { kind: 'finite', sign, m: fraction, e: 1 - bias - fractionBits }
  }
  return {
    kind: 'finite',
    sign,
    m: fraction | (1n << BigInt(fractionBits)),
    e: exponent - bias - fractionBits,
  }
}

export function toIeee(v: X87Value, width: number, mode: number): bigint {
  const exponentBits = width === 4 ? 8 : 11
  const fractionBits = width === 4 ? 23 : 52
  const bias = width === 4 ? 127 : 1023
  const signBit = v.sign < 0 ? 1n << BigInt(width * 8 - 1) : 0n
  const allOnes = (1n << BigInt(exponentBits)) - 1n
  if (v.kind === 'nan') {
    const payload = (v.m & 0x7fffffffffffffffn) >> BigInt(63 - fractionBits)
    return signBit | (allOnes << BigInt(fractionBits)) |
      (payload === 0n ? 1n << BigInt(fractionBits - 1) : payload)
  }
  if (v.kind === 'inf') return signBit | (allOnes << BigInt(fractionBits))
  if (v.kind === 'zero') return signBit

  const minSubnormal = 1 - bias - fractionBits
  const maxExponent = bias
  const rounded = roundToWidth(v, fractionBits + 1, minSubnormal, maxExponent, mode)
  if (rounded.kind === 'inf') return signBit | (allOnes << BigInt(fractionBits))
  if (rounded.kind === 'zero') return signBit

  const m = rounded.m
  const e = rounded.e
  // Whether the result is normal is a question about the value, not about
  // how many bits the significand happens to have: it is normal when its
  // leading bit sits at or above the format's smallest normal exponent.
  const leading = e + bitLength(m) - 1
  if (leading < 1 - bias) {
    // Subnormal. The exponent field is zero and the significand is written
    // at the fixed scale the format reserves for this case, with no
    // implicit leading one to remove.
    const shift = e - minSubnormal
    const fraction = shift >= 0 ? m << BigInt(shift) : m >> BigInt(-shift)
    return signBit | (fraction & ((1n << BigInt(fractionBits)) - 1n))
  }
  // Normal. Line the significand up so its leading bit is the implicit
  // one, which sits just above the stored fraction.
  const align = fractionBits - (leading - e)
  const aligned = align >= 0 ? m << BigInt(align) : m >> BigInt(-align)
  const biased = leading + bias
  if (biased >= (1 << exponentBits) - 1) return signBit | (allOnes << BigInt(fractionBits))
  return signBit | (BigInt(biased) << BigInt(fractionBits)) |
    (aligned & ((1n << BigInt(fractionBits)) - 1n))
}

/** Rounding to a narrower format, with that format's own exponent range. */
function roundToWidth(
  v: X87Value,
  precision: number,
  minExp: number,
  maxExp: number,
  mode: number,
): X87Value {
  const length = bitLength(v.m)
  const shift = Math.max(length - precision, minExp - v.e)
  let m = v.m
  let e = v.e
  if (shift > 0) {
    const dropped = v.m & ((1n << BigInt(shift)) - 1n)
    m = v.m >> BigInt(shift)
    e = v.e + shift
    const half = 1n << BigInt(shift - 1)
    const up = decideRound(mode, v.sign, dropped >= half, dropped === half,
      dropped !== 0n, (m & 1n) === 1n)
    if (up) m += 1n
  }
  if (m === 0n) return { kind: 'zero', sign: v.sign, m: 0n, e: 0 }
  if (e + bitLength(m) - 1 > maxExp) {
    return overflowResult(mode, v.sign)
  }
  return { kind: 'finite', sign: v.sign, m, e }
}

/**
 * The register stack.
 *
 * It is a stack rather than a register file, and the numbering is relative
 * to a top that instructions move. Resolving st(i) to a physical register
 * is therefore something only the interpreter can do, which is why the
 * timing model sees the whole stack as one resource.
 */
export class X87Stack {
  private readonly slots: (X87Value | null)[] = Array.from({ length: 8 }, () => null)
  private top = 0
  /** The control word, which is the default Linux one until a guest sets it. */
  control = 0x037f

  reset(): void {
    for (let i = 0; i < 8; i++) this.slots[i] = null
    this.top = 0
    this.control = 0x037f
  }

  get precision(): number {
    return precisionOf(this.control)
  }

  get rounding(): number {
    return roundingOf(this.control)
  }

  /** st(i), or null when that slot is empty. */
  get(i: number): X87Value | null {
    return this.slots[(this.top + i) & 7]!
  }

  set(i: number, value: X87Value): void {
    this.slots[(this.top + i) & 7] = value
  }

  push(value: X87Value): void {
    this.top = (this.top - 1) & 7
    this.slots[this.top] = value
  }

  pop(): void {
    this.slots[this.top] = null
    this.top = (this.top + 1) & 7
  }

  /** For the state dump: the stack in physical order, plus the top index. */
  snapshot(): { slots: readonly (X87Value | null)[]; top: number } {
    return { slots: this.slots, top: this.top }
  }
}
