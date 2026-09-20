import { type CompareInput, type ComparisonAsyncOptions, type JackProgress, type WorkloadMetadata } from './compare.ts';
import { IR_REFERENCE_MODEL_VERSION } from './ir-reference.ts';
import { OOO_MODEL_VERSION, type OoOProfile, type OoOTargetMetrics } from './ooo-types.ts';
export interface OoOCompareInput extends CompareInput {
    oooProfile?: OoOProfile;
}
export interface AnalyticalOoOEnvelope {
    schemaVersion: '0.1.0';
    modelVersion: typeof OOO_MODEL_VERSION;
    referenceModelVersion: typeof IR_REFERENCE_MODEL_VERSION;
    adapterVersion: '1.0.0';
    experimentKind: 'analytical-ooo';
    claimClass: 'analytical-estimate';
    evidenceClass: 'model-output';
    inputIdentity: string;
    artifactIdentities: string[];
    comparisonGroupKey: string;
    comparison: {
        experimentKind: 'analytical-ooo';
        modelVersion: typeof OOO_MODEL_VERSION;
        workloadSemanticHash: string;
        artifactPipelineHash: string;
        roiDefinitionHash: string;
        profileConfigFingerprint: string;
        metricDomain: 'analytical-model-cycles';
        unit: 'model-cycle';
    };
    createdAt: string;
    metrics: {
        name: string;
        domain: 'analytical-model-cycles' | 'analytical-model-nj';
        unit: string;
        value: number;
    }[];
    modelPayload: OoOTargetMetrics;
}
export interface OoOResult {
    modelVersion: typeof OOO_MODEL_VERSION;
    referenceModelVersion: typeof IR_REFERENCE_MODEL_VERSION;
    modelKind: 'deterministic-isa-inspired-decoded-op-ooo';
    claimScope: 'analytical-model-only';
    profile: OoOProfile;
    gold: number;
    fp: boolean;
    stdout: string;
    workloadId: string;
    workloadName: string;
    workload: WorkloadMetadata;
    rows: OoOTargetMetrics[];
    envelopes: AnalyticalOoOEnvelope[];
}
export declare function runOoOComparison(input: OoOCompareInput): OoOResult;
export declare function runOoOComparisonAsync(input: OoOCompareInput, onProgress: (progress: JackProgress) => void, options?: ComparisonAsyncOptions): Promise<OoOResult>;
//# sourceMappingURL=ooo-compare.d.ts.map