import { describe, expect, it } from 'vitest'
import {
  fingerprint,
  FRONTEND_VERSION,
  MEASUREMENT_MODEL_VERSION,
  MEASUREMENT_SCHEMA_VERSION,
  parseTaggedJson,
  stablePrettySerialize,
  stableSerialize,
} from './measurement.ts'

describe('tagged canonical measurement JSON', () => {
  it('versions the tagged result contract and exact IEEE model semantics', () => {
    expect(MEASUREMENT_SCHEMA_VERSION).toBe('3')
    expect(MEASUREMENT_MODEL_VERSION).toBe('9')
    expect(FRONTEND_VERSION).toBe('6')
  })

  it('roundtrips non-JSON IEEE values without collapsing them', () => {
    const value = { finite: 3.5, values: [Number.NaN, Infinity, -Infinity, -0, 0] }
    const text = stablePrettySerialize(value)
    const decoded = parseTaggedJson(text) as typeof value
    expect(decoded.finite).toBe(3.5)
    expect(Number.isNaN(decoded.values[0])).toBe(true)
    expect(decoded.values[1]).toBe(Infinity)
    expect(decoded.values[2]).toBe(-Infinity)
    expect(Object.is(decoded.values[3], -0)).toBe(true)
    expect(Object.is(decoded.values[4], 0)).toBe(true)
  })

  it('keeps finite JSON readable and keys deterministic', () => {
    expect(stableSerialize({ z: 2, a: 1 })).toBe('{"a":1,"z":2}')
    expect(parseTaggedJson('{"ordinary":[1,2,3]}')).toEqual({ ordinary: [1, 2, 3] })
  })

  it('produces distinct fingerprints for every special IEEE observable', () => {
    const values = [Number.NaN, Infinity, -Infinity, -0, 0]
    expect(new Set(values.map((value) => fingerprint({ value }))).size).toBe(values.length)
  })
})
