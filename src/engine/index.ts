export {
  runComparison,
  runComparisonAsync,
  type CompareInput,
  type CompareResult,
  type ComparisonAsyncOptions,
  type HardwareMode,
  type JackProgress,
  type RerunInputSnapshot,
  type ResolvedHardwareSnapshot,
  type WorkloadKind,
  type WorkloadMetadata,
} from './compare.ts'
export {
  BACKEND_VERSION,
  ENERGY_MODEL_VERSION,
  FRONTEND_VERSION,
  MEASUREMENT_CLAIM_SCOPE,
  MEASUREMENT_CONTRACT,
  MEASUREMENT_MODEL_KIND,
  MEASUREMENT_MODEL_VERSION,
  MEASUREMENT_SCHEMA_VERSION,
  PROFILE_VERSION,
  fingerprint,
  encodeTaggedJson,
  decodeTaggedJson,
  parseTaggedJson,
  stablePrettySerialize,
  stableSerialize,
  type MeasurementContract,
} from './measurement.ts'
export {
  CPU_CATALOG,
  DEFAULT_CPU_ID,
  cpuById,
  cpusForIsa,
  defaultCpuByIsa,
  groupCpus,
  type CpuModel,
} from './cpus.ts'
export { DEFAULT_PROFILE_ID, HARDWARE_PROFILES, overlayCustom, profileById } from './hardware.ts'
export {
  ENERGY_MODEL_CLASS,
  ENERGY_UNCERTAINTY,
  NOMINAL_ENERGY_COEFFICIENTS,
  energyOf,
  type EnergyBreakdown,
} from './energy.ts'
export {
  C_EXAMPLES,
  GUEST_C_VERSION,
  SAMPLE_C,
  cExampleByWorkloadId,
  cWorkloadId,
  compileC,
  isCWorkload,
} from './c/compile_c.ts'
export { SAMPLE_IR, parseIr } from './ir.ts'
export { ALL_ISAS, ISA_META, IsaId, OperationOrigin } from './types.ts'
export type { HardwareProfile, Metrics } from './types.ts'
export {
  WORKLOADS,
  workloadById,
  type NRole,
  type ParallelSemantics,
  type ReferenceOracle,
  type WorkloadDef,
} from './workloads.ts'
export {
  runOoOComparison,
  runOoOComparisonAsync,
  type AnalyticalOoOEnvelope,
  type OoOCompareInput,
  type OoOResult,
} from './ooo-compare.ts'
export {
  DEFAULT_OOO_PROFILE,
  OOO_ENERGY_MODEL_VERSION,
  OOO_MODEL_VERSION,
  WIDTH_ONE_OOO_PROFILE,
  decodeProgram,
  validateOoOProfile,
  type DecodedOp,
  type OoOCounters,
  type OoOProfile,
  type OoOTargetMetrics,
} from './ooo-types.ts'
export { MemorySystem, type MemoryRequest, type MemoryCompletion } from './memory-system.ts'
export {
  IR_REFERENCE_MODEL_VERSION,
  interpretIrWorkers,
  isParallelIr,
  type IrReferenceResult,
} from './ir-reference.ts'
