import { parentPort, workerData } from 'node:worker_threads'
import { canonicalJson, type JsonValue } from '@isa-sim/contracts'
import { calibrateSplitConformal, fitConstrainedLinear, intervalMetrics, regressionMetrics, sha256, type FitRow, type LinearFit, type SplitConformalCalibration } from '@isa-sim/calibration'

interface FitRequest {
  mode: 'fit'
  datasetHash: string
  datasetManifest: JsonValue
  splitHash: string
  payloadHash: string
  rows: FitRow[]
  trainingIds: string[]
  selectionIds: string[]
  conformalIds: string[]
  configs: { kind?: LinearFit['kind']; lambda?: number; l1Ratio?: number }[]
}
interface EvaluateRequest {
  mode: 'evaluate'
  datasetHash: string
  datasetManifest: JsonValue
  splitHash: string
  payloadHash: string
  fitHash: string
  fit: LinearFit
  conformal: SplitConformalCalibration
  rows: FitRow[]
  holdoutIds: string[]
}
type Request = FitRequest | EvaluateRequest

function main(input: Request): unknown {
  if (!Array.isArray(input.rows) || input.rows.length < 2 || input.rows.length > 10_000) throw new Error('fit row count out of bounds')
  const unhashed = { ...input, payloadHash: undefined }
  delete unhashed.payloadHash
  if (sha256(canonicalJson(unhashed as unknown as JsonValue)) !== input.payloadHash) throw new Error('dataset worker payload hash mismatch')
  if (sha256(canonicalJson(input.datasetManifest)) !== input.datasetHash) throw new Error('dataset manifest hash mismatch')
  const manifest = input.datasetManifest as { rowHashes?: unknown }
  if (!Array.isArray(manifest.rowHashes)) throw new Error('dataset manifest row hashes missing')
  const rowHashes = new Map(manifest.rowHashes.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid dataset row hash')
    const item = entry as Record<string, unknown>
    return [String(item.id), String(item.hash)]
  }))
  for (const row of input.rows) if (rowHashes.get(row.id) !== sha256(canonicalJson(row as unknown as JsonValue))) throw new Error(`materialized row hash mismatch: ${row.id}`)
  if (input.mode === 'evaluate') {
    if (sha256(canonicalJson(input.fit as unknown as JsonValue)) !== input.fitHash) throw new Error('fit hash mismatch')
    if (input.rows.length !== input.holdoutIds.length || new Set(input.holdoutIds).size !== input.rows.length ||
        input.rows.some((row) => !input.holdoutIds.includes(row.id))) throw new Error('holdout rows differ from frozen split')
    const predictions = input.rows.map((row) => ({ id: row.id, actual: row.target, predicted: predict(input.fit, row), weight: row.weight ?? 1 }))
    const metrics = regressionMetrics(predictions.map((row) => row.actual), predictions.map((row) => row.predicted), 1e-12, predictions.map((row) => row.weight))
    const coverage = Object.fromEntries(Object.values(input.conformal.intervals).map(({ level, radius }) => {
      const lower = predictions.map((row) => Math.max(0, row.predicted - radius))
      const upper = predictions.map((row) => row.predicted + radius)
      return [String(level), intervalMetrics(predictions.map((row) => row.actual), lower, upper, level)]
    }))
    return { datasetHash: input.datasetHash, splitHash: input.splitHash, fitHash: input.fitHash, dataHash: sha256(canonicalJson(input.rows as unknown as JsonValue)), predictions, metrics, intervalCoverage: coverage, intervalCalibrationHash: input.conformal.calibrationHash }
  }
  if (!Array.isArray(input.configs) || input.configs.length < 1 || input.configs.length > 20) throw new Error('fit configuration count out of bounds')
  for (const config of input.configs) {
    if (!config || typeof config !== 'object' || Object.keys(config).some((key) => !['kind', 'lambda', 'l1Ratio', 'maxIterations', 'tolerance', 'fitIntercept'].includes(key))) throw new Error('invalid fit configuration shape')
  }
  const byId = new Map(input.rows.map((row) => [row.id, row]))
  if (byId.size !== input.rows.length) throw new Error('duplicate fit row ID')
  const train = input.trainingIds.map((id) => byId.get(id) ?? fail(`missing training row: ${id}`))
  const selection = input.selectionIds.map((id) => byId.get(id) ?? fail(`missing selection row: ${id}`))
  const conformalRows = input.conformalIds.map((id) => byId.get(id) ?? fail(`missing conformal row: ${id}`))
  if (!train.length || !selection.length || conformalRows.length < 10 || input.rows.length !== train.length + selection.length + conformalRows.length) throw new Error('worker requires disjoint train, selection, and sufficient conformal rows; holdout is forbidden')
  if (new Set([...input.trainingIds, ...input.selectionIds, ...input.conformalIds]).size !== input.rows.length) throw new Error('split IDs overlap')
  const candidates = input.configs.map((config) => {
    const fit = fitConstrainedLinear(train, config)
    const trainingPredictions = train.map((row) => predict(fit, row))
    const selectionPredictions = selection.map((row) => predict(fit, row))
    return {
      fit,
      training: regressionMetrics(train.map((row) => row.target), trainingPredictions, 1e-12, train.map((row) => row.weight ?? 1)),
      selection: regressionMetrics(selection.map((row) => row.target), selectionPredictions, 1e-12, selection.map((row) => row.weight ?? 1)),
    }
  })
  candidates.sort((a, b) => a.selection.rmse - b.selection.rmse || a.fit.lambda - b.fit.lambda || a.fit.l1Ratio - b.fit.l1Ratio)
  const selected = candidates[0]!
  const conformalPredictions = conformalRows.map((row) => predict(selected.fit, row))
  const conformal = calibrateSplitConformal(conformalRows.map((row, index) => ({ id: row.id, actual: row.target, predicted: conformalPredictions[index]! })))
  return {
    datasetHash: input.datasetHash, splitHash: input.splitHash,
    selected: {
      ...selected, conformal,
      conformalMetrics: regressionMetrics(conformalRows.map((row) => row.target), conformalPredictions, 1e-12, conformalRows.map((row) => row.weight ?? 1)),
    },
    candidateCount: candidates.length,
  }
}

function predict(fit: LinearFit, row: FitRow): number {
  return fit.intercept + Object.entries(fit.coefficients).reduce((sum, [name, coefficient]) => sum + coefficient * (row.features[name] ?? fail(`missing feature: ${name}`)), 0)
}
function fail(message: string): never { throw new Error(message) }

try { parentPort?.postMessage({ ok: true, result: main(workerData as Request) }) }
catch (error) { parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
