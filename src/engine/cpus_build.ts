import { chipDefaults } from './hardware.ts'
import { type HardwareProfile, type IsaId } from './types.ts'

export interface CpuModel {
  id: string
  name: string
  vendor: string
  year: number
  /** Associated pseudo-backend target for this illustrative parameter preset. */
  isa: IsaId
  blurb: string
  profile: HardwareProfile
  /** Dropdown optgroup. Unset = flat list. */
  group?: string
}

export const cache = (sizeBytes: number, ways: number, lineBytes = 64): HardwareProfile['l1i'] => ({
  sizeBytes,
  ways,
  lineBytes,
})

const BASE: Omit<HardwareProfile, 'id' | 'name' | 'blurb' | 'clockMhz' | 'issueWidth'> = {
  fetchWidth: 16,
  pipelineStages: 5,
  aluCount: 1,
  memPorts: 1,
  l1i: cache(32768, 4),
  l1d: cache(32768, 4),
  memLatency: 80,
  predictor: 'gshare',
  predEntries: 256,
  forwarding: true,
  mispredictPenalty: 7,
  indirectCallPenalty: 3,
  rasDepth: 16,
  mulLatency: 3,
  divLatency: 12,
  fpAddLatency: 3,
  fpMulLatency: 4,
  fpDivLatency: 12,
  loadLatency: 2,
  complexDecodeBytes: 8,
  staticPowerMw: 400,
  ...chipDefaults(1, 1),
}

export function cpu(
  id: string,
  name: string,
  vendor: string,
  year: number,
  isa: IsaId,
  blurb: string,
  hw: Partial<HardwareProfile> & Pick<HardwareProfile, 'clockMhz' | 'issueWidth'>,
  group?: string,
): CpuModel {
  const lineBytes = hw.l1d?.lineBytes ?? hw.l1i?.lineBytes ?? BASE.l1d.lineBytes
  const inheritedL2 = { ...BASE.l2, lineBytes }
  const inheritedL3 = { ...BASE.l3, lineBytes }
  const profile: HardwareProfile = {
    ...BASE,
    ...hw,
    l1i: hw.l1i ?? BASE.l1i,
    l1d: hw.l1d ?? BASE.l1d,
    l2: hw.l2 ?? inheritedL2,
    l3: hw.l3 ?? inheritedL3,
    id: `cpu-${id}`,
    name,
    blurb,
  }
  return { id, name, vendor, year, isa, blurb, profile, group }
}
