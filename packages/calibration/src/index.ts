import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { buildEmpiricalSchedule, canonicalJson, decodeCanonicalBase64, type JsonValue } from '@isa-sim/contracts'

export const CALIBRATION_CORE_VERSION = '0.1.0' as const

export interface ImportLimits {
  maxCompressedBytes: number
  maxExpandedBytes: number
  maxFiles: number
  maxFileBytes: number
  maxPathBytes: number
  maxNameBytes: number
  maxDepth: number
  maxNestedArchives: number
  maxDecompressionRatio: number
  maxJsonLineBytes: number
  maxRecords: number
}

export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  maxCompressedBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxFiles: 4096,
  maxFileBytes: 64 * 1024 * 1024,
  maxPathBytes: 1024,
  maxNameBytes: 255,
  maxDepth: 16,
  maxNestedArchives: 0,
  maxDecompressionRatio: 100,
  maxJsonLineBytes: 8 * 1024 * 1024,
  maxRecords: 1_000_000,
})

export type ImportSeverity = 'error' | 'warning' | 'info'
export interface ImportReason {
  code: string
  severity: ImportSeverity
  path?: string
  detail: string
}
export interface ArtifactClaim {
  name: string
  sha256: string
  byteSize: number | string
  mimeType: string
}
export interface ArchiveEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'device' | 'fifo'
  size: number
}
export interface InspectionContext {
  production: boolean
  now?: number
  bundleHash?: string
  signedIndex?: SignedEnvelope<JsonValue>
  artifactFiles?: ReadonlyMap<string, Uint8Array>
  seenBundleHashes?: ReadonlySet<string>
  expected?: Partial<{
    runnerId: string
    jobId: string
    leaseId: string
    leaseNonce: string
    binarySha256: string
    buildId: string
    corpusArtifactId: string
    roiDefinitionHash: string
    target: JsonValue
    seed: string
    repetitions: number
    warmups: number
    adapters: readonly string[]
    controls: Readonly<Record<string, JsonValue>>
  }>
  runner?: {
    id: string
    keyId: string
    publicKey: string
    stateAtMeasurement: string
    stateAtImport: string
    credentialIssuedAt: string
    credentialExpiresAt: string
    revokedAt?: string
  }
}
export interface BundleInspection {
  accepted: boolean
  bundleHash: string
  format: 'jsonl'
  header: Record<string, unknown> | null
  index: Record<string, unknown> | null
  records: readonly Record<string, unknown>[]
  reasons: readonly ImportReason[]
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i
const HASH = /^[a-f0-9]{64}$/
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/

export function normalizeEvidencePath(input: string, limits = DEFAULT_IMPORT_LIMITS): string {
  if (!input || input.includes('\0') || Buffer.byteLength(input) > limits.maxPathBytes) throw new Error('unsafe path length or NUL')
  const path = input.replaceAll('\\', '/')
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('//')) throw new Error('absolute evidence path')
  const parts = path.split('/')
  if (parts.length > limits.maxDepth || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('unsafe evidence path depth/component')
  for (const part of parts) {
    if (Buffer.byteLength(part) > limits.maxNameBytes || /[. ]$/.test(part) || part.includes(':') || WINDOWS_RESERVED.test(part)) {
      throw new Error('unsafe Windows evidence name')
    }
  }
  return parts.join('/')
}

export function inspectArchiveEntries(entries: readonly ArchiveEntry[], compressedBytes: number, limits = DEFAULT_IMPORT_LIMITS): ImportReason[] {
  const reasons: ImportReason[] = []
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 1 || compressedBytes > limits.maxCompressedBytes) {
    reasons.push(reason('compressed-size', 'compressed input exceeds limit'))
  }
  if (entries.length > limits.maxFiles) reasons.push(reason('file-count', 'archive file count exceeds limit'))
  const names = new Set<string>()
  let expanded = 0
  for (const entry of entries) {
    let normalized = ''
    try { normalized = normalizeEvidencePath(entry.name, limits) } catch (error) {
      reasons.push(reason('unsafe-path', message(error), entry.name)); continue
    }
    const folded = normalized.normalize('NFC').toLocaleLowerCase('en-US')
    if (names.has(folded)) reasons.push(reason('duplicate-name', 'duplicate normalized/case-folded name', normalized))
    names.add(folded)
    if (!['file', 'directory'].includes(entry.type)) reasons.push(reason('special-entry', `${entry.type} entries are forbidden`, normalized))
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes) reasons.push(reason('file-size', 'entry size exceeds limit', normalized))
    if (entry.type === 'file') expanded += entry.size
    if (!Number.isSafeInteger(expanded) || expanded > limits.maxExpandedBytes) reasons.push(reason('expanded-size', 'expanded archive exceeds limit'))
    if (/\.(?:zip|tar|tgz|gz|bz2|xz|zst)$/i.test(normalized)) reasons.push(reason('nested-archive', 'nested archives are forbidden', normalized))
  }
  if (compressedBytes > 0 && expanded / compressedBytes > limits.maxDecompressionRatio) reasons.push(reason('decompression-ratio', 'archive decompression ratio exceeds limit'))
  return deduplicateReasons(reasons)
}

export function parseTarIndex(bytes: Uint8Array, compressedBytes = bytes.byteLength, limits = DEFAULT_IMPORT_LIMITS): { entries: ArchiveEntry[]; reasons: ImportReason[] } {
  if (bytes.byteLength > limits.maxExpandedBytes) return { entries: [], reasons: [reason('expanded-size', 'expanded archive exceeds limit')] }
  const entries: ArchiveEntry[] = []
  const view = Buffer.from(bytes)
  let offset = 0
  while (offset + 512 <= view.length) {
    const block = view.subarray(offset, offset + 512)
    if (block.every((value) => value === 0)) {
      const remainder = view.subarray(offset)
      if (remainder.byteLength < 1024 || remainder.some((value) => value !== 0)) return { entries, reasons: [reason('tar-trailing-data', 'tar footer is truncated or followed by hidden data')] }
      break
    }
    const declaredChecksumText = nulText(block.subarray(148, 156)).trim()
    if (!/^[0-7]+$/.test(declaredChecksumText)) return { entries, reasons: [reason('tar-header', 'invalid tar checksum field')] }
    const declaredChecksum = Number.parseInt(declaredChecksumText, 8)
    let actualChecksum = 0
    for (let index = 0; index < block.length; index += 1) actualChecksum += index >= 148 && index < 156 ? 32 : block[index]!
    if (actualChecksum !== declaredChecksum) return { entries, reasons: [reason('tar-checksum', 'tar header checksum mismatch')] }
    const name = nulText(block.subarray(0, 100))
    const prefix = nulText(block.subarray(345, 500))
    const fullName = prefix ? `${prefix}/${name}` : name
    const sizeText = nulText(block.subarray(124, 136)).trim()
    if (!/^[0-7]*$/.test(sizeText)) return { entries, reasons: [reason('tar-header', 'invalid tar size field', fullName)] }
    const size = Number.parseInt(sizeText || '0', 8)
    const typeByte = block[156] ?? 0
    const type: ArchiveEntry['type'] =
      typeByte === 0 || typeByte === 48 ? 'file' :
      typeByte === 53 ? 'directory' :
      typeByte === 50 ? 'symlink' :
      typeByte === 49 ? 'hardlink' :
      typeByte === 54 ? 'fifo' : 'device'
    entries.push({ name: fullName, type, size })
    offset += 512 + Math.ceil(size / 512) * 512
    if (offset > view.length) return { entries, reasons: [reason('tar-truncated', 'tar entry exceeds input', fullName)] }
    if (entries.length > limits.maxFiles) break
  }
  return { entries, reasons: inspectArchiveEntries(entries, compressedBytes, limits) }
}

export function inspectTarZstd(bytes: Uint8Array, limits = DEFAULT_IMPORT_LIMITS): { entries: ArchiveEntry[]; reasons: ImportReason[] } {
  if (bytes.byteLength < 4 || bytes.byteLength > limits.maxCompressedBytes) return { entries: [], reasons: [reason('compressed-size', 'compressed tar.zst input size is invalid')] }
  if (!(bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd)) return { entries: [], reasons: [reason('zstd-magic', 'input is not a standard zstd frame')] }
  try {
    const expanded = zstdDecompressSync(bytes, { maxOutputLength: limits.maxExpandedBytes })
    if (expanded.byteLength / bytes.byteLength > limits.maxDecompressionRatio) return { entries: [], reasons: [reason('decompression-ratio', 'archive decompression ratio exceeds limit')] }
    return parseTarIndex(expanded, bytes.byteLength, limits)
  } catch (error) {
    return { entries: [], reasons: [reason('zstd-decompression', message(error))] }
  }
}

export function extractTarZstdFiles(bytes: Uint8Array, limits = DEFAULT_IMPORT_LIMITS): { files: ReadonlyMap<string, Uint8Array>; reasons: ImportReason[] } {
  const inspected = inspectTarZstd(bytes, limits)
  if (inspected.reasons.some((item) => item.severity === 'error')) return { files: new Map(), reasons: inspected.reasons }
  try {
    const expanded = zstdDecompressSync(bytes, { maxOutputLength: limits.maxExpandedBytes })
    const files = new Map<string, Uint8Array>()
    let offset = 0, entryIndex = 0
    while (offset + 512 <= expanded.byteLength && entryIndex < inspected.entries.length) {
      const entry = inspected.entries[entryIndex]!
      const dataOffset = offset + 512, next = dataOffset + Math.ceil(entry.size / 512) * 512
      if (entry.type === 'file') {
        const content = Uint8Array.from(expanded.subarray(dataOffset, dataOffset + entry.size))
        if (looksLikeArchive(content)) return { files: new Map(), reasons: [reason('nested-archive', 'nested archive magic is forbidden', entry.name)] }
        files.set(normalizeEvidencePath(entry.name, limits), content)
      }
      offset = next; entryIndex += 1
    }
    return { files, reasons: inspected.reasons }
  } catch (error) { return { files: new Map(), reasons: [reason('zstd-decompression', message(error))] } }
}

export function inspectJsonlBundle(bytes: Uint8Array, context: InspectionContext, limits = DEFAULT_IMPORT_LIMITS): BundleInspection {
  const input = Buffer.from(bytes)
  const reasons: ImportReason[] = []
  const bundleHash = sha256(input)
  if (input.byteLength > limits.maxCompressedBytes) reasons.push(reason('compressed-size', 'bundle exceeds input limit'))
  if (context.bundleHash && context.bundleHash !== bundleHash) reasons.push(reason('bundle-hash', 'declared bundle hash mismatch'))
  if (context.seenBundleHashes?.has(bundleHash)) reasons.push(reason('replay', 'bundle was already inspected or imported'))
  if (input.at(-1) !== 0x0a) reasons.push(reason('torn-bundle', 'JSONL bundle must end with LF'))
  const rawLines = input.toString('utf8').split('\n')
  if (rawLines.at(-1) === '') rawLines.pop()
  if (rawLines.length > limits.maxRecords + 2) reasons.push(reason('record-count', 'bundle record count exceeds limit'))
  const parsed: Record<string, unknown>[] = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index]!
    if (!line || Buffer.byteLength(line) > limits.maxJsonLineBytes) {
      reasons.push(reason('jsonl-line', 'empty or oversized JSONL line', String(index + 1))); continue
    }
    try {
      const value = JSON.parse(line) as unknown
      if (!isObject(value) || canonicalJson(value as JsonValue) !== line) throw new Error('line is not canonical JSON')
      parsed.push(value)
    } catch (error) { reasons.push(reason('jsonl-schema', message(error), String(index + 1))) }
  }
  const header = parsed[0] ?? null
  const index = parsed.at(-1) ?? null
  if (!header || header.kind !== 'header' || header.schemaVersion !== '1') reasons.push(reason('header-schema', 'missing canonical version 1 header'))
  if (context.production && header?.testOnly !== false) reasons.push(reason('synthetic-production', 'synthetic/testOnly evidence is forbidden in production'))
  if (!index || index.kind !== 'index' || index.schemaVersion !== '1') reasons.push(reason('index-schema', 'missing canonical version 1 index'))
  if (header && index) {
    for (const field of ['runnerId', 'jobId']) if (header[field] !== index[field]) reasons.push(reason('bundle-binding', `${field} differs between header and index`))
    const lastLine = rawLines.at(-1) ?? ''
    const body = input.subarray(0, input.byteLength - Buffer.byteLength(`${lastLine}\n`))
    if (index.sha256 !== sha256(body) || decimal(index.byteSize) !== body.byteLength || decimal(index.recordCount) !== Math.max(0, parsed.length - 2)) {
      reasons.push(reason('index-root', 'index root hash, byte size, or record count mismatch'))
    }
  }
  validateExpected(header, context.expected, reasons)
  validateRunner(header, context, reasons)
  validateRecords(parsed.slice(1, -1), context, reasons)
  validateArtifacts(index, context.artifactFiles, reasons)
  if (context.expected?.binarySha256 && index && (!Array.isArray(index.artifactIdentities) || !index.artifactIdentities.includes(context.expected.binarySha256))) reasons.push(reason('binary-identity', 'signed index does not bind the authoritative binary identity'))
  if (!context.runner || !context.signedIndex || !index ||
      canonicalJson(context.signedIndex.payload) !== canonicalJson(index as JsonValue) ||
      context.signedIndex.keyId !== context.runner.keyId ||
      !verifyEnvelope(context.signedIndex, context.runner.publicKey)) {
    reasons.push(reason('index-signature', 'valid runner signature over exact canonical index is required'))
  }
  return { accepted: !reasons.some((item) => item.severity === 'error'), bundleHash, format: 'jsonl', header, index, records: parsed.slice(1, -1), reasons: deduplicateReasons(reasons) }
}

function validateExpected(header: Record<string, unknown> | null, expected: InspectionContext['expected'], reasons: ImportReason[]): void {
  if (!header || !expected) return
  for (const key of ['runnerId', 'jobId'] as const) if (expected[key] !== undefined && header[key] !== expected[key]) reasons.push(reason('expected-binding', `${key} does not match authoritative context`))
  for (const key of ['leaseId', 'leaseNonce', 'binarySha256', 'buildId', 'corpusArtifactId', 'roiDefinitionHash', 'target'] as const) {
    if (header[key] !== undefined && expected[key] !== undefined && canonicalJson(header[key] as JsonValue) !== canonicalJson(expected[key] as JsonValue)) reasons.push(reason('expected-binding', `${key} does not match authoritative context`))
  }
}

function validateRunner(header: Record<string, unknown> | null, context: InspectionContext, reasons: ImportReason[]): void {
  const runner = context.runner
  if (!header || !runner) { reasons.push(reason('runner-credential', 'runner credential context is required')); return }
  if (header.runnerId !== runner.id) reasons.push(reason('runner-binding', 'runner identity mismatch'))
  const measured = Date.parse(String(header.measuredAt ?? header.startedAt ?? header.createdAt ?? ''))
  const now = context.now ?? Date.now()
  const issued = Date.parse(runner.credentialIssuedAt), expires = Date.parse(runner.credentialExpiresAt)
  if (![measured, issued, expires].every(Number.isFinite) || measured < issued || measured >= expires || measured > now + 300_000) reasons.push(reason('runner-time-state', 'runner credential was not valid at measurement time'))
  if (runner.stateAtMeasurement !== 'approved' || runner.stateAtImport !== 'approved') reasons.push(reason('runner-state', 'runner must be approved at measurement and import time'))
  if (runner.revokedAt && Date.parse(runner.revokedAt) <= now) reasons.push(reason('runner-revoked', 'runner credential is revoked'))
}

function validateRecords(records: readonly Record<string, unknown>[], context: InspectionContext, reasons: ImportReason[]): void {
  let scheduleCount = 0
  let previousMonotonic = -1n
  const sampleIds = new Set<string>()
  const raw: Record<string, unknown>[] = []
  let schedule: Record<string, unknown> | null = null
  for (const [position, record] of records.entries()) {
    if (record.kind === 'schedule') {
      scheduleCount += 1
      if (position !== 0) reasons.push(reason('schedule-order', 'signed schedule must be the first body record'))
      schedule = record
      const signed = record.signed
      if (!context.runner || !isObject(signed) || !isEnvelope(signed) ||
          signed.keyId !== context.runner.keyId ||
          !verifyEnvelope(signed, context.runner.publicKey) ||
          canonicalJson(signed.payload) !== canonicalJson({
            jobId: record.jobId,
            seed: record.seed,
            entries: record.entries,
            protocol: record.protocol,
          } as JsonValue)) reasons.push(reason('schedule-signature', 'valid signature over exact randomized schedule is required'))
      continue
    }
    if (record.kind !== 'raw-run') { reasons.push(reason('record-kind', 'unknown evidence record kind', String(position + 2))); continue }
    raw.push(record)
    const sampleId = String(record.sampleId ?? '')
    if (!sampleId || sampleIds.has(sampleId)) reasons.push(reason('sample-id', 'raw sample IDs must be present and unique', String(position + 2)))
    sampleIds.add(sampleId)
    const start = unsignedBigInt(record.monotonicStartedNs), duration = unsignedBigInt(record.monotonicDurationNs)
    const end = start !== null && duration !== null ? start + duration : null
    if (start === null || duration === null) reasons.push(reason('monotonic-time', 'canonical monotonic start and duration are required'))
    if (start !== null && start < previousMonotonic) reasons.push(reason('monotonic-order', 'sample monotonic starts moved backwards'))
    if (end !== null) previousMonotonic = end
    validatePerf(record.perf, duration, reasons)
    validateEnergy(record.energy, duration, reasons)
    if (record.sensorStream !== undefined) validateSensor(record.sensorStream, reasons)
    validateRequiredEvidence(record, context.expected, reasons)
  }
  if (scheduleCount !== 1) reasons.push(reason('schedule-count', 'bundle requires exactly one signed randomized schedule'))
  if (schedule) reconcileSchedule(schedule, raw, context.expected, reasons)
}

function reconcileSchedule(schedule: Record<string, unknown>, raw: readonly Record<string, unknown>[], expected: InspectionContext['expected'], reasons: ImportReason[]): void {
  if (!Array.isArray(schedule.entries)) { reasons.push(reason('schedule-schema', 'schedule entries are required')); return }
  const entries = schedule.entries
  let authoritative: ReturnType<typeof buildEmpiricalSchedule> | null = null
  try {
    authoritative = buildEmpiricalSchedule(String(schedule.seed ?? ''), Number(expected?.repetitions), Number(expected?.warmups))
    if (!isObject(schedule.protocol) || canonicalJson(schedule.protocol as JsonValue) !== canonicalJson(authoritative.protocol as unknown as JsonValue)) reasons.push(reason('schedule-protocol', 'signed pilot/warmup/idle/measured protocol descriptor is missing or invalid'))
  } catch (error) { reasons.push(reason('schedule-protocol', message(error))) }
  if (expected?.seed !== undefined && schedule.seed !== expected.seed) reasons.push(reason('schedule-seed', 'schedule seed differs from authoritative job'))
  if (expected?.repetitions !== undefined && expected.warmups !== undefined && expected.seed !== undefined) {
    if (!authoritative || canonicalJson(entries as JsonValue) !== canonicalJson(authoritative.entries as unknown as JsonValue)) reasons.push(reason('schedule-authority', 'signed schedule differs from deterministic authoritative job schedule'))
  }
  const scheduled = raw.filter((record) => typeof record.ordinal === 'number' && record.ordinal >= 0)
  const pilots = raw.filter((record) => record.phase === 'pilot')
  const overhead = raw.filter((record) => record.phase === 'idle' && record.ordinal === -100 && record.pairId === 'instrumentation-overhead')
  if (pilots.length < 1 || pilots.length > 8 || pilots.some((record, index) =>
    canonicalJson(pickSchedule(record) as unknown as JsonValue) !== canonicalJson({ phase: 'pilot', arm: 'A', block: -1, ordinal: -1 - index, pairId: `pilot-${index}` }))) reasons.push(reason('pilot-count', 'pilots must exactly match the signed singleton protocol descriptor'))
  if (overhead.length !== 1 || canonicalJson(pickSchedule(overhead[0] ?? {}) as unknown as JsonValue) !== canonicalJson({ phase: 'idle', arm: 'B', block: -1, ordinal: -100, pairId: 'instrumentation-overhead' })) reasons.push(reason('overhead-count', 'instrumentation overhead must exactly match the signed protocol descriptor'))
  const represented = new Set([...scheduled, ...pilots, ...overhead])
  if (represented.size !== raw.length) reasons.push(reason('unscheduled-raw', 'every raw record must be represented by the signed schedule or protocol descriptor'))
  if (scheduled.length !== entries.length) reasons.push(reason('raw-schedule-cardinality', 'raw schedule cardinality differs from signed schedule'))
  for (let index = 0; index < Math.min(entries.length, scheduled.length); index += 1) {
    const entry = entries[index], record = scheduled[index]
    if (!isObject(entry) || !record || canonicalJson(pickSchedule(record) as unknown as JsonValue) !== canonicalJson(pickSchedule(entry) as unknown as JsonValue)) {
      reasons.push(reason('raw-schedule-reconciliation', `raw record ${index} differs from signed schedule`))
    }
  }
  const allOrdinals = scheduled.map((record) => record.ordinal)
  if (new Set(allOrdinals).size !== allOrdinals.length) reasons.push(reason('ordinal-duplicate', 'scheduled raw ordinals must be unique'))
  const pairs = new Map<string, string[]>()
  for (const record of scheduled) {
    if (record.phase === 'warmup') continue
    const pair = String(record.pairId ?? ''), phases = pairs.get(pair) ?? []
    phases.push(String(record.phase)); pairs.set(pair, phases)
  }
  if (expected?.repetitions !== undefined && (pairs.size !== expected.repetitions || [...pairs.values()].some((phases) => phases.length !== 2 || !phases.includes('measured') || !phases.includes('idle')))) reasons.push(reason('pair-integrity', 'measured/idle pair identities or cardinality are invalid'))
}

function validateRequiredEvidence(record: Record<string, unknown>, expected: InspectionContext['expected'], reasons: ImportReason[]): void {
  const oracle = isObject(record.oracle) ? record.oracle : null
  const affinity = isObject(record.affinity) ? record.affinity : null
  if (record.valid === true) {
    if (record.phase !== 'idle' && (!oracle || oracle.passed !== true || record.timedOut !== false || typeof oracle.iterations !== 'string' || !/^[1-9]\d*$/.test(oracle.iterations))) reasons.push(reason('oracle-evidence', 'valid active record lacks passing oracle evidence'))
    if (record.phase !== 'idle' && expected?.leaseNonce !== undefined && oracle?.nonce !== expected.leaseNonce) reasons.push(reason('oracle-nonce', 'oracle nonce differs from authoritative lease nonce'))
    if (!affinity || !Array.isArray(affinity.requested) || !Array.isArray(affinity.effective) ||
        canonicalJson(affinity.requested as JsonValue) !== canonicalJson(affinity.effective as JsonValue)) reasons.push(reason('affinity-evidence', 'valid record lacks exact affinity evidence'))
    const adapters = expected?.adapters ?? []
    if (adapters.includes('linux-perf') && (!Array.isArray(record.perf) || record.perf.length === 0)) reasons.push(reason('adapter-evidence', 'required perf evidence is missing'))
    if (adapters.some((adapter) => adapter.startsWith('rapl') && !adapter.startsWith('optional:')) && (!Array.isArray(record.energy) || record.energy.length === 0)) reasons.push(reason('adapter-evidence', 'required energy evidence is missing'))
    if (expected?.controls && Object.keys(expected.controls).some((key) => key !== 'affinity') &&
        (!isObject(record.controlsBefore) || !isObject(record.controlsAfter) || !Object.keys(record.controlsBefore).length || !Object.keys(record.controlsAfter).length)) reasons.push(reason('control-evidence', 'required control readback is missing'))
  }
}

function pickSchedule(value: Record<string, unknown>): Record<string, unknown> { return { phase: value.phase, arm: value.arm, block: value.block, ordinal: value.ordinal, pairId: value.pairId } }

function validatePerf(value: unknown, duration: bigint | null, reasons: ImportReason[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) { reasons.push(reason('perf-schema', 'perf observation must be an array')); return }
  const names = new Set<string>()
  for (const item of value) {
    if (!isObject(item)) { reasons.push(reason('perf-schema', 'perf counter must be an object')); continue }
    const enabled = unsignedBigInt(item.timeEnabledNs), running = unsignedBigInt(item.timeRunningNs), name = String(item.name ?? '')
    if (!name || names.has(name)) reasons.push(reason('perf-schema', 'perf counter names must be nonempty and unique'))
    names.add(name)
    if (enabled === null || running === null || running > enabled || (duration !== null && enabled > duration * 2n) || (running === 0n && item.scaled !== null)) reasons.push(reason('perf-scaling', 'invalid perf enabled/running/duration relationship'))
  }
}

function validateEnergy(value: unknown, duration: bigint | null, reasons: ImportReason[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) { reasons.push(reason('energy-schema', 'energy observation must be an array')); return }
  const domains = new Set<string>()
  for (const item of value) {
    if (!isObject(item)) { reasons.push(reason('energy-schema', 'energy item must be an object')); continue }
    const domain = String(item.domain ?? ''), before = unsignedBigInt(item.beforeUj), after = unsignedBigInt(item.afterUj), range = unsignedBigInt(item.maxRangeUj)
    if ((item.supported === true && !domain) || (domain && domains.has(domain))) reasons.push(reason('energy-domain', 'supported energy domains must be nonempty and unique'))
    domains.add(domain)
    if (item.supported === true && (before === null || after === null || range === null || range === 0n || before >= range || after >= range || !Number.isFinite(item.grossJoules))) reasons.push(reason('energy-wrap', 'supported energy counter lacks valid finite reading/wrap range'))
    if (item.durationNs !== undefined && duration !== null && unsignedBigInt(item.durationNs) !== duration) reasons.push(reason('energy-duration', 'energy and timing scopes have different duration'))
  }
}

function validateSensor(value: unknown, reasons: ImportReason[]): void {
  if (value === undefined) return
  if (!isObject(value) || !Array.isArray(value.samples) || !isObject(value.clockMapping)) { reasons.push(reason('sensor-schema', 'sensor stream requires samples and clock mapping')); return }
  let sequence = -1, time = -Infinity
  for (const item of value.samples) {
    if (!isObject(item) || integer(item.sequence) === null || !Number.isFinite(Number(item.sensorTime))) { reasons.push(reason('sensor-sample', 'invalid sensor sample')); continue }
    const nextSequence = Number(item.sequence), nextTime = Number(item.sensorTime)
    if (nextSequence !== sequence + 1 && sequence !== -1) reasons.push(reason('sensor-continuity', 'sensor sequence contains a gap'))
    if (nextTime <= time) reasons.push(reason('sensor-clock', 'sensor timestamps are not strictly monotonic'))
    sequence = nextSequence; time = nextTime
  }
  const mapping = value.clockMapping
  if (!Number.isFinite(Number(mapping.slope)) || Number(mapping.slope) <= 0 || !Number.isFinite(Number(mapping.intercept))) reasons.push(reason('sensor-clock', 'invalid sensor-to-monotonic clock mapping'))
}

function validateArtifacts(index: Record<string, unknown> | null, files: ReadonlyMap<string, Uint8Array> | undefined, reasons: ImportReason[]): void {
  if (!index) return
  const artifacts = index.artifacts ?? index.artifactIdentities
  if (!Array.isArray(artifacts)) { reasons.push(reason('artifact-index', 'artifact descriptor list is required')); return }
  const names = new Set<string>()
  for (const value of artifacts) {
    if (typeof value === 'string') { if (!HASH.test(value)) reasons.push(reason('artifact-hash', 'invalid artifact hash')); continue }
    if (!isObject(value)) { reasons.push(reason('artifact-schema', 'invalid artifact descriptor')); continue }
    let name: string | null = null
    try {
      name = normalizeEvidencePath(String(value.name ?? value.filename ?? value.sha256))
      const folded = name.normalize('NFC').toLocaleLowerCase('en-US')
      if (names.has(folded)) reasons.push(reason('duplicate-name', 'duplicate normalized artifact name', name))
      names.add(folded)
    } catch (error) { reasons.push(reason('unsafe-path', message(error))) }
    if (!HASH.test(String(value.sha256)) || decimal(value.byteSize) === null || !MIME.test(String(value.mimeType))) reasons.push(reason('artifact-schema', 'artifact requires exact hash, size, and MIME'))
    if (name !== null) {
      const content = files?.get(name)
      if (!content || content.byteLength !== decimal(value.byteSize) || sha256(content) !== value.sha256) reasons.push(reason('artifact-content', 'artifact content hash/size does not match signed descriptor', name))
    }
  }
}

export interface SignedEnvelope<T> {
  algorithm: 'Ed25519'
  keyId: string
  signedAt: string
  payload: T
  signature: string
}

export function verifyEnvelope<T extends JsonValue>(envelope: SignedEnvelope<T>, publicKeyBase64: string): boolean {
  if (envelope.algorithm !== 'Ed25519' || !Number.isFinite(Date.parse(envelope.signedAt))) return false
  try {
    const der = Buffer.from(decodeCanonicalBase64(publicKeyBase64))
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519' || !key.export({ format: 'der', type: 'spki' }).equals(der)) return false
    const signature = Buffer.from(decodeCanonicalBase64(envelope.signature, 64))
    const messageBytes = Buffer.from(canonicalJson({ protected: { algorithm: envelope.algorithm, keyId: envelope.keyId, signedAt: envelope.signedAt }, payload: envelope.payload }))
    return verify(null, messageBytes, key, signature)
  } catch { return false }
}

export interface ImportReport {
  reportId: string
  previousReportHash: string
  bundleHash: string
  decision: 'accepted-for-review' | 'rejected' | 'committed' | 'deleted'
  reasons: readonly ImportReason[]
  createdAt: string
  inspectorVersion: string
}

export function createImportReport(input: Omit<ImportReport, 'reportId' | 'inspectorVersion'>): ImportReport {
  const body = { ...input, inspectorVersion: CALIBRATION_CORE_VERSION }
  return { reportId: sha256(canonicalJson(body as unknown as JsonValue)), ...body }
}

export function signImportReport(report: ImportReport, keyId: string, privateKey: KeyObject, signedAt = new Date().toISOString()): SignedEnvelope<ImportReport & JsonValue> {
  const payload = report as ImportReport & JsonValue
  const protectedHeader = { algorithm: 'Ed25519' as const, keyId, signedAt }
  const signature = sign(null, Buffer.from(canonicalJson({ protected: protectedHeader, payload })), privateKey).toString('base64')
  return { ...protectedHeader, payload, signature }
}

export interface NumericSummary {
  count: number
  mean: number
  sampleSd: number | null
  median: number
  mad: number
  min: number
  max: number
  quantiles: Readonly<Record<string, number>>
  sem: number | null
}

export function summarizeExact(values: readonly number[], probabilities: readonly number[] = [0.025, 0.25, 0.5, 0.75, 0.975]): NumericSummary {
  finiteValues(values)
  if (values.length === 0) throw new Error('summary requires at least one value')
  const sorted = [...values].sort((a, b) => a - b)
  const mean = compensatedSum(values) / values.length
  const squared = compensatedSum(values.map((value) => (value - mean) ** 2))
  const sampleSd = values.length > 1 ? Math.sqrt(squared / (values.length - 1)) : null
  const median = quantile(sorted, 0.5)
  const deviations = values.map((value) => Math.abs(value - median)).sort((a, b) => a - b)
  return {
    count: values.length, mean, sampleSd, median, mad: quantile(deviations, 0.5),
    min: sorted[0]!, max: sorted.at(-1)!,
    quantiles: Object.fromEntries(probabilities.map((p) => [String(p), quantile(sorted, p)])),
    sem: sampleSd === null ? null : sampleSd / Math.sqrt(values.length),
  }
}

export function quantile(sortedValues: readonly number[], probability: number): number {
  if (sortedValues.length === 0 || probability < 0 || probability > 1 || !Number.isFinite(probability)) throw new Error('invalid quantile input')
  const position = (sortedValues.length - 1) * probability
  const lower = Math.floor(position), fraction = position - lower
  return sortedValues[lower]! + fraction * ((sortedValues[Math.min(lower + 1, sortedValues.length - 1)]!) - sortedValues[lower]!)
}

export interface FlaggedSample<T = number> { value: T; flagged: boolean; score: number | null; reason: string | null }
export function robustLogFlags(values: readonly number[], zeroMadPolicy: 'flag-nonmedian' | 'flag-none' | 'reject' = 'flag-nonmedian'): FlaggedSample[] {
  finiteValues(values)
  if (values.some((value) => value <= 0)) throw new Error('log metric requires positive observations')
  const logs = values.map(Math.log), summary = summarizeExact(logs)
  if (summary.mad === 0) {
    if (zeroMadPolicy === 'reject') throw new Error('zero MAD')
    return values.map((value, index) => {
      const flagged = zeroMadPolicy === 'flag-nonmedian' && logs[index] !== summary.median
      return { value, flagged, score: null, reason: flagged ? 'zero-MAD-nonmedian' : null }
    })
  }
  return values.map((value, index) => {
    const score = 0.6745 * (logs[index]! - summary.median) / summary.mad
    const flagged = Math.abs(score) > 3.5
    return { value, flagged, score, reason: flagged ? 'modified-z-log' : null }
  })
}

export interface ProtocolSample {
  id: string
  value: number
  protocolValid: boolean
  protocolReasons: readonly string[]
  statisticalFlag?: boolean
  blockId?: string
  clusterId?: string
  pairId?: string
}
export interface SummaryRecord {
  primary: NumericSummary | null
  sensitivity: NumericSummary | null
  attemptedCount: number
  validCount: number
  invalidCount: number
  flaggedCount: number
  policyHash: string
  codeHash: string
  rawDatasetHash: string
  confidenceMethod: string
  confidenceLevel: number
  clusterUnit: string | null
  seed: string
}

export function summarizeSamples(samples: readonly ProtocolSample[], metadata: Omit<SummaryRecord, 'primary' | 'sensitivity' | 'attemptedCount' | 'validCount' | 'invalidCount' | 'flaggedCount'>): SummaryRecord {
  const valid = samples.filter((sample) => sample.protocolValid)
  const sensitivity = valid.filter((sample) => !sample.statisticalFlag)
  return {
    primary: valid.length ? summarizeExact(valid.map((sample) => sample.value)) : null,
    sensitivity: sensitivity.length ? summarizeExact(sensitivity.map((sample) => sample.value)) : null,
    attemptedCount: samples.length, validCount: valid.length, invalidCount: samples.length - valid.length,
    flaggedCount: valid.length - sensitivity.length, ...metadata,
  }
}

export type BootstrapMethod = 'percentile' | 'bca'
export interface ConfidenceInterval { lower: number; upper: number; level: number; method: BootstrapMethod; iterations: number; seed: string }
export interface ResampleItem { value: number; blockId?: string; clusterId?: string }

export function bootstrapInterval(items: readonly ResampleItem[], options: {
  seed: string
  iterations?: number
  level?: number
  method?: BootstrapMethod
  unit?: 'observation' | 'block' | 'cluster'
  statistic?: (values: readonly number[]) => number
}): ConfidenceInterval {
  if (!items.length) throw new Error('bootstrap requires observations')
  const iterations = options.iterations ?? 2000, level = options.level ?? 0.95, method = options.method ?? 'percentile'
  if (!Number.isSafeInteger(iterations) || iterations < 100 || iterations > 100_000 || !(level > 0 && level < 1)) throw new Error('invalid bootstrap options')
  const statistic = options.statistic ?? ((values) => compensatedSum(values) / values.length)
  const rng = seededRandom(options.seed)
  const groups = groupBootstrap(items, options.unit ?? 'observation')
  if (method === 'bca' && groups.length < 3) throw new Error('BCa requires at least three resampling groups')
  const estimates: number[] = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample: number[] = []
    for (let draw = 0; draw < groups.length; draw += 1) sample.push(...groups[Math.floor(rng() * groups.length)]!)
    const estimate = statistic(sample)
    if (!Number.isFinite(estimate)) throw new Error('bootstrap statistic returned nonfinite value')
    estimates.push(estimate)
  }
  estimates.sort((a, b) => a - b)
  let lowerP = (1 - level) / 2, upperP = 1 - lowerP
  if (method === 'bca') {
    const observed = statistic(items.map((item) => item.value))
    const below = estimates.filter((value) => value < observed).length
    const z0 = inverseNormal(Math.max(1 / (2 * iterations), Math.min(1 - 1 / (2 * iterations), below / iterations)))
    const jackknife = groups.map((_group, omitted) => statistic(groups.filter((_values, index) => index !== omitted).flat()))
    const jackMean = compensatedSum(jackknife) / jackknife.length
    const numerator = compensatedSum(jackknife.map((value) => (jackMean - value) ** 3))
    const denominator = 6 * compensatedSum(jackknife.map((value) => (jackMean - value) ** 2)) ** 1.5
    const acceleration = denominator === 0 ? 0 : numerator / denominator
    lowerP = adjustedBca(z0, acceleration, lowerP)
    upperP = adjustedBca(z0, acceleration, upperP)
  }
  return { lower: quantile(estimates, lowerP), upper: quantile(estimates, upperP), level, method, iterations, seed: options.seed }
}

function groupBootstrap(items: readonly ResampleItem[], unit: 'observation' | 'block' | 'cluster'): number[][] {
  if (unit === 'observation') return items.map((item) => [item.value])
  const groups = new Map<string, number[]>()
  for (const item of items) {
    const id = unit === 'block' ? item.blockId : item.clusterId
    if (!id) throw new Error(`${unit} bootstrap requires complete group IDs`)
    const group = groups.get(id) ?? []; group.push(item.value); groups.set(id, group)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, values]) => values)
}

export interface PairedObservation { pairId: string; treatment: number; reference: number; durationScope: string; energyDomain?: string }
export function pairedLogRatios(pairs: readonly PairedObservation[]): { pairId: string; logRatio: number }[] {
  const seen = new Set<string>()
  return pairs.map((pair) => {
    if (!pair.pairId || seen.has(pair.pairId) || !(pair.treatment > 0) || !(pair.reference > 0)) throw new Error('invalid or duplicate pair')
    seen.add(pair.pairId)
    return { pairId: pair.pairId, logRatio: Math.log(pair.treatment / pair.reference) }
  })
}

export interface EnergyObservation {
  sampleId: string; pairId: string; joules: number; durationSeconds: number; adapter: string; domain: string; scope: string
  boundary: string; machineId: string; controlsHash: string; clockId: string
}
export function adjustIdleEnergy(active: EnergyObservation, baseline: EnergyObservation): { grossJoules: number; idleJoules: number; idleAdjustedJoules: number } {
  finiteValues([active.joules, baseline.joules, active.durationSeconds, baseline.durationSeconds])
  if (active.sampleId === baseline.sampleId || active.joules < 0 || baseline.joules < 0 || active.durationSeconds <= 0 || baseline.durationSeconds <= 0) throw new Error('active and baseline energy observations must be distinct and positive-duration')
  for (const key of ['pairId', 'adapter', 'domain', 'scope', 'boundary', 'machineId', 'controlsHash', 'clockId'] as const) {
    if (!active[key] || active[key] !== baseline[key]) throw new Error(`energy baseline mismatch: ${key}`)
  }
  const ratio = active.durationSeconds / baseline.durationSeconds
  if (!(ratio >= 0.25 && ratio <= 4)) throw new Error('energy baseline duration is incompatible')
  const idleJoules = baseline.joules * ratio
  return { grossJoules: active.joules, idleJoules, idleAdjustedJoules: active.joules - idleJoules }
}

export interface DatasetMember {
  id: string
  family: string
  sessionId: string
  machineId?: string
}
export interface FrozenSplit {
  trainingIds: readonly string[]
  selectionIds: readonly string[]
  conformalIds: readonly string[]
  holdoutIds: readonly string[]
  seed: string
  familyAssignment: Readonly<Record<string, 'train' | 'selection' | 'conformal' | 'holdout'>>
  hash: string
}

export function createFrozenSplit(members: readonly DatasetMember[], options: { seed: string; selectionFraction?: number; conformalFraction?: number; holdoutFraction?: number; holdoutMachine?: string; holdoutSession?: string }): FrozenSplit {
  if (!members.length || new Set(members.map((item) => item.id)).size !== members.length) throw new Error('dataset IDs must be nonempty and unique')
  const selectionFraction = options.selectionFraction ?? 0.2, conformalFraction = options.conformalFraction ?? 0.2, holdoutFraction = options.holdoutFraction ?? 0.2
  if ([selectionFraction, conformalFraction, holdoutFraction].some((value) => value <= 0) || selectionFraction + conformalFraction + holdoutFraction >= 1) throw new Error('invalid split fractions')
  const familyGroups = new Map<string, DatasetMember[]>()
  const sessionFamilies = new Map<string, Set<string>>()
  for (const member of members) {
    if (!member.id || !member.family || !member.sessionId) throw new Error('dataset member lacks grouping identity')
    const group = familyGroups.get(member.family) ?? []; group.push(member); familyGroups.set(member.family, group)
    const families = sessionFamilies.get(member.sessionId) ?? new Set<string>(); families.add(member.family); sessionFamilies.set(member.sessionId, families)
  }
  if ([...sessionFamilies.values()].some((families) => families.size !== 1)) throw new Error('session spans workload families and cannot be leakage-free')
  const forcedHoldout = new Set(members.filter((item) =>
    (options.holdoutMachine !== undefined && item.machineId === options.holdoutMachine) ||
    (options.holdoutSession !== undefined && item.sessionId === options.holdoutSession)).map((item) => item.family))
  const families = [...familyGroups.keys()].sort().map((family) => ({ family, key: sha256(`${options.seed}\0${family}`) })).sort((a, b) => a.key.localeCompare(b.key))
  const assignment: Record<string, 'train' | 'selection' | 'conformal' | 'holdout'> = {}
  let cumulative = 0
  const total = members.length
  for (const item of families) {
    if (forcedHoldout.has(item.family)) assignment[item.family] = 'holdout'
    else {
      const midpoint = (cumulative + familyGroups.get(item.family)!.length / 2) / total
      assignment[item.family] = midpoint < holdoutFraction ? 'holdout'
        : midpoint < holdoutFraction + conformalFraction ? 'conformal'
          : midpoint < holdoutFraction + conformalFraction + selectionFraction ? 'selection' : 'train'
      cumulative += familyGroups.get(item.family)!.length
    }
  }
  const select = (partition: 'train' | 'selection' | 'conformal' | 'holdout') => members.filter((item) => assignment[item.family] === partition).map((item) => item.id).sort()
  const body = { trainingIds: select('train'), selectionIds: select('selection'), conformalIds: select('conformal'), holdoutIds: select('holdout'), seed: options.seed, familyAssignment: assignment }
  const groupCount = (partition: 'selection' | 'conformal') => new Set(members.filter((item) => assignment[item.family] === partition).map((item) => `${item.family}\0${item.sessionId}`)).size
  if (!body.trainingIds.length || !body.selectionIds.length || body.conformalIds.length < 10 || !body.holdoutIds.length || groupCount('selection') < 2 || groupCount('conformal') < 3) throw new Error('grouped split lacks sufficient independent train/selection/conformal/holdout samples')
  return { ...body, hash: sha256(canonicalJson(body as unknown as JsonValue)) }
}

export interface SemanticMapping {
  simulatorVersion: string
  modelVersion: string
  profileHash: string
  toolchainHash: string
  corpusArtifactId: string
  roiDefinitionHash: string
  workloadSemanticHash: string
  binarySha256: string
}
export function assertExactSemanticMapping(native: SemanticMapping, simulated: SemanticMapping): void {
  for (const key of Object.keys(native) as (keyof SemanticMapping)[]) if (native[key] !== simulated[key]) throw new Error(`semantic mapping mismatch: ${key}`)
}

export interface FitRow { id: string; family: string; features: Readonly<Record<string, number>>; target: number; weight?: number }
export interface LinearFit {
  kind: 'ridge' | 'elastic-net' | 'nonnegative-energy'
  intercept: number
  coefficients: Readonly<Record<string, number>>
  featureMeans: Readonly<Record<string, number>>
  featureScales: Readonly<Record<string, number>>
  lambda: number
  l1Ratio: number
  iterations: number
  converged: boolean
  rank: number
  conditionNumber: number
  interceptConstrained: boolean
  kktResidual: number
}

export function fitConstrainedLinear(rows: readonly FitRow[], options: {
  kind?: LinearFit['kind']; lambda?: number; l1Ratio?: number; maxIterations?: number; tolerance?: number; fitIntercept?: boolean
} = {}): LinearFit {
  if (rows.length < 2) throw new Error('fit requires observations')
  const names = [...new Set(rows.flatMap((row) => Object.keys(row.features)))].sort()
  if (!names.length || rows.some((row) => names.some((name) => !Number.isFinite(row.features[name])) || !Number.isFinite(row.target) ||
      !Number.isFinite(row.weight ?? 1) || (row.weight ?? 1) < 0)) throw new Error('incomplete/nonfinite design matrix or invalid weight')
  const weights = rows.map((row) => row.weight ?? 1), weightSum = compensatedSum(weights)
  if (!(weightSum > 0)) throw new Error('fit requires positive total weight')
  const n = rows.length, kind = options.kind ?? 'ridge'
  const fitIntercept = options.fitIntercept !== false, constrainedIntercept = kind === 'nonnegative-energy' && fitIntercept
  const center = fitIntercept && kind !== 'nonnegative-energy'
  const means: Record<string, number> = {}, scales: Record<string, number> = {}
  for (const name of names) {
    const values = rows.map((row) => row.features[name]!)
    means[name] = center ? weightedAverage(values, weights) : 0
    scales[name] = Math.sqrt(compensatedSum(values.map((value, index) => weights[index]! * (value - means[name]!) ** 2)) / weightSum)
    if (!(scales[name]! > 1e-14)) throw new Error(`rank deficiency: constant feature ${name}`)
  }
  const x = rows.map((row) => names.map((name) => (row.features[name]! - means[name]!) / scales[name]!))
  const yMean = center ? weightedAverage(rows.map((row) => row.target), weights) : 0
  const y = rows.map((row) => row.target - yMean)
  const designForRank = fitIntercept ? x.map((row) => [1, ...row]) : x
  const spectrum = jacobiEigenvalues(gram(designForRank, weights))
  const nonzero = spectrum.filter((value) => value > Math.max(...spectrum) * 1e-12)
  const rank = nonzero.length, requiredRank = designForRank[0]!.length
  const conditionNumber = Math.sqrt(Math.max(...nonzero) / Math.min(...nonzero))
  if (rank < requiredRank || !Number.isFinite(conditionNumber) || conditionNumber > 1e8) throw new Error('rank deficiency or unstable collinearity')
  const lambda = options.lambda ?? 1e-6, l1Ratio = kind === 'ridge' ? 0 : options.l1Ratio ?? 0.5
  if (lambda < 0 || l1Ratio < 0 || l1Ratio > 1) throw new Error('invalid regularization')
  const includeInterceptCoordinate = fitIntercept && !center
  const design = includeInterceptCoordinate ? x.map((row) => [1, ...row]) : x
  const beta = Array(design[0]!.length).fill(0) as number[], maxIterations = options.maxIterations ?? 10_000, tolerance = options.tolerance ?? 1e-10
  let converged = false, iteration = 0
  for (; iteration < maxIterations; iteration += 1) {
    let maxChange = 0
    for (let column = 0; column < beta.length; column += 1) {
      const interceptColumn = includeInterceptCoordinate && column === 0
      let numerator = 0, denominator = interceptColumn ? 0 : lambda * (1 - l1Ratio)
      for (let row = 0; row < n; row += 1) {
        let residual = y[row]!
        for (let other = 0; other < beta.length; other += 1) if (other !== column) residual -= design[row]![other]! * beta[other]!
        numerator += weights[row]! * design[row]![column]! * residual
        denominator += weights[row]! * design[row]![column]! ** 2
      }
      let next = softThreshold(numerator, interceptColumn ? 0 : lambda * l1Ratio) / denominator
      if (kind === 'nonnegative-energy') next = Math.max(0, next)
      maxChange = Math.max(maxChange, Math.abs(next - beta[column]!)); beta[column] = next
    }
    if (maxChange <= tolerance) { converged = true; break }
  }
  if (!converged) throw new Error('fit did not converge')
  const coefficientOffset = includeInterceptCoordinate ? 1 : 0
  const coefficients = Object.fromEntries(names.map((name, index) => [name, beta[index + coefficientOffset]! / scales[name]!]))
  const intercept = !fitIntercept ? 0 : includeInterceptCoordinate ? beta[0]! : yMean - compensatedSum(names.map((name) => coefficients[name]! * means[name]!))
  const gradients = beta.map((_value, column) => {
    let gradient = 0
    for (let row = 0; row < n; row += 1) {
      const residual = compensatedSum(design[row]!.map((value, index) => value * beta[index]!)) - y[row]!
      gradient += weights[row]! * design[row]![column]! * residual
    }
    if (!(includeInterceptCoordinate && column === 0)) gradient += lambda * (1 - l1Ratio) * beta[column]!
    return gradient
  })
  const lambda1 = lambda * l1Ratio
  const kktResidual = Math.max(...gradients.map((gradient, index) => {
    const interceptCoordinate = includeInterceptCoordinate && index === 0
    if (interceptCoordinate) return kind === 'nonnegative-energy' && beta[index]! <= tolerance ? Math.max(0, -gradient) : Math.abs(gradient)
    const coefficient = beta[index]!
    if (Math.abs(coefficient) > tolerance) return Math.abs(gradient + lambda1 * Math.sign(coefficient))
    if (kind === 'nonnegative-energy') return Math.max(0, -(gradient + lambda1))
    return Math.max(0, Math.abs(gradient) - lambda1)
  }))
  return { kind, intercept, coefficients, featureMeans: means, featureScales: scales, lambda, l1Ratio, iterations: iteration + 1, converged, rank, conditionNumber, interceptConstrained: constrainedIntercept, kktResidual }
}

export function boundedCoordinateOptimize(initial: Readonly<Record<string, number>>, bounds: Readonly<Record<string, readonly [number, number]>>, objective: (parameters: Readonly<Record<string, number>>) => number, options: { iterations?: number; tolerance?: number } = {}): { parameters: Readonly<Record<string, number>>; objective: number; iterations: number } {
  const names = Object.keys(bounds).sort(), current = { ...initial }, steps: Record<string, number> = {}
  for (const name of names) {
    const [lower, upper] = bounds[name]!
    if (!(lower <= current[name]! && current[name]! <= upper) || !Number.isFinite(lower + upper)) throw new Error('initial parameter outside finite bounds')
    steps[name] = (upper - lower) / 4
  }
  let best = objective(current), iteration = 0
  for (; iteration < (options.iterations ?? 1000); iteration += 1) {
    let changed = false
    for (const name of names) {
      const [lower, upper] = bounds[name]!
      for (const direction of [-1, 1]) {
        const candidate = { ...current, [name]: Math.max(lower, Math.min(upper, current[name]! + direction * steps[name]!)) }
        const score = objective(candidate)
        if (Number.isFinite(score) && score < best) { Object.assign(current, candidate); best = score; changed = true }
      }
    }
    if (!changed) for (const name of names) steps[name] = steps[name]! / 2
    if (Math.max(...Object.values(steps)) <= (options.tolerance ?? 1e-9)) break
  }
  return { parameters: current, objective: best, iterations: iteration + 1 }
}

export interface RegressionMetrics {
  count: number; mae: number; rmse: number; medianAe: number; signedBias: number; smape: number; safeMape: number | null; relativeRmse: number | null; r2: number | null; spearman: number | null
}
export function regressionMetrics(actual: readonly number[], predicted: readonly number[], mapeFloor = 1e-12, weights?: readonly number[]): RegressionMetrics {
  if (!actual.length || actual.length !== predicted.length) throw new Error('metric vectors differ or are empty')
  finiteValues([...actual, ...predicted])
  const effectiveWeights = weights ?? actual.map(() => 1)
  if (effectiveWeights.length !== actual.length || effectiveWeights.some((value) => !Number.isFinite(value) || value < 0) || !(compensatedSum(effectiveWeights) > 0)) throw new Error('invalid metric weights')
  const errors = predicted.map((value, index) => value - actual[index]!), absolute = errors.map(Math.abs)
  const weightSum = compensatedSum(effectiveWeights), meanActual = weightedAverage(actual, effectiveWeights)
  const ssResidual = compensatedSum(errors.map((value, index) => effectiveWeights[index]! * value ** 2))
  const ssTotal = compensatedSum(actual.map((value, index) => effectiveWeights[index]! * (value - meanActual) ** 2))
  const safe = actual.map((value, index) => Math.abs(value) > mapeFloor ? { value: Math.abs(errors[index]! / value), weight: effectiveWeights[index]! } : null).filter((value): value is { value: number; weight: number } => value !== null)
  return {
    count: actual.length, mae: compensatedSum(absolute.map((value, index) => effectiveWeights[index]! * value)) / weightSum, rmse: Math.sqrt(ssResidual / weightSum),
    medianAe: weightedQuantile(absolute, effectiveWeights, 0.5), signedBias: compensatedSum(errors.map((value, index) => effectiveWeights[index]! * value)) / weightSum,
    smape: 200 * compensatedSum(errors.map((value, index) => effectiveWeights[index]! * Math.abs(value) / Math.max(mapeFloor, Math.abs(actual[index]!) + Math.abs(predicted[index]!)))) / weightSum,
    safeMape: safe.length && compensatedSum(safe.map((item) => item.weight)) > 0 ? 100 * weightedAverage(safe.map((item) => item.value), safe.map((item) => item.weight)) : null,
    relativeRmse: Math.abs(meanActual) > mapeFloor ? Math.sqrt(ssResidual / weightSum) / Math.abs(meanActual) : null,
    r2: ssTotal > 0 ? 1 - ssResidual / ssTotal : null, spearman: actual.length > 1 ? weightedPearson(ranks(actual), ranks(predicted), effectiveWeights) : null,
  }
}

export interface IntervalMetrics { coverage: number; meanWidth: number; intervalScore: number }
export function intervalMetrics(actual: readonly number[], lower: readonly number[], upper: readonly number[], level: number): IntervalMetrics {
  if (!actual.length || actual.length !== lower.length || lower.length !== upper.length || !(level > 0 && level < 1)) throw new Error('invalid interval vectors')
  finiteValues([...actual, ...lower, ...upper])
  const alpha = 1 - level
  let covered = 0, width = 0, score = 0
  for (let i = 0; i < actual.length; i += 1) {
    if (lower[i]! > upper[i]!) throw new Error('inverted interval')
    const w = upper[i]! - lower[i]!; width += w; score += w
    if (actual[i]! >= lower[i]! && actual[i]! <= upper[i]!) covered += 1
    else if (actual[i]! < lower[i]!) score += 2 / alpha * (lower[i]! - actual[i]!)
    else score += 2 / alpha * (actual[i]! - upper[i]!)
  }
  return { coverage: covered / actual.length, meanWidth: width / actual.length, intervalScore: score / actual.length }
}

export interface SplitConformalCalibration {
  method: 'validation-split-conformal-absolute-residual'
  sampleCount: number
  calibrationHash: string
  intervals: Readonly<Record<'0.5' | '0.95', { level: 0.5 | 0.95; radius: number; correctedRank: number }>>
}
export function calibrateSplitConformal(
  rows: readonly { id: string; actual: number; predicted: number }[],
  minimumSamples = 10,
): SplitConformalCalibration {
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 2 || rows.length < minimumSamples) {
    throw new Error(`split-conformal unavailable: validation requires at least ${minimumSamples} samples`)
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length || rows.some((row) => !row.id)) throw new Error('split-conformal validation IDs must be unique')
  finiteValues(rows.flatMap((row) => [row.actual, row.predicted]))
  const canonicalRows = [...rows].sort((a, b) => a.id.localeCompare(b.id))
  const residuals = canonicalRows.map((row) => Math.abs(row.actual - row.predicted)).sort((a, b) => a - b)
  const interval = <L extends 0.5 | 0.95>(level: L) => {
    const correctedRank = Math.min(residuals.length, Math.ceil((residuals.length + 1) * level))
    return { level, radius: residuals[correctedRank - 1]!, correctedRank }
  }
  return {
    method: 'validation-split-conformal-absolute-residual',
    sampleCount: rows.length,
    calibrationHash: sha256(canonicalJson(canonicalRows as unknown as JsonValue)),
    intervals: { '0.5': interval(0.5), '0.95': interval(0.95) },
  }
}

export function groupedRegressionMetrics(rows: readonly { actual: number; predicted: number; family: string; size: string; boundary: string }[]): {
  overall: RegressionMetrics
  byFamily: Readonly<Record<string, RegressionMetrics>>
  bySize: Readonly<Record<string, RegressionMetrics>>
  byBoundary: Readonly<Record<string, RegressionMetrics>>
} {
  if (!rows.length) throw new Error('grouped metrics require rows')
  const calculate = (values: readonly typeof rows[number][]) => regressionMetrics(values.map((row) => row.actual), values.map((row) => row.predicted))
  const grouped = (key: 'family' | 'size' | 'boundary') => Object.fromEntries([...new Set(rows.map((row) => row[key]))].sort().map((value) => [value, calculate(rows.filter((row) => row[key] === value))]))
  return { overall: calculate(rows), byFamily: grouped('family'), bySize: grouped('size'), byBoundary: grouped('boundary') }
}

export interface FitBootstrapResult {
  seed: string
  groupCount: number
  minimumGroups: number
  minimumSuccessfulFits: number
  iterations: number
  attempts: number
  failures: number
  coefficients: Readonly<Record<string, readonly number[]>>
  intercepts: readonly number[]
  predictionDistributions: readonly (readonly number[])[]
}
export function bootstrapLinearFit(rows: readonly FitRow[], predictionFeatures: readonly Readonly<Record<string, number>>[], options: {
  seed: string
  iterations?: number
  maxRetries?: number
  minSuccessFraction?: number
  minimumGroups?: number
  clusterUnit?: 'family'
  fit?: Parameters<typeof fitConstrainedLinear>[1]
}): FitBootstrapResult {
  const iterations = options.iterations ?? 1000
  if (iterations < 100 || iterations > 20_000 || !Number.isSafeInteger(iterations)) throw new Error('fit bootstrap iterations out of bounds')
  const groups = new Map<string, FitRow[]>()
  for (const row of rows) { const group = groups.get(row.family) ?? []; group.push(row); groups.set(row.family, group) }
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  const minimumGroups = options.minimumGroups ?? 3
  if (!Number.isSafeInteger(minimumGroups) || minimumGroups < 2) throw new Error('invalid fit bootstrap minimum groups')
  if (ordered.length < minimumGroups) throw new Error(`fit bootstrap unavailable: insufficient independent family groups (${ordered.length}/${minimumGroups})`)
  const rng = seededRandom(options.seed), coefficients: Record<string, number[]> = {}, intercepts: number[] = []
  const predictionDistributions = predictionFeatures.map(() => [] as number[])
  const maxRetries = options.maxRetries ?? iterations, maxAttempts = iterations + maxRetries
  const minSuccessFraction = options.minSuccessFraction ?? 0.9
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || !(minSuccessFraction > 0 && minSuccessFraction <= 1)) throw new Error('invalid bootstrap retry policy')
  let attempts = 0, failures = 0
  while (intercepts.length < iterations && attempts < maxAttempts) {
    attempts += 1
    const sampled: FitRow[] = []
    for (let draw = 0; draw < ordered.length; draw += 1) {
      const [groupId, group] = ordered[Math.floor(rng() * ordered.length)]!
      sampled.push(...group.map((row, index) => ({ ...row, id: `${attempts}:${draw}:${groupId}:${index}` })))
    }
    let fit: LinearFit
    try { fit = fitConstrainedLinear(sampled, options.fit) } catch (error) {
      if (!/rank deficiency|collinearity|fit did not converge/.test(message(error))) throw error
      failures += 1; continue
    }
    intercepts.push(fit.intercept)
    for (const [name, value] of Object.entries(fit.coefficients)) (coefficients[name] ??= []).push(value)
    predictionFeatures.forEach((features, index) => predictionDistributions[index]!.push(
      fit.intercept + compensatedSum(Object.entries(fit.coefficients).map(([name, value]) => value * (features[name] ?? failValue(`missing prediction feature ${name}`)))),
    ))
  }
  const minimumSuccessfulFits = Math.ceil(iterations * minSuccessFraction)
  if (intercepts.length < minimumSuccessfulFits) throw new Error(`insufficient successful bootstrap fits: ${intercepts.length}/${minimumSuccessfulFits}; attempts=${attempts}; failures=${failures}`)
  return { seed: options.seed, groupCount: ordered.length, minimumGroups, minimumSuccessfulFits, iterations: intercepts.length, attempts, failures, coefficients, intercepts, predictionDistributions }
}

export interface UncertaintyBudget {
  repetition: number
  coefficient: number
  residual: number
  sensorCalibration: number
  clockAlignment: number
  idleBaseline: number
  samplingInterval?: MeasurementInterval
}
export function validateUncertaintyBudget(value: UncertaintyBudget): UncertaintyBudget {
  const components = [value.repetition, value.coefficient, value.residual, value.sensorCalibration, value.clockAlignment, value.idleBaseline]
  if (components.some((item) => !Number.isFinite(item) || item < 0)) throw new Error('uncertainty components must be separate nonnegative finite values')
  if (value.samplingInterval) validateConfidenceInterval(value.samplingInterval)
  return value
}

export interface MeasurementInterval extends ConfidenceInterval { estimate: number; unit: string; domain: string }
export function validateConfidenceInterval(value: ConfidenceInterval | MeasurementInterval): void {
  if (!Number.isFinite(value.lower) || !Number.isFinite(value.upper) || value.lower > value.upper ||
      !Number.isFinite(value.level) || !(value.level > 0 && value.level < 1) ||
      !Number.isSafeInteger(value.iterations) || value.iterations <= 0) throw new Error('invalid confidence interval')
  if ('estimate' in value && (!Number.isFinite(value.estimate) || value.estimate < value.lower || value.estimate > value.upper ||
      typeof value.unit !== 'string' || !value.unit || typeof value.domain !== 'string' || !value.domain)) throw new Error('invalid measurement interval estimate/unit/domain')
}

export interface ApplicabilityPredicate {
  cpu: string; microcode: string; kernel: string; toolchainHash: string; controlsHash: string; sensorBoundary: string; corpusHash: string; simulatorVersion: string
  parameterRanges: Readonly<Record<string, readonly [number, number]>>
  extrasVersion?: string
}
export function assertApplicable(predicate: ApplicabilityPredicate, context: Omit<ApplicabilityPredicate, 'parameterRanges'> & { parameters: Readonly<Record<string, number>> }): void {
  for (const key of ['cpu', 'microcode', 'kernel', 'toolchainHash', 'controlsHash', 'sensorBoundary', 'corpusHash', 'simulatorVersion'] as const) {
    if (!predicate[key] || typeof context[key] !== 'string' || predicate[key] !== context[key]) throw new Error(`applicability mismatch: ${key}`)
  }
  if (predicate.extrasVersion !== context.extrasVersion) throw new Error('applicability mismatch: extrasVersion')
  const declared = Object.keys(predicate.parameterRanges).sort(), supplied = Object.keys(context.parameters).sort()
  if (declared.join('\0') !== supplied.join('\0')) throw new Error('applicability parameter set mismatch')
  for (const [name, [lower, upper]] of Object.entries(predicate.parameterRanges)) {
    const value = context.parameters[name]
    if (![lower, upper, value].every(Number.isFinite) || lower > upper || value === undefined || value < lower || value > upper) throw new Error(`extrapolation rejected: ${name}`)
  }
}

export class HoldoutLock {
  #publishedHash: string | null = null
  publish(calibrationHash: string, evaluation: JsonValue): string {
    if (this.#publishedHash !== null) throw new Error('holdout was already evaluated')
    this.#publishedHash = sha256(canonicalJson({ calibrationHash, evaluation }))
    return this.#publishedHash
  }
  get publishedHash(): string | null { return this.#publishedHash }
}

export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function reason(code: string, detail: string, path?: string): ImportReason { return path === undefined ? { code, severity: 'error', detail } : { code, severity: 'error', detail, path } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function isEnvelope(value: Record<string, unknown>): value is Record<string, unknown> & SignedEnvelope<JsonValue> { return value.algorithm === 'Ed25519' && typeof value.keyId === 'string' && typeof value.signedAt === 'string' && typeof value.signature === 'string' && 'payload' in value }
function decimal(value: unknown): number | null { const number = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value; return Number.isSafeInteger(number) && Number(number) >= 0 ? Number(number) : null }
function integer(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null }
function unsignedBigInt(value: unknown): bigint | null { try { return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null } catch { return null } }
function nulText(value: Uint8Array): string { const end = value.indexOf(0); return Buffer.from(end < 0 ? value : value.subarray(0, end)).toString('utf8') }
function looksLikeArchive(value: Uint8Array): boolean {
  return (value[0] === 0x50 && value[1] === 0x4b) || (value[0] === 0x1f && value[1] === 0x8b) ||
    (value[0] === 0x28 && value[1] === 0xb5 && value[2] === 0x2f && value[3] === 0xfd) ||
    (value.byteLength > 262 && Buffer.from(value.subarray(257, 262)).toString('ascii') === 'ustar')
}
function deduplicateReasons(values: readonly ImportReason[]): ImportReason[] { const seen = new Set<string>(); return values.filter((value) => { const key = canonicalJson(value as unknown as JsonValue); if (seen.has(key)) return false; seen.add(key); return true }) }
function finiteValues(values: readonly number[]): void { if (values.some((value) => !Number.isFinite(value))) throw new Error('nonfinite observation') }
function compensatedSum(values: readonly number[]): number { let sum = 0, correction = 0; for (const value of values) { const next = sum + value; correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum; sum = next } return sum + correction }
function seededRandom(seed: string): () => number { let state = BigInt(`0x${sha256(seed).slice(0, 16)}`) || 1n; return () => { state ^= state >> 12n; state ^= state << 25n; state ^= state >> 27n; state = BigInt.asUintN(64, state); return Number(BigInt.asUintN(53, state * 2685821657736338717n)) / 2 ** 53 } }
function normalCdf(value: number): number { const t = 1 / (1 + 0.2316419 * Math.abs(value)); const density = Math.exp(-value * value / 2) / Math.sqrt(2 * Math.PI); const p = 1 - density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return value >= 0 ? p : 1 - p }
function inverseNormal(p: number): number { if (!(p > 0 && p < 1)) throw new Error('invalid normal probability'); let low = -8, high = 8; for (let i = 0; i < 100; i += 1) { const mid = (low + high) / 2; if (normalCdf(mid) < p) low = mid; else high = mid } return (low + high) / 2 }
function adjustedBca(z0: number, acceleration: number, probability: number): number { const z = inverseNormal(probability); return Math.max(0, Math.min(1, normalCdf(z0 + (z0 + z) / (1 - acceleration * (z0 + z))))) }
function softThreshold(value: number, threshold: number): number { return Math.sign(value) * Math.max(0, Math.abs(value) - threshold) }
function gram(x: readonly (readonly number[])[], weights: readonly number[]): number[][] { const p = x[0]!.length; return Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => compensatedSum(x.map((row, index) => weights[index]! * row[i]! * row[j]!)))) }
function jacobiEigenvalues(matrix: readonly (readonly number[])[]): number[] { const a = matrix.map((row) => [...row]); for (let iteration = 0; iteration < 100 * a.length ** 2; iteration += 1) { let p = 0, q = 0, largest = 0; for (let i = 0; i < a.length; i += 1) for (let j = i + 1; j < a.length; j += 1) if (Math.abs(a[i]![j]!) > largest) { largest = Math.abs(a[i]![j]!); p = i; q = j } if (largest < 1e-12) break; const angle = 0.5 * Math.atan2(2 * a[p]![q]!, a[q]![q]! - a[p]![p]!); const c = Math.cos(angle), s = Math.sin(angle); for (let k = 0; k < a.length; k += 1) { const apk = a[p]![k]!, aqk = a[q]![k]!; a[p]![k] = c * apk - s * aqk; a[q]![k] = s * apk + c * aqk } for (let k = 0; k < a.length; k += 1) { const akp = a[k]![p]!, akq = a[k]![q]!; a[k]![p] = c * akp - s * akq; a[k]![q] = s * akp + c * akq } } return a.map((row, index) => Math.max(0, row[index]!)).sort((a, b) => b - a) }
function ranks(values: readonly number[]): number[] { const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value); const result = Array(values.length).fill(0) as number[]; for (let i = 0; i < ordered.length;) { let j = i + 1; while (j < ordered.length && ordered[j]!.value === ordered[i]!.value) j += 1; const rank = (i + j - 1) / 2 + 1; for (let k = i; k < j; k += 1) result[ordered[k]!.index] = rank; i = j } return result }
function failValue(message: string): never { throw new Error(message) }
function weightedAverage(values: readonly number[], weights: readonly number[]): number { return compensatedSum(values.map((value, index) => value * weights[index]!)) / compensatedSum(weights) }
function weightedQuantile(values: readonly number[], weights: readonly number[], probability: number): number {
  const ordered = values.map((value, index) => ({ value, weight: weights[index]! })).filter((item) => item.weight > 0).sort((a, b) => a.value - b.value)
  const threshold = probability * compensatedSum(ordered.map((item) => item.weight))
  let cumulative = 0
  for (const item of ordered) { cumulative += item.weight; if (cumulative >= threshold) return item.value }
  return ordered.at(-1)!.value
}
function weightedPearson(a: readonly number[], b: readonly number[], weights: readonly number[]): number | null {
  const ma = weightedAverage(a, weights), mb = weightedAverage(b, weights)
  const numerator = compensatedSum(a.map((value, index) => weights[index]! * (value - ma) * (b[index]! - mb)))
  const da = compensatedSum(a.map((value, index) => weights[index]! * (value - ma) ** 2))
  const db = compensatedSum(b.map((value, index) => weights[index]! * (value - mb) ** 2))
  return da > 0 && db > 0 ? numerator / Math.sqrt(da * db) : null
}
