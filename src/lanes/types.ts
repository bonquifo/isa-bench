export type LaneId = 'inorder' | 'ooo' | 'toolchain' | 'external' | 'empirical' | 'calibrated'

export type EvidenceBadge =
  | 'SIMULATED ANALYTICAL'
  | 'GENERATED CODE VALIDATION'
  | 'EXTERNAL SIMULATOR'
  | 'PHYSICALLY MEASURED'
  | 'CALIBRATED PREDICTION'
  | 'IMPORTED UNVERIFIED'
  | 'SIGNED'
  | 'ATTESTED'

export interface ResultEnvelope {
  schemaVersion?: string
  experimentKind?: string
  claimClass?: string
  evidenceClass?: string
  comparisonGroupKey?: string
  inputIdentity?: string
  artifactIdentities?: string[]
  createdAt?: string
  proof?: {
    signatureVerified?: true
    signatureVerifier?: string
    signatureIdentityHash?: string
    attestationVerified?: true
    attestationType?: string
    attestationVerifier?: string
    attestationEvidenceHash?: string
  }
  metrics?: Array<{ name: string; domain: string; unit: string; value: string | number }>
  [key: string]: unknown
}

export const LANES: ReadonlyArray<{
  id: LaneId
  title: string
  short: string
  category: 'MODEL' | 'VALIDATION' | 'EXTERNAL LAB' | 'EMPIRICAL ADMIN' | 'CALIBRATION'
  serverRequired: boolean
  runLabel: string
  runHint: string
}> = [
  { id: 'inorder', title: 'Controlled In-order', short: 'IN-ORDER', category: 'MODEL', serverRequired: false, runLabel: 'RUN MODEL', runHint: 'Use RUN MODEL in the top cyan/magenta bar. The embedded backend runs this lane when connected; otherwise the browser model runs.' },
  { id: 'ooo', title: 'Controlled Detailed OoO', short: 'DETAILED OOO', category: 'MODEL', serverRequired: false, runLabel: 'RUN MODEL', runHint: 'Use RUN MODEL in the top cyan/magenta bar. This is the decoded-op OoO model, not the in-order model.' },
  { id: 'toolchain', title: 'Real Toolchain Validation', short: 'TOOLCHAIN', category: 'VALIDATION', serverRequired: true, runLabel: 'RUN MODEL', runHint: 'Use RUN MODEL in the top cyan/magenta bar to validate codegen through the embedded backend. This is not a timing-model rank.' },
  { id: 'external', title: 'Research Simulators', short: 'GEM5 / MCA / CHAMPSIM', category: 'EXTERNAL LAB', serverRequired: true, runLabel: 'RUN MODEL', runHint: 'Use RUN MODEL in the top cyan/magenta bar for gem5 or llvm-mca when an eligible artifact exists. ChampSim stays unavailable until an imported trace exists.' },
  { id: 'empirical', title: 'Empirical Calibration Lab', short: 'EMPIRICAL LAB', category: 'EMPIRICAL ADMIN', serverRequired: true, runLabel: 'RUN MODEL', runHint: 'RUN MODEL is shown but unavailable. This admin lab has no model to execute until signed evidence is imported.' },
  { id: 'calibrated', title: 'Calibrated Predictions', short: 'CALIBRATED', category: 'CALIBRATION', serverRequired: true, runLabel: 'RUN MODEL', runHint: 'Use RUN MODEL in the top cyan/magenta bar after an approved calibration exists. The lab is empty until then.' },
]

export function hasVerifiedSignature(envelope: ResultEnvelope): boolean {
  return envelope.proof?.signatureVerified === true
}

export function hasVerifiedAttestation(envelope: ResultEnvelope): boolean {
  return envelope.proof?.attestationVerified === true
}

export function comparisonGroups(envelopes: readonly ResultEnvelope[]): Map<string, ResultEnvelope[]> {
  const groups = new Map<string, ResultEnvelope[]>()
  for (const envelope of envelopes) {
    const key = envelope.comparisonGroupKey ?? `ungrouped:${envelope.experimentKind ?? 'unknown'}`
    groups.set(key, [...(groups.get(key) ?? []), envelope])
  }
  return groups
}

export function comparable(envelopes: readonly ResultEnvelope[]): boolean {
  if (envelopes.length < 2) return true
  const first = envelopes[0]
  if (!first) return true
  const expected = comparisonSignature(first)
  return envelopes.every((item) => comparisonSignature(item) === expected)
}

function comparisonSignature(envelope: ResultEnvelope): string {
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion ?? null,
    experimentKind: envelope.experimentKind ?? null,
    claimClass: envelope.claimClass ?? null,
    evidenceClass: envelope.evidenceClass ?? null,
    modelVersion: envelope.modelVersion ?? null,
    adapterVersion: envelope.adapterVersion ?? null,
    comparisonGroupKey: envelope.comparisonGroupKey ?? null,
    inputIdentity: envelope.inputIdentity ?? null,
    artifactIdentities: envelope.artifactIdentities ?? [],
    metrics: (envelope.metrics ?? []).map(({ domain, unit }) => [domain, unit]),
  })
}

export function nextLaneIndex(key: string, index: number): number {
  return nextRovingIndex(key, index, LANES.length)
}

export function nextRovingIndex(key: string, index: number, length: number): number {
  if (!Number.isSafeInteger(length) || length < 1) return -1
  const last = length - 1
  if (key === 'Home') return 0
  if (key === 'End') return last
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % length
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index + last) % length
  return -1
}
