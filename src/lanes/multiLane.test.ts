import { describe, expect, it } from 'vitest'
import { LANES, comparable, comparisonGroups, hasVerifiedSignature, nextLaneIndex, nextRovingIndex, type ResultEnvelope } from './types.ts'

describe('multi-lane evidence guards', () => {
  it('exposes every experiment as a separate navigation destination', () => {
    expect(LANES.map((lane) => lane.id)).toEqual([
      'inorder', 'ooo', 'toolchain', 'external', 'empirical', 'calibrated',
    ])
    expect(LANES.filter((lane) => !lane.serverRequired).map((lane) => lane.id)).toEqual(['inorder', 'ooo'])
    expect(LANES.map((lane) => lane.runLabel)).toEqual([
      'RUN MODEL', 'RUN MODEL', 'RUN MODEL', 'RUN MODEL', 'RUN MODEL', 'RUN MODEL',
    ])
    expect(nextLaneIndex('Home', 4)).toBe(0)
    expect(nextLaneIndex('End', 1)).toBe(5)
    expect(nextLaneIndex('ArrowRight', 5)).toBe(0)
    expect(nextLaneIndex('ArrowLeft', 0)).toBe(5)
    expect(nextRovingIndex('ArrowRight', 6, 7)).toBe(0)
    expect(nextRovingIndex('ArrowLeft', 0, 7)).toBe(6)
    expect(nextRovingIndex('Home', 5, 7)).toBe(0)
    expect(nextRovingIndex('End', 0, 7)).toBe(6)
  })

  it('never treats mixed groups, kinds, domains, or units as comparable', () => {
    const base: ResultEnvelope = {
      schemaVersion: '1.0.0',
      experimentKind: 'gem5',
      claimClass: 'external-simulation',
      evidenceClass: 'external-simulator-output',
      comparisonGroupKey: 'one',
      inputIdentity: 'input-one',
      artifactIdentities: ['artifact-one', 'artifact-two'],
      metrics: [
        { name: 'cycles', domain: 'external-simulator-cycles', unit: 'sim-cycle', value: 10 },
        { name: 'ipc', domain: 'external-simulator-rate', unit: 'instructions/sim-cycle', value: 2 },
      ],
    }
    expect(comparable([base, { ...base }])).toBe(true)
    expect(comparable([base, { ...base, experimentKind: 'llvm-mca' }])).toBe(false)
    expect(comparable([base, { ...base, comparisonGroupKey: 'two' }])).toBe(false)
    expect(comparable([base, { ...base, metrics: [base.metrics![0]!, { name: 'ipc', domain: 'external-simulator-ratio', unit: 'ratio', value: 2 }] }])).toBe(false)
    expect(comparable([base, { ...base, metrics: [...base.metrics!].reverse() }])).toBe(false)
    expect(comparable([base, { ...base, inputIdentity: 'input-two' }])).toBe(false)
    expect(comparable([base, { ...base, artifactIdentities: ['artifact-two', 'artifact-one'] }])).toBe(false)
    expect(comparisonGroups([base, { ...base, comparisonGroupKey: 'two' }]).size).toBe(2)
  })

  it('requires explicit verified evidence for signed/attested status', () => {
    expect(hasVerifiedSignature({})).toBe(false)
    expect(hasVerifiedSignature({ proof: { signatureVerified: true } })).toBe(true)
    expect(hasVerifiedSignature({ proof: { attestationVerified: true } })).toBe(false)
  })
})
