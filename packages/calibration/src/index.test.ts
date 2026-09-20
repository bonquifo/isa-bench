import { describe, expect, it } from 'vitest'
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { buildEmpiricalSchedule, canonicalJson, type JsonValue } from '@isa-sim/contracts'
import {
  HoldoutLock,
  adjustIdleEnergy,
  assertApplicable,
  bootstrapInterval,
  bootstrapLinearFit,
  calibrateSplitConformal,
  createFrozenSplit,
  fitConstrainedLinear,
  inspectArchiveEntries,
  inspectJsonlBundle,
  intervalMetrics,
  pairedLogRatios,
  parseTarIndex,
  regressionMetrics,
  robustLogFlags,
  sha256,
  summarizeExact,
  validateConfidenceInterval,
  validateUncertaintyBudget,
} from './index.js'

describe('calibration statistics', () => {
  it('computes deterministic exact descriptive statistics', () => {
    expect(summarizeExact([1, 2, 3, 4, 5])).toEqual({
      count: 5, mean: 3, sampleSd: Math.sqrt(2.5), median: 3, mad: 1, min: 1, max: 5,
      quantiles: { '0.025': 1.1, '0.25': 2, '0.5': 3, '0.75': 4, '0.975': 4.9 },
      sem: Math.sqrt(0.5),
    })
  })

  it('handles zero MAD without silently dropping observations', () => {
    expect(robustLogFlags([2, 2, 2, 4]).map((item) => item.flagged)).toEqual([false, false, false, true])
    expect(robustLogFlags([2, 2, 2, 4], 'flag-none').every((item) => !item.flagged)).toBe(true)
  })

  it('is deterministic for block and cluster bootstrap', () => {
    const values = [
      { value: 1, blockId: 'a', clusterId: 'm1' }, { value: 2, blockId: 'a', clusterId: 'm1' },
      { value: 4, blockId: 'b', clusterId: 'm2' }, { value: 8, blockId: 'b', clusterId: 'm2' },
      { value: 3, blockId: 'c', clusterId: 'm3' }, { value: 6, blockId: 'c', clusterId: 'm3' },
    ]
    const first = bootstrapInterval(values, { seed: 'fixture-7', iterations: 500, method: 'bca', unit: 'block' })
    expect(bootstrapInterval(values, { seed: 'fixture-7', iterations: 500, method: 'bca', unit: 'block' })).toEqual(first)
    expect(bootstrapInterval(values, { seed: 'fixture-7', iterations: 500, unit: 'cluster' })).toEqual(
      bootstrapInterval(values, { seed: 'fixture-7', iterations: 500, unit: 'cluster' }),
    )
    expect(() => bootstrapInterval(values.slice(0, 4), { seed: 'fixture-7', iterations: 500, method: 'bca', unit: 'cluster' })).toThrow(/three/)
  })

  it('preserves pair IDs and negative idle-adjusted energy', () => {
    expect(pairedLogRatios([{ pairId: 'p1', treatment: 20, reference: 10, durationScope: 'roi' }])).toEqual([{ pairId: 'p1', logRatio: Math.log(2) }])
    const common = { pairId: 'p1', adapter: 'rapl', domain: 'package', scope: 'roi', boundary: 'socket', machineId: 'm1', controlsHash: 'c', clockId: 'mono' }
    expect(adjustIdleEnergy(
      { ...common, sampleId: 'active', joules: 2, durationSeconds: 1 },
      { ...common, sampleId: 'idle', joules: 3, durationSeconds: 1 },
    )).toEqual({ grossJoules: 2, idleJoules: 3, idleAdjustedJoules: -1 })
    expect(() => adjustIdleEnergy(
      { ...common, sampleId: 'active', joules: 2, durationSeconds: 1 },
      { ...common, domain: 'dram', sampleId: 'idle', joules: 1, durationSeconds: 1 },
    )).toThrow(/domain/)
  })
})

describe('datasets and fitting', () => {
  it('never leaks workload families across frozen partitions', () => {
    const members = Array.from({ length: 80 }, (_, index) => ({ id: `r${index}`, family: `f${index}`, sessionId: `s${index}` }))
    const split = createFrozenSplit(members, { seed: 'split-1' })
    for (const family of new Set(members.map((item) => item.family))) {
      const partitions = new Set(members.filter((item) => item.family === family).map((item) =>
        split.trainingIds.includes(item.id) ? 'train' : split.selectionIds.includes(item.id) ? 'selection' : split.conformalIds.includes(item.id) ? 'conformal' : 'holdout'))
      expect(partitions.size).toBe(1)
    }
    expect(() => createFrozenSplit(members.map((item, index) => index < 2 ? { ...item, sessionId: 'shared-cross-family' } : item), { seed: 'split-1' })).toThrow(/session spans workload families/)
  })

  it('recovers physical-unit synthetic coefficients exactly', () => {
    const rows = Array.from({ length: 30 }, (_, index) => {
      const x = index - 10, z = ((index * 7) % 11) - 5
      return { id: String(index), family: `f${index % 5}`, features: { x, z }, target: 2 + 3 * x + 4 * z }
    })
    const fit = fitConstrainedLinear(rows, { lambda: 0, tolerance: 1e-12 })
    expect(fit.intercept).toBeCloseTo(2, 9)
    expect(fit.coefficients.x).toBeCloseTo(3, 9)
    expect(fit.coefficients.z).toBeCloseTo(4, 9)
  })

  it('enforces nonnegative energy coefficients and rejects rank deficiency', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ id: String(index), family: 'f', features: { events: index + 1 }, target: 1 + 0.5 * (index + 1) }))
    const fit = fitConstrainedLinear(rows, { kind: 'nonnegative-energy', lambda: 0 })
    expect(fit.intercept).toBeCloseTo(1, 8)
    expect(fit.coefficients.events).toBeCloseTo(0.5, 8)
    expect(fit.interceptConstrained).toBe(true)
    expect(fit.kktResidual).toBeLessThan(1e-7)
    const elastic = fitConstrainedLinear(rows, { kind: 'elastic-net', fitIntercept: false, lambda: 1, l1Ratio: 0.5, tolerance: 1e-12 })
    expect(elastic.kktResidual).toBeLessThan(1e-8)
    expect(elastic.kktResidual).not.toBeCloseTo(0.5, 3)
    expect(() => fitConstrainedLinear(rows.map((row) => ({ ...row, features: { a: row.features.events, b: row.features.events * 2 } })))).toThrow(/rank deficiency|collinearity/)
  })

  it('honors weights, exact zero intercept, and NNLS boundary optima', () => {
    const divergent = [
      { id: 'a', family: 'a', features: { x: 1 }, target: 10, weight: 100 },
      { id: 'b', family: 'b', features: { x: 2 }, target: 2, weight: 1 },
    ]
    expect(fitConstrainedLinear(divergent, { fitIntercept: false, lambda: 0 }).coefficients.x).toBeCloseTo(1004 / 104, 10)
    const zero = fitConstrainedLinear([
      { id: 'a', family: 'a', features: { x: 1 }, target: 1 },
      { id: 'b', family: 'b', features: { x: 2 }, target: 2 },
      { id: 'c', family: 'c', features: { x: 3 }, target: 3 },
    ], { fitIntercept: false, lambda: 0 })
    expect(zero.intercept).toBe(0)
    expect(zero.coefficients.x).toBeCloseTo(1, 12)
    const boundary = fitConstrainedLinear([
      { id: 'a', family: 'a', features: { x: 1 }, target: 3 },
      { id: 'b', family: 'b', features: { x: 2 }, target: 2 },
      { id: 'c', family: 'c', features: { x: 3 }, target: 1 },
    ], { kind: 'nonnegative-energy', lambda: 0, tolerance: 1e-12 })
    expect(boundary.coefficients.x).toBeCloseTo(0, 9)
    expect(boundary.intercept).toBeCloseTo(2, 9)
    expect(boundary.kktResidual).toBeLessThan(1e-7)
  })

  it('retries degenerate grouped bootstrap fits deterministically', () => {
    const rows = [1, 2, 3].map((x) => ({ id: String(x), family: `f${x}`, features: { x }, target: 1 + 2 * x }))
    const result = bootstrapLinearFit(rows, [{ x: 4 }], { seed: 'retry', iterations: 100, maxRetries: 100, fit: { lambda: 0 } })
    expect(result.iterations).toBe(100)
    expect(result.failures).toBeGreaterThan(0)
    expect(result.predictionDistributions[0]!.every(Number.isFinite)).toBe(true)
    expect(result).toMatchObject({ groupCount: 3, minimumGroups: 3, minimumSuccessfulFits: 90 })
    expect(() => bootstrapLinearFit(rows.map((row) => ({ ...row, family: 'only-family' })), [{ x: 4 }], { seed: 'bad', iterations: 100 })).toThrow(/unavailable.*insufficient independent family groups/)
  })

  it('locks holdout once and rejects extrapolation', () => {
    const lock = new HoldoutLock()
    expect(lock.publish('a'.repeat(64), { rmse: 1 })).toMatch(/^[a-f0-9]{64}$/)
    expect(() => lock.publish('a'.repeat(64), { rmse: 1 })).toThrow(/already/)
    const predicate = { cpu: 'c', microcode: 'm', kernel: 'k', toolchainHash: 't', controlsHash: 'x', sensorBoundary: 'package', corpusHash: 'r', simulatorVersion: '1', parameterRanges: { size: [1, 10] as const } }
    expect(() => assertApplicable(predicate, { ...predicate, parameters: { size: 11 } })).toThrow(/extrapolation/)
    expect(() => assertApplicable(predicate, { ...predicate, parameters: { size: 2, extra: 1 } })).toThrow(/parameter set/)
    expect(() => assertApplicable(predicate, { ...predicate, parameters: { size: Number.NaN } })).toThrow(/extrapolation/)
    expect(() => assertApplicable(predicate, { ...predicate, cpu: 'different', parameters: { size: 2 } })).toThrow(/cpu/)
    expect(() => assertApplicable(predicate, { ...predicate, extrasVersion: 'unexpected', parameters: { size: 2 } })).toThrow(/extrasVersion/)
  })

  it('reports point and interval metrics', () => {
    expect(regressionMetrics([1, 2, 3], [1, 2, 3])).toMatchObject({ mae: 0, rmse: 0, signedBias: 0, r2: 1, spearman: 1 })
    const intervals = intervalMetrics([1, 2], [0, 2.1], [1.1, 3], 0.5)
    expect(intervals).toMatchObject({ coverage: 0.5, meanWidth: 1 })
    expect(intervals.intervalScore).toBeCloseTo(1.2, 12)
    expect(() => intervalMetrics([1], [Number.NaN], [2], 0.95)).toThrow(/nonfinite/)
    expect(() => validateConfidenceInterval({ lower: 0, upper: 2, estimate: 3, level: 0.95, method: 'percentile', iterations: 10, seed: 's', unit: 'J', domain: 'energy' })).toThrow(/interval/)
    expect(() => validateUncertaintyBudget({ repetition: 1, coefficient: 1, residual: 1, sensorCalibration: 1, clockAlignment: Number.POSITIVE_INFINITY, idleBaseline: 1 })).toThrow(/uncertainty/)
    const conformal = calibrateSplitConformal(Array.from({ length: 10 }, (_, index) => ({ id: `v${index}`, actual: index, predicted: index + index / 10 })))
    expect(conformal).toMatchObject({
      method: 'validation-split-conformal-absolute-residual',
      sampleCount: 10,
      intervals: { '0.5': { correctedRank: 6 }, '0.95': { correctedRank: 10 } },
    })
    expect(conformal.intervals['0.5'].radius).toBeCloseTo(0.5)
    expect(conformal.intervals['0.95'].radius).toBeCloseTo(0.9)
    expect(() => calibrateSplitConformal([{ id: 'v', actual: 1, predicted: 1 }])).toThrow(/at least 10/)
  })
})

describe('archive boundary', () => {
  it('rejects traversal, special files, aliases, nesting, and bombs', () => {
    const reasons = inspectArchiveEntries([
      { name: '../escape', type: 'file', size: 1 },
      { name: 'safe/data', type: 'symlink', size: 0 },
      { name: 'SAFE/DATA', type: 'file', size: 1 },
      { name: 'con.txt', type: 'file', size: 1 },
      { name: 'nested.tar', type: 'file', size: 1_000_000 },
    ], 1)
    expect(new Set(reasons.map((item) => item.code))).toEqual(expect.objectContaining(new Set(['unsafe-path', 'special-entry', 'duplicate-name', 'nested-archive', 'decompression-ratio'])))
  })

  it('rejects tar footer smuggling', () => {
    const header = Buffer.alloc(512)
    header.write('evidence.jsonl')
    header.write('00000000000\0', 124, 'ascii')
    header[156] = 48
    header.fill(32, 148, 156)
    const checksum = [...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0')
    header.write(`${checksum}\0 `, 148, 'ascii')
    const archive = Buffer.concat([header, Buffer.alloc(1024), Buffer.from('hidden')])
    expect(parseTarIndex(archive).reasons.some((reason) => reason.code === 'tar-trailing-data')).toBe(true)
  })

  it('reconciles every raw record to the exact signed schedule', () => {
    const key = generateKeyPairSync('ed25519').privateKey
    const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64')
    const keyId = 'runner-key', signedAt = '2026-08-27T12:00:00.000Z', leaseNonce = 'lease-nonce'
    const { entries, protocol } = buildEmpiricalSchedule('seed', 32, 0)
    const envelope = (payload: JsonValue) => {
      const protectedHeader = { algorithm: 'Ed25519' as const, keyId, signedAt }
      return { ...protectedHeader, payload, signature: sign(null, Buffer.from(canonicalJson({ protected: protectedHeader, payload })), key).toString('base64') }
    }
    const schedulePayload = { jobId: 'job-1', seed: 'seed', entries, protocol }
    const raw = (sampleId: string, phase: string, ordinal: number, pairId: string, start: number) => ({
      kind: 'raw-run', sampleId, phase, block: ordinal >= 0 ? 0 : -1, arm: phase === 'idle' ? 'B' : 'A', ordinal, pairId,
      valid: true, validityReasons: [], monotonicStartedNs: String(start), monotonicDurationNs: '10', timedOut: false,
      oracle: { passed: true, detail: 'ok', iterations: '1', nonce: leaseNonce }, affinity: { requested: [0], effective: [0] },
      perf: [], energy: [], controlsBefore: {}, controlsAfter: {},
    })
    const records = [
      { kind: 'schedule', ...schedulePayload, signed: envelope(schedulePayload) },
      raw('overhead', 'idle', -100, 'instrumentation-overhead', 10),
      raw('pilot', 'pilot', -1, 'pilot-0', 30),
      ...entries.map((entry, index) => ({ ...raw(`scheduled-${index}`, entry.phase, entry.ordinal, entry.pairId, 50 + index * 20), block: entry.block, arm: entry.arm })),
    ]
    const header = { kind: 'header', schemaVersion: '1', testOnly: false, runnerId: 'runner-1', jobId: 'job-1', createdAt: signedAt }
    const body = Buffer.from(`${[header, ...records].map((item) => canonicalJson(item as JsonValue)).join('\n')}\n`)
    const index = { kind: 'index', schemaVersion: '1', runnerId: 'runner-1', jobId: 'job-1', sha256: sha256(body), byteSize: String(body.byteLength), recordCount: records.length, artifactIdentities: ['a'.repeat(64)] }
    const bundle = Buffer.from(`${body.toString()}${canonicalJson(index)}\n`)
    const context = {
      production: true, now: Date.parse('2026-08-27T12:01:00.000Z'), signedIndex: envelope(index),
      runner: { id: 'runner-1', keyId, publicKey, stateAtMeasurement: 'approved', stateAtImport: 'approved', credentialIssuedAt: '2026-08-27T11:00:00.000Z', credentialExpiresAt: '2026-08-28T11:00:00.000Z' },
      expected: { runnerId: 'runner-1', jobId: 'job-1', leaseNonce, binarySha256: 'a'.repeat(64), seed: 'seed', repetitions: 32, warmups: 0, adapters: [], controls: {} },
    } as const
    const accepted = inspectJsonlBundle(bundle, context)
    expect(accepted.reasons).toEqual([])
    const mismatched = records.map((record) => record.kind === 'raw-run' && record.ordinal === 1 ? { ...record, pairId: 'wrong' } : record)
    const badBody = Buffer.from(`${[header, ...mismatched].map((item) => canonicalJson(item as JsonValue)).join('\n')}\n`)
    const badIndex = { ...index, sha256: sha256(badBody), byteSize: String(badBody.byteLength) }
    const badBundle = Buffer.from(`${badBody.toString()}${canonicalJson(badIndex)}\n`)
    const result = inspectJsonlBundle(badBundle, { ...context, signedIndex: envelope(badIndex) })
    expect(result.accepted).toBe(false)
    expect(result.reasons.some((reason) => reason.code === 'raw-schedule-reconciliation')).toBe(true)
    const withUnscheduledNegative = [...records, raw('unscheduled', 'warmup', -7, 'not-declared', 90)]
    const extraBody = Buffer.from(`${[header, ...withUnscheduledNegative].map((item) => canonicalJson(item as JsonValue)).join('\n')}\n`)
    const extraIndex = { ...index, sha256: sha256(extraBody), byteSize: String(extraBody.byteLength), recordCount: withUnscheduledNegative.length }
    const extraResult = inspectJsonlBundle(Buffer.from(`${extraBody.toString()}${canonicalJson(extraIndex)}\n`), { ...context, signedIndex: envelope(extraIndex) })
    expect(extraResult.reasons.some((reason) => reason.code === 'unscheduled-raw')).toBe(true)
  })
})
