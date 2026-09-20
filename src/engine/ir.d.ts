export declare const BinOp: {
    readonly ADD: "add";
    readonly SUB: "sub";
    readonly MUL: "mul";
    readonly DIV: "div";
    readonly REM: "rem";
    readonly AND: "and";
    readonly OR: "or";
    readonly XOR: "xor";
    readonly SHL: "shl";
    readonly SHR: "shr";
    readonly SAR: "sar";
    readonly ADDF: "addf";
    readonly SUBF: "subf";
    readonly MULF: "mulf";
    readonly DIVF: "divf";
    readonly EQF: "eqf";
    readonly NEF: "nef";
    readonly LTF: "ltf";
    readonly GEF: "gef";
};
export type BinOp = (typeof BinOp)[keyof typeof BinOp];
export declare const Cond: {
    readonly EQ: "eq";
    readonly NE: "ne";
    readonly LT: "lt";
    readonly GE: "ge";
};
export type Cond = (typeof Cond)[keyof typeof Cond];
export type IrInst = ({
    kind: 'imm';
    dst: number;
    value: number;
} | {
    kind: 'immf';
    dst: number;
    value: number;
} | {
    kind: 'mov';
    dst: number;
    src: number;
} | {
    kind: 'binop';
    op: BinOp;
    dst: number;
    a: number;
    b: number;
} | {
    kind: 'convert';
    op: 'itod' | 'dtoi' | 'i8';
    dst: number;
    src: number;
} | {
    kind: 'addi';
    dst: number;
    a: number;
    imm: number;
} | {
    kind: 'ldb';
    dst: number;
    base: number;
    off: number;
} | {
    kind: 'stb';
    src: number;
    base: number;
    off: number;
} | {
    kind: 'ldw';
    dst: number;
    base: number;
    off: number;
} | {
    kind: 'stw';
    src: number;
    base: number;
    off: number;
} | {
    kind: 'ldd';
    dst: number;
    base: number;
    off: number;
} | {
    kind: 'std';
    src: number;
    base: number;
    off: number;
} | {
    kind: 'ldw_s';
    dst: number;
    base: number;
    index: number;
    scale: number;
    off: number;
} | {
    kind: 'stw_s';
    src: number;
    base: number;
    index: number;
    scale: number;
    off: number;
} | {
    kind: 'ldd_s';
    dst: number;
    base: number;
    index: number;
    scale: number;
    off: number;
} | {
    kind: 'std_s';
    src: number;
    base: number;
    index: number;
    scale: number;
    off: number;
} | {
    kind: 'label';
    name: string;
} | {
    kind: 'br';
    label: string;
} | {
    kind: 'brc';
    cond: Cond;
    a: number;
    b: number;
    label: string;
} | {
    kind: 'halt';
    src: number;
} | {
    kind: 'tid';
    dst: number;
} | {
    kind: 'ptid';
    dst: number;
} | {
    kind: 'pnthreads';
    dst: number;
} | {
    kind: 'nthreads';
    dst: number;
} | {
    kind: 'cstack_check';
    src: number;
    area: 'software' | 'park';
} | {
    kind: 'barrier';
} | {
    kind: 'call';
    label: string;
    saves?: number[];
    saveSpills?: number[];
} | {
    kind: 'ret';
} | {
    kind: 'icall';
    fn: number;
    saves?: number[];
    saveSpills?: number[];
} | {
    kind: 'labaddr';
    dst: number;
    label: string;
} | {
    kind: 'spill_load';
    dst: number;
    slot: number;
} | {
    kind: 'spill_store';
    src: number;
    slot: number;
}) & {
    origin?: 'semantic' | 'lowering' | 'runtime';
};
export interface DataBlob {
    addr: number;
    bytes: number[];
    words: number[];
    floats: number[];
}
export interface IrProgram {
    insts: IrInst[];
    data: DataBlob[];
    memSize: number;
}
export declare const VALID_MEMORY_SCALES: readonly [1, 2, 4, 8];
export declare function validateMemoryScale(scale: number): void;
export declare function validateProgram(prog: IrProgram): void;
export declare function virtUses(inst: IrInst): number[];
export declare function virtDef(inst: IrInst): number;
export declare function evalBin(op: BinOp, a: number, b: number): number;
export declare function evalCond(cond: Cond, a: number, b: number): boolean;
export declare function applyData(mem: ArrayBuffer, data: DataBlob[]): void;
export declare function checkMemoryAccess(operation: string, address: number, width: number, size: number): void;
export declare function interpretIr(prog: IrProgram, mem: ArrayBuffer): {
    value: number;
    steps: number;
    stdout: string;
};
export declare class IrBuilder {
    insts: IrInst[];
    data: DataBlob[];
    private nextVirt;
    private nextLab;
    reg(): number;
    ensureVirt(n: number): void;
    lab(prefix?: string): string;
    imm(value: number): number;
    immf(value: number): number;
    mov(src: number): number;
    movTo(dst: number, src: number): void;
    convert(op: 'itod' | 'dtoi' | 'i8', src: number): number;
    bin(op: BinOp, a: number, b: number): number;
    binTo(op: BinOp, dst: number, a: number, b: number): void;
    add(a: number, b: number): number;
    sub(a: number, b: number): number;
    mul(a: number, b: number): number;
    and(a: number, b: number): number;
    or(a: number, b: number): number;
    xor(a: number, b: number): number;
    shl(a: number, b: number): number;
    shr(a: number, b: number): number;
    addf(a: number, b: number): number;
    mulf(a: number, b: number): number;
    addTo(dst: number, a: number, b: number): void;
    subTo(dst: number, a: number, b: number): void;
    mulTo(dst: number, a: number, b: number): void;
    addfTo(dst: number, a: number, b: number): void;
    mulfTo(dst: number, a: number, b: number): void;
    addi(a: number, imm: number): number;
    addiTo(dst: number, a: number, imm: number): void;
    ldw(base: number, off?: number): number;
    stw(src: number, base: number, off?: number): void;
    ldb(base: number, off?: number): number;
    stb(src: number, base: number, off?: number): void;
    ldd(base: number, off?: number): number;
    std(src: number, base: number, off?: number): void;
    ldwS(base: number, index: number, scale?: number, off?: number): number;
    stwS(src: number, base: number, index: number, scale?: number, off?: number): void;
    lddS(base: number, index: number, scale?: number, off?: number): number;
    stdS(src: number, base: number, index: number, scale?: number, off?: number): void;
    label(name: string): void;
    br(label: string): void;
    brc(cond: Cond, a: number, b: number, label: string): void;
    beq(a: number, b: number, label: string): void;
    bne(a: number, b: number, label: string): void;
    blt(a: number, b: number, label: string): void;
    bge(a: number, b: number, label: string): void;
    halt(src: number): void;
    tid(): number;
    privateTid(): number;
    privateNthreads(): number;
    nthreads(): number;
    cstackCheck(src: number, area: 'software' | 'park'): void;
    barrier(): void;
    call(label: string): void;
    ret(): void;
    icall(fn: number): void;
    labaddr(label: string): number;
    words(addr: number, values: number[]): void;
    floats(addr: number, values: number[]): void;
    bytes(addr: number, values: number[]): void;
    program(): IrProgram;
}
export declare function parseIr(source: string): IrProgram;
export declare const SAMPLE_IR = "# Sum 0 .. N-1\nimm r0, 0          # i\nimm r1, 0          # acc\nimm r2, 256        # n\nimm r3, 1\nloop:\n  bge r0, r2, done\n  add r1, r1, r0\n  add r0, r0, r3\n  br loop\ndone:\n  halt r1\n";
//# sourceMappingURL=ir.d.ts.map