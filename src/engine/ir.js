import { readGuestStdout } from './guestio.ts';
import { C_PARK_BYTES, C_STACK_BASE, C_STACK_STRIDE, DATA_BASE, MEM_SIZE, NONE, } from './types.ts';
import { i32, idiv, imul, irem, isar, ishl, ishr } from './bits.ts';
export const BinOp = {
    ADD: 'add',
    SUB: 'sub',
    MUL: 'mul',
    DIV: 'div',
    REM: 'rem',
    AND: 'and',
    OR: 'or',
    XOR: 'xor',
    SHL: 'shl',
    SHR: 'shr',
    SAR: 'sar',
    ADDF: 'addf',
    SUBF: 'subf',
    MULF: 'mulf',
    DIVF: 'divf',
    EQF: 'eqf',
    NEF: 'nef',
    LTF: 'ltf',
    GEF: 'gef',
};
export const Cond = {
    EQ: 'eq',
    NE: 'ne',
    LT: 'lt',
    GE: 'ge',
};
export const VALID_MEMORY_SCALES = [1, 2, 4, 8];
export function validateMemoryScale(scale) {
    if (!VALID_MEMORY_SCALES.includes(scale)) {
        throw new Error(`Unsupported memory scale ${scale}; expected one of 1, 2, 4, 8`);
    }
}
export function validateProgram(prog) {
    for (const ins of prog.insts) {
        switch (ins.kind) {
            case 'ldw_s':
            case 'stw_s':
            case 'ldd_s':
            case 'std_s':
                validateMemoryScale(ins.scale);
        }
    }
}
export function virtUses(inst) {
    switch (inst.kind) {
        case 'imm':
        case 'immf':
        case 'label':
        case 'br':
            return [];
        case 'mov':
        case 'convert':
            return [inst.src];
        case 'binop':
            return [inst.a, inst.b];
        case 'addi':
            return [inst.a];
        case 'ldw':
        case 'ldd':
        case 'ldb':
            return [inst.base];
        case 'stw':
        case 'std':
        case 'stb':
            return [inst.src, inst.base];
        case 'ldw_s':
        case 'ldd_s':
            return [inst.base, inst.index];
        case 'stw_s':
        case 'std_s':
            return [inst.src, inst.base, inst.index];
        case 'brc':
            return [inst.a, inst.b];
        case 'halt':
        case 'cstack_check':
            return [inst.src];
        case 'tid':
        case 'ptid':
        case 'pnthreads':
        case 'nthreads':
        case 'barrier':
        case 'call':
        case 'ret':
        case 'labaddr':
            return [];
        case 'icall':
            return [inst.fn];
        case 'spill_load':
            return [];
        case 'spill_store':
            return [inst.src];
    }
}
export function virtDef(inst) {
    switch (inst.kind) {
        case 'imm':
        case 'immf':
        case 'mov':
        case 'convert':
        case 'binop':
        case 'addi':
        case 'ldw':
        case 'ldd':
        case 'ldb':
        case 'ldw_s':
        case 'ldd_s':
        case 'tid':
        case 'ptid':
        case 'pnthreads':
        case 'nthreads':
        case 'labaddr':
        case 'spill_load':
            return inst.dst;
        default:
            return NONE;
    }
}
export function evalBin(op, a, b) {
    switch (op) {
        case 'add':
            return i32(a + b);
        case 'sub':
            return i32(a - b);
        case 'mul':
            return imul(a, b);
        case 'div':
            return idiv(a, b);
        case 'rem':
            return irem(a, b);
        case 'and':
            return i32(a) & i32(b);
        case 'or':
            return i32(a) | i32(b);
        case 'xor':
            return i32(a) ^ i32(b);
        case 'shl':
            return ishl(a, b);
        case 'shr':
            return ishr(a, b);
        case 'sar':
            return isar(a, b);
        case 'addf':
            return a + b;
        case 'subf':
            return a - b;
        case 'mulf':
            return a * b;
        case 'divf':
            return a / b;
        case 'eqf':
            return a === b ? 1 : 0;
        case 'nef':
            return a !== b ? 1 : 0;
        case 'ltf':
            return a < b ? 1 : 0;
        case 'gef':
            return a >= b ? 1 : 0;
    }
}
export function evalCond(cond, a, b) {
    const x = i32(a);
    const y = i32(b);
    switch (cond) {
        case 'eq':
            return x === y;
        case 'ne':
            return x !== y;
        case 'lt':
            return x < y;
        case 'ge':
            return x >= y;
    }
}
export function applyData(mem, data) {
    const view = new DataView(mem);
    for (const blob of data) {
        for (let i = 0; i < blob.bytes.length; i++) {
            const addr = blob.addr + i;
            checkMemoryAccess('applyData byte store', addr, 1, mem.byteLength);
            view.setUint8(addr, blob.bytes[i] & 0xff);
        }
        for (let i = 0; i < blob.words.length; i++) {
            const addr = blob.addr + i * 4;
            checkMemoryAccess('applyData word store', addr, 4, mem.byteLength);
            view.setInt32(addr, blob.words[i] | 0, true);
        }
        for (let i = 0; i < blob.floats.length; i++) {
            const addr = blob.addr + i * 8;
            checkMemoryAccess('applyData float store', addr, 8, mem.byteLength);
            view.setFloat64(addr, blob.floats[i], true);
        }
    }
}
export function checkMemoryAccess(operation, address, width, size) {
    if (!Number.isSafeInteger(address) || address < 0 || address > size - width) {
        throw new Error(`Guest memory fault: ${operation} at address ${address} (width ${width}, memory size ${size})`);
    }
}
export function interpretIr(prog, mem) {
    const maxReg = prog.insts.reduce((n, ins) => {
        const d = virtDef(ins);
        return Math.max(n, d, ...virtUses(ins));
    }, 0);
    const regs = new Float64Array(maxReg + 1);
    const view = new DataView(mem);
    const labels = new Map();
    prog.insts.forEach((ins, i) => {
        if (ins.kind === 'label')
            labels.set(ins.name, i);
    });
    const ea = (base, off, index = 0, scale = 0) => {
        return i32(regs[base] + off + (scale ? regs[index] * scale : 0));
    };
    let pc = 0;
    let steps = 0;
    const calls = [];
    const maxSteps = 100_000_000;
    while (pc < prog.insts.length && steps < maxSteps) {
        const ins = prog.insts[pc];
        steps += 1;
        switch (ins.kind) {
            case 'label':
                pc += 1;
                break;
            case 'imm':
                regs[ins.dst] = i32(ins.value);
                pc += 1;
                break;
            case 'immf':
                regs[ins.dst] = ins.value;
                pc += 1;
                break;
            case 'mov':
                regs[ins.dst] = regs[ins.src];
                pc += 1;
                break;
            case 'convert':
                regs[ins.dst] = ins.op === 'itod'
                    ? i32(regs[ins.src])
                    : ins.op === 'i8'
                        ? (i32(regs[ins.src]) << 24) >> 24
                        : i32(Math.trunc(regs[ins.src]));
                pc += 1;
                break;
            case 'binop':
                regs[ins.dst] = evalBin(ins.op, regs[ins.a], regs[ins.b]);
                pc += 1;
                break;
            case 'addi':
                regs[ins.dst] = i32(regs[ins.a] + ins.imm);
                pc += 1;
                break;
            case 'ldw':
                {
                    const addr = ea(ins.base, ins.off);
                    checkMemoryAccess('IR ldw', addr, 4, mem.byteLength);
                    regs[ins.dst] = view.getInt32(addr, true);
                }
                pc += 1;
                break;
            case 'ldb':
                {
                    const addr = ea(ins.base, ins.off);
                    checkMemoryAccess('IR ldb', addr, 1, mem.byteLength);
                    regs[ins.dst] = view.getInt8(addr);
                }
                pc += 1;
                break;
            case 'stw':
                {
                    const addr = ea(ins.base, ins.off);
                    checkMemoryAccess('IR stw', addr, 4, mem.byteLength);
                    view.setInt32(addr, i32(regs[ins.src]), true);
                }
                pc += 1;
                break;
            case 'stb':
                {
                    const addr = ea(ins.base, ins.off);
                    checkMemoryAccess('IR stb', addr, 1, mem.byteLength);
                    view.setInt8(addr, i32(regs[ins.src]));
                }
                pc += 1;
                break;
            case 'ldd':
                {
                    const addr = ea(ins.base, ins.off);
                    checkMemoryAccess('IR ldd', addr, 8, mem.byteLength);
                    regs[ins.dst] = view.getFloat64(addr, true);
                }
                pc += 1;
                break;
            case 'std':
                {
                    const addr = ea(ins.base, ins.off);
                    checkMemoryAccess('IR std', addr, 8, mem.byteLength);
                    view.setFloat64(addr, regs[ins.src], true);
                }
                pc += 1;
                break;
            case 'ldw_s':
                {
                    const addr = ea(ins.base, ins.off, ins.index, ins.scale);
                    checkMemoryAccess('IR scaled ldw', addr, 4, mem.byteLength);
                    regs[ins.dst] = view.getInt32(addr, true);
                }
                pc += 1;
                break;
            case 'stw_s':
                {
                    const addr = ea(ins.base, ins.off, ins.index, ins.scale);
                    checkMemoryAccess('IR scaled stw', addr, 4, mem.byteLength);
                    view.setInt32(addr, i32(regs[ins.src]), true);
                }
                pc += 1;
                break;
            case 'ldd_s':
                {
                    const addr = ea(ins.base, ins.off, ins.index, ins.scale);
                    checkMemoryAccess('IR scaled ldd', addr, 8, mem.byteLength);
                    regs[ins.dst] = view.getFloat64(addr, true);
                }
                pc += 1;
                break;
            case 'std_s':
                {
                    const addr = ea(ins.base, ins.off, ins.index, ins.scale);
                    checkMemoryAccess('IR scaled std', addr, 8, mem.byteLength);
                    view.setFloat64(addr, regs[ins.src], true);
                }
                pc += 1;
                break;
            case 'br': {
                const t = labels.get(ins.label);
                if (t === undefined)
                    throw new Error(`Unknown label ${ins.label}`);
                pc = t;
                break;
            }
            case 'brc': {
                if (evalCond(ins.cond, regs[ins.a], regs[ins.b])) {
                    const t = labels.get(ins.label);
                    if (t === undefined)
                        throw new Error(`Unknown label ${ins.label}`);
                    pc = t;
                }
                else {
                    pc += 1;
                }
                break;
            }
            case 'halt':
                return { value: regs[ins.src], steps, stdout: readGuestStdout(mem) };
            case 'call': {
                const t = labels.get(ins.label);
                if (t === undefined)
                    throw new Error(`Unknown label ${ins.label}`);
                calls.push(pc + 1);
                pc = t;
                break;
            }
            case 'ret': {
                const back = calls.pop();
                if (back === undefined)
                    throw new Error('RET with empty call stack');
                pc = back;
                break;
            }
            case 'icall': {
                calls.push(pc + 1);
                pc = i32(regs[ins.fn]);
                break;
            }
            case 'labaddr': {
                const t = labels.get(ins.label);
                if (t === undefined)
                    throw new Error(`Unknown label ${ins.label}`);
                regs[ins.dst] = t;
                pc += 1;
                break;
            }
            case 'tid':
                regs[ins.dst] = 0;
                pc += 1;
                break;
            case 'ptid':
                regs[ins.dst] = 0;
                pc += 1;
                break;
            case 'pnthreads':
                regs[ins.dst] = 1;
                pc += 1;
                break;
            case 'nthreads':
                regs[ins.dst] = 1;
                pc += 1;
                break;
            case 'cstack_check': {
                const ptr = i32(regs[ins.src]);
                const low = C_STACK_BASE;
                const high = C_STACK_BASE + C_STACK_STRIDE;
                const valid = ins.area === 'software'
                    ? ptr >= low + C_PARK_BYTES && ptr <= high
                    : ptr >= low && ptr <= low + C_PARK_BYTES;
                if (!valid) {
                    throw new Error(`Guest C ${ins.area} stack fault for worker 0 at address ${ptr} (region ${low}..${high})`);
                }
                pc += 1;
                break;
            }
            case 'barrier':
                pc += 1;
                break;
            case 'spill_load':
            case 'spill_store':
                throw new Error('Allocator spill instruction is invalid in source IR');
        }
    }
    throw new Error('IR program did not halt');
}
export class IrBuilder {
    insts = [];
    data = [];
    nextVirt = 0;
    nextLab = 0;
    reg() {
        const r = this.nextVirt;
        this.nextVirt += 1;
        return r;
    }
    ensureVirt(n) {
        if (n + 1 > this.nextVirt)
            this.nextVirt = n + 1;
    }
    lab(prefix = 'L') {
        const name = `${prefix}${this.nextLab}`;
        this.nextLab += 1;
        return name;
    }
    imm(value) {
        const dst = this.reg();
        this.insts.push({ kind: 'imm', dst, value: i32(value) });
        return dst;
    }
    immf(value) {
        const dst = this.reg();
        this.insts.push({ kind: 'immf', dst, value });
        return dst;
    }
    mov(src) {
        const dst = this.reg();
        this.insts.push({ kind: 'mov', dst, src });
        return dst;
    }
    movTo(dst, src) {
        this.insts.push({ kind: 'mov', dst, src });
    }
    convert(op, src) {
        const dst = this.reg();
        this.insts.push({ kind: 'convert', op, dst, src });
        return dst;
    }
    bin(op, a, b) {
        const dst = this.reg();
        this.insts.push({ kind: 'binop', op, dst, a, b });
        return dst;
    }
    binTo(op, dst, a, b) {
        this.insts.push({ kind: 'binop', op, dst, a, b });
    }
    add(a, b) {
        return this.bin('add', a, b);
    }
    sub(a, b) {
        return this.bin('sub', a, b);
    }
    mul(a, b) {
        return this.bin('mul', a, b);
    }
    and(a, b) {
        return this.bin('and', a, b);
    }
    or(a, b) {
        return this.bin('or', a, b);
    }
    xor(a, b) {
        return this.bin('xor', a, b);
    }
    shl(a, b) {
        return this.bin('shl', a, b);
    }
    shr(a, b) {
        return this.bin('shr', a, b);
    }
    addf(a, b) {
        return this.bin('addf', a, b);
    }
    mulf(a, b) {
        return this.bin('mulf', a, b);
    }
    addTo(dst, a, b) {
        this.binTo('add', dst, a, b);
    }
    subTo(dst, a, b) {
        this.binTo('sub', dst, a, b);
    }
    mulTo(dst, a, b) {
        this.binTo('mul', dst, a, b);
    }
    addfTo(dst, a, b) {
        this.binTo('addf', dst, a, b);
    }
    mulfTo(dst, a, b) {
        this.binTo('mulf', dst, a, b);
    }
    addi(a, imm) {
        const dst = this.reg();
        this.insts.push({ kind: 'addi', dst, a, imm: i32(imm) });
        return dst;
    }
    addiTo(dst, a, imm) {
        this.insts.push({ kind: 'addi', dst, a, imm: i32(imm) });
    }
    ldw(base, off = 0) {
        const dst = this.reg();
        this.insts.push({ kind: 'ldw', dst, base, off });
        return dst;
    }
    stw(src, base, off = 0) {
        this.insts.push({ kind: 'stw', src, base, off });
    }
    ldb(base, off = 0) {
        const dst = this.reg();
        this.insts.push({ kind: 'ldb', dst, base, off });
        return dst;
    }
    stb(src, base, off = 0) {
        this.insts.push({ kind: 'stb', src, base, off });
    }
    ldd(base, off = 0) {
        const dst = this.reg();
        this.insts.push({ kind: 'ldd', dst, base, off });
        return dst;
    }
    std(src, base, off = 0) {
        this.insts.push({ kind: 'std', src, base, off });
    }
    ldwS(base, index, scale = 4, off = 0) {
        validateMemoryScale(scale);
        const dst = this.reg();
        this.insts.push({ kind: 'ldw_s', dst, base, index, scale, off });
        return dst;
    }
    stwS(src, base, index, scale = 4, off = 0) {
        validateMemoryScale(scale);
        this.insts.push({ kind: 'stw_s', src, base, index, scale, off });
    }
    lddS(base, index, scale = 8, off = 0) {
        validateMemoryScale(scale);
        const dst = this.reg();
        this.insts.push({ kind: 'ldd_s', dst, base, index, scale, off });
        return dst;
    }
    stdS(src, base, index, scale = 8, off = 0) {
        validateMemoryScale(scale);
        this.insts.push({ kind: 'std_s', src, base, index, scale, off });
    }
    label(name) {
        this.insts.push({ kind: 'label', name });
    }
    br(label) {
        this.insts.push({ kind: 'br', label });
    }
    brc(cond, a, b, label) {
        this.insts.push({ kind: 'brc', cond, a, b, label });
    }
    beq(a, b, label) {
        this.brc('eq', a, b, label);
    }
    bne(a, b, label) {
        this.brc('ne', a, b, label);
    }
    blt(a, b, label) {
        this.brc('lt', a, b, label);
    }
    bge(a, b, label) {
        this.brc('ge', a, b, label);
    }
    halt(src) {
        this.insts.push({ kind: 'halt', src });
    }
    tid() {
        const dst = this.reg();
        this.insts.push({ kind: 'tid', dst });
        return dst;
    }
    privateTid() {
        const dst = this.reg();
        this.insts.push({ kind: 'ptid', dst });
        return dst;
    }
    privateNthreads() {
        const dst = this.reg();
        this.insts.push({ kind: 'pnthreads', dst });
        return dst;
    }
    nthreads() {
        const dst = this.reg();
        this.insts.push({ kind: 'nthreads', dst });
        return dst;
    }
    cstackCheck(src, area) {
        this.insts.push({ kind: 'cstack_check', src, area });
    }
    barrier() {
        this.insts.push({ kind: 'barrier' });
    }
    call(label) {
        this.insts.push({ kind: 'call', label });
    }
    ret() {
        this.insts.push({ kind: 'ret' });
    }
    icall(fn) {
        this.insts.push({ kind: 'icall', fn });
    }
    labaddr(label) {
        const dst = this.reg();
        this.insts.push({ kind: 'labaddr', dst, label });
        return dst;
    }
    words(addr, values) {
        this.data.push({ addr, bytes: [], words: values.map(i32), floats: [] });
    }
    floats(addr, values) {
        this.data.push({ addr, bytes: [], words: [], floats: values });
    }
    bytes(addr, values) {
        this.data.push({ addr, bytes: values.map((v) => v & 0xff), words: [], floats: [] });
    }
    program() {
        return { insts: this.insts, data: this.data, memSize: MEM_SIZE };
    }
}
export function parseIr(source) {
    const b = new IrBuilder();
    const lines = source.split(/\r?\n/);
    let dataAddr = DATA_BASE;
    let inData = false;
    const parseReg = (tok) => {
        const m = /^r(\d+)$/i.exec(tok);
        if (!m)
            throw new Error(`Expected register, got "${tok}"`);
        const n = Number(m[1]);
        b.ensureVirt(n);
        return n;
    };
    const parseNum = (tok) => {
        if (tok.startsWith('0x') || tok.startsWith('0X'))
            return Number.parseInt(tok, 16);
        const n = Number(tok);
        if (!Number.isFinite(n))
            throw new Error(`Expected number, got "${tok}"`);
        return n;
    };
    const parseMem = (tokens, start) => {
        const joined = tokens.slice(start).join(',');
        const m = /^(-?\d+)?\((r\d+)(?:,(r\d+)(?:,(\d+))?)?\)$/i.exec(joined);
        if (m) {
            if (m[4])
                validateMemoryScale(Number(m[4]));
            return {
                off: m[1] ? Number(m[1]) : 0,
                base: parseReg(m[2]),
                index: m[3] ? parseReg(m[3]) : undefined,
                scale: m[4] ? Number(m[4]) : undefined,
            };
        }
        const t = tokens[start];
        if (tokens[start + 1] !== undefined && tokens[start + 2] !== undefined) {
            return { base: parseReg(tokens[start]), off: parseNum(tokens[start + 1]) };
        }
        return { base: parseReg(t), off: 0 };
    };
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        let line = lines[lineNo];
        line = line.replace(/[#;].*$/, '').trim();
        if (!line)
            continue;
        if (/^\.data\b/i.test(line)) {
            const parts = line.split(/\s+/);
            dataAddr = parts[1] ? parseNum(parts[1]) : DATA_BASE;
            inData = true;
            continue;
        }
        if (/^\.text\b/i.test(line)) {
            inData = false;
            continue;
        }
        if (/^\.word\b/i.test(line)) {
            const nums = line.split(/\s+/).slice(1).map(parseNum);
            b.words(dataAddr, nums);
            dataAddr += nums.length * 4;
            continue;
        }
        if (/^\.byte\b/i.test(line)) {
            const nums = line.split(/\s+/).slice(1).map(parseNum);
            b.bytes(dataAddr, nums);
            dataAddr += nums.length;
            continue;
        }
        if (/^\.(?:double|float)\b/i.test(line)) {
            const nums = line.split(/\s+/).slice(1).map(parseNum);
            b.floats(dataAddr, nums);
            dataAddr += nums.length * 8;
            continue;
        }
        if (inData) {
            throw new Error(`Line ${lineNo + 1}: unexpected instruction in .data`);
        }
        if (/^[A-Za-z_]\w*:$/.test(line)) {
            b.label(line.slice(0, -1));
            continue;
        }
        const colon = line.match(/^([A-Za-z_]\w*):(.+)$/);
        if (colon) {
            b.label(colon[1]);
            line = colon[2].trim();
            if (!line)
                continue;
        }
        const tokens = line.replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
        const op = tokens[0].toLowerCase();
        const a = tokens.slice(1);
        try {
            switch (op) {
                case 'imm':
                    b.insts.push({ kind: 'imm', dst: parseReg(a[0]), value: i32(parseNum(a[1])) });
                    break;
                case 'immf':
                    b.insts.push({ kind: 'immf', dst: parseReg(a[0]), value: parseNum(a[1]) });
                    break;
                case 'mov':
                    b.insts.push({ kind: 'mov', dst: parseReg(a[0]), src: parseReg(a[1]) });
                    break;
                case 'itod':
                case 'dtoi':
                case 'i8':
                    b.insts.push({ kind: 'convert', op, dst: parseReg(a[0]), src: parseReg(a[1]) });
                    break;
                case 'add':
                case 'sub':
                case 'mul':
                case 'div':
                case 'rem':
                case 'and':
                case 'or':
                case 'xor':
                case 'shl':
                case 'shr':
                case 'sar':
                case 'addf':
                case 'subf':
                case 'mulf':
                case 'divf':
                case 'eqf':
                case 'nef':
                case 'ltf':
                case 'gef':
                    b.insts.push({
                        kind: 'binop',
                        op,
                        dst: parseReg(a[0]),
                        a: parseReg(a[1]),
                        b: parseReg(a[2]),
                    });
                    break;
                case 'addi':
                    b.insts.push({
                        kind: 'addi',
                        dst: parseReg(a[0]),
                        a: parseReg(a[1]),
                        imm: i32(parseNum(a[2])),
                    });
                    break;
                case 'ldw': {
                    const m = parseMem(a, 1);
                    if (m.index !== undefined) {
                        b.insts.push({
                            kind: 'ldw_s',
                            dst: parseReg(a[0]),
                            base: m.base,
                            index: m.index,
                            scale: m.scale ?? 4,
                            off: m.off,
                        });
                    }
                    else {
                        b.insts.push({ kind: 'ldw', dst: parseReg(a[0]), base: m.base, off: m.off });
                    }
                    break;
                }
                case 'ldb': {
                    const m = parseMem(a, 1);
                    if (m.index !== undefined)
                        throw new Error('ldb does not support indexed syntax; compute the byte address explicitly');
                    b.insts.push({ kind: 'ldb', dst: parseReg(a[0]), base: m.base, off: m.off });
                    break;
                }
                case 'stb': {
                    const m = parseMem(a, 1);
                    if (m.index !== undefined)
                        throw new Error('stb does not support indexed syntax; compute the byte address explicitly');
                    b.insts.push({ kind: 'stb', src: parseReg(a[0]), base: m.base, off: m.off });
                    break;
                }
                case 'stw': {
                    const m = parseMem(a, 1);
                    if (m.index !== undefined) {
                        b.insts.push({
                            kind: 'stw_s',
                            src: parseReg(a[0]),
                            base: m.base,
                            index: m.index,
                            scale: m.scale ?? 4,
                            off: m.off,
                        });
                    }
                    else {
                        b.insts.push({ kind: 'stw', src: parseReg(a[0]), base: m.base, off: m.off });
                    }
                    break;
                }
                case 'ldd': {
                    const m = parseMem(a, 1);
                    if (m.index !== undefined) {
                        b.insts.push({
                            kind: 'ldd_s',
                            dst: parseReg(a[0]),
                            base: m.base,
                            index: m.index,
                            scale: m.scale ?? 8,
                            off: m.off,
                        });
                    }
                    else {
                        b.insts.push({ kind: 'ldd', dst: parseReg(a[0]), base: m.base, off: m.off });
                    }
                    break;
                }
                case 'std': {
                    const m = parseMem(a, 1);
                    if (m.index !== undefined) {
                        b.insts.push({
                            kind: 'std_s',
                            src: parseReg(a[0]),
                            base: m.base,
                            index: m.index,
                            scale: m.scale ?? 8,
                            off: m.off,
                        });
                    }
                    else {
                        b.insts.push({ kind: 'std', src: parseReg(a[0]), base: m.base, off: m.off });
                    }
                    break;
                }
                case 'beq':
                case 'bne':
                case 'blt':
                case 'bge':
                    b.insts.push({
                        kind: 'brc',
                        cond: op.slice(1),
                        a: parseReg(a[0]),
                        b: parseReg(a[1]),
                        label: a[2],
                    });
                    break;
                case 'br':
                case 'j':
                    b.insts.push({ kind: 'br', label: a[0] });
                    break;
                case 'halt':
                    b.insts.push({ kind: 'halt', src: parseReg(a[0]) });
                    break;
                case 'tid':
                    b.insts.push({ kind: 'tid', dst: parseReg(a[0]) });
                    break;
                case 'nthreads':
                    b.insts.push({ kind: 'nthreads', dst: parseReg(a[0]) });
                    break;
                case 'barrier':
                    b.insts.push({ kind: 'barrier' });
                    break;
                case 'call':
                    b.insts.push({ kind: 'call', label: a[0] });
                    break;
                case 'ret':
                    b.insts.push({ kind: 'ret' });
                    break;
                case 'icall':
                    b.insts.push({ kind: 'icall', fn: parseReg(a[0]) });
                    break;
                case 'la':
                case 'labaddr':
                    b.insts.push({ kind: 'labaddr', dst: parseReg(a[0]), label: a[1] });
                    break;
                default:
                    throw new Error(`Unknown opcode "${op}"`);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Line ${lineNo + 1}: ${msg}`);
        }
    }
    const hasHalt = b.insts.some((ins) => ins.kind === 'halt');
    if (!hasHalt)
        throw new Error('Program must end with a halt instruction');
    return b.program();
}
export const SAMPLE_IR = `# Sum 0 .. N-1
imm r0, 0          # i
imm r1, 0          # acc
imm r2, 256        # n
imm r3, 1
loop:
  bge r0, r2, done
  add r1, r1, r0
  add r0, r0, r3
  br loop
done:
  halt r1
`;
//# sourceMappingURL=ir.js.map