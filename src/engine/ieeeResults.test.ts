import { describe, expect, it } from 'vitest'
import { valuesEqual } from './bits.ts'
import { runComparison } from './compare.ts'
import { parseCompareResult } from './compareSchema.ts'
import { ALL_ISAS } from './types.ts'

const cases = [
  {
    name: 'positive infinity',
    ir: 'immf r0, 1\nimmf r1, 0\ndivf r2, r0, r1\nhalt r2',
    c: 'double main(void) { return 1.0 / 0.0; }',
    expected: Infinity,
  },
  {
    name: 'negative infinity',
    ir: 'immf r0, -1\nimmf r1, 0\ndivf r2, r0, r1\nhalt r2',
    c: 'double main(void) { return -1.0 / 0.0; }',
    expected: -Infinity,
  },
  {
    name: 'NaN',
    ir: 'immf r0, 0\nimmf r1, 0\ndivf r2, r0, r1\nhalt r2',
    c: 'double main(void) { return 0.0 / 0.0; }',
    expected: Number.NaN,
  },
  {
    name: 'negative zero',
    ir: 'immf r0, -0\nhalt r0',
    c: 'double main(void) { return -1.0 * 0.0; }',
    expected: -0,
  },
] as const

describe('end-to-end IEEE result observables', () => {
  for (const testCase of cases) {
    it(`preserves ${testCase.name} through custom IR on every backend`, () => {
      const result = runComparison({
        workloadId: 'custom',
        n: 1,
        seed: 1,
        isas: ALL_ISAS,
        hardwareMode: 'same',
        profileId: 'equal-inorder',
        customSource: testCase.ir,
      })
      expect(valuesEqual(result.gold, testCase.expected, true)).toBe(true)
      expect(result.fp).toBe(true)
      expect(result.rows.every((row) => valuesEqual(row.result, testCase.expected, true))).toBe(true)
    })

    it(`preserves ${testCase.name} through Guest C on every backend`, () => {
      const result = runComparison({
        workloadId: 'custom-c',
        n: 1,
        seed: 1,
        isas: ALL_ISAS,
        hardwareMode: 'same',
        profileId: 'equal-inorder',
        customSource: testCase.c,
      })
      expect(valuesEqual(result.gold, testCase.expected, true)).toBe(true)
      expect(result.fp).toBe(true)
      expect(result.rows.every((row) => valuesEqual(row.result, testCase.expected, true))).toBe(true)
    })
  }

  it('rejects opposite infinities and finite/infinite comparisons', () => {
    expect(valuesEqual(Infinity, -Infinity, true)).toBe(false)
    expect(valuesEqual(Infinity, Number.MAX_VALUE, true)).toBe(false)
    expect(valuesEqual(-Infinity, -Number.MAX_VALUE, true)).toBe(false)
  })

  it('validates non-finite observables as current results, not legacy archives', () => {
    for (const testCase of cases) {
      const result = runComparison({
        workloadId: 'custom-c',
        n: 1,
        seed: 1,
        isas: ['riscv', 'x86'],
        hardwareMode: 'same',
        profileId: 'equal-inorder',
        customSource: testCase.c,
      })
      expect(() => parseCompareResult(result)).not.toThrow()
      expect(valuesEqual(parseCompareResult(result).gold, testCase.expected, true)).toBe(true)
    }
  })

  it('still rejects non-finite values in model counters', () => {
    const result = runComparison({
      workloadId: 'custom-c',
      n: 1,
      seed: 1,
      isas: ['riscv'],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: 'double main(void) { return 1.0 / 0.0; }',
    })
    expect(() => parseCompareResult({
      ...result,
      rows: [{ ...result.rows[0], cycles: Infinity }],
    })).toThrow()
  })

  it('negates doubles by IEEE-754 sign, so -(+0.0) observes negative zero', () => {
    const negatedZero = runComparison({
      workloadId: 'custom-c',
      n: 1,
      seed: 1,
      isas: ALL_ISAS,
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: 'double main(void) { double zero = 0.0; return -zero; }',
    })
    expect(Object.is(negatedZero.gold, -0)).toBe(true)
    expect(negatedZero.rows.every((row) => Object.is(row.result, -0))).toBe(true)

    for (const [source, expected] of [
      ['double main(void) { return -0.0; }', -0],
      ['double main(void) { double zero = 0.0; double negative = -zero; return -negative; }', 0],
      ['double main(void) { double value = 1.5; return -value; }', -1.5],
      ['double main(void) { double infinite = 1.0 / 0.0; return -infinite; }', -Infinity],
      ['double main(void) { double a = 5.0; double b = 2.0; return a - b; }', 3],
    ] as const) {
      const result = runComparison({
        workloadId: 'custom-c',
        n: 1,
        seed: 1,
        isas: ALL_ISAS,
        hardwareMode: 'same',
        profileId: 'equal-inorder',
        customSource: source,
      })
      expect(valuesEqual(result.gold, expected, true)).toBe(true)
      expect(result.rows.every((row) => valuesEqual(row.result, expected, true))).toBe(true)
    }
  })
})
