import { inSigned, i32, splitLui12 } from './bits.ts';
import { validateProgram } from './ir.ts';
import { assignAddresses, binClass, binOpcode, mach } from './mach.ts';
import { allocate, legalize } from './regalloc.ts';
import { emitThread, lowerMos, lowerPower, lowerSparc, lowerWasm } from './lower_extra.ts';
import { InstClass, IsaId, NONE, Opcode, OperationOrigin, STACK_TOP, } from './types.ts';
class Emit {
    insts = [];
    labels = new Map();
    scratches = [];
    label(name) {
        this.labels.set(name, this.insts.length);
    }
    push(m) {
        this.insts.push(m);
    }
    /**
     * Attribute one legal IR action structurally. Every emitted instruction is a
     * lowering helper unless it is the action's explicit final effect. Runtime
     * actions have no semantic operation; allocator spill actions are lowering.
     */
    action(ins, emit) {
        const start = this.insts.length;
        emit();
        const end = this.insts.length;
        const runtime = ins.origin === OperationOrigin.RUNTIME ||
            ins.kind === 'tid' || ins.kind === 'ptid' ||
            ins.kind === 'pnthreads' || ins.kind === 'nthreads' ||
            ins.kind === 'cstack_check' || ins.kind === 'barrier' ||
            ins.kind === 'call' || ins.kind === 'icall' || ins.kind === 'ret';
        const lowering = ins.origin === OperationOrigin.LOWERING ||
            ins.kind === 'spill_load' || ins.kind === 'spill_store';
        for (let i = start; i < end; i++) {
            this.insts[i].origin = runtime
                ? OperationOrigin.RUNTIME
                : OperationOrigin.LOWERING;
        }
        if (runtime || lowering || ins.kind === 'label')
            return;
        const isEffect = (m) => {
            switch (ins.kind) {
                case 'imm': return m.op === Opcode.LI || m.op === Opcode.ADDI;
                case 'immf': return m.op === Opcode.LIF;
                case 'mov': return m.op === Opcode.MOV;
                case 'convert':
                    return m.op === (ins.op === 'itod' ? Opcode.ITOD : ins.op === 'dtoi' ? Opcode.DTOI : Opcode.I8);
                case 'binop': return m.op === binOpcode(ins.op);
                case 'addi': return m.op === Opcode.ADDI || m.op === Opcode.ADD;
                case 'ldb': return m.op === Opcode.LDB;
                case 'stb': return m.op === Opcode.STB;
                case 'ldw':
                case 'ldw_s': return m.op === Opcode.LDW;
                case 'stw':
                case 'stw_s': return m.op === Opcode.STW;
                case 'ldd':
                case 'ldd_s': return m.op === Opcode.LDD;
                case 'std':
                case 'std_s': return m.op === Opcode.STD;
                case 'br': return m.op === Opcode.BR;
                case 'brc': return m.op === condOp(ins.cond);
                case 'halt': return m.op === Opcode.HALT;
                case 'labaddr': return m.op === Opcode.LI;
                default: return false;
            }
        };
        for (let i = end - 1; i >= start; i--) {
            if (isEffect(this.insts[i])) {
                this.insts[i].origin = OperationOrigin.SEMANTIC;
                return;
            }
        }
        // A self-move can legally disappear and therefore contributes no op.
        if (ins.kind !== 'mov') {
            throw new Error(`Lowerer emitted no semantic final effect for ${ins.kind}`);
        }
    }
    scratch(avoid) {
        for (const s of this.scratches) {
            if (!avoid.includes(s))
                return s;
        }
        throw new Error('No free scratch register');
    }
    finish() {
        for (const ins of this.insts) {
            if (ins.label) {
                const t = this.labels.get(ins.label);
                if (t === undefined)
                    throw new Error(`Unresolved label ${ins.label}`);
                ins.target = t;
                if (ins.op === Opcode.LI)
                    ins.imm = t;
            }
        }
        assignAddresses(this.insts);
        return this.insts;
    }
}
const RV_NAMES = [
    'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
    's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
    'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
    's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
];
const ARM_NAMES = Array.from({ length: 32 }, (_, i) => (i === 31 ? 'sp' : `x${i}`));
const MIPS_NAMES = [
    'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
    't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
    's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
    't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra',
];
const X86_NAMES = [
    'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
    'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
];
function rn(isa, r) {
    if (r < 0)
        return '';
    switch (isa) {
        case IsaId.RISCV:
            return RV_NAMES[r] ?? `x${r}`;
        case IsaId.ARM:
            return ARM_NAMES[r] ?? `x${r}`;
        case IsaId.X86:
            return X86_NAMES[r] ?? `r${r}`;
        case IsaId.MIPS:
            return MIPS_NAMES[r] ?? `$${r}`;
        case IsaId.POWER:
            return `r${r}`;
        case IsaId.SPARC:
            return ([
                '%g0', '%g1', '%g2', '%g3', '%g4', '%g5', '%g6', '%g7',
                '%o0', '%o1', '%o2', '%o3', '%o4', '%o5', '%sp', '%o7',
                '%l0', '%l1', '%l2', '%l3', '%l4', '%l5', '%l6', '%l7',
                '%i0', '%i1', '%i2', '%i3', '%i4', '%i5', '%fp', '%i7',
            ][r] ?? `%r${r}`);
        case IsaId.WASM:
            return `loc${r}`;
        case IsaId.MOS:
            return ['A', 'X', 'Y', 'S', 'Z0', 'Z1', 'Z2', 'Z3'][r] ?? `Z${r}`;
    }
}
function memStr(isa, base, off, index, scale) {
    const b = rn(isa, base);
    if (index >= 0) {
        if (isa === IsaId.X86) {
            const disp = off ? `+${off}` : '';
            return `[${b}+${rn(isa, index)}*${scale}${disp}]`;
        }
        if (isa === IsaId.ARM) {
            const sh = scale === 1 ? '' : `, lsl #${Math.log2(scale)}`;
            const extra = off ? `, #${off}` : '';
            return `[${b}, ${rn(isa, index)}${sh}${extra}]`;
        }
        if (isa === IsaId.POWER)
            return `${b}, ${rn(isa, index)}`;
        if (isa === IsaId.SPARC)
            return `[${b}+${rn(isa, index)}]`;
        if (isa === IsaId.WASM)
            return `[${b}+${rn(isa, index)}*${scale}]`;
    }
    if (isa === IsaId.X86)
        return off ? `[${b}+${off}]` : `[${b}]`;
    return `${off}(${b})`;
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
function lowerRiscV(ir, e) {
    const isa = IsaId.RISCV;
    const R = (r) => rn(isa, r);
    const li = (rd, imm) => {
        if (imm === 0) {
            e.push(mach({
                op: Opcode.LI, mnemonic: `addi ${R(rd)}, zero, 0`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: 0, imm: 0,
            }));
            return;
        }
        if (inSigned(imm, 12)) {
            e.push(mach({
                op: Opcode.LI, mnemonic: `addi ${R(rd)}, zero, ${imm}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: 0, imm,
            }));
            return;
        }
        const { upper, lower } = splitLui12(imm);
        e.push(mach({
            op: Opcode.LI, mnemonic: `lui ${R(rd)}, ${upper}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, imm: upper << 12,
        }));
        if (lower !== 0) {
            e.push(mach({
                op: Opcode.ADDI, mnemonic: `addi ${R(rd)}, ${R(rd)}, ${lower}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: rd, imm: lower,
            }));
        }
    };
    const expandAddi = (rd, rs, imm) => {
        if (inSigned(imm, 12)) {
            e.push(mach({
                op: Opcode.ADDI, mnemonic: `addi ${R(rd)}, ${R(rs)}, ${imm}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: rs, imm,
            }));
            return;
        }
        const t = e.scratch([rd, rs]);
        li(t, imm);
        e.push(mach({
            op: Opcode.ADD, mnemonic: `add ${R(rd)}, ${R(rs)}, ${R(t)}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, srcA: rs, srcB: t,
        }));
    };
    const expandMem = (kind, val, base, off) => {
        let b = base;
        let o = off;
        if (!inSigned(off, 12)) {
            const t = e.scratch([val, base]);
            expandAddi(t, base, off);
            b = t;
            o = 0;
        }
        const isLoad = kind === 'ldw' || kind === 'ldd';
        const op = kind === 'ldw' ? Opcode.LDW : kind === 'stw' ? Opcode.STW : kind === 'ldd' ? Opcode.LDD : Opcode.STD;
        const mnem = kind === 'ldw' ? 'lw' : kind === 'stw' ? 'sw' : kind === 'ldd' ? 'fld' : 'fsd';
        e.push(mach({
            op, mnemonic: `${mnem} ${R(val)}, ${memStr(isa, b, o, NONE, 1)}`, bytes: 4,
            cls: isLoad ? InstClass.LD : InstClass.ST,
            dst: isLoad ? val : NONE,
            srcA: isLoad ? NONE : val,
            memBase: b, memOff: o,
        }));
    };
    const expandScaled = (kind, val, base, index, scale, off) => {
        const sh = Math.log2(scale);
        const t = val !== base && val !== index && (kind === 'ldw_s' || kind === 'ldd_s')
            ? val
            : e.scratch([val, base, index]);
        e.push(mach({
            op: Opcode.SHL, mnemonic: `slli ${R(t)}, ${R(index)}, ${sh}`, bytes: 4,
            cls: InstClass.ALU, dst: t, srcA: index, imm: sh,
        }));
        e.push(mach({
            op: Opcode.ADD, mnemonic: `add ${R(t)}, ${R(base)}, ${R(t)}`, bytes: 4,
            cls: InstClass.ALU, dst: t, srcA: base, srcB: t,
        }));
        const plain = kind.replace('_s', '');
        expandMem(plain, val, t, off);
    };
    for (const ins of ir) {
        e.action(ins, () => {
            if (emitThread(e, ins, R))
                return;
            switch (ins.kind) {
                case 'label':
                    e.label(ins.name);
                    break;
                case 'imm':
                    li(ins.dst, i32(ins.value));
                    break;
                case 'immf':
                    e.push(mach({
                        op: Opcode.LIF, mnemonic: `li t; fmv.d.x f${ins.dst}, ${ins.value}`, bytes: 8,
                        cls: InstClass.MOV, dst: ins.dst, imm: ins.value, uops: 2,
                    }));
                    break;
                case 'mov':
                    e.push(mach({
                        op: Opcode.MOV, mnemonic: `addi ${R(ins.dst)}, ${R(ins.src)}, 0`, bytes: 4,
                        cls: InstClass.MOV, dst: ins.dst, srcA: ins.src,
                    }));
                    break;
                case 'binop':
                    e.push(mach({
                        op: binOpcode(ins.op),
                        mnemonic: `${rvBinName(ins.op)} ${R(ins.dst)}, ${R(ins.a)}, ${R(ins.b)}`,
                        bytes: 4, cls: binClass(ins.op), dst: ins.dst, srcA: ins.a, srcB: ins.b,
                    }));
                    break;
                case 'addi':
                    expandAddi(ins.dst, ins.a, ins.imm);
                    break;
                case 'ldw':
                    expandMem('ldw', ins.dst, ins.base, ins.off);
                    break;
                case 'stw':
                    expandMem('stw', ins.src, ins.base, ins.off);
                    break;
                case 'ldd':
                    expandMem('ldd', ins.dst, ins.base, ins.off);
                    break;
                case 'std':
                    expandMem('std', ins.src, ins.base, ins.off);
                    break;
                case 'ldw_s':
                    expandScaled('ldw_s', ins.dst, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'stw_s':
                    expandScaled('stw_s', ins.src, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'ldd_s':
                    expandScaled('ldd_s', ins.dst, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'std_s':
                    expandScaled('std_s', ins.src, ins.base, ins.index, ins.scale, ins.off);
                    break;
                case 'br':
                    e.push(mach({
                        op: Opcode.BR, mnemonic: `jal zero, ${ins.label}`, bytes: 4,
                        cls: InstClass.BR, label: ins.label,
                    }));
                    break;
                case 'brc':
                    e.push(mach({
                        op: condOp(ins.cond),
                        mnemonic: `b${ins.cond} ${R(ins.a)}, ${R(ins.b)}, ${ins.label}`,
                        bytes: 4, cls: InstClass.BR, srcA: ins.a, srcB: ins.b, label: ins.label,
                    }));
                    break;
                case 'halt':
                    e.push(mach({
                        op: Opcode.HALT, mnemonic: `unimp  # halt ${R(ins.src)}`, bytes: 4,
                        cls: InstClass.NOP, srcA: ins.src,
                    }));
                    break;
            }
        });
    }
}
function rvBinName(op) {
    const names = {
        add: 'add', sub: 'sub', mul: 'mul', div: 'div', rem: 'rem',
        and: 'and', or: 'or', xor: 'xor', shl: 'sll', shr: 'srl', sar: 'sra',
        addf: 'fadd.d', subf: 'fsub.d', mulf: 'fmul.d', divf: 'fdiv.d',
    };
    return names[op] ?? op;
}
function lowerArm(ir, e) {
    const isa = IsaId.ARM;
    const R = (r) => rn(isa, r);
    const li = (rd, imm) => {
        const v = i32(imm);
        const u = v >>> 0;
        if (u <= 0xffff) {
            e.push(mach({
                op: Opcode.LI, mnemonic: `movz ${R(rd)}, #${u}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, imm: v,
            }));
            return;
        }
        e.push(mach({
            op: Opcode.LI, mnemonic: `movz ${R(rd)}, #${u & 0xffff}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, imm: v & 0xffff,
        }));
        e.push(mach({
            op: Opcode.LI, mnemonic: `movk ${R(rd)}, #${(u >>> 16) & 0xffff}, lsl #16`, bytes: 4,
            cls: InstClass.ALU, dst: rd, imm: v,
        }));
    };
    const expandAddi = (rd, rs, imm) => {
        if (imm >= 0 && imm < 4096) {
            e.push(mach({
                op: Opcode.ADDI, mnemonic: `add ${R(rd)}, ${R(rs)}, #${imm}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: rs, imm,
            }));
            return;
        }
        if (imm < 0 && -imm < 4096) {
            e.push(mach({
                op: Opcode.ADDI, mnemonic: `sub ${R(rd)}, ${R(rs)}, #${-imm}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: rs, imm,
            }));
            return;
        }
        const t = e.scratch([rd, rs]);
        li(t, imm);
        e.push(mach({
            op: Opcode.ADD, mnemonic: `add ${R(rd)}, ${R(rs)}, ${R(t)}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, srcA: rs, srcB: t,
        }));
    };
    const plainMem = (kind, val, base, off) => {
        let b = base;
        let o = off;
        if (off < 0 || off >= 4096) {
            const t = e.scratch([val, base]);
            expandAddi(t, base, off);
            b = t;
            o = 0;
        }
        const isLoad = kind === 'ldw' || kind === 'ldd';
        const op = kind === 'ldw' ? Opcode.LDW : kind === 'stw' ? Opcode.STW : kind === 'ldd' ? Opcode.LDD : Opcode.STD;
        const mnem = kind === 'ldw' ? 'ldr' : kind === 'stw' ? 'str' : kind === 'ldd' ? 'ldr d' : 'str d';
        e.push(mach({
            op, mnemonic: `${mnem} ${R(val)}, ${memStr(isa, b, o, NONE, 1)}`, bytes: 4,
            cls: isLoad ? InstClass.LD : InstClass.ST,
            dst: isLoad ? val : NONE,
            srcA: isLoad ? NONE : val,
            memBase: b, memOff: o,
        }));
    };
    const scaled = (kind, val, base, index, scale, off) => {
        let b = base;
        if (off !== 0) {
            const t = e.scratch([val, base, index]);
            expandAddi(t, base, off);
            b = t;
        }
        const isLoad = kind === 'ldw_s' || kind === 'ldd_s';
        const op = kind.startsWith('ldw') ? Opcode.LDW : kind.startsWith('stw') ? Opcode.STW : kind.startsWith('ldd') ? Opcode.LDD : Opcode.STD;
        e.push(mach({
            op, mnemonic: `${isLoad ? 'ldr' : 'str'} ${R(val)}, ${memStr(isa, b, 0, index, scale)}`,
            bytes: 4, cls: isLoad ? InstClass.LD : InstClass.ST,
            dst: isLoad ? val : NONE,
            srcA: isLoad ? NONE : val,
            memBase: b, memIndex: index, memScale: scale,
            uops: 1,
        }));
    };
    for (const ins of ir) {
        e.action(ins, () => {
            if (emitThread(e, ins, R))
                return;
            switch (ins.kind) {
                case 'label':
                    e.label(ins.name);
                    break;
                case 'imm':
                    li(ins.dst, i32(ins.value));
                    break;
                case 'immf':
                    e.push(mach({
                        op: Opcode.LIF, mnemonic: `fmov d${ins.dst}, #${ins.value}`, bytes: 8,
                        cls: InstClass.MOV, dst: ins.dst, imm: ins.value, uops: 2,
                    }));
                    break;
                case 'mov':
                    e.push(mach({
                        op: Opcode.MOV, mnemonic: `mov ${R(ins.dst)}, ${R(ins.src)}`, bytes: 4,
                        cls: InstClass.MOV, dst: ins.dst, srcA: ins.src,
                    }));
                    break;
                case 'binop':
                    e.push(mach({
                        op: binOpcode(ins.op),
                        mnemonic: `${armBinName(ins.op)} ${R(ins.dst)}, ${R(ins.a)}, ${R(ins.b)}`,
                        bytes: 4, cls: binClass(ins.op), dst: ins.dst, srcA: ins.a, srcB: ins.b,
                    }));
                    break;
                case 'addi':
                    expandAddi(ins.dst, ins.a, ins.imm);
                    break;
                case 'ldw':
                    plainMem('ldw', ins.dst, ins.base, ins.off);
                    break;
                case 'stw':
                    plainMem('stw', ins.src, ins.base, ins.off);
                    break;
                case 'ldd':
                    plainMem('ldd', ins.dst, ins.base, ins.off);
                    break;
                case 'std':
                    plainMem('std', ins.src, ins.base, ins.off);
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
                        op: Opcode.NOP, mnemonic: `cmp ${R(ins.a)}, ${R(ins.b)}`, bytes: 4,
                        cls: InstClass.ALU, srcA: ins.a, srcB: ins.b, resourceWrites: ['arm.flags'],
                    }));
                    e.push(mach({
                        op: condOp(ins.cond),
                        mnemonic: `b.${ins.cond} ${ins.label}`, bytes: 4,
                        cls: InstClass.BR, srcA: ins.a, srcB: ins.b, label: ins.label,
                        resourceReads: ['arm.flags'],
                    }));
                    break;
                case 'halt':
                    e.push(mach({
                        op: Opcode.HALT, mnemonic: `brk #0  // halt ${R(ins.src)}`, bytes: 4,
                        cls: InstClass.NOP, srcA: ins.src,
                    }));
                    break;
            }
        });
    }
}
function armBinName(op) {
    const names = {
        add: 'add', sub: 'sub', mul: 'mul', div: 'sdiv', rem: 'msub',
        and: 'and', or: 'orr', xor: 'eor', shl: 'lsl', shr: 'lsr', sar: 'asr',
        addf: 'fadd', subf: 'fsub', mulf: 'fmul', divf: 'fdiv',
    };
    return names[op] ?? op;
}
function lowerMips(ir, e) {
    const isa = IsaId.MIPS;
    const R = (r) => rn(isa, r);
    const li = (rd, imm) => {
        if (inSigned(imm, 16)) {
            e.push(mach({
                op: Opcode.LI, mnemonic: `addiu ${R(rd)}, zero, ${imm}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: 0, imm,
            }));
            return;
        }
        const hi = (imm >>> 16) & 0xffff;
        const lo = imm & 0xffff;
        e.push(mach({
            op: Opcode.LI, mnemonic: `lui ${R(rd)}, 0x${hi.toString(16)}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, imm: hi << 16,
        }));
        if (lo) {
            e.push(mach({
                op: Opcode.LI, mnemonic: `ori ${R(rd)}, ${R(rd)}, 0x${lo.toString(16)}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, imm,
            }));
        }
    };
    const expandAddi = (rd, rs, imm) => {
        if (inSigned(imm, 16)) {
            e.push(mach({
                op: Opcode.ADDI, mnemonic: `addiu ${R(rd)}, ${R(rs)}, ${imm}`, bytes: 4,
                cls: InstClass.ALU, dst: rd, srcA: rs, imm,
            }));
            return;
        }
        const t = e.scratch([rd, rs]);
        li(t, imm);
        e.push(mach({
            op: Opcode.ADD, mnemonic: `addu ${R(rd)}, ${R(rs)}, ${R(t)}`, bytes: 4,
            cls: InstClass.ALU, dst: rd, srcA: rs, srcB: t,
        }));
    };
    const plainMem = (kind, val, base, off) => {
        let b = base;
        let o = off;
        if (!inSigned(off, 16)) {
            const t = e.scratch([val, base]);
            expandAddi(t, base, off);
            b = t;
            o = 0;
        }
        const isLoad = kind === 'ldw' || kind === 'ldd';
        const op = kind === 'ldw' ? Opcode.LDW : kind === 'stw' ? Opcode.STW : kind === 'ldd' ? Opcode.LDD : Opcode.STD;
        const mnem = kind === 'ldw' ? 'lw' : kind === 'stw' ? 'sw' : kind === 'ldd' ? 'ldc1' : 'sdc1';
        e.push(mach({
            op, mnemonic: `${mnem} ${R(val)}, ${memStr(isa, b, o, NONE, 1)}`, bytes: 4,
            cls: isLoad ? InstClass.LD : InstClass.ST,
            dst: isLoad ? val : NONE,
            srcA: isLoad ? NONE : val,
            memBase: b, memOff: o,
        }));
    };
    const scaled = (kind, val, base, index, scale, off) => {
        const sh = Math.log2(scale);
        const t = e.scratch([val, base, index]);
        e.push(mach({
            op: Opcode.SHL, mnemonic: `sll ${R(t)}, ${R(index)}, ${sh}`, bytes: 4,
            cls: InstClass.ALU, dst: t, srcA: index, imm: sh,
        }));
        e.push(mach({
            op: Opcode.ADD, mnemonic: `addu ${R(t)}, ${R(base)}, ${R(t)}`, bytes: 4,
            cls: InstClass.ALU, dst: t, srcA: base, srcB: t,
        }));
        plainMem(kind.replace('_s', ''), val, t, off);
    };
    for (const ins of ir) {
        e.action(ins, () => {
            if (emitThread(e, ins, R))
                return;
            switch (ins.kind) {
                case 'label':
                    e.label(ins.name);
                    break;
                case 'imm':
                    li(ins.dst, i32(ins.value));
                    break;
                case 'immf':
                    e.push(mach({
                        op: Opcode.LIF, mnemonic: `li.d $f${ins.dst}, ${ins.value}`, bytes: 8,
                        cls: InstClass.MOV, dst: ins.dst, imm: ins.value, uops: 2,
                    }));
                    break;
                case 'mov':
                    e.push(mach({
                        op: Opcode.MOV, mnemonic: `move ${R(ins.dst)}, ${R(ins.src)}`, bytes: 4,
                        cls: InstClass.MOV, dst: ins.dst, srcA: ins.src,
                    }));
                    break;
                case 'binop':
                    e.push(mach({
                        op: binOpcode(ins.op),
                        mnemonic: `${mipsBinName(ins.op)} ${R(ins.dst)}, ${R(ins.a)}, ${R(ins.b)}`,
                        bytes: 4, cls: binClass(ins.op), dst: ins.dst, srcA: ins.a, srcB: ins.b,
                    }));
                    break;
                case 'addi':
                    expandAddi(ins.dst, ins.a, ins.imm);
                    break;
                case 'ldw':
                    plainMem('ldw', ins.dst, ins.base, ins.off);
                    break;
                case 'stw':
                    plainMem('stw', ins.src, ins.base, ins.off);
                    break;
                case 'ldd':
                    plainMem('ldd', ins.dst, ins.base, ins.off);
                    break;
                case 'std':
                    plainMem('std', ins.src, ins.base, ins.off);
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
                        op: Opcode.BR, mnemonic: `j ${ins.label}`, bytes: 4,
                        cls: InstClass.BR, label: ins.label,
                    }));
                    break;
                case 'brc':
                    e.push(mach({
                        op: condOp(ins.cond),
                        mnemonic: `b${ins.cond} ${R(ins.a)}, ${R(ins.b)}, ${ins.label}`,
                        bytes: 4, cls: InstClass.BR, srcA: ins.a, srcB: ins.b, label: ins.label,
                    }));
                    break;
                case 'halt':
                    e.push(mach({
                        op: Opcode.HALT, mnemonic: `break  # halt ${R(ins.src)}`, bytes: 4,
                        cls: InstClass.NOP, srcA: ins.src,
                    }));
                    break;
            }
        });
    }
}
function mipsBinName(op) {
    const names = {
        add: 'addu', sub: 'subu', mul: 'mul', div: 'div', rem: 'rem',
        and: 'and', or: 'or', xor: 'xor', shl: 'sllv', shr: 'srlv', sar: 'srav',
        addf: 'add.d', subf: 'sub.d', mulf: 'mul.d', divf: 'div.d',
    };
    return names[op] ?? op;
}
function x86Size(kind) {
    switch (kind) {
        case 'rr':
            return 3;
        case 'ri':
            return 6;
        case 'rm':
            return 7;
        case 'j':
            return 6;
        case 'jmp':
            return 5;
        case 'li':
            return 5;
    }
}
function lowerX86(ir, e) {
    const isa = IsaId.X86;
    const R = (r) => rn(isa, r);
    const movRR = (rd, rs) => {
        if (rd === rs)
            return;
        e.push(mach({
            op: Opcode.MOV, mnemonic: `mov ${R(rd)}, ${R(rs)}`, bytes: x86Size('rr'),
            cls: InstClass.MOV, dst: rd, srcA: rs,
        }));
    };
    const twoAddr = (op, opcode, cls, rd, ra, rb) => {
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
                movRR(saved, rb);
                right = saved;
            }
        }
        if (rd === left) {
            e.push(mach({
                op: opcode, mnemonic: `${op} ${R(rd)}, ${R(right)}`, bytes: x86Size('rr'),
                cls, dst: rd, srcA: rd, srcB: right,
            }));
            return;
        }
        movRR(rd, left);
        e.push(mach({
            op: opcode, mnemonic: `${op} ${R(rd)}, ${R(right)}`, bytes: x86Size('rr'),
            cls, dst: rd, srcA: rd, srcB: right,
        }));
    };
    const memArgs = (base, off, index = NONE, scale = 1) => ({
        memBase: base, memOff: off, memIndex: index, memScale: scale,
    });
    for (const ins of ir) {
        e.action(ins, () => {
            if (emitThread(e, ins, R))
                return;
            switch (ins.kind) {
                case 'label':
                    e.label(ins.name);
                    break;
                case 'imm':
                    e.push(mach({
                        op: Opcode.LI, mnemonic: `mov ${R(ins.dst)}, ${i32(ins.value)}`, bytes: x86Size('li'),
                        cls: InstClass.ALU, dst: ins.dst, imm: i32(ins.value),
                    }));
                    break;
                case 'immf':
                    e.push(mach({
                        op: Opcode.LIF, mnemonic: `movsd xmm${ins.dst}, ${ins.value}`, bytes: 8,
                        cls: InstClass.MOV, dst: ins.dst, imm: ins.value,
                    }));
                    break;
                case 'mov':
                    movRR(ins.dst, ins.src);
                    break;
                case 'binop': {
                    const names = {
                        add: 'add', sub: 'sub', mul: 'imul', div: 'idiv', rem: 'idiv',
                        and: 'and', or: 'or', xor: 'xor', shl: 'shl', shr: 'shr', sar: 'sar',
                        addf: 'addsd', subf: 'subsd', mulf: 'mulsd', divf: 'divsd',
                    };
                    twoAddr(names[ins.op] ?? ins.op, binOpcode(ins.op), binClass(ins.op), ins.dst, ins.a, ins.b);
                    break;
                }
                case 'addi':
                    if (ins.dst === ins.a) {
                        e.push(mach({
                            op: Opcode.ADDI, mnemonic: `add ${R(ins.dst)}, ${ins.imm}`, bytes: x86Size('ri'),
                            cls: InstClass.ALU, dst: ins.dst, srcA: ins.dst, imm: ins.imm,
                        }));
                    }
                    else {
                        movRR(ins.dst, ins.a);
                        e.push(mach({
                            op: Opcode.ADDI, mnemonic: `add ${R(ins.dst)}, ${ins.imm}`, bytes: x86Size('ri'),
                            cls: InstClass.ALU, dst: ins.dst, srcA: ins.dst, imm: ins.imm,
                        }));
                    }
                    break;
                case 'ldw':
                    e.push(mach({
                        op: Opcode.LDW, mnemonic: `mov ${R(ins.dst)}, ${memStr(isa, ins.base, ins.off, NONE, 1)}`,
                        bytes: x86Size('rm'), cls: InstClass.LD, dst: ins.dst, ...memArgs(ins.base, ins.off),
                    }));
                    break;
                case 'stw':
                    e.push(mach({
                        op: Opcode.STW, mnemonic: `mov ${memStr(isa, ins.base, ins.off, NONE, 1)}, ${R(ins.src)}`,
                        bytes: x86Size('rm'), cls: InstClass.ST, srcA: ins.src, ...memArgs(ins.base, ins.off),
                    }));
                    break;
                case 'ldd':
                    e.push(mach({
                        op: Opcode.LDD, mnemonic: `movsd xmm${ins.dst}, ${memStr(isa, ins.base, ins.off, NONE, 1)}`,
                        bytes: 8, cls: InstClass.LD, dst: ins.dst, ...memArgs(ins.base, ins.off),
                    }));
                    break;
                case 'std':
                    e.push(mach({
                        op: Opcode.STD, mnemonic: `movsd ${memStr(isa, ins.base, ins.off, NONE, 1)}, xmm${ins.src}`,
                        bytes: 8, cls: InstClass.ST, srcA: ins.src, ...memArgs(ins.base, ins.off),
                    }));
                    break;
                case 'ldw_s':
                    e.push(mach({
                        op: Opcode.LDW,
                        mnemonic: `mov ${R(ins.dst)}, ${memStr(isa, ins.base, ins.off, ins.index, ins.scale)}`,
                        bytes: 8, cls: InstClass.LD, dst: ins.dst,
                        ...memArgs(ins.base, ins.off, ins.index, ins.scale),
                    }));
                    break;
                case 'stw_s':
                    e.push(mach({
                        op: Opcode.STW,
                        mnemonic: `mov ${memStr(isa, ins.base, ins.off, ins.index, ins.scale)}, ${R(ins.src)}`,
                        bytes: 8, cls: InstClass.ST, srcA: ins.src,
                        ...memArgs(ins.base, ins.off, ins.index, ins.scale),
                    }));
                    break;
                case 'ldd_s':
                    e.push(mach({
                        op: Opcode.LDD,
                        mnemonic: `movsd xmm${ins.dst}, ${memStr(isa, ins.base, ins.off, ins.index, ins.scale)}`,
                        bytes: 9, cls: InstClass.LD, dst: ins.dst,
                        ...memArgs(ins.base, ins.off, ins.index, ins.scale),
                    }));
                    break;
                case 'std_s':
                    e.push(mach({
                        op: Opcode.STD,
                        mnemonic: `movsd ${memStr(isa, ins.base, ins.off, ins.index, ins.scale)}, xmm${ins.src}`,
                        bytes: 9, cls: InstClass.ST, srcA: ins.src,
                        ...memArgs(ins.base, ins.off, ins.index, ins.scale),
                    }));
                    break;
                case 'br':
                    e.push(mach({
                        op: Opcode.BR, mnemonic: `jmp ${ins.label}`, bytes: x86Size('jmp'),
                        cls: InstClass.BR, label: ins.label,
                    }));
                    break;
                case 'brc': {
                    const cc = { eq: 'e', ne: 'ne', lt: 'l', ge: 'ge' };
                    e.push(mach({
                        op: Opcode.NOP, mnemonic: `cmp ${R(ins.a)}, ${R(ins.b)}`, bytes: x86Size('rr'),
                        cls: InstClass.ALU, srcA: ins.a, srcB: ins.b, resourceWrites: ['x86.flags'],
                    }));
                    e.push(mach({
                        op: condOp(ins.cond), mnemonic: `j${cc[ins.cond]} ${ins.label}`, bytes: x86Size('j'),
                        cls: InstClass.BR, srcA: ins.a, srcB: ins.b, label: ins.label,
                        resourceReads: ['x86.flags'],
                    }));
                    break;
                }
                case 'halt':
                    e.push(mach({
                        op: Opcode.HALT, mnemonic: `ud2  ; halt ${R(ins.src)}`, bytes: 2,
                        cls: InstClass.NOP, srcA: ins.src,
                    }));
                    break;
            }
        });
    }
}
export function compile(prog, isa) {
    validateProgram(prog);
    const alloc = allocate(prog.insts, isa);
    const legal = legalize(prog.insts, alloc);
    const e = new Emit();
    e.scratches = alloc.scratches;
    e.push(mach({
        op: Opcode.LI,
        mnemonic: isa === IsaId.X86
            ? `mov ${rn(isa, alloc.sp)}, ${STACK_TOP}`
            : isa === IsaId.ARM
                ? `movz ${rn(isa, alloc.sp)}, #${STACK_TOP}`
                : isa === IsaId.WASM
                    ? `i32.const ${STACK_TOP} / local.set ${rn(isa, alloc.sp)}`
                    : isa === IsaId.MOS
                        ? `LDA #${STACK_TOP} / STA S`
                        : `li ${rn(isa, alloc.sp)}, ${STACK_TOP}`,
        bytes: isa === IsaId.X86 || isa === IsaId.WASM ? 7 : isa === IsaId.MOS ? 5 : 4,
        cls: InstClass.ALU,
        dst: alloc.sp,
        imm: STACK_TOP,
        origin: OperationOrigin.RUNTIME,
    }));
    switch (isa) {
        case IsaId.RISCV:
            lowerRiscV(legal, e);
            break;
        case IsaId.ARM:
            lowerArm(legal, e);
            break;
        case IsaId.X86:
            lowerX86(legal, e);
            break;
        case IsaId.MIPS:
            lowerMips(legal, e);
            break;
        case IsaId.POWER:
            lowerPower(legal, e);
            break;
        case IsaId.SPARC:
            lowerSparc(legal, e);
            break;
        case IsaId.WASM:
            lowerWasm(legal, e);
            break;
        case IsaId.MOS:
            lowerMos(legal, e);
            break;
    }
    const insts = e.finish();
    return {
        isa,
        insts,
        codeBytes: insts.reduce((n, i) => n + i.bytes, 0),
        spillSlots: alloc.stackSlots,
        physRegsUsed: alloc.physUsed.size,
    };
}
export function disassemble(program, limit = 80) {
    return program.insts.slice(0, limit).map((ins, i) => {
        const hex = ins.addr.toString(16).padStart(4, '0');
        return `${String(i).padStart(4, ' ')}  ${hex}  ${ins.mnemonic}`;
    });
}
//# sourceMappingURL=compile.js.map