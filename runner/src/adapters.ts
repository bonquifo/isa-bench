import type { EnergyReading, PerfReading } from './types.js'

export function scalePerf(name: string, raw: bigint, enabled: bigint, running: bigint, group: string): PerfReading {
  if (enabled < 0n || running < 0n || running > enabled) throw new Error('invalid perf timing')
  return {
    name, raw: raw.toString(), scaled: running === 0n ? null : ((raw * enabled) / running).toString(),
    timeEnabledNs: enabled.toString(), timeRunningNs: running.toString(), group,
  }
}

export function perfValid(readings: readonly PerfReading[], minimumRunningRatio = 0.9): boolean {
  return readings.every((reading) => {
    const enabled = BigInt(reading.timeEnabledNs)
    return enabled > 0n && Number(BigInt(reading.timeRunningNs)) / Number(enabled) >= minimumRunningRatio
  })
}

export function raplEnergy(
  beforeUj: bigint, afterUj: bigint, maxRangeUj: bigint, elapsedNs: bigint, maxPowerWatts?: number,
): EnergyReading {
  if (maxRangeUj <= 0n || beforeUj < 0n || afterUj < 0n || beforeUj >= maxRangeUj || afterUj >= maxRangeUj) {
    throw new Error('invalid RAPL sample')
  }
  let delta = afterUj - beforeUj
  let wraps = 0
  if (delta < 0n) { delta += maxRangeUj; wraps = 1 }
  if (maxPowerWatts !== undefined) {
    const possibleWraps = Math.floor(maxPowerWatts * Number(elapsedNs) / 1e9 / (Number(maxRangeUj) / 1e6))
    if (possibleWraps > wraps) throw new Error('ambiguous RAPL wrap')
  }
  return { adapter: 'rapl-powercap', supported: true, grossJoules: Number(delta) / 1e6, processEnergy: false, wrapCount: wraps }
}

export function subtractIdle(gross: EnergyReading, idleJoules: number): EnergyReading {
  if (!gross.supported || gross.grossJoules === undefined) throw new Error('gross energy unavailable')
  if (!Number.isFinite(idleJoules) || idleJoules < 0) throw new Error('invalid idle energy')
  return { ...gross, idleJoules, netJoules: gross.grossJoules - idleJoules }
}

export function inaIntegrate(
  samples: readonly { timestampNs: bigint; shuntVolts: number; busVolts: number }[],
  shuntOhms: number,
): EnergyReading {
  if (samples.length < 2 || !(shuntOhms > 0)) throw new Error('insufficient INA samples')
  let joules = 0
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1]!
    const b = samples[index]!
    const dt = Number(b.timestampNs - a.timestampNs) / 1e9
    if (!(dt > 0)) throw new Error('non-monotonic INA timestamps')
    const wattsA = a.busVolts * a.shuntVolts / shuntOhms
    const wattsB = b.busVolts * b.shuntVolts / shuntOhms
    joules += (wattsA + wattsB) * 0.5 * dt
  }
  return { adapter: 'ina', supported: true, grossJoules: joules, processEnergy: false }
}

export function mapExternalClock(
  sourceNs: bigint, offsetNs: bigint, driftPpm: number, referenceNs: bigint, uncertaintyNs: number, thresholdNs: number,
): bigint {
  if (!Number.isFinite(driftPpm) || uncertaintyNs > thresholdNs) throw new Error('external clock alignment uncertainty too high')
  const elapsed = Number(sourceNs - referenceNs)
  return sourceNs + offsetNs + BigInt(Math.round(elapsed * driftPpm / 1e6))
}

export const nullEnergy = (reason: string): EnergyReading => ({
  adapter: 'null', supported: false, processEnergy: false, reason,
})
