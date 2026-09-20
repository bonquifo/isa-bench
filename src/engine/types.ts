export const IsaId = {
  RISCV: 'riscv',
  ARM: 'arm',
  X86: 'x86',
  MIPS: 'mips',
  POWER: 'power',
  SPARC: 'sparc',
  WASM: 'wasm',
  MOS: 'mos',
} as const
export type IsaId = (typeof IsaId)[keyof typeof IsaId]

export const ALL_ISAS: IsaId[] = [
  IsaId.RISCV,
  IsaId.ARM,
  IsaId.X86,
  IsaId.MIPS,
  IsaId.POWER,
  IsaId.SPARC,
  IsaId.WASM,
  IsaId.MOS,
]

export const ISA_META: Record<
  IsaId,
  { short: string; full: string; family: string; color: string }
> = {
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
}

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
} as const
export type InstClass = (typeof InstClass)[keyof typeof InstClass]

export const OperationOrigin = {
  SEMANTIC: 'semantic',
  LOWERING: 'lowering',
  RUNTIME: 'runtime',
} as const
export type OperationOrigin = (typeof OperationOrigin)[keyof typeof OperationOrigin]

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
} as const
export type Opcode = (typeof Opcode)[keyof typeof Opcode]

export interface MachInst {
  op: Opcode
  mnemonic: string
  bytes: number
  dst: number
  srcA: number
  srcB: number
  imm: number
  memBase: number
  memOff: number
  memIndex: number
  memScale: number
  target: number
  label: string
  cls: InstClass
  uops: number
  readsMem: boolean
  writesMem: boolean
  addr: number
  /** Conservative caller-live physical registers preserved by a call. */
  saveRegs?: number[]
  /** Caller-live private spill slots preserved by a call. */
  saveSpills?: number[]
  /** Non-register resources read when the instruction issues. */
  resourceReads: string[]
  /** Non-register resources written when the instruction completes. */
  resourceWrites: string[]
  /** Waits for all older operations in the thread and ends its issue group. */
  serializing: boolean
  /** Why this dynamic modeled operation exists. */
  origin: OperationOrigin
}

export interface CacheConfig {
  sizeBytes: number
  lineBytes: number
  ways: number
}

export interface HardwareProfile {
  id: string
  name: string
  blurb: string
  clockMhz: number
  fetchWidth: number
  issueWidth: number
  pipelineStages: number
  aluCount: number
  memPorts: number
  l1i: CacheConfig
  l1d: CacheConfig
  memLatency: number
  predictor: 'none' | 'static' | 'bimodal' | 'gshare'
  predEntries: number
  forwarding: boolean
  mispredictPenalty: number
  /** Fixed fetch redirect cost for an indirect call. */
  indirectCallPenalty: number
  /** Perfect return-address-stack entries; deeper returns pay the redirect cost. */
  rasDepth: number
  mulLatency: number
  divLatency: number
  fpAddLatency: number
  fpMulLatency: number
  fpDivLatency: number
  loadLatency: number
  complexDecodeBytes: number
  /** Nominal static/leakage power in mW per modeled physical core. */
  staticPowerMw: number
  /** Physical cores on the package. */
  cores: number
  /** Logical hardware threads (cores × SMT, or P+E hybrid total). */
  threads: number
  l2: CacheConfig
  l3: CacheConfig
  l2Latency: number
  l3Latency: number
  /** DRAM channels; extra misses beyond this pay a surcharge. */
  memChannels: number
  /** Minimum cycles between line requests accepted by one DRAM channel. */
  dramIssueInterval: number
  /** Fixed deterministic private-cache ownership transfer latency. */
  coherenceLatency: number
}

export interface IsaTiming {
  /** Extra cycles charged after every issued instruction (CISC decode). */
  decodeOverhead: number
  /** Extra cycles before a load result can be consumed (MIPS load delay). */
  loadDelay: number
  /** Fixed bubble cycles after every control transfer; no delay-slot instruction executes. */
  branchDelay: number
  /** Energy multiplier on decode / control. */
  decodeEnergy: number
}

export interface Program {
  isa: IsaId
  insts: MachInst[]
  codeBytes: number
  spillSlots: number
  physRegsUsed: number
}

export interface Metrics {
  isa: IsaId
  hardwareId: string
  hardwareName: string
  result: number
  matchedGold: boolean
  instructions: number
  uops: number
  cycles: number
  cpi: number
  ipc: number
  /** completedOperations / global model cycles, aggregated across all workers. */
  aggregateModeledOpsPerCycle: number
  /** global model cycles / completedOperations, aggregated across all workers. */
  modelCyclesPerAggregateOp: number
  codeBytes: number
  clockMhz: number
  timeUs: number
  icHits: number
  icMisses: number
  dcHits: number
  dcMisses: number
  branches: number
  mispredicts: number
  stalls: number
  mix: Record<InstClass, number>
  dynamicEnergyNj: number
  staticEnergyNj: number
  totalEnergyNj: number
  edp: number
  operationDecodeEnergyNj: number
  cacheEnergyNj: number
  memoryCoherenceEnergyNj: number
  recoveryEnergyNj: number
  nominalModelEnergyNj: number
  modeledEdpNjUs: number
  energyModelClass: 'uncalibrated-event-model'
  energyUncertainty: 'not-quantified'
  spillSlots: number
  disasm: string[]
  cores: number
  threads: number
  activeThreads: number
  busyCores: number
  /** Physical cores that issued at least one operation during the run. */
  coresThatIssued: number
  l2Hits: number
  l2Misses: number
  l3Hits: number
  l3Misses: number
  /** Guest printf / putchar capture. Empty for kernels that never write stdout. */
  stdout: string
  /** Modeled operations accepted by issue. Legacy `instructions` is identical. */
  issuedOperations: number
  /** Modeled operations whose completion point was reached. */
  completedOperations: number
  issuedUops: number
  completedUops: number
  operationOrigins: Record<OperationOrigin, number>
  zeroIssueCycles: number
  dependencyStallCycles: number
  fetchStallCycles: number
  resourceStallCycles: number
  memoryOrderStallCycles: number
  serializationStallCycles: number
  conditionalBranches: number
  directJumps: number
  calls: number
  returns: number
  indirectCalls: number
  rasMisses: number
  /** Dynamic encoded bytes accepted by fetch/decode. */
  fetchedBytes: number
  decodedBytes: number
  /** Per-line architectural cache lookups (retries are excluded). */
  icLineAccesses: number
  dcLineAccesses: number
  dramRequests: number
  dramQueueCycles: number
  coherenceTransfers: number
  coherenceInvalidations: number
  /** Per-core residency integrated over global model cycles. */
  activeCoreCycles: number
  stalledCoreCycles: number
  idleCoreCycles: number
  averageActiveCores: number
  averageStalledCores: number
}

export const MEM_SIZE = 2 << 20
export const STACK_TOP = 0x80000
export const DATA_BASE = 0x1000
/** Scratch for SPMD reductions, padded to one modeled baseline cache line. */
export const PARTIAL_BASE = 0x7a000
export const PARTIAL_STRIDE = 64
/** Word-per-char stdout: [len][c0][c1]… */
export const STDOUT_BASE = 0x60000
export const STDOUT_MAX = 2048
export const HEAP_BASE = 0x20000
export const HEAP_PTR = 0x1fff8
/** Guest C heap is bounded below stdout and never enters worker-private stacks. */
export const HEAP_LIMIT = STDOUT_BASE
/** Guest-addressable C stacks: one validated 4 KiB region per hardware worker. */
export const C_STACK_BASE = 0x100000
export const C_STACK_STRIDE = 0x1000
/** Lowest software-stack address; the lower bytes are reserved for expression parking. */
export const C_STACK_LIMIT_OFFSET = 0x200
export const C_PARK_BYTES = 0x200
export const C_STACK_USABLE_BYTES = C_STACK_STRIDE - C_STACK_LIMIT_OFFSET
export const MAX_HW_THREADS = 256
export const NONE = -1

export function validateMemoryLayout(): void {
  const stdoutEnd = STDOUT_BASE + 4 + STDOUT_MAX * 4
  const partialEnd = PARTIAL_BASE + MAX_HW_THREADS * PARTIAL_STRIDE
  const cStacksEnd = C_STACK_BASE + MAX_HW_THREADS * C_STACK_STRIDE
  if (!(DATA_BASE < HEAP_PTR && HEAP_PTR < HEAP_BASE && HEAP_BASE < HEAP_LIMIT && HEAP_LIMIT <= STDOUT_BASE)) {
    throw new Error('Invalid data/heap/stdout memory ordering')
  }
  if (stdoutEnd > PARTIAL_BASE || partialEnd > STACK_TOP || STACK_TOP > C_STACK_BASE || cStacksEnd > MEM_SIZE) {
    throw new Error('Guest memory regions overlap or exceed MEM_SIZE')
  }
  if (C_PARK_BYTES !== C_STACK_LIMIT_OFFSET || C_PARK_BYTES <= 0 || C_PARK_BYTES >= C_STACK_STRIDE) {
    throw new Error('Invalid Guest C park-stack reservation')
  }
}

validateMemoryLayout()
