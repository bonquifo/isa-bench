import { DEFAULT_OOO_PROFILE, OOO_MODEL_VERSION, type OoOProfile, type OoOTargetMetrics } from './ooo-types.ts';
import { type HardwareProfile, type Program } from './types.ts';
export interface SimulateOoOOptions {
    maxWorkers?: number;
    profile?: OoOProfile;
    /** Verification guard; production default is 80 million model cycles. */
    maxCycles?: number;
}
export declare function simulateOoO(program: Program, rawHardware: HardwareProfile, memory: ArrayBuffer, options?: SimulateOoOOptions): OoOTargetMetrics;
export { DEFAULT_OOO_PROFILE, OOO_MODEL_VERSION };
//# sourceMappingURL=ooo.d.ts.map