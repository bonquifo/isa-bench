/**
 * The real targets for the comparison, loaded on demand.
 *
 * This module imports every target's shipped binaries, so the app reaches it
 * only through a dynamic import when a real comparison is asked for -- the
 * same reason the real lane is loaded lazily. The engine never imports it:
 * the comparison is handed this provider and asks it for bytes.
 */
import type { RealTargetProvider } from '../engine/compareReal.ts'
import { REAL_TARGETS } from './realTargets.ts'

export const shippedRealProvider: RealTargetProvider = (isa) => {
  const target = REAL_TARGETS.find((candidate) => candidate.id === isa)
  if (!target) return undefined
  return {
    isa,
    label: target.label,
    libc: target.libc,
    oracle: target.oracle,
    verified: target.verified,
    intBits: target.intBits,
    returnChannel: target.returnChannel,
    backend: target.backend,
    async binary(programId) {
      const program = target.shipped.shippedPrograms().find((item) => item.id === programId)
      return program ? target.shipped.loadShippedElf(program.url) : null
    },
  }
}
