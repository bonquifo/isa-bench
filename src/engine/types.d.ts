export declare const IsaId: {
    readonly RISCV: "riscv";
    readonly ARM: "arm";
    readonly X86: "x86";
    readonly MIPS: "mips";
    readonly POWER: "power";
    readonly SPARC: "sparc";
    readonly WASM: "wasm";
    readonly MOS: "mos";
};
export type IsaId = (typeof IsaId)[keyof typeof IsaId];
export declare const ALL_ISAS: IsaId[];
export declare const ISA_META: Record<IsaId, {
    short: string;
    full: string;
    family: string;
    color: string;
}>;
export declare const InstClass: {
    readonly ALU: "alu";
    readonly MUL: "mul";
    readonly DIV: "div";
    readonly LD: "ld";
    readonly ST: "st";
    readonly BR: "br";
    readonly FP: "fp";
    readonly MOV: "mov";
    readonly NOP: "nop";
};
export type InstClass = (typeof InstClass)[keyof typeof InstClass];
export declare const OperationOrigin: {
    readonly SEMANTIC: "semantic";
    readonly LOWERING: "lowering";
    readonly RUNTIME: "runtime";
};
export type OperationOrigin = (typeof OperationOrigin)[keyof typeof OperationOrigin];
export declare const Opcode: {
    readonly LI: "li";
    readonly LIF: "lif";
    readonly MOV: "mov";
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
    readonly ADDI: "addi";
    readonly ADDF: "addf";
    readonly SUBF: "subf";
    readonly MULF: "mulf";
    readonly DIVF: "divf";
    readonly EQF: "eqf";
    readonly NEF: "nef";
    readonly LTF: "ltf";
    readonly GEF: "gef";
    readonly ITOD: "itod";
    readonly DTOI: "dtoi";
    readonly I8: "i8";
    readonly LDB: "ldb";
    readonly STB: "stb";
    readonly LDW: "ldw";
    readonly STW: "stw";
    readonly LDD: "ldd";
    readonly STD: "std";
    readonly BEQ: "beq";
    readonly BNE: "bne";
    readonly BLT: "blt";
    readonly BGE: "bge";
    readonly BR: "br";
    readonly HALT: "halt";
    readonly NOP: "nop";
    readonly TID: "tid";
    readonly PTID: "ptid";
    readonly PNTHREADS: "pnthreads";
    readonly NTHREADS: "nthreads";
    readonly CSTACK_CHECK: "cstack_check";
    readonly BARRIER: "barrier";
    readonly CALL: "call";
    readonly RET: "ret";
    readonly ICALL: "icall";
    readonly SPILL_LOAD: "spill_load";
    readonly SPILL_STORE: "spill_store";
};
export type Opcode = (typeof Opcode)[keyof typeof Opcode];
export interface MachInst {
    op: Opcode;
    mnemonic: string;
    bytes: number;
    dst: number;
    srcA: number;
    srcB: number;
    imm: number;
    memBase: number;
    memOff: number;
    memIndex: number;
    memScale: number;
    target: number;
    label: string;
    cls: InstClass;
    uops: number;
    readsMem: boolean;
    writesMem: boolean;
    addr: number;
    /** Conservative caller-live physical registers preserved by a call. */
    saveRegs?: number[];
    /** Caller-live private spill slots preserved by a call. */
    saveSpills?: number[];
    /** Non-register resources read when the instruction issues. */
    resourceReads: string[];
    /** Non-register resources written when the instruction completes. */
    resourceWrites: string[];
    /** Waits for all older operations in the thread and ends its issue group. */
    serializing: boolean;
    /** Why this dynamic modeled operation exists. */
    origin: OperationOrigin;
}
export interface CacheConfig {
    sizeBytes: number;
    lineBytes: number;
    ways: number;
}
export interface HardwareProfile {
    id: string;
    name: string;
    blurb: string;
    clockMhz: number;
    fetchWidth: number;
    issueWidth: number;
    pipelineStages: number;
    aluCount: number;
    memPorts: number;
    l1i: CacheConfig;
    l1d: CacheConfig;
    memLatency: number;
    predictor: 'none' | 'static' | 'bimodal' | 'gshare';
    predEntries: number;
    forwarding: boolean;
    mispredictPenalty: number;
    /** Fixed fetch redirect cost for an indirect call. */
    indirectCallPenalty: number;
    /** Perfect return-address-stack entries; deeper returns pay the redirect cost. */
    rasDepth: number;
    mulLatency: number;
    divLatency: number;
    fpAddLatency: number;
    fpMulLatency: number;
    fpDivLatency: number;
    loadLatency: number;
    complexDecodeBytes: number;
    /** Nominal static/leakage power in mW per modeled physical core. */
    staticPowerMw: number;
    /** Physical cores on the package. */
    cores: number;
    /** Logical hardware threads (cores × SMT, or P+E hybrid total). */
    threads: number;
    l2: CacheConfig;
    l3: CacheConfig;
    l2Latency: number;
    l3Latency: number;
    /** DRAM channels; extra misses beyond this pay a surcharge. */
    memChannels: number;
    /** Minimum cycles between line requests accepted by one DRAM channel. */
    dramIssueInterval: number;
    /** Fixed deterministic private-cache ownership transfer latency. */
    coherenceLatency: number;
}
export interface IsaTiming {
    /** Extra cycles charged after every issued instruction (CISC decode). */
    decodeOverhead: number;
    /** Extra cycles before a load result can be consumed (MIPS load delay). */
    loadDelay: number;
    /** Fixed bubble cycles after every control transfer; no delay-slot instruction executes. */
    branchDelay: number;
    /** Energy multiplier on decode / control. */
    decodeEnergy: number;
}
export interface Program {
    isa: IsaId;
    insts: MachInst[];
    codeBytes: number;
    spillSlots: number;
    physRegsUsed: number;
}
export interface Metrics {
    isa: IsaId;
    hardwareId: string;
    hardwareName: string;
    result: number;
    matchedGold: boolean;
    instructions: number;
    uops: number;
    cycles: number;
    cpi: number;
    ipc: number;
    /** completedOperations / global model cycles, aggregated across all workers. */
    aggregateModeledOpsPerCycle: number;
    /** global model cycles / completedOperations, aggregated across all workers. */
    modelCyclesPerAggregateOp: number;
    codeBytes: number;
    clockMhz: number;
    timeUs: number;
    icHits: number;
    icMisses: number;
    dcHits: number;
    dcMisses: number;
    branches: number;
    mispredicts: number;
    stalls: number;
    mix: Record<InstClass, number>;
    dynamicEnergyNj: number;
    staticEnergyNj: number;
    totalEnergyNj: number;
    edp: number;
    operationDecodeEnergyNj: number;
    cacheEnergyNj: number;
    memoryCoherenceEnergyNj: number;
    recoveryEnergyNj: number;
    nominalModelEnergyNj: number;
    modeledEdpNjUs: number;
    energyModelClass: 'uncalibrated-event-model';
    energyUncertainty: 'not-quantified';
    spillSlots: number;
    disasm: string[];
    cores: number;
    threads: number;
    activeThreads: number;
    busyCores: number;
    /** Physical cores that issued at least one operation during the run. */
    coresThatIssued: number;
    l2Hits: number;
    l2Misses: number;
    l3Hits: number;
    l3Misses: number;
    /** Guest printf / putchar capture. Empty for kernels that never write stdout. */
    stdout: string;
    /** Modeled operations accepted by issue. Legacy `instructions` is identical. */
    issuedOperations: number;
    /** Modeled operations whose completion point was reached. */
    completedOperations: number;
    issuedUops: number;
    completedUops: number;
    operationOrigins: Record<OperationOrigin, number>;
    zeroIssueCycles: number;
    dependencyStallCycles: number;
    fetchStallCycles: number;
    resourceStallCycles: number;
    memoryOrderStallCycles: number;
    serializationStallCycles: number;
    conditionalBranches: number;
    directJumps: number;
    calls: number;
    returns: number;
    indirectCalls: number;
    rasMisses: number;
    /** Dynamic encoded bytes accepted by fetch/decode. */
    fetchedBytes: number;
    decodedBytes: number;
    /** Per-line architectural cache lookups (retries are excluded). */
    icLineAccesses: number;
    dcLineAccesses: number;
    dramRequests: number;
    dramQueueCycles: number;
    coherenceTransfers: number;
    coherenceInvalidations: number;
    /** Per-core residency integrated over global model cycles. */
    activeCoreCycles: number;
    stalledCoreCycles: number;
    idleCoreCycles: number;
    averageActiveCores: number;
    averageStalledCores: number;
}
export declare const MEM_SIZE: number;
export declare const STACK_TOP = 524288;
export declare const DATA_BASE = 4096;
/** Scratch for SPMD reductions, padded to one modeled baseline cache line. */
export declare const PARTIAL_BASE = 499712;
export declare const PARTIAL_STRIDE = 64;
/** Word-per-char stdout: [len][c0][c1]… */
export declare const STDOUT_BASE = 393216;
export declare const STDOUT_MAX = 2048;
export declare const HEAP_BASE = 131072;
export declare const HEAP_PTR = 131064;
/** Guest C heap is bounded below stdout and never enters worker-private stacks. */
export declare const HEAP_LIMIT = 393216;
/** Guest-addressable C stacks: one validated 4 KiB region per hardware worker. */
export declare const C_STACK_BASE = 1048576;
export declare const C_STACK_STRIDE = 4096;
/** Lowest software-stack address; the lower bytes are reserved for expression parking. */
export declare const C_STACK_LIMIT_OFFSET = 512;
export declare const C_PARK_BYTES = 512;
export declare const C_STACK_USABLE_BYTES: number;
export declare const MAX_HW_THREADS = 256;
export declare const NONE = -1;
export declare function validateMemoryLayout(): void;
//# sourceMappingURL=types.d.ts.map