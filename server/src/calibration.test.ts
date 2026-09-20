import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEmpiricalSchedule, canonicalJson } from '@isa-sim/contracts'
import { sha256 } from '@isa-sim/calibration'
import { createBackend, type Backend } from './app.js'

const roots: string[] = []
const backends: Backend[] = []
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.app.close()))
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe('calibration persistence boundary', () => {
  it('requires admin auth, rejects synthetic import, and leaves production tables empty', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'isa-sim-calibration-'))
    roots.push(dataDir)
    const backend = await createBackend({ dataDir, concurrency: 1 })
    backends.push(backend)
    expect((await backend.app.inject({ url: '/api/calibration/status' })).statusCode).toBe(401)
    const session = await backend.app.inject({ method: 'POST', url: '/api/session' })
    const token = (session.json() as { token: string }).token
    const header = canonicalJson({
      kind: 'header', schemaVersion: '1', testOnly: true, runnerId: `runner:${'a'.repeat(64)}`,
      jobId: 'job-1', measuredAt: new Date().toISOString(),
    })
    const body = Buffer.from(`${header}\n`)
    const index = canonicalJson({
      artifacts: [], byteSize: String(body.byteLength), jobId: 'job-1', kind: 'index',
      recordCount: 0, runnerId: `runner:${'a'.repeat(64)}`, schemaVersion: '1', sha256: sha256(body),
    })
    const response = await backend.app.inject({
      method: 'POST', url: '/api/calibration/imports/inspect',
      headers: { 'x-session-token': token },
      payload: { bundleBase64: Buffer.from(`${header}\n${index}\n`).toString('base64') },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().state).toBe('rejected')
    const status = await backend.app.inject({ url: '/api/calibration/status', headers: { 'x-session-token': token } })
    expect(status.json().counts).toEqual({
      empirical_runs: 0, empirical_summaries: 0, calibration_datasets: 0, calibration_splits: 0, calibration_fits: 0,
    })
  })

  it('deduplicates repacked evidence by canonical inner bundle identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'isa-sim-calibration-replay-'))
    roots.push(dataDir)
    const backend = await createBackend({ dataDir, concurrency: 1 })
    backends.push(backend)
    const header = canonicalJson({ kind: 'header', schemaVersion: '1', testOnly: true, runnerId: `runner:${'a'.repeat(64)}`, jobId: 'job-1', createdAt: new Date().toISOString() })
    const body = Buffer.from(`${header}\n`)
    const index = canonicalJson({ artifactIdentities: [], byteSize: String(body.byteLength), jobId: 'job-1', kind: 'index', recordCount: 0, runnerId: `runner:${'a'.repeat(64)}`, schemaVersion: '1', sha256: sha256(body) })
    const inner = Buffer.from(`${header}\n${index}\n`)
    const first = backend.calibration.inspect(inner, {}, Buffer.concat([Buffer.from('outer-a'), inner]))
    expect(first.bundle_hash).toBe(sha256(inner))
    expect(() => backend.calibration.inspect(inner, {}, Buffer.concat([Buffer.from('outer-b'), inner]))).toThrow(/replay/)
    expect(backend.db.sqlite.prepare('SELECT COUNT(*) count FROM calibration_quarantine').get()).toMatchObject({ count: 1 })
  })

  it('summarizes only committed complete measured/idle pairs into provenance-bound metrics', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'isa-sim-calibration-summary-'))
    roots.push(dataDir)
    const backend = await createBackend({ dataDir, concurrency: 1 })
    backends.push(backend)
    const corpusId = 'c'.repeat(64), bundleHash = 'd'.repeat(64), now = new Date().toISOString()
    ;(backend.calibration as unknown as { corpus: unknown }).corpus = {
      artifact: () => ({ files: [], record: { corpusVersion: '1', workloadVersion: 1, workload: 'dot_product', target: 'x86_64-linux', family: 'arithmetic', n: 32, seed: 1, compiler: 'locked', image: { build: 'locked' }, flags: [], roiHash: 'e'.repeat(64), simulatorVersion: 'sim-1', modelVersion: 'inorder-1.0.0', profileId: 'same-mid' } }),
    }
    backend.db.sqlite.prepare('INSERT INTO empirical_jobs VALUES(?,?,?,0,?,?,?,?,0,NULL,?,?)').run(
      'job-summary', canonicalJson({ binary: { corpusId }, target: { isa: 'x86_64', os: 'linux', abi: 'gnu' } }), 'finished', 'runner-summary', 'lease', 'nonce', now, now, now,
    )
    const schedule = buildEmpiricalSchedule('summary-seed', 32, 0)
    backend.db.sqlite.prepare('INSERT INTO calibration_quarantine(id,bundle_hash,source_hash,content_path,state,version,inspection_json,created_at,updated_at,committed_at) VALUES(?,?,?,?,?,0,?,?,?,?)').run(
      'q-summary', bundleHash, bundleHash, 'fixture', 'committed', canonicalJson({ records: [{ kind: 'schedule', entries: schedule.entries }] }), now, now, now,
    )
    const firstPair = schedule.entries.filter((entry) => entry.pairId === 'pair-0')
    const insert = backend.db.sqlite.prepare('INSERT INTO empirical_runs VALUES(?,?,?,?,?,?,?,?,?)')
    for (const entry of firstPair) {
      const id = `run-${entry.phase}`
      insert.run(id, bundleHash, 'runner-summary', 'job-summary', canonicalJson({ kind: 'raw-run', sampleId: id, ...entry, monotonicDurationNs: entry.phase === 'measured' ? '100' : '80', energy: [] }), 1, '[]', 0, now)
    }
    insert.run('run-pilot', bundleHash, 'runner-summary', 'job-summary', canonicalJson({ kind: 'raw-run', sampleId: 'run-pilot', phase: 'pilot', arm: 'A', block: -1, ordinal: -1, pairId: 'pilot-0', monotonicDurationNs: '1', energy: [] }), 1, '[]', 0, now)
    const metadata = { policyHash: 'a'.repeat(64), codeHash: 'b'.repeat(64), confidenceMethod: 'percentile', confidenceLevel: 0.95, clusterUnit: null, seed: 'summary' }
    const summaries = backend.calibration.summarize(['run-measured', 'run-idle'], metadata)
    expect(summaries).toHaveLength(1)
    expect(JSON.parse(String(summaries[0]!.summary_json))).toMatchObject({ metric: { key: 'duration', metricDomain: 'physical-time-ns', unit: 'ns' }, primary: { mean: 100 } })
    expect(() => backend.calibration.summarize(['run-measured'], metadata)).toThrow(/complete unique measured\/idle pairs/)
    expect(() => backend.calibration.summarize(['run-pilot'], metadata)).toThrow(/pilot\/warmup/)
  })

  it('materializes rows server-side, fits without client rows, and evaluates holdout once', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'isa-sim-calibration-fit-'))
    roots.push(dataDir)
    const backend = await createBackend({ dataDir, concurrency: 1 })
    backends.push(backend)
    const now = new Date().toISOString(), summaryIds: string[] = []
    for (let index = 0; index < 60; index += 1) {
      const id = sha256(`summary-${index}`), validCount = 10 + index, invalidCount = (index * index) % 7, flaggedCount = index % 3, sampleSd = 1 + (index * 5) % 11
      const summary = {
        primary: { mean: 2 + 0.5 * validCount + 0.2 * invalidCount + 0.1 * sampleSd, sampleSd },
        validCount, invalidCount, flaggedCount,
        metric: { key: 'duration', metricDomain: 'physical-time-ns', unit: 'ns' },
        source: {
          family: `family-${index}`, sessionId: `session-${index}`, machineId: `machine-${index}`, jobId: `job-${index}`, runnerId: `runner-${index}`, runIds: [`run-${index}`],
          workloadId: 'dot_product', target: 'x86_64-linux', modelVersion: 'inorder-1.0.0', profileId: 'same-mid', simulatorVersion: 'sim-1',
          toolchainHash: 'a'.repeat(64), corpusId: 'c'.repeat(64), roiDefinitionHash: 'b'.repeat(64), workloadSemanticHash: 'd'.repeat(64),
        },
      }
      backend.db.sqlite.prepare('INSERT INTO empirical_summaries VALUES(?,?,?,?)').run(id, sha256(`raw-${index}`), canonicalJson(summary), now)
      summaryIds.push(id)
    }
    const session = await backend.app.inject({ method: 'POST', url: '/api/session' })
    const auth = { 'x-session-token': (session.json() as { token: string }).token }
    const forbidden = await backend.app.inject({ method: 'POST', url: '/api/calibration/datasets', headers: auth, payload: { summaryIds, featureExtractor: 'summary-basic', featureVersion: '1', members: [] } })
    expect(forbidden.statusCode).toBe(400)
    const created = await backend.app.inject({ method: 'POST', url: '/api/calibration/datasets', headers: auth, payload: { summaryIds, featureExtractor: 'summary-basic', featureVersion: '1' } })
    expect(created.statusCode).toBe(201)
    const dataset = created.json() as { id: string; version: number }
    const frozen = await backend.app.inject({ method: 'POST', url: `/api/calibration/datasets/${dataset.id}/freeze`, headers: auth, payload: { version: dataset.version, seed: 'frozen-1' } })
    expect(frozen.statusCode).toBe(200)
    const falseEnergy = await backend.app.inject({ method: 'POST', url: '/api/calibration/calibrations', headers: auth, payload: {
      datasetId: dataset.id, modelKind: 'nonnegative-energy',
      acceptanceThresholds: { maxRmse: 1, maxMae: 1, minR2: 0, minCoverage50: 0, minCoverage95: 0 },
    } })
    expect(falseEnergy.statusCode).toBe(400)
    expect(falseEnergy.json()).toMatchObject({ detail: expect.stringMatching(/time summaries cannot create an energy calibration/) })
    const semanticInjection = await backend.app.inject({ method: 'POST', url: '/api/calibration/calibrations', headers: auth, payload: {
      datasetId: dataset.id, modelKind: 'ridge', acceptanceThresholds: { maxRmse: 1, maxMae: 1, minR2: 0, minCoverage50: 0, minCoverage95: 0 }, metricDomain: 'physical-energy-j',
    } })
    expect(semanticInjection.statusCode).toBe(400)
    const calibrationResponse = await backend.app.inject({ method: 'POST', url: '/api/calibration/calibrations', headers: auth, payload: {
      datasetId: dataset.id,
      modelKind: 'ridge',
      acceptanceThresholds: { maxRmse: 1e-6, maxMae: 1e-6, minR2: 0.999, minCoverage50: 0, minCoverage95: 0 },
    } })
    expect(calibrationResponse.statusCode).toBe(201)
    const calibration = calibrationResponse.json() as { id: string; version: number }
    const prematureApproval = await backend.app.inject({ method: 'POST', url: `/api/calibration/calibrations/${calibration.id}/approve`, headers: auth, payload: { version: 0 } })
    expect(prematureApproval.statusCode).toBe(409)
    const clientRows = await backend.app.inject({ method: 'POST', url: `/api/calibration/calibrations/${calibration.id}/fit`, headers: auth, payload: { version: 0, configs: [{ lambda: 0 }], rows: [] } })
    expect(clientRows.statusCode).toBe(400)
    const fitted = await backend.app.inject({ method: 'POST', url: `/api/calibration/calibrations/${calibration.id}/fit`, headers: auth, payload: { version: 0, configs: [{ lambda: 0 }] } })
    expect(fitted.statusCode).toBe(200)
    const fittedModel = JSON.parse((fitted.json() as { fit_json: string }).fit_json) as { coefficients: Record<string, number>; intercept: number }
    expect(fittedModel.intercept).toBeCloseTo(2, 8)
    expect(fittedModel.coefficients.validCount).toBeCloseTo(0.5, 8)
    expect(fittedModel.coefficients.invalidCount).toBeCloseTo(0.2, 8)
    expect(fittedModel.coefficients.sampleSd).toBeCloseTo(0.1, 8)
    const evaluated = await backend.app.inject({ method: 'POST', url: `/api/calibration/calibrations/${calibration.id}/evaluate-holdout`, headers: auth, payload: { version: 1 } })
    expect(evaluated.statusCode).toBe(200)
    expect(evaluated.json()).toMatchObject({ state: 'pending_review', version: 3 })
    const reviewedEvaluation = (evaluated.json() as { evaluation_json: string }).evaluation_json
    const approved = await backend.app.inject({ method: 'POST', url: `/api/calibration/calibrations/${calibration.id}/approve`, headers: auth, payload: { version: 3 } })
    expect(approved.statusCode).toBe(200)
    const approvedBody = approved.json() as { evaluation_json: string; holdout_lock_hash: string; state: string }
    expect(approvedBody.state).toBe('approved')
    expect(approvedBody.evaluation_json).toBe(reviewedEvaluation)
    const evaluation = JSON.parse(approvedBody.evaluation_json) as Record<string, unknown>
    expect(evaluation).toHaveProperty('training')
    expect(evaluation).toHaveProperty('selection')
    expect(evaluation).toHaveProperty('conformalMetrics')
    expect(evaluation).toHaveProperty('holdout')
    const holdout = evaluation.holdout as { predictions: unknown[]; metrics: { rmse: number }; intervalCoverage: Record<string, unknown>; intervalCalibrationHash: string }
    expect(holdout.predictions.length).toBeGreaterThan(0)
    expect(holdout.metrics.rmse).toBeLessThan(1e-8)
    expect(holdout.intervalCoverage).toHaveProperty('0.5')
    expect(holdout.intervalCoverage).toHaveProperty('0.95')
    expect(holdout.intervalCalibrationHash).toBe((evaluation.conformal as { calibrationHash: string }).calibrationHash)
    expect(approvedBody.holdout_lock_hash).toMatch(/^[a-f0-9]{64}$/)
    const prediction = await backend.app.inject({
      method: 'POST',
      url: '/api/calibration/predict',
      headers: auth,
      payload: {
        workloadId: 'dot_product',
        target: 'x86_64-linux',
        modelVersion: 'inorder-1.0.0',
        profileId: 'same-mid',
        simulatorVersion: 'sim-1', toolchainHash: 'a'.repeat(64), corpusId: 'c'.repeat(64), roiDefinitionHash: 'b'.repeat(64), workloadSemanticHash: 'd'.repeat(64),
        parameters: { validCount: 25, invalidCount: 2, flaggedFraction: 0.04, sampleSd: 5 },
      },
    })
    expect(prediction.statusCode).toBe(200)
    expect(prediction.json()).toMatchObject({
      experimentKind: 'calibrated-prediction',
      proof: {
        signatureVerified: true,
        signatureVerifier: 'calibration-server-ed25519',
        signatureIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      applicability: { extrapolated: false },
      uncertainty: {
        method: 'validation-split-conformal-absolute-residual',
        confidenceLevel: 0.95,
        calibrationSampleCount: expect.any(Number),
        calibrationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        interval50: { lower: expect.any(Number), upper: expect.any(Number) },
        interval95: { lower: expect.any(Number), upper: expect.any(Number) },
        components: {
          radius50: expect.any(Number),
          radius95: expect.any(Number),
        },
      },
    })
    const extrapolation = await backend.app.inject({
      method: 'POST',
      url: '/api/calibration/predict',
      headers: auth,
      payload: {
        workloadId: 'dot_product',
        target: 'x86_64-linux',
        modelVersion: 'inorder-1.0.0',
        profileId: 'same-mid',
        simulatorVersion: 'sim-1', toolchainHash: 'a'.repeat(64), corpusId: 'c'.repeat(64), roiDefinitionHash: 'b'.repeat(64), workloadSemanticHash: 'd'.repeat(64),
        parameters: { validCount: 99999, invalidCount: 2, flaggedFraction: 0.04, sampleSd: 5 },
      },
    })
    expect(extrapolation.statusCode).toBe(422)
    for (const parameters of [
      { validCount: 25, invalidCount: 2, flaggedFraction: 0.04 },
      { validCount: 25, invalidCount: 2, flaggedFraction: 0.04, sampleSd: 5, extra: 1 },
    ]) {
      const exactSet = await backend.app.inject({
        method: 'POST', url: '/api/calibration/predict', headers: auth,
        payload: { workloadId: 'dot_product', target: 'x86_64-linux', modelVersion: 'inorder-1.0.0', profileId: 'same-mid', simulatorVersion: 'sim-1', toolchainHash: 'a'.repeat(64), corpusId: 'c'.repeat(64), roiDefinitionHash: 'b'.repeat(64), workloadSemanticHash: 'd'.repeat(64), parameters },
      })
      expect(exactSet.statusCode).toBe(422)
      expect(exactSet.json()).toMatchObject({ error: 'applicability_rejected' })
    }
    const nonfinite = await backend.app.inject({
      method: 'POST', url: '/api/calibration/predict', headers: auth,
      payload: { workloadId: 'dot_product', target: 'x86_64-linux', modelVersion: 'inorder-1.0.0', profileId: 'same-mid', simulatorVersion: 'sim-1', toolchainHash: 'a'.repeat(64), corpusId: 'c'.repeat(64), roiDefinitionHash: 'b'.repeat(64), workloadSemanticHash: 'd'.repeat(64), parameters: { validCount: null, invalidCount: 2, flaggedFraction: 0.04, sampleSd: 5 } },
    })
    expect(nonfinite.statusCode).toBe(400)
    const replay = await backend.app.inject({ method: 'POST', url: `/api/calibration/calibrations/${calibration.id}/evaluate-holdout`, headers: auth, payload: { version: 4 } })
    expect(replay.statusCode).toBe(409)
    const strictCreated = await backend.app.inject({ method: 'POST', url: '/api/calibration/calibrations', headers: auth, payload: {
      datasetId: dataset.id, modelKind: 'ridge',
      acceptanceThresholds: { maxRmse: 0, maxMae: 0, minR2: 1, minCoverage50: 1, minCoverage95: 1 },
    } })
    const strict = strictCreated.json() as { id: string }
    const strictFit = await backend.app.inject({ method: 'POST', url: `/api/calibration/calibrations/${strict.id}/fit`, headers: auth, payload: { version: 0, configs: [{ lambda: 1 }] } })
    expect(strictFit.statusCode).toBe(200)
    const strictEvaluation = await backend.app.inject({ method: 'POST', url: `/api/calibration/calibrations/${strict.id}/evaluate-holdout`, headers: auth, payload: { version: 1 } })
    expect(strictEvaluation.json()).toMatchObject({ state: 'pending_review', version: 3 })
    const strictEvaluationJson = (strictEvaluation.json() as { evaluation_json: string }).evaluation_json
    const rejected = await backend.app.inject({ method: 'POST', url: `/api/calibration/calibrations/${strict.id}/approve`, headers: auth, payload: { version: 3 } })
    expect(rejected.json()).toMatchObject({ state: 'rejected', approved_at: null })
    expect((rejected.json() as { evaluation_json: string }).evaluation_json).toBe(strictEvaluationJson)
  })
})
