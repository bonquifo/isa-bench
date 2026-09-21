/**
 * IEEE-754 support for the real-ISA interpreters.
 *
 * Floating-point registers hold raw bit patterns, never JavaScript numbers.
 * A number cannot distinguish a quiet NaN from a signalling one, and every
 * NaN compares unequal to itself, so a register file of numbers would lose
 * exactly the state the differential comparison is checking.
 *
 * Two things here are not available from the host and have to be built:
 *
 *   fused multiply-add, which JavaScript has no primitive for. Computing
 *   a * b + c with two roundings is a different function from computing it
 *   with one, and clang emits the fused form at -O2, so the exact product is
 *   formed with bigint arithmetic and rounded once.
 *
 *   correctly rounded conversion to an arbitrary binary format, used by the
 *   same path for single precision.
 */

const SCRATCH = new DataView(new ArrayBuffer(8))

/** The quiet NaN every arithmetic operation produces on RISC-V. */
export const CANONICAL_NAN_D = 0x7ff8000000000000n
export const CANONICAL_NAN_S = 0x7fc00000

export function bitsToF64(bits: bigint): number {
  SCRATCH.setBigUint64(0, BigInt.asUintN(64, bits))
  return SCRATCH.getFloat64(0)
}

export function f64ToBits(value: number): bigint {
  SCRATCH.setFloat64(0, value)
  return SCRATCH.getBigUint64(0)
}

export function bitsToF32(bits: number): number {
  SCRATCH.setUint32(0, bits >>> 0)
  return SCRATCH.getFloat32(0)
}

export function f32ToBits(value: number): number {
  SCRATCH.setFloat32(0, value)
  return SCRATCH.getUint32(0)
}

export interface FloatFormat {
  /** Significand bits including the implicit one. */
  readonly precision: number
  /** Exponent of the least significant bit of the smallest subnormal. */
  readonly minSubnormalExp: number
  /** Unbiased exponent of the smallest normal value; below this is subnormal. */
  readonly minNormalExp: number
  /** Unbiased exponent of the largest finite value; above this is infinity. */
  readonly maxExp: number
}

export const F64: FloatFormat = {
  precision: 53, minSubnormalExp: -1074, minNormalExp: -1022, maxExp: 1023,
}
export const F32: FloatFormat = {
  precision: 24, minSubnormalExp: -149, minNormalExp: -126, maxExp: 127,
}

/** A finite value decomposed exactly: significand * 2^exponent. */
export interface Decomposed {
  kind: 'finite' | 'zero' | 'inf' | 'nan'
  /** Signed significand for 'finite'; zero otherwise. */
  m: bigint
  e: number
  /** 1 or -1; meaningful for every kind except nan. */
  sign: number
}

export function decomposeF64(bits: bigint): Decomposed {
  const raw = BigInt.asUintN(64, bits)
  const sign = (raw >> 63n) === 1n ? -1 : 1
  const exponent = Number((raw >> 52n) & 0x7ffn)
  const fraction = raw & 0xfffffffffffffn
  if (exponent === 0x7ff) {
    return { kind: fraction === 0n ? 'inf' : 'nan', m: 0n, e: 0, sign }
  }
  if (exponent === 0) {
    if (fraction === 0n) return { kind: 'zero', m: 0n, e: 0, sign }
    return { kind: 'finite', m: BigInt(sign) * fraction, e: -1074, sign }
  }
  return {
    kind: 'finite',
    m: BigInt(sign) * (fraction | 0x10000000000000n),
    e: exponent - 1075,
    sign,
  }
}

function bitLength(value: bigint): number {
  // Cheap for the magnitudes involved; the alternative is a loop per bit.
  return value === 0n ? 0 : value.toString(2).length
}

/**
 * Rounds the exact value `m * 2^e` to the nearest representable value in
 * `format`, ties to even, and returns it as a JavaScript number.
 *
 * `zeroSign` gives the sign to use when the exact value is zero, which IEEE
 * specifies separately: a sum that cancels exactly is +0 under round-to-nearest
 * regardless of the signs that produced it.
 */
export function roundExact(m: bigint, e: number, format: FloatFormat, zeroSign: number): number {
  if (m === 0n) return zeroSign < 0 ? -0 : 0
  const negative = m < 0n
  let mag = negative ? -m : m
  const length = bitLength(mag)

  // Where the least significant kept bit sits. A normal result keeps
  // `precision` significant bits; a subnormal one keeps whatever survives
  // above the format's fixed floor. Whichever demand is stricter wins, and
  // taking the larger shift selects the right case without a branch: above
  // the normal/subnormal boundary the precision demand is larger, below it
  // the floor is.
  const normalShift = length - format.precision
  const subnormalShift = format.minSubnormalExp - e
  const shift = Math.max(normalShift, subnormalShift)

  let exponent = e
  if (shift > 0) {
    const dropped = mag & ((1n << BigInt(shift)) - 1n)
    const half = 1n << BigInt(shift - 1)
    mag >>= BigInt(shift)
    if (dropped > half || (dropped === half && (mag & 1n) === 1n)) mag += 1n
    exponent = e + shift
  } else if (shift < 0) {
    mag <<= BigInt(-shift)
    exponent = e + shift
  }

  if (mag === 0n) return negative ? -0 : 0
  // The format's exponent ceiling has to be applied explicitly. Rounding to
  // the right number of significand bits says nothing about range, and for a
  // narrower format than the host's the out-of-range value is still a
  // perfectly ordinary double — which would silently look like a finite
  // result that merely rounded, rather than an overflow.
  if (bitLength(mag) - 1 + exponent > format.maxExp) return negative ? -Infinity : Infinity
  const scaled = Number(mag) * 2 ** exponent
  return negative ? -scaled : scaled
}

export function isNan64(bits: bigint): boolean {
  const raw = BigInt.asUintN(64, bits)
  return (raw & 0x7ff0000000000000n) === 0x7ff0000000000000n && (raw & 0xfffffffffffffn) !== 0n
}

/** A NaN whose most significant fraction bit is clear signals on every use. */
export function isSignaling64(bits: bigint): boolean {
  return isNan64(bits) && (BigInt.asUintN(64, bits) & 0x8000000000000n) === 0n
}

export function isNan32(bits: number): boolean {
  const raw = bits >>> 0
  return (raw & 0x7f800000) === 0x7f800000 && (raw & 0x7fffff) !== 0
}

export function isSignaling32(bits: number): boolean {
  return isNan32(bits) && ((bits >>> 0) & 0x400000) === 0
}

/**
 * Exact fused multiply-add: one rounding, as IEEE 754 specifies and as the
 * hardware instruction performs. Operands arrive as double bit patterns —
 * every single is exactly a double, so the single-precision form widens its
 * inputs losslessly and differs only in the format it rounds to.
 *
 * Returns null where the result is a NaN, leaving the caller to supply the
 * canonical pattern for its format. Special cases follow RISC-V: multiplying
 * zero by infinity is invalid whatever the addend is, and an infinite product
 * plus the opposite infinity is invalid too.
 */
export function fusedMulAdd(
  aBits: bigint,
  bBits: bigint,
  cBits: bigint,
  format: FloatFormat,
): number | null {
  const a = decomposeF64(aBits)
  const b = decomposeF64(bBits)
  const c = decomposeF64(cBits)
  if (a.kind === 'nan' || b.kind === 'nan' || c.kind === 'nan') return null

  const productSign = a.sign * b.sign
  const productIsInf = a.kind === 'inf' || b.kind === 'inf'
  const productIsZero = a.kind === 'zero' || b.kind === 'zero'
  if (productIsInf && productIsZero) return null
  if (productIsInf) {
    if (c.kind === 'inf' && c.sign !== productSign) return null
    return productSign < 0 ? -Infinity : Infinity
  }
  if (c.kind === 'inf') return c.sign < 0 ? -Infinity : Infinity

  if (productIsZero && c.kind === 'zero') {
    // Two zeroes: the result is negative only when both agree that it is.
    return productSign === c.sign && productSign < 0 ? -0 : 0
  }
  if (productIsZero) return roundExact(c.m, c.e, format, c.sign)

  const pm = a.m * b.m
  const pe = a.e + b.e
  if (c.kind === 'zero') return roundExact(pm, pe, format, productSign)

  const exponent = Math.min(pe, c.e)
  const sum = (pm << BigInt(pe - exponent)) + (c.m << BigInt(c.e - exponent))
  // An exact cancellation to zero is +0 under round-to-nearest.
  return roundExact(sum, exponent, format, 1)
}

/** The five rounding modes a RISC-V instruction can name. */
export const RoundMode = {
  RNE: 0,
  RTZ: 1,
  RDN: 2,
  RUP: 3,
  RMM: 4,
  DYN: 7,
} as const

/**
 * Rounds a finite double to an integral double under the given mode. Used by
 * float-to-integer conversion, where the rounding happens before the range
 * check rather than after.
 */
export function roundToIntegral(value: number, mode: number): number {
  switch (mode) {
    case RoundMode.RTZ:
      return Math.trunc(value)
    case RoundMode.RDN:
      return Math.floor(value)
    case RoundMode.RUP:
      return Math.ceil(value)
    case RoundMode.RMM: {
      const floor = Math.floor(value)
      const fraction = value - floor
      if (fraction > 0.5) return floor + 1
      if (fraction < 0.5) return floor
      return value < 0 ? floor : floor + 1
    }
    default: {
      // Round to nearest, ties to even.
      const floor = Math.floor(value)
      const fraction = value - floor
      if (fraction > 0.5) return floor + 1
      if (fraction < 0.5) return floor
      return floor % 2 === 0 ? floor : floor + 1
    }
  }
}

/** RISC-V fclass: a one-hot classification of a double. */
export function classifyF64(bits: bigint): bigint {
  const d = decomposeF64(bits)
  if (d.kind === 'nan') {
    // Bit 51 of the fraction distinguishes quiet from signalling.
    const quiet = (BigInt.asUintN(64, bits) & 0x8000000000000n) !== 0n
    return quiet ? 512n : 256n
  }
  if (d.kind === 'inf') return d.sign < 0 ? 1n : 128n
  if (d.kind === 'zero') return d.sign < 0 ? 8n : 16n
  const subnormal = d.e === -1074 && (d.m < 0n ? -d.m : d.m) < 0x10000000000000n
  if (d.sign < 0) return subnormal ? 4n : 2n
  return subnormal ? 32n : 64n
}

/** RISC-V fclass for a single, given its 32-bit pattern. */
export function classifyF32(bits: number): bigint {
  const raw = bits >>> 0
  const exponent = (raw >>> 23) & 0xff
  const fraction = raw & 0x7fffff
  const negative = (raw >>> 31) === 1
  if (exponent === 0xff) {
    if (fraction === 0) return negative ? 1n : 128n
    return (fraction & 0x400000) !== 0 ? 512n : 256n
  }
  if (exponent === 0) {
    if (fraction === 0) return negative ? 8n : 16n
    return negative ? 4n : 32n
  }
  return negative ? 2n : 64n
}

/**
 * Unpacks a single from a floating-point register.
 *
 * RV64 keeps singles NaN-boxed: the upper 32 bits must be all ones. A register
 * holding anything else is not a valid single, and the architecture requires
 * reading it as the canonical single NaN rather than as its low half.
 */
export function unboxSingle(bits: bigint): number {
  const raw = BigInt.asUintN(64, bits)
  if ((raw >> 32n) !== 0xffffffffn) return CANONICAL_NAN_S
  return Number(raw & 0xffffffffn) >>> 0
}

/** Boxes a single for storage in a 64-bit floating-point register. */
export function boxSingle(bits: number): bigint {
  return 0xffffffff00000000n | BigInt(bits >>> 0)
}

// ---------------------------------------------------------------------------
// IEEE exception status.
//
// The inexact, overflow and underflow flags are architectural state: a guest
// can read them through fcsr, and qemu's trace shows them being read. They
// are also the one part of floating point the host cannot report — JavaScript
// gives no access to the FPU status word — so they are recomputed here from
// the exact result.
//
// "Underflow" follows IEEE's tininess-after-rounding rule, which asks whether
// the result would be subnormal had the exponent range been unbounded. That
// is not the same question as whether the delivered result is subnormal, and
// the two differ for a value just below the smallest normal that rounds up to
// it. Rounding with the subnormal floor removed answers the right question.
// ---------------------------------------------------------------------------

export interface Exact {
  m: bigint
  e: number
}

export interface RoundingStatus {
  inexact: boolean
  overflow: boolean
  underflow: boolean
}

export const NO_STATUS: RoundingStatus = { inexact: false, overflow: false, underflow: false }

/** The exact value of a float, or null when it is not finite. */
export function exactOf(bits: bigint): Exact | null {
  const d = decomposeF64(bits)
  if (d.kind === 'inf' || d.kind === 'nan') return null
  if (d.kind === 'zero') return { m: 0n, e: 0 }
  return { m: d.m, e: d.e }
}

/** Compares two exact values given as significand and exponent. */
function sameValue(a: Exact, b: Exact): boolean {
  if (a.m === 0n || b.m === 0n) return a.m === b.m
  const e = Math.min(a.e, b.e)
  return (a.m << BigInt(a.e - e)) === (b.m << BigInt(b.e - e))
}

function bitLengthOf(value: bigint): number {
  const magnitude = value < 0n ? -value : value
  return magnitude === 0n ? 0 : magnitude.toString(2).length
}

/**
 * Whether `exact` would land below the format's smallest normal if it were
 * rounded to `precision` bits with no exponent limit. This is IEEE's
 * "tiny after rounding".
 */
function tinyAfterRounding(exact: Exact, format: FloatFormat): boolean {
  if (exact.m === 0n) return false
  const magnitude = exact.m < 0n ? -exact.m : exact.m
  const length = bitLengthOf(magnitude)
  const shift = length - format.precision
  let mantissa = magnitude
  let exponent = exact.e
  if (shift > 0) {
    const dropped = magnitude & ((1n << BigInt(shift)) - 1n)
    const half = 1n << BigInt(shift - 1)
    mantissa >>= BigInt(shift)
    if (dropped > half || (dropped === half && (mantissa & 1n) === 1n)) mantissa += 1n
    exponent += shift
  }
  return bitLengthOf(mantissa) - 1 + exponent < format.minNormalExp
}

/**
 * Status for an operation whose exact result is known. `exact` being null
 * means an infinite or NaN operand, where no rounding took place.
 */
export function statusOf(
  exact: Exact | null,
  rounded: number,
  format: FloatFormat,
): RoundingStatus {
  if (exact === null || Number.isNaN(rounded)) return NO_STATUS
  if (!Number.isFinite(rounded)) {
    // The exact value was finite and the delivered one is not: that is
    // overflow, and overflow is always inexact too.
    return { inexact: true, overflow: true, underflow: false }
  }
  const delivered = exactOf(f64ToBits(rounded))!
  if (sameValue(exact, delivered)) return NO_STATUS
  return { inexact: true, overflow: false, underflow: tinyAfterRounding(exact, format) }
}

/** The exact sum of two finite floats. */
export function exactSum(aBits: bigint, bBits: bigint): Exact | null {
  const a = exactOf(aBits)
  const b = exactOf(bBits)
  if (a === null || b === null) return null
  const e = Math.min(a.e, b.e)
  return { m: (a.m << BigInt(a.e - e)) + (b.m << BigInt(b.e - e)), e }
}

/** The exact product of two finite floats. */
export function exactProduct(aBits: bigint, bBits: bigint): Exact | null {
  const a = exactOf(aBits)
  const b = exactOf(bBits)
  if (a === null || b === null) return null
  return { m: a.m * b.m, e: a.e + b.e }
}

/**
 * Status for division, where the exact quotient generally has no finite
 * binary expansion and so cannot be handed to `statusOf`.
 *
 * Exactness is decided by multiplying back: the quotient is exact precisely
 * when the delivered result times the divisor reproduces the dividend.
 * Tininess is decided by comparing the dividend against the divisor scaled to
 * the smallest normal, which is the same question one multiplication earlier.
 */
export function quotientStatus(
  aBits: bigint,
  bBits: bigint,
  rounded: number,
  format: FloatFormat,
): RoundingStatus {
  const a = exactOf(aBits)
  const b = exactOf(bBits)
  if (a === null || b === null || Number.isNaN(rounded)) return NO_STATUS
  if (b.m === 0n) return NO_STATUS
  if (!Number.isFinite(rounded)) return { inexact: true, overflow: true, underflow: false }
  const delivered = exactOf(f64ToBits(rounded))!
  const product: Exact = { m: delivered.m * b.m, e: delivered.e + b.e }
  if (sameValue(product, a)) return NO_STATUS
  // |a| < 2^minNormalExp * |b|  is the exact statement of "the quotient is
  // below the smallest normal", with no division involved.
  const left = (a.m < 0n ? -a.m : a.m)
  const right = (b.m < 0n ? -b.m : b.m)
  const shift = format.minNormalExp + b.e - a.e
  const tiny = shift >= 0
    ? left < (right << BigInt(shift))
    : (left << BigInt(-shift)) < right
  return { inexact: true, overflow: false, underflow: tiny }
}

/**
 * Square root is inexact unless the result squared reproduces the operand. It
 * can neither overflow nor underflow: the square root of the largest finite
 * value is far below it, and the square root of the smallest subnormal is far
 * above the smallest normal.
 */
export function sqrtStatus(aBits: bigint, rounded: number): RoundingStatus {
  const a = exactOf(aBits)
  if (a === null || Number.isNaN(rounded) || !Number.isFinite(rounded)) return NO_STATUS
  const r = exactOf(f64ToBits(rounded))!
  const square: Exact = { m: r.m * r.m, e: r.e * 2 }
  return sameValue(square, a) ? NO_STATUS : { inexact: true, overflow: false, underflow: false }
}
