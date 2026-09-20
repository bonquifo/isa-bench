import { isSafePowerOfTwo } from './bits.ts';
import { MAX_CACHE_LINES, MAX_CACHE_LINE_BYTES, MAX_CACHE_SIZE_BYTES, MAX_CACHE_WAYS, MAX_TOTAL_CACHE_LINES, } from './cache.ts';
import { IsaId as Isa } from './types.ts';
const MAX_PROFILE_CORES = 256;
const MAX_PROFILE_THREADS = 512;
const cache = (sizeBytes, ways, lineBytes = 64) => ({
    sizeBytes,
    ways,
    lineBytes,
});
export function chipDefaults(cores, threads) {
    const c = Math.max(1, cores);
    const t = Math.max(c, threads);
    return {
        cores: c,
        threads: t,
        l2: cache(262144, 8),
        l3: cache(Math.min(134217728, Math.max(2 * 1048576, c * 2 * 1048576)), 16),
        l2Latency: 12,
        l3Latency: 40,
        memChannels: c >= 16 ? 8 : c >= 6 ? 4 : 2,
        dramIssueInterval: 1,
        coherenceLatency: 8,
    };
}
export function normalizeHw(hw) {
    const positiveInteger = (name, value) => {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`${name} must be a positive integer (got ${value})`);
        }
    };
    const nonnegativeInteger = (name, value) => {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`${name} must be a non-negative integer (got ${value})`);
        }
    };
    if (!Number.isFinite(hw.clockMhz) || hw.clockMhz <= 0) {
        throw new Error(`Clock MHz must be finite and positive (got ${hw.clockMhz})`);
    }
    for (const [name, value] of [
        ['Fetch width', hw.fetchWidth],
        ['Issue width', hw.issueWidth],
        ['Pipeline stages', hw.pipelineStages],
        ['ALU count', hw.aluCount],
        ['Memory ports', hw.memPorts],
        ['Predictor entries', hw.predEntries],
        ['Complex decode bytes', hw.complexDecodeBytes],
        ['Cores', hw.cores],
        ['Threads', hw.threads],
        ['Memory channels', hw.memChannels],
        ['DRAM issue interval', hw.dramIssueInterval],
        ['Multiply latency', hw.mulLatency],
        ['Divide latency', hw.divLatency],
        ['FP add latency', hw.fpAddLatency],
        ['FP multiply latency', hw.fpMulLatency],
        ['FP divide latency', hw.fpDivLatency],
        ['Load latency', hw.loadLatency],
    ])
        positiveInteger(name, value);
    if (hw.threads < hw.cores) {
        throw new Error(`Hardware threads must be greater than or equal to cores (got ${hw.threads} < ${hw.cores})`);
    }
    if (hw.cores > MAX_PROFILE_CORES || hw.threads > MAX_PROFILE_THREADS) {
        throw new Error(`Topology exceeds ${MAX_PROFILE_CORES} cores or ${MAX_PROFILE_THREADS} hardware threads`);
    }
    if (!isSafePowerOfTwo(hw.predEntries) || hw.predEntries > 1024 * 1024) {
        throw new Error(`Predictor entries must be a safe power of two no greater than 1048576 (got ${hw.predEntries})`);
    }
    for (const [name, value] of [
        ['Memory latency', hw.memLatency],
        ['Mispredict penalty', hw.mispredictPenalty],
        ['Indirect call penalty', hw.indirectCallPenalty],
        ['RAS depth', hw.rasDepth],
        ['L2 latency', hw.l2Latency],
        ['L3 latency', hw.l3Latency],
        ['Coherence latency', hw.coherenceLatency],
    ])
        nonnegativeInteger(name, value);
    if (!Number.isFinite(hw.staticPowerMw) || hw.staticPowerMw < 0) {
        throw new Error(`Static power must be finite and non-negative (got ${hw.staticPowerMw})`);
    }
    if (!['none', 'static', 'bimodal', 'gshare'].includes(hw.predictor)) {
        throw new Error(`Unknown branch predictor ${String(hw.predictor)}`);
    }
    if (typeof hw.forwarding !== 'boolean')
        throw new Error('Forwarding must be boolean');
    const caches = [
        ['L1I', hw.l1i],
        ['L1D', hw.l1d],
        ['L2', hw.l2],
        ['L3', hw.l3],
    ];
    for (const [name, cfg] of caches) {
        nonnegativeInteger(`${name} size`, cfg.sizeBytes);
        positiveInteger(`${name} ways`, cfg.ways);
        positiveInteger(`${name} line bytes`, cfg.lineBytes);
        if (!isSafePowerOfTwo(cfg.lineBytes)) {
            throw new Error(`${name} line bytes must be a safe power of two (got ${cfg.lineBytes})`);
        }
        if (cfg.sizeBytes > MAX_CACHE_SIZE_BYTES) {
            throw new Error(`${name} capacity exceeds ${MAX_CACHE_SIZE_BYTES} bytes`);
        }
        if (cfg.lineBytes > MAX_CACHE_LINE_BYTES) {
            throw new Error(`${name} line size exceeds ${MAX_CACHE_LINE_BYTES} bytes`);
        }
        if (cfg.ways > MAX_CACHE_WAYS) {
            throw new Error(`${name} associativity exceeds ${MAX_CACHE_WAYS} ways`);
        }
        const setBytes = cfg.lineBytes * cfg.ways;
        if (!Number.isSafeInteger(setBytes))
            throw new Error(`${name} geometry exceeds safe integer range`);
        if (cfg.sizeBytes > 0 && cfg.sizeBytes % setBytes !== 0) {
            throw new Error(`${name} size must be a multiple of line bytes × ways`);
        }
        if (cfg.sizeBytes / cfg.lineBytes > MAX_CACHE_LINES) {
            throw new Error(`${name} geometry exceeds ${MAX_CACHE_LINES} cache lines`);
        }
    }
    const lineSizes = new Set(caches.map(([, cfg]) => cfg.lineBytes));
    if (lineSizes.size > 1) {
        throw new Error('All configured cache levels must use one canonical line size');
    }
    const privateLines = (hw.l1i.sizeBytes + hw.l1d.sizeBytes + hw.l2.sizeBytes) / hw.l1d.lineBytes;
    const totalLines = privateLines * hw.cores + hw.l3.sizeBytes / hw.l3.lineBytes;
    if (!Number.isSafeInteger(totalLines) || totalLines > MAX_TOTAL_CACHE_LINES) {
        throw new Error(`Aggregate cache geometry exceeds ${MAX_TOTAL_CACHE_LINES} modeled lines`);
    }
    const chip = chipDefaults(hw.cores, hw.threads);
    const normalized = {
        ...chip,
        ...hw,
        l2: hw.l2 ?? chip.l2,
        l3: hw.l3 ?? chip.l3,
        l2Latency: hw.l2Latency ?? chip.l2Latency,
        l3Latency: hw.l3Latency ?? chip.l3Latency,
        memChannels: hw.memChannels ?? chip.memChannels,
        dramIssueInterval: hw.dramIssueInterval ?? chip.dramIssueInterval,
        coherenceLatency: hw.coherenceLatency ?? chip.coherenceLatency,
    };
    return normalized;
}
/** Validates a complete replay/profile snapshot before it can drive the model. */
export function validateHardwareProfile(hw) {
    const normalized = hw;
    const numeric = [
        'clockMhz', 'fetchWidth', 'issueWidth', 'pipelineStages', 'aluCount', 'memPorts',
        'memLatency', 'predEntries', 'mispredictPenalty', 'indirectCallPenalty', 'rasDepth',
        'mulLatency', 'divLatency', 'fpAddLatency', 'fpMulLatency', 'fpDivLatency',
        'loadLatency', 'complexDecodeBytes', 'staticPowerMw', 'cores', 'threads',
        'l2Latency', 'l3Latency', 'memChannels', 'dramIssueInterval', 'coherenceLatency',
    ];
    const caches = [normalized.l1i, normalized.l1d, normalized.l2, normalized.l3];
    if (!normalized.id ||
        typeof normalized.name !== 'string' ||
        typeof normalized.blurb !== 'string' ||
        typeof normalized.forwarding !== 'boolean' ||
        !['none', 'static', 'bimodal', 'gshare'].includes(normalized.predictor) ||
        numeric.some((key) => typeof normalized[key] !== 'number' || !Number.isFinite(normalized[key])) ||
        caches.some((cacheConfig) => !cacheConfig ||
            !Number.isFinite(cacheConfig.sizeBytes) || cacheConfig.sizeBytes < 0 ||
            !Number.isFinite(cacheConfig.lineBytes) || cacheConfig.lineBytes <= 0 ||
            !Number.isFinite(cacheConfig.ways) || cacheConfig.ways <= 0)) {
        throw new Error('Hardware profile snapshot is incomplete or contains invalid values');
    }
    return normalizeHw(normalized);
}
const COMMON = {
    forwarding: true,
    mulLatency: 3,
    divLatency: 12,
    fpAddLatency: 3,
    fpMulLatency: 4,
    fpDivLatency: 12,
    loadLatency: 2,
    complexDecodeBytes: 8,
    indirectCallPenalty: 3,
    rasDepth: 16,
};
export const HARDWARE_PROFILES = [
    {
        id: 'equal-inorder',
        name: 'Equal in-order',
        blurb: 'Controlled 5-stage scalar profile, 1 thread. Shared model budget for every target.',
        clockMhz: 2000,
        fetchWidth: 16,
        issueWidth: 1,
        pipelineStages: 5,
        aluCount: 1,
        memPorts: 1,
        l1i: cache(32768, 4),
        l1d: cache(32768, 4),
        memLatency: 80,
        predictor: 'gshare',
        predEntries: 256,
        mispredictPenalty: 7,
        staticPowerMw: 350,
        ...COMMON,
        ...chipDefaults(1, 1),
    },
    {
        id: 'dual-issue',
        name: 'Equal dual-issue',
        blurb: 'Fair 2-wide in-order machine, 1 thread, two ALUs.',
        clockMhz: 2200,
        fetchWidth: 16,
        issueWidth: 2,
        pipelineStages: 8,
        aluCount: 2,
        memPorts: 1,
        l1i: cache(32768, 4),
        l1d: cache(32768, 4),
        memLatency: 80,
        predictor: 'gshare',
        predEntries: 1024,
        mispredictPenalty: 10,
        staticPowerMw: 620,
        ...COMMON,
        ...chipDefaults(1, 1),
    },
    {
        id: 'wide',
        name: 'Equal 4-wide',
        blurb: 'Fair aggressive 4-wide core, 1 thread.',
        clockMhz: 3200,
        fetchWidth: 32,
        issueWidth: 4,
        pipelineStages: 14,
        aluCount: 3,
        memPorts: 2,
        l1i: cache(65536, 8),
        l1d: cache(65536, 8),
        memLatency: 100,
        predictor: 'gshare',
        predEntries: 4096,
        mispredictPenalty: 14,
        staticPowerMw: 1800,
        ...COMMON,
        ...chipDefaults(1, 1),
    },
    {
        id: 'equal-quad',
        name: 'Equal 4-core',
        blurb: 'Fair quad-core, 1 thread each. SPMD workloads split across cores.',
        clockMhz: 2400,
        fetchWidth: 16,
        issueWidth: 2,
        pipelineStages: 8,
        aluCount: 2,
        memPorts: 1,
        l1i: cache(32768, 4),
        l1d: cache(32768, 4),
        memLatency: 80,
        predictor: 'gshare',
        predEntries: 1024,
        mispredictPenalty: 10,
        staticPowerMw: 500,
        ...COMMON,
        ...chipDefaults(4, 4),
    },
    {
        id: 'equal-smt',
        name: 'Equal 4-core SMT2',
        blurb: 'Fair quad-core with 2-way SMT. Sibling threads share issue, ports, and L1.',
        clockMhz: 2400,
        fetchWidth: 16,
        issueWidth: 2,
        pipelineStages: 8,
        aluCount: 2,
        memPorts: 1,
        l1i: cache(32768, 4),
        l1d: cache(32768, 4),
        memLatency: 80,
        predictor: 'gshare',
        predEntries: 1024,
        mispredictPenalty: 10,
        staticPowerMw: 520,
        ...COMMON,
        ...chipDefaults(4, 8),
    },
    {
        id: 'embedded',
        name: 'Equal embedded',
        blurb: 'Fair small MCU-class core: tiny caches, low clock, static predictor.',
        clockMhz: 400,
        fetchWidth: 8,
        issueWidth: 1,
        pipelineStages: 3,
        aluCount: 1,
        memPorts: 1,
        l1i: cache(8192, 2),
        l1d: cache(8192, 2),
        memLatency: 12,
        predictor: 'static',
        predEntries: 64,
        forwarding: true,
        mispredictPenalty: 2,
        indirectCallPenalty: 3,
        rasDepth: 8,
        mulLatency: 4,
        divLatency: 18,
        fpAddLatency: 5,
        fpMulLatency: 6,
        fpDivLatency: 18,
        loadLatency: 2,
        complexDecodeBytes: 6,
        staticPowerMw: 18,
        ...chipDefaults(1, 1),
        l2: cache(0, 1),
        l3: cache(0, 1),
    },
];
export const DEFAULT_PROFILE_ID = 'equal-inorder';
export function profileById(id) {
    const found = HARDWARE_PROFILES.find((p) => p.id === id);
    if (!found)
        throw new Error(`Unknown hardware profile "${id}"`);
    return normalizeHw(found);
}
export function isaTiming(isa) {
    switch (isa) {
        case Isa.RISCV:
            return { decodeOverhead: 0, loadDelay: 0, branchDelay: 0, decodeEnergy: 1.0 };
        case Isa.ARM:
            return { decodeOverhead: 0, loadDelay: 0, branchDelay: 0, decodeEnergy: 1.05 };
        case Isa.X86:
            return { decodeOverhead: 1, loadDelay: 0, branchDelay: 0, decodeEnergy: 1.55 };
        case Isa.MIPS:
            return { decodeOverhead: 0, loadDelay: 1, branchDelay: 0, decodeEnergy: 1.0 };
        case Isa.POWER:
            return { decodeOverhead: 0, loadDelay: 0, branchDelay: 0, decodeEnergy: 1.08 };
        case Isa.SPARC:
            return { decodeOverhead: 0, loadDelay: 0, branchDelay: 1, decodeEnergy: 1.0 };
        case Isa.WASM:
            return { decodeOverhead: 0, loadDelay: 0, branchDelay: 0, decodeEnergy: 1.12 };
        case Isa.MOS:
            return { decodeOverhead: 0, loadDelay: 0, branchDelay: 0, decodeEnergy: 0.72 };
    }
}
export function overlayCustom(base, patch) {
    return normalizeHw({
        ...base,
        ...patch,
        l1i: { ...base.l1i, ...(patch.l1i ?? {}) },
        l1d: { ...base.l1d, ...(patch.l1d ?? {}) },
        l2: { ...base.l2, ...(patch.l2 ?? {}) },
        l3: { ...base.l3, ...(patch.l3 ?? {}) },
        id: 'custom',
        name: patch.name ?? 'Custom',
        blurb: patch.blurb ?? 'User-tuned microarchitecture.',
    });
}
//# sourceMappingURL=hardware.js.map