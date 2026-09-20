import { describe, expect, it } from 'vitest'
import {
  checksumI32,
  i32,
  idiv,
  imul,
  inSigned,
  inUnsigned,
  irem,
  isSafePowerOfTwo,
  isar,
  ishl,
  ishr,
  lcg,
  splitLui12,
  u32,
  valuesEqual,
} from './bits.ts'

describe('safe arithmetic helpers', () => {
  it('recognizes powers of two beyond 32 bits without truncation', () => {
    expect(isSafePowerOfTwo(2 ** 32)).toBe(true)
    expect(isSafePowerOfTwo(2 ** 52)).toBe(true)
    expect(isSafePowerOfTwo(4294967297)).toBe(false)
    expect(isSafePowerOfTwo(Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})

describe('two’s-complement integer model', () => {
  it('truncates to signed 32-bit with wraparound', () => {
    expect(i32(0)).toBe(0)
    expect(i32(2147483647)).toBe(2147483647)
    expect(i32(2147483648)).toBe(-2147483648)
    expect(i32(2147483649)).toBe(-2147483647)
    expect(i32(-1)).toBe(-1)
    expect(i32(-2147483648)).toBe(-2147483648)
    expect(i32(-2147483649)).toBe(2147483647)
    expect(i32(2 ** 32 + 5)).toBe(5)
  })

  it('exposes the unsigned 32-bit view', () => {
    expect(u32(-1)).toBe(0xffffffff)
    expect(u32(-2147483648)).toBe(0x80000000)
    expect(u32(1)).toBe(1)
  })

  it('multiplies with 32-bit wrap (C int / RISC-V MUL)', () => {
    expect(imul(6, 7)).toBe(42)
    expect(imul(-3, 5)).toBe(-15)
    expect(imul(65536, 65536)).toBe(0)
    expect(imul(0x7fffffff, 2)).toBe(-2)
    expect(imul(-2147483648, -1)).toBe(-2147483648)
  })

  it('divides toward zero and returns 0 on divide-by-zero', () => {
    expect(idiv(7, 2)).toBe(3)
    expect(idiv(-7, 2)).toBe(-3)
    expect(idiv(7, -2)).toBe(-3)
    expect(idiv(-7, -2)).toBe(3)
    expect(idiv(1, 0)).toBe(0)
    expect(idiv(-8, 0)).toBe(0)
    expect(idiv(-2147483648, -1)).toBe(-2147483648)
  })

  it('remainder has the sign of the dividend (C99 / JS %)', () => {
    expect(irem(7, 3)).toBe(1)
    expect(irem(-7, 3)).toBe(-1)
    expect(irem(7, -3)).toBe(1)
    expect(irem(-7, -3)).toBe(-1)
    expect(irem(5, 0)).toBe(0)
  })

  it('masks the shift amount to 5 bits like RV32 / ARM / x86', () => {
    expect(ishl(1, 0)).toBe(1)
    expect(ishl(1, 31)).toBe(-2147483648)
    expect(ishl(1, 32)).toBe(1)
    expect(ishl(1, 33)).toBe(2)
    expect(ishr(0x80000000, 1)).toBe(0x40000000)
    expect(ishr(-1, 1)).toBe(0x7fffffff)
    expect(ishr(8, 32)).toBe(8)
    expect(isar(-8, 1)).toBe(-4)
    expect(isar(-1, 31)).toBe(-1)
    expect(isar(8, 1)).toBe(4)
    expect(isar(-2147483648, 31)).toBe(-1)
  })
})

describe('immediate encodings', () => {
  it('classifies signed and unsigned bit-fields', () => {
    expect(inSigned(2047, 12)).toBe(true)
    expect(inSigned(2048, 12)).toBe(false)
    expect(inSigned(-2048, 12)).toBe(true)
    expect(inSigned(-2049, 12)).toBe(false)
    expect(inSigned(32767, 16)).toBe(true)
    expect(inSigned(32768, 16)).toBe(false)
    expect(inSigned(-4096, 13)).toBe(true)
    expect(inSigned(4095, 13)).toBe(true)
    expect(inSigned(4096, 13)).toBe(false)
    expect(inUnsigned(4095, 12)).toBe(true)
    expect(inUnsigned(4096, 12)).toBe(false)
    expect(inUnsigned(-1, 12)).toBe(false)
  })

  it('splits a 32-bit value into RISC-V LUI + signed-12 ADDI', () => {
    const reconstruct = (imm: number) => {
      const { upper, lower } = splitLui12(imm)
      expect(lower).toBeGreaterThanOrEqual(-2048)
      expect(lower).toBeLessThanOrEqual(2047)
      expect(upper).toBeGreaterThanOrEqual(0)
      expect(upper).toBeLessThanOrEqual(0xfffff)
      return i32((upper << 12) + lower)
    }
    for (const v of [0, 1, -1, 2047, 2048, -2048, 0x12345, 0x800, 0xfffff000, -4096, 0x7fffffff, -2147483648]) {
      expect(reconstruct(v), String(v)).toBe(i32(v))
    }
  })
})

describe('FNV-1a-32 checksum', () => {
  it('uses the official offset basis and prime', () => {
    const buf = new ArrayBuffer(12)
    const view = new DataView(buf)
    view.setInt32(0, 1, true)
    view.setInt32(4, 2, true)
    view.setInt32(8, 3, true)
    let h = 2166136261
    for (const w of [1, 2, 3]) {
      h ^= w
      h = Math.imul(h, 16777619)
    }
    expect(checksumI32(view, 0, 3)).toBe(h | 0)
    expect(checksumI32(view, 0, 0)).toBe(2166136261 | 0)
  })

  it('is little-endian and sensitive to word order', () => {
    const a = new DataView(new ArrayBuffer(8))
    const b = new DataView(new ArrayBuffer(8))
    a.setInt32(0, 1, true)
    a.setInt32(4, 2, true)
    b.setInt32(0, 2, true)
    b.setInt32(4, 1, true)
    expect(checksumI32(a, 0, 2)).not.toBe(checksumI32(b, 0, 2))
  })
})

describe('Numerical Recipes LCG', () => {
  it('uses a=1664525, c=1013904223, modulus 2^32', () => {
    const next = lcg(1)
    const s1 = (Math.imul(1, 1664525) + 1013904223) | 0
    const s2 = (Math.imul(s1, 1664525) + 1013904223) | 0
    expect(next()).toBe(s1)
    expect(next()).toBe(s2)
  })

  it('is deterministic for a given seed and independent across generators', () => {
    const a = lcg(42)
    const b = lcg(42)
    const c = lcg(43)
    const seq = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(seq)
    expect(c()).not.toBe(seq[0])
  })
})

describe('result equality', () => {
  it('requires exact signed-i32 integer results without truncation contamination', () => {
    expect(valuesEqual(5, 5, false)).toBe(true)
    expect(valuesEqual(5.9, 5, false)).toBe(false)
    expect(valuesEqual(-1, 0xffffffff, false)).toBe(false)
    expect(valuesEqual(Number.NaN, 0, false)).toBe(false)
    expect(valuesEqual(Infinity, 0, false)).toBe(false)
    expect(valuesEqual(1, 2, false)).toBe(false)
  })

  it('uses exact IEEE observable equality with deliberate NaN equivalence', () => {
    expect(valuesEqual(1, 1, true)).toBe(true)
    expect(valuesEqual(1, 1 + Number.EPSILON, true)).toBe(false)
    expect(valuesEqual(Number.NaN, Number.NaN, true)).toBe(true)
    expect(valuesEqual(Number.NaN, 0, true)).toBe(false)
    expect(valuesEqual(Infinity, Infinity, true)).toBe(true)
    expect(valuesEqual(-Infinity, -Infinity, true)).toBe(true)
    expect(valuesEqual(Infinity, -Infinity, true)).toBe(false)
    expect(valuesEqual(Infinity, Number.MAX_VALUE, true)).toBe(false)
    expect(valuesEqual(0, -0, true)).toBe(false)
    expect(valuesEqual(-0, -0, true)).toBe(true)
  })
})
