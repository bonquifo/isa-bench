export const IsaId = {
    RISCV: 'riscv',
    ARM: 'arm',
    X86: 'x86',
    MIPS: 'mips',
    POWER: 'power',
    SPARC: 'sparc',
    WASM: 'wasm',
    MOS: 'mos',
};
export const ALL_ISAS = [
    IsaId.RISCV,
    IsaId.ARM,
    IsaId.X86,
    IsaId.MIPS,
    IsaId.POWER,
    IsaId.SPARC,
    IsaId.WASM,
    IsaId.MOS,
];
export const ISA_META = {
    riscv: {
        short: 'RISC-V-style',
        full: 'RISC-V-style pseudo-backend',
        family: 'RISC-like subset with modeled FP pseudo-ops',
        color: '#ff6b2b',
    },
    arm: {
        short: 'AArch64-like',
        full: 'AArch64-like pseudo-backend',
        family: 'RISC-like subset, shifted addressing',
        color: '#00f0ff',
    },
    x86: {
        short: 'x86-64-style',
        full: 'x86-64-style pseudo-backend',
        family: 'CISC-like subset, variable modeled length',
        color: '#ff2bd6',
    },
    mips: {
        short: 'MIPS32-like',
        full: 'MIPS32-like pseudo-backend',
        family: 'RISC-like subset, modeled load delay',
        color: '#c8ff3d',
    },
    power: {
        short: 'POWER-like',
        full: 'PowerPC/POWER-like pseudo-backend',
        family: 'RISC-like subset, indexed loads',
        color: '#ffb020',
    },
    sparc: {
        short: 'SPARC V8-like',
        full: 'SPARC V8-like pseudo-backend',
        family: 'RISC-like subset, fixed 1-cycle control-transfer bubble (no executed slot)',
        color: '#7aa2ff',
    },
    wasm: {
        short: 'WebAssembly-like',
        full: 'WebAssembly-like pseudo-backend',
        family: 'Stack-machine subset, modeled LEB encodings',
        color: '#62e6c0',
    },
    mos: {
        short: '6502-style',
        full: 'MOS 6502-style pseudo-backend',
        family: 'Accumulator-style subset, modeled byte lengths',
        color: '#ff5c8a',
    },
};
export const InstClass = {
    ALU: 'alu',
    MUL: 'mul',
    DIV: 'div',
    LD: 'ld',
    ST: 'st',
    BR: 'br',
    FP: 'fp',
    MOV: 'mov',
    NOP: 'nop',
};
export const OperationOrigin = {
    SEMANTIC: 'semantic',
    LOWERING: 'lowering',
    RUNTIME: 'runtime',
};
export const Opcode = {
    LI: 'li',
    LIF: 'lif',
    MOV: 'mov',
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
    ADDI: 'addi',
    ADDF: 'addf',
    SUBF: 'subf',
    MULF: 'mulf',
    DIVF: 'divf',
    EQF: 'eqf',
    NEF: 'nef',
    LTF: 'ltf',
    GEF: 'gef',
    ITOD: 'itod',
    DTOI: 'dtoi',
    I8: 'i8',
    LDB: 'ldb',
    STB: 'stb',
    LDW: 'ldw',
    STW: 'stw',
    LDD: 'ldd',
    STD: 'std',
    BEQ: 'beq',
    BNE: 'bne',
    BLT: 'blt',
    BGE: 'bge',
    BR: 'br',
    HALT: 'halt',
    NOP: 'nop',
    TID: 'tid',
    PTID: 'ptid',
    PNTHREADS: 'pnthreads',
    NTHREADS: 'nthreads',
    CSTACK_CHECK: 'cstack_check',
    BARRIER: 'barrier',
    CALL: 'call',
    RET: 'ret',
    ICALL: 'icall',
    SPILL_LOAD: 'spill_load',
    SPILL_STORE: 'spill_store',
};
export const MEM_SIZE = 2 << 20;
export const STACK_TOP = 0x80000;
export const DATA_BASE = 0x1000;
/** Scratch for SPMD reductions, padded to one modeled baseline cache line. */
export const PARTIAL_BASE = 0x7a000;
export const PARTIAL_STRIDE = 64;
/** Word-per-char stdout: [len][c0][c1]… */
export const STDOUT_BASE = 0x60000;
export const STDOUT_MAX = 2048;
export const HEAP_BASE = 0x20000;
export const HEAP_PTR = 0x1fff8;
/** Guest C heap is bounded below stdout and never enters worker-private stacks. */
export const HEAP_LIMIT = STDOUT_BASE;
/** Guest-addressable C stacks: one validated 4 KiB region per hardware worker. */
export const C_STACK_BASE = 0x100000;
export const C_STACK_STRIDE = 0x1000;
/** Lowest software-stack address; the lower bytes are reserved for expression parking. */
export const C_STACK_LIMIT_OFFSET = 0x200;
export const C_PARK_BYTES = 0x200;
export const C_STACK_USABLE_BYTES = C_STACK_STRIDE - C_STACK_LIMIT_OFFSET;
export const MAX_HW_THREADS = 256;
export const NONE = -1;
export function validateMemoryLayout() {
    const stdoutEnd = STDOUT_BASE + 4 + STDOUT_MAX * 4;
    const partialEnd = PARTIAL_BASE + MAX_HW_THREADS * PARTIAL_STRIDE;
    const cStacksEnd = C_STACK_BASE + MAX_HW_THREADS * C_STACK_STRIDE;
    if (!(DATA_BASE < HEAP_PTR && HEAP_PTR < HEAP_BASE && HEAP_BASE < HEAP_LIMIT && HEAP_LIMIT <= STDOUT_BASE)) {
        throw new Error('Invalid data/heap/stdout memory ordering');
    }
    if (stdoutEnd > PARTIAL_BASE || partialEnd > STACK_TOP || STACK_TOP > C_STACK_BASE || cStacksEnd > MEM_SIZE) {
        throw new Error('Guest memory regions overlap or exceed MEM_SIZE');
    }
    if (C_PARK_BYTES !== C_STACK_LIMIT_OFFSET || C_PARK_BYTES <= 0 || C_PARK_BYTES >= C_STACK_STRIDE) {
        throw new Error('Invalid Guest C park-stack reservation');
    }
}
validateMemoryLayout();
//# sourceMappingURL=types.js.map