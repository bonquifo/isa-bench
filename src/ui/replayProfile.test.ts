import { describe, expect, it } from 'vitest'
import {
  HARDWARE_PROFILES,
  IsaId,
  runComparison,
} from '../engine/index.ts'
import { currentCatalogProfile, replayProfileState } from './replayProfile.ts'

describe('archived shared-profile replay', () => {
  it('preserves the saved id and displays its resolved snapshot after catalog deletion', () => {
    const original = runComparison({
      workloadId: 'int_sum',
      n: 16,
      seed: 7,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customHw: { clockMhz: 1775, name: 'Saved tuned profile' },
    })
    const index = HARDWARE_PROFILES.findIndex((profile) => profile.id === 'equal-inorder')
    const [removed] = HARDWARE_PROFILES.splice(index, 1)
    try {
      const state = replayProfileState(original.rerunInput, HARDWARE_PROFILES)
      expect(state.profileId).toBe('equal-inorder')
      expect(state.archived).toBe(true)
      expect(state.profile).toEqual(original.rerunInput.resolvedProfileByIsa.riscv)
      expect(state.profile.clockMhz).toBe(1775)

      const replay = runComparison(original.rerunInput)
      expect(replay.resolvedHardware).toEqual(original.resolvedHardware)
      expect(replay.inputFingerprint).toBe(original.inputFingerprint)
    } finally {
      HARDWARE_PROFILES.splice(index, 0, removed)
    }
  })

  it('switches archived ids to a current preset after replay is cleared', () => {
    expect(currentCatalogProfile('removed-profile', HARDWARE_PROFILES).id)
      .toBe(HARDWARE_PROFILES[0].id)
    expect(currentCatalogProfile('equal-smt', HARDWARE_PROFILES).id).toBe('equal-smt')
  })
})
