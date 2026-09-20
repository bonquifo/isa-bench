import { i32, inSigned } from './bits.ts';
import {} from './ir.ts';
import { binClass, binOpcode, mach } from './mach.ts';
import { InstClass, NONE, Opcode } from './types.ts';
export function emitThread(e, ins, name) {
    if (ins.kind === 'convert') {
        const op = ins.op === 'itod' ? Opcode.ITOD : ins.op === 'dtoi' ? Opcode.DTOI : Opcode.I8;
        e.push(mach({
            op, mnemonic: `${ins.op} ${name(ins.dst)}, ${name(ins.src)}`, bytes: 4,
            cls: InstClass.FP, dst: ins.dst, srcA: ins.src,
        }));
        return true;
    }
    if (ins.kind === 'ldb' || ins.kind === 'stb') {
        const load = ins.kind === 'ldb';
        e.push(mach({
            op: load ? Opcode.LDB : Opcode.STB,
            mnemonic: `${load ? 'load.byte.s8' : 'store.byte'} ${load ? name(ins.dst) : name(ins.src)}, [${name(ins.base)}${ins.off ? `+${ins.off}` : ''}]`,
            bytes: 4, cls: load ? InstClass.LD : InstClass.ST,
            dst: load ? ins.dst : NONE, srcA: load ? NONE : ins.src,
            memBase: ins.base, memOff: ins.off,
        }));
        return true;
    }
    if (ins.kind === 'tid') {
        e.push(mach({
            op: Opcode.TID, mnemonic: `tid ${name(ins.dst)}`, bytes: 4,
            cls: InstClass.MOV, dst: ins.dst,
        }));
        return true;
    }
    if (ins.kind === 'ptid') {
        e.push(mach({
            op: Opcode.PTID, mnemonic: `private.tid ${name(ins.dst)}`, bytes: 4,
            cls: InstClass.MOV, dst: ins.dst,
        }));
        return true;
    }
    if (ins.kind === 'pnthreads') {
        e.push(mach({
            op: Opcode.PNTHREADS, mnemonic: `private.nthreads ${name(ins.dst)}`, bytes: 4,
            cls: InstClass.MOV, dst: ins.dst,
        }));
        return true;
    }
    if (ins.kind === 'cstack_check') {
        e.push(mach({
            op: Opcode.CSTACK_CHECK,
            mnemonic: `guest.c.stack.check.${ins.area} ${name(ins.src)}`,
            bytes: 4, cls: InstClass.NOP, srcA: ins.src, imm: ins.area === 'software' ? 0 : 1,
            resourceReads: ['runtime.stack'], serializing: true,
        }));
        return true;
    }
    if (ins.kind === 'nthreads') {
        e.push(mach({
            op: Opcode.NTHREADS, mnemonic: `nthreads ${name(ins.dst)}`, bytes: 4,
            cls: InstClass.MOV, dst: ins.dst,
        }));
        return true;
    }
    if (ins.kind === 'barrier') {
        e.push(mach({
            op: Opcode.BARRIER, mnemonic: 'barrier', bytes: 4, cls: InstClass.NOP,
            resourceReads: ['runtime.memory'], resourceWrites: ['runtime.memory'], serializing: true,
        }));
        return true;
    }
    if (ins.kind === 'call') {
        e.push(mach({
            op: Opcode.CALL, mnemonic: `call ${ins.label}`, bytes: 4,
            cls: InstClass.BR, label: ins.label, saveRegs: ins.saves, saveSpills: ins.saveSpills,
            resourceReads: ['runtime.stack'], resourceWrites: ['runtime.stack'], serializing: true,
        }));
        return true;
    }
    if (ins.kind === 'ret') {
        e.push(mach({
            op: Opcode.RET, mnemonic: 'ret', bytes: 4, cls: InstClass.BR,
            resourceReads: ['runtime.stack'], resourceWrites: ['runtime.stack'], serializing: true,
        }));
        return true;
    }
    if (ins.kind === 'icall') {
        e.push(mach({
            op: Opcode.ICALL, mnemonic: `icall ${name(ins.fn)}`, bytes: 4,
            cls: InstClass.BR, srcA: ins.fn, saveRegs: ins.saves, saveSpills: ins.saveSpills,
            resourceReads: ['runtime.stack'], resourceWrites: ['runtime.stack'], serializing: true,
        }));
        return true;
    }
    if (ins.kind === 'labaddr') {
        e.push(mach({
            op: Opcode.LI, mnemonic: `la ${name(ins.dst)}, ${ins.label}`, bytes: 4,
            cls: InstClass.ALU, dst: ins.dst, label: ins.label,
        }));
        return true;
    }
    if (ins.kind === 'spill_load') {
        e.push(mach({
            op: Opcode.SPILL_LOAD, mnemonic: `spill.load ${name(ins.dst)}, [${ins.slot}]`, bytes: 4,
            cls: InstClass.LD, dst: ins.dst, imm: ins.slot,
            resourceReads: [`spill.${ins.slot}`],
        }));
        return true;
    }
    if (ins.kind === 'spill_store') {
        e.push(mach({
            op: Opcode.SPILL_STORE, mnemonic: `spill.store [${ins.slot}], ${name(ins.src)}`, bytes: 4,
            cls: InstClass.ST, srcA: ins.src, imm: ins.slot,
            resourceWrites: [`spill.${ins.slot}`],
        }));
        return true;
    }
    return false;
}
function condOp(cond) {
    if (cond === 'eq')
        return Opcode.BEQ;
    if (cond === 'ne')
        return Opcode.BNE;
    if (cond === 'lt')
        return Opcode.BLT;
    return Opcode.BGE;
}
const P = (r) => `r${r}`;
const S = (r) => {
    const names = [
        '%g0', '%g1', '%g2', '%g3', '%g4', '%g5', '%g6', '%g7',
        '%o0', '%o1', '%o2', '%o3', '%o4', '%o5', '%sp', '%o7',
        '%l0', '%l1', '%l2', '%l3', '%l4', '%l5', '%l6', '%l7',
        '%i0', '%i1', '%i2', '%i3', '%i4', '%i5', '%fp', '%i7',
    ];
    return names[r] ?? `%r${r}`;
};
const W = (r) => `loc${r}`;
const M = (r) => ['A', 'X', 'Y', 'S', 'Z0', 'Z1', 'Z2', 'Z3'][r] ?? `Z${r}`;
export function lowerPower(ir, e) {
    const li = (rd, imm) => {
        const v = i32(imm);
        if (inSigned(v, 16)) {
            e.push(mach({
                op: Opcode.LI, mnemonic: `li ${P(rd)}, ${v}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, imm: v,
            }));
            return;
        }
        const hi = (v >>> 16) & 0xffff;
        e.push(mach({
            op: Opcode.LI, mnemonic: `lis ${P(rd)}, 0x${hi.toString(16)}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, imm: v & 0xffff0000,
        }));
        e.push(mach({
            op: Opcode.LI, mnemonic: `ori ${P(rd)}, ${P(rd)}, ${v & 0xffff}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, imm: v,
        }));
    };
    const addi = (rd, rs, imm, avoid = []) => {
        if (inSigned(imm, 16)) {
            e.push(mach({
                op: Opcode.ADDI, mnemonic: `addi ${P(rd)}, ${P(rs)}, ${imm}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: rs, imm,
            }));
            return;
        }
        const t = e.scratch([rd, rs, ...avoid]);
        li(t, imm);
        e.push(mach({
            op: Opcode.ADD, mnemonic: `add ${P(rd)}, ${P(rs)}, ${P(t)}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, srcA: rs, srcB: t,
        }));
    };
    const mem = (kind, val, base, off) => {
        let b = base;
        let o = off;
        if (!inSigned(off, 16)) {
            const t = e.scratch([val, base]);
            addi(t, base, off);
            b = t;
            o = 0;
        }
        const load = kind === 'ldw' || kind === 'ldd';
        const op = kind === 'ldw' ? Opcode.LDW : kind === 'stw' ? Opcode.STW : kind === 'ldd' ? Opcode.LDD : Opcode.STD;
        const mnem = kind === 'ldw' ? 'lwz' : kind === 'stw' ? 'stw' : kind === 'ldd' ? 'lfd' : 'stfd';
        e.push(mach({
            op, mnemonic: `${mnem} ${P(val)}, ${o}(${P(b)})`, bytes: 4,
            cls: load ? InstClass.LD : InstClass.ST,
            dst: load ? val : NONE, srcA: load ? NONE : val, memBase: b, memOff: o,
        }));
    };
    const scaled = (kind, val, base, index, scale, off) => {
        const sh = Math.log2(scale);
        const t = e.scratch([val, base, index]);
        e.push(mach({
            op: Opcode.SHL, mnemonic: `slwi ${P(t)}, ${P(index)}, ${sh}`, bytes: 4,
            cls: InstClass.ALU, dst: t, srcA: index, imm: sh,
        }));
        let b = base;
        if (off !== 0) {
            const t2 = e.scratch([val, t, base]);
            addi(t2, base, off, [t]);
            b = t2;
        }
        const load = kind.startsWith('ld');
        const op = kind.startsWith('ldw') ? Opcode.LDW : kind.startsWith('stw') ? Opcode.STW : kind.startsWith('ldd') ? Opcode.LDD : Opcode.STD;
        const mnem = load ? (kind.includes('ldd') ? 'lfdx' : 'lwzx') : (kind.includes('std') ? 'stfdx' : 'stwx');
        e.push(mach({
            op, mnemonic: `${mnem} ${P(val)}, ${P(b)}, ${P(t)}`, bytes: 4,
            cls: load ? InstClass.LD : InstClass.ST,
            dst: load ? val : NONE, srcA: load ? NONE : val,
            memBase: b, memIndex: t, memScale: 1,
        }));
    };
    for (const ins of ir) {
        e.action(ins, () => {
            if (emitThread(e, ins, P))
                return;
            switch (ins.kind) {
                case 'label':
                    e.label(ins.name);
                    break;
                case 'imm':
                    li(ins.dst, ins.value);
                    break;
                case 'immf':
                    e.push(mach({
                        op: Opcode.LIF, mnemonic: `lfs ${P(ins.dst)}, ${ins.value}`, bytes: 8,
                        cls: InstClass.MOV, dst: ins.dst, imm: ins.value, uops: 2,
                    }));
                    break;
                case 'mov':
                    e.push(mach({
                        op: Opcode.MOV, mnemonic: `mr ${P(ins.dst)}, ${P(ins.src)}`, bytes: 4,
                        cls: InstClass.MOV, dst: ins.dst, srcA: ins.src,
                    }));
                    break;
                case 'binop':
                    e.push(mach({
                        op: binOpcode(ins.op),
                        mnemonic: `${ins.op} ${P(ins.dst)}, ${P(ins.a)}, ${P(ins.b)}`,
                        bytes: 4, cls: binClass(ins.op), dst: ins.dst, srcA: ins.a, srcB: ins.b,
                    }));
                    break;
                case 'addi':
                    addi(ins.dst, ins.a, ins.imm);
                    break;
                case 'ldw':
                    mem('ldw', ins.dst, ins.base, ins.off);
                    break;
                case 'stw':
                    mem('stw', ins.src, ins.base, ins.off);
                    break;
                case 'ldd':
                    mem('ldd', ins.dst, ins.base, ins.off);
                    break;
                case 'std':
                    mem('std', ins.src, ins.base, ins.off);
                    break;
                case 'ldw_s':
                    scaled('ldw_s', ins.dst, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'stw_s':
                    scaled('stw_s', ins.src, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'ldd_s':
                    scaled('ldd_s', ins.dst, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'std_s':
                    scaled('std_s', ins.src, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'br':
                    e.push(mach({
                        op: Opcode.BR, mnemonic: `b ${ins.label}`, bytes: 4,
                        cls: InstClass.BR, label: ins.label,
                    }));
                    break;
                case 'brc':
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `cmpw ${P(ins.a)}, ${P(ins.b)}`, bytes: 4,
                        cls: InstClass.ALU, srcA: ins.a, srcB: ins.b, resourceWrites: ['power.cr'],
                    }));
                    e.push(mach({
                        op: condOp(ins.cond), mnemonic: `bc ${ins.cond}, ${ins.label}`, bytes: 4,
                        cls: InstClass.BR, srcA: ins.a, srcB: ins.b, label: ins.label,
                        resourceReads: ['power.cr'],
                    }));
                    break;
                case 'halt':
                    e.push(mach({
                        op: Opcode.HALT, mnemonic: `trap  ; halt ${P(ins.src)}`, bytes: 4,
                        cls: InstClass.NOP, srcA: ins.src,
                    }));
                    break;
            }
        });
    }
}
export function lowerSparc(ir, e) {
    const li = (rd, imm) => {
        const v = i32(imm);
        if (inSigned(v, 13)) {
            e.push(mach({
                op: Opcode.LI, mnemonic: `or %g0, ${v}, ${S(rd)}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: 0, imm: v,
            }));
            return;
        }
        e.push(mach({
            op: Opcode.LI, mnemonic: `sethi %hi(${v}), ${S(rd)}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, imm: v & ~0x3ff,
        }));
        e.push(mach({
            op: Opcode.LI, mnemonic: `or ${S(rd)}, %lo(${v}), ${S(rd)}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, imm: v,
        }));
    };
    const addi = (rd, rs, imm) => {
        if (inSigned(imm, 13)) {
            e.push(mach({
                op: Opcode.ADDI, mnemonic: `add ${S(rs)}, ${imm}, ${S(rd)}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: rs, imm,
            }));
            return;
        }
        const t = e.scratch([rd, rs]);
        li(t, imm);
        e.push(mach({
            op: Opcode.ADD, mnemonic: `add ${S(rs)}, ${S(t)}, ${S(rd)}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, srcA: rs, srcB: t,
        }));
    };
    const mem = (kind, val, base, off) => {
        let b = base;
        let o = off;
        if (!inSigned(off, 13)) {
            const t = e.scratch([val, base]);
            addi(t, base, off);
            b = t;
            o = 0;
        }
        const load = kind === 'ldw' || kind === 'ldd';
        const op = kind === 'ldw' ? Opcode.LDW : kind === 'stw' ? Opcode.STW : kind === 'ldd' ? Opcode.LDD : Opcode.STD;
        const mnem = load ? 'ld' : 'st';
        e.push(mach({
            op, mnemonic: `${mnem} [${S(b)}+${o}], ${S(val)}`, bytes: 4,
            cls: load ? InstClass.LD : InstClass.ST,
            dst: load ? val : NONE, srcA: load ? NONE : val, memBase: b, memOff: o,
        }));
    };
    const scaled = (kind, val, base, index, scale, off) => {
        const sh = Math.log2(scale);
        const t = e.scratch([val, base, index]);
        e.push(mach({
            op: Opcode.SHL, mnemonic: `sll ${S(index)}, ${sh}, ${S(t)}`, bytes: 4,
            cls: InstClass.ALU, dst: t, srcA: index, imm: sh,
        }));
        e.push(mach({
            op: Opcode.ADD, mnemonic: `add ${S(base)}, ${S(t)}, ${S(t)}`, bytes: 4,
            cls: InstClass.ALU, dst: t, srcA: base, srcB: t,
        }));
        mem(kind.replace('_s', ''), val, t, off);
    };
    for (const ins of ir) {
        e.action(ins, () => {
            if (emitThread(e, ins, S))
                return;
            switch (ins.kind) {
                case 'label':
                    e.label(ins.name);
                    break;
                case 'imm':
                    li(ins.dst, ins.value);
                    break;
                case 'immf':
                    e.push(mach({
                        op: Opcode.LIF, mnemonic: `ldd [imm], ${S(ins.dst)}`, bytes: 8,
                        cls: InstClass.MOV, dst: ins.dst, imm: ins.value, uops: 2,
                    }));
                    break;
                case 'mov':
                    e.push(mach({
                        op: Opcode.MOV, mnemonic: `mov ${S(ins.src)}, ${S(ins.dst)}`, bytes: 4,
                        cls: InstClass.MOV, dst: ins.dst, srcA: ins.src,
                    }));
                    break;
                case 'binop':
                    e.push(mach({
                        op: binOpcode(ins.op),
                        mnemonic: `${ins.op} ${S(ins.a)}, ${S(ins.b)}, ${S(ins.dst)}`,
                        bytes: 4, cls: binClass(ins.op), dst: ins.dst, srcA: ins.a, srcB: ins.b,
                    }));
                    break;
                case 'addi':
                    addi(ins.dst, ins.a, ins.imm);
                    break;
                case 'ldw':
                    mem('ldw', ins.dst, ins.base, ins.off);
                    break;
                case 'stw':
                    mem('stw', ins.src, ins.base, ins.off);
                    break;
                case 'ldd':
                    mem('ldd', ins.dst, ins.base, ins.off);
                    break;
                case 'std':
                    mem('std', ins.src, ins.base, ins.off);
                    break;
                case 'ldw_s':
                    scaled('ldw_s', ins.dst, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'stw_s':
                    scaled('stw_s', ins.src, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'ldd_s':
                    scaled('ldd_s', ins.dst, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'std_s':
                    scaled('std_s', ins.src, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'br':
                    e.push(mach({
                        op: Opcode.BR, mnemonic: `ba ${ins.label}`, bytes: 4,
                        cls: InstClass.BR, label: ins.label,
                    }));
                    break;
                case 'brc':
                    e.push(mach({
                        op: condOp(ins.cond),
                        mnemonic: `b${ins.cond} ${S(ins.a)}, ${S(ins.b)}, ${ins.label}`,
                        bytes: 4, cls: InstClass.BR, srcA: ins.a, srcB: ins.b, label: ins.label,
                    }));
                    break;
                case 'halt':
                    e.push(mach({
                        op: Opcode.HALT, mnemonic: `unimp  ! halt ${S(ins.src)}`, bytes: 4,
                        cls: InstClass.NOP, srcA: ins.src,
                    }));
                    break;
            }
        });
    }
}
export function lowerWasm(ir, e) {
    const get = (r) => {
        e.push(mach({
            op: Opcode.NOP, mnemonic: `local.get ${W(r)}`, bytes: 2,
            cls: InstClass.MOV, srcA: r,
            resourceReads: [`wasm.local.${r}`, 'wasm.stack'],
            resourceWrites: ['wasm.stack'],
        }));
    };
    const set = (r, via) => {
        e.push(mach({
            op: Opcode.MOV, mnemonic: `local.set ${W(r)}`, bytes: 2,
            cls: InstClass.MOV, dst: r, srcA: via,
            resourceReads: ['wasm.stack'],
            resourceWrites: [`wasm.local.${r}`, 'wasm.stack'],
        }));
    };
    for (const ins of ir) {
        e.action(ins, () => {
            if (emitThread(e, ins, W))
                return;
            switch (ins.kind) {
                case 'label':
                    e.label(ins.name);
                    break;
                case 'imm':
                    e.push(mach({
                        op: Opcode.LI, mnemonic: `i32.const ${i32(ins.value)}`, bytes: 5,
                        cls: InstClass.ALU, dst: ins.dst, imm: i32(ins.value),
                    }));
                    e.push(mach({
                        op: Opcode.MOV, mnemonic: `local.set ${W(ins.dst)}`, bytes: 2,
                        cls: InstClass.MOV, dst: ins.dst, srcA: ins.dst,
                    }));
                    break;
                case 'immf':
                    e.push(mach({
                        op: Opcode.LIF, mnemonic: `f64.const ${ins.value}`, bytes: 9,
                        cls: InstClass.MOV, dst: ins.dst, imm: ins.value,
                    }));
                    break;
                case 'mov':
                    get(ins.src);
                    set(ins.dst, ins.src);
                    break;
                case 'binop':
                    get(ins.a);
                    get(ins.b);
                    e.push(mach({
                        op: binOpcode(ins.op),
                        mnemonic: `${ins.op.endsWith('f') ? 'f64' : 'i32'}.${ins.op.replace('f', '')}`,
                        bytes: 1, cls: binClass(ins.op), dst: ins.dst, srcA: ins.a, srcB: ins.b,
                        resourceReads: ['wasm.stack'], resourceWrites: ['wasm.stack'],
                    }));
                    set(ins.dst, ins.dst);
                    break;
                case 'addi':
                    get(ins.a);
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `i32.const ${ins.imm}`, bytes: 3,
                        cls: InstClass.ALU, srcA: ins.a, imm: ins.imm,
                    }));
                    e.push(mach({
                        op: Opcode.ADDI, mnemonic: 'i32.add', bytes: 1,
                        cls: InstClass.ALU, dst: ins.dst, srcA: ins.a, imm: ins.imm,
                        resourceReads: ['wasm.stack'], resourceWrites: ['wasm.stack'],
                    }));
                    set(ins.dst, ins.dst);
                    break;
                case 'ldw':
                case 'ldd':
                    get(ins.base);
                    if (ins.off) {
                        e.push(mach({
                            op: Opcode.NOP, mnemonic: `i32.const ${ins.off} / i32.add`, bytes: 4,
                            cls: InstClass.ALU, srcA: ins.base, imm: ins.off,
                        }));
                    }
                    e.push(mach({
                        op: ins.kind === 'ldw' ? Opcode.LDW : Opcode.LDD,
                        mnemonic: ins.kind === 'ldw' ? 'i32.load' : 'f64.load',
                        bytes: 3, cls: InstClass.LD, dst: ins.dst, memBase: ins.base, memOff: ins.off,
                    }));
                    set(ins.dst, ins.dst);
                    break;
                case 'stw':
                case 'std':
                    get(ins.base);
                    get(ins.src);
                    e.push(mach({
                        op: ins.kind === 'stw' ? Opcode.STW : Opcode.STD,
                        mnemonic: ins.kind === 'stw' ? 'i32.store' : 'f64.store',
                        bytes: 3, cls: InstClass.ST, srcA: ins.src, memBase: ins.base, memOff: ins.off,
                    }));
                    break;
                case 'ldw_s':
                case 'ldd_s': {
                    get(ins.base);
                    get(ins.index);
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `i32.const ${Math.log2(ins.scale)} / i32.shl`, bytes: 3,
                        cls: InstClass.ALU, srcA: ins.index, imm: Math.log2(ins.scale),
                    }));
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: 'i32.add', bytes: 1,
                        cls: InstClass.ALU, srcA: ins.base, srcB: ins.index,
                    }));
                    if (ins.off) {
                        e.push(mach({
                            op: Opcode.NOP, mnemonic: `i32.const ${ins.off} / i32.add`, bytes: 3,
                            cls: InstClass.ALU, srcA: ins.base, imm: ins.off,
                        }));
                    }
                    e.push(mach({
                        op: ins.kind === 'ldw_s' ? Opcode.LDW : Opcode.LDD,
                        mnemonic: ins.kind === 'ldw_s' ? 'i32.load' : 'f64.load',
                        bytes: 3, cls: InstClass.LD, dst: ins.dst,
                        memBase: ins.base, memIndex: ins.index, memScale: ins.scale, memOff: ins.off,
                    }));
                    set(ins.dst, ins.dst);
                    break;
                }
                case 'stw_s':
                case 'std_s': {
                    get(ins.base);
                    get(ins.index);
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `i32.const ${Math.log2(ins.scale)} / i32.shl`, bytes: 3,
                        cls: InstClass.ALU, srcA: ins.index, imm: Math.log2(ins.scale),
                    }));
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: 'i32.add', bytes: 1,
                        cls: InstClass.ALU, srcA: ins.base, srcB: ins.index,
                    }));
                    get(ins.src);
                    e.push(mach({
                        op: ins.kind === 'stw_s' ? Opcode.STW : Opcode.STD,
                        mnemonic: ins.kind === 'stw_s' ? 'i32.store' : 'f64.store',
                        bytes: 3, cls: InstClass.ST, srcA: ins.src,
                        memBase: ins.base, memIndex: ins.index, memScale: ins.scale, memOff: ins.off,
                    }));
                    break;
                }
                case 'br':
                    e.push(mach({
                        op: Opcode.BR, mnemonic: `br ${ins.label}`, bytes: 3,
                        cls: InstClass.BR, label: ins.label,
                    }));
                    break;
                case 'brc':
                    get(ins.a);
                    get(ins.b);
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `i32.${ins.cond}`, bytes: 1,
                        cls: InstClass.ALU, srcA: ins.a, srcB: ins.b,
                        resourceReads: ['wasm.stack'], resourceWrites: ['wasm.stack', 'wasm.flags'],
                    }));
                    e.push(mach({
                        op: condOp(ins.cond), mnemonic: `br_if ${ins.label}`, bytes: 3,
                        cls: InstClass.BR, srcA: ins.a, srcB: ins.b, label: ins.label,
                        resourceReads: ['wasm.stack', 'wasm.flags'], resourceWrites: ['wasm.stack'],
                    }));
                    break;
                case 'halt':
                    e.push(mach({
                        op: Opcode.HALT, mnemonic: `return  ;; halt ${W(ins.src)}`, bytes: 1,
                        cls: InstClass.NOP, srcA: ins.src,
                    }));
                    break;
            }
        });
    }
}
export function lowerMos(ir, e) {
    const ldaImm = (rd, imm) => {
        e.push(mach({
            op: Opcode.LI, mnemonic: `LDA #${i32(imm)}`, bytes: 3,
            cls: InstClass.ALU, dst: rd, imm: i32(imm),
        }));
    };
    const accBin = (op, opcode, cls, rd, ra, rb) => {
        const commutative = opcode === Opcode.ADD || opcode === Opcode.MUL ||
            opcode === Opcode.AND || opcode === Opcode.OR || opcode === Opcode.XOR ||
            opcode === Opcode.ADDF || opcode === Opcode.MULF;
        let left = ra;
        let right = rb;
        if (rd === rb) {
            if (commutative) {
                left = rb;
                right = ra;
            }
            else {
                const saved = e.scratch([rd, ra, rb]);
                e.push(mach({
                    op: Opcode.MOV, mnemonic: `LDA ${M(rb)} / STA ${M(saved)}`, bytes: 5,
                    cls: InstClass.MOV, dst: saved, srcA: rb, uops: 2,
                }));
                right = saved;
            }
        }
        if (rd !== left) {
            e.push(mach({
                op: Opcode.MOV, mnemonic: `LDA ${M(left)}`, bytes: 3,
                cls: InstClass.MOV, dst: rd, srcA: left,
            }));
        }
        if (op === 'add') {
            e.push(mach({
                op: Opcode.NOP, mnemonic: 'CLC', bytes: 1, cls: InstClass.ALU,
                resourceWrites: ['mos.carry'],
            }));
        }
        e.push(mach({
            op: opcode, mnemonic: `${mosOp(op)} ${M(right)}`, bytes: 3,
            cls, dst: rd, srcA: rd, srcB: right,
            resourceReads: ['mos.acc', ...(op === 'add' ? ['mos.carry'] : [])],
            resourceWrites: ['mos.acc', ...(op === 'add' ? ['mos.carry'] : [])],
        }));
    };
    for (const ins of ir) {
        e.action(ins, () => {
            if (emitThread(e, ins, M))
                return;
            switch (ins.kind) {
                case 'label':
                    e.label(ins.name);
                    break;
                case 'imm':
                    ldaImm(ins.dst, ins.value);
                    break;
                case 'immf':
                    e.push(mach({
                        op: Opcode.LIF, mnemonic: `LDA #${ins.value}`, bytes: 3,
                        cls: InstClass.MOV, dst: ins.dst, imm: ins.value,
                    }));
                    break;
                case 'mov':
                    if (ins.dst !== ins.src) {
                        e.push(mach({
                            op: Opcode.MOV, mnemonic: `LDA ${M(ins.src)} / STA ${M(ins.dst)}`, bytes: 5,
                            cls: InstClass.MOV, dst: ins.dst, srcA: ins.src, uops: 2,
                        }));
                    }
                    break;
                case 'binop':
                    accBin(ins.op, binOpcode(ins.op), binClass(ins.op), ins.dst, ins.a, ins.b);
                    break;
                case 'addi':
                    if (ins.dst !== ins.a) {
                        e.push(mach({
                            op: Opcode.MOV, mnemonic: `LDA ${M(ins.a)}`, bytes: 3,
                            cls: InstClass.MOV, dst: ins.dst, srcA: ins.a,
                        }));
                    }
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: 'CLC', bytes: 1, cls: InstClass.ALU,
                        resourceWrites: ['mos.carry'],
                    }));
                    e.push(mach({
                        op: Opcode.ADDI, mnemonic: `ADC #${ins.imm}`, bytes: 2,
                        cls: InstClass.ALU, dst: ins.dst, srcA: ins.dst, imm: ins.imm,
                        resourceReads: ['mos.acc', 'mos.carry'], resourceWrites: ['mos.acc', 'mos.carry'],
                    }));
                    break;
                case 'ldw':
                case 'ldd':
                    e.push(mach({
                        op: ins.kind === 'ldw' ? Opcode.LDW : Opcode.LDD,
                        mnemonic: `LDA ${ins.off}(${M(ins.base)})`,
                        bytes: 3, cls: InstClass.LD, dst: ins.dst, memBase: ins.base, memOff: ins.off,
                    }));
                    break;
                case 'stw':
                case 'std':
                    e.push(mach({
                        op: Opcode.MOV, mnemonic: `LDA ${M(ins.src)}`, bytes: 3,
                        cls: InstClass.MOV, srcA: ins.src,
                    }));
                    e.push(mach({
                        op: ins.kind === 'stw' ? Opcode.STW : Opcode.STD,
                        mnemonic: `STA ${ins.off}(${M(ins.base)})`,
                        bytes: 3, cls: InstClass.ST, srcA: ins.src, memBase: ins.base, memOff: ins.off,
                    }));
                    break;
                case 'ldw_s':
                case 'ldd_s': {
                    const sh = Math.log2(ins.scale);
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `LDA ${M(ins.index)}`, bytes: 3,
                        cls: InstClass.MOV, srcA: ins.index,
                    }));
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `ASL A ×${sh}`, bytes: Math.max(1, sh),
                        cls: InstClass.ALU, srcA: ins.index, imm: sh,
                    }));
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `ADC ${M(ins.base)}`, bytes: 3,
                        cls: InstClass.ALU, srcA: ins.base, srcB: ins.index,
                    }));
                    e.push(mach({
                        op: ins.kind === 'ldw_s' ? Opcode.LDW : Opcode.LDD,
                        mnemonic: `LDA (${M(ins.base)},${M(ins.index)})`,
                        bytes: 2, cls: InstClass.LD, dst: ins.dst,
                        memBase: ins.base, memIndex: ins.index, memScale: ins.scale, memOff: ins.off,
                    }));
                    break;
                }
                case 'stw_s':
                case 'std_s': {
                    const sh = Math.log2(ins.scale);
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `LDA ${M(ins.index)}`, bytes: 3,
                        cls: InstClass.MOV, srcA: ins.index,
                    }));
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `ASL A ×${sh}`, bytes: Math.max(1, sh),
                        cls: InstClass.ALU, srcA: ins.index, imm: sh,
                    }));
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `ADC ${M(ins.base)}`, bytes: 3,
                        cls: InstClass.ALU, srcA: ins.base, srcB: ins.index,
                    }));
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `LDA ${M(ins.src)}`, bytes: 3,
                        cls: InstClass.MOV, srcA: ins.src,
                    }));
                    e.push(mach({
                        op: ins.kind === 'stw_s' ? Opcode.STW : Opcode.STD,
                        mnemonic: `STA (${M(ins.base)},${M(ins.index)})`,
                        bytes: 2, cls: InstClass.ST, srcA: ins.src,
                        memBase: ins.base, memIndex: ins.index, memScale: ins.scale, memOff: ins.off,
                    }));
                    break;
                }
                case 'br':
                    e.push(mach({
                        op: Opcode.BR, mnemonic: `JMP ${ins.label}`, bytes: 3,
                        cls: InstClass.BR, label: ins.label,
                    }));
                    break;
                case 'brc':
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `CMP ${M(ins.a)}, ${M(ins.b)}`, bytes: 3,
                        cls: InstClass.ALU, srcA: ins.a, srcB: ins.b,
                        resourceReads: ['mos.acc'], resourceWrites: ['mos.flags'],
                    }));
                    e.push(mach({
                        op: condOp(ins.cond), mnemonic: `B${ins.cond.toUpperCase()} ${ins.label}`, bytes: 2,
                        cls: InstClass.BR, srcA: ins.a, srcB: ins.b, label: ins.label,
                        resourceReads: ['mos.flags'],
                    }));
                    break;
                case 'halt':
                    e.push(mach({
                        op: Opcode.HALT, mnemonic: `BRK  ; halt ${M(ins.src)}`, bytes: 2,
                        cls: InstClass.NOP, srcA: ins.src,
                    }));
                    break;
            }
        });
    }
}
function mosOp(op) {
    const names = {
        add: 'ADC', sub: 'SBC', mul: 'MUL', div: 'DIV', rem: 'MOD',
        and: 'AND', or: 'ORA', xor: 'EOR', shl: 'ASL', shr: 'LSR', sar: 'ASR',
        addf: 'FADD', subf: 'FSUB', mulf: 'FMUL', divf: 'FDIV',
    };
    return names[op] ?? op.toUpperCase();
}
//# sourceMappingURL=lower_extra.js.map