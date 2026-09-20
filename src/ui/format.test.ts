import { describe, expect, it } from 'vitest'
import { fmtFixed, fmtInt, fmtMult, fmtNs, fmtNum, pct, signedPct } from './format.ts'

describe('report formatters', () => {
  it('formats integers with grouping and rounds', () => {
    expect(fmtInt(1234567)).toBe('1,234,567')
    expect(fmtInt(1.6)).toBe('2')
  })

  it('fixes a digit count and names non-finite IEEE values', () => {
    expect(fmtFixed(3.14159, 2)).toBe('3.14')
    expect(fmtFixed(2, 3)).toBe('2.000')
    expect(fmtFixed(Number.NaN)).toBe('NaN')
    expect(fmtFixed(Number.POSITIVE_INFINITY)).toBe('Infinity')
  })

  it('switches fmtNum between integer and 6-digit float', () => {
    expect(fmtNum(1234.5, false)).toBe('1,234')
    expect(fmtNum(1.5, true)).toBe('1.500000')
    expect(fmtNum(Number.NaN, true)).toBe('NaN')
    expect(fmtNum(Infinity, true)).toBe('Infinity')
    expect(fmtNum(-Infinity, true)).toBe('-Infinity')
    expect(fmtNum(-0, true)).toBe('-0')
  })

  it('converts cycles/MHz into ns, µs, or ms', () => {
    expect(fmtNs(1, 2000)).toBe('0.50 ns')
    expect(fmtNs(4000, 2000)).toBe('2.00 µs')
    expect(fmtNs(4_000_000, 2000)).toBe('2.000 ms')
  })

  it('prints percentages, signed deltas, and multipliers', () => {
    expect(pct(1, 4)).toBe('25.0%')
    expect(pct(1, 0)).toBe('0%')
    expect(signedPct(12.34)).toBe('+12.3%')
    expect(signedPct(-0.02)).toBe('0%')
    expect(signedPct(Infinity)).toBe('—')
    expect(signedPct(Number.NaN)).toBe('—')
    expect(fmtMult(1.5)).toBe('1.50×')
    expect(fmtMult(Number.NaN)).toBe('—')
  })
})
