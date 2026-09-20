import { ExternalSimulatorResultSchema } from '@isa-sim/contracts'

export type ExternalResult = ReturnType<typeof ExternalSimulatorResultSchema.parse>

export function parseExternalResult(value: unknown): ExternalResult {
  return ExternalSimulatorResultSchema.parse(value)
}

export function externalClaim(result: ExternalResult): string {
  return result.experimentKind === 'llvm-mca'
    ? 'Static scheduling-model throughput estimate; not execution timing.'
    : `${result.simulator.name} external simulation; host diagnostic duration is excluded.`
}

export function canonicalDownload(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
