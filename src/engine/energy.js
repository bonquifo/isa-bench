import { isaTiming } from './hardware.ts';
import {} from './types.ts';
export const ENERGY_MODEL_CLASS = 'uncalibrated-event-model';
export const ENERGY_UNCERTAINTY = 'not-quantified';
/**
 * Versioned nominal event coefficients in nJ/event. They are deterministic
 * comparison weights, not measurements or a physical calibration.
 */
export const NOMINAL_ENERGY_COEFFICIENTS = Object.freeze({
    operationNj: Object.freeze({
        alu: 0.8, mul: 3.2, div: 8.5, ld: 2.4, st: 2.6,
        br: 1.6, fp: 4.1, mov: 0.5, nop: 0.2,
    }),
    originNj: Object.freeze({
        semantic: 0,
        lowering: 0.1,
        runtime: 0.2,
    }),
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
});
export function energyOf(args) {
    const t = isaTiming(args.isa);
    const c = NOMINAL_ENERGY_COEFFICIENTS;
    let operation = 0;
    for (const cls of Object.keys(c.operationNj)) {
        operation += args.mix[cls] * c.operationNj[cls];
    }
    if (args.operationOrigins) {
        for (const origin of Object.keys(c.originNj)) {
            operation += args.operationOrigins[origin] * c.originNj[origin];
        }
    }
    const operationDecodeEnergyNj = (operation + (args.decodedBytes ?? 0) * c.decodedByteNj) * t.decodeEnergy;
    const cacheEnergyNj = ((args.icLineAccesses ?? 0) + (args.dcLineAccesses ?? 0)) * c.l1LineAccessNj +
        ((args.l2Hits ?? 0) + (args.l2Misses ?? 0)) * c.l2LineAccessNj +
        ((args.l3Hits ?? 0) + (args.l3Misses ?? 0)) * c.l3LineAccessNj;
    const memoryCoherenceEnergyNj = (args.dramRequests ?? 0) * c.dramRequestNj +
        (args.coherenceTransfers ?? 0) * c.coherenceTransferNj +
        (args.coherenceInvalidations ?? 0) * c.coherenceInvalidationNj;
    const recoveryEnergyNj = args.mispredicts * c.branchRecoveryNj;
    const hasResidency = args.clockMhz !== undefined &&
        args.activeCoreCycles !== undefined &&
        args.stalledCoreCycles !== undefined &&
        args.idleCoreCycles !== undefined;
    // cycle / MHz = µs, and mW × µs = nJ exactly.
    const staticEnergyNj = hasResidency
        ? args.staticPowerMw * (args.activeCoreCycles +
            c.stalledPowerFraction * args.stalledCoreCycles +
            c.idlePowerFraction * args.idleCoreCycles) / args.clockMhz
        : args.staticPowerMw * args.timeUs;
    const dynamicEnergyNj = operationDecodeEnergyNj + cacheEnergyNj + memoryCoherenceEnergyNj + recoveryEnergyNj;
    const nominalModelEnergyNj = dynamicEnergyNj + staticEnergyNj;
    const modeledEdpNjUs = nominalModelEnergyNj * args.timeUs;
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
    };
}
//# sourceMappingURL=energy.js.map