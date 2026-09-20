import { type IrProgram } from './ir.ts';
export declare const IR_REFERENCE_MODEL_VERSION = "ir-reference-2.0.0";
export interface IrReferenceResult {
    value: number;
    steps: number;
    stdout: string;
    modelVersion: typeof IR_REFERENCE_MODEL_VERSION;
    workers: number;
}
export declare function isParallelIr(prog: IrProgram): boolean;
/**
 * ISA-independent deterministic IR oracle. One runnable instruction is
 * executed per thread in fixed round-robin order each round. Memory is shared;
 * registers and call stacks are private. Barriers use the initial participant
 * set and release only after every participant reaches the same epoch.
 */
export declare function interpretIrWorkers(prog: IrProgram, mem: ArrayBuffer, requestedWorkers: number): IrReferenceResult;
//# sourceMappingURL=ir-reference.d.ts.map