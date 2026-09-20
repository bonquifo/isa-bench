import { isSafePowerOfTwo } from './bits.ts';
export const MAX_CACHE_SIZE_BYTES = 256 * 1024 * 1024;
export const MAX_CACHE_LINES = 4 * 1024 * 1024;
export const MAX_TOTAL_CACHE_LINES = 8 * 1024 * 1024;
export const MAX_CACHE_LINE_BYTES = 1024 * 1024;
export const MAX_CACHE_WAYS = 4096;
/** Deterministic line-request scheduler; it is intentionally not calibrated hardware. */
export class DramScheduler {
    available;
    issueInterval;
    constructor(channels, issueInterval) {
        if (!Number.isSafeInteger(channels) || channels <= 0) {
            throw new Error(`DRAM channels must be a positive integer (got ${channels})`);
        }
        if (!Number.isSafeInteger(issueInterval) || issueInterval <= 0) {
            throw new Error(`DRAM issue interval must be a positive integer (got ${issueInterval})`);
        }
        this.issueInterval = issueInterval;
        this.available = Array.from({ length: channels }, () => 0);
    }
    request(cycle, latency) {
        let channel = 0;
        for (let i = 1; i < this.available.length; i++) {
            if (this.available[i] < this.available[channel])
                channel = i;
        }
        const start = Math.max(cycle, this.available[channel]);
        this.available[channel] = start + this.issueInterval;
        return { channel, start, ready: start + latency, queueCycles: start - cycle };
    }
}
export class SetCache {
    sets;
    ways;
    lineBytes;
    lineMask;
    indexBits;
    data;
    stamp = 1;
    hits = 0;
    misses = 0;
    constructor(cfg) {
        if (!isSafePowerOfTwo(cfg.lineBytes)) {
            throw new Error(`Cache lineBytes must be a positive safe power of two (got ${cfg.lineBytes})`);
        }
        if (!Number.isSafeInteger(cfg.ways) || cfg.ways <= 0) {
            throw new Error(`Cache ways must be a positive integer (got ${cfg.ways})`);
        }
        if (cfg.sizeBytes > MAX_CACHE_SIZE_BYTES) {
            throw new Error(`Cache capacity exceeds ${MAX_CACHE_SIZE_BYTES} bytes`);
        }
        if (cfg.lineBytes > MAX_CACHE_LINE_BYTES) {
            throw new Error(`Cache line size exceeds ${MAX_CACHE_LINE_BYTES} bytes`);
        }
        if (cfg.ways > MAX_CACHE_WAYS) {
            throw new Error(`Cache associativity exceeds ${MAX_CACHE_WAYS} ways`);
        }
        if (cfg.sizeBytes / cfg.lineBytes > MAX_CACHE_LINES) {
            throw new Error(`Cache geometry exceeds ${MAX_CACHE_LINES} lines`);
        }
        if (!Number.isSafeInteger(cfg.sizeBytes) || cfg.sizeBytes < 0 ||
            (cfg.sizeBytes > 0 && cfg.sizeBytes % (cfg.lineBytes * cfg.ways) !== 0)) {
            throw new Error(`Cache sizeBytes must be zero or a positive multiple of lineBytes × ways (got ${cfg.sizeBytes})`);
        }
        this.lineBytes = cfg.lineBytes;
        this.ways = cfg.ways;
        this.sets = cfg.sizeBytes === 0 ? 0 : cfg.sizeBytes / (cfg.lineBytes * cfg.ways);
        this.lineMask = this.lineBytes - 1;
        this.indexBits = Math.log2(this.sets);
        this.data = Array.from({ length: this.sets * this.ways }, () => ({
            tag: 0,
            valid: false,
            lru: 0,
        }));
    }
    lineAddress(addr) {
        return Math.floor(addr / this.lineBytes) * this.lineBytes;
    }
    lineAddresses(address, width) {
        if (!Number.isSafeInteger(address) || address < 0 ||
            !Number.isSafeInteger(width) || width <= 0 ||
            !Number.isSafeInteger(address + width)) {
            throw new Error(`Invalid cache byte range [${address}, ${address + width})`);
        }
        const first = this.lineAddress(address);
        const last = this.lineAddress(address + width - 1);
        const out = [];
        for (let line = first; line <= last; line += this.lineBytes)
            out.push(line);
        return out;
    }
    lookup(addr) {
        if (this.sets === 0) {
            this.misses += 1;
            return false;
        }
        const lineAddr = this.lineAddress(addr);
        const index = Math.floor(lineAddr / this.lineBytes) % this.sets;
        const tag = lineAddr;
        const base = index * this.ways;
        for (let w = 0; w < this.ways; w++) {
            const line = this.data[base + w];
            if (line.valid && line.tag === tag) {
                this.stamp += 1;
                line.lru = this.stamp;
                this.hits += 1;
                return true;
            }
        }
        this.misses += 1;
        return false;
    }
    /** Non-mutating, non-accounting residency check used for retry validation. */
    has(addr) {
        if (this.sets === 0)
            return false;
        const lineAddr = this.lineAddress(addr);
        const index = Math.floor(lineAddr / this.lineBytes) % this.sets;
        const base = index * this.ways;
        for (let w = 0; w < this.ways; w++) {
            const line = this.data[base + w];
            if (line.valid && line.tag === lineAddr)
                return true;
        }
        return false;
    }
    /** Installs a line and returns the evicted line address, if any. */
    fill(addr) {
        if (this.sets === 0)
            return null;
        const lineAddr = this.lineAddress(addr);
        const index = Math.floor(lineAddr / this.lineBytes) % this.sets;
        const tag = lineAddr;
        const base = index * this.ways;
        for (let w = 0; w < this.ways; w++) {
            const line = this.data[base + w];
            if (line.valid && line.tag === tag) {
                this.stamp += 1;
                line.lru = this.stamp;
                return null;
            }
        }
        let victim = 0;
        let oldest = this.data[base].lru;
        for (let w = 1; w < this.ways; w++) {
            if (!this.data[base + w].valid) {
                victim = w;
                break;
            }
            if (this.data[base + w].lru < oldest) {
                oldest = this.data[base + w].lru;
                victim = w;
            }
        }
        this.stamp += 1;
        const evicted = this.data[base + victim].valid ? this.data[base + victim].tag : null;
        this.data[base + victim] = { tag, valid: true, lru: this.stamp };
        return evicted;
    }
    invalidate(addr) {
        if (this.sets === 0)
            return false;
        const lineAddr = this.lineAddress(addr);
        const index = Math.floor(lineAddr / this.lineBytes) % this.sets;
        const base = index * this.ways;
        for (let w = 0; w < this.ways; w++) {
            const line = this.data[base + w];
            if (line.valid && line.tag === lineAddr) {
                line.valid = false;
                return true;
            }
        }
        return false;
    }
    /** Compatibility helper: lookup and immediately install a missed line. */
    probe(addr) {
        const hit = this.lookup(addr);
        if (!hit)
            this.fill(addr);
        return hit;
    }
    resetStats() {
        this.hits = 0;
        this.misses = 0;
    }
}
//# sourceMappingURL=cache.js.map