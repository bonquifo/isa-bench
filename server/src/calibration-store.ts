import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  createFrozenSplit,
  createImportReport,
  inspectJsonlBundle,
  sha256,
  signImportReport,
  summarizeSamples,
  type DatasetMember,
  type FitRow,
  type InspectionContext,
  type ProtocolSample,
} from '@isa-sim/calibration'
import { canonicalJson, type JsonValue } from '@isa-sim/contracts'
import type { NativeCorpusStore } from './corpus.js'
import type { EmpiricalStore, Row } from './empirical.js'
import { verifyRawBundle } from './empirical-routes.js'

export type QuarantineState = 'awaiting_review' | 'rejected' | 'committed' | 'deleted'
interface MaterializedRow extends FitRow { sessionId: string; machineId: string; summaryHash: string }

export class CalibrationStore {
  readonly casDir: string
  readonly reportSigner: KeyObject
  readonly reportKeyId: string
  constructor(readonly sqlite: DatabaseSync, dataDir: string, private readonly empirical: EmpiricalStore, private readonly corpus: NativeCorpusStore, readonly production = true) {
    this.casDir = join(dataDir, 'calibration-quarantine')
    mkdirSync(this.casDir, { recursive: true })
    this.reportSigner = loadSigner(join(dataDir, 'calibration-report-ed25519.pk8'))
    this.reportKeyId = `calibration-report:${sha256(createPublicKey(this.reportSigner).export({ format: 'der', type: 'spki' }))}`
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS calibration_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT OR IGNORE INTO calibration_migrations VALUES(1,datetime('now'));
      INSERT OR IGNORE INTO calibration_migrations VALUES(2,datetime('now'));
      CREATE TABLE IF NOT EXISTS calibration_quarantine(
        id TEXT PRIMARY KEY,bundle_hash TEXT UNIQUE NOT NULL,source_hash TEXT NOT NULL,content_path TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,
        inspection_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,committed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS calibration_import_reports(
        id TEXT PRIMARY KEY,quarantine_id TEXT NOT NULL REFERENCES calibration_quarantine(id),previous_hash TEXT NOT NULL,report_hash TEXT UNIQUE NOT NULL,
        report_json TEXT NOT NULL,signature_json TEXT,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS empirical_runs(
        id TEXT PRIMARY KEY,bundle_hash TEXT NOT NULL,runner_id TEXT NOT NULL,job_id TEXT NOT NULL,sample_json TEXT NOT NULL,protocol_valid INTEGER NOT NULL,
        protocol_reasons_json TEXT NOT NULL,statistical_flag INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(bundle_hash,id)
      );
      CREATE TABLE IF NOT EXISTS empirical_summaries(
        id TEXT PRIMARY KEY,dataset_hash TEXT NOT NULL,summary_json TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calibration_datasets(
        id TEXT PRIMARY KEY,state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,definition_json TEXT NOT NULL,resolved_ids_json TEXT NOT NULL,
        dataset_hash TEXT UNIQUE NOT NULL,signature_json TEXT,created_at TEXT NOT NULL,frozen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS calibration_splits(
        id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL REFERENCES calibration_datasets(id),split_hash TEXT UNIQUE NOT NULL,split_json TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calibration_dataset_rows(
        dataset_id TEXT NOT NULL REFERENCES calibration_datasets(id),row_id TEXT NOT NULL,row_hash TEXT NOT NULL,row_json TEXT NOT NULL,
        PRIMARY KEY(dataset_id,row_id),UNIQUE(dataset_id,row_hash)
      );
      CREATE TABLE IF NOT EXISTS calibration_fits(
        id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL REFERENCES calibration_datasets(id),state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,
        specification_json TEXT NOT NULL,fit_json TEXT,evaluation_json TEXT,holdout_lock_hash TEXT,signature_json TEXT,approved_at TEXT,superseded_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calibration_content_refs(hash TEXT PRIMARY KEY,path TEXT NOT NULL,byte_size INTEGER NOT NULL,mime_type TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calibration_quarantine_state ON calibration_quarantine(state,created_at);
      CREATE INDEX IF NOT EXISTS empirical_runs_bundle ON empirical_runs(bundle_hash,id);
      CREATE INDEX IF NOT EXISTS calibration_fits_state ON calibration_fits(state,created_at);
    `)
    const quarantineColumns = (sqlite.prepare("PRAGMA table_info('calibration_quarantine')").all() as Row[]).map((row) => String(row.name))
    if (!quarantineColumns.includes('source_hash')) sqlite.exec("ALTER TABLE calibration_quarantine ADD COLUMN source_hash TEXT NOT NULL DEFAULT ''")
  }

  inspect(bytes: Uint8Array, context: Pick<InspectionContext, 'signedIndex' | 'artifactFiles'>, sourceBytes: Uint8Array = bytes): Row {
    const bundleHash = sha256(bytes), sourceHash = sha256(sourceBytes)
    const seen = this.sqlite.prepare('SELECT bundle_hash FROM calibration_quarantine WHERE bundle_hash=?').get(bundleHash)
    const header = parseBundleHeader(bytes)
    const job = header ? this.sqlite.prepare('SELECT * FROM empirical_jobs WHERE id=?').get(String(header.jobId)) as Row | undefined : undefined
    const runnerId = job ? String(job.runner_id ?? '') : ''
    const runner = runnerId ? this.empirical.runner(runnerId) : null
    const spec = job ? parseObjectJson(String(job.spec_json)) : null
    const measuredAt = String(header?.createdAt ?? header?.measuredAt ?? '')
    const manifest = runner ? this.manifestAt(runnerId, measuredAt) : null
    const corpusArtifact = spec && isObject(spec.binary) ? this.corpus.artifact(String(spec.binary.corpusId ?? '')) : null
    const historicalCredential = runner ? this.credentialAt(runnerId, measuredAt) : null
    let inspection = inspectJsonlBundle(bytes, {
      ...context,
      production: this.production,
      seenBundleHashes: seen ? new Set([bundleHash]) : new Set(),
      expected: {
        runnerId, jobId: String(job?.id ?? ''), leaseId: String(job?.lease_id ?? ''), leaseNonce: String(job?.lease_nonce ?? ''),
        binarySha256: String(isObject(spec?.binary) ? spec.binary.sha256 ?? '' : ''),
        corpusArtifactId: String(isObject(spec?.binary) ? spec.binary.corpusId ?? '' : ''),
        roiDefinitionHash: String(corpusArtifact?.record.roiHash ?? ''),
        buildId: String(isObject(corpusArtifact?.record.image) ? corpusArtifact.record.image.build ?? '' : ''),
        target: (spec?.target ?? null) as JsonValue,
        seed: String(spec?.seed ?? ''), repetitions: Number(spec?.repetitions), warmups: Number(spec?.warmups),
        adapters: Array.isArray(spec?.adapters) ? spec.adapters.map(String) : [],
        controls: isObject(spec?.controls) ? spec.controls as Record<string, JsonValue> : {},
      },
      ...(runner ? {
        runner: {
          id: String(runner.id), keyId: String(runner.key_id), publicKey: String(runner.public_key),
          stateAtMeasurement: String(historicalCredential?.state ?? 'missing'), stateAtImport: String(runner.state),
          credentialIssuedAt: String(historicalCredential?.issued_at ?? ''),
          credentialExpiresAt: String(historicalCredential?.expires_at ?? ''),
          ...(runner.state === 'revoked' ? { revokedAt: String(runner.updated_at) } : {}),
        },
      } : {}),
    })
    const authorityReasons: { code: string; severity: 'error'; detail: string }[] = []
    if (!job || !runner || !spec) authorityReasons.push({ code: 'authoritative-job', severity: 'error', detail: 'authoritative job/runner records are missing' })
    if (!historicalCredential) authorityReasons.push({ code: 'authoritative-credential', severity: 'error', detail: 'no approved runner credential covered measurement time' })
    if (job && (job.runner_id !== runner?.id || job.artifact_id !== bundleHash || !['finished', 'failed'].includes(String(job.state)))) authorityReasons.push({ code: 'authoritative-job', severity: 'error', detail: 'bundle is not the exact artifact bound to the authoritative completed job/lease/runner' })
    if (job && !this.validJobEventChain(job)) authorityReasons.push({ code: 'authoritative-sequence', severity: 'error', detail: 'job event sequence/nonce/lease chain is incomplete or inconsistent' })
    const artifact = this.sqlite.prepare('SELECT * FROM empirical_artifacts WHERE hash=?').get(bundleHash) as Row | undefined
    if (!artifact || artifact.runner_id !== runnerId || artifact.job_id !== job?.id || Number(artifact.size) !== bytes.byteLength ||
        !existsSync(String(artifact?.path ?? '')) || sha256(readFileSync(String(artifact?.path ?? ''))) !== bundleHash) authorityReasons.push({ code: 'authoritative-artifact', severity: 'error', detail: 'canonical inner bundle is not an intact authoritative empirical artifact' })
    if (!manifest) authorityReasons.push({ code: 'authoritative-capability', severity: 'error', detail: 'no authoritative runner capability covered measurement time' })
    const authoritativeBinary = isObject(spec?.binary) ? spec.binary : null
    if (!corpusArtifact || !authoritativeBinary || corpusArtifact.record.binarySha256 !== authoritativeBinary.sha256 ||
        !corpusArtifact.files.some((file) => file.name === 'benchmark.bin' && file.sha256 === authoritativeBinary.sha256 && file.bytes === Number(authoritativeBinary.size))) authorityReasons.push({ code: 'authoritative-corpus', severity: 'error', detail: 'job binary/build/corpus/ROI mapping is not authoritative and exact' })
    if (artifact && context.signedIndex && runner && spec && manifest) {
      try {
        const verified = verifyRawBundle(Buffer.from(bytes), context.signedIndex as never, runnerId, String(job!.id), String(runner.public_key), String(runner.key_id), spec as never, manifest)
        if (canonicalJson(verified as JsonValue) !== String(artifact.index_json)) authorityReasons.push({ code: 'authoritative-index', severity: 'error', detail: 'signed index differs from authoritative artifact index' })
      } catch (error) { authorityReasons.push({ code: 'authoritative-protocol', severity: 'error', detail: error instanceof Error ? error.message : String(error) }) }
    }
    if (authorityReasons.length) inspection = { ...inspection, accepted: false, reasons: [...inspection.reasons, ...authorityReasons] }
    if (seen) throw new Error('bundle replay')
    const id = randomUUID(), now = new Date().toISOString(), state: QuarantineState = inspection.accepted ? 'awaiting_review' : 'rejected'
    const path = this.writeCas(sourceHash, sourceBytes)
    this.transaction(() => {
      this.sqlite.prepare('INSERT OR IGNORE INTO calibration_content_refs VALUES(?,?,?,?,?)').run(sourceHash, path, sourceBytes.byteLength, sourceBytes === bytes ? 'application/x-ndjson' : 'application/zstd', now)
      this.sqlite.prepare('INSERT INTO calibration_quarantine(id,bundle_hash,source_hash,content_path,state,version,inspection_json,created_at,updated_at,committed_at) VALUES(?,?,?,?,?,0,?,?,?,NULL)').run(id, bundleHash, sourceHash, path, state, canonicalJson(inspection as unknown as JsonValue), now, now)
      this.appendReport(id, bundleHash, inspection.accepted ? 'accepted-for-review' : 'rejected', inspection.reasons)
      this.empirical.audit('admin:session', 'calibration.import.inspect', 'success', 'quarantine', id, { bundleHash, state })
    })
    return this.getQuarantine(id)!
  }

  listQuarantine(): Row[] {
    return this.sqlite.prepare('SELECT id,bundle_hash,state,version,inspection_json,created_at,updated_at,committed_at FROM calibration_quarantine ORDER BY created_at DESC').all() as Row[]
  }
  getQuarantine(id: string): Row | null {
    return this.sqlite.prepare('SELECT id,bundle_hash,state,version,inspection_json,created_at,updated_at,committed_at FROM calibration_quarantine WHERE id=?').get(id) as Row | undefined ?? null
  }
  reports(id: string): Row[] {
    return this.sqlite.prepare('SELECT id,previous_hash,report_hash,report_json,signature_json,created_at FROM calibration_import_reports WHERE quarantine_id=? ORDER BY created_at,id').all(id) as Row[]
  }

  commit(id: string, expectedVersion: number): Row {
    return this.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM calibration_quarantine WHERE id=?').get(id) as Row | undefined
      if (!row || row.state !== 'awaiting_review' || Number(row.version) !== expectedVersion) throw new Error('quarantine state/version conflict')
      const inspection = JSON.parse(String(row.inspection_json)) as ReturnType<typeof inspectJsonlBundle>
      if (!inspection.accepted || inspection.reasons.some((reason) => reason.severity === 'error')) throw new Error('rejected inspection cannot commit')
      const runner = this.empirical.runner(String(inspection.header?.runnerId))
      if (!runner || runner.state !== 'approved' || Date.parse(String(runner.credential_expires_at)) <= Date.now()) throw new Error('runner no longer approved at commit')
      if (this.production && inspection.header?.testOnly !== false) throw new Error('production rejects synthetic/testOnly evidence')
      const insert = this.sqlite.prepare('INSERT INTO empirical_runs VALUES(?,?,?,?,?,?,?,?,?)')
      const now = new Date().toISOString()
      for (const record of inspection.records) {
        if (record.kind !== 'raw-run') continue
        const runId = String(record.sampleId ?? `${row.bundle_hash}:${record.ordinal}`)
        const reasons = Array.isArray(record.validityReasons) ? record.validityReasons.map(String) : ['missing-validity-reasons']
        const valid = record.valid === true && reasons.length === 0
        insert.run(runId, String(row.bundle_hash), String(inspection.header?.runnerId), String(inspection.header?.jobId), canonicalJson(record as JsonValue), valid ? 1 : 0, canonicalJson(reasons), 0, now)
      }
      if (this.sqlite.prepare("UPDATE calibration_quarantine SET state='committed',version=version+1,updated_at=?,committed_at=? WHERE id=? AND state='awaiting_review' AND version=?").run(now, now, id, expectedVersion).changes !== 1) throw new Error('quarantine commit conflict')
      this.appendReport(id, String(row.bundle_hash), 'committed', [])
      this.empirical.audit('admin:session', 'calibration.import.commit', 'success', 'quarantine', id, { bundleHash: String(row.bundle_hash) })
      return this.getQuarantine(id)!
    })
  }

  delete(id: string, expectedVersion: number): Row {
    return this.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM calibration_quarantine WHERE id=?').get(id) as Row | undefined
      if (!row || !['awaiting_review', 'rejected'].includes(String(row.state)) || Number(row.version) !== expectedVersion) throw new Error('quarantine state/version conflict')
      const now = new Date().toISOString()
      this.sqlite.prepare("UPDATE calibration_quarantine SET state='deleted',version=version+1,updated_at=? WHERE id=?").run(now, id)
      this.appendReport(id, String(row.bundle_hash), 'deleted', [])
      this.empirical.audit('admin:session', 'calibration.import.delete', 'success', 'quarantine', id, { bundleHash: String(row.bundle_hash) })
      return this.getQuarantine(id)!
    })
  }

  runs(limit = 100): Row[] {
    return this.sqlite.prepare('SELECT id,bundle_hash,runner_id,job_id,sample_json,protocol_valid,protocol_reasons_json,statistical_flag,created_at FROM empirical_runs ORDER BY created_at,id LIMIT ?').all(Math.max(1, Math.min(1000, limit))) as Row[]
  }
  run(id: string): Row | null { return this.sqlite.prepare('SELECT * FROM empirical_runs WHERE id=?').get(id) as Row | undefined ?? null }

  summarize(ids: readonly string[], metadata: { policyHash: string; codeHash: string; confidenceMethod: string; confidenceLevel: number; clusterUnit: string | null; seed: string }): Row[] {
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error('explicit unique run IDs required')
    if (!(metadata.confidenceLevel > 0 && metadata.confidenceLevel < 1)) throw new Error('confidence level must be in (0,1)')
    const sourceRows = ids.map((id) => this.run(id) ?? fail(`run not found: ${id}`))
    if (sourceRows.some((row) => Number(row.protocol_valid) !== 1 || (JSON.parse(String(row.protocol_reasons_json)) as unknown[]).length !== 0)) throw new Error('summary requires protocol-valid committed runs')
    const bundleHashes = [...new Set(sourceRows.map((row) => String(row.bundle_hash)))]
    if (bundleHashes.length !== 1) throw new Error('summary runs must come from one committed signed bundle')
    const quarantine = this.sqlite.prepare("SELECT inspection_json FROM calibration_quarantine WHERE bundle_hash=? AND state='committed'").get(bundleHashes[0]!) as Row | undefined
    if (!quarantine) throw new Error('summary source bundle is not committed')
    const inspection = parseObjectJson(String(quarantine.inspection_json)), records = Array.isArray(inspection?.records) ? inspection.records.map((value) => isObject(value) ? value : fail('invalid committed record')) : []
    const schedule = records.find((record) => record.kind === 'schedule')
    if (!schedule || !Array.isArray(schedule.entries)) throw new Error('committed signed schedule is missing')
    const signedEntries = new Map(schedule.entries.map((value) => {
      const entry = isObject(value) ? value : fail('invalid signed schedule entry')
      return [Number(entry.ordinal), entry]
    }))
    const selected = sourceRows.map((row) => ({ row, raw: parseObjectJson(String(row.sample_json)) ?? fail(`invalid committed run: ${row.id}`) }))
    if (selected.some(({ raw }) => !['measured', 'idle'].includes(String(raw.phase)) || !signedEntries.has(Number(raw.ordinal)))) throw new Error('pilot/warmup/unscheduled runs cannot be summarized')
    for (const { raw } of selected) {
      const entry = signedEntries.get(Number(raw.ordinal))!
      if (canonicalJson(pickRunSchedule(raw) as JsonValue) !== canonicalJson(pickRunSchedule(entry) as JsonValue)) throw new Error('run differs from committed signed schedule')
    }
    const pairs = new Map<string, typeof selected>()
    for (const item of selected) { const pair = String(item.raw.pairId); pairs.set(pair, [...(pairs.get(pair) ?? []), item]) }
    if ([...pairs.values()].some((pair) => pair.length !== 2 || pair.filter((item) => item.raw.phase === 'measured').length !== 1 || pair.filter((item) => item.raw.phase === 'idle').length !== 1)) {
      throw new Error('summary run IDs must contain complete unique measured/idle pairs')
    }
    const selectedIds = new Set(ids)
    if (selectedIds.size !== selected.length) throw new Error('duplicate summary run IDs')
    const rawDatasetHash = sha256(canonicalJson([...ids].sort()))
    const jobIds = [...new Set(sourceRows.map((row) => String(row.job_id)))]
    if (jobIds.length !== 1) throw new Error('summary must contain one authoritative job/session')
    const job = this.sqlite.prepare('SELECT spec_json,runner_id FROM empirical_jobs WHERE id=?').get(jobIds[0]!) as Row | undefined
    const spec = job ? parseObjectJson(String(job.spec_json)) : null
    const corpusId = String(isObject(spec?.binary) ? spec.binary.corpusId ?? '' : '')
    const corpusArtifact = this.corpus.artifact(corpusId)
    if (!job || !spec || !corpusArtifact) throw new Error('summary authoritative job/corpus context missing')
    const source = authoritativeSummarySource(jobIds[0]!, job, spec, corpusId, corpusArtifact.record, ids)
    const sampleSets: Array<{ metric: Record<string, JsonValue>; samples: ProtocolSample[] }> = [{
      metric: { key: 'duration', metricDomain: 'physical-time-ns', unit: 'ns' },
      samples: [...pairs.values()].map((pair) => {
        const measured = pair.find((item) => item.raw.phase === 'measured')!
        const value = Number(measured.raw.monotonicDurationNs)
        if (!Number.isFinite(value) || value < 0) throw new Error('measured duration is invalid')
        return protocolSample(measured.row, value)
      }),
    }]
    const energySets = new Map<string, { metric: Record<string, JsonValue>; samples: ProtocolSample[] }>()
    for (const pair of pairs.values()) {
      const measured = pair.find((item) => item.raw.phase === 'measured')!, idle = pair.find((item) => item.raw.phase === 'idle')!
      const activeEnergy = energyMap(measured.raw), idleEnergy = energyMap(idle.raw)
      if (activeEnergy.size !== idleEnergy.size || [...activeEnergy.keys()].some((key) => !idleEnergy.has(key))) throw new Error('measured/idle energy adapters, domains, scopes, or boundaries differ')
      for (const [key, active] of activeEnergy) {
        const baseline = idleEnergy.get(key)!, gross = finiteNonnegative(active.grossJoules, 'active gross energy')
        const idleGross = finiteNonnegative(baseline.grossJoules, 'idle gross energy')
        const activeDuration = Number(measured.raw.monotonicDurationNs), idleDuration = Number(idle.raw.monotonicDurationNs)
        if (!(activeDuration > 0) || !(idleDuration > 0)) throw new Error('energy pair duration is invalid')
        const adjusted = gross - idleGross * activeDuration / idleDuration
        for (const [adjustment, value] of [['gross', gross], ['idle-adjusted', adjusted]] as const) {
          const setKey = `${key}\0${adjustment}`, existing = energySets.get(setKey) ?? {
            metric: { key: `energy:${key}:${adjustment}`, metricDomain: 'physical-energy-j', unit: 'J', energyDomain: String(active.domain), adapter: String(active.adapter), scope: String(active.scope), boundary: String(active.boundary), adjustment },
            samples: [],
          }
          existing.samples.push(protocolSample(measured.row, value)); energySets.set(setKey, existing)
        }
      }
    }
    sampleSets.push(...energySets.values())
    const now = new Date().toISOString(), output: Row[] = []
    for (const set of sampleSets) {
      const base = summarizeSamples(set.samples, { ...metadata, rawDatasetHash: sha256(canonicalJson({ rawDatasetHash, metric: set.metric } as JsonValue)) })
      const summary = { ...base, metric: set.metric, source }
      const id = sha256(canonicalJson(summary as unknown as JsonValue))
      this.sqlite.prepare('INSERT OR IGNORE INTO empirical_summaries VALUES(?,?,?,?)').run(id, base.rawDatasetHash, canonicalJson(summary as unknown as JsonValue), now)
      this.empirical.audit('admin:session', 'empirical.summarize', 'success', 'summary', id, { rawDatasetHash, metric: set.metric })
      output.push(this.sqlite.prepare('SELECT * FROM empirical_summaries WHERE id=?').get(id) as Row)
    }
    return output
  }

  createDataset(definition: { summaryIds: readonly string[]; featureExtractor: string; featureVersion: string }): Row {
    if (definition.featureExtractor !== 'summary-basic' || definition.featureVersion !== '1') throw new Error('unsupported server feature extractor/version')
    const resolved = [...definition.summaryIds].sort()
    if (!resolved.length || new Set(resolved).size !== resolved.length) throw new Error('dataset summary IDs must be nonempty and unique')
    const extractorHash = sha256(canonicalJson({ name: definition.featureExtractor, version: definition.featureVersion, features: ['validCount', 'invalidCount', 'flaggedFraction', 'sampleSd'], target: 'primary.mean', weight: 'validCount' }))
    const materialized = resolved.map((summaryId) => this.materializeSummary(summaryId))
    const summaries = resolved.map((summaryId) => {
      const row = this.sqlite.prepare('SELECT summary_json FROM empirical_summaries WHERE id=?').get(summaryId) as Row | undefined
      return row ? parseObjectJson(String(row.summary_json)) ?? fail(`invalid summary: ${summaryId}`) : fail(`committed summary not found: ${summaryId}`)
    })
    const metricKeys = new Set(summaries.map((summary) => canonicalJson(summary.metric as JsonValue)))
    if (metricKeys.size !== 1) throw new Error('dataset summaries must share one exact metric domain/unit/energy provenance')
    const metric = summaries[0]!.metric
    if (!isObject(metric) || !['physical-time-ns', 'physical-energy-j'].includes(String(metric.metricDomain)) || !['ns', 'J'].includes(String(metric.unit))) throw new Error('dataset metric provenance is invalid')
    const sources = summaries.map((summary) => isObject(summary.source) ? summary.source : fail('summary source provenance is missing'))
    for (const source of sources) {
      for (const key of ['workloadId', 'target', 'modelVersion', 'profileId', 'simulatorVersion', 'toolchainHash', 'corpusId', 'roiDefinitionHash', 'workloadSemanticHash'] as const) {
        if (typeof source[key] !== 'string' || !source[key]) throw new Error(`dataset requires authoritative ${key} provenance`)
      }
    }
    const dimensionNames = {
      workloadId: 'workloadIds', target: 'targets', modelVersion: 'modelVersions', profileId: 'profileIds', simulatorVersion: 'simulatorVersions',
      toolchainHash: 'toolchainHashes', corpusId: 'corpusIds', roiDefinitionHash: 'roiDefinitionHashes', workloadSemanticHash: 'workloadSemanticHashes',
    } as const
    const dimensions = Object.fromEntries(Object.entries(dimensionNames).map(([key, plural]) =>
      [plural, [...new Set(sources.map((source) => String(source[key])))].sort()]))
    const featureNames = Object.keys(materialized[0]!.features).sort()
    if (materialized.some((row) => Object.keys(row.features).sort().join('\0') !== featureNames.join('\0'))) throw new Error('dataset feature registry mismatch')
    const parameterRanges = Object.fromEntries(featureNames.map((name) => {
      const values = materialized.map((row) => row.features[name]!)
      return [name, [Math.min(...values), Math.max(...values)]]
    }))
    const featureMapping = Object.fromEntries(featureNames.map((name) => [name, name]))
    const provenance = { metric, dimensions, parameterRanges, featureMapping, applicabilityVersion: 'summary-basic-applicability-1' }
    const rowEntries = materialized.map((row) => { const json = canonicalJson(row as unknown as JsonValue); return { row, json, hash: sha256(json) } })
    const canonical = { summaryIds: resolved, featureExtractor: definition.featureExtractor, featureVersion: definition.featureVersion, extractorHash, provenance, rowHashes: rowEntries.map((entry) => ({ id: entry.row.id, hash: entry.hash })) }
    const datasetHash = sha256(canonicalJson(canonical as unknown as JsonValue)), id = randomUUID(), now = new Date().toISOString()
    this.transaction(() => {
      this.sqlite.prepare("INSERT INTO calibration_datasets VALUES(?,'draft',0,?,?,?,?,?,NULL)").run(id, canonicalJson({ summaryIds: resolved, featureExtractor: definition.featureExtractor, featureVersion: definition.featureVersion, extractorHash, provenance } as unknown as JsonValue), canonicalJson(resolved), datasetHash, null, now)
      const insert = this.sqlite.prepare('INSERT INTO calibration_dataset_rows VALUES(?,?,?,?)')
      for (const entry of rowEntries) insert.run(id, entry.row.id, entry.hash, entry.json)
      this.empirical.audit('admin:session', 'dataset.create', 'success', 'dataset', id, { datasetHash, extractorHash })
    })
    return this.dataset(id)!
  }
  dataset(id: string): Row | null { return this.sqlite.prepare('SELECT * FROM calibration_datasets WHERE id=?').get(id) as Row | undefined ?? null }
  split(datasetId: string): Row | null { return this.sqlite.prepare('SELECT * FROM calibration_splits WHERE dataset_id=?').get(datasetId) as Row | undefined ?? null }
  datasetRows(datasetId: string): MaterializedRow[] {
    return (this.sqlite.prepare('SELECT row_json FROM calibration_dataset_rows WHERE dataset_id=? ORDER BY row_id').all(datasetId) as Row[]).map((row) => JSON.parse(String(row.row_json)) as MaterializedRow)
  }
  freezeDataset(id: string, expectedVersion: number, splitOptions: { seed: string; selectionFraction?: number; conformalFraction?: number; holdoutFraction?: number; holdoutMachine?: string; holdoutSession?: string }): Row {
    return this.transaction(() => {
      const row = this.dataset(id)
      if (!row || row.state !== 'draft' || Number(row.version) !== expectedVersion) throw new Error('dataset state/version conflict')
      const materialized = this.datasetRows(id)
      const resolved = JSON.parse(String(row.resolved_ids_json)) as string[]
      if (materialized.length !== resolved.length || !materialized.every((member) => resolved.includes(member.id))) throw new Error('materialized dataset rows must exactly cover summaries')
      const members: DatasetMember[] = materialized.map((item) => ({ id: item.id, family: item.family, sessionId: item.sessionId, machineId: item.machineId }))
      const split = createFrozenSplit(members, splitOptions), splitId = randomUUID(), now = new Date().toISOString()
      const signature = this.signState({ datasetId: id, datasetHash: String(row.dataset_hash), splitHash: split.hash, definition: JSON.parse(String(row.definition_json)) as JsonValue, state: 'frozen' }, now)
      this.sqlite.prepare('INSERT INTO calibration_splits VALUES(?,?,?,?,?)').run(splitId, id, split.hash, canonicalJson(split as unknown as JsonValue), now)
      if (this.sqlite.prepare("UPDATE calibration_datasets SET state='frozen',version=version+1,signature_json=?,frozen_at=? WHERE id=? AND state='draft' AND version=?").run(canonicalJson(signature), now, id, expectedVersion).changes !== 1) throw new Error('dataset freeze conflict')
      this.empirical.audit('admin:session', 'dataset.freeze', 'success', 'dataset', id, { splitHash: split.hash })
      return { ...this.dataset(id)!, split }
    })
  }

  createCalibration(datasetId: string, request: { modelKind: 'ridge' | 'elastic-net' | 'nonnegative-energy'; acceptanceThresholds: Record<string, number> }): Row {
    const dataset = this.dataset(datasetId)
    if (!dataset || dataset.state !== 'frozen') throw new Error('calibration requires frozen dataset')
    const definition = parseObjectJson(String(dataset.definition_json)) ?? fail('frozen dataset definition is invalid')
    const provenance = isObject(definition.provenance) ? definition.provenance : fail('frozen dataset provenance is missing')
    const metric = isObject(provenance.metric) ? provenance.metric : fail('frozen dataset metric is missing')
    const dimensions = isObject(provenance.dimensions) ? provenance.dimensions : fail('frozen dataset dimensions are missing')
    const metricDomain = String(metric.metricDomain)
    if (metricDomain === 'physical-energy-j' && request.modelKind !== 'nonnegative-energy') throw new Error('physical-energy calibration requires the nonnegative-energy model')
    if (metricDomain === 'physical-time-ns' && request.modelKind === 'nonnegative-energy') throw new Error('time summaries cannot create an energy calibration')
    const thresholds = validateAcceptanceThresholds(request.acceptanceThresholds)
    const specification = {
      modelKind: request.modelKind,
      acceptanceThresholds: thresholds,
      domain: {
        workloadIds: dimensions.workloadIds, targets: dimensions.targets,
        modelVersions: dimensions.modelVersions, profileIds: dimensions.profileIds,
        simulatorVersions: dimensions.simulatorVersions, toolchainHashes: dimensions.toolchainHashes,
        corpusIds: dimensions.corpusIds, roiDefinitionHashes: dimensions.roiDefinitionHashes,
        workloadSemanticHashes: dimensions.workloadSemanticHashes,
      },
      parameterRanges: provenance.parameterRanges,
      featureMapping: provenance.featureMapping,
      metricDomain,
      unit: metric.unit,
      metric,
      featureExtractor: definition.featureExtractor,
      featureVersion: definition.featureVersion,
      extractorHash: definition.extractorHash,
      applicabilityVersion: provenance.applicabilityVersion,
    }
    const id = randomUUID(), now = new Date().toISOString()
    this.sqlite.prepare("INSERT INTO calibration_fits VALUES(?,?,'created',0,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?)").run(id, datasetId, canonicalJson(specification as unknown as JsonValue), now, now)
    this.empirical.audit('admin:session', 'calibration.create', 'success', 'calibration', id, { datasetId })
    return this.calibration(id)!
  }
  calibration(id: string): Row | null { return this.sqlite.prepare('SELECT * FROM calibration_fits WHERE id=?').get(id) as Row | undefined ?? null }
  fitPayload(id: string): { datasetHash: string; datasetManifest: JsonValue; splitHash: string; rows: MaterializedRow[]; trainingIds: string[]; selectionIds: string[]; conformalIds: string[] } {
    const calibration = this.calibration(id); if (!calibration) throw new Error('calibration not found')
    const dataset = this.dataset(String(calibration.dataset_id)), splitRow = this.split(String(calibration.dataset_id))
    if (!dataset || dataset.state !== 'frozen' || !splitRow) throw new Error('frozen dataset/split not found')
    const split = JSON.parse(String(splitRow.split_json)) as { trainingIds: string[]; selectionIds: string[]; conformalIds: string[] }
    const allowed = new Set([...split.trainingIds, ...split.selectionIds, ...split.conformalIds])
    return { datasetHash: String(dataset.dataset_hash), datasetManifest: this.datasetManifest(String(dataset.id)), splitHash: String(splitRow.split_hash), rows: this.datasetRows(String(dataset.id)).filter((row) => allowed.has(row.id)), trainingIds: split.trainingIds, selectionIds: split.selectionIds, conformalIds: split.conformalIds }
  }
  beginHoldout(id: string, expectedVersion: number): { reservationVersion: number; datasetHash: string; datasetManifest: JsonValue; splitHash: string; fit: JsonValue; conformal: JsonValue; rows: MaterializedRow[]; holdoutIds: string[]; fitHash: string } {
    return this.transaction(() => {
      const calibration = this.calibration(id)
      if (!calibration || calibration.state !== 'fitted' || Number(calibration.version) !== expectedVersion || calibration.holdout_lock_hash || !calibration.fit_json) throw new Error('holdout already published or calibration is not fitted/version-current')
      const dataset = this.dataset(String(calibration.dataset_id)), splitRow = this.split(String(calibration.dataset_id))
      if (!dataset || !splitRow) throw new Error('frozen dataset/split not found')
      const split = JSON.parse(String(splitRow.split_json)) as { holdoutIds: string[] }
      const fit = JSON.parse(String(calibration.fit_json)) as JsonValue
      const fitEvaluation = JSON.parse(String(calibration.evaluation_json)) as Record<string, JsonValue>
      if (!fitEvaluation.conformal) throw new Error('validation-only interval calibration is missing')
      if (this.sqlite.prepare("UPDATE calibration_fits SET state='evaluating_holdout',version=version+1,updated_at=? WHERE id=? AND state='fitted' AND version=? AND holdout_lock_hash IS NULL").run(new Date().toISOString(), id, expectedVersion).changes !== 1) throw new Error('holdout reservation conflict')
      this.empirical.audit('admin:session', 'calibration.holdout.reserve', 'success', 'calibration', id, { expectedVersion })
      return { reservationVersion: expectedVersion + 1, datasetHash: String(dataset.dataset_hash), datasetManifest: this.datasetManifest(String(dataset.id)), splitHash: String(splitRow.split_hash), fit, conformal: fitEvaluation.conformal, rows: this.datasetRows(String(dataset.id)).filter((row) => split.holdoutIds.includes(row.id)), holdoutIds: split.holdoutIds, fitHash: sha256(canonicalJson(fit)) }
    })
  }
  abortHoldout(id: string, reservationVersion: number): void {
    this.transaction(() => {
      if (this.sqlite.prepare("UPDATE calibration_fits SET state='fitted',version=version+1,updated_at=? WHERE id=? AND state='evaluating_holdout' AND version=? AND holdout_lock_hash IS NULL").run(new Date().toISOString(), id, reservationVersion).changes === 1) {
        this.empirical.audit('system', 'calibration.holdout.abort', 'failure', 'calibration', id, { reservationVersion })
      }
    })
  }
  recordFit(id: string, expectedVersion: number, fit: JsonValue, evaluation: JsonValue): Row {
    const calibration = this.calibration(id), evaluationObject = isObject(evaluation) ? evaluation : null
    const dataset = calibration ? this.dataset(String(calibration.dataset_id)) : null
    if (!calibration || !dataset || evaluationObject?.datasetHash !== dataset.dataset_hash) throw new Error('fit result dataset hash mismatch')
    const now = new Date().toISOString()
    const changed = this.sqlite.prepare("UPDATE calibration_fits SET state='fitted',version=version+1,fit_json=?,evaluation_json=?,updated_at=? WHERE id=? AND state='created' AND version=?").run(canonicalJson(fit), canonicalJson(evaluation), now, id, expectedVersion)
    if (changed.changes !== 1) throw new Error('calibration fit state/version conflict')
    this.empirical.audit('admin:session', 'calibration.fit', 'success', 'calibration', id, { fitHash: sha256(canonicalJson(fit)) })
    return this.calibration(id)!
  }
  recordHoldout(id: string, expectedVersion: number, holdoutEvaluation: JsonValue): Row {
    return this.transaction(() => {
      const row = this.calibration(id)
      if (!row || row.state !== 'evaluating_holdout' || Number(row.version) !== expectedVersion || row.holdout_lock_hash) throw new Error('holdout already published or calibration state/version conflict')
      const previousEvaluation = JSON.parse(String(row.evaluation_json)) as Record<string, JsonValue>
      const fitHash = sha256(canonicalJson(JSON.parse(String(row.fit_json)) as JsonValue))
      const fullEvaluation = { ...previousEvaluation, holdout: holdoutEvaluation }
      const evaluationHash = sha256(canonicalJson(fullEvaluation))
      const lockHash = sha256(canonicalJson({ fitHash, evaluationHash, holdoutEvaluation })), now = new Date().toISOString()
      const signature = this.signState({ calibrationId: id, fitHash, evaluationHash, holdoutLockHash: lockHash, holdoutEvaluation, state: 'pending_review' }, now)
      const changed = this.sqlite.prepare("UPDATE calibration_fits SET state='pending_review',version=version+1,evaluation_json=?,holdout_lock_hash=?,signature_json=?,updated_at=? WHERE id=? AND state='evaluating_holdout' AND version=? AND holdout_lock_hash IS NULL").run(canonicalJson(fullEvaluation), lockHash, canonicalJson(signature), now, id, expectedVersion)
      if (changed.changes !== 1) throw new Error('holdout publication conflict')
      this.empirical.audit('admin:session', 'calibration.holdout.evaluate', 'success', 'calibration', id, { holdoutLockHash: lockHash })
      return this.calibration(id)!
    })
  }
  approve(id: string, expectedVersion: number): Row {
    return this.transaction(() => {
      const row = this.calibration(id)
      if (!row || row.state !== 'pending_review' || Number(row.version) !== expectedVersion || !row.holdout_lock_hash) throw new Error('calibration approval state/version conflict')
      const specification = parseObjectJson(String(row.specification_json)) ?? fail('calibration specification invalid')
      const thresholds = isObject(specification.acceptanceThresholds) ? specification.acceptanceThresholds : fail('preregistered acceptance thresholds missing')
      const evaluation = parseObjectJson(String(row.evaluation_json)) ?? fail('holdout evaluation missing')
      const holdout = isObject(evaluation.holdout) ? evaluation.holdout : fail('holdout evaluation missing')
      const metrics = isObject(holdout.metrics) ? holdout.metrics : fail('holdout metrics missing')
      const coverage = isObject(holdout.intervalCoverage) ? holdout.intervalCoverage : fail('holdout interval coverage missing')
      const coverage50 = isObject(coverage['0.5']) ? Number(coverage['0.5'].coverage) : Number.NaN
      const coverage95 = isObject(coverage['0.95']) ? Number(coverage['0.95'].coverage) : Number.NaN
      const gateValues = [metrics.rmse, metrics.mae, metrics.r2, coverage50, coverage95]
      const passed = gateValues.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
        Number(metrics.rmse) <= Number(thresholds.maxRmse) && Number(metrics.mae) <= Number(thresholds.maxMae) &&
        Number(metrics.r2) >= Number(thresholds.minR2) && coverage50 >= Number(thresholds.minCoverage50) && coverage95 >= Number(thresholds.minCoverage95)
      const state = passed ? 'approved' : 'rejected', now = new Date().toISOString()
      const signature = this.signState({ calibrationId: id, holdoutLockHash: String(row.holdout_lock_hash), thresholds: thresholds as JsonValue, gatePassed: passed, state }, now)
      const changed = this.sqlite.prepare("UPDATE calibration_fits SET state=?,version=version+1,signature_json=?,approved_at=?,updated_at=? WHERE id=? AND state='pending_review' AND version=?").run(state, canonicalJson(signature), passed ? now : null, now, id, expectedVersion)
      if (changed.changes !== 1) throw new Error('calibration review conflict')
      this.empirical.audit('admin:session', 'calibration.approve', passed ? 'success' : 'failure', 'calibration', id, { holdoutLockHash: String(row.holdout_lock_hash), thresholds: thresholds as unknown as JsonValue, gatePassed: passed })
      return this.calibration(id)!
    })
  }
  retire(id: string, expectedVersion: number): Row {
    const now = new Date().toISOString()
    const existing = this.calibration(id)
    if (!existing || existing.state !== 'approved' || Number(existing.version) !== expectedVersion) throw new Error('calibration retire state/version conflict')
    const signature = this.signState({ calibrationId: id, previousSignatureHash: sha256(String(existing.signature_json)), state: 'retired' }, now)
    if (this.sqlite.prepare("UPDATE calibration_fits SET state='retired',version=version+1,signature_json=?,updated_at=? WHERE id=? AND state='approved' AND version=?").run(canonicalJson(signature), now, id, expectedVersion).changes !== 1) throw new Error('calibration retire state/version conflict')
    this.empirical.audit('admin:session', 'calibration.retire', 'success', 'calibration', id, {})
    return this.calibration(id)!
  }

  counts(): Record<string, number> {
    return Object.fromEntries(['empirical_runs', 'empirical_summaries', 'calibration_datasets', 'calibration_splits', 'calibration_fits'].map((table) => [table, Number((this.sqlite.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as Row).count)]))
  }

  private materializeSummary(summaryId: string): MaterializedRow {
    const row = this.sqlite.prepare('SELECT summary_json FROM empirical_summaries WHERE id=?').get(summaryId) as Row | undefined
    if (!row) throw new Error(`committed summary not found: ${summaryId}`)
    const summary = parseObjectJson(String(row.summary_json)), primary = summary && isObject(summary.primary) ? summary.primary : null
    const source = summary && isObject(summary.source) ? summary.source : null
    if (!summary || !primary || !source || !Number.isFinite(primary.mean) || !Number.isFinite(primary.sampleSd) ||
        !Number.isSafeInteger(summary.validCount) || Number(summary.validCount) <= 0 || !Number.isSafeInteger(summary.invalidCount) || !Number.isSafeInteger(summary.flaggedCount)) throw new Error(`summary cannot be materialized: ${summaryId}`)
    return {
      id: summaryId, family: String(source.family), sessionId: String(source.sessionId), machineId: String(source.machineId),
      features: { validCount: Number(summary.validCount), invalidCount: Number(summary.invalidCount), flaggedFraction: Number(summary.flaggedCount) / Number(summary.validCount), sampleSd: Number(primary.sampleSd) },
      target: Number(primary.mean), weight: Number(summary.validCount), summaryHash: sha256(String(row.summary_json)),
    }
  }
  private datasetManifest(datasetId: string): JsonValue {
    const dataset = this.dataset(datasetId); if (!dataset) throw new Error('dataset not found')
    const definition = parseObjectJson(String(dataset.definition_json)); if (!definition) throw new Error('dataset definition invalid')
    const summaryIds = JSON.parse(String(dataset.resolved_ids_json)) as string[]
    const rowHashes = (this.sqlite.prepare('SELECT row_id,row_hash FROM calibration_dataset_rows WHERE dataset_id=? ORDER BY row_id').all(datasetId) as Row[]).map((row) => ({ id: String(row.row_id), hash: String(row.row_hash) }))
    return { summaryIds, featureExtractor: String(definition.featureExtractor), featureVersion: String(definition.featureVersion), extractorHash: String(definition.extractorHash), provenance: definition.provenance as JsonValue, rowHashes }
  }
  private appendReport(quarantineId: string, bundleHash: string, decision: 'accepted-for-review' | 'rejected' | 'committed' | 'deleted', reasons: readonly { code: string; severity: 'error' | 'warning' | 'info'; path?: string; detail: string }[]): void {
    const previous = this.sqlite.prepare('SELECT report_hash FROM calibration_import_reports ORDER BY rowid DESC LIMIT 1').get() as Row | undefined
    const report = createImportReport({ previousReportHash: String(previous?.report_hash ?? '0'.repeat(64)), bundleHash, decision, reasons, createdAt: new Date().toISOString() })
    const signed = signImportReport(report, this.reportKeyId, this.reportSigner, report.createdAt)
    this.sqlite.prepare('INSERT INTO calibration_import_reports VALUES(?,?,?,?,?,?,?)').run(report.reportId, quarantineId, report.previousReportHash, report.reportId, canonicalJson(report as unknown as JsonValue), canonicalJson(signed as unknown as JsonValue), report.createdAt)
  }
  private signState(payload: Record<string, JsonValue>, signedAt: string): JsonValue {
    const protectedHeader = { algorithm: 'Ed25519', keyId: this.reportKeyId, signedAt }
    const signature = cryptoSign(null, Buffer.from(canonicalJson({ protected: protectedHeader, payload })), this.reportSigner).toString('base64')
    return { ...protectedHeader, payload, signature }
  }
  private manifestAt(runnerId: string, measuredAt: string): Record<string, unknown> | null {
    if (!Number.isFinite(Date.parse(measuredAt))) return null
    const row = this.sqlite.prepare('SELECT envelope_json FROM empirical_manifests WHERE runner_id=? AND observed_at<=? AND expires_at>? ORDER BY sequence DESC LIMIT 1').get(runnerId, measuredAt, measuredAt) as Row | undefined
    if (!row) return null
    const envelope = parseObjectJson(String(row.envelope_json))
    return envelope && isObject(envelope.payload) && isObject(envelope.payload.manifest) ? envelope.payload.manifest : null
  }
  private credentialAt(runnerId: string, measuredAt: string): Row | null {
    if (!Number.isFinite(Date.parse(measuredAt))) return null
    return this.sqlite.prepare("SELECT state,issued_at,expires_at,credential_json FROM empirical_runner_credential_history WHERE runner_id=? AND state='approved' AND issued_at<=? AND expires_at>? ORDER BY sequence DESC LIMIT 1").get(runnerId, measuredAt, measuredAt) as Row | undefined ?? null
  }
  private validJobEventChain(job: Row): boolean {
    const events = this.sqlite.prepare('SELECT sequence,kind,envelope_json FROM empirical_job_events WHERE job_id=? AND runner_id=? ORDER BY sequence').all(String(job.id), String(job.runner_id)) as Row[]
    const kinds = events.map((event) => String(event.kind))
    if (!kinds.includes('accept') || !kinds.includes('start') || (!kinds.includes('finish') && !kinds.includes('fail'))) return false
    let previous = -1
    for (const event of events) {
      const sequence = Number(event.sequence), envelope = parseObjectJson(String(event.envelope_json)), payload = envelope && isObject(envelope.payload) ? envelope.payload : null
      if (!Number.isSafeInteger(sequence) || sequence <= previous || !payload || payload.leaseId !== job.lease_id || payload.leaseNonce !== job.lease_nonce || payload.sequence !== String(sequence)) return false
      previous = sequence
    }
    return true
  }
  private writeCas(hash: string, bytes: Uint8Array): string {
    const target = join(this.casDir, hash.slice(0, 2), hash)
    if (existsSync(target)) {
      const existing = readFileSync(target)
      if (existing.byteLength !== bytes.byteLength || sha256(existing) !== hash) throw new Error('content-address collision')
      return target
    }
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${randomUUID()}.staging`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      let offset = 0
      while (offset < bytes.byteLength) { const written = writeSync(fd, bytes, offset, bytes.byteLength - offset); if (written <= 0) throw new Error('short quarantine write'); offset += written }
      fsyncSync(fd)
    } catch (error) { closeSync(fd); try { unlinkSync(temporary) } catch {} throw error }
    closeSync(fd)
    if (sha256(readFileSync(temporary)) !== hash) { unlinkSync(temporary); throw new Error('quarantine write hash mismatch') }
    renameSync(temporary, target)
    return target
  }
  private transaction<T>(operation: () => T): T {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try { const value = operation(); this.sqlite.exec('COMMIT'); return value } catch (error) { this.sqlite.exec('ROLLBACK'); throw error }
  }
}

function parseObjectJson(json: string): Record<string, unknown> | null { try { const value = JSON.parse(json) as unknown; return isObject(value) ? value : null } catch { return null } }
function parseBundleHeader(bytes: Uint8Array): Record<string, unknown> | null {
  try { const line = Buffer.from(bytes).toString('utf8').split('\n', 1)[0]; if (!line) return null; const value = JSON.parse(line) as unknown; return isObject(value) ? value : null } catch { return null }
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function fail(message: string): never { throw new Error(message) }
function pickRunSchedule(value: Record<string, unknown>): Record<string, unknown> {
  return { phase: value.phase, arm: value.arm, block: value.block, ordinal: value.ordinal, pairId: value.pairId }
}
function protocolSample(row: Row, value: number): ProtocolSample {
  if (!Number.isFinite(value)) throw new Error(`nonfinite metric value for ${String(row.id)}`)
  return { id: String(row.id), value, protocolValid: true, protocolReasons: [], statisticalFlag: Boolean(row.statistical_flag) }
}
function energyMap(raw: Record<string, unknown>): Map<string, Record<string, unknown>> {
  if (!Array.isArray(raw.energy)) throw new Error('energy observations must be an array')
  const output = new Map<string, Record<string, unknown>>()
  for (const value of raw.energy) {
    const item = isObject(value) ? value : fail('invalid energy observation')
    if (item.supported !== true) continue
    if (item.processEnergy !== false || typeof item.adapter !== 'string' || !item.adapter ||
        typeof item.domain !== 'string' || !item.domain || typeof item.scope !== 'string' || !item.scope ||
        typeof item.boundary !== 'string' || !item.boundary) throw new Error('supported energy observation lacks exact adapter/domain/scope/boundary provenance')
    const key = `${item.adapter}\0${item.domain}\0${item.scope}\0${item.boundary}`
    if (output.has(key)) throw new Error('duplicate energy adapter/domain/scope/boundary observation')
    output.set(key, item)
  }
  return output
}
function finiteNonnegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid`)
  return value
}
function validateAcceptanceThresholds(value: Record<string, number>): Record<string, number> {
  const keys = ['maxRmse', 'maxMae', 'minR2', 'minCoverage50', 'minCoverage95']
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error('acceptance thresholds must preregister maxRmse/maxMae/minR2/minCoverage50/minCoverage95')
  for (const key of keys) if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) throw new Error(`acceptance threshold ${key} must be finite`)
  if (value.maxRmse! < 0 || value.maxMae! < 0 || value.minR2! < -1 || value.minR2! > 1 ||
      value.minCoverage50! < 0 || value.minCoverage50! > 1 || value.minCoverage95! < 0 || value.minCoverage95! > 1) throw new Error('acceptance thresholds are out of bounds')
  return Object.fromEntries(keys.map((key) => [key, value[key]!]))
}
function authoritativeSummarySource(jobId: string, job: Row, spec: Record<string, unknown>, corpusId: string, record: Record<string, unknown>, ids: readonly string[]): Record<string, JsonValue> {
  const target = isObject(spec.target) ? spec.target : fail('authoritative target is missing')
  const parameterValues = Object.fromEntries(['n', 'seed'].filter((key) => Number.isFinite(record[key])).map((key) => [key, Number(record[key])]))
  const image = isObject(record.image) ? record.image : {}
  return {
    runIds: [...ids].sort(), jobId, runnerId: String(job.runner_id), sessionId: jobId,
    family: String(record.family ?? record.workload ?? corpusId), machineId: String(job.runner_id),
    workloadId: String(record.workload ?? ''), target: String(record.target ?? `${String(target.isa)}-${String(target.os)}-${String(target.abi)}`),
    corpusId, corpusVersion: String(record.corpusVersion ?? ''), roiDefinitionHash: String(record.roiHash ?? ''),
    toolchainHash: sha256(canonicalJson({ compiler: record.compiler ?? null, image, flags: record.flags ?? [] } as unknown as JsonValue)),
    workloadSemanticHash: sha256(canonicalJson({ workload: record.workload ?? null, workloadVersion: record.workloadVersion ?? null, parameterValues } as JsonValue)),
    parameterValues,
    simulatorVersion: typeof record.simulatorVersion === 'string' ? record.simulatorVersion : null,
    modelVersion: typeof record.modelVersion === 'string' ? record.modelVersion : null,
    profileId: typeof record.profileId === 'string' ? record.profileId : null,
  }
}

function loadSigner(path: string): KeyObject {
  if (existsSync(path)) {
    const key = createPrivateKey({ key: readFileSync(path), format: 'der', type: 'pkcs8' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('calibration report key is not Ed25519')
    return key
  }
  const key = generateKeyPairSync('ed25519').privateKey
  writeFileSync(path, key.export({ format: 'der', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
  return key
}
