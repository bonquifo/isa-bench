import type { EnergyReading, PerfReading } from './types.js'

export interface HelperRunRequest {
  operation: 'run'
  binary: { path: string; sha256: string; size: string; corpusId: string }
  argv: string[]
  iterations: string
  cpus: number[]
  timeoutMs: number
  jobNonce: string
  corpusIdentity: string
  adapters: string[]
}

export interface HelperRunResponse {
  valid: boolean
  validityReasons: string[]
  monotonicStartedNs: string
  monotonicDurationNs: string
  userCpuNs: string
  systemCpuNs: string
  exitCode: number | null
  signal: number | string | null
  timedOut: boolean
  stdoutSha256: string
  stderrSha256: string
  oraclePassed: boolean
  oracleDetail: string
  oracleIterations: string
  oracleNonce: string
  affinity: { requested: number[]; effective: number[] }
  contextSwitches: { voluntary: number; involuntary: number } | null
  migrations: number | null
  faults: { minor: number; major: number } | null
  perf: PerfReading[]
  energy: EnergyReading[]
  sensors: unknown[]
  clockUncertaintyNs: string
  clockSource: string
  temperatureC: number | null
  frequencyKHz: string | null
  throttle: boolean | null
  controlsBefore: Record<string, string>
  controlsAfter: Record<string, string>
  adapterStatus: Array<{ adapter: string; required: boolean; supported: boolean; reason?: string }>
}

export function parseHelperRunResponse(value: unknown): HelperRunResponse {
  const item = object(value)
  const required = [
    'adapterStatus','affinity','clockSource','clockUncertaintyNs','contextSwitches','controlsAfter','controlsBefore','energy','exitCode','faults','frequencyKHz','migrations','monotonicDurationNs',
    'monotonicStartedNs','oracleDetail','oracleIterations','oracleNonce','oraclePassed','perf','sensors','signal','stderrSha256',
    'stdoutSha256','systemCpuNs','temperatureC','throttle','timedOut','userCpuNs','valid','validityReasons',
  ]
  if (Object.keys(item).sort().join(',') !== required.sort().join(',')) throw new Error(`incomplete/unknown helper response: ${Object.keys(item).sort().join(',')}`)
  const decimal = (key: string, positive = false): string => {
    const result = item[key]
    if (typeof result !== 'string' || !/^(0|[1-9]\d*)$/.test(result) || (positive && result === '0')) throw new Error(`invalid helper ${key}`)
    return result
  }
  if (typeof item.valid !== 'boolean' || !Array.isArray(item.validityReasons) ||
      item.validityReasons.some((reason) => typeof reason !== 'string') ||
      typeof item.oraclePassed !== 'boolean' || typeof item.oracleDetail !== 'string' || typeof item.oracleNonce !== 'string' ||
      typeof item.clockSource !== 'string' || item.clockSource.length === 0 ||
      typeof item.timedOut !== 'boolean' || !Array.isArray(item.perf) || !Array.isArray(item.energy) || !Array.isArray(item.adapterStatus) ||
      !Array.isArray(item.sensors) || !sha(item.stdoutSha256) || !sha(item.stderrSha256)) throw new Error('invalid helper response')
  object(item.controlsBefore); object(item.controlsAfter)
  const affinity = object(item.affinity), requested = integerArray(affinity.requested), effective = integerArray(affinity.effective)
  const context = item.contextSwitches===null?null:object(item.contextSwitches), faults = item.faults===null?null:object(item.faults)
  for (const counter of item.perf) {
    const value = object(counter)
    if (Object.keys(value).sort().join(',') !== 'group,name,raw,scaled,timeEnabledNs,timeRunningNs' ||
        typeof value.name !== 'string' || typeof value.group !== 'string' || !decimalText(value.raw) ||
        !decimalText(value.timeEnabledNs) || !decimalText(value.timeRunningNs) ||
        !(value.scaled === null || decimalText(value.scaled))) throw new Error('invalid perf evidence')
  }
  for (const reading of item.energy) if (typeof object(reading).supported !== 'boolean') throw new Error('invalid energy evidence')
  for(const status of item.adapterStatus){const value=object(status);if(typeof value.adapter!=='string'||typeof value.required!=='boolean'||typeof value.supported!=='boolean'||(value.reason!==undefined&&typeof value.reason!=='string'))throw new Error('invalid adapter status')}
  for (const number of [...(context?[context.voluntary,context.involuntary]:[]),...(faults?[faults.minor,faults.major]:[])]) if (!Number.isSafeInteger(number) || Number(number) < 0) throw new Error('invalid helper evidence count')
  if (item.valid && (item.validityReasons.length !== 0 || !item.oraclePassed || requested.join(',') !== effective.join(',') ||
      item.timedOut || (item.exitCode !== 0))) throw new Error('valid helper response lacks required evidence')
  return {
    ...item, monotonicStartedNs: decimal('monotonicStartedNs', true),
    monotonicDurationNs: decimal('monotonicDurationNs', true), userCpuNs: decimal('userCpuNs'),
    systemCpuNs: decimal('systemCpuNs'), clockUncertaintyNs: decimal('clockUncertaintyNs'), affinity: { requested, effective },
    contextSwitches: context as unknown as HelperRunResponse['contextSwitches'],
    faults: faults as unknown as HelperRunResponse['faults'],
  } as HelperRunResponse
}

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('helper object required'); return value as Record<string, unknown> }
function integerArray(value: unknown): number[] { if (!Array.isArray(value) || value.length === 0 || value.some((item) => !Number.isSafeInteger(item) || Number(item) < 0)) throw new Error('invalid affinity array'); return value as number[] }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const decimalText = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
