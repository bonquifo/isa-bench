import { describe, expect, it } from 'vitest'
import {
  CANONICAL_NAN_D,
  CANONICAL_NAN_S,
  F32,
  F64,
  RoundMode,
  bitsToF32,
  bitsToF64,
  boxSingle,
  classifyF32,
  classifyF64,
  decomposeF64,
  exactOf,
  exactProduct,
  exactSum,
  f32ToBits,
  f64ToBits,
  fusedMulAdd,
  isNan32,
  isNan64,
  isSignaling32,
  isSignaling64,
  quotientStatus,
  roundExact,
  roundToIntegral,
  sqrtStatus,
  statusOf,
  unboxSingle,
  type Exact,
} from './fp.ts'

const MIN_NORMAL_D = 2 ** -1022
const MIN_SUBNORMAL_D = 2 ** -1074

describe('bit and value conversion', () => {
  it('round-trips doubles through their bit patterns', () => {
    for (const value of [0, -0, 1.5, -2.25, Infinity, -Infinity, MIN_SUBNORMAL_D]) {
      expect(bitsToF64(f64ToBits(value))).toBe(value)
    }
    expect(Object.is(bitsToF64(f64ToBits(-0)), -0)).toBe(true)
  })

  it('round-trips singles through their bit patterns', () => {
    for (const value of [0, 1.5, -2.25, Infinity]) {
      expect(bitsToF32(f32ToBits(value))).toBe(value)
    }
  })

  it('preserves a NaN payload through a bit move', () => {
    expect(f64ToBits(bitsToF64(0x7ff0000000000001n))).toBe(0x7ff0000000000001n)
  })
})

describe('NaN classification', () => {
  it('separates quiet from signalling', () => {
    expect(isNan64(CANONICAL_NAN_D)).toBe(true)
    expect(isSignaling64(CANONICAL_NAN_D)).toBe(false)
    expect(isSignaling64(0x7ff0000000000001n)).toBe(true)
    expect(isNan64(0x7ff0000000000000n)).toBe(false)
    expect(isNan32(CANONICAL_NAN_S)).toBe(true)
    expect(isSignaling32(CANONICAL_NAN_S)).toBe(false)
    expect(isSignaling32(0x7f800001)).toBe(true)
    expect(isNan32(0x7f800000)).toBe(false)
  })

  it('assigns the one-hot fclass code the architecture specifies', () => {
    expect(classifyF64(0xfff0000000000000n)).toBe(1n)
    expect(classifyF64(0xbff0000000000000n)).toBe(2n)
    expect(classifyF64(0x8000000000000001n)).toBe(4n)
    expect(classifyF64(0x8000000000000000n)).toBe(8n)
    expect(classifyF64(0n)).toBe(16n)
    expect(classifyF64(1n)).toBe(32n)
    expect(classifyF64(0x3ff0000000000000n)).toBe(64n)
    expect(classifyF64(0x7ff0000000000000n)).toBe(128n)
    expect(classifyF64(0x7ff0000000000001n)).toBe(256n)
    expect(classifyF64(CANONICAL_NAN_D)).toBe(512n)

    expect(classifyF32(0xff800000)).toBe(1n)
    expect(classifyF32(0xbf800000)).toBe(2n)
    expect(classifyF32(0x80000001)).toBe(4n)
    expect(classifyF32(0x80000000)).toBe(8n)
    expect(classifyF32(0)).toBe(16n)
    expect(classifyF32(1)).toBe(32n)
    expect(classifyF32(0x3f800000)).toBe(64n)
    expect(classifyF32(0x7f800000)).toBe(128n)
    expect(classifyF32(0x7f800001)).toBe(256n)
    expect(classifyF32(CANONICAL_NAN_S)).toBe(512n)
  })
})

describe('NaN boxing', () => {
  it('reads a boxed single out of a wide register', () => {
    expect(unboxSingle(boxSingle(0x3f800000))).toBe(0x3f800000)
  })

  it('reads anything that is not boxed as the canonical single NaN', () => {
    // The architecture requires this: a 64-bit pattern whose upper half is
    // not all ones is not a valid single, whatever its lower half looks like.
    expect(unboxSingle(0x3ff0000000000000n)).toBe(CANONICAL_NAN_S)
    expect(unboxSingle(0n)).toBe(CANONICAL_NAN_S)
  })
})

describe('decomposeF64', () => {
  it('splits finite values into an exact significand and exponent', () => {
    const one = decomposeF64(f64ToBits(1))
    expect(one.kind).toBe('finite')
    expect(Number(one.m) * 2 ** one.e).toBe(1)
    const subnormal = decomposeF64(1n)
    expect(subnormal.kind).toBe('finite')
    expect(subnormal.m).toBe(1n)
    expect(subnormal.e).toBe(-1074)
  })

  it('reports the non-finite kinds and the sign of zero', () => {
    expect(decomposeF64(0x7ff0000000000000n).kind).toBe('inf')
    expect(decomposeF64(CANONICAL_NAN_D).kind).toBe('nan')
    expect(decomposeF64(0n).kind).toBe('zero')
    expect(decomposeF64(0x8000000000000000n).sign).toBe(-1)
    expect(exactOf(0x7ff0000000000000n)).toBeNull()
  })
})

describe('roundExact', () => {
  it('rounds ties to even', () => {
    // 2^53 + 1 is not representable; it sits exactly between two doubles.
    expect(roundExact((1n << 53n) + 1n, 0, F64, 1)).toBe(2 ** 53)
    expect(roundExact((1n << 53n) + 3n, 0, F64, 1)).toBe(2 ** 53 + 4)
  })

  it('produces subnormals down to the format floor', () => {
    expect(roundExact(1n, -1074, F64, 1)).toBe(MIN_SUBNORMAL_D)
    expect(roundExact(1n, -1075, F64, 1)).toBe(0)
    expect(roundExact(3n, -1076, F64, 1)).toBe(MIN_SUBNORMAL_D)
  })

  it('overflows to infinity past the format ceiling', () => {
    expect(roundExact(1n, 1024, F64, 1)).toBe(Infinity)
    expect(roundExact(-1n, 1024, F64, 1)).toBe(-Infinity)
    // The narrower format overflows far sooner, and the value that does it
    // is a perfectly ordinary double — which is why the ceiling is explicit.
    expect(roundExact(1n, 128, F32, 1)).toBe(Infinity)
    expect(roundExact(1n, 127, F32, 1)).toBe(2 ** 127)
  })

  it('keeps the sign of an exact zero', () => {
    expect(Object.is(roundExact(0n, 0, F64, -1), -0)).toBe(true)
    expect(Object.is(roundExact(0n, 0, F64, 1), 0)).toBe(true)
  })

  it('rounds to the narrower format when asked', () => {
    // 1 + 2^-52 is a double but not a single; it rounds to 1.
    expect(roundExact((1n << 52n) + 1n, -52, F32, 1)).toBe(1)
    expect(roundExact((1n << 52n) + 1n, -52, F64, 1)).toBe(1 + 2 ** -52)
  })
})

/**
 * Checks that `value` really is the nearest representable number to the exact
 * quantity `m * 2^e`, with ties to even. This is the definition of correct
 * rounding, checked in exact integer arithmetic rather than by comparison
 * against another floating-point computation.
 */
function expectCorrectlyRounded(exact: Exact, value: number): void {
  const delivered = exactOf(f64ToBits(value))
  expect(delivered).not.toBeNull()
  const d = delivered!
  const scale = Math.min(exact.e, d.e)
  const exactScaled = exact.m << BigInt(exact.e - scale)
  const valueScaled = d.m << BigInt(d.e - scale)
  const difference = exactScaled - valueScaled
  const magnitude = difference < 0n ? -difference : difference
  // One unit in the last place of the delivered value, at the common scale.
  const ulp = 1n << BigInt(d.e - scale)
  expect(magnitude * 2n <= ulp).toBe(true)
  if (magnitude * 2n === ulp) expect(d.m % 2n).toBe(0n)
}

describe('fusedMulAdd', () => {
  it('differs from multiplying and adding separately', () => {
    // (1 + 2^-52)(1 - 2^-52) is exactly 1 - 2^-104. Rounded to a double that
    // is 1, so the unfused result cancels to zero; the fused one does not.
    const a = f64ToBits(1 + 2 ** -52)
    const b = f64ToBits(1 - 2 ** -52)
    const c = f64ToBits(-1)
    expect(bitsToF64(a) * bitsToF64(b) + bitsToF64(c)).toBe(0)
    expect(fusedMulAdd(a, b, c, F64)).toBe(-(2 ** -104))
  })

  it('rounds the exact product-sum correctly over random operands', () => {
    let state = 0x9e3779b97f4a7c15n
    const draw = (): bigint => {
      state ^= state >> 12n
      state = BigInt.asUintN(64, state ^ (state << 25n))
      state ^= state >> 27n
      return BigInt.asUintN(64, state * 0x2545f4914f6cdd1dn)
    }
    let checked = 0
    for (let i = 0; i < 4000; i++) {
      // Keep the exponents modest so nothing overflows; the rounding
      // behaviour under test is the same at every scale.
      const make = (): bigint =>
        f64ToBits((Number(BigInt.asIntN(32, draw())) / 65536) * 2 ** (Number(draw() % 40n) - 20))
      const a = make()
      const b = make()
      const c = make()
      const result = fusedMulAdd(a, b, c, F64)
      if (result === null || !Number.isFinite(result)) continue
      const product = exactProduct(a, b)!
      const addend = exactOf(c)!
      const scale = Math.min(product.e, addend.e)
      const exact: Exact = {
        m: (product.m << BigInt(product.e - scale)) + (addend.m << BigInt(addend.e - scale)),
        e: scale,
      }
      if (exact.m === 0n) continue
      expectCorrectlyRounded(exact, result)
      checked += 1
    }
    expect(checked).toBeGreaterThan(3000)
  })

  it('follows the architecture on the invalid and infinite cases', () => {
    const inf = f64ToBits(Infinity)
    const negInf = f64ToBits(-Infinity)
    const zero = 0n
    expect(fusedMulAdd(inf, zero, f64ToBits(1), F64)).toBeNull()
    expect(fusedMulAdd(inf, f64ToBits(1), negInf, F64)).toBeNull()
    expect(fusedMulAdd(CANONICAL_NAN_D, f64ToBits(1), f64ToBits(1), F64)).toBeNull()
    expect(fusedMulAdd(inf, f64ToBits(2), f64ToBits(1), F64)).toBe(Infinity)
    expect(fusedMulAdd(f64ToBits(2), f64ToBits(-3), negInf, F64)).toBe(-Infinity)
  })

  it('gets the sign of a zero result right', () => {
    const zero = 0n
    const negZero = 0x8000000000000000n
    // Adding zeroes of opposite sign gives +0 under round-to-nearest, so a
    // negative result needs both the product and the addend to be negative.
    expect(Object.is(fusedMulAdd(zero, zero, negZero, F64), 0)).toBe(true)
    expect(Object.is(fusedMulAdd(zero, zero, zero, F64), 0)).toBe(true)
    expect(Object.is(fusedMulAdd(negZero, zero, zero, F64), 0)).toBe(true)
    expect(Object.is(fusedMulAdd(negZero, zero, negZero, F64), -0)).toBe(true)
    expect(Object.is(fusedMulAdd(zero, negZero, negZero, F64), -0)).toBe(true)
    // An exact cancellation is positive zero under round-to-nearest.
    expect(Object.is(fusedMulAdd(f64ToBits(2), f64ToBits(3), f64ToBits(-6), F64), 0)).toBe(true)
  })

  it('passes a zero product straight through to the addend', () => {
    expect(fusedMulAdd(0n, f64ToBits(5), f64ToBits(1.5), F64)).toBe(1.5)
    expect(fusedMulAdd(f64ToBits(2), f64ToBits(3), 0n, F64)).toBe(6)
  })

  it('rounds to single precision when asked', () => {
    // 2^-150 is below the smallest single subnormal and rounds to zero.
    expect(fusedMulAdd(f64ToBits(2 ** -75), f64ToBits(2 ** -75), 0n, F32)).toBe(0)
    expect(fusedMulAdd(f64ToBits(2 ** 100), f64ToBits(2 ** 100), 0n, F32)).toBe(Infinity)
  })
})

describe('rounding status', () => {
  it('reports an exact result as exact', () => {
    expect(statusOf(exactSum(f64ToBits(1), f64ToBits(2)), 3, F64).inexact).toBe(false)
    expect(statusOf(null, 1, F64).inexact).toBe(false)
    expect(statusOf(exactOf(f64ToBits(1)), NaN, F64).inexact).toBe(false)
  })

  it('reports inexactness when rounding moved the value', () => {
    const a = f64ToBits(1)
    const b = f64ToBits(2 ** -60)
    const status = statusOf(exactSum(a, b), 1 + 2 ** -60, F64)
    expect(status.inexact).toBe(true)
    expect(status.overflow).toBe(false)
    expect(status.underflow).toBe(false)
  })

  it('reports overflow when a finite exact value became infinite', () => {
    const big = f64ToBits(Number.MAX_VALUE)
    const status = statusOf(exactSum(big, big), Infinity, F64)
    expect(status).toEqual({ inexact: true, overflow: true, underflow: false })
  })

  it('reports underflow only when the result is both tiny and inexact', () => {
    // Exactly the smallest subnormal: tiny, but nothing was rounded away.
    expect(statusOf(exactOf(1n), MIN_SUBNORMAL_D, F64).underflow).toBe(false)
    // Half of it rounds to zero, which is both tiny and inexact.
    const halfway = statusOf({ m: 1n, e: -1076 }, 0, F64)
    expect(halfway).toEqual({ inexact: true, overflow: false, underflow: true })
  })

  it('decides division exactness by multiplying back', () => {
    const six = f64ToBits(6)
    const two = f64ToBits(2)
    const three = f64ToBits(3)
    expect(quotientStatus(six, two, 3, F64).inexact).toBe(false)
    expect(quotientStatus(f64ToBits(1), three, 1 / 3, F64).inexact).toBe(true)
    expect(quotientStatus(six, 0n, Infinity, F64)).toEqual({
      inexact: false, overflow: false, underflow: false,
    })
    expect(quotientStatus(f64ToBits(Number.MAX_VALUE), f64ToBits(0.5), Infinity, F64).overflow)
      .toBe(true)
  })

  it('detects a quotient that underflows into the subnormals', () => {
    const status = quotientStatus(f64ToBits(MIN_NORMAL_D), f64ToBits(3), MIN_NORMAL_D / 3, F64)
    expect(status.inexact).toBe(true)
    expect(status.underflow).toBe(true)
  })

  it('decides square-root exactness by squaring back', () => {
    expect(sqrtStatus(f64ToBits(4), 2).inexact).toBe(false)
    expect(sqrtStatus(f64ToBits(2), Math.SQRT2).inexact).toBe(true)
    expect(sqrtStatus(f64ToBits(-1), NaN).inexact).toBe(false)
  })
})

describe('roundToIntegral', () => {
  it('implements every mode the architecture names', () => {
    expect(roundToIntegral(2.5, RoundMode.RTZ)).toBe(2)
    expect(roundToIntegral(-2.5, RoundMode.RTZ)).toBe(-2)
    expect(roundToIntegral(2.5, RoundMode.RDN)).toBe(2)
    expect(roundToIntegral(-2.5, RoundMode.RDN)).toBe(-3)
    expect(roundToIntegral(2.5, RoundMode.RUP)).toBe(3)
    expect(roundToIntegral(-2.5, RoundMode.RUP)).toBe(-2)
    expect(roundToIntegral(2.5, RoundMode.RMM)).toBe(3)
    expect(roundToIntegral(-2.5, RoundMode.RMM)).toBe(-3)
    expect(roundToIntegral(3.5, RoundMode.RMM)).toBe(4)
  })

  it('breaks ties to even in the default mode', () => {
    expect(roundToIntegral(2.5, RoundMode.RNE)).toBe(2)
    expect(roundToIntegral(3.5, RoundMode.RNE)).toBe(4)
    expect(roundToIntegral(-2.5, RoundMode.RNE)).toBe(-2)
    expect(roundToIntegral(-3.5, RoundMode.RNE)).toBe(-4)
    expect(roundToIntegral(2.4, RoundMode.RNE)).toBe(2)
    expect(roundToIntegral(2.6, RoundMode.RNE)).toBe(3)
  })
})
