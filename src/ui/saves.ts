import {
  computeInputFingerprint,
  type CompareResult,
  type RerunInputSnapshot,
} from '../engine/compare.ts'
import { valuesEqual } from '../engine/bits.ts'
import { validateHardwareProfile } from '../engine/hardware.ts'
import { parseTaggedJson, stableSerialize } from '../engine/measurement.ts'
import { ALL_ISAS, type HardwareProfile, type IsaId } from '../engine/types.ts'
import type { LegacyCompareResult } from './reportLegacy.ts'

export const SAVE_KEY_V2 = 'isa-bench-saves-v2'
export const LEGACY_SAVE_KEY_V1 = 'isa-bench-saves-v1'
export const SAVE_SCHEMA_VERSION = 2

export interface SavedRun {
  schemaVersion: 2
  id: string
  name: string
  savedAt: number
  rerunnable: true
  result: CompareResult
}

export interface LegacySavedRun {
  schemaVersion: 1
  id: string
  name: string
  savedAt: number
  rerunnable: false
  result: LegacyCompareResult
}

export type StoredRun = SavedRun | LegacySavedRun

interface SaveStoreV2 {
  schemaVersion: 2
  entries: StoredRun[]
}

export interface SaveLoadResult {
  saves: StoredRun[]
  issues: string[]
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const ISA_IDS = new Set<string>(ALL_ISAS)
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const oneOf = (value: unknown, choices: readonly string[]): value is string =>
  typeof value === 'string' && choices.includes(value)
const uniqueIsaArray = (value: unknown): value is IsaId[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((isa) => typeof isa === 'string' && ISA_IDS.has(isa)) &&
  new Set(value).size === value.length

function validCache(value: unknown): boolean {
  return object(value) &&
    finite(value.sizeBytes) && value.sizeBytes >= 0 &&
    finite(value.lineBytes) && value.lineBytes > 0 &&
    finite(value.ways) && value.ways > 0
}

function validHardwareProfile(value: unknown): value is HardwareProfile {
  if (!object(value)) return false
  const numeric = [
    'clockMhz', 'fetchWidth', 'issueWidth', 'pipelineStages', 'aluCount', 'memPorts',
    'memLatency', 'predEntries', 'mispredictPenalty', 'indirectCallPenalty', 'rasDepth',
    'mulLatency', 'divLatency', 'fpAddLatency', 'fpMulLatency', 'fpDivLatency',
    'loadLatency', 'complexDecodeBytes', 'staticPowerMw', 'cores', 'threads',
    'l2Latency', 'l3Latency', 'memChannels', 'dramIssueInterval', 'coherenceLatency',
  ]
  if (
    typeof value.id !== 'string' || !value.id ||
    typeof value.name !== 'string' ||
    typeof value.blurb !== 'string' ||
    typeof value.forwarding !== 'boolean' ||
    !oneOf(value.predictor, ['none', 'static', 'bimodal', 'gshare']) ||
    !numeric.every((key) => finite(value[key])) ||
    !validCache(value.l1i) || !validCache(value.l1d) ||
    !validCache(value.l2) || !validCache(value.l3)
  ) return false
  try {
    validateHardwareProfile(value as unknown as HardwareProfile)
    return true
  } catch {
    return false
  }
}

function validMetrics(value: unknown): boolean {
  if (!object(value) || !ISA_IDS.has(String(value.isa))) return false
  if (!object(value.mix) || !object(value.operationOrigins)) return false
  const mix = value.mix
  const origins = value.operationOrigins
  const numeric = [
    'instructions', 'uops', 'cycles', 'cpi', 'ipc',
    'aggregateModeledOpsPerCycle', 'modelCyclesPerAggregateOp', 'codeBytes', 'clockMhz',
    'timeUs', 'icHits', 'icMisses', 'dcHits', 'dcMisses', 'branches', 'mispredicts',
    'stalls', 'dynamicEnergyNj', 'staticEnergyNj', 'totalEnergyNj', 'edp',
    'operationDecodeEnergyNj', 'cacheEnergyNj', 'memoryCoherenceEnergyNj',
    'recoveryEnergyNj', 'nominalModelEnergyNj', 'modeledEdpNjUs', 'spillSlots',
    'cores', 'threads', 'activeThreads', 'busyCores', 'coresThatIssued',
    'l2Hits', 'l2Misses', 'l3Hits', 'l3Misses', 'issuedOperations',
    'completedOperations', 'issuedUops', 'completedUops', 'zeroIssueCycles',
    'dependencyStallCycles', 'fetchStallCycles', 'resourceStallCycles',
    'memoryOrderStallCycles', 'serializationStallCycles', 'conditionalBranches',
    'directJumps', 'calls', 'returns', 'indirectCalls', 'rasMisses', 'fetchedBytes',
    'decodedBytes', 'icLineAccesses', 'dcLineAccesses', 'dramRequests',
    'dramQueueCycles', 'coherenceTransfers', 'coherenceInvalidations',
    'activeCoreCycles', 'stalledCoreCycles', 'idleCoreCycles', 'averageActiveCores',
    'averageStalledCores',
  ]
  return (
    typeof value.hardwareId === 'string' &&
    typeof value.hardwareName === 'string' &&
    typeof value.result === 'number' &&
    typeof value.matchedGold === 'boolean' &&
    typeof value.stdout === 'string' &&
    Array.isArray(value.disasm) &&
    value.disasm.every((line) => typeof line === 'string') &&
    oneOf(value.energyModelClass, ['uncalibrated-event-model']) &&
    oneOf(value.energyUncertainty, ['not-quantified']) &&
    numeric.every((key) => finite(value[key])) &&
    ['alu', 'mul', 'div', 'ld', 'st', 'br', 'fp', 'mov', 'nop']
      .every((key) => finite(mix[key])) &&
    ['semantic', 'lowering', 'runtime'].every((key) => finite(origins[key]))
  )
}

function validContract(value: unknown): boolean {
  return object(value) &&
    ['schemaVersion', 'modelVersion', 'frontendVersion', 'backendVersion', 'profileVersion', 'energyVersion']
      .every((key) => typeof value[key] === 'string' && value[key] !== '') &&
    value.claimScope === 'software-model-only' &&
    value.modelKind === 'deterministic-educational-model'
}

function validWorkload(value: unknown): boolean {
  return object(value) &&
    oneOf(value.kind, ['builtin-ir', 'fixed-c', 'custom-ir', 'custom-c']) &&
    oneOf(value.nRole, ['problem-size', 'worker-cap', 'unused']) &&
    oneOf(value.parallelSemantics, ['serial', 'spmd-striped', 'source-defined']) &&
    oneOf(value.referenceOracle, ['independent-host-model', 'ir-interpreter']) &&
    finite(value.requestedN) &&
    (value.effectiveN === null || finite(value.effectiveN)) &&
    finite(value.requestedSeed) &&
    (value.effectiveSeed === null || finite(value.effectiveSeed)) &&
    typeof value.seedUsed === 'boolean' &&
    (value.requestedWorkerCap === null || finite(value.requestedWorkerCap)) &&
    finite(value.maxUsefulWorkers) &&
    typeof value.hasIndependentExpectedCheck === 'boolean'
}

function validResolvedHardware(value: unknown): value is CompareResult['resolvedHardware'] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) =>
      object(item) && typeof item.isa === 'string' && ISA_IDS.has(item.isa) &&
      validHardwareProfile(item.profile)
    ) &&
    new Set(value.map((item) => item.isa)).size === value.length
}

function validResult(value: unknown, current: true): value is CompareResult
function validResult(value: unknown, current: false): value is LegacyCompareResult
function validResult(value: unknown, current: boolean): value is CompareResult | LegacyCompareResult {
  if (!object(value)) return false
  if (
    typeof value.workloadId !== 'string' ||
    typeof value.workloadName !== 'string' ||
    typeof value.hardwareMode !== 'string' ||
    !finite(value.n) ||
    !finite(value.seed) ||
    !Array.isArray(value.rows) ||
    typeof value.gold !== 'number'
  ) return false
  if (!value.rows.every((row) => object(row))) return false
  if (!current) return true
  if (value.rows.length === 0 || !value.rows.every(validMetrics)) return false
  const rerun = value.rerunInput
  const contract = value.contract
  if (!(
    (value.hardwareMode === 'same' || value.hardwareMode === 'cpus') &&
    typeof value.fp === 'boolean' &&
    typeof value.notes === 'string' &&
    finite(value.goldSteps) &&
    typeof value.stdout === 'string' &&
    (value.source === undefined || typeof value.source === 'string') &&
    validContract(contract) &&
    validWorkload(value.workload) &&
    object(rerun) &&
    typeof rerun.workloadId === 'string' &&
    typeof rerun.n === 'number' &&
    Number.isFinite(rerun.n) &&
    typeof rerun.seed === 'number' &&
    Number.isFinite(rerun.seed) &&
    uniqueIsaArray(rerun.selectedIsas) &&
    uniqueIsaArray(rerun.isas) &&
    (rerun.hardwareMode === 'same' || rerun.hardwareMode === 'cpus') &&
    typeof rerun.profileId === 'string' &&
    (rerun.customSource === undefined || typeof rerun.customSource === 'string') &&
    (rerun.effectiveSource === undefined || typeof rerun.effectiveSource === 'string') &&
    (rerun.effectiveSourceOverride === undefined || typeof rerun.effectiveSourceOverride === 'string') &&
    validResolvedHardware(value.resolvedHardware) &&
    object(rerun.resolvedProfileByIsa) &&
    typeof value.inputFingerprint === 'string'
  )) return false
  const candidate = value as unknown as CompareResult
  const selected = candidate.rerunInput.selectedIsas
  const rowIsas = candidate.rows.map((row) => row.isa)
  const profileIsas = candidate.resolvedHardware.map((item) => item.isa)
  const replayProfiles = candidate.rerunInput.resolvedProfileByIsa
  const sourceFieldsValid = candidate.workload.kind === 'builtin-ir'
    ? candidate.rerunInput.customSource === undefined &&
      candidate.rerunInput.effectiveSource === undefined &&
      candidate.rerunInput.effectiveSourceOverride === undefined
    : candidate.workload.kind === 'fixed-c'
      ? candidate.rerunInput.customSource === undefined &&
        candidate.rerunInput.effectiveSource !== undefined &&
        candidate.rerunInput.effectiveSource === candidate.rerunInput.effectiveSourceOverride &&
        candidate.source === candidate.rerunInput.effectiveSource
      : candidate.rerunInput.effectiveSourceOverride === undefined &&
        candidate.rerunInput.customSource !== undefined &&
        candidate.rerunInput.customSource === candidate.rerunInput.effectiveSource &&
        candidate.source === candidate.rerunInput.effectiveSource
  if (
    !sourceFieldsValid ||
    !valuesEqual(candidate.gold, candidate.gold, candidate.fp) ||
    candidate.rows.some((row) =>
      !row.matchedGold || !valuesEqual(row.result, candidate.gold, candidate.fp)
    ) ||
    rowIsas.length !== selected.length ||
    candidate.workloadId !== candidate.rerunInput.workloadId ||
    candidate.hardwareMode !== candidate.rerunInput.hardwareMode ||
    stableSerialize(candidate.rerunInput.isas) !== stableSerialize(selected) ||
    new Set(rowIsas).size !== rowIsas.length ||
    selected.some((isa, index) => rowIsas[index] !== isa || profileIsas[index] !== isa) ||
    Object.keys(replayProfiles).length !== selected.length ||
    selected.some((isa, index) =>
      !validHardwareProfile(replayProfiles[isa]) ||
      stableSerialize(replayProfiles[isa]) !==
        stableSerialize(candidate.resolvedHardware[index].profile)
    )
  ) return false
  return candidate.inputFingerprint === computeInputFingerprint(
    candidate.contract,
    candidate.rerunInput,
    candidate.workload,
    candidate.resolvedHardware,
  )
}

function validateEntry(value: unknown): StoredRun | null {
  if (!object(value)) return null
  const common =
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.savedAt === 'number'
  if (!common) return null
  if (
    value.schemaVersion === SAVE_SCHEMA_VERSION &&
    value.rerunnable === true &&
    validResult(value.result, true)
  ) return value as unknown as SavedRun
  if (
    value.schemaVersion === 1 &&
    value.rerunnable === false &&
    validResult(value.result, false)
  ) return value as unknown as LegacySavedRun
  return null
}

function parseEntries(raw: string, issues: string[]): StoredRun[] {
  try {
    const parsed = parseTaggedJson(raw)
    if (!object(parsed) || parsed.schemaVersion !== SAVE_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      issues.push('Saved-run store has an unsupported shape.')
      return []
    }
    return parsed.entries.flatMap((value, index) => {
      const valid = validateEntry(value)
      if (valid) return [valid]
      issues.push(`Rejected invalid saved-run entry ${index + 1}.`)
      return []
    })
  } catch {
    issues.push('Saved-run store contains invalid JSON.')
    return []
  }
}

function migrateLegacy(raw: string, issues: string[]): LegacySavedRun[] {
  try {
    const parsed = parseTaggedJson(raw)
    if (!Array.isArray(parsed)) {
      issues.push('Legacy saved-run archive has an unsupported shape.')
      return []
    }
    return parsed.flatMap((value, index) => {
      if (!object(value) || !validResult(value.result, false)) {
        issues.push(`Rejected invalid legacy saved-run entry ${index + 1}.`)
        return []
      }
      if (
        typeof value.id !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.savedAt !== 'number'
      ) {
        issues.push(`Rejected invalid legacy saved-run entry ${index + 1}.`)
        return []
      }
      const legacyMode = (value.result as unknown as { hardwareMode?: unknown }).hardwareMode
      const result: LegacyCompareResult = {
        ...value.result,
        ...(legacyMode === 'typical' ? { hardwareMode: 'cpus' } : {}),
      }
      return [{
        schemaVersion: 1 as const,
        id: value.id,
        name: value.name,
        savedAt: value.savedAt,
        rerunnable: false as const,
        result,
      }]
    })
  } catch {
    issues.push('Legacy saved-run archive contains invalid JSON.')
    return []
  }
}

export function loadSavesState(): SaveLoadResult {
  const issues: string[] = []
  try {
    if (typeof localStorage === 'undefined') return { saves: [], issues }
    const raw = localStorage.getItem(SAVE_KEY_V2)
    const current = raw ? parseEntries(raw, issues) : []
    const legacyRaw = localStorage.getItem(LEGACY_SAVE_KEY_V1)
    const legacy = legacyRaw ? migrateLegacy(legacyRaw, issues) : []
    const ids = new Set(current.map((save) => save.id))
    const migrated = legacy.filter((save) => {
      if (ids.has(save.id)) return false
      ids.add(save.id)
      return true
    })
    const saves = [...current, ...migrated]
    if (migrated.length) {
      try {
        persistSaves(saves)
      } catch (error) {
        issues.push(`Legacy archives are viewable but migration could not be stored: ${storageMessage(error)}`)
      }
    }
    return { saves, issues }
  } catch (error) {
    issues.push(`Saved runs could not be read: ${storageMessage(error)}`)
    return { saves: [], issues }
  }
}

export function loadSaves(): StoredRun[] {
  return loadSavesState().saves
}

/** Returns a defensive, complete rerun snapshot only for validated current saves. */
export function restoreInput(save: StoredRun): RerunInputSnapshot | null {
  if (!save.rerunnable) return null
  const restored = structuredClone(save.result.rerunInput)
  restored.resolvedProfileByIsa = Object.fromEntries(
    save.result.resolvedHardware.map(({ isa, profile }) => [isa, structuredClone(profile)]),
  ) as Partial<Record<IsaId, HardwareProfile>>
  return restored
}

function storageMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function persistSaves(saves: StoredRun[]): void {
  if (typeof localStorage === 'undefined') return
  const store: SaveStoreV2 = { schemaVersion: SAVE_SCHEMA_VERSION, entries: saves }
  localStorage.setItem(SAVE_KEY_V2, stableSerialize(store))
}

export function saveRun(name: string, result: CompareResult): SavedRun {
  if (!validResult(result, true)) throw new Error('Current result is incomplete and cannot be saved.')
  const entry: SavedRun = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || result.workloadName,
    savedAt: Date.now(),
    rerunnable: true,
    result,
  }
  persistSaves([entry, ...loadSaves()].slice(0, 40))
  return entry
}

export function deleteSave(id: string): StoredRun[] {
  const next = loadSaves().filter((s) => s.id !== id)
  persistSaves(next)
  return next
}
