import { describe, expect, it } from 'vitest'
import { runComparison } from '../engine/compare.ts'
import { valuesEqual } from '../engine/bits.ts'
import { IsaId } from '../engine/types.ts'
import {
  csvEscape,
  makeCanonicalResultEnvelope,
  parseResultJson,
  resultToCsv,
  resultToJson,
} from './exports.ts'

const result = runComparison({
  workloadId: 'int_sum',
  n: 8,
  seed: 1,
  isas: [IsaId.RISCV],
  hardwareMode: 'same',
  profileId: 'equal-inorder',
})

describe('result exports', () => {
  it('creates a versioned canonical JSON envelope with reproducibility data', () => {
    const envelope = makeCanonicalResultEnvelope(result)
    expect(envelope.format).toBe('isa-bench-canonical-result')
    expect(envelope.version).toBe(2)
    expect(envelope.contract).toEqual(result.contract)
    expect(envelope.rerunInput).toEqual(result.rerunInput)
    expect(envelope.resolvedProfiles).toEqual(result.resolvedHardware)
    expect(JSON.parse(resultToJson(result))).toEqual(envelope)
  })

  it('parses canonical IEEE-tagged result exports losslessly', () => {
    const special = structuredClone(result)
    special.fp = true
    special.gold = Number.NaN
    special.rows[0].result = -0
    const parsed = parseResultJson(resultToJson(special))
    expect(Number.isNaN(parsed.result.gold)).toBe(true)
    expect(Object.is(parsed.result.rows[0].result, -0)).toBe(true)
    expect(resultToJson(special)).toContain('$isaBench.ieee754')
  })

  it('replays an exported non-finite result from its decoded canonical input', () => {
    const original = runComparison({
      workloadId: 'custom',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: 'immf r0, 1\nimmf r1, 0\ndivf r2, r0, r1\nhalt r2',
    })
    const decoded = parseResultJson(resultToJson(original))
    const replay = runComparison(decoded.rerunInput)
    expect(valuesEqual(replay.gold, Infinity, true)).toBe(true)
    expect(replay.inputFingerprint).toBe(original.inputFingerprint)
  })

  it('serializes logically identical insertion orders byte-identically', () => {
    const reordered = Object.fromEntries(Object.entries(result).reverse()) as unknown as typeof result
    reordered.rerunInput = Object.fromEntries(
      Object.entries(result.rerunInput).reverse(),
    ) as unknown as typeof result.rerunInput
    expect(resultToJson(reordered)).toBe(resultToJson(result))
  })

  it('uses qualified flattened-summary headers', () => {
    const csv = resultToCsv(result)
    expect(csv).toContain('flattened-summary-only-json-is-canonical')
    expect(csv).toContain('dynamic_modeled_ops')
    expect(csv).toContain('profile_snapshot_fingerprint')
    // A lowered result says so, and leaves the counted columns empty.
    const [header, first] = csv.split('\r\n').map((line) => line.split(','))
    const cell = (name: string) => first![header!.indexOf(name)]
    expect(cell('execution_mode')).toBe('model-lowering')
    expect(cell('instructions_retired')).toBe('')
    expect(cell('dynamic_modeled_ops')).not.toBe('')
    // Energy is not reported, so it is not a summary column.
    expect(header!.some((name) => /energy/.test(name))).toBe(false)
  })

  it('escapes commas, quotes, CR, and LF with doubled quotes', () => {
    expect(csvEscape('plain')).toBe('plain')
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('a"b')).toBe('"a""b"')
    expect(csvEscape('a\r\nb')).toBe('"a\r\nb"')
  })

  it('neutralizes spreadsheet formulas only for string cells', () => {
    for (const value of ['=1+1', '+cmd', '-formula', '@link', '  =SUM(A1:A2)', '\t@name']) {
      expect(csvEscape(value)).toBe(`'${value}`)
    }
    expect(csvEscape('safe')).toBe('safe')
    expect(csvEscape(-12.5)).toBe('-12.5')
  })
})
