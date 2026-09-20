export interface EmpiricalScheduleEntry {
  phase: 'warmup' | 'measured' | 'idle'
  arm: 'A' | 'B'
  block: number
  ordinal: number
  pairId: string
}

export interface EmpiricalScheduleProtocol {
  schemaVersion: '1'
  instrumentationOverhead: { phase: 'idle'; arm: 'B'; block: -1; ordinal: -100; pairId: 'instrumentation-overhead'; count: 1 }
  pilots: { phase: 'pilot'; arm: 'A'; block: -1; ordinalStart: -1; ordinalStep: -1; pairIdPrefix: 'pilot-'; minCount: 1; maxCount: 8 }
  warmups: { phase: 'warmup'; arm: 'A'; block: -1; ordinalStart: 0; pairIdPrefix: 'warmup-'; count: number }
  pairedMeasurements: {
    phases: readonly ['measured', 'idle']
    arms: readonly ['A', 'B']
    pairIdPrefix: 'pair-'
    repetitions: number
    pairsPerBlock: 4
    blockPatterns: readonly ['ABBA', 'BAAB']
  }
}

export interface EmpiricalSignedSchedule {
  entries: EmpiricalScheduleEntry[]
  protocol: EmpiricalScheduleProtocol
}

export function buildEmpiricalSchedule(seed: string, repetitions = 32, warmups = 5): EmpiricalSignedSchedule {
  if (!seed || seed.length > 256) throw new Error('schedule seed must be nonempty and bounded')
  if (!Number.isSafeInteger(repetitions) || repetitions < 32 || repetitions > 10_000 || repetitions % 4 !== 0) {
    throw new Error('repetitions must be at least 32 and divisible by four')
  }
  if (!Number.isSafeInteger(warmups) || warmups < 0 || warmups > 1_000) throw new Error('invalid warmups')
  const protocol: EmpiricalScheduleProtocol = {
    schemaVersion: '1',
    instrumentationOverhead: { phase: 'idle', arm: 'B', block: -1, ordinal: -100, pairId: 'instrumentation-overhead', count: 1 },
    pilots: { phase: 'pilot', arm: 'A', block: -1, ordinalStart: -1, ordinalStep: -1, pairIdPrefix: 'pilot-', minCount: 1, maxCount: 8 },
    warmups: { phase: 'warmup', arm: 'A', block: -1, ordinalStart: 0, pairIdPrefix: 'warmup-', count: warmups },
    pairedMeasurements: { phases: ['measured', 'idle'], arms: ['A', 'B'], pairIdPrefix: 'pair-', repetitions, pairsPerBlock: 4, blockPatterns: ['ABBA', 'BAAB'] },
  }
  const random = xorshift(seed)
  const entries: EmpiricalScheduleEntry[] = Array.from({ length: warmups }, (_, ordinal) => ({
    phase: 'warmup', arm: 'A', block: -1, ordinal, pairId: `warmup-${ordinal}`,
  }))
  let ordinal = warmups
  for (let pair = 0; pair < repetitions;) {
    const block = Math.floor(pair / 4)
    const pattern: readonly ('A' | 'B')[] = random() < 0.5 ? ['A', 'B', 'B', 'A'] : ['B', 'A', 'A', 'B']
    for (const orientation of pattern) {
      const pairId = `pair-${pair}`
      const arms: readonly ('A' | 'B')[] = orientation === 'A' ? ['A', 'B'] : ['B', 'A']
      for (const arm of arms) entries.push({ phase: arm === 'A' ? 'measured' : 'idle', arm, block, ordinal: ordinal++, pairId })
      pair += 1
    }
  }
  return { entries, protocol }
}

function xorshift(seed: string): () => number {
  let state = 2166136261
  for (const char of seed) state = Math.imul(state ^ char.codePointAt(0)!, 16777619) >>> 0
  if (state === 0) state = 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}
