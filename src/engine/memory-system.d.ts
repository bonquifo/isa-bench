import type { HardwareProfile } from './types.ts';
export type MemoryRequestKind = 'instruction-fetch' | 'speculative-load' | 'committed-store';
export interface MemoryRequest {
    id: number;
    kind: MemoryRequestKind;
    core: number;
    address: number;
    width: number;
    issuedCycle: number;
    readyCycle: number;
    speculative: boolean;
}
export interface MemoryCompletion extends MemoryRequest {
    wrongPath: boolean;
    installedFills: number;
}
export interface MemorySystemStats {
    requests: number;
    completions: number;
    releases: number;
    retainedRequests: number;
    pendingRequests: number;
    pendingLines: number;
    instructionFetches: number;
    speculativeLoads: number;
    committedStores: number;
    coalescedLineRequests: number;
    ownedFills: number;
    installedFills: number;
    wrongPathFills: number;
    wrongPathBytes: number;
    icLineAccesses: number;
    dcLineAccesses: number;
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
}
/** Deterministic request-ID cache/coherence/DRAM service. */
export declare class MemorySystem {
    private readonly hw;
    readonly memory: ArrayBuffer;
    private readonly icaches;
    private readonly dcaches;
    private readonly l2;
    private readonly l3;
    private readonly dram;
    private readonly pendingLines;
    private readonly requestsById;
    private readonly pendingRequestIds;
    private readonly directory;
    private nextId;
    private readonly counters;
    constructor(hw: HardwareProfile, memory: ArrayBuffer);
    instructionFetch(core: number, address: number, width: number, cycle: number): MemoryRequest;
    speculativeLoad(core: number, address: number, width: number, cycle: number): MemoryRequest;
    committedStore(core: number, address: number, width: number, cycle: number): MemoryRequest;
    markWrongPath(id: number): void;
    releaseRequest(id: number): void;
    isComplete(id: number): boolean;
    outstandingRequests(): number;
    complete(cycle: number): MemoryCompletion[];
    invalidate(core: number, address: number): boolean;
    readBytes(address: number, width: number): Uint8Array;
    readInt8(address: number): number;
    readInt32(address: number): number;
    readFloat64(address: number): number;
    writeBytes(address: number, bytes: Uint8Array): void;
    stats(): MemorySystemStats;
    assertConservation(): void;
    assertDrained(): void;
    private request;
    private requestLine;
    private makeFill;
    private countWrongPath;
    private installFill;
    private onEviction;
    private hasDataResidency;
    private sanitizeDirectory;
    private removeDirectoryResidency;
}
//# sourceMappingURL=memory-system.d.ts.map