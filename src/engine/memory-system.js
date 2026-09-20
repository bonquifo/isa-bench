import { DramScheduler, SetCache } from './cache.ts';
/** Deterministic request-ID cache/coherence/DRAM service. */
export class MemorySystem {
    hw;
    memory;
    icaches;
    dcaches;
    l2;
    l3;
    dram;
    pendingLines = new Map();
    requestsById = new Map();
    pendingRequestIds = new Set();
    directory = new Map();
    nextId = 1;
    counters = {
        completions: 0,
        releases: 0,
        instructionFetches: 0,
        speculativeLoads: 0,
        committedStores: 0,
        coalescedLineRequests: 0,
        ownedFills: 0,
        installedFills: 0,
        wrongPathFills: 0,
        wrongPathBytes: 0,
        icLineAccesses: 0,
        dcLineAccesses: 0,
        dramRequests: 0,
        dramQueueCycles: 0,
        coherenceTransfers: 0,
        coherenceInvalidations: 0,
    };
    constructor(hw, memory) {
        this.hw = hw;
        this.memory = memory;
        this.icaches = Array.from({ length: hw.cores }, () => new SetCache(hw.l1i));
        this.dcaches = Array.from({ length: hw.cores }, () => new SetCache(hw.l1d));
        this.l2 = Array.from({ length: hw.cores }, () => hw.l2.sizeBytes > 0 ? new SetCache(hw.l2) : null);
        this.l3 = hw.l3.sizeBytes > 0 ? new SetCache(hw.l3) : null;
        this.dram = new DramScheduler(hw.memChannels, hw.dramIssueInterval);
    }
    instructionFetch(core, address, width, cycle) {
        this.counters.instructionFetches += 1;
        return this.request('instruction-fetch', core, address, width, cycle, true);
    }
    speculativeLoad(core, address, width, cycle) {
        this.counters.speculativeLoads += 1;
        return this.request('speculative-load', core, address, width, cycle, true);
    }
    committedStore(core, address, width, cycle) {
        this.counters.committedStores += 1;
        return this.request('committed-store', core, address, width, cycle, false);
    }
    markWrongPath(id) {
        const request = this.requestsById.get(id);
        if (!request || request.wrongPath)
            return;
        request.wrongPath = true;
        this.countWrongPath(request);
    }
    releaseRequest(id) {
        const request = this.requestsById.get(id);
        if (!request || request.released)
            return;
        request.released = true;
        this.counters.releases += 1;
        if (request.completed)
            this.requestsById.delete(id);
    }
    isComplete(id) {
        return this.requestsById.get(id)?.completed ?? false;
    }
    outstandingRequests() {
        return this.pendingRequestIds.size;
    }
    complete(cycle) {
        for (const id of this.pendingRequestIds) {
            const request = this.requestsById.get(id);
            for (const fill of request.fills) {
                if (!fill.installed && fill.readyCycle <= cycle)
                    this.installFill(request, fill);
            }
        }
        const due = [...this.pendingRequestIds]
            .map((id) => this.requestsById.get(id))
            .filter((request) => request.readyCycle <= cycle)
            .sort((a, b) => a.readyCycle - b.readyCycle || a.id - b.id);
        const completions = [];
        for (const request of due) {
            request.completed = true;
            this.pendingRequestIds.delete(request.id);
            for (const fill of request.fills) {
                if (!fill.installed)
                    this.installFill(request, fill);
            }
            for (const invalidation of request.invalidations) {
                const l1 = this.dcaches[invalidation.core].invalidate(invalidation.line);
                const l2 = this.l2[invalidation.core]?.invalidate(invalidation.line) ?? false;
                if (l1 || l2)
                    this.counters.coherenceInvalidations += 1;
                this.removeDirectoryResidency(invalidation.core, invalidation.line);
            }
            this.counters.completions += 1;
            this.countWrongPath(request);
            completions.push({ ...request });
            if (request.released)
                this.requestsById.delete(request.id);
        }
        return completions;
    }
    invalidate(core, address) {
        const l1 = this.dcaches[core].invalidate(address);
        const l2 = this.l2[core]?.invalidate(address) ?? false;
        if (l1 || l2)
            this.counters.coherenceInvalidations += 1;
        this.removeDirectoryResidency(core, address);
        return l1 || l2;
    }
    readBytes(address, width) {
        return new Uint8Array(this.memory.slice(address, address + width));
    }
    readInt8(address) {
        return new DataView(this.memory).getInt8(address);
    }
    readInt32(address) {
        return new DataView(this.memory).getInt32(address, true);
    }
    readFloat64(address) {
        return new DataView(this.memory).getFloat64(address, true);
    }
    writeBytes(address, bytes) {
        new Uint8Array(this.memory, address, bytes.length).set(bytes);
    }
    stats() {
        return {
            requests: this.nextId - 1,
            ...this.counters,
            retainedRequests: this.requestsById.size,
            pendingRequests: this.pendingRequestIds.size,
            pendingLines: this.pendingLines.size,
            icHits: this.icaches.reduce((n, cache) => n + cache.hits, 0),
            icMisses: this.icaches.reduce((n, cache) => n + cache.misses, 0),
            dcHits: this.dcaches.reduce((n, cache) => n + cache.hits, 0),
            dcMisses: this.dcaches.reduce((n, cache) => n + cache.misses, 0),
            l2Hits: this.l2.reduce((n, cache) => n + (cache?.hits ?? 0), 0),
            l2Misses: this.l2.reduce((n, cache) => n + (cache?.misses ?? 0), 0),
            l3Hits: this.l3?.hits ?? 0,
            l3Misses: this.l3?.misses ?? 0,
        };
    }
    assertConservation() {
        const issued = this.nextId - 1;
        if (issued !== this.counters.completions + this.pendingRequestIds.size) {
            throw new Error(`Memory request conservation failed: issued=${issued}, completed=${this.counters.completions}, ` +
                `pending=${this.pendingRequestIds.size}`);
        }
        const retainedUnreleased = [...this.requestsById.values()]
            .filter((request) => !request.released).length;
        if (this.counters.releases + retainedUnreleased !== issued) {
            throw new Error(`Memory release/retention conservation failed: issued=${issued}, ` +
                `released=${this.counters.releases}, retainedUnreleased=${retainedUnreleased}`);
        }
        for (const id of this.pendingRequestIds) {
            const request = this.requestsById.get(id);
            if (!request || request.completed) {
                throw new Error(`Memory pending request ${id} is missing or already completed`);
            }
        }
        for (const [key, pending] of this.pendingLines) {
            const request = this.requestsById.get(pending.requestId);
            const fill = request?.fills.find((candidate) => candidate.key === key);
            if (!request || request.completed || !fill || fill.installed ||
                fill.readyCycle !== pending.readyCycle) {
                throw new Error(`Memory pending-line ownership failed for ${key}`);
            }
        }
        if (this.counters.ownedFills !== this.counters.installedFills + this.pendingLines.size) {
            throw new Error(`Memory fill conservation failed: owned=${this.counters.ownedFills}, ` +
                `installed=${this.counters.installedFills}, pending=${this.pendingLines.size}`);
        }
    }
    assertDrained() {
        this.assertConservation();
        if (this.pendingRequestIds.size || this.pendingLines.size || this.requestsById.size) {
            throw new Error(`Memory drain failed: requests=${this.requestsById.size}, ` +
                `pendingRequests=${this.pendingRequestIds.size}, pendingLines=${this.pendingLines.size}`);
        }
        if (this.counters.releases !== this.nextId - 1) {
            throw new Error(`Memory release conservation failed: issued=${this.nextId - 1}, ` +
                `released=${this.counters.releases}`);
        }
        for (const [line, directory] of this.directory) {
            this.sanitizeDirectory(line, directory);
            if (directory.owner !== null && !this.hasDataResidency(directory.owner, line)) {
                throw new Error(`Directory owner ${directory.owner} lacks residency for line ${line}`);
            }
            for (const sharer of directory.sharers) {
                if (!this.hasDataResidency(sharer, line)) {
                    throw new Error(`Directory sharer ${sharer} lacks residency for line ${line}`);
                }
            }
        }
    }
    request(kind, core, address, width, cycle, speculative) {
        if (!Number.isSafeInteger(core) || core < 0 || core >= this.hw.cores) {
            throw new Error(`Invalid memory-system core ${core}`);
        }
        if (!Number.isSafeInteger(address) || address < 0 || !Number.isSafeInteger(width) ||
            width <= 0 || address + width > this.memory.byteLength) {
            throw new Error(`Invalid memory request [${address}, ${address + width})`);
        }
        const id = this.nextId++;
        const cache = kind === 'instruction-fetch' ? this.icaches[core] : this.dcaches[core];
        const lines = cache.lineAddresses(address, width);
        const fills = [];
        const invalidations = [];
        let readyCycle = cycle;
        for (const line of lines) {
            if (kind === 'instruction-fetch')
                this.counters.icLineAccesses += 1;
            else
                this.counters.dcLineAccesses += 1;
            const hierarchy = this.requestLine(cache, kind === 'instruction-fetch' ? 'l1i' : 'l1d', core, line, cycle, id);
            fills.push(...hierarchy.fills);
            let lineReady = hierarchy.readyCycle;
            if (kind !== 'instruction-fetch') {
                const directory = this.directory.get(line) ?? {
                    owner: null,
                    sharers: new Set(),
                    ready: 0,
                };
                this.directory.set(line, directory);
                this.sanitizeDirectory(line, directory);
                if (kind === 'committed-store') {
                    const targets = new Set(directory.sharers);
                    if (directory.owner !== null)
                        targets.add(directory.owner);
                    targets.delete(core);
                    if (targets.size > 0) {
                        lineReady = Math.max(lineReady, directory.ready) + this.hw.coherenceLatency;
                        this.counters.coherenceTransfers += 1;
                    }
                    for (const target of targets)
                        invalidations.push({ core: target, line });
                    directory.owner = core;
                    directory.sharers.clear();
                    directory.ready = lineReady;
                }
                else {
                    if (directory.owner !== null && directory.owner !== core) {
                        lineReady = Math.max(lineReady, directory.ready) + this.hw.coherenceLatency;
                        this.counters.coherenceTransfers += 1;
                        directory.sharers.add(directory.owner);
                        directory.owner = null;
                    }
                    directory.sharers.add(core);
                    directory.ready = lineReady;
                }
            }
            for (const fill of hierarchy.fills) {
                fill.readyCycle = lineReady;
                this.pendingLines.set(fill.key, { requestId: id, readyCycle: lineReady });
            }
            readyCycle = Math.max(readyCycle, lineReady);
        }
        const request = {
            id,
            kind,
            core,
            address,
            width,
            issuedCycle: cycle,
            readyCycle,
            speculative,
            lines,
            fills,
            invalidations,
            completed: false,
            wrongPath: false,
            wrongPathCounted: false,
            released: false,
            installedFills: 0,
        };
        this.requestsById.set(id, request);
        this.pendingRequestIds.add(id);
        return { ...request };
    }
    requestLine(l1, level, core, line, cycle, requestId) {
        if (l1.lookup(line))
            return { readyCycle: cycle, fills: [] };
        const l1Key = `${level}:${core}:${line}`;
        if (l1.sets > 0) {
            const pendingL1 = this.pendingLines.get(l1Key);
            if (pendingL1) {
                this.counters.coalescedLineRequests += 1;
                return { readyCycle: pendingL1.readyCycle, fills: [] };
            }
        }
        const fills = l1.sets > 0
            ? [this.makeFill(l1, level, core, l1Key, line, requestId)]
            : [];
        let readyCycle;
        const l2 = this.l2[core];
        if (l2) {
            const key = `l2:${core}:${line}`;
            if (l2.lookup(line))
                readyCycle = cycle + this.hw.l2Latency;
            else {
                const pending = this.pendingLines.get(key);
                if (pending) {
                    this.counters.coalescedLineRequests += 1;
                    readyCycle = pending.readyCycle;
                }
                else {
                    fills.push(this.makeFill(l2, 'l2', core, key, line, requestId));
                }
            }
        }
        if (readyCycle === undefined && this.l3) {
            const key = `l3:${line}`;
            if (this.l3.lookup(line))
                readyCycle = cycle + this.hw.l3Latency;
            else {
                const pending = this.pendingLines.get(key);
                if (pending) {
                    this.counters.coalescedLineRequests += 1;
                    readyCycle = pending.readyCycle;
                }
                else {
                    fills.push(this.makeFill(this.l3, 'l3', null, key, line, requestId));
                }
            }
        }
        if (readyCycle === undefined) {
            const dram = this.dram.request(cycle, this.hw.memLatency);
            this.counters.dramRequests += 1;
            this.counters.dramQueueCycles += dram.queueCycles;
            readyCycle = dram.ready;
        }
        return { readyCycle, fills };
    }
    makeFill(cache, level, core, key, line, requestId) {
        this.counters.ownedFills += 1;
        return {
            cache,
            level,
            core,
            key,
            line,
            requestId,
            readyCycle: -1,
            installed: false,
        };
    }
    countWrongPath(request) {
        if (!request.wrongPath || request.wrongPathCounted || !request.completed)
            return;
        request.wrongPathCounted = true;
        this.counters.wrongPathFills += request.installedFills;
        this.counters.wrongPathBytes += request.fills.reduce((sum, fill) => sum + (fill.installed ? fill.cache.lineBytes : 0), 0);
    }
    installFill(request, fill) {
        const owner = this.pendingLines.get(fill.key);
        if (!owner || owner.requestId !== request.id || owner.readyCycle !== fill.readyCycle)
            return;
        const evicted = fill.cache.fill(fill.line);
        fill.installed = true;
        request.installedFills += 1;
        this.counters.installedFills += 1;
        this.pendingLines.delete(fill.key);
        if (evicted !== null)
            this.onEviction(fill.level, fill.core, evicted);
    }
    onEviction(level, core, line) {
        if ((level === 'l1d' || level === 'l2') && core !== null) {
            if (!this.hasDataResidency(core, line))
                this.removeDirectoryResidency(core, line);
        }
    }
    hasDataResidency(core, line) {
        return this.dcaches[core]?.has(line) === true ||
            this.l2[core]?.has(line) === true ||
            this.pendingLines.has(`l1d:${core}:${line}`) ||
            this.pendingLines.has(`l2:${core}:${line}`);
    }
    sanitizeDirectory(line, directory) {
        if (directory.owner !== null && !this.hasDataResidency(directory.owner, line)) {
            directory.owner = null;
        }
        for (const sharer of [...directory.sharers]) {
            if (!this.hasDataResidency(sharer, line))
                directory.sharers.delete(sharer);
        }
    }
    removeDirectoryResidency(core, line) {
        const directory = this.directory.get(line);
        if (!directory)
            return;
        if (directory.owner === core)
            directory.owner = null;
        directory.sharers.delete(core);
    }
}
//# sourceMappingURL=memory-system.js.map