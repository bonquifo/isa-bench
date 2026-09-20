export function emptyEnv() {
    return { records: new Map(), enums: new Map(), typedefs: new Map() };
}
export function cloneType(ty) {
    switch (ty.kind) {
        case 'ptr':
            return { kind: 'ptr', to: cloneType(ty.to) };
        case 'array':
            return { kind: 'array', to: cloneType(ty.to), len: ty.len };
        case 'fn':
            return { kind: 'fn', ret: cloneType(ty.ret), params: ty.params.map(cloneType), variadic: ty.variadic };
        case 'record':
            return { kind: 'record', rec: ty.rec, tag: ty.tag };
        default:
            return ty;
    }
}
export function alignOf(ty, env) {
    switch (ty.kind) {
        case 'void':
            return 1;
        case 'int':
        case 'ptr':
        case 'fn':
            return 4;
        case 'char':
            return 1;
        case 'double':
            return 8;
        case 'array':
            return alignOf(ty.to, env);
        case 'record': {
            const rec = env.records.get(ty.tag);
            return rec?.align || 4;
        }
    }
}
export function sizeOf(ty, env) {
    switch (ty.kind) {
        case 'void':
            return 0;
        case 'int':
        case 'ptr':
        case 'fn':
            return 4;
        case 'char':
            return 1;
        case 'double':
            return 8;
        case 'array':
            return Math.max(0, ty.len) * sizeOf(ty.to, env);
        case 'record': {
            const rec = env.records.get(ty.tag);
            if (!rec?.complete)
                return 0;
            return rec.size;
        }
    }
}
export function decay(ty) {
    if (ty.kind === 'array')
        return { kind: 'ptr', to: ty.to };
    if (ty.kind === 'fn')
        return { kind: 'ptr', to: ty };
    return ty;
}
export function isFloat(ty) {
    return ty.kind === 'double';
}
export function isPtr(ty) {
    return ty.kind === 'ptr' || ty.kind === 'array';
}
export function isAgg(ty) {
    return ty.kind === 'record' || ty.kind === 'array';
}
export function typesEq(a, b) {
    if (a.kind !== b.kind) {
        if ((a.kind === 'ptr' && b.kind === 'ptr') === false) {
            if (a.kind === 'int' && b.kind === 'int')
                return true;
        }
    }
    if (a.kind !== b.kind)
        return false;
    switch (a.kind) {
        case 'void':
        case 'int':
        case 'char':
        case 'double':
            return true;
        case 'ptr':
            return b.kind === 'ptr' && (((a.to.kind === 'void' || b.to.kind === 'void') && a.to.kind !== 'fn' && b.to.kind !== 'fn')
                || typesEq(a.to, b.to));
        case 'array':
            return b.kind === 'array' && typesEq(a.to, b.to);
        case 'fn':
            return b.kind === 'fn'
                && a.variadic === b.variadic
                && a.params.length === b.params.length
                && typesEq(a.ret, b.ret)
                && a.params.every((param, i) => typesEq(param, b.params[i]));
        case 'record':
            return b.kind === 'record' && a.rec === b.rec && a.tag === b.tag;
    }
}
export function fieldOf(ty, name, env) {
    if (ty.kind !== 'record')
        throw new Error(`member '.${name}' on a non-struct`);
    const rec = env.records.get(ty.tag);
    if (!rec?.complete)
        throw new Error(`incomplete ${ty.rec} '${ty.tag}'`);
    const f = rec.fields.find((x) => x.name === name);
    if (!f)
        throw new Error(`${ty.rec} '${ty.tag}' has no member '${name}'`);
    return f;
}
export function flattenFields(fields, env) {
    const out = [];
    for (const f of fields) {
        if (!f.name && f.ty.kind === 'record') {
            const inner = env.records.get(f.ty.tag);
            if (inner) {
                for (const c of flattenFields(inner.fields, env)) {
                    out.push({ ...c, off: f.off + c.off });
                }
                continue;
            }
        }
        out.push(f);
    }
    return out;
}
export function layoutRecord(rec, tag, raw, env) {
    const fields = [];
    let off = 0;
    let size = 0;
    let align = 1;
    let bitCursor = 0;
    let bitWord = -1;
    for (const src of raw) {
        const a = alignOf(src.ty, env);
        if (a > align)
            align = a;
        if (src.bits === 0) {
            off = Math.ceil(off / 4) * 4;
            bitWord = -1;
            bitCursor = 0;
            continue;
        }
        if (src.bits !== undefined && src.bits > 0 && src.ty.kind === 'int') {
            if (bitWord < 0 || bitCursor + src.bits > 32) {
                off = Math.ceil(off / 4) * 4;
                bitWord = off;
                bitCursor = 0;
                off += 4;
            }
            fields.push({
                name: src.name,
                ty: src.ty,
                off: bitWord,
                bits: src.bits,
                bitOff: bitCursor,
            });
            bitCursor += src.bits;
            size = rec === 'union' ? Math.max(size, 4) : Math.max(size, off);
            continue;
        }
        bitWord = -1;
        bitCursor = 0;
        const sz = Math.max(src.ty.kind === 'array' && src.ty.len === 0 ? 0 : sizeOf(src.ty, env), src.name || src.ty.kind === 'record' ? sizeOf(src.ty, env) : 0);
        if (rec === 'union') {
            fields.push({ name: src.name, ty: src.ty, off: 0 });
            size = Math.max(size, sz);
        }
        else {
            off = Math.ceil(off / a) * a;
            fields.push({ name: src.name, ty: src.ty, off });
            off += sz;
            size = off;
        }
    }
    size = Math.ceil(Math.max(size, 0) / align) * align;
    if (size === 0)
        size = 4;
    const def = { rec, tag, fields: flattenFields(fields, env), size, align, complete: true };
    env.records.set(tag, def);
    return def;
}
//# sourceMappingURL=ctypes.js.map