import { buildEmpiricalSchedule, type EmpiricalScheduleEntry } from '@isa-sim/contracts'

export type ScheduleEntry = EmpiricalScheduleEntry

export function selectInnerIterations(pilotDurationNs: bigint, pilotIterations: bigint): bigint {
  if (pilotDurationNs <= 0n || pilotIterations <= 0n) throw new Error('invalid pilot')
  const target = 250_000_000n
  const selected = (target * pilotIterations + pilotDurationNs - 1n) / pilotDurationNs
  return selected < 1n ? 1n : selected
}

export function buildSchedule(seed: string, repetitions = 32, warmups = 5): ScheduleEntry[] {
  return buildEmpiricalSchedule(seed, repetitions, warmups).entries
}
