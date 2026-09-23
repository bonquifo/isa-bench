import { isaTiming } from './hardware.ts'
import {
  type InstClass,
  type IsaId,
  type OperationOrigin,
} from './types.ts'

export const ENERGY_MODEL_CLASS = 'uncalibrated-event-model' as const
export const ENERGY_UNCERTAINTY = 'not-quantified' as const

/**
 * Versioned nominal event coefficients in nJ/event. They are deterministic
 * comparison weights, not measurements or a physical calibration.
 */
export const NOMINAL_ENERGY_COEFFICIENTS = Object.freeze({
  operationNj: Object.freeze({
    alu: 0.8, mul: 3.2, div: 8.5, ld: 2.4, st: 2.6,
    br: 1.6, fp: 4.1, mov: 0.5, nop: 0.2,
  } satisfies Record<InstClass, number>),
  originNj: Object.freeze({
    semantic: 0,
    lowering: 0.1,
    runtime: 0.2,
  } satisfies Record<OperationOrigin, number>),
  decodedByteNj: 0.04,
  l1LineAccessNj: 0.08,
  l2LineAccessNj: 0.35,
  l3LineAccessNj: 1.4,
  dramRequestNj: 180,
  coherenceTransferNj: 8,
  coherenceInvalidationNj: 2,
  branchRecoveryNj: 22,
  stalledPowerFraction: 0.65,
  idlePowerFraction: 0.4,
})

export interface EnergyBreakdown {
  operationDecodeEnergyNj: number
  cacheEnergyNj: number
  memoryCoherenceEnergyNj: number
  recoveryEnergyNj: number
  staticEnergyNj: number
  nominalModelEnergyNj: number
  modeledEdpNjUs: number
  energyModelClass: typeof ENERGY_MODEL_CLASS
  energyUncertainty: typeof ENERGY_UNCERTAINTY
  /** Compatibility aliases. */
  dynamicEnergyNj: number
  totalEnergyNj: number
  edp: number
}

export function energyOf(args: {
  isa: IsaId
  /**
   * Overrides the ISA's nominal decode-energy weight. The lowering's
   * weights stand in for decoders its invented streams do not have; the
   * real-ISA path passes 1, so no target is weighted by a number nobody
   * measured.
   */
  decodeEnergyScale?: number
  mix: Record<InstClass, number>
  operationOrigins?: Record<OperationOrigin, number>
  decodedBytes?: number
  icLineAccesses?: number
  dcLineAccesses?: number
  l2Hits?: number
  l2Misses?: number
  l3Hits?: number
  l3Misses?: number
  dramRequests?: number
  coherenceTransfers?: number
  coherenceInvalidations?: number
  mispredicts: number
  timeUs: number
  activeCoreCycles?: number
  stalledCoreCycles?: number
  idleCoreCycles?: number
  clockMhz?: number
  /** Nominal leakage/static power in mW for one modeled physical core. */
  staticPowerMw: number
  // Accepted legacy inputs; neither contributes to this model.
  instructions?: number
  icMisses?: number
  dcMisses?: number
  codeBytes?: number
}): EnergyBreakdown {
  const decodeScale = args.decodeEnergyScale ?? isaTiming(args.isa).decodeEnergy
  const c = NOMINAL_ENERGY_COEFFICIENTS
  let operation = 0
  for (const cls of Object.keys(c.operationNj) as InstClass[]) {
    operation += args.mix[cls] * c.operationNj[cls]
  }
  if (args.operationOrigins) {
    for (const origin of Object.keys(c.originNj) as OperationOrigin[]) {
      operation += args.operationOrigins[origin] * c.originNj[origin]
    }
  }
  const operationDecodeEnergyNj =
    (operation + (args.decodedBytes ?? 0) * c.decodedByteNj) * decodeScale
  const cacheEnergyNj =
    ((args.icLineAccesses ?? 0) + (args.dcLineAccesses ?? 0)) * c.l1LineAccessNj +
    ((args.l2Hits ?? 0) + (args.l2Misses ?? 0)) * c.l2LineAccessNj +
    ((args.l3Hits ?? 0) + (args.l3Misses ?? 0)) * c.l3LineAccessNj
  const memoryCoherenceEnergyNj =
    (args.dramRequests ?? 0) * c.dramRequestNj +
    (args.coherenceTransfers ?? 0) * c.coherenceTransferNj +
    (args.coherenceInvalidations ?? 0) * c.coherenceInvalidationNj
  const recoveryEnergyNj = args.mispredicts * c.branchRecoveryNj
  const hasResidency = args.clockMhz !== undefined &&
    args.activeCoreCycles !== undefined &&
    args.stalledCoreCycles !== undefined &&
    args.idleCoreCycles !== undefined
  // cycle / MHz = µs, and mW × µs = nJ exactly.
  const staticEnergyNj = hasResidency
    ? args.staticPowerMw * (
      args.activeCoreCycles! +
      c.stalledPowerFraction * args.stalledCoreCycles! +
      c.idlePowerFraction * args.idleCoreCycles!
    ) / args.clockMhz!
    : args.staticPowerMw * args.timeUs
  const dynamicEnergyNj =
    operationDecodeEnergyNj + cacheEnergyNj + memoryCoherenceEnergyNj + recoveryEnergyNj
  const nominalModelEnergyNj = dynamicEnergyNj + staticEnergyNj
  const modeledEdpNjUs = nominalModelEnergyNj * args.timeUs
  return {
    operationDecodeEnergyNj,
    cacheEnergyNj,
    memoryCoherenceEnergyNj,
    recoveryEnergyNj,
    staticEnergyNj,
    nominalModelEnergyNj,
    modeledEdpNjUs,
    energyModelClass: ENERGY_MODEL_CLASS,
    energyUncertainty: ENERGY_UNCERTAINTY,
    dynamicEnergyNj,
    totalEnergyNj: nominalModelEnergyNj,
    edp: modeledEdpNjUs,
  }
}
