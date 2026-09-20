import type { CacheConfig } from './types.ts';
export declare const MAX_CACHE_SIZE_BYTES: number;
export declare const MAX_CACHE_LINES: number;
export declare const MAX_TOTAL_CACHE_LINES: number;
export declare const MAX_CACHE_LINE_BYTES: number;
export declare const MAX_CACHE_WAYS = 4096;
/** Deterministic line-request scheduler; it is intentionally not calibrated hardware. */
export declare class DramScheduler {
    private readonly available;
    readonly issueInterval: number;
    constructor(channels: number, issueInterval: number);
    request(cycle: number, latency: number): {
        channel: number;
        start: number;
        ready: number;
        queueCycles: number;
    };
}
export declare class SetCache {
    readonly sets: number;
    readonly ways: number;
    readonly lineBytes: number;
    readonly lineMask: number;
    readonly indexBits: number;
    private readonly data;
    private stamp;
    hits: number;
    misses: number;
    constructor(cfg: CacheConfig);
    lineAddress(addr: number): number;
    lineAddresses(address: number, width: number): number[];
    lookup(addr: number): boolean;
    /** Non-mutating, non-accounting residency check used for retry validation. */
    has(addr: number): boolean;
    /** Installs a line and returns the evicted line address, if any. */
    fill(addr: number): number | null;
    invalidate(addr: number): boolean;
    /** Compatibility helper: lookup and immediately install a missed line. */
    probe(addr: number): boolean;
    resetStats(): void;
}
//# sourceMappingURL=cache.d.ts.map