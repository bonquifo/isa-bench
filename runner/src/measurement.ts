import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { CapabilityManifest, CorpusEligibility, JobSpec, RawRunRecord, Signed } from './types.js'
import type { ScheduleRecord } from './types.js'
import type { Identity } from './identity.js'
import { sha256, verifySigned } from './identity.js'
import { parseHelperRunResponse, type HelperRunRequest, type HelperRunResponse } from './helper-protocol.js'
import { selectInnerIterations } from './schedule.js'
import { buildEmpiricalSchedule, parseEmpiricalAdapter } from '@isa-sim/contracts'

export interface HelperClient {
  request(request: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface RunOptions {
  allowRealJob: true
  corpus: CorpusEligibility
  capabilities: Signed<CapabilityManifest>
  lockRoot: string
  identity: Identity
  bundleRecord(record: RawRunRecord | ScheduleRecord): void
  temperature(): Promise<number | null>
  sleep(ms: number): Promise<void>
  resume?: { innerIterations: string; matchedDurationNs: string; completedOrdinals: readonly number[]; schedulePresent: true }
  existingSchedule?: boolean
}

export function assertCorpusEligible(job: JobSpec, record: CorpusEligibility, hostIsa: string): void {
  if (!record.eligible || record.hostIsa !== hostIsa || record.hostIsa !== job.target.isa ||
      record.os !== job.target.os || record.abi !== job.target.abi ||
      record.corpusId !== job.binary.corpusId || record.sha256 !== job.binary.sha256 ||
      record.size !== job.binary.size) throw new Error('corpus eligibility mismatch')
}

export function hashFileStable(path: string): { sha256: string; size: string } {
  const before = statSync(path)
  if (!before.isFile()) throw new Error('eligible binary is not a regular file')
  const bytes = readFileSync(path)
  const after = statSync(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('binary changed while hashing')
  }
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength.toString() }
}

export class MeasurementRunner {
  constructor(private readonly helper: HelperClient) {}

  async run(job: JobSpec, options: RunOptions): Promise<{ innerIterations: string; measured: number }> {
    if (options.allowRealJob !== true) throw new Error('run requires explicit real job authorization')
    assertCorpusEligible(job, options.corpus, process.arch)
    if (!verifySigned(options.capabilities, options.identity.value.publicKey)) throw new Error('capability manifest signature invalid')
    const capabilities = options.capabilities.payload
    assertCapabilityMatch(job, capabilities)
    const release = acquireLock(options.lockRoot, `${job.target.isa}-exclusive`)
    let restoreTransaction: string | undefined
    let signalHandler: (()=>void)|undefined
    try {
      await awaitThermalQuiescence(options, job.thresholds.maxTemperatureC)
      const controlEntries = Object.entries(job.controls).filter(([key]) => key !== 'affinity')
      for (const [key] of controlEntries) if (key !== 'turbo' && !/^cpu\d+\.(governor|min_khz|max_khz)$/.test(key)) throw new Error(`unknown control ${key}`)
      const controls = Object.fromEntries(controlEntries)
      const control = Object.keys(controls).length === 0
        ? { verified: true }
        : await this.helper.request({
            operation: 'controls', controls,
            transaction: resolve(options.lockRoot, `${job.jobId}.restore.json`),
          })
      restoreTransaction = typeof control.restoreTransaction === 'string' ? control.restoreTransaction : undefined
      if(restoreTransaction){signalHandler=()=>{void this.helper.request({operation:'restore',transaction:restoreTransaction}).finally(()=>process.exit(143))};process.once('SIGINT',signalHandler);process.once('SIGTERM',signalHandler)}
      if (control.verified !== true) throw new Error('control read-back verification failed')
      const controlSnapshots = { before: stringRecord(control.controlsBefore), after: stringRecord(control.controlsAfter) }
      const { entries: schedule, protocol } = buildEmpiricalSchedule(job.seed, job.repetitions ?? 32, job.warmups ?? 5)
      const schedulePayload = {
        jobId: job.jobId, seed: job.seed, entries: schedule, protocol,
      }
      if (!options.resume?.schedulePresent && !options.existingSchedule) options.bundleRecord({ kind: 'schedule', ...schedulePayload, signed: options.identity.sign(schedulePayload) })
      const cpus = selectCpus(job, capabilities)
      if (!options.resume) {
        const overhead = await this.idle(job,1_000_000n, -1, -100, 'instrumentation-overhead', cpus, controlSnapshots)
        options.bundleRecord(overhead.record)
      }
      let inner = options.resume ? BigInt(options.resume.innerIterations) : 1n
      let pilotDuration = options.resume ? BigInt(options.resume.matchedDurationNs) : 0n
      for (let attempt = 0; !options.resume && attempt < 8; attempt += 1) {
        const pilot = await this.execute(job, options.corpus, inner, 'pilot', -1, 'A', -1 - attempt, `pilot-${attempt}`, cpus, controlSnapshots)
        options.bundleRecord(pilot.record)
        if (!pilot.record.valid) throw new Error(`pilot invalid: ${pilot.record.validityReasons.join(', ')}`)
        pilotDuration = BigInt(pilot.record.monotonicDurationNs)
        if (pilotDuration >= 100_000_000n && pilotDuration <= 500_000_000n) break
        if (pilotDuration > 500_000_000n && inner === 1n) throw new Error('single iteration exceeds pilot bound')
        inner = selectInnerIterations(pilotDuration, inner)
      }
      if (pilotDuration < 100_000_000n || pilotDuration > 500_000_000n) throw new Error('pilot failed to converge')
      let measured = 0
      const completed = new Set(options.resume?.completedOrdinals ?? [])
      for (const entry of schedule) {
        if (completed.has(entry.ordinal)) { if (entry.phase === 'measured') measured += 1; continue }
        let result: { record: RawRunRecord }
        try {
          result = entry.phase === 'idle'
            ? await this.idle(job,pilotDuration, entry.block, entry.ordinal, entry.pairId, cpus, controlSnapshots)
            : await this.execute(job, options.corpus, inner, entry.phase, entry.block, entry.arm, entry.ordinal, entry.pairId, cpus, controlSnapshots)
        } catch (error) {
          options.bundleRecord(invalidRecord(entry.phase, entry.block, entry.arm, entry.ordinal, entry.pairId, error))
          throw error
        }
        options.bundleRecord(result.record)
        if (entry.phase === 'measured') measured += 1
        if (result.record.temperatureC !== null && job.thresholds.maxTemperatureC !== undefined &&
            result.record.temperatureC > job.thresholds.maxTemperatureC) throw new Error('thermal abort threshold exceeded')
        if (result.record.throttle) throw new Error('throttling evidence observed')
      }
      return { innerIterations: inner.toString(), measured }
    } finally {
      if(signalHandler){process.off('SIGINT',signalHandler);process.off('SIGTERM',signalHandler)}
      await restoreAndRelease(this.helper, restoreTransaction, release)
    }
  }

  private async execute(
    job: JobSpec, corpus: CorpusEligibility, iterations: bigint,
    phase: RawRunRecord['phase'], block: number, arm: 'A' | 'B', ordinal: number, pairId: string, cpus: number[],
    controls: { before: Record<string,string>; after: Record<string,string> },
  ): Promise<{ record: RawRunRecord }> {
    const current = hashFileStable(corpus.binaryPath)
    if (current.sha256 !== job.binary.sha256 || current.size !== job.binary.size) throw new Error('binary mutation detected')
    const request: HelperRunRequest = {
      operation: 'run',
      binary: { path: resolve(corpus.binaryPath), sha256: job.binary.sha256, size: job.binary.size, corpusId: corpus.corpusId },
      argv: [...job.argv], iterations: iterations.toString(), cpus,
      timeoutMs: 30_000,
      jobNonce: job.nonce, corpusIdentity: sha256(corpus.corpusId),
      adapters: [...job.adapters],
    }
    const response = parseHelperRunResponse(await this.helper.request({ ...request }))
    const record = normalizeRecord(response, phase, block, arm, ordinal, pairId)
    record.controlsBefore=controls.before;record.controlsAfter=controls.after
    enforceEvidence(job, response, record)
    return { record }
  }
  private async idle(job:JobSpec,duration: bigint, block: number, ordinal: number, pairId: string, cpus: number[], controls: { before: Record<string,string>; after: Record<string,string> }): Promise<{ record: RawRunRecord }> {
    const response = parseHelperRunResponse(await this.helper.request({ operation: 'idle', durationNs: duration.toString(), cpus,adapters:[...job.adapters] }))
    const record=normalizeRecord(response, 'idle', block, 'B', ordinal, pairId);record.controlsBefore=controls.before;record.controlsAfter=controls.after
    enforceEvidence(job,response,record)
    return { record }
  }
}

async function restoreAndRelease(helper: HelperClient, transaction: string | undefined, release: () => void): Promise<void> {
  let failure: unknown
  try {
    if (transaction) {
      const restored = await helper.request({ operation: 'restore', transaction })
      if (restored.restored !== true) throw new Error('control restore was not verified')
    }
  } catch (error) { failure = error }
  release()
  if (failure) throw failure
}

function assertCapabilityMatch(job: JobSpec, capabilities: CapabilityManifest): void {
  if (capabilities.runnerId !== job.runnerId || Date.parse(capabilities.expiresAt) <= Date.now()) {
    throw new Error('capability manifest unavailable or expired')
  }
  if (capabilities.host.os.status !== 'supported' || capabilities.host.os.value.platform !== job.target.os) throw new Error('host OS capability mismatch')
  if (capabilities.host.arch.status !== 'supported' || canonicalIsa(capabilities.host.arch.value) !== canonicalIsa(job.target.isa)) throw new Error('host ISA capability mismatch')
  if (capabilities.host.abi.status !== 'supported' || capabilities.host.abi.value !== job.target.abi) throw new Error('host ABI capability mismatch')
  if (capabilities.clock.status !== 'supported') throw new Error('required raw clock capability unavailable')
  if (job.thresholds.maxTemperatureC !== undefined && capabilities.thermal.status !== 'supported') throw new Error('required thermal capability unavailable')
  if (Object.keys(job.controls).some((key) => key !== 'affinity') && capabilities.frequency.status !== 'supported') throw new Error('required control capability unavailable')
  for (const adapter of job.adapters) {
    const policy=parseEmpiricalAdapter(adapter)
    if (policy.required&&policy.name.startsWith('rapl') && capabilities.energy.status !== 'supported') throw new Error('required energy capability unavailable')
    if (policy.required&&policy.name === 'linux-perf' && capabilities.pmu.status !== 'supported') throw new Error('required PMU capability unavailable')
  }
}
function canonicalIsa(value: string): string {
  return value === 'x64' || value === 'x86_64' ? 'x86_64' : value === 'arm64' || value === 'aarch64' ? 'aarch64' : value
}

async function awaitThermalQuiescence(options: RunOptions, threshold?: number): Promise<void> {
  if (threshold === undefined) return
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = await options.temperature()
    if (value === null) throw new Error('required thermal sensor unavailable')
    if (value <= threshold) return
    await options.sleep(500)
  }
  throw new Error('thermal quiescence timeout')
}

function acquireLock(root: string, name: string): () => void {
  const path = resolve(root, `${name}.lock`)
  mkdirSync(dirname(path), { recursive: true })
  const descriptor = openSync(path, 'wx', 0o600)
  return () => { closeSync(descriptor); rmSync(path, { force: true }) }
}

function normalizeRecord(value: HelperRunResponse, phase: RawRunRecord['phase'], block: number, arm: 'A' | 'B', ordinal: number, pairId: string): RawRunRecord {
  const valid = value.valid
  return {
    kind: 'raw-run', sampleId: crypto.randomUUID(), phase, block, arm, ordinal, pairId, valid,
    validityReasons: value.validityReasons,
    monotonicStartedNs: value.monotonicStartedNs, monotonicDurationNs: value.monotonicDurationNs,
    userCpuNs: value.userCpuNs, systemCpuNs: value.systemCpuNs,
    timedOut: value.timedOut,
    exitCode: value.exitCode, signal: value.signal === null ? null : String(value.signal),
    stdoutSha256: value.stdoutSha256, stderrSha256: value.stderrSha256,
    oracle: { passed: value.oraclePassed, detail: value.oracleDetail, iterations: value.oracleIterations, nonce: value.oracleNonce },
    affinity: value.affinity, contextSwitches: value.contextSwitches, migrations: value.migrations, faults: value.faults,
    clock: { source: value.clockSource, uncertaintyNs: value.clockUncertaintyNs },
    adapterStatus:value.adapterStatus,
    perf: value.perf, energy: value.energy, sensorStreamRefs: [],
    temperatureC: typeof value.temperatureC === 'number' ? value.temperatureC : null,
    frequencyKHz: typeof value.frequencyKHz === 'string' ? value.frequencyKHz : null,
    throttle: typeof value.throttle === 'boolean' ? value.throttle : null,
    controlsBefore: stringRecord(value.controlsBefore), controlsAfter: stringRecord(value.controlsAfter),
  }
}
function selectCpus(job: JobSpec, capabilities: CapabilityManifest): number[] {
  if (capabilities.cpu.topology.status !== 'supported') throw new Error('validated topology unavailable')
  const topology = capabilities.cpu.topology.value
  const requested = typeof job.controls.affinity === 'string'
    ? job.controls.affinity.split(',').map((item) => Number(item))
    : [0]
  if (requested.length === 0 || requested.some((cpu) => !Number.isSafeInteger(cpu) || cpu < 0 || cpu >= topology.logicalCpus)) throw new Error('requested affinity unavailable')
  return requested
}
function invalidRecord(phase: RawRunRecord['phase'], block: number, arm: 'A'|'B', ordinal: number, pairId: string, error: unknown): RawRunRecord {
  return { kind:'raw-run',sampleId:crypto.randomUUID(),phase,block,arm,ordinal,pairId,valid:false,validityReasons:[`protocol-failure:${error instanceof Error?error.message:String(error)}`],monotonicStartedNs:'0',monotonicDurationNs:'0',userCpuNs:'0',systemCpuNs:'0',timedOut:false,exitCode:null,signal:null,stdoutSha256:sha256(''),stderrSha256:sha256(''),oracle:{passed:false,detail:'helper protocol failed',iterations:'0',nonce:''},affinity:{},contextSwitches:{voluntary:0,involuntary:0},migrations:null,faults:{minor:0,major:0},clock:{source:'unavailable',uncertaintyNs:'0'},adapterStatus:[],perf:[],energy:[],sensorStreamRefs:[],temperatureC:null,frequencyKHz:null,throttle:null,controlsBefore:{},controlsAfter:{} }
}
function enforceEvidence(job: JobSpec, response: HelperRunResponse, record: RawRunRecord): void {
  const reject = (reason: string): void => { if (!record.validityReasons.includes(reason)) record.validityReasons.push(reason); record.valid = false }
  for(const adapter of job.adapters){const policy=parseEmpiricalAdapter(adapter),status=response.adapterStatus.find(item=>item.adapter===policy.name);if(!status||status.required!==policy.required)reject(`adapter-status-missing:${policy.name}`);else if(policy.required&&!status.supported)reject(`required-adapter-unavailable:${policy.name}`)}
  if (job.adapters.some(adapter=>{const policy=parseEmpiricalAdapter(adapter);return policy.required&&policy.name==='linux-perf'})) {
    if (response.perf.length === 0) reject('required-perf-evidence-unavailable')
    const minimum = job.thresholds.maxPmuMultiplexRatio === undefined ? 0.98 : 1 - job.thresholds.maxPmuMultiplexRatio
    if (response.perf.some((counter) => BigInt(counter.timeRunningNs) * 1_000_000n < BigInt(counter.timeEnabledNs) * BigInt(Math.floor(minimum * 1_000_000)))) reject('pmu-running-ratio-below-threshold')
  }
  if (job.adapters.some((adapter) => {const policy=parseEmpiricalAdapter(adapter);return policy.required&&policy.name.startsWith('rapl')}) && !response.energy.some((item) => item.supported)) reject('required-energy-evidence-unavailable')
  if (job.thresholds.maxClockUncertaintyNs !== undefined && BigInt(response.clockUncertaintyNs) > BigInt(job.thresholds.maxClockUncertaintyNs)) reject('clock-uncertainty-threshold')
  if (job.thresholds.maxTemperatureC !== undefined && (response.temperatureC === null || response.throttle === null)) reject('required-thermal-evidence-unavailable')
  if (Object.keys(job.controls).some((key) => key !== 'affinity') &&
      (Object.keys(response.controlsBefore).length === 0 || Object.keys(response.controlsAfter).length === 0)) reject('control-snapshot-unavailable')
}
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const stringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(asRecord(value)).map(([key, item]) => [key, String(item)]))
