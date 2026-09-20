import { type HardwareProfile, type Metrics, type Program } from './types.ts';
export interface SimulateOpts {
    /** Cap on SPMD workers. Serial programs ignore this. */
    maxWorkers?: number;
}
export declare function simulate(program: Program, rawHw: HardwareProfile, mem: ArrayBuffer, opts?: SimulateOpts): Metrics;
//# sourceMappingURL=cpu.d.ts.map