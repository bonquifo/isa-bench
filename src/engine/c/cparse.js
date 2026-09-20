import { CError, lex } from './clex.ts';
import { cloneType, emptyEnv, layoutRecord, sizeOf, } from './ctypes.ts';
class P {
    i = 0;
    toks;
    env;
    anon = 0;
    lastStorage;
    constructor(toks, env) {
        this.toks = toks;
        this.env = env;
    }
    tok() {
        return this.toks[this.i] ?? this.toks[this.toks.length - 1];
    }
    peek(n = 0) {
        return this.toks[this.i + n] ?? this.toks[this.toks.length - 1];
    }
    at(kind, text) {
        const t = this.tok();
        return t.kind === kind && (text === undefined || t.text === text);
    }
    eat(kind, text) {
        const t = this.tok();
        if (t.kind !== kind || (text !== undefined && t.text !== text)) {
            throw new CError(`expected ${text ?? kind}, got '${t.text}'`, t.line, t.col);
        }
        this.i += 1;
        return t;
    }
    tryEat(kind, text) {
        if (this.at(kind, text)) {
            this.i += 1;
            return true;
        }
        return false;
    }
    err(msg) {
        const t = this.tok();
        throw new CError(msg, t.line, t.col);
    }
}
function isTypeTok(p) {
    if (p.at('ident') && p.env.typedefs.has(p.tok().text))
        return true;
    if (!p.at('kw'))
        return false;
    return [
        'void', 'char', 'short', 'int', 'long', 'float', 'double',
        'signed', 'unsigned', 'const', 'volatile', 'static', 'extern',
        'inline', 'auto', 'register', 'restrict', '_Bool', 'bool',
        'struct', 'union', 'enum', '_Thread_local',
    ].includes(p.tok().text);
}
function foldInt(e, p) {
    if (e.kind === 'int')
        return e.value;
    if (e.kind === 'ident')
        return p.env.enums.get(e.name);
    if (e.kind === 'sizeof' && e.ty)
        return sizeOf(e.ty, p.env);
    if (e.kind === 'alignof')
        return 4;
    if (e.kind === 'unary' && e.op === '-') {
        const v = foldInt(e.expr, p);
        return v === undefined ? undefined : -v;
    }
    if (e.kind === 'unary' && e.op === '+')
        return foldInt(e.expr, p);
    if (e.kind === 'unary' && e.op === '~') {
        const v = foldInt(e.expr, p);
        return v === undefined ? undefined : ~v;
    }
    if (e.kind === 'binary') {
        const a = foldInt(e.a, p);
        const b = foldInt(e.b, p);
        if (a === undefined || b === undefined)
            return undefined;
        switch (e.op) {
            case '+': return (a + b) | 0;
            case '-': return (a - b) | 0;
            case '*': return Math.imul(a, b);
            case '/': return b ? (a / b) | 0 : 0;
            case '%': return b ? a % b : 0;
            case '<<': return a << b;
            case '>>': return a >> b;
            case '&': return a & b;
            case '|': return a | b;
            case '^': return a ^ b;
            default: return undefined;
        }
    }
    if (e.kind === 'cast')
        return foldInt(e.expr, p);
    return undefined;
}
function parseRecord(p, rec) {
    let tag = '';
    if (p.at('ident'))
        tag = p.eat('ident').text;
    if (p.tryEat('punct', '{')) {
        if (!tag) {
            p.anon += 1;
            tag = `$anon${p.anon}`;
        }
        const raw = [];
        while (!p.at('punct', '}') && !p.at('eof')) {
            if (p.tryEat('kw', '_Static_assert')) {
                parseStaticAssert(p);
                continue;
            }
            const base = parseBaseType(p);
            if (p.tryEat('punct', ';'))
                continue;
            for (;;) {
                const d = parseDeclarator(p, true);
                let bits;
                if (p.tryEat('punct', ':')) {
                    const n = parseAssign(p);
                    const v = foldInt(n, p);
                    if (v === undefined)
                        p.err('bit-field width must be constant');
                    if (d.wrap(base).kind !== 'int')
                        p.err('Guest C bit-fields must have type int');
                    if (v < 0 || v > 32)
                        p.err(`bit-field width ${v} is outside 0..32`);
                    if (v === 0 && d.name)
                        p.err('named bit-field cannot have zero width');
                    bits = v;
                }
                raw.push({ name: d.name, ty: d.wrap(base), bits });
                if (!p.tryEat('punct', ','))
                    break;
            }
            p.eat('punct', ';');
        }
        p.eat('punct', '}');
        layoutRecord(rec, tag, raw, p.env);
    }
    else if (tag) {
        if (!p.env.records.has(tag)) {
            p.env.records.set(tag, { rec, tag, fields: [], size: 0, align: 4, complete: false });
        }
    }
    else
        p.err(`expected ${rec} tag or body`);
    return { kind: 'record', rec, tag };
}
function parseEnum(p) {
    if (p.at('ident'))
        p.i += 1;
    if (p.tryEat('punct', '{')) {
        let val = 0;
        while (!p.at('punct', '}') && !p.at('eof')) {
            const name = p.eat('ident').text;
            if (p.tryEat('punct', '=')) {
                const n = parseAssign(p);
                const v = foldInt(n, p);
                if (v === undefined)
                    p.err('enum value must be constant');
                val = v;
            }
            p.env.enums.set(name, val);
            val += 1;
            if (!p.tryEat('punct', ','))
                break;
        }
        p.eat('punct', '}');
    }
    return { kind: 'int' };
}
function parseBaseType(p) {
    let storage;
    let base;
    let signed = false;
    while (p.at('kw') || (p.at('ident') && p.env.typedefs.has(p.tok().text))) {
        if (p.at('ident')) {
            const name = p.tok().text;
            const ty = p.env.typedefs.get(name);
            if (ty) {
                p.i += 1;
                return cloneType(ty);
            }
        }
        const k = p.tok().text;
        if (k === 'const' || k === 'volatile' || k === 'inline' || k === 'auto' || k === 'register' || k === 'restrict') {
            p.i += 1;
            continue;
        }
        if (k === 'signed') {
            signed = true;
            p.i += 1;
            continue;
        }
        if (k === 'unsigned' || k === 'short' || k === 'long' || k === '_Bool' || k === 'bool' || k === '_Thread_local') {
            p.err(`Guest C v1.4 does not support '${k}' scalar types`);
        }
        if (k === 'static') {
            storage = 'static';
            p.lastStorage = 'static';
            p.i += 1;
            continue;
        }
        if (k === 'extern') {
            storage = 'extern';
            p.lastStorage = 'extern';
            p.i += 1;
            continue;
        }
        if (k === 'struct') {
            p.i += 1;
            const ty = parseRecord(p, 'struct');
            void storage;
            return ty;
        }
        if (k === 'union') {
            p.i += 1;
            return parseRecord(p, 'union');
        }
        if (k === 'enum') {
            p.i += 1;
            return parseEnum(p);
        }
        if (k === 'void') {
            p.i += 1;
            base = 'void';
            break;
        }
        if (k === 'float')
            p.err("Guest C v1.4 does not support 'float'; use double");
        if (k === 'double') {
            p.i += 1;
            base = 'double';
            break;
        }
        if (k === 'char') {
            p.i += 1;
            base = 'char';
            break;
        }
        if (k === 'int') {
            p.i += 1;
            base = 'int';
            continue;
        }
        break;
    }
    if (!base && signed)
        base = 'int';
    if (base === 'void')
        return { kind: 'void' };
    if (base === 'char')
        return { kind: 'char', signed: true };
    if (base === 'double')
        return { kind: 'double' };
    if (base === 'int')
        return { kind: 'int' };
    p.err('expected a type');
}
function parseDeclarator(p, abstract = false) {
    let stars = 0;
    while (p.tryEat('punct', '*')) {
        while (p.tryEat('kw', 'const') || p.tryEat('kw', 'volatile') || p.tryEat('kw', 'restrict')) { /* */ }
        stars += 1;
    }
    let inner;
    if (p.tryEat('punct', '(') && !isTypeTok(p) && !p.at('punct', ')')) {
        inner = parseDeclarator(p, abstract);
        p.eat('punct', ')');
    }
    else if (p.at('ident')) {
        inner = { name: p.eat('ident').text, wrap: (t) => t };
    }
    else if (abstract) {
        inner = { name: '', wrap: (t) => t };
    }
    else {
        p.err('expected identifier');
    }
    let wrap = inner.wrap;
    let params = inner.params;
    let variadic = inner.variadic;
    let explicitVoid = inner.explicitVoid;
    let vla = inner.vla;
    for (;;) {
        if (p.tryEat('punct', '[')) {
            let len = 0;
            if (!p.at('punct', ']')) {
                const n = parseAssign(p);
                const c = foldInt(n, p);
                if (c !== undefined)
                    len = c;
                else {
                    len = -1;
                    vla = n;
                }
            }
            p.eat('punct', ']');
            const prev = wrap;
            wrap = (base) => prev({ kind: 'array', to: base, len });
            continue;
        }
        if (p.tryEat('punct', '(')) {
            const ps = [];
            let vari = false;
            let voidList = false;
            if (!p.at('punct', ')')) {
                if (p.at('kw', 'void') && p.peek(1).text === ')') {
                    p.i += 1;
                    voidList = true;
                }
                else {
                    for (;;) {
                        if (p.tok().text === '...') {
                            p.err('Guest C v1.4 does not support user-declared variadic functions');
                        }
                        if (!isTypeTok(p))
                            p.err('expected parameter type');
                        const ty0 = parseBaseType(p);
                        const d = parseDeclarator(p, true);
                        const declared = d.wrap(ty0);
                        const adjusted = declared.kind === 'array'
                            ? { kind: 'ptr', to: declared.to }
                            : declared.kind === 'fn'
                                ? { kind: 'ptr', to: declared }
                                : declared;
                        ps.push({ name: d.name || `arg${ps.length}`, ty: adjusted });
                        if (!p.tryEat('punct', ','))
                            break;
                    }
                }
            }
            p.eat('punct', ')');
            params = ps;
            variadic = vari;
            explicitVoid = voidList;
            const prev = wrap;
            wrap = (base) => prev({
                kind: 'fn',
                ret: base,
                params: ps.map((x) => x.ty),
                variadic: vari,
            });
            continue;
        }
        break;
    }
    const starWrap = (base) => {
        let t = base;
        for (let i = 0; i < stars; i++)
            t = { kind: 'ptr', to: t };
        return wrap(t);
    };
    return { name: inner.name, wrap: starWrap, params, variadic, explicitVoid, vla };
}
function parseExpr(p) {
    return parseComma(p);
}
function parseComma(p) {
    const first = parseAssign(p);
    if (!p.at('punct', ','))
        return first;
    const items = [first];
    while (p.tryEat('punct', ','))
        items.push(parseAssign(p));
    return { kind: 'comma', items };
}
const ASSIGNS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
function parseAssign(p) {
    const lhs = parseCond(p);
    const t = p.tok();
    if (t.kind === 'punct' && ASSIGNS.has(t.text)) {
        p.i += 1;
        return { kind: 'assign', op: t.text, lhs, rhs: parseAssign(p) };
    }
    return lhs;
}
function parseCond(p) {
    const c = parseOr(p);
    if (!p.tryEat('punct', '?'))
        return c;
    const t = parseExpr(p);
    p.eat('punct', ':');
    return { kind: 'cond', c, t, f: parseCond(p) };
}
function binL(p, next, ops) {
    let a = next(p);
    while (p.tok().kind === 'punct' && ops.includes(p.tok().text)) {
        const op = p.tok().text;
        p.i += 1;
        a = { kind: 'binary', op, a, b: next(p) };
    }
    return a;
}
function parseOr(p) { return binL(p, parseAnd, ['||']); }
function parseAnd(p) { return binL(p, parseBor, ['&&']); }
function parseBor(p) { return binL(p, parseXor, ['|']); }
function parseXor(p) { return binL(p, parseBand, ['^']); }
function parseBand(p) { return binL(p, parseEq, ['&']); }
function parseEq(p) { return binL(p, parseRel, ['==', '!=']); }
function parseRel(p) { return binL(p, parseShift, ['<', '>', '<=', '>=']); }
function parseShift(p) { return binL(p, parseAdd, ['<<', '>>']); }
function parseAdd(p) { return binL(p, parseMul, ['+', '-']); }
function parseMul(p) { return binL(p, parseUnary, ['*', '/', '%']); }
function parseUnary(p) {
    if (p.tryEat('kw', 'sizeof')) {
        if (p.tryEat('punct', '(')) {
            if (isTypeTok(p)) {
                const ty = parseAbstractType(p);
                p.eat('punct', ')');
                return { kind: 'sizeof', ty };
            }
            const expr = parseExpr(p);
            p.eat('punct', ')');
            return { kind: 'sizeof', expr };
        }
        return { kind: 'sizeof', expr: parseUnary(p) };
    }
    if (p.tryEat('kw', '_Alignof')) {
        p.eat('punct', '(');
        const ty = parseAbstractType(p);
        p.eat('punct', ')');
        return { kind: 'alignof', ty };
    }
    if (p.tryEat('punct', '(')) {
        if (isTypeTok(p)) {
            const ty = parseAbstractType(p);
            p.eat('punct', ')');
            if (p.at('punct', '{'))
                return { kind: 'compound', ty, init: parseInit(p) };
            return { kind: 'cast', ty, expr: parseUnary(p) };
        }
        const e = parseExpr(p);
        p.eat('punct', ')');
        return parsePost(p, e);
    }
    if (p.at('punct') && ['+', '-', '!', '~', '*', '&', '++', '--'].includes(p.tok().text)) {
        const op = p.tok().text;
        p.i += 1;
        return { kind: 'unary', op, expr: parseUnary(p) };
    }
    return parsePost(p, parsePrimary(p));
}
function parseAbstractType(p) {
    const base = parseBaseType(p);
    const d = parseDeclarator(p, true);
    return d.wrap(base);
}
function parsePost(p, e) {
    for (;;) {
        if (p.tryEat('punct', '[')) {
            const index = parseExpr(p);
            p.eat('punct', ']');
            e = { kind: 'index', base: e, index };
            continue;
        }
        if (p.tryEat('punct', '(')) {
            const args = [];
            if (!p.at('punct', ')')) {
                args.push(parseAssign(p));
                while (p.tryEat('punct', ','))
                    args.push(parseAssign(p));
            }
            p.eat('punct', ')');
            e = { kind: 'call', callee: e, args };
            continue;
        }
        if (p.tryEat('punct', '.')) {
            e = { kind: 'member', base: e, field: p.eat('ident').text, arrow: false };
            continue;
        }
        if (p.tryEat('punct', '->')) {
            e = { kind: 'member', base: e, field: p.eat('ident').text, arrow: true };
            continue;
        }
        if (p.tryEat('punct', '++')) {
            e = { kind: 'unary', op: '++x', expr: e };
            continue;
        }
        if (p.tryEat('punct', '--')) {
            e = { kind: 'unary', op: '--x', expr: e };
            continue;
        }
        break;
    }
    return e;
}
function parsePrimary(p) {
    if (p.tryEat('kw', '_Generic')) {
        p.eat('punct', '(');
        const ctrl = parseAssign(p);
        p.eat('punct', ',');
        const assocs = [];
        for (;;) {
            if (p.tryEat('kw', 'default')) {
                p.eat('punct', ':');
                assocs.push({ expr: parseAssign(p) });
            }
            else {
                const ty = parseAbstractType(p);
                p.eat('punct', ':');
                assocs.push({ ty, expr: parseAssign(p) });
            }
            if (!p.tryEat('punct', ','))
                break;
        }
        p.eat('punct', ')');
        return { kind: 'generic', ctrl, assocs };
    }
    if (p.at('int'))
        return { kind: 'int', value: Number(p.eat('int').value) };
    if (p.at('float'))
        return { kind: 'float', value: Number(p.eat('float').value) };
    if (p.at('str')) {
        let s = String(p.eat('str').value ?? '');
        while (p.at('str'))
            s += String(p.eat('str').value ?? '');
        return { kind: 'str', value: s };
    }
    if (p.at('char'))
        return { kind: 'int', value: Number(p.eat('char').value) };
    if (p.at('ident'))
        return { kind: 'ident', name: p.eat('ident').text };
    p.err(`expected expression, got '${p.tok().text}'`);
}
function parseInit(p) {
    if (!p.tryEat('punct', '{'))
        return { kind: 'expr', expr: parseAssign(p) };
    const items = [];
    while (!p.at('punct', '}') && !p.at('eof')) {
        const designators = [];
        while (p.at('punct', '.') || p.at('punct', '[')) {
            if (p.tryEat('punct', '.'))
                designators.push({ kind: 'field', name: p.eat('ident').text });
            else {
                p.eat('punct', '[');
                const n = parseAssign(p);
                const v = foldInt(n, p);
                if (v === undefined)
                    p.err('designated index must be constant');
                p.eat('punct', ']');
                designators.push({ kind: 'index', index: v });
            }
        }
        if (designators.length)
            p.tryEat('punct', '=');
        items.push({ designators, init: parseInit(p) });
        if (!p.tryEat('punct', ','))
            break;
    }
    p.eat('punct', '}');
    return { kind: 'list', items };
}
function parseStaticAssert(p) {
    p.eat('punct', '(');
    const e = parseAssign(p);
    p.eat('punct', ',');
    const msg = p.at('str') ? String(p.eat('str').value ?? '') : '';
    p.eat('punct', ')');
    p.eat('punct', ';');
    const v = foldInt(e, p);
    if (v === 0)
        throw new CError(`static assertion failed: ${msg}`, p.tok().line, p.tok().col);
    return { kind: 'static_assert', ok: true, msg };
}
function parseStmt(p) {
    if (p.tryEat('punct', '{')) {
        const stmts = [];
        while (!p.at('punct', '}') && !p.at('eof'))
            stmts.push(parseStmt(p));
        p.eat('punct', '}');
        return { kind: 'block', stmts };
    }
    if (p.tryEat('kw', '_Static_assert'))
        return parseStaticAssert(p);
    if (p.tryEat('kw', 'if')) {
        p.eat('punct', '(');
        const cond = parseExpr(p);
        p.eat('punct', ')');
        const then = parseStmt(p);
        const els = p.tryEat('kw', 'else') ? parseStmt(p) : undefined;
        return { kind: 'if', cond, then, else: els };
    }
    if (p.tryEat('kw', 'while')) {
        p.eat('punct', '(');
        const cond = parseExpr(p);
        p.eat('punct', ')');
        return { kind: 'while', cond, body: parseStmt(p) };
    }
    if (p.tryEat('kw', 'do')) {
        const body = parseStmt(p);
        p.eat('kw', 'while');
        p.eat('punct', '(');
        const cond = parseExpr(p);
        p.eat('punct', ')');
        p.eat('punct', ';');
        return { kind: 'do', cond, body };
    }
    if (p.tryEat('kw', 'for')) {
        p.eat('punct', '(');
        let init;
        if (!p.tryEat('punct', ';')) {
            if (isTypeTok(p))
                init = parseDeclStmt(p);
            else {
                init = { kind: 'expr', expr: parseExpr(p) };
                p.eat('punct', ';');
            }
        }
        let cond;
        if (!p.at('punct', ';'))
            cond = parseExpr(p);
        p.eat('punct', ';');
        let step;
        if (!p.at('punct', ')'))
            step = parseExpr(p);
        p.eat('punct', ')');
        return { kind: 'for', init, cond, step, body: parseStmt(p) };
    }
    if (p.tryEat('kw', 'return')) {
        if (p.tryEat('punct', ';'))
            return { kind: 'return' };
        const expr = parseExpr(p);
        p.eat('punct', ';');
        return { kind: 'return', expr };
    }
    if (p.tryEat('kw', 'break')) {
        p.eat('punct', ';');
        return { kind: 'break' };
    }
    if (p.tryEat('kw', 'continue')) {
        p.eat('punct', ';');
        return { kind: 'continue' };
    }
    if (p.tryEat('kw', 'goto')) {
        const name = p.eat('ident').text;
        p.eat('punct', ';');
        return { kind: 'goto', name };
    }
    if (p.tryEat('kw', 'switch')) {
        p.eat('punct', '(');
        const expr = parseExpr(p);
        p.eat('punct', ')');
        const body = parseStmt(p);
        return { kind: 'switch', expr, body: body.kind === 'block' ? body.stmts : [body] };
    }
    if (p.tryEat('kw', 'case')) {
        const v = parseExpr(p);
        const n = foldInt(v, p);
        if (n === undefined)
            p.err('case label must be an integer constant');
        p.eat('punct', ':');
        return { kind: 'case', value: n };
    }
    if (p.tryEat('kw', 'default')) {
        p.eat('punct', ':');
        return { kind: 'default' };
    }
    if (p.at('ident') && p.peek(1).text === ':') {
        const name = p.eat('ident').text;
        p.eat('punct', ':');
        return { kind: 'label', name };
    }
    if (isTypeTok(p))
        return parseDeclStmt(p);
    if (p.tryEat('punct', ';'))
        return { kind: 'block', stmts: [] };
    const expr = parseExpr(p);
    p.eat('punct', ';');
    return { kind: 'expr', expr };
}
function parseDeclStmt(p) {
    const base = parseBaseType(p);
    const storage = p.lastStorage;
    p.lastStorage = undefined;
    const decls = [];
    if (!p.at('punct', ';')) {
        for (;;) {
            const d = parseDeclarator(p);
            let ty = d.wrap(base);
            let init;
            if (p.tryEat('punct', '=')) {
                init = parseInit(p);
                const string = stringInitializer(init);
                if (ty.kind === 'array' && ty.len === 0 && string !== undefined) {
                    ty = { kind: 'array', to: ty.to, len: string.length + 1 };
                }
                validateStringInitializer(p, ty, init);
            }
            decls.push({ name: d.name, ty, init, vla: d.vla, storage });
            if (!p.tryEat('punct', ','))
                break;
        }
    }
    p.eat('punct', ';');
    return { kind: 'decl', decls };
}
function validateStringInitializer(p, ty, init) {
    const string = stringInitializer(init);
    if (string === undefined)
        return;
    if (ty.kind !== 'array' || ty.to.kind !== 'char') {
        if (ty.kind !== 'ptr')
            p.err('string initializer requires char array or pointer');
        return;
    }
    if (string.length > ty.len) {
        p.err(`string literal of ${string.length} bytes is too long for char[${ty.len}]`);
    }
}
function stringInitializer(init) {
    if (init.kind === 'expr' && init.expr.kind === 'str')
        return init.expr.value;
    if (init.kind === 'list' && init.items.length === 1 && init.items[0].designators.length === 0) {
        const only = init.items[0].init;
        if (only.kind === 'expr' && only.expr.kind === 'str')
            return only.expr.value;
    }
    return undefined;
}
export function parseC(source) {
    const env = emptyEnv();
    const p = new P(lex(source), env);
    const fns = [];
    const globals = [];
    while (!p.at('eof')) {
        if (p.tryEat('kw', '_Static_assert')) {
            parseStaticAssert(p);
            continue;
        }
        if (p.tryEat('kw', 'typedef')) {
            const base = parseBaseType(p);
            const d = parseDeclarator(p);
            env.typedefs.set(d.name, d.wrap(base));
            p.eat('punct', ';');
            continue;
        }
        if (!isTypeTok(p))
            p.err('expected declaration');
        const base = parseBaseType(p);
        if (p.tryEat('punct', ';'))
            continue;
        const d = parseDeclarator(p);
        const ty = d.wrap(base);
        if (ty.kind === 'fn') {
            const fn = {
                name: d.name,
                ret: ty.ret,
                params: d.params ?? ty.params.map((t, i) => ({ name: `arg${i}`, ty: t })),
                variadic: ty.variadic,
                explicitVoid: d.explicitVoid ?? false,
            };
            if (p.tryEat('punct', '{')) {
                const stmts = [];
                while (!p.at('punct', '}') && !p.at('eof'))
                    stmts.push(parseStmt(p));
                p.eat('punct', '}');
                fn.body = { kind: 'block', stmts };
            }
            else {
                p.eat('punct', ';');
            }
            fns.push(fn);
        }
        else {
            let init;
            let gty = ty;
            if (p.tryEat('punct', '=')) {
                init = parseInit(p);
                const string = stringInitializer(init);
                if (gty.kind === 'array' && gty.len === 0 && string !== undefined) {
                    gty = { kind: 'array', to: gty.to, len: string.length + 1 };
                }
                validateStringInitializer(p, gty, init);
            }
            globals.push({ name: d.name, ty: gty, init });
            while (p.tryEat('punct', ',')) {
                const d2 = parseDeclarator(p);
                let init2;
                if (p.tryEat('punct', '='))
                    init2 = parseInit(p);
                let ty2 = d2.wrap(base);
                const string = init2 ? stringInitializer(init2) : undefined;
                if (ty2.kind === 'array' && ty2.len === 0 && string !== undefined) {
                    ty2 = { kind: 'array', to: ty2.to, len: string.length + 1 };
                }
                if (init2)
                    validateStringInitializer(p, ty2, init2);
                globals.push({ name: d2.name, ty: ty2, init: init2 });
            }
            p.eat('punct', ';');
        }
    }
    return { fns, globals, env };
}
export { CError };
//# sourceMappingURL=cparse.js.map