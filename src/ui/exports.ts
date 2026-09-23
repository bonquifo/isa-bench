import {
  fingerprint,
  parseTaggedJson,
  stablePrettySerialize,
} from '../engine/measurement.ts'
import type { CompareResult } from '../engine/compare.ts'
import { isRealResult, targetFull } from './targetNames.ts'

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

/**
 * The flattened summary: one line per target, the report's own figures.
 *
 * A column that means one thing on a real run and another on the lowering
 * is two columns, one of them empty, so a spreadsheet never puts a count
 * of real instructions beside a count of modeled operations as if they
 * were the same measure. Energy is not a column: the report does not
 * present it, and the canonical JSON still carries the model's estimate.
 */
const CSV_HEADERS = [
  'export_kind',
  'disclaimer',
  'execution_mode',
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
  'trace_timing_model_version',
  'frontend_version',
  'backend_version',
  'profile_version',
  'profile_snapshot_id',
  'profile_snapshot_fingerprint',
  'result_value',
  'reference_match',
  'ranked',
  // Counted from the real execution; empty on the lowering.
  'instructions_retired',
  'instruction_bytes_executed',
  'data_memory_instructions',
  'data_memory_reads',
  'data_memory_writes',
  'conditional_branches',
  'conditional_branches_taken',
  'calls',
  'returns',
  'code_executed_distinct_bytes',
  'platform_traps',
  // The lowering's own figures; empty on a real run.
  'dynamic_modeled_ops',
  'modeled_stream_bytes',
  'spill_slots',
  // Modelled, for both.
  'model_cycles',
  'model_clock_mhz',
  'modelled_time_us',
  'model_cycles_per_instruction',
  'model_cycles_per_modeled_op',
  'branch_mispredictions',
  'icache_line_misses',
  'dcache_line_misses',
  'memory_line_requests',
  'stdout',
] as const

export function resultToCsv(result: CompareResult): string {
  const real = isRealResult(result)
  const rows = result.rows.map((row) => {
    const resolved = result.resolvedHardware.find((item) => item.isa === row.isa)
    const profile = resolved?.profile
    const e = real ? row.executed : undefined
    const counted = (value: number | undefined): number | '' => (e ? value ?? '' : '')
    return [
      'flattened-summary-only-json-is-canonical',
      EXPORT_DISCLAIMER,
      real ? 'real-isa' : 'model-lowering',
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
      result.execution?.timingModelVersion ?? '',
      result.contract.frontendVersion,
      result.contract.backendVersion,
      result.contract.profileVersion,
      profile?.id ?? row.hardwareId,
      profile ? fingerprint(profile) : '',
      row.result,
      row.matchedGold,
      row.matchedGold,
      real ? row.instructions : '',
      counted(e?.instructionBytes),
      counted(e?.memoryInstructions),
      counted(e?.loads),
      counted(e?.stores),
      counted(e?.conditionalBranches),
      counted(e?.takenConditionalBranches),
      counted(e?.calls),
      counted(e?.returns),
      counted(e?.codeFootprintBytes),
      counted(e?.platformTraps),
      real ? '' : row.completedOperations,
      real ? '' : row.codeBytes,
      real ? '' : row.spillSlots,
      row.cycles,
      row.clockMhz,
      row.timeUs,
      real ? row.modelCyclesPerAggregateOp : '',
      real ? '' : row.modelCyclesPerAggregateOp,
      row.mispredicts,
      row.icMisses,
      row.dcMisses,
      row.dramRequests,
      row.stdout ?? result.stdout,
    ]
  })
  return [CSV_HEADERS, ...rows].map((line) => line.map(csvEscape).join(',')).join('\r\n')
}
