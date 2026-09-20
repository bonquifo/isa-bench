import { ALL_ISAS, ISA_META, type IsaId } from '../engine/types.ts'
import type { CompareResult } from '../engine/compare.ts'
import { CompareResultSchema } from '../engine/compareSchema.ts'
import { fmtFixed, fmtInt, fmtNum } from './format.ts'

export interface LegacyMetric {
  isa?: unknown
  hardwareName?: unknown
  result?: unknown
  matchedGold?: unknown
  cycles?: unknown
  instructions?: unknown
  cpi?: unknown
  ipc?: unknown
  codeBytes?: unknown
  totalEnergyNj?: unknown
  activeThreads?: unknown
  threads?: unknown
  disasm?: unknown
}

export interface LegacyCompareResult {
  gold: number
  fp?: boolean
  workloadId: string
  workloadName: string
  notes?: string
  hardwareMode: string
  n: number
  seed: number
  rows: LegacyMetric[]
  stdout?: string
  source?: string
}

export type ReportableResult = CompareResult | LegacyCompareResult

export interface LegacyReportRowView {
  key: string
  target: string
  hardware: string
  fields: string[]
  trace: string[]
}

export interface LegacyReportView {
  title: string
  subtitle: string
  reference: string
  parameters: string
  stdout: string
  rows: LegacyReportRowView[]
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isaName(value: unknown): string {
  if (typeof value === 'string' && (ALL_ISAS as string[]).includes(value)) {
    return ISA_META[value as IsaId].full
  }
  return typeof value === 'string' && value.trim() ? value : 'Unknown archived target'
}

export function isCurrentCompareResult(result: ReportableResult): result is CompareResult {
  return CompareResultSchema.safeParse(result).success
}

export function buildLegacyReportView(result: LegacyCompareResult): LegacyReportView {
  return {
    title: result.workloadName || 'Legacy saved report',
    subtitle: result.notes || 'Archived legacy result; original model contract was not recorded.',
    reference: `ARCHIVED OLD-MODEL REFERENCE FIELD ${fmtNum(result.gold, result.fp === true)}`,
    parameters: `ARCHIVED OLD-MODEL INPUT FIELDS · N ${fmtInt(result.n)} · SEED ${fmtInt(result.seed)}`,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    rows: result.rows.map((row, index) => {
      const fields: string[] = []
      if (typeof row.result === 'number') {
        fields.push(`ARCHIVED OLD-MODEL RESULT FIELD ${fmtNum(row.result, result.fp === true)}`)
      }
      if (finite(row.cycles)) fields.push(`ARCHIVED OLD-MODEL CYCLES ${fmtInt(row.cycles)}`)
      if (finite(row.instructions)) {
        fields.push(`ARCHIVED OLD-MODEL INSTRUCTION FIELD ${fmtInt(row.instructions)}`)
      }
      if (finite(row.cpi)) fields.push(`ARCHIVED OLD-MODEL CPI FIELD ${fmtFixed(row.cpi, 3)}`)
      if (finite(row.ipc)) fields.push(`ARCHIVED OLD-MODEL IPC FIELD ${fmtFixed(row.ipc, 3)}`)
      if (finite(row.codeBytes)) fields.push(`ARCHIVED OLD-MODEL CODE-BYTE FIELD ${fmtInt(row.codeBytes)}`)
      if (finite(row.totalEnergyNj)) {
        fields.push(`ARCHIVED OLD-MODEL ENERGY FIELD ${fmtFixed(row.totalEnergyNj, 1)} nJ`)
      }
      if (finite(row.activeThreads) && finite(row.threads)) {
        fields.push(`ARCHIVED OLD-MODEL THREAD FIELDS ${row.activeThreads}/${row.threads}`)
      }
      if (fields.length === 0) fields.push('NO COMPATIBLE NUMERIC FIELDS IN THIS ARCHIVE')
      return {
        key: `${typeof row.isa === 'string' ? row.isa : 'unknown'}-${index}`,
        target: isaName(row.isa),
        hardware: typeof row.hardwareName === 'string' ? row.hardwareName : 'Unrecorded profile',
        fields,
        trace: Array.isArray(row.disasm)
          ? row.disasm.filter((line): line is string => typeof line === 'string')
          : [],
      }
    }),
  }
}
