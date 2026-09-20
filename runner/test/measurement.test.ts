import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSchedule, hashFileStable, inaIntegrate, mapExternalClock, nullEnergy, perfValid, raplEnergy,
  scalePerf, selectInnerIterations, subtractIdle, parseHelperRunResponse,
} from '../src/index.js'

describe('measurement policy', () => {
  it('generates deterministic frozen ABBA schedules with warmup exclusion', () => {
    const first = buildSchedule('seed', 32, 5)
    expect(first).toEqual(buildSchedule('seed', 32, 5))
    expect(first.filter((entry) => entry.phase === 'warmup')).toHaveLength(5)
    expect(first.filter((entry) => entry.phase === 'measured')).toHaveLength(32)
    expect(first.filter((entry) => entry.phase === 'idle')).toHaveLength(32)
    for (const block of new Set(first.filter((entry) => entry.block >= 0).map((entry) => entry.block))) {
      const entries=first.filter((entry) => entry.block === block),pairIds=[...new Set(entries.map(entry=>entry.pairId))]
      expect(entries).toHaveLength(8)
      const pattern = pairIds.map(pairId=>entries.find(entry=>entry.pairId===pairId)!.arm).join('')
      expect(['ABBA', 'BAAB']).toContain(pattern)
    }
    const pairs=new Map<string,typeof first>()
    for(const entry of first.filter(candidate=>candidate.phase!=='warmup'))pairs.set(entry.pairId,[...(pairs.get(entry.pairId)??[]),entry])
    expect([...pairs.keys()][0]).toBe('pair-0')
    for(const treatments of pairs.values())expect(treatments.map(entry=>entry.phase).sort()).toEqual(['idle','measured'])
    expect(()=>buildSchedule('seed',30,0)).toThrow('divisible by four')
    expect(()=>buildSchedule('seed',34,0)).toThrow('divisible by four')
    expect(selectInnerIterations(10_000_000n, 1n)).toBe(25n)
  })

  it('never upgrades incomplete helper evidence to a valid sample', () => {
    expect(() => parseHelperRunResponse({ valid: true, validityReasons: [] })).toThrow('incomplete')
  })

  it('detects binary mutation and PMU multiplex thresholds', () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-binary-'))
    const path = join(root, 'eligible.bin')
    writeFileSync(path, 'one')
    const one = hashFileStable(path)
    writeFileSync(path, 'two')
    expect(hashFileStable(path).sha256).not.toBe(one.sha256)
    expect(perfValid([scalePerf('cycles', 90n, 100n, 90n, 'g')], 0.9)).toBe(true)
    expect(perfValid([scalePerf('cycles', 89n, 100n, 89n, 'g')], 0.9)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('preserves negative net energy and validates energy/clock adapters', () => {
    const gross = raplEnergy(90n, 10n, 100n, 1000n)
    expect(gross.wrapCount).toBe(1)
    expect(subtractIdle(gross, 0.00003).netJoules).toBeLessThan(0)
    expect(() => raplEnergy(90n, 10n, 100n, 1_000_000_000n, 1000)).toThrow('ambiguous')
    expect(inaIntegrate([
      { timestampNs: 0n, shuntVolts: 0.01, busVolts: 5 },
      { timestampNs: 1_000_000_000n, shuntVolts: 0.01, busVolts: 5 },
    ], 0.1).grossJoules).toBeCloseTo(0.5)
    expect(nullEnergy('none').supported).toBe(false)
    expect(mapExternalClock(1_000_000n, 100n, 10, 0n, 10, 20)).toBe(1_000_110n)
    expect(() => mapExternalClock(1n, 0n, 0, 0n, 21, 20)).toThrow('uncertainty')
  })
})
