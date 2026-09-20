import type { InstClass, IsaId, MachInst, OperationOrigin } from './types.ts';
export declare const OOO_MODEL_VERSION = "ooo-1.2.0";
export declare const OOO_ENERGY_MODEL_VERSION = "ooo-energy-1.2.0-uncalibrated";
export interface DecodedOp {
    readonly pc: number;
    readonly address: number;
    readonly op: MachInst;
    readonly srcRegs: readonly number[];
    readonly dstReg: number;
    readonly resourceReads: readonly string[];
    readonly resourceWrites: readonly string[];
    readonly uops: number;
    readonly bytes: number;
    readonly fuClass: InstClass;
}
export interface FuProfile {
    count: number;
    latency: number;
    initiationInterval: number;
}
export interface OoOProfile {
    id: string;
    name: string;
    modelVersion: typeof OOO_MODEL_VERSION;
    fetchWidth: number;
    decodeWidth: number;
    renameWidth: number;
    dispatchWidth: number;
    issueWidth: number;
    retireWidth: number;
    robEntries: number;
    physicalRegisters: number;
    rsEntries: Record<InstClass, number>;
    loadQueueEntries: number;
    storeQueueEntries: number;
    storeBufferEntries: number;
    checkpoints: number;
    recoveryCycles: number;
    speculateConditionalBranches: boolean;
    fu: Record<InstClass, FuProfile>;
}
export interface OccupancyMetric {
    area: number;
    peak: number;
    fullCycles: number;
}
export interface OoOCounters {
    fetchedOps: number;
    fetchedUops: number;
    decodedOps: number;
    decodedUops: number;
    renamedOps: number;
    renamedUops: number;
    dispatchedOps: number;
    dispatchedUops: number;
    issuedOps: number;
    issuedUops: number;
    completedOps: number;
    completedUops: number;
    retiredOps: number;
    retiredUops: number;
    squashedOps: number;
    squashedUops: number;
    frontendFlushedOps: number;
    frontendFlushedUops: number;
    wrongPathOps: number;
    wrongPathBytes: number;
    branchPredictions: number;
    branchMispredicts: number;
    branchRecoveryCycles: number;
    branchSquashedOps: number;
    rasHits: number;
    rasMisses: number;
    forwardedLoads: number;
    nonaliasBypasses: number;
    unknownStoreStalls: number;
    overlapStalls: number;
    partialForwardedLoads: number;
    forwardedBytes: number;
    storeAddressIssues: number;
    freeListStallCycles: number;
    checkpointStallCycles: number;
    indirectRecoveryCycles: number;
    retireSlots: number;
    activeCoreCycles: number;
    stalledCoreCycles: number;
    idleCoreCycles: number;
    headBlock: Record<'not-complete' | 'store-buffer' | 'barrier', number>;
    operationOrigins: Record<OperationOrigin, number>;
}
export interface OoOTargetMetrics {
    isa: IsaId;
    hardwareId: string;
    hardwareName: string;
    profileId: string;
    modelVersion: typeof OOO_MODEL_VERSION;
    energyModelVersion: typeof OOO_ENERGY_MODEL_VERSION;
    energyModelClass: 'uncalibrated-ooo-event-model';
    result: number;
    stdout: string;
    matchedGold: boolean;
    cycles: number;
    ipc: number;
    retiredOps: number;
    retiredUops: number;
    codeBytes: number;
    counts: OoOCounters;
    occupancy: {
        rob: OccupancyMetric;
        rs: OccupancyMetric;
        prf: OccupancyMetric;
        lq: OccupancyMetric;
        sq: OccupancyMetric;
        storeBuffer: OccupancyMetric;
    };
    fuBusyCycles: Record<InstClass, number>;
    fuUtilization: Record<InstClass, number>;
    memory: {
        requests: number;
        completions: number;
        releases: number;
        retainedRequests: number;
        pendingRequests: number;
        pendingLines: number;
        icHits: number;
        icMisses: number;
        dcHits: number;
        dcMisses: number;
        l2Hits: number;
        l2Misses: number;
        l3Hits: number;
        l3Misses: number;
        dramRequests: number;
        dramQueueCycles: number;
        coherenceTransfers: number;
        coherenceInvalidations: number;
        speculativeLoads: number;
        committedStores: number;
        wrongPathFills: number;
        wrongPathFillBytes: number;
        ownedFills: number;
        installedFills: number;
        coalescedLineRequests: number;
    };
    dynamicEnergyNj: number;
    staticEnergyNj: number;
    totalEnergyNj: number;
    disasm: string[];
}
export declare const DEFAULT_OOO_PROFILE: OoOProfile;
export declare const WIDTH_ONE_OOO_PROFILE: OoOProfile;
export declare function validateOoOProfile(profile: OoOProfile): OoOProfile;
export declare function decodeProgram(insts: readonly MachInst[]): DecodedOp[];
//# sourceMappingURL=ooo-types.d.ts.map