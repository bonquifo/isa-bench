import {
  fingerprint,
  parseTaggedJson,
  stablePrettySerialize,
} from '../engine/measurement.ts'
import type { CompareResult } from '../engine/compare.ts'
import { targetFull } from './targetNames.ts'

export const RESULT_EXPORT_VERSION = 2
export const EXPORT_DISCLAIMER =
  'Deterministic educational software model only; no physical hardware measurements or performance prediction.'

export interface CanonicalResultEnvelope {
  format: 'isa-bench-canonical-result'
  version: 2
  disclaimer: string
  contract: CompareResult['contract']
  provenance: {
    inputFingerprint: string
    comparisonMode: CompareResult['hardwareMode']
    workloadKind: CompareResult['workload']['kind']
  }
  rerunInput: CompareResult['rerunInput']
  resolvedProfiles: CompareResult['resolvedHardware']
  result: CompareResult
}

export function makeCanonicalResultEnvelope(result: CompareResult): CanonicalResultEnvelope {
  return {
    format: 'isa-bench-canonical-result',
    version: RESULT_EXPORT_VERSION,
    disclaimer: EXPORT_DISCLAIMER,
    contract: result.contract,
    provenance: {
      inputFingerprint: result.inputFingerprint,
      comparisonMode: result.hardwareMode,
      workloadKind: result.workload.kind,
    },
    rerunInput: result.rerunInput,
    resolvedProfiles: result.resolvedHardware,
    result,
  }
}

export function resultToJson(result: CompareResult): string {
  return stablePrettySerialize(makeCanonicalResultEnvelope(result))
}

export function parseResultJson(text: string): CanonicalResultEnvelope {
  const parsed = parseTaggedJson(text)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { format?: unknown }).format !== 'isa-bench-canonical-result' ||
    (parsed as { version?: unknown }).version !== RESULT_EXPORT_VERSION
  ) {
    throw new Error('Unsupported canonical result envelope')
  }
  return parsed as CanonicalResultEnvelope
}

export function csvEscape(value: unknown): string {
  const raw = value == null ? '' : String(value)
  const text = typeof value === 'string' && /^\s*[=+\-@]/.test(value) ? `'${raw}` : raw
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const CSV_HEADERS = [
  'export_kind',
  'disclaimer',
  'isa_target',
  'isa_public_name',
  'illustrative_profile_name',
  'comparison_mode',
  'workload_id',
  'workload_kind',
  'requested_n',
  'effective_n',
  'requested_seed',
  'effective_seed',
  'seed_used',
  'requested_worker_cap',
  'effective_active_workers',
  'contract_schema_version',
  'model_version',
  'frontend_version',
  'backend_version',
  'profile_version',
  'energy_model_version',
  'energy_model_class',
  'energy_uncertainty',
  'profile_snapshot_id',
  'profile_snapshot_fingerprint',
  'result_value',
  'reference_match',
  'model_cycles',
  'dynamic_modeled_ops',
  'aggregate_modeled_ops_per_model_cycle',
  'model_cycles_per_aggregate_op',
  'modeled_stream_bytes',
  'modeled_elapsed_time_us',
  'nominal_model_energy_nj_uncalibrated',
  'cores_that_issued',
  'average_active_cores',
  'stdout',
] as const

export function resultToCsv(result: CompareResult): string {
  const rows = result.rows.map((row) => {
    const resolved = result.resolvedHardware.find((item) => item.isa === row.isa)
    const profile = resolved?.profile
    return [
      'flattened-summary-only-json-is-canonical',
      EXPORT_DISCLAIMER,
      row.isa,
      targetFull(result, row.isa),
      row.hardwareName,
      result.hardwareMode,
      result.workloadId,
      result.workload.kind,
      result.workload.nRole === 'problem-size' ? result.workload.requestedN : '',
      result.workload.effectiveN ?? '',
      result.workload.seedUsed ? result.workload.requestedSeed : '',
      result.workload.seedUsed ? (result.workload.effectiveSeed ?? '') : '',
      result.workload.seedUsed,
      result.workload.requestedWorkerCap ?? '',
      row.activeThreads,
      result.contract.schemaVersion,
      result.contract.modelVersion,
      result.contract.frontendVersion,
      result.contract.backendVersion,
      result.contract.profileVersion,
      result.contract.energyVersion,
      row.energyModelClass,
      row.energyUncertainty,
      profile?.id ?? row.hardwareId,
      profile ? fingerprint(profile) : '',
      row.result,
      row.matchedGold,
      row.cycles,
      row.completedOperations,
      row.aggregateModeledOpsPerCycle,
      row.modelCyclesPerAggregateOp,
      row.codeBytes,
      row.timeUs,
      row.nominalModelEnergyNj,
      row.coresThatIssued,
      row.averageActiveCores,
      row.stdout ?? result.stdout,
    ]
  })
  return [CSV_HEADERS, ...rows].map((line) => line.map(csvEscape).join(',')).join('\r\n')
}
