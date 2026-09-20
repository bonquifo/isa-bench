/**
 * Versioned contract for deterministic educational measurements.
 *
 * These versions are intentionally independent: consumers can tell whether a
 * result changed because of its shape, model, compiler, profiles, or energy
 * accounting.
 */
export declare const MEASUREMENT_SCHEMA_VERSION = "3";
export declare const MEASUREMENT_MODEL_VERSION = "9";
export declare const FRONTEND_VERSION = "6";
export declare const BACKEND_VERSION = "5";
export declare const PROFILE_VERSION = "5";
export declare const ENERGY_MODEL_VERSION = "2";
export declare const MEASUREMENT_CLAIM_SCOPE: "software-model-only";
export declare const MEASUREMENT_MODEL_KIND: "deterministic-educational-model";
export interface MeasurementContract {
    schemaVersion: string;
    modelVersion: string;
    frontendVersion: string;
    backendVersion: string;
    profileVersion: string;
    energyVersion: string;
    claimScope: typeof MEASUREMENT_CLAIM_SCOPE;
    modelKind: typeof MEASUREMENT_MODEL_KIND;
}
export declare const MEASUREMENT_CONTRACT: Readonly<MeasurementContract>;
/** Encodes non-JSON IEEE-754 values as canonical reserved tag objects. */
export declare function encodeTaggedJson(value: unknown): unknown;
/** Decodes canonical IEEE-754 tags while leaving ordinary JSON unchanged. */
export declare function decodeTaggedJson(value: unknown): unknown;
/** Parses tagged or ordinary JSON. */
export declare function parseTaggedJson(text: string): unknown;
/** Deterministic compact tagged serialization with sorted object keys. */
export declare function stableSerialize(value: unknown): string;
/** Deterministic pretty tagged serialization with sorted object keys. */
export declare function stablePrettySerialize(value: unknown): string;
/**
 * Small deterministic, non-cryptographic FNV-1a fingerprint.
 * The name deliberately does not imply cryptographic integrity.
 */
export declare function fingerprint(value: unknown): string;
//# sourceMappingURL=measurement.d.ts.map