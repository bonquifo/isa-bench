import { IsaId, NONE, OperationOrigin } from './types.ts';
import { virtDef, virtUses } from './ir.ts';
export function isaRegs(isa) {
    switch (isa) {
        case IsaId.RISCV:
            return {
                allocatable: range(5, 32),
                scratches: [3, 4, 1],
                sp: 2,
            };
        case IsaId.ARM:
            return {
                allocatable: range(0, 28),
                scratches: [28, 29, 30],
                sp: 31,
            };
        case IsaId.X86:
            return {
                allocatable: [3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
                scratches: [0, 1, 2],
                sp: 4,
            };
        case IsaId.MIPS:
            return {
                allocatable: range(3, 29),
                scratches: [1, 2, 31],
                sp: 29,
            };
        case IsaId.POWER:
            return {
                allocatable: [...range(3, 11), ...range(13, 32)],
                scratches: [0, 11, 12],
                sp: 1,
            };
        case IsaId.SPARC:
            return {
                allocatable: [...range(4, 14), ...range(15, 32)],
                scratches: [1, 2, 3],
                sp: 14,
            };
        case IsaId.WASM:
            return {
                allocatable: range(4, 32),
                scratches: [0, 1, 2],
                sp: 3,
            };
        case IsaId.MOS:
            return {
                allocatable: [4, 5, 6, 7],
                scratches: [0, 1, 2],
                sp: 3,
            };
    }
}
function range(lo, hi) {
    const out = [];
    for (let i = lo; i < hi; i++)
        out.push(i);
    return out;
}
function successors(insts) {
    const labels = new Map();
    insts.forEach((ins, i) => {
        if (ins.kind === 'label')
            labels.set(ins.name, i);
    });
    return insts.map((ins, i) => {
        if (ins.kind === 'halt')
            return [];
        if (ins.kind === 'br') {
            const t = labels.get(ins.label);
            return t === undefined ? [] : [t];
        }
        const next = i + 1 < insts.length ? [i + 1] : [];
        if (ins.kind === 'brc') {
            const t = labels.get(ins.label);
            return t === undefined ? next : [...next, t];
        }
        return next;
    });
}
function livenessExtents(insts) {
    const n = insts.length;
    const succ = successors(insts);
    const liveIn = Array.from({ length: n }, () => new Set());
    const liveOut = Array.from({ length: n }, () => new Set());
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = n - 1; i >= 0; i--) {
            const out = new Set();
            for (const s of succ[i]) {
                for (const v of liveIn[s])
                    out.add(v);
            }
            const inn = new Set(out);
            const def = virtDef(insts[i]);
            if (def !== NONE)
                inn.delete(def);
            for (const u of virtUses(insts[i]))
                inn.add(u);
            if (out.size !== liveOut[i].size || [...out].some((v) => !liveOut[i].has(v))) {
                liveOut[i] = out;
                changed = true;
            }
            if (inn.size !== liveIn[i].size || [...inn].some((v) => !liveIn[i].has(v))) {
                liveIn[i] = inn;
                changed = true;
            }
        }
    }
    const start = new Map();
    const end = new Map();
    const touch = (v, i) => {
        start.set(v, Math.min(start.get(v) ?? i, i));
        end.set(v, Math.max(end.get(v) ?? i, i));
    };
    insts.forEach((ins, i) => {
        const def = virtDef(ins);
        if (def !== NONE)
            touch(def, i);
        for (const u of virtUses(ins))
            touch(u, i);
        for (const v of liveIn[i])
            touch(v, i);
        for (const v of liveOut[i])
            touch(v, i);
    });
    return {
        intervals: [...start.keys()].map((virt) => ({
            virt,
            start: start.get(virt) ?? 0,
            end: end.get(virt) ?? 0,
        })),
        liveOut,
    };
}
export function allocate(insts, isa) {
    const regs = isaRegs(isa);
    const { intervals, liveOut } = livenessExtents(insts);
    intervals.sort((a, b) => a.start - b.start || a.virt - b.virt);
    const free = [...regs.allocatable];
    const map = new Map();
    const spills = new Map();
    const active = [];
    let slots = 0;
    const expire = (cursor) => {
        for (let i = active.length - 1; i >= 0; i--) {
            if (active[i].end < cursor) {
                const phys = map.get(active[i].virt);
                if (phys !== undefined)
                    free.push(phys);
                active.splice(i, 1);
            }
        }
    };
    for (const iv of intervals) {
        expire(iv.start);
        if (free.length > 0) {
            const phys = free.shift();
            map.set(iv.virt, phys);
            active.push(iv);
        }
        else {
            let victim = 0;
            for (let i = 1; i < active.length; i++) {
                if (active[i].end > active[victim].end)
                    victim = i;
            }
            if (active.length > 0 && active[victim].end > iv.end) {
                const taken = map.get(active[victim].virt);
                if (taken === undefined)
                    throw new Error('Missing phys for victim');
                spills.set(active[victim].virt, slots);
                slots += 1;
                map.delete(active[victim].virt);
                map.set(iv.virt, taken);
                active.splice(victim, 1);
                active.push(iv);
            }
            else {
                spills.set(iv.virt, slots);
                slots += 1;
            }
        }
    }
    const physUsed = new Set();
    for (const p of map.values())
        physUsed.add(p);
    const callSaves = new Map();
    const callSpillSaves = new Map();
    const callable = new Set();
    for (const ins of insts) {
        if (ins.kind === 'call')
            callable.add(ins.label);
        if (ins.kind === 'labaddr')
            callable.add(ins.label);
    }
    const entries = [...callable]
        .map((name) => ({ name, index: insts.findIndex((ins) => ins.kind === 'label' && ins.name === name) }))
        .filter((x) => x.index >= 0)
        .sort((a, b) => a.index - b.index);
    const ownDefs = new Map();
    const directCalls = new Map();
    for (let e = 0; e < entries.length; e++) {
        const start = entries[e].index;
        const end = entries[e + 1]?.index ?? insts.length;
        const defs = new Set();
        const calls = new Set();
        for (let i = start; i < end; i++) {
            const item = insts[i];
            const def = virtDef(item);
            if (def !== NONE)
                defs.add(def);
            if (item.kind === 'call')
                calls.add(item.label);
            if (item.kind === 'icall')
                for (const entry of entries)
                    calls.add(entry.name);
        }
        ownDefs.set(entries[e].name, defs);
        directCalls.set(entries[e].name, calls);
    }
    const mayDefs = new Map([...ownDefs].map(([name, defs]) => [name, new Set(defs)]));
    let mayDefsChanged = true;
    while (mayDefsChanged) {
        mayDefsChanged = false;
        for (const entry of entries) {
            const defs = mayDefs.get(entry.name);
            for (const target of directCalls.get(entry.name) ?? []) {
                for (const def of mayDefs.get(target) ?? []) {
                    if (!defs.has(def)) {
                        defs.add(def);
                        mayDefsChanged = true;
                    }
                }
            }
        }
    }
    const indirectMayDefs = new Set();
    for (const defs of mayDefs.values())
        for (const def of defs)
            indirectMayDefs.add(def);
    const firstDef = new Map();
    insts.forEach((ins, i) => {
        const def = virtDef(ins);
        if (def !== NONE && !firstDef.has(def))
            firstDef.set(def, i);
    });
    insts.forEach((ins, i) => {
        if (ins.kind !== 'call' && ins.kind !== 'icall')
            return;
        const saves = new Set();
        const spillSaves = new Set();
        const clobbered = ins.kind === 'call' ? (mayDefs.get(ins.label) ?? new Set()) : indirectMayDefs;
        const liveByPhys = new Map();
        for (const virt of liveOut[i]) {
            if ((firstDef.get(virt) ?? Number.POSITIVE_INFINITY) >= i)
                continue;
            const phys = map.get(virt);
            if (phys !== undefined) {
                const group = liveByPhys.get(phys) ?? [];
                group.push(virt);
                liveByPhys.set(phys, group);
            }
            const slot = spills.get(virt);
            if (slot !== undefined && !clobbered.has(virt))
                spillSaves.add(slot);
        }
        for (const [phys, virtuals] of liveByPhys) {
            if (virtuals.some((virt) => !clobbered.has(virt)))
                saves.add(phys);
        }
        callSaves.set(i, [...saves]);
        callSpillSaves.set(i, [...spillSaves]);
    });
    return {
        map,
        spills,
        scratches: regs.scratches,
        sp: regs.sp,
        stackSlots: slots,
        physUsed,
        callSaves,
        callSpillSaves,
    };
}
export function legalize(insts, alloc) {
    const out = [];
    const { map, spills, scratches } = alloc;
    const s0 = scratches[0];
    const s1 = scratches[1];
    const s2 = scratches[2] ?? scratches[0];
    const physOf = (v, scratch) => {
        const spilled = spills.get(v);
        if (spilled !== undefined) {
            out.push({
                kind: 'spill_load',
                dst: scratch,
                slot: spilled,
                origin: OperationOrigin.LOWERING,
            });
            return scratch;
        }
        const p = map.get(v);
        if (p === undefined)
            throw new Error(`No allocation for r${v}`);
        return p;
    };
    const destOf = (v) => {
        const spilled = spills.get(v);
        if (spilled !== undefined)
            return { phys: s0, spill: spilled };
        const p = map.get(v);
        if (p === undefined)
            throw new Error(`No allocation for r${v}`);
        return { phys: p };
    };
    const writeBack = (dest) => {
        if (dest.spill !== undefined) {
            out.push({
                kind: 'spill_store',
                src: dest.phys,
                slot: dest.spill,
                origin: OperationOrigin.LOWERING,
            });
        }
    };
    for (let insIndex = 0; insIndex < insts.length; insIndex++) {
        const ins = insts[insIndex];
        switch (ins.kind) {
            case 'label':
            case 'br':
                out.push(ins);
                break;
            case 'imm':
            case 'immf': {
                const d = destOf(ins.dst);
                out.push({ ...ins, dst: d.phys });
                writeBack(d);
                break;
            }
            case 'mov': {
                const src = physOf(ins.src, s1);
                const d = destOf(ins.dst);
                out.push({ kind: 'mov', dst: d.phys, src, origin: ins.origin });
                writeBack(d);
                break;
            }
            case 'convert': {
                const src = physOf(ins.src, s1);
                const d = destOf(ins.dst);
                out.push({ kind: 'convert', op: ins.op, dst: d.phys, src, origin: ins.origin });
                writeBack(d);
                break;
            }
            case 'binop': {
                const a = physOf(ins.a, s1);
                const b = physOf(ins.b, s2 === a ? s0 : s2);
                const d = destOf(ins.dst);
                const dst = d.spill !== undefined ? (a === s0 || b === s0 ? s1 : s0) : d.phys;
                out.push({ kind: 'binop', op: ins.op, dst, a, b, origin: ins.origin });
                if (d.spill !== undefined) {
                    out.push({
                        kind: 'spill_store',
                        src: dst,
                        slot: d.spill,
                        origin: OperationOrigin.LOWERING,
                    });
                }
                else if (dst !== d.phys) {
                    out.push({
                        kind: 'mov',
                        dst: d.phys,
                        src: dst,
                        origin: OperationOrigin.LOWERING,
                    });
                }
                break;
            }
            case 'addi': {
                const a = physOf(ins.a, s1);
                const d = destOf(ins.dst);
                const dst = d.spill !== undefined ? s0 : d.phys;
                out.push({ kind: 'addi', dst, a, imm: ins.imm, origin: ins.origin });
                writeBack({ phys: dst, spill: d.spill });
                break;
            }
            case 'ldw':
            case 'ldd':
            case 'ldb': {
                const base = physOf(ins.base, s1);
                const d = destOf(ins.dst);
                const dst = d.spill !== undefined ? s0 : d.phys;
                out.push({ ...ins, dst, base });
                writeBack({ phys: dst, spill: d.spill });
                break;
            }
            case 'stw':
            case 'std':
            case 'stb': {
                const src = physOf(ins.src, s0);
                const base = physOf(ins.base, s1);
                out.push({ ...ins, src, base });
                break;
            }
            case 'ldw_s':
            case 'ldd_s': {
                const base = physOf(ins.base, s1);
                const index = physOf(ins.index, s2);
                const d = destOf(ins.dst);
                const dst = d.spill !== undefined ? s0 : d.phys;
                out.push({ ...ins, dst, base, index });
                writeBack({ phys: dst, spill: d.spill });
                break;
            }
            case 'stw_s':
            case 'std_s': {
                const src = physOf(ins.src, s0);
                const base = physOf(ins.base, s1);
                const index = physOf(ins.index, s2);
                out.push({ ...ins, src, base, index });
                break;
            }
            case 'brc': {
                const a = physOf(ins.a, s0);
                const b = physOf(ins.b, s1);
                out.push({ kind: 'brc', cond: ins.cond, a, b, label: ins.label, origin: ins.origin });
                break;
            }
            case 'halt': {
                const src = physOf(ins.src, s0);
                out.push({ kind: 'halt', src, origin: ins.origin });
                break;
            }
            case 'tid':
            case 'ptid':
            case 'pnthreads':
            case 'nthreads': {
                const d = destOf(ins.dst);
                out.push({ ...ins, dst: d.phys });
                writeBack(d);
                break;
            }
            case 'cstack_check':
                out.push({ ...ins, src: physOf(ins.src, s0) });
                break;
            case 'barrier':
            case 'ret':
                out.push(ins);
                break;
            case 'call':
                out.push({
                    ...ins,
                    saves: alloc.callSaves.get(insIndex) ?? [],
                    saveSpills: alloc.callSpillSaves.get(insIndex) ?? [],
                });
                break;
            case 'icall': {
                out.push({
                    kind: 'icall',
                    fn: physOf(ins.fn, s0),
                    saves: alloc.callSaves.get(insIndex) ?? [],
                    saveSpills: alloc.callSpillSaves.get(insIndex) ?? [],
                    origin: ins.origin,
                });
                break;
            }
            case 'labaddr': {
                const d = destOf(ins.dst);
                out.push({ kind: 'labaddr', dst: d.phys, label: ins.label, origin: ins.origin });
                writeBack(d);
                break;
            }
            case 'spill_load':
            case 'spill_store':
                throw new Error('Allocator spill instruction is invalid before legalization');
        }
    }
    return out;
}
//# sourceMappingURL=regalloc.js.map