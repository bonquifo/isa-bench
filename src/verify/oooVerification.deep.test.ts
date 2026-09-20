import { describe, expect, it } from 'vitest'
import { C_EXAMPLES, cWorkloadId } from '../engine/c/compile_c.ts'
import { runOoOComparison } from '../engine/ooo-compare.ts'
import { DEFAULT_OOO_PROFILE, WIDTH_ONE_OOO_PROFILE } from '../engine/ooo-types.ts'
import { ALL_ISAS } from '../engine/types.ts'
import { WORKLOADS } from '../engine/workloads.ts'
import { generateRandomIr } from './randomIr.ts'

describe('deep OoO verification', () => {
  it('matches every built-in across all target lowerings', () => {
    for (const workload of WORKLOADS) {
      const result = runOoOComparison({
        workloadId: workload.id,
        n: Math.min(workload.defaultN, 32),
        seed: 42,
        isas: ALL_ISAS,
        hardwareMode: 'same',
        profileId: 'equal-inorder',
      })
      expect(result.rows.every((row) => row.matchedGold), workload.id).toBe(true)
    }
  })

  it('matches representative recursive, stdout, and heap C fixtures on all targets', () => {
    for (const id of ['fib', 'hello', 'ptr']) {
      const fixture = C_EXAMPLES.find((item) => item.id === id)!
      const result = runOoOComparison({
        workloadId: cWorkloadId(fixture),
        n: 1,
        seed: 1,
        isas: ALL_ISAS,
        hardwareMode: 'same',
        profileId: 'equal-inorder',
      })
      expect(result.rows.every((row) => row.matchedGold), id).toBe(true)
    }
  })

  it('matches 64 seeded random programs under default and width-one profiles', () => {
    for (let seed = 1; seed <= 64; seed++) {
      const generated = generateRandomIr(seed)
      for (const profile of [DEFAULT_OOO_PROFILE, WIDTH_ONE_OOO_PROFILE]) {
        const result = runOoOComparison({
          workloadId: 'custom',
          n: 1,
          seed,
          isas: ALL_ISAS,
          hardwareMode: 'same',
          profileId: 'equal-inorder',
          customSource: generated.source,
          oooProfile: profile,
        })
        expect(result.gold, `${profile.id} seed ${seed}`).toBe(generated.expectedReturn)
        expect(
          result.rows.every((row) => row.matchedGold),
          `${profile.id} seed ${seed}`,
        ).toBe(true)
      }
    }
  })

  it('preserves parallel barrier and false-sharing results with tiny store buffers', () => {
    for (const workloadId of ['int_sum', 'dot_product']) {
      const result = runOoOComparison({
        workloadId,
        n: 64,
        seed: 7,
        isas: ALL_ISAS,
        hardwareMode: 'same',
        profileId: 'equal-quad',
        oooProfile: { ...DEFAULT_OOO_PROFILE, storeBufferEntries: 1 },
      })
      expect(result.rows.every((row) => row.matchedGold), workloadId).toBe(true)
      for (const row of result.rows) {
        expect(row.memory.requests).toBe(row.memory.completions)
        expect(row.memory.releases).toBe(row.memory.requests)
        expect(row.memory.retainedRequests).toBe(0)
        expect(row.memory.pendingLines).toBe(0)
      }
    }
  })
})
