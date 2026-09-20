import { type IrProgram } from './ir.ts';
export interface BuiltWorkload {
    ir: IrProgram;
    memory: ArrayBuffer;
    expected: number;
    fp: boolean;
    notes: string;
    /** Useful SPMD width. Serial kernels stay 1. */
    maxWorkers: number;
}
export type NRole = 'problem-size' | 'worker-cap' | 'unused';
export type ParallelSemantics = 'serial' | 'spmd-striped' | 'source-defined';
export type ReferenceOracle = 'independent-host-model' | 'ir-interpreter';
export interface WorkloadDef {
    id: string;
    name: string;
    blurb: string;
    category: 'integer' | 'memory' | 'control' | 'fp' | 'mixed';
    defaultN: number;
    minN: number;
    maxN: number;
    nLabel: string;
    /** Whether changing the signed-i32 seed changes this workload. */
    usesSeed: boolean;
    nRole: 'problem-size';
    parallelSemantics: Exclude<ParallelSemantics, 'source-defined'>;
    referenceOracle: 'independent-host-model';
    hasIndependentExpectedCheck: true;
    build: (n: number, seed: number) => BuiltWorkload;
}
export declare const WORKLOADS: WorkloadDef[];
export declare function workloadById(id: string): WorkloadDef;
//# sourceMappingURL=workloads.d.ts.map