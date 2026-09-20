import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { existsSync } from 'node:fs'
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  CalibratedPredictionResultSchema,
  buildComparisonGroupKey,
  canonicalJson,
  decodeCanonicalBase64,
  type JsonValue,
} from '@isa-sim/contracts'
import { extractTarZstdFiles, sha256 } from '@isa-sim/calibration'
import type { CalibrationStore } from './calibration-store.js'

export async function registerCalibrationRoutes(app: FastifyInstance, store: CalibrationStore, maxBundleBytes: number): Promise<void> {
  app.post('/api/calibration/imports/inspect', async (request, reply) => guarded(reply, () => {
    const body = object(request.body)
    const encoded = text(body.bundleBase64)
    if (Object.keys(body).some((key) => !['bundleBase64', 'format', 'signedIndex'].includes(key))) throw new Error('import request contains forbidden client assertions')
    const sourceBytes = Buffer.from(decodeCanonicalBase64(encoded))
    if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > maxBundleBytes) throw new Error('bundle input size out of bounds')
    let bytes: Uint8Array = sourceBytes
    let signedIndex = body.signedIndex === undefined ? undefined : object(body.signedIndex)
    let artifactFiles: ReadonlyMap<string, Uint8Array> | undefined
    if (body.format === 'tar.zst' || (sourceBytes[0] === 0x28 && sourceBytes[1] === 0xb5 && sourceBytes[2] === 0x2f && sourceBytes[3] === 0xfd)) {
      const extracted = extractTarZstdFiles(sourceBytes)
      if (extracted.reasons.some((item) => item.severity === 'error')) throw new Error(extracted.reasons.map((item) => `${item.code}: ${item.detail}`).join('; '))
      const bundle = extracted.files.get('measurement.jsonl'), envelope = extracted.files.get('signed-index.json')
      if (!bundle || !envelope) throw new Error('tar.zst requires measurement.jsonl and signed-index.json')
      bytes = bundle
      signedIndex = object(JSON.parse(Buffer.from(envelope).toString('utf8')) as unknown)
      const payload = object(signedIndex.payload), artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : []
      const signedNames = new Set(artifacts.map((artifact) => { const descriptor = object(artifact); return text(descriptor.name ?? descriptor.filename ?? descriptor.sha256) }))
      const archivedNames = [...extracted.files.keys()].filter((name) => !['measurement.jsonl', 'signed-index.json'].includes(name))
      if (archivedNames.some((name) => !signedNames.has(name)) || [...signedNames].some((name) => !extracted.files.has(name))) throw new Error('tar.zst contains missing or unsigned artifact files')
      artifactFiles = extracted.files
    } else if (body.format !== undefined && body.format !== 'jsonl') throw new Error('format must be jsonl or tar.zst')
    return store.inspect(bytes, {
      ...(signedIndex === undefined ? {} : { signedIndex: signedIndex as never }),
      ...(artifactFiles === undefined ? {} : { artifactFiles }),
    }, sourceBytes)
  }, 201))
  app.get('/api/calibration/imports', async () => ({ imports: store.listQuarantine() }))
  app.get('/api/calibration/imports/:id', async (request, reply) => store.getQuarantine(param(request, 'id')) ?? reply.code(404).send({ error: 'quarantine_not_found' }))
  app.get('/api/calibration/imports/:id/report', async (request, reply) => {
    const id = param(request, 'id')
    if (!store.getQuarantine(id)) return reply.code(404).send({ error: 'quarantine_not_found' })
    return { reports: store.reports(id) }
  })
  app.post('/api/calibration/imports/:id/commit', async (request, reply) => guarded(reply, () => store.commit(param(request, 'id'), expectedVersion(request))))
  app.post('/api/calibration/imports/:id/delete', async (request, reply) => guarded(reply, () => store.delete(param(request, 'id'), expectedVersion(request))))

  app.get('/api/empirical/runs', async (request) => ({ runs: store.runs(limit(request)) }))
  app.get('/api/empirical/runs/:id', async (request, reply) => store.run(param(request, 'id')) ?? reply.code(404).send({ error: 'run_not_found' }))
  app.post('/api/empirical/runs/summarize', async (request, reply) => guarded(reply, () => {
    const body = object(request.body), ids = stringArray(body.runIds)
    if (Object.keys(body).some((key) => !['runIds', 'policyHash', 'codeHash', 'confidenceMethod', 'confidenceLevel', 'clusterUnit', 'seed'].includes(key))) throw new Error('summary request contains client-supplied metric or provenance')
    return { summaries: store.summarize(ids, {
      policyHash: hash(body.policyHash), codeHash: hash(body.codeHash), confidenceMethod: text(body.confidenceMethod),
      confidenceLevel: finite(body.confidenceLevel), clusterUnit: body.clusterUnit === null ? null : text(body.clusterUnit), seed: text(body.seed),
    }) }
  }, 201))

  app.post('/api/calibration/datasets', async (request, reply) => guarded(reply, () => {
    const body = object(request.body)
    if (Object.keys(body).some((key) => !['summaryIds', 'featureExtractor', 'featureVersion'].includes(key))) throw new Error('dataset request contains client-supplied materialization')
    return store.createDataset({
      summaryIds: stringArray(body.summaryIds),
      featureExtractor: text(body.featureExtractor), featureVersion: text(body.featureVersion),
    })
  }, 201))
  app.get('/api/calibration/datasets/:id', async (request, reply) => store.dataset(param(request, 'id')) ?? reply.code(404).send({ error: 'dataset_not_found' }))
  app.post('/api/calibration/datasets/:id/freeze', async (request, reply) => guarded(reply, () => {
    const body = object(request.body)
    if (Object.keys(body).some((key) => !['version', 'seed', 'selectionFraction', 'conformalFraction', 'holdoutFraction', 'holdoutMachine', 'holdoutSession'].includes(key))) throw new Error('freeze request contains client-supplied split membership or provenance')
    return store.freezeDataset(param(request, 'id'), expectedVersion(request), {
      seed: text(body.seed),
      ...(body.selectionFraction === undefined ? {} : { selectionFraction: finite(body.selectionFraction) }),
      ...(body.conformalFraction === undefined ? {} : { conformalFraction: finite(body.conformalFraction) }),
      ...(body.holdoutFraction === undefined ? {} : { holdoutFraction: finite(body.holdoutFraction) }),
      ...(body.holdoutMachine === undefined ? {} : { holdoutMachine: text(body.holdoutMachine) }),
      ...(body.holdoutSession === undefined ? {} : { holdoutSession: text(body.holdoutSession) }),
    })
  }))

  app.post('/api/calibration/calibrations', async (request, reply) => guarded(reply, () => {
    const body = object(request.body)
    if (Object.keys(body).some((key) => !['datasetId', 'modelKind', 'acceptanceThresholds'].includes(key))) throw new Error('calibration request contains client-supplied semantic claims')
    const modelKind = text(body.modelKind)
    if (!['ridge', 'elastic-net', 'nonnegative-energy'].includes(modelKind)) throw new Error('unsupported calibration model kind')
    return store.createCalibration(text(body.datasetId), { modelKind: modelKind as 'ridge' | 'elastic-net' | 'nonnegative-energy', acceptanceThresholds: numericRecord(body.acceptanceThresholds) })
  }, 201))
  app.get('/api/calibration/calibrations/:id', async (request, reply) => store.calibration(param(request, 'id')) ?? reply.code(404).send({ error: 'calibration_not_found' }))
  app.post('/api/calibration/calibrations/:id/fit', async (request, reply) => {
    try {
      const id = param(request, 'id'), body = object(request.body), calibration = store.calibration(id)
      if (!calibration) return reply.code(404).send({ error: 'calibration_not_found' })
      if (Object.keys(body).some((key) => !['version', 'configs'].includes(key))) throw new Error('fit accepts only version and configurations')
      const specification = object(JSON.parse(String(calibration.specification_json)) as unknown)
      const configs = array(body.configs).map((value) => {
        const config = object(value)
        if (config.kind !== undefined && config.kind !== specification.modelKind) throw new Error('fit configuration cannot change the server-derived model kind')
        return { ...config, kind: specification.modelKind }
      })
      const stored = store.fitPayload(id)
      const payload = withPayloadHash({ mode: 'fit', ...stored, configs })
      const result = await runFitWorker(payload, request, 30_000)
      const selected = object(result.selected)
      return reply.send(store.recordFit(id, expectedVersion(request), json(selected.fit), json({ datasetHash: result.datasetHash, splitHash: result.splitHash, training: selected.training, selection: selected.selection, conformalMetrics: selected.conformalMetrics, conformal: selected.conformal, candidateCount: result.candidateCount })))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return reply.code(/state\/version|conflict/.test(detail) ? 409 : 400).send({ error: 'fit_rejected', detail })
    }
  })
  app.post('/api/calibration/calibrations/:id/evaluate-holdout', async (request, reply) => {
    let reservation: { id: string; version: number } | null = null
    try {
      const id = param(request, 'id'), body = object(request.body)
      if (Object.keys(body).some((key) => key !== 'version')) throw new Error('approval accepts only expected version')
      const { reservationVersion, ...stored } = store.beginHoldout(id, expectedVersion(request))
      reservation = { id, version: reservationVersion }
      const evaluation = await runFitWorker(withPayloadHash({ mode: 'evaluate', ...stored }), request, 30_000)
      const approved = store.recordHoldout(id, reservationVersion, evaluation as JsonValue)
      reservation = null
      return reply.send(approved)
    } catch (error) {
      if (reservation) {
        try { store.abortHoldout(reservation.id, reservation.version) } catch {}
      }
      const detail = error instanceof Error ? error.message : String(error)
      return reply.code(/already|state\/version|conflict/.test(detail) ? 409 : 400).send({ error: 'holdout_evaluation_rejected', detail })
    }
  })
  app.post('/api/calibration/calibrations/:id/approve', async (request, reply) => guarded(reply, () => {
    const body = object(request.body)
    if (Object.keys(body).some((key) => key !== 'version')) throw new Error('approval accepts only expected version')
    return store.approve(param(request, 'id'), expectedVersion(request))
  }))
  app.post('/api/calibration/calibrations/:id/retire', async (request, reply) => guarded(reply, () => {
    return store.retire(param(request, 'id'), expectedVersion(request))
  }))
  app.get('/api/calibration/status', async () => ({ counts: store.counts(), production: store.production }))
  app.get('/api/calibration/catalog', async () => ({
    imports: store.listQuarantine(),
    runs: store.runs(1000),
    summaries: store.sqlite.prepare('SELECT * FROM empirical_summaries ORDER BY created_at DESC').all(),
    datasets: store.sqlite.prepare('SELECT * FROM calibration_datasets ORDER BY created_at DESC').all(),
    splits: store.sqlite.prepare('SELECT * FROM calibration_splits ORDER BY created_at DESC').all(),
    calibrations: store.sqlite.prepare('SELECT * FROM calibration_fits ORDER BY created_at DESC').all(),
  }))
  app.post('/api/calibration/predict', async (request, reply) => {
    try {
      const body = object(request.body)
      const allowed = ['workloadId', 'target', 'modelVersion', 'profileId', 'simulatorVersion', 'toolchainHash', 'corpusId', 'roiDefinitionHash', 'workloadSemanticHash', 'parameters']
      if (Object.keys(body).some((key) => !allowed.includes(key))) throw new Error('prediction request contains unknown fields')
      const query = {
        workloadId: text(body.workloadId),
        target: text(body.target),
        modelVersion: text(body.modelVersion),
        profileId: text(body.profileId),
        simulatorVersion: text(body.simulatorVersion),
        toolchainHash: hash(body.toolchainHash),
        corpusId: text(body.corpusId),
        roiDefinitionHash: hash(body.roiDefinitionHash),
        workloadSemanticHash: hash(body.workloadSemanticHash),
        parameters: numericRecord(body.parameters),
      }
      const candidates = store.sqlite.prepare("SELECT * FROM calibration_fits WHERE state='approved' ORDER BY approved_at DESC").all() as Record<string, unknown>[]
      let mismatch = 'no approved calibration exists'
      for (const candidate of candidates) {
        const specification = object(JSON.parse(String(candidate.specification_json)) as unknown)
        const domain = object(specification.domain)
        if (!matches(domain.workloadIds, query.workloadId) || !matches(domain.targets, query.target) ||
            !matches(domain.modelVersions, query.modelVersion) || !matches(domain.profileIds, query.profileId) ||
            !matches(domain.simulatorVersions, query.simulatorVersion) || !matches(domain.toolchainHashes, query.toolchainHash) ||
            !matches(domain.corpusIds, query.corpusId) || !matches(domain.roiDefinitionHashes, query.roiDefinitionHash) ||
            !matches(domain.workloadSemanticHashes, query.workloadSemanticHash)) {
          mismatch = 'approved calibrations do not match exact workload/target/model/profile/toolchain/corpus/ROI domain'
          continue
        }
        const dataset = store.dataset(String(candidate.dataset_id))
        if (!dataset || dataset.state !== 'frozen') throw new Error('approved calibration dataset is not frozen')
        const definition = object(JSON.parse(String(dataset.definition_json)) as unknown)
        if (definition.featureExtractor !== 'summary-basic' || definition.featureVersion !== '1') {
          throw new Error('approved calibration uses an unsupported frozen feature extractor/version')
        }
        const ranges = object(specification.parameterRanges)
        const declaredParameters = Object.keys(ranges).sort()
        const suppliedParameters = Object.keys(query.parameters).sort()
        if (declaredParameters.join('\0') !== suppliedParameters.join('\0')) {
          return reply.code(422).send({ error: 'applicability_rejected', detail: 'parameter set must exactly equal the approved applicability parameter set' })
        }
        for (const [name, rangeValue] of Object.entries(ranges)) {
          const range = array(rangeValue).map(finite)
          if (range.length !== 2 || range[0]! > range[1]!) throw new Error(`invalid calibration range for ${name}`)
          const actual = query.parameters[name]
          if (actual === undefined || actual < range[0]! || actual > range[1]!) {
            return reply.code(422).send({ error: 'extrapolation_rejected', detail: `${name} is outside approved [${range[0]}, ${range[1]}]` })
          }
        }
        const fit = object(JSON.parse(String(candidate.fit_json)) as unknown)
        const coefficients = numericRecord(fit.coefficients)
        const mapping = object(specification.featureMapping)
        if (Object.keys(coefficients).sort().join('\0') !== Object.keys(mapping).sort().join('\0')) throw new Error('approved feature mapping differs from fitted coefficient set')
        const features: Record<string, number> = {}
        for (const name of Object.keys(coefficients)) {
          const source = mapping[name]
          if (typeof source === 'string') {
            if (query.parameters[source] === undefined) throw new Error(`effective parameter ${source} is missing`)
            features[name] = query.parameters[source]!
          } else {
            const constant = object(source).constant
            features[name] = finite(constant)
          }
        }
        const point = finite(fit.intercept) + Object.entries(coefficients)
          .reduce((sum, [name, coefficient]) => sum + coefficient * features[name]!, 0)
        if (point < 0) throw new Error('calibrated point prediction is negative')
        const evaluation = object(JSON.parse(String(candidate.evaluation_json)) as unknown)
        const conformal = object(evaluation.conformal)
        if (conformal.method !== 'validation-split-conformal-absolute-residual') throw new Error('approved calibration lacks validation-only split-conformal intervals')
        const calibrationSampleCount = finite(conformal.sampleCount)
        if (!Number.isSafeInteger(calibrationSampleCount) || calibrationSampleCount < 10) throw new Error('split-conformal calibration sample count is insufficient')
        const conformalCalibrationHash = hash(conformal.calibrationHash)
        const conformalIntervals = object(conformal.intervals)
        const intervalDefinition = (level: '0.5' | '0.95') => {
          const definition = object(conformalIntervals[level])
          if (finite(definition.level) !== Number(level)) throw new Error(`split-conformal ${level} interval level mismatch`)
          const radius = finite(definition.radius), correctedRank = finite(definition.correctedRank)
          if (radius < 0 || !Number.isSafeInteger(correctedRank) || correctedRank < 1 || correctedRank > calibrationSampleCount) throw new Error(`invalid split-conformal ${level} interval`)
          return { lower: Math.max(0, point - radius), upper: point + radius, radius }
        }
        const interval50 = intervalDefinition('0.5'), interval95 = intervalDefinition('0.95')
        if (specification.metricDomain !== 'physical-energy-j' && specification.metricDomain !== 'physical-time-ns') throw new Error('approved calibration metric domain is invalid')
        const metricDomain: 'physical-energy-j' | 'physical-time-ns' = specification.metricDomain
        const unit = metricDomain === 'physical-energy-j' ? 'J' : 'ns'
        const fitHash = sha256(canonicalJson(fit as JsonValue))
        const evaluationHash = sha256(canonicalJson(evaluation as JsonValue))
        const calibrationHash = sha256(canonicalJson({
          id: String(candidate.id), datasetHash: String(dataset.dataset_hash), fitHash, evaluationHash,
          holdoutLockHash: String(candidate.holdout_lock_hash),
        } as JsonValue))
        const inputIdentity = sha256(canonicalJson(query as unknown as JsonValue))
        const comparison = {
          experimentKind: 'calibrated-prediction' as const,
          modelVersion: query.modelVersion,
          workloadSemanticHash: query.workloadSemanticHash,
          artifactPipelineHash: fitHash,
          roiDefinitionHash: query.roiDefinitionHash,
          profileConfigFingerprint: sha256(canonicalJson({ target: query.target, profileId: query.profileId, simulatorVersion: query.simulatorVersion, toolchainHash: query.toolchainHash, corpusId: query.corpusId })),
          metricDomain,
          unit,
        }
        const result = CalibratedPredictionResultSchema.parse({
          schemaVersion: '1.0.0',
          modelVersion: query.modelVersion,
          adapterVersion: 'calibrated-predictor-1.0.0',
          experimentKind: 'calibrated-prediction',
          claimClass: 'calibrated-prediction',
          evidenceClass: 'calibration-fit',
          inputIdentity,
          artifactIdentities: [String(dataset.dataset_hash), fitHash, evaluationHash],
          comparisonGroupKey: await buildComparisonGroupKey(comparison),
          comparison,
          createdAt: new Date().toISOString(),
          proof: verifiedCalibrationProof(candidate, store),
          calibrationId: calibrationHash,
          datasetId: String(dataset.dataset_hash),
          modelHash: sha256(query.modelVersion),
          applicability: {
            workloadId: query.workloadId,
            target: query.target,
            modelVersion: query.modelVersion,
            profileId: query.profileId,
            simulatorVersion: query.simulatorVersion,
            toolchainHash: query.toolchainHash,
            corpusId: query.corpusId,
            roiDefinitionHash: query.roiDefinitionHash,
            workloadSemanticHash: query.workloadSemanticHash,
            extrapolated: false,
          },
          metrics: [{ name: 'point_prediction', domain: metricDomain, unit, value: point }],
          uncertainty: {
            method: 'validation-split-conformal-absolute-residual',
            confidenceLevel: 0.95,
            calibrationSampleCount,
            calibrationHash: conformalCalibrationHash,
            lower: interval95.lower,
            upper: interval95.upper,
            unit,
            interval50: { lower: interval50.lower, upper: interval50.upper },
            interval95: { lower: interval95.lower, upper: interval95.upper },
            components: { radius50: interval50.radius, radius95: interval95.radius },
          },
        })
        return reply.send(result)
      }
      return reply.code(404).send({ error: 'no_applicable_calibration', detail: mismatch })
    } catch (error) {
      return reply.code(400).send({ error: 'prediction_rejected', detail: error instanceof Error ? error.message : String(error) })
    }
  })
}

function guarded(reply: FastifyReply, operation: () => unknown, successCode = 200): unknown {
  try { return reply.code(successCode).send(operation()) }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const conflict = /state\/version|conflict|already|replay/.test(detail)
    return reply.code(conflict ? 409 : 400).send({ error: conflict ? 'state_conflict' : 'invalid_request', detail })
  }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required'); return value as Record<string, unknown> }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('array required'); return value }
function text(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('nonempty string required'); return value }
function stringArray(value: unknown): string[] { return array(value).map(text) }
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('finite number required'); return value }
function numericRecord(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(object(value)).map(([key, item]) => [key, finite(item)]))
}
function matches(value: unknown, candidate: string): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string') && value.includes(candidate)
}

function verifiedCalibrationProof(
  calibration: Record<string, unknown>,
  store: CalibrationStore,
): {
  signatureVerified: true
  signatureVerifier: string
  signatureIdentityHash: string
} | undefined {
  try {
    const signed = object(JSON.parse(String(calibration.signature_json)) as unknown)
    const protectedHeader = {
      algorithm: text(signed.algorithm),
      keyId: text(signed.keyId),
      signedAt: text(signed.signedAt),
    }
    if (protectedHeader.algorithm !== 'Ed25519' || protectedHeader.keyId !== store.reportKeyId) return undefined
    const valid = verifySignature(
      null,
      Buffer.from(canonicalJson({ protected: protectedHeader, payload: signed.payload as JsonValue })),
      createPublicKey(store.reportSigner),
      Buffer.from(text(signed.signature), 'base64'),
    )
    if (!valid) return undefined
    return {
      signatureVerified: true,
      signatureVerifier: 'calibration-server-ed25519',
      signatureIdentityHash: sha256(createPublicKey(store.reportSigner).export({ format: 'der', type: 'spki' })),
    }
  } catch {
    return undefined
  }
}
function hash(value: unknown): string { const result = text(value); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('lowercase SHA-256 required'); return result }
function json(value: unknown): JsonValue { JSON.stringify(value); return value as JsonValue }
function param(request: FastifyRequest, name: string): string { return text((request.params as Record<string, unknown>)[name]) }
function expectedVersion(request: FastifyRequest): number {
  const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
  const header = request.headers['if-match']
  const raw = header === undefined ? body.version : String(header).replace(/^W\//, '').replaceAll('"', '')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('nonnegative expected version required')
  return value
}
function limit(request: FastifyRequest): number {
  const value = Number((request.query as { limit?: string }).limit ?? 100)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid limit')
  return Math.min(1000, value)
}

function runFitWorker(data: Record<string, unknown>, request: FastifyRequest, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const adjacent = new URL('./calibration-worker.js', import.meta.url)
    const workerUrl = existsSync(fileURLToPath(adjacent)) ? adjacent : new URL('../dist/calibration-worker.js', import.meta.url)
    const worker = new Worker(workerUrl, { workerData: data })
    let settled = false
    const finish = (operation: () => void) => { if (settled) return; settled = true; clearTimeout(timer); request.raw.off('aborted', abort); operation() }
    const abort = () => finish(() => { void worker.terminate(); reject(new Error('fit cancelled')) })
    const timer = setTimeout(() => finish(() => { void worker.terminate(); reject(new Error('fit time limit exceeded')) }), timeoutMs)
    timer.unref()
    request.raw.once('aborted', abort)
    worker.once('message', (message: unknown) => finish(() => {
      const response = object(message)
      if (response.ok !== true) reject(new Error(String(response.error ?? 'fit worker failed')))
      else resolve(object(response.result))
    }))
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) => { if (code !== 0) finish(() => reject(new Error(`fit worker exited ${code}`))) })
  })
}
function withPayloadHash(data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, payloadHash: sha256(canonicalJson(data as JsonValue)) }
}
