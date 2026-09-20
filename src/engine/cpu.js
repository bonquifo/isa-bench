import { i32, idiv, imul, irem, isar, ishl, ishr } from './bits.ts';
import { DramScheduler, SetCache } from './cache.ts';
import { disassemble } from './compile.ts';
import { energyOf } from './energy.ts';
import { readGuestStdout } from './guestio.ts';
import { checkMemoryAccess } from './ir.ts';
import { isaTiming, normalizeHw } from './hardware.ts';
import { BranchPredictor } from './predictor.ts';
import { InstClass, C_PARK_BYTES, C_STACK_BASE, C_STACK_STRIDE, MAX_HW_THREADS, Opcode, OperationOrigin, } from './types.ts';
function emptyMix() {
    return {
        alu: 0,
        mul: 0,
        div: 0,
        ld: 0,
        st: 0,
        br: 0,
        fp: 0,
        mov: 0,
        nop: 0,
    };
}
function programUsesThreads(insts) {
    return insts.some((i) => i.op === Opcode.TID || i.op === Opcode.NTHREADS);
}
function srcsOf(inst) {
    const s = [];
    if (inst.srcA >= 0)
        s.push(inst.srcA);
    if (inst.srcB >= 0)
        s.push(inst.srcB);
    if (inst.memBase >= 0)
        s.push(inst.memBase);
    if (inst.memIndex >= 0)
        s.push(inst.memIndex);
    return s;
}
function maxReady(th, inst) {
    let m = 0;
    for (const s of srcsOf(inst))
        m = Math.max(m, th.ready[s] ?? 0);
    if (inst.dst >= 0)
        m = Math.max(m, th.ready[inst.dst] ?? 0);
    for (const r of inst.resourceReads)
        m = Math.max(m, th.resourceReady.get(r) ?? 0);
    for (const r of inst.resourceWrites)
        m = Math.max(m, th.resourceReady.get(r) ?? 0);
    for (const r of inst.saveRegs ?? [])
        m = Math.max(m, th.ready[r] ?? 0);
    if (inst.readsMem || inst.writesMem)
        m = Math.max(m, th.memoryReady);
    return m;
}
function portsOf(inst) {
    if (inst.readsMem || inst.writesMem)
        return { alu: 0, mem: 1 };
    if (inst.cls === InstClass.BR || inst.cls === InstClass.NOP)
        return { alu: 0, mem: 0 };
    return { alu: 1, mem: 0 };
}
function independent(group, inst) {
    const srcs = srcsOf(inst);
    const writes = inst.dst >= 0 ? [inst.dst] : [];
    for (const prev of group) {
        const prevSrcs = srcsOf(prev);
        if (prev.dst >= 0 && (srcs.includes(prev.dst) || writes.includes(prev.dst)))
            return false;
        if (inst.dst >= 0 && prevSrcs.includes(inst.dst))
            return false;
        if (prev.resourceWrites.some((r) => inst.resourceReads.includes(r) || inst.resourceWrites.includes(r)))
            return false;
        if (inst.resourceWrites.some((r) => prev.resourceReads.includes(r)))
            return false;
    }
    return true;
}
const MAX_CALL_DEPTH = 4096;
function isConditional(inst) {
    return inst.op === Opcode.BEQ || inst.op === Opcode.BNE || inst.op === Opcode.BLT || inst.op === Opcode.BGE;
}
function isControl(inst) {
    return isConditional(inst) || inst.op === Opcode.BR || inst.op === Opcode.CALL ||
        inst.op === Opcode.ICALL || inst.op === Opcode.RET || inst.op === Opcode.HALT ||
        inst.op === Opcode.BARRIER;
}
function mustDrain(inst) {
    return inst.serializing || inst.op === Opcode.CALL || inst.op === Opcode.ICALL ||
        inst.op === Opcode.RET || inst.op === Opcode.HALT || inst.op === Opcode.BARRIER;
}
export function simulate(program, rawHw, mem, opts = {}) {
    const hw = normalizeHw(rawHw);
    const insts = program.insts;
    const view = new DataView(mem);
    const timing = isaTiming(program.isa);
    const mix = emptyMix();
    const parallel = programUsesThreads(insts);
    const hwThreads = Math.max(1, Math.min(MAX_HW_THREADS, hw.threads));
    const want = parallel ? Math.min(hwThreads, Math.max(1, opts.maxWorkers ?? hwThreads)) : 1;
    const activeThreads = Math.max(1, Math.min(want, hwThreads));
    const coresN = Math.max(1, Math.min(hw.cores, activeThreads));
    if (!Number.isSafeInteger(program.spillSlots) || program.spillSlots < 0) {
        throw new Error(`Invalid allocator spill capacity ${program.spillSlots}`);
    }
    const privateSpillValues = program.spillSlots * activeThreads;
    if (privateSpillValues > 4 * 1024 * 1024) {
        throw new Error(`Allocator spill capacity ${program.spillSlots} × ${activeThreads} threads exceeds private storage limit`);
    }
    const l3 = hw.l3.sizeBytes > 0 ? new SetCache(hw.l3) : null;
    const dram = new DramScheduler(hw.memChannels, hw.dramIssueInterval);
    let eventSeq = 0;
    const completions = [];
    // One pending fill per private/shared cache line is the deterministic MSHR
    // policy: later requests coalesce on its absolute ready cycle and never see
    // a tag before the fill event runs.
    const pendingLines = new Map();
    const directory = new Map();
    // This is a timing-only, line-granular MSI-like directory. Functional bytes
    // remain in the shared ArrayBuffer and stores update them at completion.
    // Instruction lines do not participate: self-modifying code is out of scope.
    let fetchedBytes = 0;
    let decodedBytes = 0;
    let icLineAccesses = 0;
    let dcLineAccesses = 0;
    let dramRequests = 0;
    let dramQueueCycles = 0;
    let coherenceTransfers = 0;
    let coherenceInvalidations = 0;
    const cores = Array.from({ length: hw.cores }, (_, id) => ({
        id,
        icache: new SetCache(hw.l1i),
        dcache: new SetCache(hw.l1d),
        l2: hw.l2.sizeBytes > 0 ? new SetCache(hw.l2) : null,
        threads: [],
        rr: 0,
    }));
    const threads = [];
    for (let i = 0; i < activeThreads; i++) {
        const core = cores[i % coresN];
        const th = {
            id: i,
            core: core.id,
            pc: 0,
            regs: new Float64Array(32),
            ready: new Float64Array(32),
            resourceReady: new Map(),
            outstanding: 0,
            memoryReady: 0,
            fetchReady: 0,
            fetchAttemptPc: -1,
            fetchAttemptLines: new Set(),
            fetchAssemblyPc: -1,
            fetchAssemblyReady: 0,
            halted: false,
            barrier: false,
            result: 0,
            predictor: new BranchPredictor(hw),
            calls: [],
            spillFrames: [new Float64Array(program.spillSlots)],
        };
        core.threads.push(th);
        threads.push(th);
    }
    const ea = (th, inst) => {
        const base = inst.memBase >= 0 ? i32(th.regs[inst.memBase]) : 0;
        const idx = inst.memIndex >= 0 ? i32(th.regs[inst.memIndex]) * inst.memScale : 0;
        return i32(base + idx + inst.memOff);
    };
    const latencyOf = (inst) => {
        switch (inst.op) {
            case Opcode.MUL:
                return hw.mulLatency;
            case Opcode.MULF:
                return hw.fpMulLatency;
            case Opcode.DIV:
            case Opcode.REM:
                return hw.divLatency;
            case Opcode.DIVF:
                return hw.fpDivLatency;
            case Opcode.ADDF:
            case Opcode.SUBF:
                return hw.fpAddLatency;
            case Opcode.LDW:
            case Opcode.LDD:
            case Opcode.LDB:
                return hw.loadLatency;
            default:
                return 1;
        }
    };
    const requestLine = (core, addr, isFetch, cycle) => {
        const l1 = isFetch ? core.icache : core.dcache;
        const line = l1.lineAddress(addr);
        if (isFetch)
            icLineAccesses += 1;
        else
            dcLineAccesses += 1;
        if (l1.lookup(line))
            return cycle;
        const l1Key = `${isFetch ? 'i' : 'd'}:${core.id}:${line}`;
        const existingL1 = pendingLines.get(l1Key);
        if (existingL1 !== undefined)
            return existingL1;
        const fills = [{ cache: l1, key: l1Key }];
        let ready;
        if (core.l2) {
            const l2Key = `l2:${core.id}:${line}`;
            if (core.l2.lookup(line)) {
                ready = cycle + hw.l2Latency;
            }
            else {
                fills.push({ cache: core.l2, key: l2Key });
                ready = pendingLines.get(l2Key);
            }
        }
        if (ready === undefined && l3) {
            const l3Key = `l3:${line}`;
            if (l3.lookup(line)) {
                ready = cycle + hw.l3Latency;
            }
            else {
                fills.push({ cache: l3, key: l3Key });
                ready = pendingLines.get(l3Key);
            }
        }
        if (ready === undefined) {
            // Earliest available channel wins; scanning upward preserves the
            // stable lowest-index tie break. Each accepts one line per configured
            // issue interval, independently of the fixed response latency.
            const request = dram.request(cycle, hw.memLatency);
            dramQueueCycles += request.queueCycles;
            dramRequests += 1;
            ready = request.ready;
        }
        for (const fill of fills)
            pendingLines.set(fill.key, ready);
        const scheduledReady = ready;
        completions.push({
            cycle: scheduledReady,
            seq: eventSeq++,
            run: () => {
                for (const fill of fills) {
                    fill.cache.fill(line);
                    if (pendingLines.get(fill.key) === scheduledReady)
                        pendingLines.delete(fill.key);
                }
            },
        });
        return scheduledReady;
    };
    const accessWidth = (inst) => {
        switch (inst.op) {
            case Opcode.LDB:
            case Opcode.STB: return 1;
            case Opcode.LDW:
            case Opcode.STW: return 4;
            case Opcode.LDD:
            case Opcode.STD: return 8;
            default: return 0;
        }
    };
    const exec = (th, inst) => {
        const a = inst.srcA >= 0 ? th.regs[inst.srcA] : 0;
        const b = inst.srcB >= 0 ? th.regs[inst.srcB] : 0;
        const write = (v) => {
            if (inst.dst >= 0)
                th.regs[inst.dst] = v;
        };
        switch (inst.op) {
            case Opcode.LI:
                write(i32(inst.imm));
                return {};
            case Opcode.LIF:
                write(inst.imm);
                return {};
            case Opcode.MOV:
                write(a);
                return {};
            case Opcode.ADD:
                write(i32(a + b));
                return {};
            case Opcode.SUB:
                write(i32(a - b));
                return {};
            case Opcode.MUL:
                write(imul(a, b));
                return {};
            case Opcode.DIV:
                write(idiv(a, b));
                return {};
            case Opcode.REM:
                write(irem(a, b));
                return {};
            case Opcode.AND:
                write(i32(a) & i32(b));
                return {};
            case Opcode.OR:
                write(i32(a) | i32(b));
                return {};
            case Opcode.XOR:
                write(i32(a) ^ i32(b));
                return {};
            case Opcode.SHL:
                write(ishl(a, inst.srcB >= 0 ? b : inst.imm));
                return {};
            case Opcode.SHR:
                write(ishr(a, inst.srcB >= 0 ? b : inst.imm));
                return {};
            case Opcode.SAR:
                write(isar(a, inst.srcB >= 0 ? b : inst.imm));
                return {};
            case Opcode.ADDI:
                write(i32(a + inst.imm));
                return {};
            case Opcode.ADDF:
                write(a + b);
                return {};
            case Opcode.SUBF:
                write(a - b);
                return {};
            case Opcode.MULF:
                write(a * b);
                return {};
            case Opcode.DIVF:
                write(a / b);
                return {};
            case Opcode.EQF:
                write(a === b ? 1 : 0);
                return {};
            case Opcode.NEF:
                write(a !== b ? 1 : 0);
                return {};
            case Opcode.LTF:
                write(a < b ? 1 : 0);
                return {};
            case Opcode.GEF:
                write(a >= b ? 1 : 0);
                return {};
            case Opcode.ITOD:
                write(i32(a));
                return {};
            case Opcode.DTOI:
                write(i32(Math.trunc(a)));
                return {};
            case Opcode.I8:
                write((i32(a) << 24) >> 24);
                return {};
            case Opcode.LDB:
                {
                    const addr = ea(th, inst);
                    checkMemoryAccess('CPU ldb', addr, 1, mem.byteLength);
                    write(view.getInt8(addr));
                }
                return {};
            case Opcode.STB:
                {
                    const addr = ea(th, inst);
                    checkMemoryAccess('CPU stb', addr, 1, mem.byteLength);
                    view.setInt8(addr, i32(a));
                }
                return {};
            case Opcode.LDW:
                {
                    const addr = ea(th, inst);
                    checkMemoryAccess('CPU ldw', addr, 4, mem.byteLength);
                    write(view.getInt32(addr, true));
                }
                return {};
            case Opcode.STW:
                {
                    const addr = ea(th, inst);
                    checkMemoryAccess('CPU stw', addr, 4, mem.byteLength);
                    view.setInt32(addr, i32(a), true);
                }
                return {};
            case Opcode.LDD:
                {
                    const addr = ea(th, inst);
                    checkMemoryAccess('CPU ldd', addr, 8, mem.byteLength);
                    write(view.getFloat64(addr, true));
                }
                return {};
            case Opcode.STD:
                {
                    const addr = ea(th, inst);
                    checkMemoryAccess('CPU std', addr, 8, mem.byteLength);
                    view.setFloat64(addr, a, true);
                }
                return {};
            case Opcode.SPILL_LOAD: {
                const frame = th.spillFrames[th.spillFrames.length - 1];
                if (!frame || inst.imm < 0 || inst.imm >= frame.length) {
                    throw new Error(`Allocator spill fault: load slot ${inst.imm} (capacity ${frame?.length ?? 0})`);
                }
                write(frame[inst.imm]);
                return {};
            }
            case Opcode.SPILL_STORE: {
                const frame = th.spillFrames[th.spillFrames.length - 1];
                if (!frame || inst.imm < 0 || inst.imm >= frame.length) {
                    throw new Error(`Allocator spill fault: store slot ${inst.imm} (capacity ${frame?.length ?? 0})`);
                }
                frame[inst.imm] = a;
                return {};
            }
            case Opcode.BEQ:
                return { taken: i32(a) === i32(b) };
            case Opcode.BNE:
                return { taken: i32(a) !== i32(b) };
            case Opcode.BLT:
                return { taken: i32(a) < i32(b) };
            case Opcode.BGE:
                return { taken: i32(a) >= i32(b) };
            case Opcode.BR:
                return { taken: true };
            case Opcode.HALT:
                return { halt: true };
            case Opcode.NOP:
                return {};
            case Opcode.TID:
            case Opcode.PTID:
                write(i32(th.id));
                return {};
            case Opcode.PNTHREADS:
                write(i32(activeThreads));
                return {};
            case Opcode.NTHREADS:
                write(i32(activeThreads));
                return {};
            case Opcode.CSTACK_CHECK: {
                const ptr = i32(a);
                const low = C_STACK_BASE + th.id * C_STACK_STRIDE;
                const high = low + C_STACK_STRIDE;
                const park = inst.imm === 1;
                const valid = park
                    ? ptr >= low && ptr <= low + C_PARK_BYTES
                    : ptr >= low + C_PARK_BYTES && ptr <= high;
                if (!valid) {
                    throw new Error(`Guest C ${park ? 'park' : 'software'} stack fault for worker ${th.id} at address ${ptr} (region ${low}..${high})`);
                }
                return {};
            }
            case Opcode.BARRIER:
                return { barrier: true };
            case Opcode.CALL:
                return { call: true };
            case Opcode.RET:
                return { ret: true };
            case Opcode.ICALL:
                return { icall: true };
        }
    };
    const pickGroup = (th, cycles, issueLeft, aluLeft, memLeft, fetchLeft) => {
        const group = [];
        let alu = 0;
        let mem = 0;
        let fetch = 0;
        let issue = 0;
        for (let k = 0;; k++) {
            if (th.pc + k >= insts.length)
                break;
            const inst = insts[th.pc + k];
            const cost = Math.max(1, inst.uops);
            if (group.length > 0 && issue + cost > issueLeft)
                break;
            if (group.length === 0 && cost > issueLeft && issueLeft < hw.issueWidth)
                break;
            if (group.length === 0 && inst.bytes > fetchLeft && fetchLeft < hw.fetchWidth)
                break;
            if (k > 0 && fetch + inst.bytes > fetchLeft)
                break;
            const complex = inst.bytes >= hw.complexDecodeBytes;
            if (complex && group.length > 0)
                break;
            if (k > 0 && !independent(group, inst))
                break;
            if (k > 0 && maxReady(th, inst) > cycles)
                break;
            if ((inst.readsMem || inst.writesMem) &&
                group.some((older) => older.readsMem || older.writesMem))
                break;
            if (mustDrain(inst) && group.length > 0)
                break;
            if (mustDrain(inst) && th.outstanding > 0)
                break;
            const ports = portsOf(inst);
            if (alu + ports.alu > aluLeft)
                break;
            if (mem + ports.mem > memLeft)
                break;
            group.push(inst);
            issue += Math.min(cost, hw.issueWidth);
            alu += ports.alu;
            mem += ports.mem;
            fetch += inst.bytes;
            if (complex || cost > hw.issueWidth || isControl(inst) || inst.serializing)
                break;
        }
        return group;
    };
    let cycles = 0;
    let stalls = 0;
    let instructions = 0;
    let uops = 0;
    let branches = 0;
    let mispredicts = 0;
    let completedOperations = 0;
    let completedUops = 0;
    const operationOrigins = {
        semantic: 0,
        lowering: 0,
        runtime: 0,
    };
    let zeroIssueCycles = 0;
    let dependencyStallCycles = 0;
    let fetchStallCycles = 0;
    let resourceStallCycles = 0;
    let memoryOrderStallCycles = 0;
    let serializationStallCycles = 0;
    let conditionalBranches = 0;
    let directJumps = 0;
    let calls = 0;
    let returns = 0;
    let indirectCalls = 0;
    let rasMisses = 0;
    let activeCoreCycles = 0;
    let stalledCoreCycles = 0;
    let idleCoreCycles = 0;
    const coresThatIssued = new Set();
    const maxCycles = 80_000_000;
    while ((threads.some((t) => !t.halted) || completions.length > 0) && cycles < maxCycles) {
        const due = completions
            .filter((e) => e.cycle <= cycles)
            .sort((a, b) => a.cycle - b.cycle || a.seq - b.seq);
        for (const event of due) {
            event.run();
            if (event.th) {
                event.th.outstanding -= 1;
                completedOperations += 1;
                completedUops += event.uops ?? 0;
                operationOrigins[event.origin ?? OperationOrigin.SEMANTIC] += 1;
            }
        }
        if (due.length > 0) {
            const done = new Set(due);
            for (let i = completions.length - 1; i >= 0; i--) {
                if (done.has(completions[i]))
                    completions.splice(i, 1);
            }
        }
        let issued = 0;
        const issuedCores = new Set();
        const waiting = threads.filter((t) => !t.halted && t.barrier);
        const live = threads.filter((t) => !t.halted);
        if (waiting.length > 0 && waiting.length === live.length) {
            for (const t of waiting)
                t.barrier = false;
        }
        for (const core of cores) {
            let issueLeft = hw.issueWidth;
            let aluLeft = hw.aluCount;
            let memLeft = hw.memPorts;
            let fetchLeft = hw.fetchWidth;
            const n = core.threads.length;
            if (n === 0)
                continue;
            for (let s = 0; s < n && issueLeft > 0; s++) {
                const th = core.threads[(core.rr + s) % n];
                if (th.halted || th.barrier)
                    continue;
                if (th.fetchReady > cycles)
                    continue;
                if (th.pc >= insts.length) {
                    th.halted = true;
                    continue;
                }
                const head = insts[th.pc];
                const need = maxReady(th, head);
                if (need > cycles)
                    continue;
                if (mustDrain(head) && th.outstanding > 0)
                    continue;
                const group = pickGroup(th, cycles, issueLeft, aluLeft, memLeft, fetchLeft);
                if (group.length === 0)
                    continue;
                if (th.fetchAttemptPc !== th.pc) {
                    th.fetchAttemptPc = th.pc;
                    th.fetchAttemptLines.clear();
                }
                let fetchReady = cycles;
                const fetchLines = new Set();
                for (const inst of group) {
                    for (const line of core.icache.lineAddresses(inst.addr, inst.bytes))
                        fetchLines.add(line);
                }
                for (const line of fetchLines) {
                    if (th.fetchAttemptLines.has(line)) {
                        // A completed fill can be displaced while this thread is waiting
                        // to issue. Revalidate silently: a resident retry is not another
                        // hit, while an eviction becomes a real new line request.
                        if (core.icache.has(line))
                            continue;
                        th.fetchAttemptLines.delete(line);
                    }
                    th.fetchAttemptLines.add(line);
                    fetchReady = Math.max(fetchReady, requestLine(core, line, true, cycles));
                }
                if (fetchReady > cycles) {
                    th.fetchReady = Math.max(th.fetchReady, fetchReady);
                    continue;
                }
                if (th.fetchAssemblyPc !== th.pc) {
                    th.fetchAssemblyPc = th.pc;
                    const fetchCycles = Math.max(1, Math.ceil(group.reduce((n, inst) => n + inst.bytes, 0) / hw.fetchWidth));
                    th.fetchAssemblyReady = cycles + fetchCycles - 1;
                }
                if (th.fetchAssemblyReady > cycles) {
                    th.fetchReady = Math.max(th.fetchReady, th.fetchAssemblyReady);
                    continue;
                }
                th.fetchAttemptPc = -1;
                th.fetchAttemptLines.clear();
                th.fetchAssemblyPc = -1;
                const groupBytes = group.reduce((sum, inst) => sum + inst.bytes, 0);
                fetchedBytes += groupBytes;
                decodedBytes += groupBytes;
                if (group.some((g) => g.bytes >= hw.complexDecodeBytes)) {
                    th.fetchReady = Math.max(th.fetchReady, cycles + 1 + timing.decodeOverhead);
                }
                issuedCores.add(core.id);
                coresThatIssued.add(core.id);
                let branched = false;
                for (let groupPos = 0; groupPos < group.length; groupPos++) {
                    const inst = group[groupPos];
                    const effectiveAddress = inst.readsMem || inst.writesMem ? ea(th, inst) : undefined;
                    const regSnapshot = th.regs.slice();
                    const spillFrame = th.spillFrames[th.spillFrames.length - 1];
                    const out = isControl(inst) ? exec(th, inst) : {};
                    mix[inst.cls] += 1;
                    instructions += 1;
                    uops += inst.uops;
                    issued += 1;
                    let hierarchyReady = cycles;
                    const coherenceActions = [];
                    if (effectiveAddress !== undefined && inst.op !== Opcode.SPILL_LOAD && inst.op !== Opcode.SPILL_STORE) {
                        const width = accessWidth(inst);
                        checkMemoryAccess(`CPU ${inst.op}`, effectiveAddress, width, mem.byteLength);
                        const lines = core.dcache.lineAddresses(effectiveAddress, width);
                        for (const line of lines) {
                            let dir = directory.get(line);
                            if (!dir) {
                                dir = {
                                    owner: null,
                                    sharers: new Set(),
                                    ready: 0,
                                    version: 0,
                                    projectedUntil: new Map(),
                                };
                                directory.set(line, dir);
                            }
                            let lineReady;
                            const remoteOwner = inst.readsMem && dir.owner !== null && dir.owner !== core.id;
                            if (remoteOwner) {
                                dcLineAccesses += 1;
                                // A projected remote owner makes any still-present local tag
                                // stale; the earlier ownership event invalidates it before
                                // this serialized transfer completes.
                                core.dcache.misses += 1;
                                const key = `d:${core.id}:${line}`;
                                lineReady = Math.max(cycles, dir.ready) + hw.coherenceLatency;
                                pendingLines.set(key, lineReady);
                                const fillReady = lineReady;
                                completions.push({
                                    cycle: fillReady,
                                    seq: eventSeq++,
                                    run: () => {
                                        core.dcache.fill(line);
                                        core.l2?.fill(line);
                                        if (pendingLines.get(key) === fillReady)
                                            pendingLines.delete(key);
                                    },
                                });
                                coherenceTransfers += 1;
                                const previousOwner = dir.owner;
                                dir.version += 1;
                                dir.owner = null;
                                if (previousOwner !== null) {
                                    dir.sharers.add(previousOwner);
                                    dir.projectedUntil.set(previousOwner, lineReady);
                                }
                                dir.sharers.add(core.id);
                                dir.projectedUntil.set(core.id, lineReady);
                            }
                            else {
                                lineReady = requestLine(core, line, false, cycles);
                            }
                            const ownershipStart = Math.max(lineReady, dir.ready);
                            if (inst.writesMem) {
                                const candidates = new Set(dir.sharers);
                                if (dir.owner !== null)
                                    candidates.add(dir.owner);
                                candidates.delete(core.id);
                                const targets = new Set();
                                for (const target of candidates) {
                                    const other = cores[target];
                                    const projected = (dir.projectedUntil.get(target) ?? 0) > cycles;
                                    const resident = !!other && (other.dcache.has(line) || !!other.l2?.has(line));
                                    if (projected || resident)
                                        targets.add(target);
                                    else {
                                        dir.sharers.delete(target);
                                        if (dir.owner === target)
                                            dir.owner = null;
                                        dir.projectedUntil.delete(target);
                                    }
                                }
                                lineReady = ownershipStart + (targets.size > 0 ? hw.coherenceLatency : 0);
                                dir.version += 1;
                                const ownershipVersion = dir.version;
                                dir.owner = core.id;
                                dir.sharers.clear();
                                dir.ready = lineReady;
                                dir.projectedUntil.clear();
                                dir.projectedUntil.set(core.id, lineReady);
                                if (targets.size > 0) {
                                    coherenceActions.push(() => {
                                        if (directory.get(line)?.version !== ownershipVersion)
                                            return;
                                        for (const target of targets) {
                                            const other = cores[target];
                                            if (!other)
                                                continue;
                                            const invalidatedL1 = other.dcache.invalidate(line);
                                            const invalidatedL2 = other.l2?.invalidate(line) ?? false;
                                            if (invalidatedL1 || invalidatedL2)
                                                coherenceInvalidations += 1;
                                        }
                                    });
                                }
                            }
                            else {
                                lineReady = Math.max(lineReady, dir.ready);
                                dir.ready = lineReady;
                                if (dir.owner === null)
                                    dir.sharers.add(core.id);
                                dir.projectedUntil.set(core.id, lineReady);
                            }
                            hierarchyReady = Math.max(hierarchyReady, lineReady);
                        }
                    }
                    let lat = latencyOf(inst);
                    if (timing.loadDelay > 0 && inst.readsMem)
                        lat += timing.loadDelay;
                    if (!hw.forwarding)
                        lat += Math.max(0, hw.pipelineStages - 3);
                    const completionCycle = Math.max(cycles + lat, hierarchyReady + lat);
                    if (!isControl(inst)) {
                        th.outstanding += 1;
                        completions.push({
                            cycle: completionCycle,
                            seq: eventSeq++,
                            th,
                            uops: inst.uops,
                            origin: inst.origin,
                            run: () => {
                                for (const action of coherenceActions)
                                    action();
                                const liveRegs = th.regs;
                                const liveFrames = th.spillFrames;
                                th.regs = regSnapshot;
                                th.spillFrames = [spillFrame];
                                exec(th, inst);
                                const value = inst.dst >= 0 ? th.regs[inst.dst] : 0;
                                th.regs = liveRegs;
                                th.spillFrames = liveFrames;
                                if (inst.dst >= 0)
                                    th.regs[inst.dst] = value;
                            },
                        });
                        if (inst.dst >= 0)
                            th.ready[inst.dst] = completionCycle;
                        for (const r of inst.resourceWrites)
                            th.resourceReady.set(r, completionCycle);
                        if (inst.readsMem || inst.writesMem)
                            th.memoryReady = completionCycle;
                    }
                    else {
                        completedOperations += 1;
                        completedUops += inst.uops;
                        operationOrigins[inst.origin] += 1;
                    }
                    if (out.halt) {
                        th.halted = true;
                        th.result = inst.srcA >= 0 ? th.regs[inst.srcA] : 0;
                        break;
                    }
                    if (out.barrier) {
                        th.barrier = true;
                        th.pc += 1;
                        branched = true;
                        break;
                    }
                    if (out.call) {
                        if (th.calls.length >= MAX_CALL_DEPTH)
                            throw new Error(`Call depth exceeds ${MAX_CALL_DEPTH}`);
                        calls += 1;
                        th.calls.push({
                            pc: th.pc + groupPos + 1,
                            saved: (inst.saveRegs ?? []).map((r) => [r, th.regs[r], th.ready[r]]),
                            savedSpills: new Set(inst.saveSpills ?? []),
                            rasHit: th.calls.length < hw.rasDepth,
                        });
                        th.spillFrames.push(th.spillFrames[th.spillFrames.length - 1].slice());
                        th.pc = inst.target;
                        if (timing.branchDelay > 0)
                            th.fetchReady = Math.max(th.fetchReady, cycles + 1 + timing.branchDelay);
                        branched = true;
                        break;
                    }
                    if (out.icall) {
                        if (th.calls.length >= MAX_CALL_DEPTH)
                            throw new Error(`Call depth exceeds ${MAX_CALL_DEPTH}`);
                        indirectCalls += 1;
                        th.calls.push({
                            pc: th.pc + groupPos + 1,
                            saved: (inst.saveRegs ?? []).map((r) => [r, th.regs[r], th.ready[r]]),
                            savedSpills: new Set(inst.saveSpills ?? []),
                            rasHit: th.calls.length < hw.rasDepth,
                        });
                        th.spillFrames.push(th.spillFrames[th.spillFrames.length - 1].slice());
                        th.pc = i32(th.regs[inst.srcA]);
                        th.fetchReady = Math.max(th.fetchReady, cycles + 1 + hw.indirectCallPenalty + timing.branchDelay);
                        branched = true;
                        break;
                    }
                    if (out.ret) {
                        returns += 1;
                        const frame = th.calls.pop();
                        if (frame === undefined)
                            throw new Error('RET with empty call stack');
                        for (const [reg, value, ready] of frame.saved) {
                            th.regs[reg] = value;
                            th.ready[reg] = ready;
                        }
                        const calleeSpills = th.spillFrames.pop();
                        const callerSpills = th.spillFrames[th.spillFrames.length - 1];
                        if (!calleeSpills || !callerSpills)
                            throw new Error('Allocator spill frame underflow on RET');
                        for (let slot = 0; slot < calleeSpills.length; slot++) {
                            if (!frame.savedSpills.has(slot))
                                callerSpills[slot] = calleeSpills[slot];
                        }
                        th.pc = frame.pc;
                        if (!frame.rasHit) {
                            rasMisses += 1;
                            th.fetchReady = Math.max(th.fetchReady, cycles + 1 + hw.indirectCallPenalty + timing.branchDelay);
                        }
                        else if (timing.branchDelay > 0) {
                            th.fetchReady = Math.max(th.fetchReady, cycles + 1 + timing.branchDelay);
                        }
                        branched = true;
                        break;
                    }
                    if (out.taken !== undefined) {
                        if (isConditional(inst)) {
                            branches += 1;
                            conditionalBranches += 1;
                            const targetAddr = insts[inst.target]?.addr ?? inst.addr;
                            const pred = th.predictor.predict(inst.addr, targetAddr);
                            th.predictor.update(inst.addr, out.taken);
                            if (pred !== out.taken) {
                                mispredicts += 1;
                                th.fetchReady = Math.max(th.fetchReady, cycles + 1 + hw.mispredictPenalty + timing.branchDelay);
                            }
                        }
                        else {
                            directJumps += 1;
                        }
                        if (timing.branchDelay > 0) {
                            th.fetchReady = Math.max(th.fetchReady, cycles + 1 + timing.branchDelay);
                        }
                        th.pc = out.taken ? inst.target : th.pc + group.length;
                        branched = true;
                        break;
                    }
                }
                if (!branched && !th.halted)
                    th.pc += group.length;
                for (const inst of group) {
                    const p = portsOf(inst);
                    issueLeft -= Math.min(Math.max(1, inst.uops), hw.issueWidth);
                    aluLeft -= p.alu;
                    memLeft -= p.mem;
                    fetchLeft -= inst.bytes;
                }
            }
            core.rr += 1;
        }
        if (issued === 0) {
            let cause = 'resource';
            // Deterministic cause: first runnable worker in stable worker order,
            // with fetch > memory-order > serialization > dependency precedence.
            for (const th of threads) {
                if (th.halted || th.barrier || th.pc >= insts.length)
                    continue;
                const head = insts[th.pc];
                if (th.fetchReady > cycles)
                    cause = 'fetch';
                else if ((head.readsMem || head.writesMem) && th.memoryReady > cycles)
                    cause = 'memory';
                else if (mustDrain(head) && th.outstanding > 0)
                    cause = 'serialization';
                else if (maxReady(th, head) > cycles)
                    cause = 'dependency';
                break;
            }
            let next = Infinity;
            for (const event of completions) {
                if (event.cycle > cycles)
                    next = Math.min(next, event.cycle);
            }
            for (const th of threads) {
                if (th.halted || th.barrier)
                    continue;
                if (th.fetchReady > cycles)
                    next = Math.min(next, th.fetchReady);
                if (th.memoryReady > cycles)
                    next = Math.min(next, th.memoryReady);
                for (let r = 0; r < 32; r++) {
                    if (th.ready[r] > cycles)
                        next = Math.min(next, th.ready[r]);
                }
                for (const ready of th.resourceReady.values()) {
                    if (ready > cycles)
                        next = Math.min(next, ready);
                }
            }
            const skipped = Number.isFinite(next) ? next - cycles : 1;
            zeroIssueCycles += skipped;
            stalls += skipped;
            if (cause === 'fetch')
                fetchStallCycles += skipped;
            else if (cause === 'memory')
                memoryOrderStallCycles += skipped;
            else if (cause === 'serialization')
                serializationStallCycles += skipped;
            else if (cause === 'dependency')
                dependencyStallCycles += skipped;
            else
                resourceStallCycles += skipped;
            for (const core of cores) {
                const hasLiveWorker = core.threads.some((t) => !t.halted);
                if (hasLiveWorker)
                    stalledCoreCycles += skipped;
                else
                    idleCoreCycles += skipped;
            }
            cycles += skipped;
        }
        else {
            for (const core of cores) {
                if (issuedCores.has(core.id))
                    activeCoreCycles += 1;
                else if (core.threads.some((t) => !t.halted))
                    stalledCoreCycles += 1;
                else
                    idleCoreCycles += 1;
            }
            cycles += 1;
        }
    }
    if (threads.some((t) => !t.halted)) {
        throw new Error(`${program.isa} simulation did not halt (${cycles} cycles)`);
    }
    if (instructions !== completedOperations || uops !== completedUops) {
        throw new Error(`Completion invariant failed: operations ${instructions}/${completedOperations}, ` +
            `uops ${uops}/${completedUops}`);
    }
    const originTotal = Object.values(operationOrigins).reduce((sum, n) => sum + n, 0);
    if (originTotal !== completedOperations) {
        throw new Error(`Origin invariant failed: ${originTotal} != ${completedOperations}`);
    }
    if (activeCoreCycles + stalledCoreCycles + idleCoreCycles !== cycles * hw.cores) {
        throw new Error('Core residency invariant failed');
    }
    const lead = threads.find((t) => t.id === 0) ?? threads[0];
    const timeUs = cycles / hw.clockMhz;
    const aggregateModeledOpsPerCycle = cycles === 0 ? 0 : completedOperations / cycles;
    const modelCyclesPerAggregateOp = completedOperations === 0 ? 0 : cycles / completedOperations;
    const cpi = modelCyclesPerAggregateOp;
    const ipc = aggregateModeledOpsPerCycle;
    const busyCores = coresThatIssued.size;
    let l2Hits = 0;
    let l2Misses = 0;
    for (const c of cores) {
        if (c.l2) {
            l2Hits += c.l2.hits;
            l2Misses += c.l2.misses;
        }
    }
    const energy = energyOf({
        isa: program.isa,
        mix,
        operationOrigins,
        decodedBytes,
        icLineAccesses,
        dcLineAccesses,
        l2Hits,
        l2Misses,
        l3Hits: l3?.hits ?? 0,
        l3Misses: l3?.misses ?? 0,
        dramRequests,
        coherenceTransfers,
        coherenceInvalidations,
        mispredicts,
        timeUs,
        activeCoreCycles,
        stalledCoreCycles,
        idleCoreCycles,
        clockMhz: hw.clockMhz,
        staticPowerMw: hw.staticPowerMw,
    });
    return {
        isa: program.isa,
        hardwareId: hw.id,
        hardwareName: hw.name,
        result: lead.result,
        matchedGold: false,
        instructions,
        uops,
        cycles,
        cpi,
        ipc,
        aggregateModeledOpsPerCycle,
        modelCyclesPerAggregateOp,
        codeBytes: program.codeBytes,
        clockMhz: hw.clockMhz,
        timeUs,
        icHits: cores.reduce((n, c) => n + c.icache.hits, 0),
        icMisses: cores.reduce((n, c) => n + c.icache.misses, 0),
        dcHits: cores.reduce((n, c) => n + c.dcache.hits, 0),
        dcMisses: cores.reduce((n, c) => n + c.dcache.misses, 0),
        branches,
        mispredicts,
        stalls,
        mix,
        dynamicEnergyNj: energy.dynamicEnergyNj,
        staticEnergyNj: energy.staticEnergyNj,
        totalEnergyNj: energy.totalEnergyNj,
        edp: energy.edp,
        operationDecodeEnergyNj: energy.operationDecodeEnergyNj,
        cacheEnergyNj: energy.cacheEnergyNj,
        memoryCoherenceEnergyNj: energy.memoryCoherenceEnergyNj,
        recoveryEnergyNj: energy.recoveryEnergyNj,
        nominalModelEnergyNj: energy.nominalModelEnergyNj,
        modeledEdpNjUs: energy.modeledEdpNjUs,
        energyModelClass: energy.energyModelClass,
        energyUncertainty: energy.energyUncertainty,
        spillSlots: program.spillSlots,
        disasm: disassemble(program),
        cores: hw.cores,
        threads: hw.threads,
        activeThreads,
        busyCores,
        coresThatIssued: busyCores,
        l2Hits,
        l2Misses,
        l3Hits: l3?.hits ?? 0,
        l3Misses: l3?.misses ?? 0,
        stdout: readGuestStdout(mem),
        issuedOperations: instructions,
        completedOperations,
        issuedUops: uops,
        completedUops,
        operationOrigins,
        zeroIssueCycles,
        dependencyStallCycles,
        fetchStallCycles,
        resourceStallCycles,
        memoryOrderStallCycles,
        serializationStallCycles,
        conditionalBranches,
        directJumps,
        calls,
        returns,
        indirectCalls,
        rasMisses,
        fetchedBytes,
        decodedBytes,
        icLineAccesses,
        dcLineAccesses,
        dramRequests,
        dramQueueCycles,
        coherenceTransfers,
        coherenceInvalidations,
        activeCoreCycles,
        stalledCoreCycles,
        idleCoreCycles,
        averageActiveCores: cycles === 0 ? 0 : activeCoreCycles / cycles,
        averageStalledCores: cycles === 0 ? 0 : stalledCoreCycles / cycles,
    };
}
//# sourceMappingURL=cpu.js.map