import { describe, expect, it } from 'vitest'
import { hex64, mulhs, mulhsu, mulhu, s64, sext, u64, zext } from './bits64.ts'

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n
const UINT64_MAX = 2n ** 64n - 1n

describe('s64 / u64', () => {
  it('wraps at the signed boundary', () => {
    expect(s64(INT64_MAX)).toBe(INT64_MAX)
    expect(s64(INT64_MAX + 1n)).toBe(INT64_MIN)
    expect(s64(INT64_MIN - 1n)).toBe(INT64_MAX)
    expect(s64(UINT64_MAX)).toBe(-1n)
  })

  it('wraps at the unsigned boundary', () => {
    expect(u64(-1n)).toBe(UINT64_MAX)
    expect(u64(INT64_MIN)).toBe(2n ** 63n)
    expect(u64(UINT64_MAX + 1n)).toBe(0n)
  })

  it('round-trips every value through both interpretations', () => {
    for (const v of [0n, 1n, -1n, INT64_MIN, INT64_MAX, 0x8000000000000000n, 0xdeadbeefcafef00dn]) {
      expect(s64(u64(v))).toBe(s64(v))
      expect(u64(s64(v))).toBe(u64(v))
    }
  })
})

describe('sext / zext', () => {
  it('sign-extends at every width a load uses', () => {
    expect(sext(0xffn, 8)).toBe(-1n)
    expect(sext(0x7fn, 8)).toBe(127n)
    expect(sext(0x80n, 8)).toBe(-128n)
    expect(sext(0xffffn, 16)).toBe(-1n)
    expect(sext(0x8000n, 16)).toBe(-32768n)
    expect(sext(0xffffffffn, 32)).toBe(-1n)
    expect(sext(0x80000000n, 32)).toBe(-2147483648n)
    expect(sext(0x7fffffffn, 32)).toBe(2147483647n)
  })

  it('zero-extends at every width a load uses', () => {
    expect(zext(-1n, 8)).toBe(0xffn)
    expect(zext(-1n, 16)).toBe(0xffffn)
    expect(zext(-1n, 32)).toBe(0xffffffffn)
    expect(zext(-1n, 64)).toBe(UINT64_MAX)
    expect(zext(0x1234n, 8)).toBe(0x34n)
  })

  it('discards the bits above the requested width', () => {
    expect(sext(0xdeadbeefn, 16)).toBe(sext(0xbeefn, 16))
    expect(zext(0xdeadbeefn, 16)).toBe(0xbeefn)
  })
})

describe('mulh family', () => {
  it('matches hand-computed values at the boundaries', () => {
    expect(mulhs(-1n, -1n)).toBe(0n)
    expect(mulhs(-1n, 1n)).toBe(-1n)
    expect(mulhs(INT64_MIN, INT64_MIN)).toBe(2n ** 62n)
    expect(mulhs(INT64_MIN, -1n)).toBe(0n)
    expect(mulhu(-1n, -1n)).toBe(-2n)
    expect(mulhu(0n, -1n)).toBe(0n)
    expect(mulhsu(-1n, -1n)).toBe(-1n)
    expect(mulhsu(1n, -1n)).toBe(0n)
  })

  it('reconstructs the exact 128-bit product for both signednesses', () => {
    let state = 0x2545f4914f6cdd1dn
    const draw = (): bigint => {
      // xorshift64*, purely so the cases are spread across the whole width.
      state ^= state >> 12n
      state ^= u64(state << 25n)
      state ^= state >> 27n
      state = u64(state)
      return s64(state * 0x2545f4914f6cdd1dn)
    }
    for (let i = 0; i < 2000; i++) {
      const a = draw()
      const b = draw()
      const low = u64(a * b)
      expect((u64(mulhs(a, b)) << 64n) | low).toBe(BigInt.asUintN(128, s64(a) * s64(b)))
      expect((u64(mulhu(a, b)) << 64n) | low).toBe(BigInt.asUintN(128, u64(a) * u64(b)))
      expect((u64(mulhsu(a, b)) << 64n) | low).toBe(BigInt.asUintN(128, s64(a) * u64(b)))
    }
  })
})

describe('hex64', () => {
  it('always prints sixteen digits so mismatches align', () => {
    expect(hex64(0n)).toBe('0x0000000000000000')
    expect(hex64(-1n)).toBe('0xffffffffffffffff')
    expect(hex64(INT64_MIN)).toBe('0x8000000000000000')
  })
})
