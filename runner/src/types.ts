import type { EmpiricalJobSpec, EmpiricalScheduleEntry, EmpiricalScheduleProtocol } from '@isa-sim/contracts'

export type Availability<T> =
  | { status: 'supported'; value: T }
  | { status: 'unsupported' | 'permission-denied' | 'probe-failed'; reason: string }

export interface CapabilityManifest {
  schemaVersion: '1'
  runnerId: string
  sequence: string
  observedAt: string
  expiresAt: string
  host: {
    os: Availability<{ platform: string; release: string; version: string }>
    arch: Availability<string>
    abi: Availability<string>
    kernel: Availability<string>
    bootId: Availability<string>
    machineHash: Availability<string>
  }
  cpu: {
    identity: Availability<{ family: string; model: string; stepping: string; microcode: string | null }>
    features: Availability<string[]>
    topology: Availability<{
      packages: number; numaNodes: number; physicalCores: number; logicalCpus: number
      smt: boolean; hybrid: boolean
    }>
  }
  caches: Availability<unknown[]>
  memory: Availability<{ bytes: string; pageBytes: string; hugePages: string }>
  firmware: Availability<{ kind: string; secureBoot: boolean | null }>
  frequency: Availability<{ governors: string[]; currentKHz: string[]; turbo: boolean | null }>
  thermal: Availability<{ sensors: string[]; throttleEvidence: boolean }>
  pmu: Availability<{ version: string; counters: number; perfEventParanoid: number | null }>
  energy: Availability<{ raplDomains: Array<{ name: string; scope: string; energyUj: string; maxRangeUj: string; readable: boolean }>; sensors: string[] }>
  container: Availability<{ runtime: string; version: string }>
  clock: Availability<{ source: string; synchronized: boolean | null; evidence: string }>
}

export interface Signed<T> {
  algorithm: 'Ed25519'
  keyId: string
  payload: T
  signature: string
  signedAt: string
}

export type RunnerState = 'pending' | 'approved' | 'quarantined' | 'revoked' | 'expired'

export interface RunnerCredential {
  runnerId: string
  keyId: string
  publicKey: string
  state: RunnerState
  issuedAt: string
  expiresAt: string
  sequence: string
}

export type JobSpec = EmpiricalJobSpec

export type LeaseEventKind = 'accept' | 'heartbeat' | 'start' | 'event' | 'finish' | 'fail'
export interface LeaseEvent {
  operation: string
  runnerId: string
  keyId: string
  requestId: string
  jobId: string
  leaseId: string
  leaseNonce: string
  sequence: string
  kind: LeaseEventKind
  timestamp: string
  nonce: string
  data: Record<string, unknown>
}

export interface PerfReading {
  name: string
  raw: string
  scaled: string | null
  timeEnabledNs: string
  timeRunningNs: string
  group: string
}

export interface EnergyReading {
  adapter: 'rapl-powercap' | 'rapl-perf' | 'ina' | 'external' | 'null'
  supported: boolean
  grossJoules?: number
  idleJoules?: number
  netJoules?: number
  domain?: string
  processEnergy: false
  wrapCount?: number
  streamRef?: string
  reason?: string
  beforeUj?: string
  afterUj?: string
  maxRangeUj?: string
}

export interface RawRunRecord {
  kind: 'raw-run'
  sampleId: string
  phase: 'pilot' | 'warmup' | 'measured' | 'idle'
  block: number
  arm: 'A' | 'B'
  ordinal: number
  pairId: string
  valid: boolean
  validityReasons: string[]
  monotonicStartedNs: string
  monotonicDurationNs: string
  userCpuNs: string
  systemCpuNs: string
  timedOut: boolean
  exitCode: number | null
  signal: string | null
  stdoutSha256: string
  stderrSha256: string
  oracle: { passed: boolean; detail: string; iterations: string; nonce: string }
  affinity: Record<string, unknown>
  contextSwitches: { voluntary: number; involuntary: number } | null
  migrations: number | null
  faults: { minor: number; major: number } | null
  clock: { source: string; uncertaintyNs: string }
  adapterStatus: Array<{ adapter: string; required: boolean; supported: boolean; reason?: string }>
  perf: PerfReading[]
  energy: EnergyReading[]
  sensorStreamRefs: string[]
  temperatureC: number | null
  frequencyKHz: string | null
  throttle: boolean | null
  controlsBefore: Record<string, string>
  controlsAfter: Record<string, string>
}

export interface ScheduleRecord {
  kind: 'schedule'
  jobId: string
  seed: string
  entries: EmpiricalScheduleEntry[]
  protocol: EmpiricalScheduleProtocol
  signed: Signed<{
    jobId: string
    seed: string
    entries: EmpiricalScheduleEntry[]
    protocol: ScheduleRecord['protocol']
  }>
}

export interface CorpusEligibility {
  corpusId: string
  hostIsa: string
  os: string
  abi: string
  binaryPath: string
  sha256: string
  size: string
  eligible: true
}
