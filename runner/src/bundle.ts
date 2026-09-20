import {
  closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { buildEmpiricalSchedule, canonicalJson, type JsonValue } from '@isa-sim/contracts'
import type { Identity } from './identity.js'
import { sha256 } from './identity.js'
import type { RawRunRecord, ScheduleRecord, Signed } from './types.js'

export interface BundleHeader {
  kind: 'header'
  schemaVersion: '1'
  jobId: string
  runnerId: string
  testOnly: boolean
  createdAt: string
}
export interface BundleIndex {
  kind: 'index'
  schemaVersion: '1'
  runnerId: string
  jobId: string
  sha256: string
  byteSize: string
  recordCount: number
  artifactIdentities: string[]
}
export interface FinalizedBundle {
  path: string
  index: BundleIndex
  signature: Signed<BundleIndex>
}

export class RawBundleWriter {
  private descriptor: number
  private records = 0
  private recovered: Array<RawRunRecord | ScheduleRecord> = []
  private bytesSinceSync = 0
  private readonly header: BundleHeader
  constructor(
    readonly partialPath: string,
    header: BundleHeader,
    private readonly fsyncEveryBytes = 64 * 1024,
  ) {
    validateSafeId(header.jobId)
    this.header = validateHeader(header)
    mkdirSync(dirname(partialPath), { recursive: true })
    const recovering = existsSync(partialPath)
    this.descriptor = openSync(partialPath, 'a+')
    if (recovering) {
      const recovered = recoverJsonl(partialPath)
      if (canonicalJson(recovered.header as unknown as JsonValue) !== canonicalJson(this.header as unknown as JsonValue)) throw new Error('recovering bundle header mismatch')
      recovered.records.forEach(validateBundleRecord)
      this.recovered = recovered.records
      this.records = recovered.records.length
    } else {
      this.appendLine(header)
      fsyncSync(this.descriptor)
    }
  }
  recoveredRecords(): readonly (RawRunRecord | ScheduleRecord)[] { return this.recovered }
  append(record: RawRunRecord | ScheduleRecord): void {
    validateBundleRecord(record)
    this.appendLine(record)
    this.records += 1
  }
  finalize(identity: Identity, artifactIdentities: string[] = []): FinalizedBundle {
    fsyncSync(this.descriptor)
    closeSync(this.descriptor)
    const body = readFileSync(this.partialPath)
    const index: BundleIndex = {
      kind: 'index', schemaVersion: '1', runnerId: this.header.runnerId, jobId: this.header.jobId,
      sha256: sha256(body), byteSize: body.byteLength.toString(), recordCount: this.records,
      artifactIdentities: artifactIdentities.map(validHash),
    }
    const indexLine = Buffer.from(`${canonicalJson(index as unknown as JsonValue)}\n`)
    const fd = openSync(this.partialPath, 'a')
    writeAll(fd, indexLine)
    fsyncSync(fd)
    closeSync(fd)
    if (identity.value.runnerId !== this.header.runnerId) throw new Error('bundle identity mismatch')
    const finalPath = this.partialPath.replace(/\.partial$/, '') || `${this.partialPath}.final`
    const signaturePath = `${finalPath}.signature.json`
    const metadataPath = `${finalPath}.finalize.json`
    let signature: Signed<BundleIndex>
    if (existsSync(metadataPath)) {
      const metadata = object(JSON.parse(readFileSync(metadataPath, 'utf8')))
      signature = metadata.signature as Signed<BundleIndex>
      if (canonicalJson(metadata.index as JsonValue) !== canonicalJson(index as unknown as JsonValue) ||
          !verifySigned(signature, identity.value.publicKey) ||
          canonicalJson(signature.payload as unknown as JsonValue) !== canonicalJson(index as unknown as JsonValue)) throw new Error('bundle finalization metadata mismatch')
    } else {
      signature = identity.sign(index)
      const stagedMetadata = `${metadataPath}.${process.pid}.tmp`
      const metadataFd = openSync(stagedMetadata, 'wx', 0o600)
      writeAll(metadataFd, Buffer.from(JSON.stringify({ index, signature }))); fsyncSync(metadataFd); closeSync(metadataFd)
      renameSync(stagedMetadata, metadataPath); fsyncParent(metadataPath)
    }
    if (existsSync(finalPath)) throw new Error('bundle finalization collision')
    if (existsSync(signaturePath)) {
      if (readFileSync(signaturePath, 'utf8') !== JSON.stringify(signature)) throw new Error('bundle signature collision')
      renameSync(this.partialPath, finalPath)
      fsyncParent(finalPath)
      return { path: finalPath, index, signature }
    }
    const stagedSignature = `${signaturePath}.${process.pid}.tmp`
    const signatureFd = openSync(stagedSignature, 'wx', 0o600)
    writeAll(signatureFd, Buffer.from(JSON.stringify(signature)))
    fsyncSync(signatureFd)
    closeSync(signatureFd)
    renameSync(stagedSignature, signaturePath)
    fsyncParent(signaturePath)
    renameSync(this.partialPath, finalPath)
    fsyncParent(finalPath)
    return { path: finalPath, index, signature }
  }
  private appendLine(value: unknown): void {
    const bytes = Buffer.from(`${canonicalJson(value as JsonValue)}\n`)
    writeAll(this.descriptor, bytes)
    this.bytesSinceSync += bytes.byteLength
    if (this.bytesSinceSync >= this.fsyncEveryBytes) {
      fsyncSync(this.descriptor)
      this.bytesSinceSync = 0
    }
  }
}

export function verifyBundle(
  path: string,
  production = true,
  expected?: { runnerId: string; jobId: string; publicKey: string },
): BundleIndex {
  const before = statSync(path)
  const bytes = readFileSync(path)
  if (bytes.at(-1) !== 0x0a) throw new Error('torn bundle final line')
  const lines = bytes.toString('utf8').split('\n').slice(0, -1)
  if (lines.some((line) => line.length === 0)) throw new Error('empty bundle record')
  const header = validateHeader(JSON.parse(lines[0] ?? '{}'))
  if (production && header.testOnly !== false) throw new Error('synthetic/test-only bundles are forbidden')
  const index = validateIndex(JSON.parse(lines.at(-1) ?? '{}'))
  const records = lines.slice(1, -1).map((line) => validateBundleRecord(JSON.parse(line)))
  const schedules = records.filter((record): record is ScheduleRecord => record.kind === 'schedule')
  if (production && schedules.length !== 1) throw new Error('production bundle requires one signed schedule')
  if (index.recordCount !== records.length || index.runnerId !== header.runnerId || index.jobId !== header.jobId) throw new Error('bundle index binding mismatch')
  if (expected && (header.runnerId !== expected.runnerId || header.jobId !== expected.jobId)) throw new Error('bundle owner/job mismatch')
  const indexLineBytes = Buffer.byteLength(`${lines.at(-1)}\n`)
  const body = bytes.subarray(0, bytes.byteLength - indexLineBytes)
  if (sha256(body) !== index.sha256 || body.byteLength.toString() !== index.byteSize) throw new Error('bundle index mismatch')
  const after = statSync(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('bundle changed during verification')
  if (expected) {
    for (const schedule of schedules) {
      const payload = { jobId: schedule.jobId, seed: schedule.seed, entries: schedule.entries, protocol: schedule.protocol }
      if (schedule.jobId !== expected.jobId || JSON.stringify(schedule.signed.payload) !== JSON.stringify(payload) ||
          !verifySigned(schedule.signed, expected.publicKey)) throw new Error('schedule signature mismatch')
    }
    const signature = JSON.parse(readFileSync(`${path}.signature.json`, 'utf8')) as Signed<BundleIndex>
      if (canonicalJson(signature.payload as unknown as JsonValue) !== canonicalJson(index as unknown as JsonValue) || signature.keyId === '' ||
        !verifySigned(signature, expected.publicKey)) throw new Error('bundle signature/index mismatch')
  }
  return index
}

export function bundlePaths(root: string, jobId: string): { partial: string; final: string } {
  validateSafeId(jobId)
  return { partial: join(root, `${jobId}.jsonl.partial`), final: join(root, `${jobId}.jsonl`) }
}

import { verifySigned } from './identity.js'

function validateHeader(value: unknown): BundleHeader {
  const item = object(value)
  const keys = Object.keys(item).sort().join(',')
  if (keys !== 'createdAt,jobId,kind,runnerId,schemaVersion,testOnly' || item.kind !== 'header' ||
      item.schemaVersion !== '1' || typeof item.testOnly !== 'boolean' || !validDate(item.createdAt)) throw new Error('invalid bundle header')
  validateSafeId(String(item.jobId))
  if (!/^runner:[a-f0-9]{64}$/.test(String(item.runnerId))) throw new Error('invalid bundle runner ID')
  return item as unknown as BundleHeader
}
function validateIndex(value: unknown): BundleIndex {
  const item = object(value)
  if (item.kind !== 'index' || item.schemaVersion !== '1' || !/^[a-f0-9]{64}$/.test(String(item.sha256)) ||
      !/^(0|[1-9]\d*)$/.test(String(item.byteSize)) || !Number.isSafeInteger(item.recordCount) ||
      !Array.isArray(item.artifactIdentities) || item.artifactIdentities.some((hash) => !/^[a-f0-9]{64}$/.test(String(hash)))) {
    throw new Error('invalid bundle index')
  }
  return item as unknown as BundleIndex
}
function validateRawRecord(value: unknown): RawRunRecord {
  const item = object(value)
  if (item.kind !== 'raw-run' || !['pilot', 'warmup', 'measured', 'idle'].includes(String(item.phase)) ||
      typeof item.valid !== 'boolean' || !Array.isArray(item.validityReasons) ||
      !/^(0|[1-9]\d*)$/.test(String(item.monotonicDurationNs)) || !Number.isSafeInteger(item.ordinal) ||
      typeof item.pairId !== 'string' || typeof item.timedOut !== 'boolean' || !object(item.oracle) ||
      !object(item.affinity) || (item.contextSwitches!==null&&!object(item.contextSwitches)) || (item.faults!==null&&!object(item.faults)) || !object(item.clock) ||
      !Array.isArray(item.adapterStatus) || !Array.isArray(item.perf) || !Array.isArray(item.energy)) throw new Error('invalid raw bundle record')
  return item as unknown as RawRunRecord
}
function validateBundleRecord(value: unknown): RawRunRecord | ScheduleRecord {
  const item = object(value)
  if (item.kind === 'schedule') {
    if (!Array.isArray(item.entries) || typeof item.seed !== 'string' || typeof item.jobId !== 'string' || !validScheduleProtocol(item.protocol) || !object(item.signed)) throw new Error('invalid schedule record')
    return item as unknown as ScheduleRecord
  }
  return validateRawRecord(value)
}
function validScheduleProtocol(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const protocol = value as { warmups?: { count?: unknown }; pairedMeasurements?: { repetitions?: unknown } }
  try {
    return canonicalJson(value as JsonValue) === canonicalJson(buildEmpiricalSchedule('validation-only', Number(protocol.pairedMeasurements?.repetitions), Number(protocol.warmups?.count)).protocol as unknown as JsonValue)
  } catch { return false }
}
function recoverJsonl(path: string): { header: BundleHeader; records: Array<RawRunRecord | ScheduleRecord> } {
  const bytes = readFileSync(path)
  let complete = bytes.lastIndexOf(0x0a)
  if (complete < 0) throw new Error('partial bundle has no complete header')
  if (complete !== bytes.byteLength - 1) {
    const fd = openSync(path, 'r+'); ftruncateSync(fd, complete + 1); fsyncSync(fd); closeSync(fd); fsyncParent(path)
  }
  const lines = bytes.subarray(0, complete + 1).toString('utf8').split('\n').slice(0, -1)
  const last = lines.at(-1)
  if (last) {
    try {
      if (object(JSON.parse(last)).kind === 'index') {
        const shortened = Buffer.byteLength(`${lines.slice(0, -1).join('\n')}\n`)
        const fd = openSync(path, 'r+'); ftruncateSync(fd, shortened); fsyncSync(fd); closeSync(fd)
        lines.pop()
      }
    } catch { /* Raw-record validation below reports malformed complete lines. */ }
  }
  if (lines.some((line) => line.length === 0)) throw new Error('empty partial record')
  return { header: validateHeader(JSON.parse(lines[0] ?? '{}')), records: lines.slice(1).map((line) => validateBundleRecord(JSON.parse(line))) }
}
function writeAll(fd: number, bytes: Buffer): void { let offset = 0; while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (count <= 0) throw new Error('short bundle write'); offset += count } }
function fsyncParent(path: string): void { try { const fd = openSync(dirname(path), 'r'); fsyncSync(fd); closeSync(fd) } catch { /* Windows may not fsync directories. */ } }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required'); return value as Record<string, unknown> }
function validDate(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function validHash(value: string): string { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid artifact hash'); return value }
function validateSafeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || /[. ]$/.test(value) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) throw new Error('unsafe job ID')
}
