/**
 * The contract between a real-ISA interpreter and a timing model.
 *
 * Execution and timing are separated here, which is the whole point of this
 * layer. The engine's existing models fuse them — `simulate()` in
 * src/engine/cpu.ts and `simulateOoO()` in src/engine/ooo.ts each carry their
 * own copy of the semantics — so adding eight real instruction sets to a fused
 * design would mean sixteen places for a semantic bug to live rather than
 * eight plus two.
 *
 * Two halves, because a timing model needs both:
 *
 *   ProgramImage  static, addressed by byte address, decoded on demand. An
 *                 out-of-order model fetches down mispredicted paths that never
 *                 retire, so it needs instructions the trace will never mention.
 *   RetireChunk   dynamic, the instructions that actually retired, in order,
 *                 with the facts only execution knows: which way each branch
 *                 went, where each indirect jump landed, what address each
 *                 access touched.
 *
 * The trace streams in reusable chunks rather than materialising. A workload
 * of ten million instructions would otherwise be a few hundred megabytes of
 * arrays inside an Electron renderer.
 */
import type { InstClass, OperationOrigin } from '../../engine/types.ts'

export const NO_ADDRESS = -1n

/**
 * How an instruction reaches its successor, in the terms a timing model cares
 * about: whether to predict it, whether it pushes or pops a return-address
 * stack, and whether the target is known before execution.
 */
export const ControlKind = {
  SEQ: 'seq',
  COND: 'cond',
  JUMP: 'jump',
  CALL: 'call',
  RET: 'ret',
  INDIRECT: 'indirect',
  TRAP: 'trap',
} as const
export type ControlKind = (typeof ControlKind)[keyof typeof ControlKind]

/**
 * Which functional-unit latency applies. Named rather than numeric because
 * the number belongs to the hardware profile, not to the instruction, and the
 * engine already keeps those numbers in `HardwareProfile`.
 */
export const LatencyClass = {
  FIXED: 'fixed',
  MUL: 'mul',
  DIV: 'div',
  FP_ADD: 'fpAdd',
  FP_MUL: 'fpMul',
  FP_DIV: 'fpDiv',
  LOAD: 'load',
} as const
export type LatencyClass = (typeof LatencyClass)[keyof typeof LatencyClass]

/**
 * One statically decoded instruction, with no semantics attached.
 *
 * `reads` and `writes` are resolved architectural resource ids in a flat
 * per-ISA space. Resolving them here rather than in the timing model is what
 * lets one hazard model serve every ISA: SPARC's register windows and ARM's
 * predication are decided by the interpreter, and what reaches timing is
 * simply which registers this instruction touched.
 */
export interface StaticInst {
  readonly addr: bigint
  /** Real encoded length. 2 for a compressed instruction, not a nominal 4. */
  readonly bytes: number
  readonly mnemonic: string
  readonly cls: InstClass
  readonly latencyClass: LatencyClass
  readonly uops: number
  readonly reads: readonly number[]
  readonly writes: readonly number[]
  readonly control: ControlKind
  /** Byte address of a direct branch or jump target; NO_ADDRESS otherwise. */
  readonly staticTarget: bigint
  readonly readsMem: boolean
  readonly writesMem: boolean
  /** Bytes touched by the memory access, or 0 when there is none. */
  readonly accessWidth: number
  readonly serializing: boolean
  readonly origin: OperationOrigin
}

/** Names for the architectural resource ids used in `reads` and `writes`. */
export interface RegisterNaming {
  readonly count: number
  name(id: number): string
}

export interface ProgramImage {
  readonly isa: string
  readonly entry: bigint
  readonly naming: RegisterNaming
  /**
   * The instruction at `addr`, decoding it if this is the first request.
   * Throws for anything it cannot decode: this is the execution path, and a
   * silently skipped instruction is the failure mode this project exists to
   * avoid.
   */
  at(addr: bigint): StaticInst
  /**
   * As `at`, but yields null instead of throwing. For speculative walks only:
   * a mispredicted fetch can legitimately run into bytes that are not
   * instructions, and a timing model must be able to model that without the
   * run failing.
   */
  speculativeAt(addr: bigint): StaticInst | null
  /** Total bytes of loaded executable image, for the code-size metric. */
  readonly codeBytes: number
}

/**
 * A run of retired instructions, as parallel arrays. Reused between calls, so
 * a consumer must finish with a chunk before asking for the next one.
 */
export interface RetireChunk {
  /** How many entries of each array are valid. */
  count: number
  readonly pc: BigInt64Array
  /** Where control actually went; covers indirect targets and taken branches. */
  readonly nextPc: BigInt64Array
  /** Effective address of the memory access, meaningless when width is 0. */
  readonly effAddr: BigInt64Array
  readonly accessWidth: Uint8Array
  /** 1 when a conditional branch was taken. */
  readonly taken: Uint8Array
}

export function createRetireChunk(capacity: number): RetireChunk {
  return {
    count: 0,
    pc: new BigInt64Array(capacity),
    nextPc: new BigInt64Array(capacity),
    effAddr: new BigInt64Array(capacity),
    accessWidth: new Uint8Array(capacity),
    taken: new Uint8Array(capacity),
  }
}

/** Why a `run` call stopped. */
export const RunState = {
  /** The chunk filled; there is more to execute. */
  MORE: 'more',
  /** The guest exited. `exitCode` is set. */
  EXITED: 'exited',
} as const
export type RunState = (typeof RunState)[keyof typeof RunState]

/** Final architectural state, the unit of differential comparison. */
export interface ArchState {
  /** General-purpose registers, architectural order. */
  readonly gpr: readonly bigint[]
  /** Floating-point registers as raw bit patterns, never as values. */
  readonly fpr: readonly bigint[]
  /** Named status registers: fcsr on RISC-V, NZCV on AArch64, and so on. */
  readonly status: Readonly<Record<string, bigint>>
  readonly pc: bigint
}

export interface Interpreter {
  readonly image: ProgramImage
  /** Fills `into` with up to `into.pc.length` retired instructions. */
  run(into: RetireChunk): RunState
  /** Valid once `run` has returned EXITED. */
  finalState(): ArchState
  /** Bytes the guest wrote to fd 1. */
  stdout(): Uint8Array
  readonly exitCode: number
  /** Total instructions retired so far. */
  readonly retired: number
}
