export function i32(n) {
    return n | 0;
}
export function u32(n) {
    return n >>> 0;
}
/** Exact for the full JavaScript safe-integer domain; does not truncate to 32 bits. */
export function isSafePowerOfTwo(n) {
    if (!Number.isSafeInteger(n) || n <= 0)
        return false;
    const exponent = Math.log2(n);
    return Number.isInteger(exponent) && 2 ** exponent === n;
}
export function imul(a, b) {
    return Math.imul(a | 0, b | 0);
}
export function idiv(a, b) {
    const d = b | 0;
    if (d === 0)
        return 0;
    return (a / d) | 0;
}
export function irem(a, b) {
    const d = b | 0;
    if (d === 0)
        return 0;
    return (a | 0) % d | 0;
}
export function ishl(a, b) {
    return (a | 0) << ((b | 0) & 31);
}
export function ishr(a, b) {
    return (a | 0) >>> ((b | 0) & 31);
}
export function isar(a, b) {
    return (a | 0) >> ((b | 0) & 31);
}
export function inSigned(n, bits) {
    const min = -(1 << (bits - 1));
    const max = (1 << (bits - 1)) - 1;
    return n >= min && n <= max;
}
export function inUnsigned(n, bits) {
    return n >= 0 && n < 1 << bits;
}
export function splitLui12(imm) {
    const lower = (imm << 20) >> 20;
    const upper = ((imm - lower) >>> 12) & 0xfffff;
    return { upper, lower };
}
export function checksumI32(view, addr, words) {
    let h = 2166136261;
    for (let i = 0; i < words; i++) {
        h ^= view.getInt32(addr + i * 4, true);
        h = Math.imul(h, 16777619);
    }
    return h | 0;
}
export function lcg(seed) {
    let s = seed | 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) | 0;
        return s;
    };
}
export function valuesEqual(a, b, fp) {
    if (!fp) {
        const isI32 = (value) => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
        return isI32(a) && isI32(b) && a === b;
    }
    // Every backend executes the same ordered binary64 operations. NaN is the
    // single deliberate equivalence class; all other observables, including
    // infinities and the sign of zero, therefore use exact IEEE identity.
    if (Number.isNaN(a) && Number.isNaN(b))
        return true;
    return Object.is(a, b);
}
//# sourceMappingURL=bits.js.map