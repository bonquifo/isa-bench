import { i32, idiv, imul, irem } from '../bits.ts';
import { IrBuilder } from '../ir.ts';
import { DATA_BASE, C_PARK_BYTES, C_STACK_BASE, C_STACK_USABLE_BYTES, C_STACK_STRIDE, HEAP_BASE, HEAP_LIMIT, HEAP_PTR, STDOUT_BASE, STDOUT_MAX, } from '../types.ts';
import { alignOf, decay, fieldOf, isAgg, isFloat, isPtr, sizeOf, typesEq, } from './ctypes.ts';
import { CError, } from './cparse.ts';
const INT = { kind: 'int' };
const CHAR = { kind: 'char', signed: true };
const FLT = { kind: 'double' };
const PTR_VOID = { kind: 'ptr', to: { kind: 'void' } };
class Lower {
    b = new IrBuilder();
    env;
    sp;
    fp;
    psp;
    data = DATA_BASE;
    strings = new Map();
    fns = new Map();
    globals = new Map();
    scopes = [];
    declSlots = new Map();
    frame = 0;
    nargs = 0;
    hiddenRet = false;
    retTy = INT;
    breaks = [];
    continues = [];
    gotos = new Map();
    staticN = 0;
    constructor(env) {
        this.env = env;
        this.sp = this.b.reg();
        this.fp = this.b.reg();
        this.psp = this.b.reg();
    }
    sz(ty) {
        return sizeOf(ty, this.env);
    }
    run(prog) {
        for (const fn of prog.fns) {
            if (fn.variadic)
                throw new CError(`Guest C v1.4 does not support variadic function '${fn.name}'`, 1, 1);
            if ((fn.ret.kind === 'double' && fn.name !== 'main') || fn.params.some((p) => p.ty.kind === 'double')) {
                throw new CError(`Guest C v1.4 does not support double in function signature '${fn.name}'`, 1, 1);
            }
            const prev = this.fns.get(fn.name);
            if (prev) {
                const prevTy = { kind: 'fn', ret: prev.ret, params: prev.params.map((p) => p.ty), variadic: prev.variadic };
                const nextTy = { kind: 'fn', ret: fn.ret, params: fn.params.map((p) => p.ty), variadic: fn.variadic };
                if (!typesEq(prevTy, nextTy))
                    throw new CError(`conflicting declarations for function '${fn.name}'`, 1, 1);
            }
            if (!prev || fn.body)
                this.fns.set(fn.name, fn);
        }
        this.validateEntry();
        const globalAddrs = prog.globals.map((g) => this.reserveGlobal(g.name, g.ty));
        for (let i = 0; i < prog.globals.length; i++) {
            this.emitData(globalAddrs[i], prog.globals[i].ty, prog.globals[i].init);
        }
        this.emitStart();
        this.emitHelpers();
        for (const fn of prog.fns) {
            if (fn.body)
                this.emitFn(fn);
        }
        this.assertStaticBoundary(this.data, 'final lowered static data');
        return {
            ir: this.b.program(),
            guestVersion: 'Guest C v1.4',
            notes: 'Guest C v1.4 → portable IR. The runtime entry is exactly int main(void), with double main(void) as the sole extension. Scalars are signed 32-bit wrapping int, signed 8-bit char, pointers, and IEEE-754 binary64 double; other double function signatures, float, unsigned/short/long/long double, and user variadics are rejected. Static data, local statics, and interned literals are checked against the heap boundary after all lowering. Function calls and pointer assignments are signature-checked, integer constant expressions equal to zero are null pointer constants, unions initialize exactly one selected member, and declarations use lexical block scope. const/volatile/restrict are accepted and ignored. Each worker has a guarded 4 KiB guest stack (3584-byte software stack plus 512-byte expression park stack). malloc/calloc use the full serial heap but return null whenever active C worker count is greater than one. printf accepts only literal %%, %c, %s, and %d. free is a no-op. No OS files, signals, or setjmp.',
        };
    }
    validateEntry() {
        const main = this.fns.get('main');
        const required = 'entry must be defined exactly as int main(void) or double main(void)';
        if (!main?.body)
            throw new CError(`Guest C v1.4 ${required}`, 1, 1);
        if (main.variadic)
            throw new CError(`Guest C v1.4 ${required}; main cannot be variadic`, 1, 1);
        if (!main.explicitVoid || main.params.length !== 0) {
            throw new CError(`Guest C v1.4 ${required}; main cannot have parameters`, 1, 1);
        }
        if (main.ret.kind !== 'int' && main.ret.kind !== 'double') {
            throw new CError(`Guest C v1.4 ${required}; unsupported main return type '${main.ret.kind}'`, 1, 1);
        }
    }
    assertStaticBoundary(end, what) {
        if (end > HEAP_BASE) {
            throw new CError(`Guest C static data allocation '${what}' ends at ${end}, overlapping heap base ${HEAP_BASE}`, 1, 1);
        }
    }
    placeGlobal(name, ty, init) {
        const addr = this.reserveGlobal(name, ty);
        this.emitData(addr, ty, init);
        return addr;
    }
    reserveGlobal(name, ty) {
        const sz = Math.max(4, this.sz(ty) || 4);
        const addr = this.align(this.data, alignOf(ty, this.env) || 4);
        this.assertStaticBoundary(addr + sz, name);
        this.globals.set(name, { addr, ty });
        this.data = addr + sz;
        return addr;
    }
    emitData(addr, ty, init) {
        if (!init) {
            this.b.bytes(addr, new Array(Math.max(1, this.sz(ty))).fill(0));
            return;
        }
        const string = this.stringInitializer(init);
        if (ty.kind === 'array' && ty.to.kind === 'char' && string !== undefined) {
            const bytes = [...string].map((c) => c.charCodeAt(0));
            if (ty.len > bytes.length)
                bytes.push(0);
            this.b.bytes(addr, bytes);
            return;
        }
        if (init.kind === 'expr') {
            const value = this.constExpr(init.expr);
            if (ty.kind === 'double')
                this.b.floats(addr, [Number(value.value)]);
            else if (ty.kind === 'char')
                this.b.bytes(addr, [i32(value.value)]);
            else if (ty.kind === 'int' || ty.kind === 'ptr' || ty.kind === 'fn') {
                if (ty.kind === 'ptr') {
                    const compatibleAddress = value.ty.kind === 'ptr' && typesEq(ty, value.ty);
                    if (!compatibleAddress && this.integerConstant(init.expr) !== 0) {
                        throw new CError('global pointer initializer is not a compatible address constant or null', 1, 1);
                    }
                }
                this.b.words(addr, [i32(value.value)]);
            }
            else {
                throw new CError(`unsupported global initializer for ${ty.kind}`, 1, 1);
            }
            return;
        }
        if (ty.kind === 'array') {
            const sequential = init.items.filter((item) => item.designators.length === 0);
            let ai = 0;
            for (let i = 0; i < ty.len; i++) {
                const des = init.items.find((item) => item.designators[0]?.kind === 'index' && item.designators[0].index === i);
                const item = des ?? sequential[ai++];
                this.emitData(addr + i * this.sz(ty.to), ty.to, item?.init);
            }
            return;
        }
        if (ty.kind === 'record') {
            const rec = this.env.records.get(ty.tag);
            if (!rec)
                return;
            if (rec.rec === 'union') {
                this.b.bytes(addr, new Array(this.sz(ty)).fill(0));
                const selected = this.unionInitializer(ty, init);
                if (selected)
                    this.emitData(addr + selected.off, selected.ty, selected.init);
                return;
            }
            const sequential = init.items.filter((item) => item.designators.length === 0);
            let ai = 0;
            for (const f of rec.fields) {
                const des = init.items.find((x) => x.designators[0]?.kind === 'field' && x.designators[0].name === f.name);
                const item = des ?? sequential[ai++];
                this.emitData(addr + f.off, f.ty, item?.init);
            }
        }
    }
    unionInitializer(ty, init) {
        const rec = this.env.records.get(ty.tag);
        if (!rec || rec.rec !== 'union' || init.items.length === 0)
            return undefined;
        if (init.items.length > 1) {
            throw new CError(`union '${ty.tag}' initializer must select exactly one member`, 1, 1);
        }
        const item = init.items[0];
        const first = item.designators[0];
        const field = first?.kind === 'field'
            ? rec.fields.find((candidate) => candidate.name === first.name)
            : rec.fields[0];
        if (!field)
            throw new CError(`union '${ty.tag}' initializer selects an unknown member`, 1, 1);
        if (first && first.kind !== 'field') {
            throw new CError(`union '${ty.tag}' initializer requires a member designator`, 1, 1);
        }
        const remaining = first ? item.designators.slice(1) : item.designators;
        return {
            off: field.off,
            ty: field.ty,
            init: remaining.length
                ? { kind: 'list', items: [{ designators: remaining, init: item.init }] }
                : item.init,
        };
    }
    stringInitializer(init) {
        if (init.kind === 'expr' && init.expr.kind === 'str')
            return init.expr.value;
        if (init.kind === 'list' && init.items.length === 1 && init.items[0].designators.length === 0) {
            const only = init.items[0].init;
            if (only.kind === 'expr' && only.expr.kind === 'str')
                return only.expr.value;
        }
        return undefined;
    }
    constExpr(e) {
        if (e.kind === 'int')
            return { value: i32(e.value), ty: INT };
        if (e.kind === 'float')
            return { value: e.value, ty: FLT };
        if (e.kind === 'str')
            return { value: this.intern(e.value), ty: { kind: 'ptr', to: CHAR } };
        if (e.kind === 'ident') {
            const en = this.env.enums.get(e.name);
            if (en !== undefined)
                return { value: en, ty: INT };
            const global = this.globals.get(e.name);
            if (global?.ty.kind === 'array')
                return { value: global.addr, ty: decay(global.ty) };
            throw new CError(`global initializer identifier '${e.name}' is not a constant expression`, 1, 1);
        }
        if (e.kind === 'sizeof') {
            return { value: this.sz(e.ty ?? (e.expr ? this.sizeofType(e.expr) : INT)), ty: INT };
        }
        if (e.kind === 'alignof')
            return { value: alignOf(e.ty, this.env), ty: INT };
        if (e.kind === 'cast') {
            const v = this.constExpr(e.expr);
            if (e.ty.kind === 'double')
                return { value: Number(v.value), ty: FLT };
            if (e.ty.kind === 'char')
                return { value: (i32(v.value) << 24) >> 24, ty: CHAR };
            if (e.ty.kind === 'int')
                return { value: i32(Math.trunc(v.value)), ty: INT };
            if (e.ty.kind === 'ptr')
                return { value: i32(v.value), ty: e.ty };
            throw new CError(`unsupported global constant cast to ${e.ty.kind}`, 1, 1);
        }
        if (e.kind === 'unary') {
            if (e.op === '&' && e.expr.kind === 'ident') {
                const global = this.globals.get(e.expr.name);
                if (!global)
                    throw new CError(`unknown global address '${e.expr.name}'`, 1, 1);
                return { value: global.addr, ty: { kind: 'ptr', to: global.ty } };
            }
            const v = this.constExpr(e.expr);
            if (e.op === '+')
                return v;
            if (e.op === '-')
                return { value: v.ty.kind === 'double' ? -v.value : i32(-v.value), ty: v.ty };
            if (e.op === '~')
                return { value: ~i32(v.value), ty: INT };
            if (e.op === '!')
                return { value: v.value === 0 ? 1 : 0, ty: INT };
            throw new CError(`unsupported unary '${e.op}' in global initializer`, 1, 1);
        }
        if (e.kind === 'cond')
            return this.constExpr(this.constExpr(e.c).value !== 0 ? e.t : e.f);
        if (e.kind === 'comma') {
            if (!e.items.length)
                return { value: 0, ty: INT };
            return this.constExpr(e.items[e.items.length - 1]);
        }
        if (e.kind === 'binary') {
            const a = this.constExpr(e.a);
            if (e.op === '&&' && a.value === 0)
                return { value: 0, ty: INT };
            if (e.op === '||' && a.value !== 0)
                return { value: 1, ty: INT };
            const b = this.constExpr(e.b);
            if (e.op === '&&' || e.op === '||')
                return { value: b.value === 0 ? 0 : 1, ty: INT };
            if (a.ty.kind === 'ptr' || b.ty.kind === 'ptr') {
                if (e.op === '+' && a.ty.kind === 'ptr' && (b.ty.kind === 'int' || b.ty.kind === 'char')) {
                    return { value: i32(a.value + b.value * this.sz(a.ty.to)), ty: a.ty };
                }
                if (e.op === '+' && b.ty.kind === 'ptr' && (a.ty.kind === 'int' || a.ty.kind === 'char')) {
                    return { value: i32(b.value + a.value * this.sz(b.ty.to)), ty: b.ty };
                }
                if ((e.op === '==' || e.op === '!=') && (a.ty.kind === 'ptr' || a.value === 0) && (b.ty.kind === 'ptr' || b.value === 0)) {
                    return { value: e.op === '==' ? Number(a.value === b.value) : Number(a.value !== b.value), ty: INT };
                }
                throw new CError(`unsupported pointer operator '${e.op}' in global initializer`, 1, 1);
            }
            const fp = a.ty.kind === 'double' || b.ty.kind === 'double';
            const x = fp ? a.value : i32(a.value);
            const y = fp ? b.value : i32(b.value);
            const arithmetic = (value) => ({ value: fp ? value : i32(value), ty: fp ? FLT : INT });
            switch (e.op) {
                case '+': return arithmetic(x + y);
                case '-': return arithmetic(x - y);
                case '*': return arithmetic(fp ? x * y : imul(x, y));
                case '/': return arithmetic(fp ? x / y : idiv(x, y));
                case '%': return { value: irem(x, y), ty: INT };
                case '&': return { value: i32(x) & i32(y), ty: INT };
                case '|': return { value: i32(x) | i32(y), ty: INT };
                case '^': return { value: i32(x) ^ i32(y), ty: INT };
                case '<<': return { value: i32(x) << (i32(y) & 31), ty: INT };
                case '>>': return { value: i32(x) >> (i32(y) & 31), ty: INT };
                case '==': return { value: Number(x === y), ty: INT };
                case '!=': return { value: Number(x !== y), ty: INT };
                case '<': return { value: Number(x < y), ty: INT };
                case '<=': return { value: Number(x <= y), ty: INT };
                case '>': return { value: Number(x > y), ty: INT };
                case '>=': return { value: Number(x >= y), ty: INT };
            }
        }
        throw new CError('unsupported non-constant global initializer', 1, 1);
    }
    integerConstant(e) {
        const safe = (expr) => {
            switch (expr.kind) {
                case 'int':
                case 'float':
                case 'alignof':
                    return true;
                case 'ident':
                    return this.env.enums.has(expr.name);
                case 'sizeof':
                    return true;
                case 'cast':
                    return safe(expr.expr);
                case 'unary':
                    return expr.op !== '&' && expr.op !== '*' && expr.op !== '++' && expr.op !== '--'
                        && expr.op !== '++x' && expr.op !== '--x' && safe(expr.expr);
                case 'binary':
                    return safe(expr.a) && safe(expr.b);
                case 'cond':
                    return safe(expr.c) && safe(expr.t) && safe(expr.f);
                default:
                    return false;
            }
        };
        if (!safe(e))
            return undefined;
        try {
            const value = this.constExpr(e);
            return value.ty.kind === 'int' || value.ty.kind === 'char' ? i32(value.value) : undefined;
        }
        catch {
            return undefined;
        }
    }
    align(addr, n) {
        const a = Math.max(1, n);
        return Math.ceil(addr / a) * a;
    }
    intern(s) {
        const hit = this.strings.get(s);
        if (hit !== undefined)
            return hit;
        const addr = this.data;
        const bytes = [...s].map((c) => c.charCodeAt(0) & 0xff);
        bytes.push(0);
        this.assertStaticBoundary(addr + bytes.length, `string literal (${bytes.length} bytes)`);
        this.b.bytes(addr, bytes);
        this.data = addr + bytes.length;
        this.strings.set(s, addr);
        return addr;
    }
    emitStart() {
        this.b.label('__start');
        const tid = this.b.privateTid();
        const workerBase = this.b.add(this.b.imm(C_STACK_BASE), this.b.mul(tid, this.b.imm(C_STACK_STRIDE)));
        this.b.movTo(this.sp, this.b.addi(workerBase, C_STACK_STRIDE));
        this.b.movTo(this.fp, this.b.imm(0));
        this.b.movTo(this.psp, this.b.addi(workerBase, C_PARK_BYTES));
        const heapReady = this.b.lab();
        this.b.bne(tid, this.b.imm(0), heapReady);
        this.b.stw(this.b.imm(HEAP_BASE), this.b.imm(HEAP_PTR), 0);
        this.b.label(heapReady);
        const main = this.fns.get('main');
        const doubleResult = main.ret.kind === 'double';
        this.reserveStack(doubleResult ? 8 : 4);
        this.b.call('main');
        const rv = doubleResult ? this.b.ldd(this.sp, 0) : this.b.ldw(this.sp, 0);
        this.b.halt(rv);
    }
    emitHelpers() {
        this.emitPutchar();
        this.emitPutint();
        this.emitPutstr();
    }
    prologue(localBytes) {
        const next = this.b.addi(this.sp, -(4 + localBytes));
        this.b.cstackCheck(next, 'software');
        this.b.stw(this.fp, this.sp, -4);
        this.b.movTo(this.fp, this.sp);
        this.b.movTo(this.sp, next);
    }
    epilogue(ret) {
        this.b.stw(ret, this.fp, this.nargs * 4);
        const saved = this.b.ldw(this.fp, -4);
        this.b.movTo(this.sp, this.fp);
        this.b.movTo(this.fp, saved);
        this.b.ret();
    }
    emitPutchar() {
        this.b.label('__putchar');
        this.nargs = 1;
        this.prologue(8);
        this.b.stw(this.b.imm(0), this.fp, -8);
        const c = this.b.ldw(this.fp, 0);
        const base = this.b.imm(STDOUT_BASE);
        const n = this.b.ldw(base, 0);
        const skip = this.b.lab();
        this.b.blt(n, this.b.imm(0), skip);
        this.b.bge(n, this.b.imm(STDOUT_MAX), skip);
        const four = this.b.imm(4);
        const off = this.b.add(this.b.mul(n, four), four);
        const addr = this.b.add(base, off);
        this.b.stw(this.b.and(c, this.b.imm(0xff)), addr, 0);
        this.b.stw(this.b.addi(n, 1), base, 0);
        this.b.label(skip);
        this.epilogue(c);
    }
    emitPutstr() {
        this.b.label('__putstr');
        this.nargs = 1;
        this.prologue(8);
        this.b.stw(this.b.imm(0), this.fp, -8);
        const top = this.b.lab();
        const done = this.b.lab();
        this.b.label(top);
        const p = this.b.ldw(this.fp, 0);
        const ch = this.b.ldb(p, 0);
        this.b.beq(ch, this.b.imm(0), done);
        this.callFn('__putchar', [ch]);
        this.b.stw(this.b.addi(this.b.ldw(this.fp, -8), 1), this.fp, -8);
        this.b.stw(this.b.addi(this.b.ldw(this.fp, 0), 1), this.fp, 0);
        this.b.br(top);
        this.b.label(done);
        this.epilogue(this.b.ldw(this.fp, -8));
    }
    emitPutint() {
        this.b.label('__putint');
        this.nargs = 1;
        this.prologue(12);
        const n = this.b.ldw(this.fp, 0);
        const notMin = this.b.lab();
        this.b.bne(n, this.b.imm(-2147483648), notMin);
        this.callFn('__putstr', [this.b.imm(this.intern('-2147483648'))]);
        this.epilogue(this.b.imm(11));
        this.b.label(notMin);
        this.b.stw(this.b.imm(0), this.fp, -8);
        const doneNeg = this.b.lab();
        this.b.bge(n, this.b.imm(0), doneNeg);
        this.callFn('__putchar', [this.b.imm(45)]);
        this.b.stw(this.b.imm(1), this.fp, -8);
        const pos = this.b.sub(this.b.imm(0), this.b.ldw(this.fp, 0));
        this.b.stw(pos, this.fp, 0);
        this.b.label(doneNeg);
        const n2 = this.b.ldw(this.fp, 0);
        const small = this.b.lab();
        this.b.blt(n2, this.b.imm(10), small);
        const q = this.b.bin('div', n2, this.b.imm(10));
        const r = this.b.bin('rem', n2, this.b.imm(10));
        this.b.stw(r, this.fp, -12);
        const digits = this.callFn('__putint', [q]);
        const r2 = this.b.ldw(this.fp, -12);
        this.callFn('__putchar', [this.b.addi(r2, 48)]);
        this.epilogue(this.b.add(this.b.addi(digits, 1), this.b.ldw(this.fp, -8)));
        this.b.label(small);
        this.callFn('__putchar', [this.b.addi(this.b.ldw(this.fp, 0), 48)]);
        this.epilogue(this.b.addi(this.b.ldw(this.fp, -8), 1));
    }
    callFn(name, args) {
        this.reserveStack(4);
        for (let i = args.length - 1; i >= 0; i--) {
            this.pushWord(args[i]);
        }
        this.b.call(name);
        this.b.addiTo(this.sp, this.sp, args.length * 4);
        const rv = this.b.ldw(this.sp, 0);
        this.b.addiTo(this.sp, this.sp, 4);
        return rv;
    }
    icallFn(fn, args) {
        this.reserveStack(4);
        for (let i = args.length - 1; i >= 0; i--) {
            this.pushWord(args[i]);
        }
        this.b.icall(fn);
        this.b.addiTo(this.sp, this.sp, args.length * 4);
        const rv = this.b.ldw(this.sp, 0);
        this.b.addiTo(this.sp, this.sp, 4);
        return rv;
    }
    alloca(bytes) {
        if (typeof bytes === 'number') {
            const n = Math.max(4, Math.ceil(bytes / 4) * 4);
            const next = this.b.addi(this.sp, -n);
            this.b.cstackCheck(next, 'software');
            this.b.movTo(this.sp, next);
            return this.b.mov(this.sp);
        }
        const aligned = this.b.and(this.b.addi(bytes.reg, 3), this.b.imm(~3));
        const next = this.b.sub(this.sp, aligned);
        this.b.cstackCheck(next, 'software');
        this.b.movTo(this.sp, next);
        return this.b.mov(this.sp);
    }
    reserveStack(bytes) {
        const next = this.b.addi(this.sp, -bytes);
        this.b.cstackCheck(next, 'software');
        this.b.movTo(this.sp, next);
    }
    pushWord(value) {
        const next = this.b.addi(this.sp, -4);
        this.b.cstackCheck(next, 'software');
        this.b.stw(value, next, 0);
        this.b.movTo(this.sp, next);
    }
    copyMem(dst, src, n) {
        for (let i = 0; i < n; i++)
            this.b.stb(this.b.ldb(src, i), dst, i);
    }
    gotoLab(name) {
        let lab = this.gotos.get(name);
        if (!lab) {
            lab = this.b.lab('G');
            this.gotos.set(name, lab);
        }
        return lab;
    }
    emitFn(fn) {
        this.scopes = [new Map()];
        this.declSlots = new Map();
        this.frame = 0;
        this.gotos = new Map();
        this.retTy = fn.ret;
        this.hiddenRet = fn.ret.kind === 'record';
        this.nargs = fn.params.length + (this.hiddenRet ? 1 : 0);
        this.breaks = [];
        this.continues = [];
        this.b.label(fn.name);
        const body = fn.body;
        if (!body)
            return;
        const argBase = this.hiddenRet ? 1 : 0;
        for (let i = 0; i < fn.params.length; i++) {
            const p = fn.params[i];
            if (p.ty.kind === 'record') {
                const sz = this.sz(p.ty);
                this.frame = this.alignOff(this.frame + sz);
                this.declare(p.name, { kind: 'local', off: -(this.frame + 4), ty: p.ty });
            }
            else {
                this.declare(p.name, { kind: 'local', off: (argBase + i) * 4, ty: p.ty });
            }
        }
        this.collectLocals(body);
        if (this.frame + 4 > C_STACK_USABLE_BYTES) {
            throw new CError(`Guest C software stack frame for '${fn.name}' needs ${this.frame + 4} bytes; limit is ${C_STACK_USABLE_BYTES}`, 1, 1);
        }
        this.prologue(this.frame);
        for (let i = 0; i < fn.params.length; i++) {
            const p = fn.params[i];
            if (p.ty.kind === 'record') {
                const slot = this.lookup(p.name);
                if (slot.kind !== 'local')
                    throw new CError(`invalid parameter slot '${p.name}'`, 1, 1);
                for (let off = 0; off < this.sz(p.ty); off += 4) {
                    const src = this.b.ldw(this.fp, (argBase + i) * 4);
                    this.b.stw(this.b.ldw(src, off), this.fp, slot.off + off);
                }
            }
        }
        this.stmt(body);
        this.doReturn({ reg: this.b.imm(0), ty: INT });
    }
    alignOff(n) {
        return Math.ceil(n / 4) * 4;
    }
    collectLocals(s) {
        switch (s.kind) {
            case 'block':
                for (const x of s.stmts)
                    this.collectLocals(x);
                break;
            case 'if':
                this.collectLocals(s.then);
                if (s.else)
                    this.collectLocals(s.else);
                break;
            case 'while':
            case 'do':
                this.collectLocals(s.body);
                break;
            case 'for':
                if (s.init)
                    this.collectLocals(s.init);
                this.collectLocals(s.body);
                break;
            case 'switch':
                for (const x of s.body)
                    this.collectLocals(x);
                break;
            case 'decl':
                for (const d of s.decls)
                    this.reserveLocal(d);
                break;
            default:
                break;
        }
    }
    reserveLocal(d) {
        if (d.storage === 'static') {
            this.staticN += 1;
            const name = `__st_${d.name}_${this.staticN}`;
            const addr = this.placeGlobal(name, d.ty, d.init);
            this.declSlots.set(d, { kind: 'global', addr, ty: d.ty });
            return;
        }
        if (d.vla || (d.ty.kind === 'array' && d.ty.len < 0)) {
            this.frame = this.alignOff(this.frame + 4);
            this.declSlots.set(d, { kind: 'local', off: -(this.frame + 4), ty: d.ty, vla: true });
            return;
        }
        const sz = Math.max(4, this.sz(d.ty));
        this.frame = this.alignOff(this.frame + sz);
        this.declSlots.set(d, { kind: 'local', off: -(this.frame + 4), ty: d.ty });
    }
    stmt(s) {
        switch (s.kind) {
            case 'block':
                this.scopes.push(new Map());
                for (const x of s.stmts)
                    this.stmt(x);
                this.scopes.pop();
                return;
            case 'static_assert':
                return;
            case 'expr':
                this.rval(s.expr);
                return;
            case 'decl':
                for (const d of s.decls)
                    this.emitDecl(d);
                return;
            case 'if': {
                const c = this.truth(this.rval(s.cond));
                const els = this.b.lab();
                const done = this.b.lab();
                this.b.beq(c, this.b.imm(0), els);
                this.stmt(s.then);
                this.b.br(done);
                this.b.label(els);
                if (s.else)
                    this.stmt(s.else);
                this.b.label(done);
                return;
            }
            case 'while': {
                const top = this.b.lab();
                const done = this.b.lab();
                this.breaks.push(done);
                this.continues.push(top);
                this.b.label(top);
                const c = this.truth(this.rval(s.cond));
                this.b.beq(c, this.b.imm(0), done);
                this.stmt(s.body);
                this.b.br(top);
                this.b.label(done);
                this.breaks.pop();
                this.continues.pop();
                return;
            }
            case 'do': {
                const top = this.b.lab();
                const condLab = this.b.lab();
                const done = this.b.lab();
                this.breaks.push(done);
                this.continues.push(condLab);
                this.b.label(top);
                this.stmt(s.body);
                this.b.label(condLab);
                const c = this.truth(this.rval(s.cond));
                this.b.bne(c, this.b.imm(0), top);
                this.b.label(done);
                this.breaks.pop();
                this.continues.pop();
                return;
            }
            case 'for': {
                this.scopes.push(new Map());
                if (s.init)
                    this.stmt(s.init);
                const top = this.b.lab();
                const step = this.b.lab();
                const done = this.b.lab();
                this.breaks.push(done);
                this.continues.push(step);
                this.b.label(top);
                if (s.cond) {
                    const c = this.truth(this.rval(s.cond));
                    this.b.beq(c, this.b.imm(0), done);
                }
                this.stmt(s.body);
                this.b.label(step);
                if (s.step)
                    this.rval(s.step);
                this.b.br(top);
                this.b.label(done);
                this.breaks.pop();
                this.continues.pop();
                this.scopes.pop();
                return;
            }
            case 'return':
                if (!s.expr) {
                    if (this.retTy.kind !== 'void')
                        throw new CError('non-void function must return a value', 1, 1);
                    this.doReturn({ reg: this.b.imm(0), ty: INT });
                }
                else {
                    if (this.retTy.kind === 'void')
                        throw new CError('void function cannot return a value', 1, 1);
                    this.doReturn(this.convertFor(this.rval(s.expr), this.retTy, s.expr));
                }
                return;
            case 'break':
                if (!this.breaks.length)
                    throw new CError('break outside loop', 1, 1);
                this.b.br(this.breaks[this.breaks.length - 1]);
                return;
            case 'continue':
                if (!this.continues.length)
                    throw new CError('continue outside loop', 1, 1);
                this.b.br(this.continues[this.continues.length - 1]);
                return;
            case 'goto':
                this.b.br(this.gotoLab(s.name));
                return;
            case 'label':
                this.b.label(this.gotoLab(s.name));
                return;
            case 'switch':
                this.emitSwitch(s.expr, s.body);
                return;
            case 'case':
            case 'default':
                return;
        }
    }
    emitDecl(d) {
        const slot = this.declSlots.get(d);
        if (!slot)
            throw new CError(`missing declaration slot for '${d.name}'`, 1, 1);
        this.declare(d.name, slot);
        if (slot.kind === 'global')
            return;
        if (slot.vla) {
            const n = d.vla ? this.rval(d.vla).reg : this.b.imm(1);
            const elem = d.ty.kind === 'array' ? this.sz(d.ty.to) : 4;
            const p = this.alloca({ reg: this.b.mul(n, this.b.imm(elem)) });
            this.b.stw(p, this.fp, slot.off);
            return;
        }
        if (d.init) {
            const addr = this.b.addi(this.fp, slot.off);
            if (isAgg(slot.ty))
                this.zeroBytes(addr, this.sz(slot.ty));
            this.initAt(addr, slot.ty, d.init);
        }
    }
    initAt(addr, ty, init) {
        const string = this.stringInitializer(init);
        if (ty.kind === 'array' && ty.to.kind === 'char' && string !== undefined) {
            for (let i = 0; i < string.length; i++)
                this.b.stb(this.b.imm(string.charCodeAt(i)), addr, i);
            if (ty.len > string.length)
                this.b.stb(this.b.imm(0), addr, string.length);
            return;
        }
        if (init.kind === 'expr') {
            this.park(addr);
            const v = this.rval(init.expr);
            const dest = this.unpark();
            this.store(dest, 0, this.convertFor(v, ty, init.expr), ty);
            return;
        }
        if (ty.kind === 'array') {
            const sequential = init.items.filter((item) => item.designators.length === 0);
            let ai = 0;
            for (let i = 0; i < ty.len; i++) {
                const des = init.items.find((x) => x.designators[0]?.kind === 'index' && x.designators[0].index === i);
                const item = des ?? sequential[ai++];
                if (item)
                    this.initAt(this.b.addi(addr, i * this.sz(ty.to)), ty.to, item.init);
            }
            return;
        }
        if (ty.kind === 'record') {
            const rec = this.env.records.get(ty.tag);
            if (!rec)
                return;
            if (rec.rec === 'union') {
                const selected = this.unionInitializer(ty, init);
                if (selected)
                    this.initAt(this.b.addi(addr, selected.off), selected.ty, selected.init);
                return;
            }
            const sequential = init.items.filter((item) => item.designators.length === 0);
            let ai = 0;
            for (const f of rec.fields) {
                const des = init.items.find((x) => x.designators[0]?.kind === 'field' && x.designators[0].name === f.name);
                const item = des ?? sequential[ai++];
                if (item)
                    this.initAt(this.b.addi(addr, f.off), f.ty, item.init);
            }
        }
    }
    doReturn(v) {
        if (this.retTy.kind === 'void') {
            this.epilogue(this.b.imm(0));
            return;
        }
        if (this.hiddenRet) {
            const dest = this.b.ldw(this.fp, 0);
            if (isAgg(v.ty))
                this.copyMem(dest, v.reg, this.sz(v.ty));
            else
                this.store(dest, 0, v, this.retTy);
            this.epilogue(this.b.ldw(this.fp, 0));
            return;
        }
        const returned = isAgg(v.ty) ? v : this.convert(v, this.retTy);
        if (returned.ty.kind === 'double')
            this.b.std(returned.reg, this.fp, this.nargs * 4);
        else
            this.b.stw(isAgg(returned.ty) ? this.b.ldw(returned.reg, 0) : returned.reg, this.fp, this.nargs * 4);
        const saved = this.b.ldw(this.fp, -4);
        this.b.movTo(this.sp, this.fp);
        this.b.movTo(this.fp, saved);
        this.b.ret();
    }
    emitSwitch(expr, body) {
        this.scopes.push(new Map());
        const v = this.rval(expr).reg;
        const done = this.b.lab();
        this.breaks.push(done);
        const labels = [];
        for (const st of body) {
            if (st.kind === 'case')
                labels.push({ value: st.value, lab: this.b.lab('C') });
            if (st.kind === 'default')
                labels.push({ value: 'default', lab: this.b.lab('D') });
        }
        for (const L of labels) {
            if (L.value !== 'default')
                this.b.beq(v, this.b.imm(L.value), L.lab);
        }
        const def = labels.find((x) => x.value === 'default');
        this.b.br(def ? def.lab : done);
        let li = 0;
        for (const st of body) {
            if (st.kind === 'case' || st.kind === 'default') {
                this.b.label(labels[li].lab);
                li += 1;
                continue;
            }
            this.stmt(st);
        }
        this.b.label(done);
        this.breaks.pop();
        this.scopes.pop();
    }
    truth(v) {
        if (v.ty.kind === 'void' || isAgg(v.ty))
            throw new CError('condition requires a scalar value', 1, 1);
        if (v.ty.kind === 'double')
            return this.b.bin('nef', v.reg, this.b.immf(0));
        return v.reg;
    }
    declare(name, slot) {
        const scope = this.scopes[this.scopes.length - 1];
        if (!scope)
            throw new CError('internal scope stack underflow', 1, 1);
        if (scope.has(name))
            throw new CError(`redeclaration of '${name}' in the same scope`, 1, 1);
        scope.set(name, slot);
    }
    lookup(name) {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            const slot = this.scopes[i].get(name);
            if (slot)
                return slot;
        }
        const g = this.globals.get(name);
        if (g)
            return { kind: 'global', addr: g.addr, ty: g.ty };
        throw new CError(`unknown identifier '${name}'`, 1, 1);
    }
    typeOf(e) {
        switch (e.kind) {
            case 'int':
                return INT;
            case 'float':
                return FLT;
            case 'str':
                return { kind: 'ptr', to: CHAR };
            case 'ident': {
                if (this.env.enums.has(e.name))
                    return INT;
                if (this.fns.has(e.name)) {
                    const fn = this.fns.get(e.name);
                    return { kind: 'ptr', to: { kind: 'fn', ret: fn.ret, params: fn.params.map((p) => p.ty), variadic: fn.variadic } };
                }
                try {
                    return decay(this.lookup(e.name).ty);
                }
                catch {
                    return INT;
                }
            }
            case 'member': {
                const base = e.arrow
                    ? (this.typeOf(e.base).kind === 'ptr' ? this.typeOf(e.base).to : this.typeOf(e.base))
                    : this.typeOf(e.base);
                try {
                    return fieldOf(base, e.field, this.env).ty;
                }
                catch {
                    return INT;
                }
            }
            case 'index': {
                const b = this.typeOf(e.base);
                return b.kind === 'ptr' || b.kind === 'array' ? b.to : INT;
            }
            case 'unary':
                if (e.op === '&')
                    return { kind: 'ptr', to: this.typeOf(e.expr) };
                if (e.op === '*') {
                    const t = this.typeOf(e.expr);
                    return t.kind === 'ptr' ? t.to : INT;
                }
                return this.typeOf(e.expr);
            case 'cast':
            case 'compound':
                return e.ty;
            case 'call':
                if (e.callee.kind === 'ident') {
                    const fn = this.fns.get(e.callee.name);
                    if (fn)
                        return fn.ret;
                }
                {
                    const callee = this.typeOf(e.callee);
                    if (callee.kind === 'ptr' && callee.to.kind === 'fn')
                        return callee.to.ret;
                    if (callee.kind === 'fn')
                        return callee.ret;
                    return INT;
                }
            case 'cond':
                return this.conditionalType(e);
            default:
                return INT;
        }
    }
    conditionalType(e) {
        const t = decay(this.typeOf(e.t));
        const f = decay(this.typeOf(e.f));
        const arithmetic = (ty) => ty.kind === 'int' || ty.kind === 'char' || ty.kind === 'double';
        if (arithmetic(t) && arithmetic(f)) {
            return t.kind === 'double' || f.kind === 'double' ? FLT : INT;
        }
        if (t.kind === 'ptr' && f.kind === 'ptr') {
            if (!typesEq(t, f))
                throw new CError('incompatible pointer types in conditional expression', 1, 1);
            if (t.to.kind === 'void')
                return f;
            return t;
        }
        if (t.kind === 'ptr' && this.integerConstant(e.f) === 0)
            return t;
        if (f.kind === 'ptr' && this.integerConstant(e.t) === 0)
            return f;
        if (t.kind === 'record' && f.kind === 'record' && typesEq(t, f))
            return t;
        if (t.kind === 'void' || f.kind === 'void') {
            throw new CError('Guest C v1.4 does not support void arms in conditional expressions', 1, 1);
        }
        if (isAgg(t) || isAgg(f)) {
            throw new CError('incompatible aggregate arms in conditional expression', 1, 1);
        }
        throw new CError('incompatible types in conditional expression', 1, 1);
    }
    sizeofType(e) {
        if (e.kind === 'ident') {
            if (this.fns.has(e.name))
                return this.typeOf(e);
            return this.lookup(e.name).ty;
        }
        if (e.kind === 'str')
            return { kind: 'array', to: CHAR, len: e.value.length + 1 };
        return this.typeOf(e);
    }
    addrOf(e) {
        switch (e.kind) {
            case 'ident': {
                const s = this.lookup(e.name);
                if (s.kind === 'local') {
                    if (s.vla)
                        return { reg: this.b.ldw(this.fp, s.off), ty: s.ty.kind === 'array' ? s.ty.to : s.ty };
                    return { reg: this.b.addi(this.fp, s.off), ty: s.ty };
                }
                return { reg: this.b.imm(s.addr), ty: s.ty };
            }
            case 'unary':
                if (e.op === '*') {
                    const p = this.rval(e.expr);
                    return { reg: p.reg, ty: p.ty.kind === 'ptr' ? p.ty.to : INT };
                }
                break;
            case 'index': {
                const b = this.rval(e.base);
                const i = this.rval(e.index);
                const elem = b.ty.kind === 'ptr' || b.ty.kind === 'array' ? b.ty.to : INT;
                const sc = this.sz(elem) || 4;
                return { reg: this.b.add(b.reg, this.b.mul(i.reg, this.b.imm(sc))), ty: elem };
            }
            case 'member': {
                const baseTy = e.arrow
                    ? this.rval(e.base)
                    : e.base.kind === 'cond'
                        ? this.rval(e.base)
                        : { reg: this.addrOf(e.base).reg, ty: this.addrOf(e.base).ty };
                const recTy = e.arrow
                    ? (baseTy.ty.kind === 'ptr' ? baseTy.ty.to : baseTy.ty)
                    : baseTy.ty;
                const f = fieldOf(recTy, e.field, this.env);
                return { reg: this.b.addi(baseTy.reg, f.off), ty: f.ty };
            }
            case 'compound': {
                const p = this.alloca(this.sz(e.ty) || 4);
                if (isAgg(e.ty))
                    this.zeroBytes(p, this.sz(e.ty));
                this.initAt(p, e.ty, e.init);
                return { reg: p, ty: e.ty };
            }
            default:
                break;
        }
        throw new CError('not an lvalue', 1, 1);
    }
    convert(v, to, explicit = false) {
        if (to.kind === 'void' || v.ty.kind === 'void') {
            throw new CError('void value is not compatible with a scalar or aggregate value', 1, 1);
        }
        if (to.kind === 'ptr') {
            if (v.ty.kind === 'ptr') {
                if (!explicit && !typesEq(to, v.ty))
                    throw new CError('incompatible pointer assignment', 1, 1);
                return { reg: v.reg, ty: to };
            }
            if (!explicit)
                throw new CError('pointer assignment requires a compatible pointer or null constant', 1, 1);
            return { reg: v.reg, ty: to };
        }
        if (to.kind === 'double' && v.ty.kind !== 'double') {
            if (v.ty.kind === 'int' || v.ty.kind === 'char') {
                return { reg: this.b.convert('itod', v.reg), ty: FLT };
            }
            throw new CError('Guest C v1.4 cannot convert pointer/aggregate to double', 1, 1);
        }
        if ((to.kind === 'int' || to.kind === 'char') && v.ty.kind === 'double') {
            const int = this.b.convert('dtoi', v.reg);
            return { reg: to.kind === 'char' ? this.b.convert('i8', int) : int, ty: to };
        }
        if (to.kind === 'char' && v.ty.kind !== 'char')
            return { reg: this.b.convert('i8', v.reg), ty: to };
        return { reg: v.reg, ty: to };
    }
    convertFor(v, to, source) {
        if (to.kind === 'ptr' && this.integerConstant(source) === 0) {
            return { reg: v.reg, ty: to };
        }
        if (isAgg(to) || isAgg(v.ty)) {
            if (!typesEq(to, v.ty))
                throw new CError('incompatible aggregate assignment', 1, 1);
            return { reg: v.reg, ty: to };
        }
        return this.convert(v, to);
    }
    load(addr, ty) {
        if (isAgg(ty))
            return { reg: addr, ty };
        const t = decay(ty);
        if (t.kind === 'double')
            return { reg: this.b.ldd(addr, 0), ty: FLT };
        if (t.kind === 'char')
            return { reg: this.b.ldb(addr, 0), ty: CHAR };
        return { reg: this.b.ldw(addr, 0), ty: t.kind === 'ptr' || t.kind === 'fn' ? t : INT };
    }
    store(addr, off, v, ty) {
        if (isAgg(ty) || isAgg(v.ty)) {
            this.copyMem(off ? this.b.addi(addr, off) : addr, v.reg, this.sz(ty) || this.sz(v.ty));
            return;
        }
        const converted = this.convert(v, ty);
        if (ty.kind === 'double')
            this.b.std(converted.reg, addr, off);
        else if (ty.kind === 'char')
            this.b.stb(converted.reg, addr, off);
        else
            this.b.stw(converted.reg, addr, off);
    }
    loadField(addr, ty, bits, bitOff) {
        if (bits !== undefined && bits > 0) {
            const w = this.b.ldw(addr, 0);
            if (bits === 32)
                return { reg: w, ty: INT };
            const left = 32 - (bitOff ?? 0) - bits;
            const shifted = this.b.shl(w, this.b.imm(left));
            return { reg: this.b.bin('sar', shifted, this.b.imm(32 - bits)), ty: INT };
        }
        return this.load(addr, ty);
    }
    storeField(addr, v, ty, bits, bitOff) {
        if (bits !== undefined && bits > 0) {
            if (bits === 32) {
                this.b.stw(v.reg, addr, 0);
                return;
            }
            const w = this.b.ldw(addr, 0);
            const valueMask = (2 ** bits - 1) | 0;
            const mask = (valueMask << (bitOff ?? 0)) | 0;
            const cleared = this.b.and(w, this.b.imm(~mask));
            const inserted = this.b.or(cleared, this.b.shl(this.b.and(v.reg, this.b.imm(valueMask)), this.b.imm(bitOff ?? 0)));
            this.b.stw(inserted, addr, 0);
            return;
        }
        this.store(addr, 0, v, ty);
    }
    rval(e) {
        switch (e.kind) {
            case 'int':
                return { reg: this.b.imm(e.value), ty: INT };
            case 'float':
                return { reg: this.b.immf(e.value), ty: FLT };
            case 'str':
                return { reg: this.b.imm(this.intern(e.value)), ty: { kind: 'ptr', to: CHAR } };
            case 'ident': {
                if (this.env.enums.has(e.name))
                    return { reg: this.b.imm(this.env.enums.get(e.name)), ty: INT };
                if (this.fns.has(e.name))
                    return { reg: this.b.labaddr(e.name), ty: this.typeOf(e) };
                const s = this.lookup(e.name);
                if (s.ty.kind === 'array') {
                    if (s.kind === 'local' && 'vla' in s && s.vla)
                        return { reg: this.b.ldw(this.fp, s.off), ty: { kind: 'ptr', to: s.ty.to } };
                    if (s.kind === 'local')
                        return { reg: this.b.addi(this.fp, s.off), ty: { kind: 'ptr', to: s.ty.to } };
                    return { reg: this.b.imm(s.addr), ty: { kind: 'ptr', to: s.ty.to } };
                }
                if (s.ty.kind === 'record') {
                    const a = this.addrOf(e);
                    return { reg: a.reg, ty: a.ty };
                }
                const a = this.addrOf(e);
                return this.load(a.reg, a.ty);
            }
            case 'comma': {
                let v = { reg: this.b.imm(0), ty: INT };
                for (const x of e.items)
                    v = this.rval(x);
                return v;
            }
            case 'cast':
                return this.convert(this.rval(e.expr), e.ty, true);
            case 'sizeof':
                if (e.ty)
                    return { reg: this.b.imm(this.sz(e.ty)), ty: INT };
                if (e.expr)
                    return { reg: this.b.imm(this.sz(this.sizeofType(e.expr))), ty: INT };
                return { reg: this.b.imm(4), ty: INT };
            case 'alignof':
                return { reg: this.b.imm(alignOf(e.ty, this.env)), ty: INT };
            case 'generic': {
                const t = this.typeOf(e.ctrl);
                const hit = e.assocs.find((a) => a.ty && typesEq(a.ty, t)) ?? e.assocs.find((a) => !a.ty);
                if (!hit)
                    throw new CError('_Generic has no matching association', 1, 1);
                return this.rval(hit.expr);
            }
            case 'cond': {
                const resultTy = this.conditionalType(e);
                const c = this.truth(this.rval(e.c));
                const els = this.b.lab();
                const done = this.b.lab();
                const out = this.b.reg();
                this.b.beq(c, this.b.imm(0), els);
                const t = this.convertFor(this.rval(e.t), resultTy, e.t);
                this.b.movTo(out, t.reg);
                this.b.br(done);
                this.b.label(els);
                const f = this.convertFor(this.rval(e.f), resultTy, e.f);
                this.b.movTo(out, f.reg);
                this.b.label(done);
                return { reg: out, ty: resultTy };
            }
            case 'index': {
                const a = this.addrOf(e);
                return this.load(a.reg, a.ty);
            }
            case 'member': {
                const a = this.addrOf(e);
                const recTy = e.arrow
                    ? (this.typeOf(e.base).kind === 'ptr' ? this.typeOf(e.base).to : this.typeOf(e.base))
                    : this.typeOf(e.base);
                let bits;
                let bitOff;
                try {
                    const f = fieldOf(recTy, e.field, this.env);
                    bits = f.bits;
                    bitOff = f.bitOff;
                }
                catch { /* */ }
                return this.loadField(a.reg, a.ty, bits, bitOff);
            }
            case 'compound': {
                const a = this.addrOf(e);
                return isAgg(a.ty) ? { reg: a.reg, ty: a.ty } : this.load(a.reg, a.ty);
            }
            case 'unary':
                return this.unary(e.op, e.expr);
            case 'binary':
                return this.binary(e.op, e.a, e.b);
            case 'assign':
                return this.assign(e.op, e.lhs, e.rhs);
            case 'call':
                return this.call(e);
        }
    }
    unary(op, expr) {
        if (op === '&') {
            if (expr.kind === 'ident' && this.fns.has(expr.name)) {
                return { reg: this.b.labaddr(expr.name), ty: this.typeOf(expr) };
            }
            const a = this.addrOf(expr);
            return { reg: a.reg, ty: { kind: 'ptr', to: a.ty } };
        }
        if (op === '*') {
            const p = this.rval(expr);
            const to = p.ty.kind === 'ptr' ? p.ty.to : INT;
            return this.load(p.reg, to);
        }
        if (op === '++' || op === '--') {
            const a = this.addrOf(expr);
            const cur = this.load(a.reg, a.ty);
            const step = cur.ty.kind === 'ptr' ? this.sz(cur.ty.to) : 1;
            const one = isFloat(cur.ty) ? this.b.immf(1) : this.b.imm(step);
            const next = this.b.bin(isFloat(cur.ty) ? (op === '++' ? 'addf' : 'subf') : (op === '++' ? 'add' : 'sub'), cur.reg, one);
            this.store(a.reg, 0, { reg: next, ty: cur.ty }, a.ty);
            return { reg: next, ty: cur.ty };
        }
        if (op === '++x' || op === '--x') {
            const a = this.addrOf(expr);
            const cur = this.load(a.reg, a.ty);
            const step = cur.ty.kind === 'ptr' ? this.sz(cur.ty.to) : 1;
            const one = isFloat(cur.ty) ? this.b.immf(1) : this.b.imm(step);
            const next = this.b.bin(isFloat(cur.ty) ? (op === '++x' ? 'addf' : 'subf') : (op === '++x' ? 'add' : 'sub'), cur.reg, one);
            this.store(a.reg, 0, { reg: next, ty: cur.ty }, a.ty);
            return cur;
        }
        const v = this.rval(expr);
        if (op === '+')
            return v;
        if (op === '-') {
            if (isFloat(v.ty))
                return { reg: this.b.bin('subf', this.b.immf(0), v.reg), ty: FLT };
            return { reg: this.b.sub(this.b.imm(0), v.reg), ty: INT };
        }
        if (op === '~')
            return { reg: this.b.xor(v.reg, this.b.imm(-1)), ty: INT };
        if (op === '!') {
            return { reg: this.cmp('==', this.truth(v), this.b.imm(0)), ty: INT };
        }
        throw new CError(`unsupported unary '${op}'`, 1, 1);
    }
    binary(op, a, b) {
        if (op === '&&' || op === '||') {
            const out = this.b.reg();
            const done = this.b.lab();
            const av = this.truth(this.rval(a));
            this.b.movTo(out, this.b.imm(op === '&&' ? 0 : 1));
            if (op === '&&') {
                this.b.beq(av, this.b.imm(0), done);
                const bv = this.truth(this.rval(b));
                this.b.beq(bv, this.b.imm(0), done);
                this.b.movTo(out, this.b.imm(1));
            }
            else {
                this.b.bne(av, this.b.imm(0), done);
                const bv = this.truth(this.rval(b));
                this.b.bne(bv, this.b.imm(0), done);
                this.b.movTo(out, this.b.imm(0));
            }
            this.b.label(done);
            return { reg: out, ty: INT };
        }
        const av = this.rval(a);
        if (av.ty.kind === 'void' || isAgg(av.ty))
            throw new CError(`left operand of '${op}' is not scalar`, 1, 1);
        if (isFloat(av.ty))
            this.parkDouble(av.reg);
        else
            this.park(av.reg);
        const bv = this.rval(b);
        if (bv.ty.kind === 'void' || isAgg(bv.ty))
            throw new CError(`right operand of '${op}' is not scalar`, 1, 1);
        const a2 = { reg: isFloat(av.ty) ? this.unparkDouble() : this.unpark(), ty: av.ty };
        if (op === '+' && isPtr(a2.ty) && !isPtr(bv.ty)) {
            if (bv.ty.kind !== 'int' && bv.ty.kind !== 'char')
                throw new CError('pointer offset must be an integer', 1, 1);
            const elem = a2.ty.kind === 'ptr' || a2.ty.kind === 'array' ? a2.ty.to : INT;
            return { reg: this.b.add(a2.reg, this.b.mul(bv.reg, this.b.imm(this.sz(elem) || 4))), ty: decay(a2.ty) };
        }
        if (op === '+' && !isPtr(a2.ty) && isPtr(bv.ty)) {
            if (a2.ty.kind !== 'int' && a2.ty.kind !== 'char')
                throw new CError('pointer offset must be an integer', 1, 1);
            const elem = bv.ty.kind === 'ptr' || bv.ty.kind === 'array' ? bv.ty.to : INT;
            return { reg: this.b.add(bv.reg, this.b.mul(a2.reg, this.b.imm(this.sz(elem) || 4))), ty: decay(bv.ty) };
        }
        if (op === '-' && isPtr(a2.ty) && !isPtr(bv.ty)) {
            if (bv.ty.kind !== 'int' && bv.ty.kind !== 'char')
                throw new CError('pointer offset must be an integer', 1, 1);
            const elem = a2.ty.kind === 'ptr' || a2.ty.kind === 'array' ? a2.ty.to : INT;
            return { reg: this.b.sub(a2.reg, this.b.mul(bv.reg, this.b.imm(this.sz(elem) || 4))), ty: decay(a2.ty) };
        }
        if (op === '-' && isPtr(a2.ty) && isPtr(bv.ty)) {
            if (!typesEq(decay(a2.ty), decay(bv.ty)))
                throw new CError('cannot subtract incompatible pointer types', 1, 1);
            const elem = a2.ty.kind === 'ptr' ? a2.ty.to : INT;
            return { reg: this.b.bin('div', this.b.sub(a2.reg, bv.reg), this.b.imm(this.sz(elem) || 4)), ty: INT };
        }
        if (isPtr(a2.ty) || isPtr(bv.ty)) {
            if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
                if (isPtr(a2.ty) !== isPtr(bv.ty)) {
                    const other = isPtr(a2.ty) ? b : a;
                    if (this.integerConstant(other) !== 0 || (op !== '==' && op !== '!=')) {
                        throw new CError('pointer comparison requires a compatible pointer or null constant', 1, 1);
                    }
                }
                if (isPtr(a2.ty) && isPtr(bv.ty) && !typesEq(decay(a2.ty), decay(bv.ty))) {
                    throw new CError('comparison of incompatible pointer types', 1, 1);
                }
                return { reg: this.cmp(op, a2.reg, bv.reg), ty: INT };
            }
            throw new CError(`invalid pointer operator '${op}'`, 1, 1);
        }
        const fp = isFloat(a2.ty) || isFloat(bv.ty);
        const left = fp ? this.convert(a2, FLT) : a2;
        const right = fp ? this.convert(bv, FLT) : bv;
        if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
            return { reg: fp ? this.cmpFloat(op, left.reg, right.reg) : this.cmp(op, left.reg, right.reg), ty: INT };
        }
        const map = {
            '+': fp ? 'addf' : 'add',
            '-': fp ? 'subf' : 'sub',
            '*': fp ? 'mulf' : 'mul',
            '/': fp ? 'divf' : 'div',
            '%': 'rem',
            '&': 'and',
            '|': 'or',
            '^': 'xor',
            '<<': 'shl',
        };
        if (op === '>>')
            return { reg: this.b.bin('sar', a2.reg, bv.reg), ty: INT };
        const ir = map[op];
        if (!ir)
            throw new CError(`unsupported operator '${op}'`, 1, 1);
        return { reg: this.b.bin(ir, left.reg, right.reg), ty: fp ? FLT : INT };
    }
    park(reg) {
        const next = this.b.addi(this.psp, -4);
        this.b.cstackCheck(next, 'park');
        this.b.stw(reg, next, 0);
        this.b.movTo(this.psp, next);
    }
    unpark() {
        const v = this.b.ldw(this.psp, 0);
        this.b.addiTo(this.psp, this.psp, 4);
        return v;
    }
    parkDouble(reg) {
        const next = this.b.addi(this.psp, -8);
        this.b.cstackCheck(next, 'park');
        this.b.std(reg, next, 0);
        this.b.movTo(this.psp, next);
    }
    unparkDouble() {
        const v = this.b.ldd(this.psp, 0);
        this.b.addiTo(this.psp, this.psp, 8);
        return v;
    }
    cmp(op, a, b) {
        const out = this.b.reg();
        const yes = this.b.lab();
        const done = this.b.lab();
        this.b.movTo(out, this.b.imm(0));
        if (op === '==')
            this.b.beq(a, b, yes);
        else if (op === '!=')
            this.b.bne(a, b, yes);
        else if (op === '<')
            this.b.blt(a, b, yes);
        else if (op === '>=')
            this.b.bge(a, b, yes);
        else if (op === '>')
            this.b.blt(b, a, yes);
        else if (op === '<=')
            this.b.bge(b, a, yes);
        this.b.br(done);
        this.b.label(yes);
        this.b.movTo(out, this.b.imm(1));
        this.b.label(done);
        return out;
    }
    cmpFloat(op, a, b) {
        if (op === '==')
            return this.b.bin('eqf', a, b);
        if (op === '!=')
            return this.b.bin('nef', a, b);
        if (op === '<')
            return this.b.bin('ltf', a, b);
        if (op === '>=')
            return this.b.bin('gef', a, b);
        if (op === '>')
            return this.b.bin('ltf', b, a);
        return this.b.bin('gef', b, a);
    }
    assign(op, lhs, rhs) {
        const a = this.addrOf(lhs);
        let bits;
        let bitOff;
        if (lhs.kind === 'member') {
            try {
                const rec = lhs.arrow
                    ? (this.typeOf(lhs.base).kind === 'ptr' ? this.typeOf(lhs.base).to : this.typeOf(lhs.base))
                    : this.typeOf(lhs.base);
                const f = fieldOf(rec, lhs.field, this.env);
                bits = f.bits;
                bitOff = f.bitOff;
            }
            catch { /* */ }
        }
        if (op === '=') {
            this.park(a.reg);
            const v = this.rval(rhs);
            const dest = this.unpark();
            const converted = this.convertFor(v, a.ty, rhs);
            this.storeField(dest, converted, a.ty, bits, bitOff);
            return converted;
        }
        const cur = this.loadField(a.reg, a.ty, bits, bitOff);
        this.park(a.reg);
        if (isFloat(cur.ty))
            this.parkDouble(cur.reg);
        else
            this.park(cur.reg);
        const rv = this.rval(rhs);
        const left = isFloat(cur.ty) ? this.unparkDouble() : this.unpark();
        const dest = this.unpark();
        const computed = this.binaryRegs(op.slice(0, -1), { reg: left, ty: cur.ty }, rv);
        const converted = this.convert(computed, a.ty);
        this.storeField(dest, converted, a.ty, bits, bitOff);
        return converted;
    }
    binaryRegs(op, av, bv) {
        if (av.ty.kind === 'ptr') {
            if (op !== '+' && op !== '-')
                throw new CError(`invalid pointer compound operator '${op}='`, 1, 1);
            if (bv.ty.kind !== 'int' && bv.ty.kind !== 'char')
                throw new CError('pointer offset must be an integer', 1, 1);
            const scaled = this.b.mul(bv.reg, this.b.imm(this.sz(av.ty.to) || 4));
            return { reg: op === '+' ? this.b.add(av.reg, scaled) : this.b.sub(av.reg, scaled), ty: av.ty };
        }
        if (bv.ty.kind === 'ptr')
            throw new CError(`invalid pointer compound operator '${op}='`, 1, 1);
        const fp = isFloat(av.ty) || isFloat(bv.ty);
        const left = fp ? this.convert(av, FLT) : av;
        const right = fp ? this.convert(bv, FLT) : bv;
        if (op === '>>')
            return { reg: this.b.bin('sar', av.reg, bv.reg), ty: INT };
        if (fp && op === '+')
            return { reg: this.b.bin('addf', left.reg, right.reg), ty: FLT };
        if (fp && op === '-')
            return { reg: this.b.bin('subf', left.reg, right.reg), ty: FLT };
        if (fp && op === '*')
            return { reg: this.b.bin('mulf', left.reg, right.reg), ty: FLT };
        if (fp && op === '/')
            return { reg: this.b.bin('divf', left.reg, right.reg), ty: FLT };
        const map = {
            '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'rem',
            '&': 'and', '|': 'or', '^': 'xor', '<<': 'shl',
        };
        const ir = map[op];
        if (!ir)
            throw new CError(`unsupported '${op}='`, 1, 1);
        return { reg: this.b.bin(ir, av.reg, bv.reg), ty: INT };
    }
    argVal(e, ty) {
        const raw = this.rval(e);
        const v = ty ? this.convertFor(raw, ty, e) : raw;
        if (isAgg(v.ty))
            return v.reg;
        return v.reg;
    }
    call(e) {
        if (e.callee.kind === 'ident') {
            const name = e.callee.name;
            const builtin = this.builtin(name, e.args);
            if (builtin)
                return builtin;
            if (this.fns.has(name)) {
                const fn = this.fns.get(name);
                if (e.args.length !== fn.params.length) {
                    throw new CError(`function '${name}' expects ${fn.params.length} arguments, got ${e.args.length}`, 1, 1);
                }
                const retAgg = fn.ret.kind === 'record';
                if (retAgg)
                    this.park(this.alloca(this.sz(fn.ret) || 4));
                for (let i = 0; i < e.args.length; i++)
                    this.park(this.argVal(e.args[i], fn.params[i].ty));
                const stacked = [];
                for (let i = e.args.length - 1; i >= 0; i--)
                    stacked[i] = this.unpark();
                if (retAgg) {
                    const dest = this.unpark();
                    const got = this.callFn(name, [dest, ...stacked]);
                    return { reg: got, ty: fn.ret };
                }
                return { reg: this.callFn(name, stacked), ty: fn.ret };
            }
        }
        const fnptr = this.rval(e.callee);
        const fnTy = fnptr.ty.kind === 'ptr' && fnptr.ty.to.kind === 'fn' ? fnptr.ty.to : null;
        if (!fnTy)
            throw new CError('called expression is not a function pointer', 1, 1);
        if (fnTy.variadic)
            throw new CError('Guest C v1.4 does not support indirect variadic calls', 1, 1);
        if (fnTy.params.length !== e.args.length)
            throw new CError(`function pointer expects ${fnTy.params.length} arguments, got ${e.args.length}`, 1, 1);
        if (fnTy.ret.kind === 'record' || fnTy.ret.kind === 'array') {
            throw new CError('Guest C v1.4 does not support aggregate returns through function pointers', 1, 1);
        }
        if (fnTy.ret.kind === 'double' || fnTy.params.some((p) => p.kind === 'double')) {
            throw new CError('Guest C v1.4 does not support double in function-pointer signatures', 1, 1);
        }
        const args = e.args.map((a, i) => this.argVal(a, fnTy.params[i]));
        for (const a of args)
            this.park(a);
        const stacked = [];
        for (let i = args.length - 1; i >= 0; i--)
            stacked[i] = this.unpark();
        this.park(fnptr.reg);
        const fp = this.unpark();
        return { reg: this.icallFn(fp, stacked), ty: fnTy.ret };
    }
    loopCopy(dst, src, n, storeVal) {
        const i = this.b.imm(0);
        const top = this.b.lab();
        const done = this.b.lab();
        this.b.label(top);
        this.b.bge(i, n, done);
        const addrD = this.b.add(dst, i);
        if (storeVal !== undefined)
            this.b.stb(storeVal, addrD, 0);
        else {
            const addrS = this.b.add(src, i);
            this.b.stb(this.b.ldb(addrS, 0), addrD, 0);
        }
        this.b.addiTo(i, i, 1);
        this.b.br(top);
        this.b.label(done);
    }
    builtin(name, args) {
        if (name === 'printf')
            return this.printf(args);
        const builtinArity = {
            putchar: 1, puts: 1, malloc: 1, calloc: 2, free: 1, abs: 1,
            strlen: 1, strcmp: 2, memcmp: 3, strcpy: 2, memcpy: 3,
            strcat: 2, memset: 3, atoi: 1, __tid: 0, __nthreads: 0, __barrier: 0,
        };
        const expected = builtinArity[name];
        if (expected !== undefined && args.length !== expected) {
            throw new CError(`builtin '${name}' expects ${expected} arguments, got ${args.length}`, 1, 1);
        }
        if (name === 'putchar') {
            const c = this.rval(args[0] ?? { kind: 'int', value: 0 });
            return { reg: this.callFn('__putchar', [c.reg]), ty: INT };
        }
        if (name === 'puts') {
            const s = this.rval(args[0] ?? { kind: 'int', value: 0 });
            this.callFn('__putstr', [s.reg]);
            this.callFn('__putchar', [this.b.imm(10)]);
            return { reg: this.b.imm(0), ty: INT };
        }
        if (name === 'malloc' || name === 'calloc') {
            const n = this.rval(args[0] ?? { kind: 'int', value: 0 });
            let bytes = n.reg;
            const invalid = this.b.lab();
            const done = this.b.lab();
            const out = this.b.reg();
            this.b.movTo(out, this.b.imm(0));
            this.b.bge(this.b.privateNthreads(), this.b.imm(2), invalid);
            this.b.blt(n.reg, this.b.imm(0), invalid);
            if (name === 'calloc' && args[1]) {
                const m = this.rval(args[1]);
                this.b.blt(m.reg, this.b.imm(0), invalid);
                bytes = this.b.mul(n.reg, m.reg);
                this.b.blt(bytes, this.b.imm(0), invalid);
                const zero = this.b.lab();
                this.b.beq(n.reg, this.b.imm(0), zero);
                this.b.bne(this.b.bin('div', bytes, n.reg), m.reg, invalid);
                this.b.label(zero);
            }
            const ptr = this.b.imm(HEAP_PTR);
            const p = this.b.ldw(ptr, 0);
            const aligned = this.b.and(this.b.addi(bytes, 3), this.b.imm(~3));
            const next = this.b.add(p, aligned);
            this.b.blt(aligned, this.b.imm(0), invalid);
            this.b.blt(next, p, invalid);
            this.b.blt(this.b.imm(HEAP_LIMIT), next, invalid);
            this.b.movTo(out, p);
            this.b.stw(next, ptr, 0);
            if (name === 'calloc')
                this.zeroWords(p, aligned);
            this.b.br(done);
            this.b.label(invalid);
            this.b.label(done);
            return { reg: out, ty: PTR_VOID };
        }
        if (name === 'free')
            return { reg: this.b.imm(0), ty: INT };
        if (name === 'abs') {
            const v = this.rval(args[0] ?? { kind: 'int', value: 0 });
            const pos = this.b.lab();
            const out = this.b.reg();
            this.b.movTo(out, v.reg);
            this.b.bge(v.reg, this.b.imm(0), pos);
            this.b.movTo(out, this.b.sub(this.b.imm(0), v.reg));
            this.b.label(pos);
            return { reg: out, ty: INT };
        }
        if (name === 'strlen')
            return this.strlen(args);
        if (name === 'strcmp' || name === 'memcmp')
            return this.strcmp(args, name === 'memcmp');
        if (name === 'strcpy' || name === 'memcpy')
            return this.strcpy(args, name === 'memcpy');
        if (name === 'strcat')
            return this.strcat(args);
        if (name === 'memset')
            return this.memset(args);
        if (name === 'atoi')
            return this.atoi(args);
        if (name === '__tid')
            return { reg: this.b.tid(), ty: INT };
        if (name === '__nthreads')
            return { reg: this.b.nthreads(), ty: INT };
        if (name === '__barrier') {
            this.b.barrier();
            return { reg: this.b.imm(0), ty: INT };
        }
        return null;
    }
    zeroWords(p, n) {
        const i = this.b.imm(0);
        const top = this.b.lab();
        const done = this.b.lab();
        this.b.label(top);
        this.b.bge(i, n, done);
        this.b.stw(this.b.imm(0), this.b.add(p, i), 0);
        this.b.addiTo(i, i, 4);
        this.b.br(top);
        this.b.label(done);
    }
    zeroBytes(p, bytes) {
        const i = this.b.imm(0);
        const top = this.b.lab();
        const done = this.b.lab();
        this.b.label(top);
        this.b.bge(i, this.b.imm(bytes), done);
        this.b.stb(this.b.imm(0), this.b.add(p, i), 0);
        this.b.addiTo(i, i, 1);
        this.b.br(top);
        this.b.label(done);
    }
    strlen(args) {
        const p = this.b.mov(this.rval(args[0] ?? { kind: 'int', value: 0 }).reg);
        const n = this.b.imm(0);
        const top = this.b.lab();
        const done = this.b.lab();
        this.b.label(top);
        this.b.beq(this.b.ldb(p, 0), this.b.imm(0), done);
        this.b.addiTo(n, n, 1);
        this.b.addiTo(p, p, 1);
        this.b.br(top);
        this.b.label(done);
        return { reg: n, ty: INT };
    }
    strcmp(args, bounded) {
        const a = this.b.mov(this.rval(args[0] ?? { kind: 'int', value: 0 }).reg);
        const b = this.b.mov(this.rval(args[1] ?? { kind: 'int', value: 0 }).reg);
        const lim = bounded ? this.rval(args[2] ?? { kind: 'int', value: 0 }).reg : this.b.imm(1 << 20);
        const i = this.b.imm(0);
        const out = this.b.imm(0);
        const top = this.b.lab();
        const done = this.b.lab();
        const differs = this.b.lab();
        this.b.label(top);
        this.b.bge(i, lim, done);
        const ca = this.b.and(this.b.ldb(a, 0), this.b.imm(0xff));
        const cb = this.b.and(this.b.ldb(b, 0), this.b.imm(0xff));
        const diff = this.b.sub(ca, cb);
        this.b.bne(diff, this.b.imm(0), differs);
        this.b.beq(ca, this.b.imm(0), done);
        this.b.addiTo(a, a, 1);
        this.b.addiTo(b, b, 1);
        this.b.addiTo(i, i, 1);
        this.b.br(top);
        this.b.label(differs);
        this.b.movTo(out, diff);
        this.b.label(done);
        return { reg: out, ty: INT };
    }
    strcpy(args, bounded) {
        const dst = this.rval(args[0] ?? { kind: 'int', value: 0 }).reg;
        const src = this.rval(args[1] ?? { kind: 'int', value: 0 }).reg;
        const n = bounded ? this.rval(args[2] ?? { kind: 'int', value: 0 }).reg : this.b.imm(1 << 20);
        const d = this.b.mov(dst);
        const s = this.b.mov(src);
        const i = this.b.imm(0);
        const top = this.b.lab();
        const done = this.b.lab();
        this.b.label(top);
        this.b.bge(i, n, done);
        const ch = this.b.ldb(s, 0);
        this.b.stb(ch, d, 0);
        this.b.beq(ch, this.b.imm(0), done);
        this.b.addiTo(s, s, 1);
        this.b.addiTo(d, d, 1);
        this.b.addiTo(i, i, 1);
        this.b.br(top);
        this.b.label(done);
        return { reg: dst, ty: PTR_VOID };
    }
    strcat(args) {
        const dst = this.rval(args[0] ?? { kind: 'int', value: 0 }).reg;
        const d = this.b.mov(dst);
        const top = this.b.lab();
        const go = this.b.lab();
        this.b.label(top);
        this.b.beq(this.b.ldb(d, 0), this.b.imm(0), go);
        this.b.addiTo(d, d, 1);
        this.b.br(top);
        this.b.label(go);
        const src = this.rval(args[1] ?? { kind: 'int', value: 0 }).reg;
        const s = this.b.mov(src);
        const loop = this.b.lab();
        const done = this.b.lab();
        this.b.label(loop);
        const ch = this.b.ldb(s, 0);
        this.b.stb(ch, d, 0);
        this.b.beq(ch, this.b.imm(0), done);
        this.b.addiTo(s, s, 1);
        this.b.addiTo(d, d, 1);
        this.b.br(loop);
        this.b.label(done);
        return { reg: dst, ty: PTR_VOID };
    }
    memset(args) {
        const dst = this.rval(args[0] ?? { kind: 'int', value: 0 }).reg;
        const val = this.rval(args[1] ?? { kind: 'int', value: 0 }).reg;
        const n = this.rval(args[2] ?? { kind: 'int', value: 0 }).reg;
        const d = this.b.mov(dst);
        const i = this.b.imm(0);
        const top = this.b.lab();
        const done = this.b.lab();
        this.b.label(top);
        this.b.bge(i, n, done);
        this.b.stb(val, d, 0);
        this.b.addiTo(d, d, 1);
        this.b.addiTo(i, i, 1);
        this.b.br(top);
        this.b.label(done);
        return { reg: dst, ty: PTR_VOID };
    }
    atoi(args) {
        const p = this.b.mov(this.rval(args[0] ?? { kind: 'int', value: 0 }).reg);
        const sign = this.b.imm(1);
        const neg = this.b.lab();
        const loop = this.b.lab();
        const done = this.b.lab();
        this.b.bne(this.b.ldb(p, 0), this.b.imm(45), loop);
        this.b.movTo(sign, this.b.imm(-1));
        this.b.addiTo(p, p, 1);
        this.b.label(loop);
        const acc = this.b.imm(0);
        const more = this.b.lab();
        this.b.label(more);
        const ch = this.b.ldb(p, 0);
        this.b.blt(ch, this.b.imm(48), done);
        this.b.bge(ch, this.b.imm(58), done);
        this.b.movTo(acc, this.b.add(this.b.mul(acc, this.b.imm(10)), this.b.addi(ch, -48)));
        this.b.addiTo(p, p, 1);
        this.b.br(more);
        this.b.label(done);
        void neg;
        return { reg: this.b.mul(acc, sign), ty: INT };
    }
    printf(args) {
        if (!args.length)
            return { reg: this.b.imm(0), ty: INT };
        const fmtE = args[0];
        if (fmtE.kind !== 'str')
            throw new CError('printf format must be a string literal', 1, 1);
        const fmt = fmtE.value;
        let ai = 1;
        let i = 0;
        const count = this.b.imm(0);
        while (i < fmt.length) {
            if (fmt[i] === '%' && i + 1 < fmt.length) {
                const spec = fmt[i + 1];
                if (spec === '%') {
                    this.callFn('__putchar', [this.b.imm(37)]);
                    this.b.addiTo(count, count, 1);
                    i += 2;
                    continue;
                }
                if (spec !== 'c' && spec !== 's' && spec !== 'd') {
                    throw new CError(`Guest C v1.4 printf does not support format '%${spec}'`, 1, 1);
                }
                if (ai >= args.length)
                    throw new CError(`printf missing argument for '%${spec}'`, 1, 1);
                const arg = args[ai++];
                const v = this.rval(arg);
                if (spec === 's')
                    this.b.addTo(count, count, this.callFn('__putstr', [v.reg]));
                else if (spec === 'c') {
                    this.callFn('__putchar', [v.reg]);
                    this.b.addiTo(count, count, 1);
                }
                else
                    this.b.addTo(count, count, this.callFn('__putint', [v.reg]));
                i += 2;
                continue;
            }
            if (fmt[i] === '%')
                throw new CError('Guest C v1.4 printf format ends with bare %', 1, 1);
            this.callFn('__putchar', [this.b.imm(fmt.charCodeAt(i))]);
            this.b.addiTo(count, count, 1);
            i += 1;
        }
        if (ai !== args.length)
            throw new CError('printf has unused arguments', 1, 1);
        return { reg: count, ty: INT };
    }
}
export function lowerC(prog) {
    return new Lower(prog.env).run(prog);
}
//# sourceMappingURL=clower.js.map