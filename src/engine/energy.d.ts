import { type InstClass, type IsaId, type OperationOrigin } from './types.ts';
export declare const ENERGY_MODEL_CLASS: "uncalibrated-event-model";
export declare const ENERGY_UNCERTAINTY: "not-quantified";
/**
 * Versioned nominal event coefficients in nJ/event. They are deterministic
 * comparison weights, not measurements or a physical calibration.
 */
export declare const NOMINAL_ENERGY_COEFFICIENTS: Readonly<{
    operationNj: Readonly<{
        alu: number;
        mul: number;
        div: number;
        ld: number;
        st: number;
        br: number;
        fp: number;
        mov: number;
        nop: number;
    }>;
    originNj: Readonly<{
        semantic: number;
        lowering: number;
        runtime: number;
    }>;
    decodedByteNj: 0.04;
    l1LineAccessNj: 0.08;
    l2LineAccessNj: 0.35;
    l3LineAccessNj: 1.4;
    dramRequestNj: 180;
    coherenceTransferNj: 8;
    coherenceInvalidationNj: 2;
    branchRecoveryNj: 22;
    stalledPowerFraction: 0.65;
    idlePowerFraction: 0.4;
}>;
export interface EnergyBreakdown {
    operationDecodeEnergyNj: number;
    cacheEnergyNj: number;
    memoryCoherenceEnergyNj: number;
    recoveryEnergyNj: number;
    staticEnergyNj: number;
    nominalModelEnergyNj: number;
    modeledEdpNjUs: number;
    energyModelClass: typeof ENERGY_MODEL_CLASS;
    energyUncertainty: typeof ENERGY_UNCERTAINTY;
    /** Compatibility aliases. */
    dynamicEnergyNj: number;
    totalEnergyNj: number;
    edp: number;
}
export declare function energyOf(args: {
    isa: IsaId;
    mix: Record<InstClass, number>;
    operationOrigins?: Record<OperationOrigin, number>;
    decodedBytes?: number;
    icLineAccesses?: number;
    dcLineAccesses?: number;
    l2Hits?: number;
    l2Misses?: number;
    l3Hits?: number;
    l3Misses?: number;
    dramRequests?: number;
    coherenceTransfers?: number;
    coherenceInvalidations?: number;
    mispredicts: number;
    timeUs: number;
    activeCoreCycles?: number;
    stalledCoreCycles?: number;
    idleCoreCycles?: number;
    clockMhz?: number;
    /** Nominal leakage/static power in mW for one modeled physical core. */
    staticPowerMw: number;
    instructions?: number;
    icMisses?: number;
    dcMisses?: number;
    codeBytes?: number;
}): EnergyBreakdown;
//# sourceMappingURL=energy.d.ts.map