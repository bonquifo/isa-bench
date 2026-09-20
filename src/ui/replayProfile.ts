import type { RerunInputSnapshot } from '../engine/compare.ts'
import type { HardwareProfile } from '../engine/types.ts'

export interface ReplayProfileState {
  profileId: string
  profile: HardwareProfile
  archived: boolean
}

/** Resolves display controls from the saved snapshot without rewriting its catalog id. */
export function replayProfileState(
  input: RerunInputSnapshot,
  catalog: HardwareProfile[],
): ReplayProfileState {
  const catalogProfile = catalog.find((profile) => profile.id === input.profileId)
  const savedProfile = input.selectedIsas
    .map((isa) => input.resolvedProfileByIsa[isa])
    .find((profile): profile is HardwareProfile => profile !== undefined)
  const profile = savedProfile ?? catalogProfile
  if (!profile) {
    throw new Error(`Saved profile "${input.profileId}" has no resolved snapshot`)
  }
  return {
    profileId: input.profileId,
    profile: structuredClone(profile),
    archived: !catalogProfile,
  }
}

/** Chooses a live preset once a user action intentionally leaves exact replay. */
export function currentCatalogProfile(
  profileId: string,
  catalog: HardwareProfile[],
): HardwareProfile {
  const profile = catalog.find((item) => item.id === profileId) ?? catalog[0]
  if (!profile) throw new Error('No current hardware profiles are available')
  return profile
}
