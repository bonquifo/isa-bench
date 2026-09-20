import { type MeasurementContract } from './measurement.ts';
import { type IrProgram } from './ir.ts';
import { type HardwareProfile, type IsaId, type Metrics } from './types.ts';
import { type NRole, type ParallelSemantics, type ReferenceOracle } from './workloads.ts';
export type HardwareMode = 'same' | 'cpus';
export interface CompareInput {
    workloadId: string;
    n: number;
    seed: number;
    isas: IsaId[];
    hardwareMode: HardwareMode;
    profileId: string;
    customHw?: Partial<HardwareProfile>;
    customSource?: string;
    /** Saved fixed-C source used only for exact replay of a canned program. */
    effectiveSourceOverride?: string;
    /** Complete saved profiles take precedence over mutable profile/preset catalogs. */
    resolvedProfileByIsa?: Partial<Record<IsaId, HardwareProfile>>;
    /** Illustrative preset id per ISA. Used in `cpus` mode. */
    cpuByIsa?: Partial<Record<IsaId, string>>;
}
export type WorkloadKind = 'builtin-ir' | 'fixed-c' | 'custom-ir' | 'custom-c';
export interface WorkloadMetadata {
    kind: WorkloadKind;
    requestedN: number;
    effectiveN: number | null;
    nRole: NRole;
    requestedSeed: number;
    effectiveSeed: number | null;
    seedUsed: boolean;
    requestedWorkerCap: number | null;
    maxUsefulWorkers: number;
    parallelSemantics: ParallelSemantics;
    referenceOracle: ReferenceOracle;
    hasIndependentExpectedCheck: boolean;
}
export interface RerunInputSnapshot {
    workloadId: string;
    n: number;
    seed: number;
    isas: IsaId[];
    selectedIsas: IsaId[];
    customSource?: string;
    effectiveSource?: string;
    effectiveSourceOverride?: string;
    hardwareMode: HardwareMode;
    profileId: string;
    customHw?: Partial<HardwareProfile>;
    cpuByIsa?: Partial<Record<IsaId, string>>;
    resolvedCpuByIsa?: Partial<Record<IsaId, string>>;
    resolvedProfileByIsa: Partial<Record<IsaId, HardwareProfile>>;
}
export interface ResolvedHardwareSnapshot {
    isa: IsaId;
    profile: HardwareProfile;
}
export interface CompareResult {
    gold: number;
    fp: boolean;
    workloadId: string;
    workloadName: string;
    notes: string;
    hardwareMode: HardwareMode;
    n: number;
    seed: number;
    rows: Metrics[];
    goldSteps: number;
    stdout: string;
    source?: string;
    contract: MeasurementContract;
    workload: WorkloadMetadata;
    rerunInput: RerunInputSnapshot;
    inputFingerprint: string;
    resolvedHardware: ResolvedHardwareSnapshot[];
}
export interface JackProgress {
    ratio: number;
    phase: string;
    detail: string;
}
export declare function cloneMem(src: ArrayBuffer): ArrayBuffer;
export declare function hardwareFor(isa: IsaId, input: CompareInput): HardwareProfile;
export interface BuiltInput {
    ir: IrProgram;
    memory: ArrayBuffer;
    expected: number;
    fp: boolean;
    name: string;
    notes: string;
    maxWorkers: number;
    stdout: string;
    source?: string;
    workload: WorkloadMetadata;
}
export declare function buildInput(input: CompareInput): BuiltInput;
export declare function selectedIsas(input: CompareInput): IsaId[];
export declare function computeInputFingerprint(contract: MeasurementContract, rerunInput: RerunInputSnapshot, workload: WorkloadMetadata, resolvedHardware: ResolvedHardwareSnapshot[]): string;
export declare function runComparison(input: CompareInput): CompareResult;
export interface ComparisonAsyncOptions {
    signal?: AbortSignal;
    /** Keep the cyberpunk pacing in browser-only mode; server workers disable it. */
    cosmeticDelays?: boolean;
}
export declare function runComparisonAsync(input: CompareInput, onProgress: (p: JackProgress) => void, options?: ComparisonAsyncOptions): Promise<CompareResult>;
//# sourceMappingURL=compare.d.ts.map