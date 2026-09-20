export declare function i32(n: number): number;
export declare function u32(n: number): number;
/** Exact for the full JavaScript safe-integer domain; does not truncate to 32 bits. */
export declare function isSafePowerOfTwo(n: number): boolean;
export declare function imul(a: number, b: number): number;
export declare function idiv(a: number, b: number): number;
export declare function irem(a: number, b: number): number;
export declare function ishl(a: number, b: number): number;
export declare function ishr(a: number, b: number): number;
export declare function isar(a: number, b: number): number;
export declare function inSigned(n: number, bits: number): boolean;
export declare function inUnsigned(n: number, bits: number): boolean;
export declare function splitLui12(imm: number): {
    upper: number;
    lower: number;
};
export declare function checksumI32(view: DataView, addr: number, words: number): number;
export declare function lcg(seed: number): () => number;
export declare function valuesEqual(a: number, b: number, fp: boolean): boolean;
//# sourceMappingURL=bits.d.ts.map