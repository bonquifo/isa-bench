import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const WORKLOAD_IDS = [
  'int_sum', 'dot_product', 'saxpy', 'memcpy', 'matmul', 'insertion_sort',
  'binary_search', 'sieve', 'checksum', 'pointer_chase', 'fir', 'fp_sum',
] as const

export type WorkloadId = typeof WORKLOAD_IDS[number]

export interface CorpusWorkload {
  id: WorkloadId
  version: number
  family: string
  selector: number
  n: { meaning: string; min: number; max: number; default: number }
  seed: { meaning: string; used: boolean; default: number }
  inputLayout: string
  oracle: string
  roi: string
  targets: {
    native: 'all'
    mos: { maxN: number } | { supported: false; reason: string }
  }
}

export interface CorpusManifest {
  schemaVersion: 1
  corpusVersion: string
  sourceDateEpoch: number
  source: { path: string; sha256: string; license: string }
  integerSemantics: Record<string, string>
  workloads: CorpusWorkload[]
}

export interface EligibilityRecord {
  workload: WorkloadId
  target: string
  eligible: boolean
  reason?: string
  coreObjectSha256?: string
  binarySha256?: string
  metadataSha256?: string
  disassemblySha256?: string
  roiHash?: string
  roiDescriptor?: {
    schemaVersion: 1
    symbol: 'isa_bench_core'
    markerBegin: 'isa_bench_roi_begin'
    markerEnd: 'isa_bench_roi_end'
    staticAnalysisScope: 'core-symbol-only'
    executionScope: 'whole-process-static-binary'
    coreObjectSha256: string
  }
  coreBytes?: number
  totalBytes?: number
  semanticExecution?: { frameVersion: 1; rawBits: string; matchedOracle: true }
  reproducibility?: {
    cleanBuilds: 2
    objectIdentical: true
    binaryIdentical: true
    retainedArtifactsIdentical: true
    normalizedExclusions: string[]
  }
}

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url))

export function loadManifest(path = manifestPath): CorpusManifest {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  validateManifest(value)
  return value
}

export function validateManifest(value: unknown): asserts value is CorpusManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.corpusVersion !== 'string') {
    throw new Error('unsupported native corpus manifest')
  }
  if (!Number.isSafeInteger(value.sourceDateEpoch) || !isRecord(value.source) ||
      typeof value.source.path !== 'string' || !isSha(value.source.sha256)) {
    throw new Error('manifest source contract is incomplete')
  }
  if (!isRecord(value.integerSemantics) || !Array.isArray(value.workloads) ||
      value.workloads.length !== WORKLOAD_IDS.length) {
    throw new Error('manifest must contain the twelve workload mappings')
  }
  const seen = new Set<string>()
  for (const candidate of value.workloads) {
    if (!isRecord(candidate) || !WORKLOAD_IDS.includes(candidate.id as WorkloadId) ||
        seen.has(String(candidate.id)) || candidate.version !== 1 ||
        typeof candidate.family !== 'string' || !Number.isInteger(candidate.selector) ||
        !isRecord(candidate.n) || !Number.isInteger(candidate.n.min) ||
        !Number.isInteger(candidate.n.max) || !Number.isInteger(candidate.n.default) ||
        Number(candidate.n.min) > Number(candidate.n.default) ||
        Number(candidate.n.default) > Number(candidate.n.max) ||
        !isRecord(candidate.seed) || typeof candidate.seed.used !== 'boolean' ||
        !Number.isInteger(candidate.seed.default) ||
        typeof candidate.inputLayout !== 'string' || candidate.inputLayout.length === 0 ||
        typeof candidate.oracle !== 'string' || candidate.oracle.length === 0 ||
        typeof candidate.roi !== 'string' || candidate.roi.length === 0 ||
        !isRecord(candidate.targets)) {
      throw new Error(`invalid workload mapping ${String(candidate.id)}`)
    }
    seen.add(String(candidate.id))
  }
  if (WORKLOAD_IDS.some((id) => !seen.has(id))) throw new Error('workload mapping is incomplete')
}

export function sourceSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function expectedRaw(workload: WorkloadId, n: number, seed: number): bigint {
  if (!Number.isInteger(n) || !Number.isInteger(seed)) throw new Error('N and seed must be integers')
  const mapping = loadManifest().workloads.find((item) => item.id === workload)
  if (!mapping || n < mapping.n.min || n > mapping.n.max) throw new Error('N is outside workload bounds')
  const next = lcg(seed)
  let result: number
  switch (workload) {
    case 'int_sum': {
      result = 0
      for (let i = 0; i < n; ++i) result = add32(result, i)
      break
    }
    case 'dot_product': {
      const a = Array.from({ length: n }, () => (next() % 17) - 8)
      const b = Array.from({ length: n }, () => (next() % 13) - 6)
      result = 0
      for (let i = 0; i < n; ++i) result = add32(result, Math.imul(a[i]!, b[i]!))
      break
    }
    case 'saxpy': {
      const x = Array.from({ length: n }, () => (next() % 11) - 5)
      const y = Array.from({ length: n }, () => (next() % 9) - 4)
      result = fnv(y.map((value, index) => add32(value, Math.imul(3, x[index]!))))
      break
    }
    case 'memcpy':
      result = fnv(Array.from({ length: n }, () => next()))
      break
    case 'matmul': {
      const a = Array.from({ length: n * n }, () => (next() % 7) - 3)
      const b = Array.from({ length: n * n }, () => (next() % 7) - 3)
      const c: number[] = []
      for (let i = 0; i < n; ++i) for (let j = 0; j < n; ++j) {
        let acc = 0
        for (let k = 0; k < n; ++k) acc = add32(acc, Math.imul(a[i * n + k]!, b[k * n + j]!))
        c.push(acc)
      }
      result = fnv(c)
      break
    }
    case 'insertion_sort': {
      const values = Array.from({ length: n }, () => next())
      values.sort((left, right) => left - right)
      result = fnv(values)
      break
    }
    case 'binary_search': {
      const values = Array.from({ length: n }, () => next() % 10000).sort((left, right) => left - right)
      const keys = Array.from({ length: n }, (_, i) => i % 3 === 0 ? next() % 10000 : values[i]!)
      result = 0
      for (const key of keys) {
        let lo = 0
        let hi = n - 1
        let found = -1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (values[mid] === key) { found = mid; break }
          if (values[mid]! < key) lo = mid + 1
          else hi = mid - 1
        }
        result = add32(result, found)
      }
      break
    }
    case 'sieve': {
      const marks = new Uint8Array(n + 1)
      marks.fill(1)
      marks[0] = 0
      marks[1] = 0
      for (let i = 2; i <= Math.floor(n / i); ++i) {
        if (marks[i] === 0) continue
        for (let j = i * i; j <= n; j += i) marks[j] = 0
      }
      result = marks.reduce((sum, mark, i) => sum + (i >= 2 && mark !== 0 ? 1 : 0), 0)
      break
    }
    case 'checksum': {
      result = seed | 0
      for (let i = 0; i < n; ++i) {
        result = (result ^ i) | 0
        result = add32((result << 5) | (result >>> 27), 0x9e3779b9)
        result = (result ^ (result >>> 7)) | 0
      }
      break
    }
    case 'pointer_chase': {
      const order = Array.from({ length: n }, (_, i) => i)
      for (let i = n - 1; i > 0; --i) {
        const j = (next() >>> 0) % (i + 1)
        ;[order[i], order[j]] = [order[j]!, order[i]!]
      }
      const links = new Int32Array(n)
      for (let i = 0; i < n; ++i) links[order[i]!] = order[(i + 1) % n]!
      let node = 0
      result = 0
      for (let i = 0; i < n; ++i) {
        result = add32(result, add32(Math.imul(node, 17), seed))
        node = links[node]!
      }
      break
    }
    case 'fir': {
      const coefficients = [1, -2, 3, -1, 2, 1, -1, 1]
      const input = Array.from({ length: n }, () => (next() % 21) - 10)
      result = 0
      for (let i = 0; i < n; ++i) {
        let acc = 0
        for (let k = 0; k < 8; ++k) acc = add32(acc, Math.imul(coefficients[k]!, i >= k ? input[i - k]! : 0))
        result = add32(result, acc)
      }
      break
    }
    case 'fp_sum': {
      let sum = 0
      for (let i = 0; i < n; ++i) sum += ((next() % 2001) - 1000) / 100
      return f64Raw(sum)
    }
  }
  return BigInt(result >>> 0)
}

export function parseV1Frame(bytes: Uint8Array): { kind: 'i32' | 'binary64'; rawBits: bigint } {
  if (bytes.byteLength !== 24) throw new Error('native corpus frame must be exactly 24 bytes')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46415349 || view.getUint16(4, true) !== 1 ||
      view.getUint8(6) !== 0 || view.getUint32(16, true) !== 0 || view.getUint32(20, true) !== 0) {
    throw new Error('invalid successful v1 result frame')
  }
  const kind = view.getUint8(7)
  if (kind !== 0 && kind !== 1) throw new Error('invalid result kind')
  const rawBits = view.getBigUint64(8, true)
  if (kind === 0 && (rawBits >> 32n) !== 0n) throw new Error('i32 frame has nonzero high bits')
  return { kind: kind === 0 ? 'i32' : 'binary64', rawBits }
}

export function validateEligibility(record: EligibilityRecord): void {
  if (!record.eligible) {
    if (!record.reason) throw new Error('ineligible record requires an explicit reason')
    return
  }
  if (!isSha(record.coreObjectSha256) || !isSha(record.binarySha256) ||
      !isSha(record.metadataSha256) || !isSha(record.disassemblySha256) ||
      !isSha(record.roiHash) || record.roiDescriptor?.symbol !== 'isa_bench_core' ||
      record.roiDescriptor.staticAnalysisScope !== 'core-symbol-only' ||
      record.roiDescriptor.executionScope !== 'whole-process-static-binary' ||
      record.roiDescriptor.coreObjectSha256 !== record.coreObjectSha256 ||
      !record.coreBytes || !record.totalBytes || !record.semanticExecution?.matchedOracle ||
      record.semanticExecution.frameVersion !== 1 ||
      record.reproducibility?.cleanBuilds !== 2 ||
      !record.reproducibility.objectIdentical || !record.reproducibility.binaryIdentical ||
      !record.reproducibility.retainedArtifactsIdentical) {
    throw new Error('eligible artifact lacks evidence')
  }
}

export function assertSafeBuildArg(value: string): void {
  if (!/^[A-Za-z0-9_./:=+,-]+$/.test(value) || value.includes('..')) {
    throw new Error(`unsafe build argument: ${value}`)
  }
}

function lcg(seed: number): () => number {
  let state = seed | 0
  return () => (state = (Math.imul(state, 1664525) + 1013904223) | 0)
}

function add32(left: number, right: number): number {
  return (left + right) | 0
}

function fnv(words: number[]): number {
  let hash = 2166136261
  for (const word of words) hash = Math.imul(hash ^ word, 16777619)
  return hash | 0
}

function f64Raw(value: number): bigint {
  const bytes = new ArrayBuffer(8)
  const view = new DataView(bytes)
  view.setFloat64(0, value, true)
  return view.getBigUint64(0, true)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
