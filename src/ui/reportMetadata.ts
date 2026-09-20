import type { CompareResult } from '../engine/compare.ts'

export function reportParameterLabels(result: CompareResult): string[] {
  const workload = result.workload
  if (!workload) return ['LEGACY ARCHIVE · PARAMETERS UNVERSIONED']
  const labels: string[] = []
  if (workload.kind === 'builtin-ir') {
    labels.push(`EFFECTIVE N ${workload.effectiveN}`)
    if (workload.requestedN !== workload.effectiveN) {
      labels.push(`CLAMPED FROM ${workload.requestedN}`)
    }
    if (workload.seedUsed) labels.push(`SEED ${workload.effectiveSeed}`)
  } else if ((workload.kind === 'custom-c' || workload.kind === 'custom-ir') && workload.nRole === 'worker-cap') {
    const active = result.rows.length ? Math.max(...result.rows.map((row) => row.activeThreads)) : 0
    labels.push(`WORKER CAP ${workload.requestedWorkerCap}`)
    labels.push(`EFFECTIVE ACTIVE WORKERS ${active}`)
  }
  return labels
}

export function reportContractLabels(result: CompareResult): string[] {
  if (!result.contract) return ['LEGACY V1 · NON-RERUNNABLE · UNVERSIONED CONTRACT']
  return [
    `CONTRACT ${result.contract.schemaVersion}`,
    `MODEL ${result.contract.modelVersion}`,
    `BACKEND ${result.contract.backendVersion}`,
    `PROFILE ${result.contract.profileVersion}`,
    `ENERGY ${result.contract.energyVersion}`,
    result.hardwareMode === 'same'
      ? 'COMPARISON CONTROLLED · SHARED MODEL PROFILE'
      : 'COMPARISON ILLUSTRATIVE · NAMED PARAMETER PRESETS',
  ]
}
