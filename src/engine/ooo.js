import { i32, idiv, imul, irem, isar, ishl, ishr } from './bits.ts';
import { disassemble } from './compile.ts';
import { readGuestStdout } from './guestio.ts';
import { normalizeHw } from './hardware.ts';
import { checkMemoryAccess } from './ir.ts';
import { MemorySystem } from './memory-system.ts';
import { DEFAULT_OOO_PROFILE, OOO_ENERGY_MODEL_VERSION, OOO_MODEL_VERSION, decodeProgram, validateOoOProfile, } from './ooo-types.ts';
import { C_PARK_BYTES, C_STACK_BASE, C_STACK_STRIDE, InstClass, MAX_HW_THREADS, Opcode, } from './types.ts';
const MAX_CALL_DEPTH = 4096;
const MAX_CYCLES = 80_000_000;
const classes = Object.values(InstClass);
function emptyClassRecord(create) {
    return Object.fromEntries(classes.map((cls) => [cls, create()]));
}
function emptyOccupancy() {
    return { area: 0, peak: 0, fullCycles: 0 };
}
function srcRegs(inst) {
    const out = [];
    for (const reg of [inst.srcA, inst.srcB, inst.memBase, inst.memIndex]) {
        if (reg >= 0 && !out.includes(reg))
            out.push(reg);
    }
    return out;
}
function isConditional(inst) {
    return [Opcode.BEQ, Opcode.BNE, Opcode.BLT, Opcode.BGE].includes(inst.op);
}
function isSerialized(inst) {
    return inst.serializing || [
        Opcode.CALL, Opcode.ICALL, Opcode.RET, Opcode.HALT, Opcode.BARRIER,
    ].includes(inst.op);
}
function accessWidth(inst) {
    if (inst.op === Opcode.LDB || inst.op === Opcode.STB)
        return 1;
    if (inst.op === Opcode.LDW || inst.op === Opcode.STW)
        return 4;
    if (inst.op === Opcode.LDD || inst.op === Opcode.STD)
        return 8;
    return 0;
}
function isRealLoad(inst) {
    return inst.readsMem && inst.op !== Opcode.SPILL_LOAD;
}
function isRealStore(inst) {
    return inst.writesMem && inst.op !== Opcode.SPILL_STORE;
}
class OoOPredictor {
    table;
    mask;
    hw;
    history = 0;
    constructor(hw) {
        this.hw = hw;
        this.table = new Uint8Array(hw.predEntries);
        this.table.fill(1);
        this.mask = hw.predEntries - 1;
    }
    predict(address, target) {
        const before = this.history;
        const direct = (address >>> 2) & this.mask;
        const index = this.hw.predictor === 'gshare' ? (direct ^ before) & this.mask : direct;
        const taken = this.hw.predictor === 'none' ? false
            : this.hw.predictor === 'static' ? target < address
                : this.table[index] >= 2;
        this.history = ((before << 1) | Number(taken)) & this.mask;
        return { taken, index, before };
    }
    resolve(index, taken) {
        if (this.hw.predictor === 'none' || this.hw.predictor === 'static')
            return;
        const value = this.table[index];
        if (taken && value < 3)
            this.table[index] = value + 1;
        if (!taken && value > 0)
            this.table[index] = value - 1;
    }
    recover(before, taken) {
        this.history = ((before << 1) | Number(taken)) & this.mask;
    }
}
function makeCounters() {
    return {
        fetchedOps: 0, fetchedUops: 0, decodedOps: 0, decodedUops: 0,
        renamedOps: 0, renamedUops: 0, dispatchedOps: 0, dispatchedUops: 0,
        issuedOps: 0, issuedUops: 0, completedOps: 0, completedUops: 0,
        retiredOps: 0, retiredUops: 0, squashedOps: 0, squashedUops: 0,
        frontendFlushedOps: 0, frontendFlushedUops: 0, wrongPathOps: 0, wrongPathBytes: 0,
        branchPredictions: 0, branchMispredicts: 0, branchRecoveryCycles: 0,
        branchSquashedOps: 0, rasHits: 0, rasMisses: 0, forwardedLoads: 0,
        nonaliasBypasses: 0, unknownStoreStalls: 0, overlapStalls: 0,
        partialForwardedLoads: 0, forwardedBytes: 0, storeAddressIssues: 0,
        freeListStallCycles: 0, checkpointStallCycles: 0, indirectRecoveryCycles: 0,
        retireSlots: 0, activeCoreCycles: 0, stalledCoreCycles: 0, idleCoreCycles: 0,
        headBlock: { 'not-complete': 0, 'store-buffer': 0, barrier: 0 },
        operationOrigins: { semantic: 0, lowering: 0, runtime: 0 },
    };
}
export function simulateOoO(program, rawHardware, memory, options = {}) {
    const hw = normalizeHw(rawHardware);
    const profile = validateOoOProfile(options.profile ?? DEFAULT_OOO_PROFILE);
    const decoded = decodeProgram(program.insts);
    const parallel = program.insts.some((inst) => inst.op === Opcode.TID || inst.op === Opcode.NTHREADS);
    const hardwareThreads = Math.max(1, Math.min(MAX_HW_THREADS, hw.threads));
    const requested = parallel
        ? Math.min(hardwareThreads, Math.max(1, options.maxWorkers ?? hardwareThreads))
        : 1;
    const activeThreads = Math.max(1, requested);
    const activeCores = Math.max(1, Math.min(hw.cores, activeThreads));
    if (profile.physicalRegisters <= program.physRegsUsed) {
        throw new Error(`OoO profile has ${profile.physicalRegisters} physical registers but program requires ${program.physRegsUsed} logical registers`);
    }
    const memorySystem = new MemorySystem(hw, memory);
    const counters = makeCounters();
    const occupancy = {
        rob: emptyOccupancy(), rs: emptyOccupancy(), prf: emptyOccupancy(),
        lq: emptyOccupancy(), sq: emptyOccupancy(), storeBuffer: emptyOccupancy(),
    };
    const fuBusyCycles = emptyClassRecord(() => 0);
    const cores = Array.from({ length: hw.cores }, (_, id) => ({
        id,
        threads: [],
        rr: 0,
        fu: emptyClassRecord((() => [])),
        issueProgress: null,
    }));
    for (const core of cores) {
        for (const cls of classes) {
            core.fu[cls] = Array.from({ length: profile.fu[cls].count }, () => ({ nextIssue: 0, busyUntil: 0 }));
        }
    }
    const threads = [];
    const logicalRegs = Math.max(32, program.physRegsUsed);
    for (let id = 0; id < activeThreads; id++) {
        const core = cores[id % activeCores];
        const prf = Array.from({ length: profile.physicalRegisters }, (_, tag) => ({ value: 0, ready: tag < logicalRegs, allocated: tag < logicalRegs, owner: tag < logicalRegs ? `r${tag}` : '' }));
        const thread = {
            id, core: core.id, fetchPc: 0, fetchBlocked: false, recoveryUntil: 0,
            halted: false, barrier: false, result: 0,
            rat: Array.from({ length: logicalRegs }, (_, reg) => reg),
            amt: Array.from({ length: logicalRegs }, (_, reg) => reg),
            resourceRat: new Map(), resourceAmt: new Map(), prf,
            freeList: Array.from({ length: profile.physicalRegisters - logicalRegs }, (_, index) => logicalRegs + index),
            rob: [], rs: emptyClassRecord(() => []), fetchQueue: [], decodeQueue: [],
            fetchProgress: null,
            dispatchQueue: [],
            checkpoints: [], predictor: new OoOPredictor(hw), calls: [],
            spillFrames: [new Float64Array(program.spillSlots)], retiredSequence: 0,
            storeBuffer: [], barrierWaitEpoch: null, barrierReleasedEpoch: -1,
        };
        core.threads.push(thread);
        threads.push(thread);
    }
    let cycle = 0;
    let sequence = 1;
    const completions = [];
    const pendingBranches = [];
    const storeRequest = new Map();
    let storeDrainCore = 0;
    let barrierEpoch = 0;
    const mix = emptyClassRecord(() => 0);
    const allocate = (thread, owner, initial = 0) => {
        const tag = thread.freeList.shift();
        if (tag === undefined)
            return -1;
        const physical = thread.prf[tag];
        physical.allocated = true;
        physical.ready = false;
        physical.value = initial;
        physical.owner = owner;
        return tag;
    };
    const release = (thread, tag) => {
        if (tag < 0)
            return;
        const physical = thread.prf[tag];
        if (!physical.allocated)
            throw new Error(`OoO double-free of physical tag p${tag}`);
        physical.allocated = false;
        physical.ready = false;
        physical.owner = '';
        thread.freeList.push(tag);
    };
    const resourceTag = (thread, name, created) => {
        const existing = thread.resourceRat.get(name);
        if (existing !== undefined)
            return existing;
        const tag = allocate(thread, name);
        if (tag < 0)
            return -1;
        thread.prf[tag].ready = true;
        if (name.startsWith('spill.')) {
            const slot = Number(name.slice('spill.'.length));
            thread.prf[tag].value = thread.spillFrames.at(-1)?.[slot] ?? 0;
        }
        thread.resourceRat.set(name, tag);
        created.push({ name, tag });
        return tag;
    };
    const effectiveAddress = (entry) => {
        const op = entry.decoded.op;
        const tags = new Map();
        srcRegs(op).forEach((reg, index) => tags.set(reg, entry.srcTags[index]));
        const value = (reg) => reg >= 0 ? entry.thread.prf[tags.get(reg)].value : 0;
        return i32(value(op.memBase) + value(op.memIndex) * op.memScale + op.memOff);
    };
    const arithmetic = (entry) => {
        const inst = entry.decoded.op;
        const map = new Map();
        srcRegs(inst).forEach((reg, index) => map.set(reg, entry.srcTags[index]));
        const read = (reg) => reg >= 0 ? entry.thread.prf[map.get(reg)].value : 0;
        const a = read(inst.srcA);
        const b = read(inst.srcB);
        switch (inst.op) {
            case Opcode.LI: return i32(inst.imm);
            case Opcode.LIF: return inst.imm;
            case Opcode.MOV: return a;
            case Opcode.ADD: return i32(a + b);
            case Opcode.SUB: return i32(a - b);
            case Opcode.MUL: return imul(a, b);
            case Opcode.DIV: return idiv(a, b);
            case Opcode.REM: return irem(a, b);
            case Opcode.AND: return i32(a) & i32(b);
            case Opcode.OR: return i32(a) | i32(b);
            case Opcode.XOR: return i32(a) ^ i32(b);
            case Opcode.SHL: return ishl(a, inst.srcB >= 0 ? b : inst.imm);
            case Opcode.SHR: return ishr(a, inst.srcB >= 0 ? b : inst.imm);
            case Opcode.SAR: return isar(a, inst.srcB >= 0 ? b : inst.imm);
            case Opcode.ADDI: return i32(a + inst.imm);
            case Opcode.ADDF: return a + b;
            case Opcode.SUBF: return a - b;
            case Opcode.MULF: return a * b;
            case Opcode.DIVF: return a / b;
            case Opcode.EQF: return a === b ? 1 : 0;
            case Opcode.NEF: return a !== b ? 1 : 0;
            case Opcode.LTF: return a < b ? 1 : 0;
            case Opcode.GEF: return a >= b ? 1 : 0;
            case Opcode.ITOD: return i32(a);
            case Opcode.DTOI: return i32(Math.trunc(a));
            case Opcode.I8: return (i32(a) << 24) >> 24;
            case Opcode.TID:
            case Opcode.PTID: return entry.thread.id;
            case Opcode.NTHREADS:
            case Opcode.PNTHREADS: return activeThreads;
            case Opcode.SPILL_LOAD: {
                for (let i = entry.thread.rob.indexOf(entry) - 1; i >= 0; i--) {
                    const older = entry.thread.rob[i];
                    if (older.decoded.op.op === Opcode.SPILL_STORE && older.decoded.op.imm === inst.imm) {
                        return older.value;
                    }
                }
                return entry.thread.spillFrames.at(-1)?.[inst.imm] ?? 0;
            }
            default: return 0;
        }
    };
    const condition = (entry) => {
        const inst = entry.decoded.op;
        const map = new Map();
        srcRegs(inst).forEach((reg, index) => map.set(reg, entry.srcTags[index]));
        const a = inst.srcA >= 0 ? entry.thread.prf[map.get(inst.srcA)].value : 0;
        const b = inst.srcB >= 0 ? entry.thread.prf[map.get(inst.srcB)].value : 0;
        if (inst.op === Opcode.BEQ)
            return i32(a) === i32(b);
        if (inst.op === Opcode.BNE)
            return i32(a) !== i32(b);
        if (inst.op === Opcode.BLT)
            return i32(a) < i32(b);
        if (inst.op === Opcode.BGE)
            return i32(a) >= i32(b);
        return true;
    };
    const makeStoreBytes = (entry) => {
        const inst = entry.decoded.op;
        const source = inst.srcA >= 0 ? entry.thread.prf[entry.srcTags[srcRegs(inst).indexOf(inst.srcA)]].value : 0;
        const width = accessWidth(inst);
        const bytes = new Uint8Array(width);
        const view = new DataView(bytes.buffer);
        if (width === 1)
            view.setInt8(0, i32(source));
        else if (width === 4)
            view.setInt32(0, i32(source), true);
        else
            view.setFloat64(0, source, true);
        return bytes;
    };
    const bytesToValue = (bytes) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length === 1)
            return view.getInt8(0);
        if (bytes.length === 4)
            return view.getInt32(0, true);
        return view.getFloat64(0, true);
    };
    const overlap = (a, aw, b, bw) => a < b + bw && b < a + aw;
    const loadDependency = (entry) => {
        const address = effectiveAddress(entry);
        const width = accessWidth(entry.decoded.op);
        const bytes = new Uint8Array(width);
        const mask = new Uint8Array(width);
        let sawNonalias = false;
        for (let index = entry.thread.rob.indexOf(entry) - 1; index >= 0; index--) {
            const older = entry.thread.rob[index];
            if (!isRealStore(older.decoded.op))
                continue;
            if (older.address === undefined)
                return { stall: 'unknown' };
            const olderWidth = accessWidth(older.decoded.op);
            if (!overlap(address, width, older.address, olderWidth)) {
                sawNonalias = true;
                continue;
            }
            if (!older.dataReady || !older.storeBytes)
                return { stall: 'overlap' };
            for (let loadByte = 0; loadByte < width; loadByte++) {
                const absolute = address + loadByte;
                const storeByte = absolute - older.address;
                if (storeByte >= 0 && storeByte < older.storeBytes.length && mask[loadByte] === 0) {
                    bytes[loadByte] = older.storeBytes[storeByte];
                    mask[loadByte] = 1;
                }
            }
        }
        for (let index = entry.thread.storeBuffer.length - 1; index >= 0; index--) {
            const older = entry.thread.storeBuffer[index];
            if (!overlap(address, width, older.address, older.bytes.length))
                continue;
            for (let loadByte = 0; loadByte < width; loadByte++) {
                const absolute = address + loadByte;
                const storeByte = absolute - older.address;
                if (storeByte >= 0 && storeByte < older.bytes.length && mask[loadByte] === 0) {
                    bytes[loadByte] = older.bytes[storeByte];
                    mask[loadByte] = 1;
                }
            }
        }
        if (sawNonalias)
            counters.nonaliasBypasses += 1;
        const forwardedBytes = mask.reduce((sum, value) => sum + Number(value !== 0), 0);
        return forwardedBytes > 0 ? { forwarded: { bytes, mask } } : {};
    };
    const squashAfter = (branch, correctPc) => {
        const thread = branch.thread;
        const checkpoint = branch.checkpoint;
        if (!checkpoint)
            throw new Error(`OoO branch ${branch.seq} lacks checkpoint`);
        const younger = thread.rob.filter((entry) => entry.seq > branch.seq);
        for (let index = younger.length - 1; index >= 0; index--) {
            const entry = younger[index];
            entry.squashed = true;
            if (entry.memoryRequest !== undefined)
                memorySystem.markWrongPath(entry.memoryRequest);
            memorySystem.markWrongPath(entry.fetchRequest);
            memorySystem.releaseRequest(entry.fetchRequest);
            if (entry.memoryRequest !== undefined)
                memorySystem.releaseRequest(entry.memoryRequest);
            if (entry.destTag >= 0)
                release(thread, entry.destTag);
            for (const resource of entry.resources)
                release(thread, resource.newTag);
            for (const created of entry.createdResourceTags)
                release(thread, created.tag);
            counters.squashedOps += 1;
            counters.squashedUops += entry.decoded.uops;
            counters.branchSquashedOps += 1;
            counters.wrongPathOps += 1;
            counters.wrongPathBytes += entry.decoded.bytes;
        }
        const youngerSet = new Set(younger);
        thread.rob = thread.rob.filter((entry) => !youngerSet.has(entry));
        for (const cls of classes)
            thread.rs[cls] = thread.rs[cls].filter((entry) => !youngerSet.has(entry));
        thread.dispatchQueue = thread.dispatchQueue.filter((entry) => !youngerSet.has(entry));
        const core = cores[thread.core];
        if (core.issueProgress && youngerSet.has(core.issueProgress))
            core.issueProgress = null;
        thread.rat = [...checkpoint.rat];
        thread.resourceRat = new Map(checkpoint.resourceRat);
        thread.checkpoints = thread.checkpoints.filter((item) => item.branchSeq < branch.seq);
        const frontend = [
            ...thread.fetchQueue,
            ...thread.decodeQueue,
            ...(thread.fetchProgress ? [thread.fetchProgress] : []),
        ];
        const admittedFrontend = frontend.filter((item) => item.fetchAdmitted > 0);
        counters.frontendFlushedOps += admittedFrontend.length;
        counters.frontendFlushedUops += admittedFrontend.reduce((sum, item) => sum + item.fetchAdmitted, 0);
        counters.wrongPathOps += admittedFrontend.length;
        counters.wrongPathBytes += admittedFrontend.reduce((sum, item) => sum + Math.ceil(item.decoded.bytes * item.fetchAdmitted / item.decoded.uops), 0);
        for (const item of frontend) {
            memorySystem.markWrongPath(item.fetchRequest);
            memorySystem.releaseRequest(item.fetchRequest);
        }
        thread.fetchQueue = [];
        thread.decodeQueue = [];
        thread.fetchProgress = null;
        thread.predictor.recover(branch.historyBefore ?? checkpoint.history, correctPc === branch.decoded.op.target);
        thread.fetchPc = correctPc;
        thread.fetchBlocked = false;
        thread.recoveryUntil = cycle + profile.recoveryCycles;
        counters.branchRecoveryCycles += profile.recoveryCycles;
    };
    const assertLiveState = () => {
        for (const thread of threads) {
            for (const front of [
                ...thread.fetchQueue,
                ...thread.decodeQueue,
                ...(thread.fetchProgress ? [thread.fetchProgress] : []),
            ]) {
                const total = front.decoded.uops;
                if (front.fetchRemaining + front.fetchAdmitted !== total ||
                    front.decodeRemaining + front.decodeAdmitted !== total ||
                    front.renameRemaining + front.renameAdmitted !== total ||
                    front.fetchAdmitted < front.decodeAdmitted ||
                    front.decodeAdmitted < front.renameAdmitted) {
                    throw new Error(`OoO frontend progress invariant failed for thread ${thread.id} pc ${front.decoded.pc}`);
                }
            }
            if (thread.rob.length > profile.robEntries) {
                throw new Error(`OoO ROB capacity exceeded in thread ${thread.id}`);
            }
            const loads = thread.rob.filter((entry) => isRealLoad(entry.decoded.op)).length;
            const stores = thread.rob.filter((entry) => isRealStore(entry.decoded.op)).length;
            if (loads > profile.loadQueueEntries || stores > profile.storeQueueEntries) {
                throw new Error(`OoO LSQ capacity exceeded in thread ${thread.id}`);
            }
            if (thread.storeBuffer.length > profile.storeBufferEntries) {
                throw new Error(`OoO store-buffer capacity exceeded in thread ${thread.id}`);
            }
            if (thread.checkpoints.length > profile.checkpoints) {
                throw new Error(`OoO checkpoint capacity exceeded in thread ${thread.id}`);
            }
            const robSet = new Set(thread.rob);
            const rsSet = new Set();
            for (const cls of classes) {
                if (thread.rs[cls].length > profile.rsEntries[cls]) {
                    throw new Error(`OoO ${cls} RS capacity exceeded in thread ${thread.id}`);
                }
                for (const entry of thread.rs[cls]) {
                    if (!robSet.has(entry) || entry.decoded.op.cls !== cls || entry.issued || !entry.inRs) {
                        throw new Error(`OoO ${cls} RS reference invariant failed for entry ${entry.seq}`);
                    }
                    if (rsSet.has(entry))
                        throw new Error(`OoO entry ${entry.seq} appears in multiple RS queues`);
                    rsSet.add(entry);
                }
            }
            for (const entry of thread.dispatchQueue) {
                if (!robSet.has(entry) || entry.inRs || entry.issued) {
                    throw new Error(`OoO dispatch reference invariant failed for entry ${entry.seq}`);
                }
                if (entry.dispatchRemaining + entry.dispatchAdmitted !== entry.decoded.uops) {
                    throw new Error(`OoO dispatch progress invariant failed for entry ${entry.seq}`);
                }
            }
            for (const checkpoint of thread.checkpoints) {
                const branch = thread.rob.find((entry) => entry.seq === checkpoint.branchSeq);
                if (!branch || !isConditional(branch.decoded.op) || branch.completed) {
                    throw new Error(`OoO checkpoint ${checkpoint.branchSeq} lacks unresolved branch owner`);
                }
            }
            const free = new Set(thread.freeList);
            if (free.size !== thread.freeList.length) {
                throw new Error(`OoO free-list duplicate in thread ${thread.id}`);
            }
            const owners = new Set([
                ...thread.rat,
                ...thread.amt,
                ...thread.resourceRat.values(),
                ...thread.resourceAmt.values(),
            ]);
            for (const entry of thread.rob) {
                if (entry.destTag >= 0)
                    owners.add(entry.destTag);
                if (entry.oldTag >= 0)
                    owners.add(entry.oldTag);
                for (const resource of entry.resources) {
                    owners.add(resource.oldTag);
                    owners.add(resource.newTag);
                }
                for (const created of entry.createdResourceTags)
                    owners.add(created.tag);
            }
            const ownerNames = new Set();
            for (let tag = 0; tag < thread.prf.length; tag++) {
                const physical = thread.prf[tag];
                const allocated = physical.allocated;
                const owned = owners.has(tag);
                if (allocated !== owned || free.has(tag) === allocated) {
                    throw new Error(`OoO live tag ownership failed for thread ${thread.id} p${tag}: ` +
                        `allocated=${allocated}, owned=${owned}, free=${free.has(tag)}`);
                }
                if (allocated) {
                    if (!physical.owner || ownerNames.has(physical.owner)) {
                        throw new Error(`OoO physical tag owner is missing or duplicated in thread ${thread.id}: ${physical.owner}`);
                    }
                    ownerNames.add(physical.owner);
                }
                else if (physical.owner) {
                    throw new Error(`OoO free physical tag p${tag} retains owner ${physical.owner}`);
                }
            }
        }
    };
    const maxCycles = options.maxCycles ?? MAX_CYCLES;
    while (cycle < maxCycles) {
        // 1. Memory/FU completion.
        const memoryDone = memorySystem.complete(cycle);
        for (const completed of memoryDone) {
            const buffered = storeRequest.get(completed.id);
            if (buffered) {
                memorySystem.writeBytes(buffered.address, buffered.bytes);
                const owner = threads[buffered.threadId];
                if (owner.storeBuffer[0] !== buffered) {
                    throw new Error(`Store visibility FIFO failed for thread ${buffered.threadId}`);
                }
                owner.storeBuffer.shift();
                storeRequest.delete(completed.id);
                memorySystem.releaseRequest(completed.id);
            }
        }
        const due = completions
            .filter((event) => event.cycle <= cycle)
            .sort((a, b) => a.cycle - b.cycle || a.seq - b.seq);
        if (due.length) {
            const dueSet = new Set(due);
            for (let index = completions.length - 1; index >= 0; index--) {
                if (dueSet.has(completions[index]))
                    completions.splice(index, 1);
            }
        }
        for (const event of due) {
            const entry = event.rob;
            if (entry.squashed)
                continue;
            const inst = entry.decoded.op;
            try {
                if (entry.exception) {
                    // Fault is carried to in-order retirement; wrong-path squash drops it.
                }
                else if (isRealLoad(inst)) {
                    const address = entry.address;
                    const width = accessWidth(inst);
                    checkMemoryAccess(`OoO ${inst.op}`, address, width, memory.byteLength);
                    const bytes = memorySystem.readBytes(address, width);
                    if (event.forwarded) {
                        for (let index = 0; index < width; index++) {
                            if (event.forwarded.mask[index])
                                bytes[index] = event.forwarded.bytes[index];
                        }
                    }
                    entry.value = bytesToValue(bytes);
                }
                else if (isRealStore(inst)) {
                    entry.storeBytes = makeStoreBytes(entry);
                    entry.dataReady = true;
                }
                else if (inst.op === Opcode.SPILL_STORE) {
                    entry.value = entry.thread.prf[entry.srcTags[srcRegs(inst).indexOf(inst.srcA)]].value;
                }
                else if (isConditional(inst)) {
                    const taken = condition(entry);
                    entry.actualNext = taken ? inst.target : entry.decoded.pc + 1;
                    pendingBranches.push(entry);
                }
                else if (inst.op === Opcode.BR) {
                    entry.actualNext = inst.target;
                }
                else {
                    entry.value = arithmetic(entry);
                }
            }
            catch (error) {
                entry.exception = error instanceof Error ? error : new Error(String(error));
            }
            entry.completed = true;
            if (entry.destTag >= 0) {
                entry.thread.prf[entry.destTag].value = entry.value;
                entry.thread.prf[entry.destTag].ready = true;
            }
            for (const resource of entry.resources) {
                entry.thread.prf[resource.newTag].value = inst.op === Opcode.SPILL_STORE
                    ? entry.value
                    : entry.thread.prf[resource.oldTag]?.value ?? 0;
                entry.thread.prf[resource.newTag].ready = true;
            }
            counters.completedOps += 1;
            counters.completedUops += entry.decoded.uops;
        }
        // 2. Branch resolution and precise squash.
        pendingBranches.sort((a, b) => a.seq - b.seq);
        while (pendingBranches.length) {
            const branch = pendingBranches.shift();
            if (branch.squashed)
                continue;
            const taken = branch.actualNext === branch.decoded.op.target;
            branch.thread.checkpoints = branch.thread.checkpoints.filter((checkpoint) => checkpoint.branchSeq !== branch.seq);
            if (!profile.speculateConditionalBranches) {
                branch.thread.fetchPc = branch.actualNext;
                branch.thread.fetchBlocked = false;
                continue;
            }
            branch.thread.predictor.resolve(branch.predictorIndex ?? 0, taken);
            if (branch.actualNext !== branch.predictedNext) {
                counters.branchMispredicts += 1;
                squashAfter(branch, branch.actualNext);
            }
        }
        // 3. Store-buffer drain.
        let storeIssued = false;
        for (let coreOffset = 0; coreOffset < cores.length && !storeIssued; coreOffset++) {
            const core = cores[(storeDrainCore + coreOffset) % cores.length];
            for (let threadOffset = 0; threadOffset < core.threads.length; threadOffset++) {
                const thread = core.threads[(core.rr + threadOffset) % core.threads.length];
                const buffered = thread.storeBuffer[0];
                if (!buffered || buffered.requestId !== undefined)
                    continue;
                const request = memorySystem.committedStore(buffered.core, buffered.address, buffered.bytes.length, cycle);
                buffered.requestId = request.id;
                storeRequest.set(request.id, buffered);
                storeDrainCore = (core.id + 1) % cores.length;
                storeIssued = true;
                break;
            }
        }
        // 4. In-order retirement per hardware thread.
        let retiredThisCycle = 0;
        for (const thread of threads) {
            let slots = profile.retireWidth;
            while (slots > 0 && thread.rob.length) {
                const head = thread.rob[0];
                if (!head.completed) {
                    counters.headBlock['not-complete'] += 1;
                    break;
                }
                if (head.exception)
                    throw head.exception;
                const inst = head.decoded.op;
                if (isRealStore(inst) && thread.storeBuffer.length >= profile.storeBufferEntries) {
                    counters.headBlock['store-buffer'] += 1;
                    break;
                }
                if (inst.op === Opcode.BARRIER) {
                    if (thread.storeBuffer.length > 0) {
                        counters.headBlock['store-buffer'] += 1;
                        break;
                    }
                    if (thread.barrierReleasedEpoch < barrierEpoch) {
                        thread.barrierWaitEpoch = barrierEpoch;
                        thread.barrier = true;
                        counters.headBlock.barrier += 1;
                        break;
                    }
                }
                const retireConsumed = Math.min(slots, head.retireRemaining);
                head.retireRemaining -= retireConsumed;
                slots -= retireConsumed;
                if (head.retireRemaining > 0) {
                    break;
                }
                if (head.seq <= thread.retiredSequence) {
                    throw new Error(`OoO retirement order failed for thread ${thread.id}: ${head.seq}`);
                }
                thread.retiredSequence = head.seq;
                thread.rob.shift();
                memorySystem.releaseRequest(head.fetchRequest);
                if (head.memoryRequest !== undefined)
                    memorySystem.releaseRequest(head.memoryRequest);
                if (head.destTag >= 0) {
                    thread.amt[inst.dst] = head.destTag;
                    release(thread, head.oldTag);
                }
                for (const resource of head.resources) {
                    thread.resourceAmt.set(resource.name, resource.newTag);
                    release(thread, resource.oldTag);
                }
                const writtenResources = new Set(head.resources.map((resource) => resource.name));
                for (const created of head.createdResourceTags) {
                    if (!writtenResources.has(created.name)) {
                        thread.resourceAmt.set(created.name, created.tag);
                    }
                }
                if (isRealStore(inst)) {
                    thread.storeBuffer.push({
                        seq: head.seq,
                        threadId: thread.id,
                        core: thread.core,
                        address: head.address,
                        bytes: head.storeBytes,
                    });
                }
                if (inst.op === Opcode.SPILL_STORE) {
                    const frame = thread.spillFrames.at(-1);
                    if (!frame || inst.imm < 0 || inst.imm >= frame.length) {
                        throw new Error(`Allocator spill fault: store slot ${inst.imm}`);
                    }
                    frame[inst.imm] = head.value;
                }
                else if (inst.op === Opcode.CSTACK_CHECK) {
                    const value = inst.srcA >= 0 ? thread.prf[head.srcTags[srcRegs(inst).indexOf(inst.srcA)]].value : 0;
                    const low = C_STACK_BASE + thread.id * C_STACK_STRIDE;
                    const high = low + C_STACK_STRIDE;
                    const valid = inst.imm === 1
                        ? i32(value) >= low && i32(value) <= low + C_PARK_BYTES
                        : i32(value) >= low + C_PARK_BYTES && i32(value) <= high;
                    if (!valid)
                        throw new Error(`Guest C stack fault for worker ${thread.id} at address ${i32(value)}`);
                }
                else if (inst.op === Opcode.CALL || inst.op === Opcode.ICALL) {
                    if (thread.calls.length >= MAX_CALL_DEPTH)
                        throw new Error(`Call depth exceeds ${MAX_CALL_DEPTH}`);
                    const returnPc = head.decoded.pc + 1;
                    const rasHit = thread.calls.length < hw.rasDepth;
                    thread.calls.push({
                        pc: returnPc,
                        saved: (inst.saveRegs ?? []).map((reg) => [reg, thread.prf[thread.amt[reg]].value]),
                        savedSpills: new Set(inst.saveSpills ?? []),
                        rasHit,
                    });
                    thread.spillFrames.push(thread.spillFrames.at(-1).slice());
                    const target = inst.op === Opcode.CALL
                        ? inst.target
                        : i32(thread.prf[head.srcTags[srcRegs(inst).indexOf(inst.srcA)]].value);
                    thread.fetchPc = target;
                    thread.fetchBlocked = false;
                    if (inst.op === Opcode.ICALL && hw.indirectCallPenalty > 0) {
                        thread.recoveryUntil = Math.max(thread.recoveryUntil, cycle + hw.indirectCallPenalty);
                        counters.indirectRecoveryCycles += hw.indirectCallPenalty;
                    }
                }
                else if (inst.op === Opcode.RET) {
                    const frame = thread.calls.pop();
                    if (!frame)
                        throw new Error('RET with empty call stack');
                    for (const [reg, value] of frame.saved)
                        thread.prf[thread.amt[reg]].value = value;
                    const callee = thread.spillFrames.pop();
                    const caller = thread.spillFrames.at(-1);
                    if (!callee || !caller)
                        throw new Error('Allocator spill frame underflow on RET');
                    for (let slot = 0; slot < callee.length; slot++) {
                        if (!frame.savedSpills.has(slot))
                            caller[slot] = callee[slot];
                    }
                    if (frame.rasHit)
                        counters.rasHits += 1;
                    else {
                        counters.rasMisses += 1;
                        thread.recoveryUntil = Math.max(thread.recoveryUntil, cycle + hw.indirectCallPenalty);
                        counters.indirectRecoveryCycles += hw.indirectCallPenalty;
                    }
                    thread.fetchPc = frame.pc;
                    thread.fetchBlocked = false;
                }
                else if (inst.op === Opcode.HALT) {
                    thread.result = inst.srcA >= 0
                        ? thread.prf[head.srcTags[srcRegs(inst).indexOf(inst.srcA)]].value
                        : 0;
                    thread.halted = true;
                    thread.fetchBlocked = true;
                }
                else if (inst.op === Opcode.BARRIER) {
                    thread.barrier = false;
                    thread.barrierWaitEpoch = null;
                    thread.fetchPc = head.decoded.pc + 1;
                    thread.fetchBlocked = false;
                }
                if (inst.serializing && ![
                    Opcode.CALL, Opcode.ICALL, Opcode.RET, Opcode.HALT, Opcode.BARRIER,
                ].includes(inst.op)) {
                    thread.fetchPc = head.decoded.pc + 1;
                    thread.fetchBlocked = false;
                }
                if (isConditional(inst)) {
                    if (!profile.speculateConditionalBranches) {
                        thread.fetchPc = head.actualNext;
                        thread.fetchBlocked = false;
                    }
                }
                counters.retiredOps += 1;
                counters.retiredUops += head.decoded.uops;
                counters.operationOrigins[inst.origin] += 1;
                mix[inst.cls] += 1;
                retiredThisCycle += 1;
            }
            counters.retireSlots += profile.retireWidth - slots;
        }
        // 5. Barrier release.
        const waitingAtBarrier = threads.filter((thread) => thread.barrierWaitEpoch === barrierEpoch);
        if (waitingAtBarrier.length > 0) {
            const earlyHalt = threads.find((thread) => thread.halted && thread.barrierWaitEpoch !== barrierEpoch);
            if (earlyHalt) {
                throw new Error(`Divergent barrier epoch ${barrierEpoch}: thread ${earlyHalt.id} halted before all participants arrived`);
            }
            if (waitingAtBarrier.length === threads.length &&
                threads.every((thread) => thread.storeBuffer.length === 0)) {
                for (const thread of threads) {
                    thread.barrierReleasedEpoch = barrierEpoch;
                    thread.barrier = false;
                }
            }
        }
        else if (threads.every((thread) => thread.barrierReleasedEpoch === barrierEpoch)) {
            barrierEpoch += 1;
        }
        // 6. Oldest-ready deterministic issue, sharing each core's FUs.
        let issuedThisCycle = 0;
        const activeCoreSet = new Set();
        for (const core of cores) {
            let issueSlots = profile.issueWidth;
            for (const thread of core.threads) {
                for (const entry of thread.rs.st) {
                    if (!isRealStore(entry.decoded.op) || entry.addressReady ||
                        !entry.addressTags.every((tag) => thread.prf[tag].ready))
                        continue;
                    try {
                        entry.address = effectiveAddress(entry);
                        checkMemoryAccess(`OoO ${entry.decoded.op.op}`, entry.address, accessWidth(entry.decoded.op), memory.byteLength);
                        entry.addressReady = true;
                        counters.storeAddressIssues += 1;
                    }
                    catch (error) {
                        entry.exception = error instanceof Error ? error : new Error(String(error));
                        entry.addressReady = true;
                    }
                }
            }
            const blockedIssue = new Set();
            while (issueSlots > 0) {
                let entry = core.issueProgress;
                if (!entry) {
                    const candidates = core.threads
                        .flatMap((thread) => classes.flatMap((cls) => thread.rs[cls]))
                        .filter((candidate) => !candidate.issued && !candidate.squashed && !blockedIssue.has(candidate.seq))
                        .sort((a, b) => a.seq - b.seq);
                    entry = candidates.find((candidate) => {
                        const thread = candidate.thread;
                        const inst = candidate.decoded.op;
                        const ordinaryReady = candidate.srcTags.every((tag) => thread.prf[tag].ready);
                        const resourceReady = candidate.resourceSources.every((tag) => thread.prf[tag].ready);
                        if (!resourceReady)
                            return false;
                        if (!core.fu[inst.cls].some((unit) => unit.nextIssue <= cycle))
                            return false;
                        if (isRealStore(inst)) {
                            return candidate.addressReady &&
                                (candidate.dataTag < 0 || thread.prf[candidate.dataTag].ready);
                        }
                        return ordinaryReady;
                    }) ?? null;
                    if (!entry)
                        break;
                    const cls = entry.decoded.fuClass;
                    const units = core.fu[cls];
                    let unit = -1;
                    for (let index = 0; index < units.length; index++) {
                        if (units[index].nextIssue <= cycle) {
                            unit = index;
                            break;
                        }
                    }
                    if (unit < 0)
                        break;
                    if (isRealLoad(entry.decoded.op)) {
                        const dependency = loadDependency(entry);
                        if (dependency.stall === 'unknown') {
                            counters.unknownStoreStalls += 1;
                            blockedIssue.add(entry.seq);
                            continue;
                        }
                        if (dependency.stall === 'overlap') {
                            counters.overlapStalls += 1;
                            blockedIssue.add(entry.seq);
                            continue;
                        }
                        entry.loadForwarding = dependency.forwarded;
                        if (dependency.forwarded) {
                            const count = dependency.forwarded.mask.reduce((sum, value) => sum + Number(value !== 0), 0);
                            counters.forwardedLoads += 1;
                            counters.forwardedBytes += count;
                            if (count < accessWidth(entry.decoded.op))
                                counters.partialForwardedLoads += 1;
                        }
                    }
                    entry.issueUnit = unit;
                    core.issueProgress = entry;
                }
                const consumed = Math.min(issueSlots, entry.issueRemaining);
                entry.issueRemaining -= consumed;
                issueSlots -= consumed;
                activeCoreSet.add(core.id);
                if (entry.issueRemaining > 0)
                    break;
                core.issueProgress = null;
                entry.issued = true;
                const cls = entry.decoded.fuClass;
                const unit = core.fu[cls][entry.issueUnit];
                unit.nextIssue = cycle + profile.fu[cls].initiationInterval;
                unit.busyUntil = Math.max(unit.busyUntil, cycle + profile.fu[cls].latency);
                const baseLatency = profile.fu[cls].latency;
                let ready = cycle + baseLatency;
                const fullyForwarded = entry.loadForwarding !== undefined &&
                    entry.loadForwarding.mask.every((value) => value !== 0);
                if (isRealLoad(entry.decoded.op)) {
                    try {
                        entry.address = effectiveAddress(entry);
                        checkMemoryAccess(`OoO ${entry.decoded.op.op}`, entry.address, accessWidth(entry.decoded.op), memory.byteLength);
                        if (!fullyForwarded) {
                            const request = memorySystem.speculativeLoad(core.id, entry.address, accessWidth(entry.decoded.op), cycle);
                            entry.memoryRequest = request.id;
                            ready = Math.max(ready, request.readyCycle + baseLatency);
                        }
                    }
                    catch (error) {
                        entry.exception = error instanceof Error ? error : new Error(String(error));
                    }
                }
                else if (entry.decoded.op.op === Opcode.SPILL_STORE) {
                    entry.value = entry.thread.prf[entry.srcTags[srcRegs(entry.decoded.op).indexOf(entry.decoded.op.srcA)]].value;
                }
                else if (isRealStore(entry.decoded.op)) {
                    entry.value = entry.decoded.op.srcA >= 0
                        ? entry.thread.prf[entry.dataTag].value
                        : 0;
                }
                const station = entry.thread.rs[cls];
                const stationIndex = station.indexOf(entry);
                if (stationIndex < 0)
                    throw new Error(`Issued entry ${entry.seq} is absent from ${cls} RS`);
                station.splice(stationIndex, 1);
                entry.inRs = false;
                completions.push({
                    cycle: ready,
                    seq: entry.seq,
                    rob: entry,
                    forwarded: entry.loadForwarding,
                });
                counters.issuedOps += 1;
                counters.issuedUops += entry.decoded.uops;
                issuedThisCycle += 1;
            }
        }
        // 7. Dispatch then rename. Multi-uop operations monopolize a stage until
        // their remaining uops reach zero; no operation can permanently exceed a width.
        for (const core of cores) {
            let dispatchSlots = profile.dispatchWidth;
            for (let offset = 0; offset < core.threads.length && dispatchSlots > 0; offset++) {
                const thread = core.threads[(core.rr + offset) % core.threads.length];
                while (thread.dispatchQueue.length && dispatchSlots > 0) {
                    const entry = thread.dispatchQueue[0];
                    const cls = entry.decoded.op.cls;
                    if (entry.dispatchRemaining === entry.decoded.uops &&
                        thread.rs[cls].length >= profile.rsEntries[cls])
                        break;
                    const consumed = Math.min(dispatchSlots, entry.dispatchRemaining);
                    entry.dispatchRemaining -= consumed;
                    entry.dispatchAdmitted += consumed;
                    dispatchSlots -= consumed;
                    if (entry.dispatchRemaining > 0)
                        break;
                    thread.dispatchQueue.shift();
                    thread.rs[cls].push(entry);
                    entry.inRs = true;
                    counters.dispatchedOps += 1;
                    counters.dispatchedUops += entry.decoded.uops;
                }
            }
            let renameSlots = profile.renameWidth;
            for (let offset = 0; offset < core.threads.length && renameSlots > 0; offset++) {
                const thread = core.threads[(core.rr + offset) % core.threads.length];
                while (thread.decodeQueue.length && renameSlots > 0) {
                    const front = thread.decodeQueue[0];
                    const op = front.decoded.op;
                    if (thread.rob.length >= profile.robEntries)
                        break;
                    if (isRealLoad(op) && thread.rob.filter((entry) => isRealLoad(entry.decoded.op)).length >= profile.loadQueueEntries)
                        break;
                    if (isRealStore(op) && thread.rob.filter((entry) => isRealStore(entry.decoded.op)).length >= profile.storeQueueEntries)
                        break;
                    if (isSerialized(op) && (thread.rob.length > 0 || thread.storeBuffer.length > 0))
                        break;
                    if (isConditional(op) && thread.checkpoints.length >= profile.checkpoints) {
                        counters.checkpointStallCycles += 1;
                        break;
                    }
                    const missingResources = new Set([...op.resourceReads, ...op.resourceWrites]);
                    for (const name of thread.resourceRat.keys())
                        missingResources.delete(name);
                    const neededTags = Number(op.dst >= 0) + op.resourceWrites.length + missingResources.size;
                    if (thread.freeList.length < neededTags) {
                        counters.freeListStallCycles += 1;
                        break;
                    }
                    const renameConsumed = Math.min(renameSlots, front.renameRemaining);
                    front.renameRemaining -= renameConsumed;
                    front.renameAdmitted += renameConsumed;
                    renameSlots -= renameConsumed;
                    if (front.renameRemaining > 0)
                        break;
                    const sources = srcRegs(op).map((reg) => thread.rat[reg]);
                    const sourceMap = new Map();
                    srcRegs(op).forEach((reg, index) => sourceMap.set(reg, sources[index]));
                    const createdResourceTags = [];
                    const resourceSources = [];
                    for (const name of op.resourceReads) {
                        const tag = resourceTag(thread, name, createdResourceTags);
                        if (tag < 0)
                            throw new Error(`OoO failed to initialize hidden resource ${name}`);
                        resourceSources.push(tag);
                    }
                    let destTag = -1;
                    let oldTag = -1;
                    if (op.dst >= 0) {
                        oldTag = thread.rat[op.dst];
                        destTag = allocate(thread, `r${op.dst}@${sequence}`);
                        if (destTag < 0)
                            throw new Error('OoO free-list underflow during rename');
                        thread.rat[op.dst] = destTag;
                    }
                    const resources = [];
                    for (const name of op.resourceWrites) {
                        const previous = resourceTag(thread, name, createdResourceTags);
                        const next = allocate(thread, `${name}@${sequence}`);
                        if (previous < 0 || next < 0)
                            throw new Error(`OoO hidden-resource rename failed for ${name}`);
                        resources.push({ name, oldTag: previous, newTag: next });
                        thread.resourceRat.set(name, next);
                    }
                    const entry = {
                        seq: sequence++, thread, decoded: front.decoded, srcTags: sources,
                        destTag, oldTag, resources, resourceSources, createdResourceTags,
                        issued: false, inRs: false, completed: false,
                        squashed: false, value: 0, predictedNext: front.predictedNext,
                        predictedTaken: front.predictedTaken, predictorIndex: front.predictorIndex,
                        historyBefore: front.historyBefore, wrongPath: front.wrongPath,
                        fetchRequest: front.fetchRequest,
                        dispatchRemaining: front.decoded.uops,
                        dispatchAdmitted: 0,
                        issueRemaining: front.decoded.uops,
                        retireRemaining: front.decoded.uops,
                        addressTags: [op.memBase, op.memIndex]
                            .filter((reg) => reg >= 0)
                            .map((reg) => sourceMap.get(reg)),
                        dataTag: op.srcA >= 0 ? sourceMap.get(op.srcA) : -1,
                        addressReady: !isRealStore(op),
                        dataReady: !isRealStore(op),
                        issueUnit: -1,
                    };
                    if (isConditional(op)) {
                        entry.checkpoint = {
                            branchSeq: entry.seq,
                            rat: [...thread.rat],
                            resourceRat: new Map(thread.resourceRat),
                            history: front.historyBefore ?? thread.predictor.history,
                        };
                        thread.checkpoints.push(entry.checkpoint);
                    }
                    thread.decodeQueue.shift();
                    thread.rob.push(entry);
                    thread.dispatchQueue.push(entry);
                    counters.renamedOps += 1;
                    counters.renamedUops += front.decoded.uops;
                }
            }
            core.rr = (core.rr + 1) % Math.max(1, core.threads.length);
        }
        // 8. Decode.
        for (const core of cores) {
            let decodeSlots = profile.decodeWidth;
            for (const thread of core.threads) {
                while (thread.fetchQueue.length && decodeSlots > 0) {
                    const front = thread.fetchQueue[0];
                    if (!memorySystem.isComplete(front.fetchRequest))
                        break;
                    const consumed = Math.min(decodeSlots, front.decodeRemaining);
                    front.decodeRemaining -= consumed;
                    front.decodeAdmitted += consumed;
                    if (front.decodeAdmitted === consumed)
                        counters.decodedOps += 1;
                    counters.decodedUops += consumed;
                    decodeSlots -= consumed;
                    if (front.decodeRemaining > 0)
                        break;
                    thread.fetchQueue.shift();
                    thread.decodeQueue.push(front);
                }
            }
        }
        // 9. Fetch.
        for (const core of cores) {
            let fetchSlots = profile.fetchWidth;
            for (const thread of core.threads) {
                if (thread.halted || thread.fetchBlocked || thread.recoveryUntil > cycle)
                    continue;
                while (fetchSlots > 0 && thread.fetchQueue.length < profile.decodeWidth * 2) {
                    let front = thread.fetchProgress;
                    if (!front) {
                        if (thread.fetchPc < 0 || thread.fetchPc >= decoded.length) {
                            throw new Error(`OoO fetch PC ${thread.fetchPc} is outside program`);
                        }
                        const op = decoded[thread.fetchPc];
                        let predictedNext = op.pc + 1;
                        let predictedTaken;
                        let predictorIndex;
                        let historyBefore;
                        if (isConditional(op.op)) {
                            counters.branchPredictions += 1;
                            if (profile.speculateConditionalBranches) {
                                const prediction = thread.predictor.predict(op.address, decoded[op.op.target]?.address ?? op.address);
                                predictedTaken = prediction.taken;
                                predictorIndex = prediction.index;
                                historyBefore = prediction.before;
                                predictedNext = prediction.taken ? op.op.target : op.pc + 1;
                            }
                            else {
                                predictedNext = op.pc;
                            }
                        }
                        else if (op.op.op === Opcode.BR) {
                            predictedNext = op.op.target;
                        }
                        else if (isSerialized(op.op)) {
                            predictedNext = op.pc;
                        }
                        const request = memorySystem.instructionFetch(core.id, op.address, op.bytes, cycle);
                        front = {
                            decoded: op,
                            predictedNext,
                            predictedTaken,
                            predictorIndex,
                            historyBefore,
                            wrongPath: false,
                            fetchRequest: request.id,
                            fetchRemaining: op.uops,
                            decodeRemaining: op.uops,
                            renameRemaining: op.uops,
                            fetchAdmitted: 0,
                            decodeAdmitted: 0,
                            renameAdmitted: 0,
                        };
                        thread.fetchProgress = front;
                    }
                    if (!memorySystem.isComplete(front.fetchRequest))
                        break;
                    const consumed = Math.min(fetchSlots, front.fetchRemaining);
                    front.fetchRemaining -= consumed;
                    front.fetchAdmitted += consumed;
                    if (front.fetchAdmitted === consumed)
                        counters.fetchedOps += 1;
                    counters.fetchedUops += consumed;
                    fetchSlots -= consumed;
                    if (front.fetchRemaining > 0)
                        break;
                    thread.fetchProgress = null;
                    thread.fetchQueue.push(front);
                    thread.fetchPc = front.predictedNext;
                    if ((isConditional(front.decoded.op) && !profile.speculateConditionalBranches) ||
                        isSerialized(front.decoded.op)) {
                        thread.fetchBlocked = true;
                    }
                    if (thread.fetchBlocked)
                        break;
                }
            }
        }
        // 10. Residency and bounded occupancy accounting.
        const rsCount = threads.reduce((sum, thread) => sum + classes.reduce((n, cls) => n + thread.rs[cls].length, 0), 0);
        const robCount = threads.reduce((sum, thread) => sum + thread.rob.length, 0);
        const prfCount = threads.reduce((sum, thread) => sum + thread.prf.filter((physical) => physical.allocated).length, 0);
        const lqCount = threads.reduce((sum, thread) => sum + thread.rob.filter((entry) => isRealLoad(entry.decoded.op)).length, 0);
        const sqCount = threads.reduce((sum, thread) => sum + thread.rob.filter((entry) => isRealStore(entry.decoded.op)).length, 0);
        const samples = [
            [occupancy.rob, robCount, profile.robEntries * activeThreads],
            [occupancy.rs, rsCount, classes.reduce((sum, cls) => sum + profile.rsEntries[cls], 0) * activeThreads],
            [occupancy.prf, prfCount, profile.physicalRegisters * activeThreads],
            [occupancy.lq, lqCount, profile.loadQueueEntries * activeThreads],
            [occupancy.sq, sqCount, profile.storeQueueEntries * activeThreads],
            [
                occupancy.storeBuffer,
                threads.reduce((sum, thread) => sum + thread.storeBuffer.length, 0),
                profile.storeBufferEntries * activeThreads,
            ],
        ];
        for (const [metric, value, capacity] of samples) {
            metric.area += value;
            metric.peak = Math.max(metric.peak, value);
            if (value >= capacity)
                metric.fullCycles += 1;
        }
        for (const core of cores) {
            for (const cls of classes) {
                fuBusyCycles[cls] += core.fu[cls].filter((unit) => unit.busyUntil > cycle).length;
            }
            if (activeCoreSet.has(core.id))
                counters.activeCoreCycles += 1;
            else if (core.threads.some((thread) => !thread.halted))
                counters.stalledCoreCycles += 1;
            else
                counters.idleCoreCycles += 1;
        }
        // Full ownership/reference validation is periodic to keep the bounded ROB
        // off the per-cycle hot path; local capacity checks still fail immediately.
        if ((cycle & 0xff) === 0)
            assertLiveState();
        const frontendEmpty = threads.every((thread) => thread.fetchQueue.length === 0 && thread.decodeQueue.length === 0 &&
            thread.dispatchQueue.length === 0 && thread.fetchProgress === null);
        const storeBuffersEmpty = threads.every((thread) => thread.storeBuffer.length === 0);
        const drained = threads.every((thread) => thread.halted && thread.rob.length === 0) &&
            frontendEmpty && completions.length === 0 && storeBuffersEmpty &&
            storeRequest.size === 0 && memorySystem.outstandingRequests() === 0;
        cycle += 1;
        if (drained)
            break;
        if (retiredThisCycle === 0 && issuedThisCycle === 0 &&
            threads.every((thread) => thread.halted || thread.barrier) &&
            completions.length === 0 && storeBuffersEmpty && frontendEmpty &&
            memorySystem.outstandingRequests() === 0) {
            throw new Error('OoO model deadlocked without pending completion or store drain');
        }
    }
    if (cycle >= maxCycles) {
        const state = threads.map((thread) => ({
            id: thread.id,
            fetchPc: thread.fetchPc,
            halted: thread.halted,
            blocked: thread.fetchBlocked,
            rob: thread.rob.length,
            head: thread.rob[0]?.decoded.op.op,
            headIssued: thread.rob[0]?.issued,
            headCompleted: thread.rob[0]?.completed,
            calls: thread.calls.length,
            fetchQueue: thread.fetchQueue.length,
            decodeQueue: thread.decodeQueue.length,
            dispatchQueue: thread.dispatchQueue.length,
            fetchProgress: thread.fetchProgress?.decoded.pc ?? null,
        }));
        throw new Error(`${program.isa} OoO simulation did not halt (${cycle} cycles): ` +
            `${JSON.stringify({
                state,
                completions: completions.length,
                storeBuffer: threads.reduce((sum, thread) => sum + thread.storeBuffer.length, 0),
                memoryOutstanding: memorySystem.outstandingRequests(),
                memory: memorySystem.stats(),
            })}`);
    }
    assertInvariants(threads, profile, counters, memorySystem);
    const lead = threads[0];
    const memStats = memorySystem.stats();
    const dynamicEnergyNj = counters.renamedUops * 0.003 + counters.issuedUops * 0.006 +
        counters.squashedUops * 0.004 + occupancy.rob.area * 0.00002 +
        occupancy.rs.area * 0.00003 + occupancy.prf.area * 0.00001 +
        (memStats.icLineAccesses + memStats.dcLineAccesses) * 0.02 +
        memStats.dramRequests * 1.5 + counters.branchPredictions * 0.001;
    // cycle / MHz = µs and mW × µs = nJ. OoO residency coefficients are
    // intentionally independent from the in-order energy model.
    const staticEnergyNj = hw.staticPowerMw * (counters.activeCoreCycles +
        counters.stalledCoreCycles * 0.7 +
        counters.idleCoreCycles * 0.2) / hw.clockMhz;
    return {
        isa: program.isa,
        hardwareId: hw.id,
        hardwareName: hw.name,
        profileId: profile.id,
        modelVersion: OOO_MODEL_VERSION,
        energyModelVersion: OOO_ENERGY_MODEL_VERSION,
        energyModelClass: 'uncalibrated-ooo-event-model',
        result: lead.result,
        stdout: readGuestStdout(memory),
        matchedGold: false,
        cycles: cycle,
        ipc: cycle ? counters.retiredOps / cycle : 0,
        retiredOps: counters.retiredOps,
        retiredUops: counters.retiredUops,
        codeBytes: program.codeBytes,
        counts: counters,
        occupancy,
        fuBusyCycles,
        fuUtilization: Object.fromEntries(classes.map((cls) => [
            cls,
            cycle ? fuBusyCycles[cls] / (cycle * profile.fu[cls].count * hw.cores) : 0,
        ])),
        memory: {
            requests: memStats.requests, completions: memStats.completions,
            releases: memStats.releases,
            retainedRequests: memStats.retainedRequests,
            pendingRequests: memStats.pendingRequests,
            pendingLines: memStats.pendingLines,
            icHits: memStats.icHits, icMisses: memStats.icMisses,
            dcHits: memStats.dcHits, dcMisses: memStats.dcMisses,
            l2Hits: memStats.l2Hits, l2Misses: memStats.l2Misses,
            l3Hits: memStats.l3Hits, l3Misses: memStats.l3Misses,
            dramRequests: memStats.dramRequests, dramQueueCycles: memStats.dramQueueCycles,
            coherenceTransfers: memStats.coherenceTransfers,
            coherenceInvalidations: memStats.coherenceInvalidations,
            speculativeLoads: memStats.speculativeLoads,
            committedStores: memStats.committedStores,
            wrongPathFills: memStats.wrongPathFills,
            wrongPathFillBytes: memStats.wrongPathBytes,
            ownedFills: memStats.ownedFills,
            installedFills: memStats.installedFills,
            coalescedLineRequests: memStats.coalescedLineRequests,
        },
        dynamicEnergyNj,
        staticEnergyNj,
        totalEnergyNj: dynamicEnergyNj + staticEnergyNj,
        disasm: disassemble(program),
    };
}
function assertInvariants(threads, profile, counters, memory) {
    for (const thread of threads) {
        if (thread.rob.length || thread.dispatchQueue.length ||
            classes.some((cls) => thread.rs[cls].length)) {
            throw new Error(`OoO drain invariant failed for thread ${thread.id}`);
        }
        if (thread.checkpoints.length) {
            throw new Error(`OoO checkpoint leak in thread ${thread.id}: ${thread.checkpoints.length}`);
        }
        if (thread.storeBuffer.length) {
            throw new Error(`OoO store-buffer leak in thread ${thread.id}`);
        }
        const free = new Set(thread.freeList);
        if (free.size !== thread.freeList.length)
            throw new Error(`OoO free-list duplicate in thread ${thread.id}`);
        const reachable = new Set([
            ...thread.rat,
            ...thread.amt,
            ...thread.resourceRat.values(),
            ...thread.resourceAmt.values(),
        ]);
        for (const tag of reachable) {
            if (!thread.prf[tag]?.allocated)
                throw new Error(`OoO mapping references unallocated p${tag}`);
            if (free.has(tag))
                throw new Error(`OoO mapped tag p${tag} is also free`);
        }
        const allocated = thread.prf.filter((entry) => entry.allocated).length;
        if (allocated !== reachable.size || allocated + free.size !== profile.physicalRegisters) {
            throw new Error(`OoO tag ownership failed: allocated=${allocated}, free=${free.size}`);
        }
        for (let tag = 0; tag < thread.prf.length; tag++) {
            const physical = thread.prf[tag];
            if (physical.allocated !== reachable.has(tag)) {
                throw new Error(`OoO physical tag p${tag} ownership mismatch: allocated=${physical.allocated}, ` +
                    `reachable=${reachable.has(tag)}`);
            }
            if (physical.allocated && !physical.owner) {
                throw new Error(`OoO allocated physical tag p${tag} lacks an owner`);
            }
        }
    }
    for (const core of new Set(threads.map((thread) => thread.core))) {
        if (threads.find((thread) => thread.core === core) === undefined) {
            throw new Error(`OoO core ${core} lost all thread state`);
        }
    }
    if (counters.renamedOps !== counters.retiredOps + counters.squashedOps) {
        throw new Error(`OoO rename conservation failed: ${counters.renamedOps} != ${counters.retiredOps} + ${counters.squashedOps}`);
    }
    if (counters.renamedUops !== counters.retiredUops + counters.squashedUops) {
        throw new Error(`OoO rename-uop conservation failed: ${counters.renamedUops} != ` +
            `${counters.retiredUops} + ${counters.squashedUops}`);
    }
    if (counters.fetchedOps !==
        counters.retiredOps + counters.squashedOps + counters.frontendFlushedOps ||
        counters.fetchedUops !==
            counters.retiredUops + counters.squashedUops + counters.frontendFlushedUops) {
        throw new Error(`OoO frontend conservation failed: fetched=${counters.fetchedOps}/${counters.fetchedUops}, ` +
            `retired=${counters.retiredOps}/${counters.retiredUops}, ` +
            `squashed=${counters.squashedOps}/${counters.squashedUops}, ` +
            `flushed=${counters.frontendFlushedOps}/${counters.frontendFlushedUops}`);
    }
    if (counters.decodedOps > counters.fetchedOps ||
        counters.decodedUops > counters.fetchedUops ||
        counters.renamedOps > counters.decodedOps ||
        counters.renamedUops > counters.decodedUops ||
        counters.dispatchedOps > counters.renamedOps ||
        counters.dispatchedUops > counters.renamedUops ||
        counters.issuedOps > counters.dispatchedOps ||
        counters.issuedUops > counters.dispatchedUops) {
        throw new Error('OoO pipeline stage conservation failed');
    }
    if (counters.completedOps > counters.issuedOps ||
        counters.retiredOps + counters.squashedOps > counters.renamedOps) {
        throw new Error('OoO operation conservation failed');
    }
    memory.assertDrained();
}
export { DEFAULT_OOO_PROFILE, OOO_MODEL_VERSION };
//# sourceMappingURL=ooo.js.map