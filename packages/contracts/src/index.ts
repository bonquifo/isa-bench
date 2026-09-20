import { z } from 'zod'
export * from './empirical-schedule.js'

export const CONTRACTS_VERSION = '0.1.0' as const

const HASH_RE = /^[a-f0-9]{64}$/
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/
const SIGNED_DECIMAL_RE = /^-?(0|[1-9][0-9]*)$/
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const Sha256Schema = z.string().regex(HASH_RE, 'expected lowercase SHA-256 hex')
export const DecimalStringSchema = z.string().regex(DECIMAL_RE, 'expected unsigned decimal integer')
export const SignedDecimalStringSchema = z.string().regex(SIGNED_DECIMAL_RE, 'expected decimal integer')
export const TimestampSchema = z.string().datetime({ offset: true })
export const VersionSchema = z.string().regex(VERSION_RE)
export const IdentifierSchema = z.string().regex(ID_RE)
export const FiniteNumberSchema = z.number().finite()
export const NonNegativeFiniteSchema = FiniteNumberSchema.nonnegative()
export const PositiveFiniteSchema = FiniteNumberSchema.positive()
export const SafeIntegerSchema = z.number().int().safe()
export const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/)

const EmpiricalTargetSchema = z.strictObject({
  isa: z.string().min(1).max(64),
  os: z.string().min(1).max(64),
  abi: z.string().min(1).max(128),
})
const EmpiricalBinarySchema = z.strictObject({
  corpusId: z.string().min(1).max(256),
  sha256: Sha256Schema,
  size: DecimalStringSchema.refine((value) => value !== '0'),
  eligible: z.literal(true),
})
const EmpiricalThresholdsSchema = z.strictObject({
  maxTemperatureC: FiniteNumberSchema.optional(),
  maxPmuMultiplexRatio: FiniteNumberSchema.min(0).max(1).optional(),
  maxClockUncertaintyNs: SafeIntegerSchema.nonnegative().optional(),
})
const EmpiricalAdapterNameSchema = z.enum(['wall-clock', 'linux-perf', 'rapl-powercap', 'rapl-perf', 'ina', 'external', 'null'])
export const EmpiricalAdapterSchema = z.string().refine((value) => {
  const normalized = value.startsWith('optional:') ? value.slice('optional:'.length) : value
  return EmpiricalAdapterNameSchema.safeParse(normalized).success
}, 'unknown empirical adapter')
export function parseEmpiricalAdapter(value: string): { name: z.infer<typeof EmpiricalAdapterNameSchema>; required: boolean } {
  EmpiricalAdapterSchema.parse(value)
  const required = !value.startsWith('optional:')
  return { name: (required ? value : value.slice('optional:'.length)) as z.infer<typeof EmpiricalAdapterNameSchema>, required }
}
export const EmpiricalJobTemplateSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  testOnly: z.boolean(),
  jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  target: EmpiricalTargetSchema,
  binary: EmpiricalBinarySchema,
  argv: z.array(z.string().max(4096)).max(256),
  repetitions: SafeIntegerSchema.min(32).max(10_000).refine((value) => value % 4 === 0, 'repetitions must be divisible by four').default(32),
  warmups: SafeIntegerSchema.min(0).max(1_000).default(5),
  seed: z.string().min(1).max(256),
  controls: z.record(z.string(), z.union([z.string().max(256), z.boolean()])),
  adapters: z.array(EmpiricalAdapterSchema).max(64).refine((values) => new Set(values.map((value) => parseEmpiricalAdapter(value).name)).size === values.length, 'duplicate normalized adapter'),
  thresholds: EmpiricalThresholdsSchema,
})
export const EmpiricalJobSpecSchema = EmpiricalJobTemplateSchema.extend({
  leaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  runnerId: z.string().regex(/^runner:[a-f0-9]{64}$/),
  sequence: DecimalStringSchema.refine((value) => value !== '0'),
  nonce: Base64Schema.refine((value) => {
    try { return decodeCanonicalBase64(value, 32).byteLength === 32 } catch { return false }
  }),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  leaseExpiresAt: TimestampSchema,
})
export type EmpiricalJobTemplate = z.infer<typeof EmpiricalJobTemplateSchema>
export type EmpiricalJobSpec = z.infer<typeof EmpiricalJobSpecSchema>

export type Sha256 = z.infer<typeof Sha256Schema>
export type DecimalString = z.infer<typeof DecimalStringSchema>

export const ExperimentKindSchema = z.enum([
  'analytical-inorder',
  'analytical-ooo',
  'toolchain-validation',
  'gem5',
  'llvm-mca',
  'champsim',
  'empirical-measurement',
  'calibrated-prediction',
])
export type ExperimentKind = z.infer<typeof ExperimentKindSchema>

export const ClaimClassSchema = z.enum([
  'analytical-estimate',
  'static-throughput-estimate',
  'functional-toolchain-validation',
  'external-simulation',
  'empirical-observation',
  'calibrated-prediction',
])
export const EvidenceClassSchema = z.enum([
  'model-output',
  'generated-code',
  'external-simulator-output',
  'raw-measurement',
  'aggregated-measurement',
  'calibration-fit',
])
export type ClaimClass = z.infer<typeof ClaimClassSchema>
export type EvidenceClass = z.infer<typeof EvidenceClassSchema>

const capabilityReason = z.string().trim().min(1).max(1024)
export const CapabilityTierSchema = z.discriminatedUnion('tier', [
  z.strictObject({ tier: z.literal('execute'), reason: capabilityReason }),
  z.strictObject({ tier: z.literal('codegen-only'), reason: capabilityReason }),
  z.strictObject({ tier: z.literal('unsupported'), reason: capabilityReason }),
])
export type CapabilityTier = z.infer<typeof CapabilityTierSchema>

export const AvailableValueSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('availability', [
    z.strictObject({ availability: z.literal('available'), value }),
    z.strictObject({ availability: z.literal('unavailable'), reason: capabilityReason }),
  ])

export const ArtifactRoleSchema = z.enum([
  'source',
  'binary',
  'object',
  'assembly',
  'config',
  'profile',
  'trace',
  'log',
  'result',
  'raw-sample',
  'dataset',
  'report',
  'other',
])
export const ArtifactDescriptorSchema = z.strictObject({
  id: Sha256Schema,
  sha256: Sha256Schema,
  byteSize: DecimalStringSchema,
  mimeType: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/),
  role: ArtifactRoleSchema,
  filename: z.string().min(1).max(512).optional(),
}).superRefine((value, ctx) => {
  if (value.id !== value.sha256) {
    ctx.addIssue({ code: 'custom', path: ['id'], message: 'artifact id must equal sha256' })
  }
})
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>

export const ToolProvenanceSchema = z.strictObject({
  name: z.string().min(1).max(128),
  version: VersionSchema,
  executableSha256: Sha256Schema.optional(),
  invocation: z.array(z.string().max(8192)).max(1024),
})
export const ImageProvenanceSchema = z.strictObject({
  imageReference: z.string().min(1).max(1024),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
})
export const BuildProvenanceSchema = z.strictObject({
  buildId: IdentifierSchema,
  sourceRevision: z.string().min(1).max(256),
  sourceDirty: z.boolean(),
  tools: z.array(ToolProvenanceSchema).min(1),
  image: ImageProvenanceSchema.optional(),
  commandDigest: Sha256Schema,
  environmentDigest: Sha256Schema,
})
export type BuildProvenance = z.infer<typeof BuildProvenanceSchema>

export const EndiannessSchema = z.enum(['little', 'big'])
export const TargetSchema = z.strictObject({
  triple: z.string().regex(/^[A-Za-z0-9_.+-]+-[A-Za-z0-9_.+-]+(?:-[A-Za-z0-9_.+-]+){0,2}$/),
  abi: z.string().min(1).max(128),
  endianness: EndiannessSchema,
  addressWidth: z.union([z.literal(16), z.literal(32), z.literal(64), z.literal(128)]),
})
export type Target = z.infer<typeof TargetSchema>

export const MetricDomainSchema = z.enum([
  'physical-time-ns',
  'physical-energy-j',
  'analytical-model-cycles',
  'analytical-model-nj',
  'external-simulator-cycles',
  'external-simulator-ticks',
  'external-simulator-count',
  'external-simulator-ratio',
  'external-simulator-rate',
  'static-throughput-cycles-per-instruction',
  'static-throughput-cycles',
  'static-throughput-count',
  'static-throughput-width',
  'static-throughput-pressure',
  'functional-validation-status',
])
export type MetricDomain = z.infer<typeof MetricDomainSchema>

type Brand<T, B extends string> = T & { readonly __brand: B }
export type PhysicalNanoseconds = Brand<number, 'physical-time-ns'>
export type PhysicalJoules = Brand<number, 'physical-energy-j'>
export type AnalyticalModelCycles = Brand<number, 'analytical-model-cycles'>
export type AnalyticalModelNanojoules = Brand<number, 'analytical-model-nj'>
export type ExternalSimulatorCycles = Brand<DecimalString, 'external-simulator-cycles'>
export type StaticThroughputCpi = Brand<number, 'static-throughput-cycles-per-instruction'>

const metricUnits: Record<MetricDomain, string> = {
  'physical-time-ns': 'ns',
  'physical-energy-j': 'J',
  'analytical-model-cycles': 'model-cycle',
  'analytical-model-nj': 'model-nJ',
  'external-simulator-cycles': 'sim-cycle',
  'external-simulator-ticks': 'sim-tick',
  'external-simulator-count': 'count',
  'external-simulator-ratio': 'ratio',
  'external-simulator-rate': 'sim-instructions/s',
  'static-throughput-cycles-per-instruction': 'cycles/instruction',
  'static-throughput-cycles': 'static-cycle',
  'static-throughput-count': 'count',
  'static-throughput-width': 'instructions/cycle',
  'static-throughput-pressure': 'resource-cycles/iteration',
  'functional-validation-status': 'outcome',
}

export const MetricSchema = z.strictObject({
  name: IdentifierSchema,
  domain: MetricDomainSchema,
  unit: z.string().min(1).max(64),
  value: z.union([FiniteNumberSchema, DecimalStringSchema]),
}).superRefine((metric, ctx) => {
  if (metric.unit !== metricUnits[metric.domain]) {
    ctx.addIssue({ code: 'custom', path: ['unit'], message: `unit must be ${metricUnits[metric.domain]}` })
  }
  if (['external-simulator-cycles', 'external-simulator-ticks', 'external-simulator-count', 'static-throughput-cycles', 'static-throughput-count'].includes(metric.domain) &&
      typeof metric.value !== 'string') {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'counter metrics must be decimal strings' })
  }
  if (!['external-simulator-cycles', 'external-simulator-ticks', 'external-simulator-count', 'static-throughput-cycles', 'static-throughput-count'].includes(metric.domain) &&
      typeof metric.value !== 'number') {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'this metric domain requires a finite number' })
  }
})
export type Metric = z.infer<typeof MetricSchema>

export const ComparisonDimensionsSchema = z.strictObject({
  experimentKind: ExperimentKindSchema,
  modelVersion: VersionSchema,
  workloadSemanticHash: Sha256Schema,
  artifactPipelineHash: Sha256Schema,
  roiDefinitionHash: Sha256Schema,
  profileConfigFingerprint: Sha256Schema,
  metricDomain: MetricDomainSchema,
  unit: z.string().min(1).max(64),
}).superRefine((value, ctx) => {
  if (value.unit !== metricUnits[value.metricDomain]) {
    ctx.addIssue({ code: 'custom', path: ['unit'], message: `unit must be ${metricUnits[value.metricDomain]}` })
  }
})
export type ComparisonDimensions = z.infer<typeof ComparisonDimensionsSchema>

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

const IEEE_TAG = '$isaSimIeee754'
const IeeeTagSchema = z.strictObject({
  [IEEE_TAG]: z.enum(['NaN', '+Infinity', '-Infinity', '-0']),
})
export const TaggedJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.string(),
  z.number().finite(),
  IeeeTagSchema,
  z.array(TaggedJsonValueSchema),
  z.record(z.string(), TaggedJsonValueSchema),
]))
export const IeeeJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.string(),
  z.custom<number>((value) => typeof value === 'number'),
  z.array(IeeeJsonValueSchema),
  z.record(z.string(), IeeeJsonValueSchema),
]))

function ieeeTag(value: number): 'NaN' | '+Infinity' | '-Infinity' | '-0' | null {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return '+Infinity'
  if (value === -Infinity) return '-Infinity'
  if (Object.is(value, -0)) return '-0'
  return null
}

/** Canonical tagged JSON used at every REST/SSE/database/artifact boundary. */
export function encodeTaggedJson(value: unknown): unknown {
  if (typeof value === 'number') {
    const tag = ieeeTag(value)
    return tag ? { [IEEE_TAG]: tag } : value
  }
  if (Array.isArray(value)) return value.map(encodeTaggedJson)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = encodeTaggedJson(source[key])
    }
    return result
  }
  return value
}

export function decodeTaggedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeTaggedJson)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const keys = Object.keys(source)
    if (keys.length === 1 && keys[0] === IEEE_TAG) {
      const tag = source[IEEE_TAG]
      if (tag === 'NaN') return Number.NaN
      if (tag === '+Infinity') return Infinity
      if (tag === '-Infinity') return -Infinity
      if (tag === '-0') return -0
      throw new TypeError('invalid IEEE-754 tag')
    }
    return Object.fromEntries(keys.map((key) => [key, decodeTaggedJson(source[key])]))
  }
  return value
}

export function taggedJsonStringify(value: unknown): string {
  const encoded = encodeTaggedJson(value)
  TaggedJsonValueSchema.parse(encoded)
  return JSON.stringify(encoded)
}

export function taggedJsonParse(text: string): unknown {
  const encoded = TaggedJsonValueSchema.parse(JSON.parse(text) as unknown)
  return decodeTaggedJson(encoded)
}

function canonicalize(value: JsonValue, stack: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError('canonical JSON rejects unsafe integers; use decimal strings')
    }
    if (Object.is(value, -0)) return '0'
    return JSON.stringify(value)
  }
  if (stack.has(value)) throw new TypeError('canonical JSON rejects cyclic values')
  stack.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError('canonical JSON rejects sparse arrays')
      }
      return `[${value.map((item) => canonicalize(item, stack)).join(',')}]`
    }
    const object = value as { readonly [key: string]: JsonValue }
    const keys = Object.keys(object).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(object[key] as JsonValue, stack)}`).join(',')}}`
  } finally {
    stack.delete(value)
  }
}

export function canonicalJson(value: JsonValue): string {
  return canonicalize(value, new Set())
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Bytes(data: BufferSource): Promise<Sha256> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Sha256Schema.parse(bytesToHex(new Uint8Array(digest)))
}

export async function sha256Utf8(text: string): Promise<Sha256> {
  return sha256Bytes(new TextEncoder().encode(text))
}

export async function sha256Canonical(value: JsonValue): Promise<Sha256> {
  return sha256Utf8(canonicalJson(value))
}

export async function buildComparisonGroupKey(dimensions: ComparisonDimensions): Promise<Sha256> {
  const parsed = ComparisonDimensionsSchema.parse(dimensions)
  return sha256Canonical(parsed)
}

export const EvidenceProofSchema = z.strictObject({
  signatureVerified: z.literal(true).optional(),
  signatureVerifier: IdentifierSchema.optional(),
  signatureIdentityHash: Sha256Schema.optional(),
  attestationVerified: z.literal(true).optional(),
  attestationType: IdentifierSchema.optional(),
  attestationVerifier: IdentifierSchema.optional(),
  attestationEvidenceHash: Sha256Schema.optional(),
}).superRefine((proof, ctx) => {
  const signatureFields = [proof.signatureVerifier, proof.signatureIdentityHash]
  if (proof.signatureVerified === true && signatureFields.some((value) => value === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'verified signature requires verifier and identity hash' })
  }
  if (proof.signatureVerified !== true && signatureFields.some((value) => value !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'signature proof fields require signatureVerified=true' })
  }
  const attestationFields = [proof.attestationType, proof.attestationVerifier, proof.attestationEvidenceHash]
  if (proof.attestationVerified === true && attestationFields.some((value) => value === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'verified attestation requires type, verifier, and evidence hash' })
  }
  if (proof.attestationVerified !== true && attestationFields.some((value) => value !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'attestation proof fields require attestationVerified=true' })
  }
})

const commonResultShape = {
  schemaVersion: VersionSchema,
  modelVersion: VersionSchema,
  adapterVersion: VersionSchema,
  experimentKind: ExperimentKindSchema,
  claimClass: ClaimClassSchema,
  evidenceClass: EvidenceClassSchema,
  inputIdentity: Sha256Schema,
  artifactIdentities: z.array(Sha256Schema),
  comparisonGroupKey: Sha256Schema,
  comparison: ComparisonDimensionsSchema,
  createdAt: TimestampSchema,
  proof: EvidenceProofSchema.optional(),
} as const

export const AnalyticalOoOResultSchema = z.strictObject({
  ...commonResultShape,
  experimentKind: z.literal('analytical-ooo'),
  claimClass: z.literal('analytical-estimate'),
  evidenceClass: z.literal('model-output'),
  referenceModelVersion: VersionSchema.optional(),
  metrics: z.array(MetricSchema).min(1),
  modelPayload: z.unknown(),
}).superRefine((result, ctx) => {
  result.metrics.forEach((metric, index) => {
    if (!['analytical-model-cycles', 'analytical-model-nj'].includes(metric.domain)) {
      ctx.addIssue({ code: 'custom', path: ['metrics', index, 'domain'], message: 'analytical result requires a model metric domain' })
    }
  })
})

export const AnalyticalInOrderResultSchema = z.strictObject({
  ...commonResultShape,
  experimentKind: z.literal('analytical-inorder'),
  claimClass: z.literal('analytical-estimate'),
  evidenceClass: z.literal('model-output'),
  metrics: z.array(MetricSchema).min(1),
  compareResult: z.unknown(),
}).superRefine((result, ctx) => {
  result.metrics.forEach((metric, index) => {
    if (!['analytical-model-cycles', 'analytical-model-nj'].includes(metric.domain)) {
      ctx.addIssue({ code: 'custom', path: ['metrics', index, 'domain'], message: 'analytical result requires a model metric domain' })
    }
  })
})

export const ToolchainValidationResultSchema = z.strictObject({
  ...commonResultShape,
  experimentKind: z.literal('toolchain-validation'),
  claimClass: z.literal('functional-toolchain-validation'),
  evidenceClass: z.literal('generated-code'),
  target: TargetSchema,
  build: BuildProvenanceSchema,
  validationStatus: z.enum(['passed', 'failed', 'not-executed']),
  diagnostics: z.array(z.string().max(8192)),
})

export const ExternalSimulatorResultSchema = z.strictObject({
  ...commonResultShape,
  experimentKind: z.enum(['gem5', 'llvm-mca', 'champsim']),
  claimClass: z.union([z.literal('external-simulation'), z.literal('static-throughput-estimate')]),
  evidenceClass: z.literal('external-simulator-output'),
  simulator: ToolProvenanceSchema,
  metrics: z.array(MetricSchema).min(1),
  rawOutputArtifact: ArtifactDescriptorSchema,
  target: TargetSchema.optional(),
  build: BuildProvenanceSchema.optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
  normalized: z.record(z.string(), z.unknown()).optional(),
  diagnostics: z.array(z.string().max(8192)).optional(),
}).superRefine((result, ctx) => {
  const expectedClaim = result.experimentKind === 'llvm-mca' ? 'static-throughput-estimate' : 'external-simulation'
  const expectedPrefix = result.experimentKind === 'llvm-mca' ? 'static-throughput-' : 'external-simulator-'
  if (result.claimClass !== expectedClaim) {
    ctx.addIssue({ code: 'custom', path: ['claimClass'], message: `${result.experimentKind} requires ${expectedClaim}` })
  }
  result.metrics.forEach((metric, index) => {
    if (!metric.domain.startsWith(expectedPrefix)) {
      ctx.addIssue({ code: 'custom', path: ['metrics', index, 'domain'], message: `${result.experimentKind} requires a ${expectedPrefix} metric domain` })
    }
  })
})

export const EmpiricalResultSchema = z.strictObject({
  ...commonResultShape,
  experimentKind: z.literal('empirical-measurement'),
  claimClass: z.literal('empirical-observation'),
  evidenceClass: z.enum(['raw-measurement', 'aggregated-measurement']),
  measurementBundleId: Sha256Schema,
  sampleCount: DecimalStringSchema,
  metrics: z.array(MetricSchema).min(1),
}).superRefine((result, ctx) => {
  result.metrics.forEach((metric, index) => {
    if (!['physical-time-ns', 'physical-energy-j'].includes(metric.domain)) {
      ctx.addIssue({ code: 'custom', path: ['metrics', index, 'domain'], message: 'empirical result requires a physical metric domain' })
    }
  })
})

export const CalibratedPredictionResultSchema = z.strictObject({
  ...commonResultShape,
  experimentKind: z.literal('calibrated-prediction'),
  claimClass: z.literal('calibrated-prediction'),
  evidenceClass: z.literal('calibration-fit'),
  calibrationId: Sha256Schema,
  datasetId: Sha256Schema.optional(),
  modelHash: Sha256Schema.optional(),
  applicability: z.strictObject({
    workloadId: IdentifierSchema,
    target: IdentifierSchema,
    modelVersion: VersionSchema,
    profileId: IdentifierSchema,
    simulatorVersion: VersionSchema,
    toolchainHash: Sha256Schema,
    corpusId: z.string().min(1).max(256),
    roiDefinitionHash: Sha256Schema,
    workloadSemanticHash: Sha256Schema,
    extrapolated: z.literal(false),
  }).optional(),
  metrics: z.array(MetricSchema).min(1),
  uncertainty: z.strictObject({
    method: z.string().min(1).max(128),
    confidenceLevel: FiniteNumberSchema.gt(0).lt(1),
    calibrationSampleCount: z.number().int().positive(),
    calibrationHash: Sha256Schema,
    lower: FiniteNumberSchema,
    upper: FiniteNumberSchema,
    unit: z.string().min(1).max(64),
    interval50: z.strictObject({ lower: FiniteNumberSchema, upper: FiniteNumberSchema }).optional(),
    interval95: z.strictObject({ lower: FiniteNumberSchema, upper: FiniteNumberSchema }).optional(),
    components: z.record(z.string(), NonNegativeFiniteSchema).optional(),
  }).refine((value) => value.lower <= value.upper, { message: 'lower must not exceed upper' }),
}).superRefine((result, ctx) => {
  result.metrics.forEach((metric, index) => {
    if (!['physical-time-ns', 'physical-energy-j'].includes(metric.domain)) {
      ctx.addIssue({ code: 'custom', path: ['metrics', index, 'domain'], message: 'calibrated prediction requires a physical metric domain' })
    }
  })
})

export const ResultEnvelopeSchema = z.union([
  AnalyticalInOrderResultSchema,
  AnalyticalOoOResultSchema,
  ToolchainValidationResultSchema,
  ExternalSimulatorResultSchema,
  EmpiricalResultSchema,
  CalibratedPredictionResultSchema,
])
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>

export async function assertResultIdentity(result: ResultEnvelope): Promise<void> {
  const parsed = ResultEnvelopeSchema.parse(result)
  const expected = await buildComparisonGroupKey(parsed.comparison)
  if (parsed.comparisonGroupKey !== expected) {
    throw new Error('comparisonGroupKey does not match canonical comparison dimensions')
  }
  if (parsed.experimentKind !== parsed.comparison.experimentKind) {
    throw new Error('result experimentKind differs from comparison dimensions')
  }
}

const comparisonKeys = [
  'experimentKind',
  'modelVersion',
  'workloadSemanticHash',
  'artifactPipelineHash',
  'roiDefinitionHash',
  'profileConfigFingerprint',
  'metricDomain',
  'unit',
] as const

export function assertComparable(
  values: readonly (ResultEnvelope | ComparisonDimensions)[],
): asserts values is readonly (ResultEnvelope | ComparisonDimensions)[] {
  if (values.length < 2) return
  for (const value of values) {
    if ('comparison' in value) {
      if (value.experimentKind !== value.comparison.experimentKind) {
        throw new Error('results are not comparable; result experimentKind differs from comparison dimensions')
      }
      if (value.modelVersion !== value.comparison.modelVersion) {
        throw new Error('results are not comparable; result modelVersion differs from comparison dimensions')
      }
    }
  }
  const dimensions = values.map((value) => 'comparison' in value ? value.comparison : value)
  dimensions.forEach((value) => ComparisonDimensionsSchema.parse(value))
  const first = dimensions[0]
  if (!first) return
  const mismatches = comparisonKeys.filter((key) =>
    dimensions.some((candidate) => candidate[key] !== first[key]),
  )
  if (mismatches.length > 0) {
    throw new Error(`results are not comparable; mismatched ${mismatches.join(', ')}`)
  }
  const groupKeys = values.flatMap((value) => 'comparisonGroupKey' in value ? [value.comparisonGroupKey] : [])
  if (new Set(groupKeys).size > 1) {
    throw new Error('results are not comparable; mismatched comparisonGroupKey')
  }
}

export const JobStateSchema = z.enum([
  'queued',
  'assigned',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
])
export type JobState = z.infer<typeof JobStateSchema>

const transitionTable: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['assigned', 'cancelled'],
  assigned: ['queued', 'running', 'cancelled'],
  running: ['cancelling', 'succeeded', 'failed'],
  cancelling: ['cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export const JobTransitionSchema = z.strictObject({
  jobId: IdentifierSchema,
  sequence: DecimalStringSchema,
  from: JobStateSchema,
  to: JobStateSchema,
  at: TimestampSchema,
  reason: z.string().min(1).max(2048),
}).superRefine((transition, ctx) => {
  if (!transitionTable[transition.from].includes(transition.to)) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: `invalid ${transition.from} -> ${transition.to} transition` })
  }
})

export const JobCreateRequestSchema = z.strictObject({
  requestId: IdentifierSchema,
  experimentKind: ExperimentKindSchema,
  inputArtifact: ArtifactDescriptorSchema,
  requestedCapability: z.enum(['execute', 'codegen-only']),
  target: TargetSchema,
  parameters: z.record(z.string(), z.union([z.string(), FiniteNumberSchema, z.boolean(), z.null()])),
})

const eventBase = {
  jobId: IdentifierSchema,
  sequence: DecimalStringSchema,
  at: TimestampSchema,
} as const
export const JobEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventBase, type: z.literal('progress'), fraction: FiniteNumberSchema.min(0).max(1), phase: z.string().min(1), detail: z.string() }),
  z.strictObject({ ...eventBase, type: z.literal('log'), level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string().max(65536) }),
  z.strictObject({ ...eventBase, type: z.literal('artifact'), artifact: ArtifactDescriptorSchema }),
  z.strictObject({ ...eventBase, type: z.literal('partial'), payload: z.record(z.string(), z.unknown()) }),
  z.strictObject({ ...eventBase, type: z.literal('done'), result: ResultEnvelopeSchema }),
  z.strictObject({ ...eventBase, type: z.literal('error'), code: IdentifierSchema, message: z.string().min(1), retryable: z.boolean() }),
  z.strictObject({ ...eventBase, type: z.literal('cancelled'), reason: z.string().min(1) }),
])
export type JobEvent = z.infer<typeof JobEventSchema>

export const DurableJobSchema = z.strictObject({
  id: IdentifierSchema,
  state: JobStateSchema,
  revision: DecimalStringSchema,
  request: JobCreateRequestSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  assignedRunnerId: IdentifierSchema.optional(),
  terminalResultArtifactId: Sha256Schema.optional(),
}).superRefine((job, ctx) => {
  if (['assigned', 'running', 'cancelling'].includes(job.state) && !job.assignedRunnerId) {
    ctx.addIssue({ code: 'custom', path: ['assignedRunnerId'], message: 'active job requires an assigned runner' })
  }
  if (job.state === 'succeeded' && !job.terminalResultArtifactId) {
    ctx.addIssue({ code: 'custom', path: ['terminalResultArtifactId'], message: 'succeeded job requires result artifact' })
  }
})

export const ServerJobLaneV1Schema = z.enum([
  'analytical-inorder',
  'analytical-ooo',
  'toolchain-validation',
  'gem5',
  'llvm-mca',
  'champsim',
])
export const PublicServerJobLaneV1Schema = z.enum([
  'analytical-inorder',
  'analytical-ooo',
  'gem5',
  'llvm-mca',
  'champsim',
])
export const ServerJobRequestV1Schema = z.strictObject({
  schemaVersion: z.literal('server-job-request-v1'),
  lane: ServerJobLaneV1Schema,
  input: IeeeJsonValueSchema,
  timeoutMs: z.number().int().safe().min(100).max(1_800_000).optional(),
})
export const PublicServerJobCreateV1Schema = z.strictObject({
  lane: PublicServerJobLaneV1Schema.default('analytical-inorder'),
  input: TaggedJsonValueSchema,
  timeoutMs: z.number().int().safe().min(100).max(1_800_000).optional(),
})
export const ToolchainPreparedPayloadV1Schema = z.strictObject({
  canonicalIr: z.string().min(1).max(2 * 1024 * 1024),
  targets: z.array(z.enum([
    'x86_64-linux', 'aarch64-linux', 'riscv64-linux', 'mipsel-o32',
    'powerpc64le-elfv2', 'sparc-v8', 'wasm32-wasip1', 'mos-sim',
  ])).min(1).max(8),
  memoryBytes: z.number().int().safe().min(0).max(64 * 1024 * 1024),
  emitterVersion: VersionSchema,
  expectedFrame: z.strictObject({
    kind: z.enum(['i32', 'binary64']),
    rawBits: z.string().regex(/^[a-f0-9]{16}$/),
    stdoutBase64: Base64Schema.max(16 * 1024),
  }),
})
export const ToolchainPreparedDescriptorV1Schema = z.strictObject({
  schemaVersion: z.literal('toolchain-prepared-v1'),
  payload: ToolchainPreparedPayloadV1Schema,
  payloadSha256: Sha256Schema,
})
export const ServerJobErrorV1Schema = z.strictObject({
  code: IdentifierSchema,
  message: z.string().min(1).max(8192),
  interrupted: z.boolean().optional(),
})
export const ServerJobRecordV1Schema = z.strictObject({
  schemaVersion: z.literal('server-job-v1'),
  id: IdentifierSchema,
  state: JobStateSchema,
  revision: DecimalStringSchema,
  request: ServerJobRequestV1Schema,
  progress: FiniteNumberSchema.min(0).max(1),
  error: ServerJobErrorV1Schema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  assignedRunnerId: IdentifierSchema.optional(),
  terminalResultArtifactId: Sha256Schema.optional(),
}).superRefine((job, ctx) => {
  if (['assigned', 'running', 'cancelling'].includes(job.state) && !job.assignedRunnerId) {
    ctx.addIssue({ code: 'custom', path: ['assignedRunnerId'], message: 'active job requires assigned runner' })
  }
  if (job.state === 'succeeded' && !job.terminalResultArtifactId) {
    ctx.addIssue({ code: 'custom', path: ['terminalResultArtifactId'], message: 'success requires result artifact' })
  }
})
const serverEventBase = {
  schemaVersion: z.literal('server-job-event-v1'),
  id: DecimalStringSchema,
  jobId: IdentifierSchema,
  revision: DecimalStringSchema,
  at: TimestampSchema,
} as const
export const ServerJobEventV1Schema = z.discriminatedUnion('type', [
  z.strictObject({ ...serverEventBase, type: z.literal('state'), from: JobStateSchema.nullable(), to: JobStateSchema, reason: z.string().min(1).max(2048) }),
  z.strictObject({ ...serverEventBase, type: z.literal('progress'), fraction: FiniteNumberSchema.min(0).max(1), phase: IdentifierSchema, detail: z.string().max(8192) }),
  z.strictObject({ ...serverEventBase, type: z.literal('log'), level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string().max(65536), artifact: ArtifactDescriptorSchema.optional() }),
  z.strictObject({ ...serverEventBase, type: z.literal('artifact'), artifact: ArtifactDescriptorSchema }),
  z.strictObject({ ...serverEventBase, type: z.literal('done'), resultArtifactId: Sha256Schema }),
  z.strictObject({ ...serverEventBase, type: z.literal('error'), error: ServerJobErrorV1Schema }),
  z.strictObject({ ...serverEventBase, type: z.literal('cancelled'), reason: z.string().min(1).max(2048) }),
])
export type ServerJobRequestV1 = z.infer<typeof ServerJobRequestV1Schema>
export type ServerJobRecordV1 = z.infer<typeof ServerJobRecordV1Schema>
export type ServerJobEventV1 = z.infer<typeof ServerJobEventV1Schema>

const WorkerAnalyticalPayloadV1Schema = z.record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length > 0, 'analytical worker result must not be empty')
export const ToolchainTargetObservationV1Schema = z.strictObject({
  tier: z.enum(['execute', 'codegen-only', 'unsupported']),
  reason: z.string().min(1).max(8192),
  command: z.array(z.string()).optional(),
  commands: z.array(z.array(z.string())).optional(),
  log: z.string().max(65536).optional(),
  objectBytes: z.number().int().safe().nonnegative().optional(),
  runtimeBytes: z.number().int().safe().nonnegative().optional(),
  artifactIdentities: z.array(Sha256Schema).optional(),
})
export const ToolchainWorkerResultV1Schema = z.strictObject({
  lane: z.literal('toolchain-validation'),
  claim: z.literal('functional toolchain validation only; no performance claim'),
  emitterVersion: VersionSchema,
  descriptorSha256: Sha256Schema,
  targets: z.record(z.string(), ToolchainTargetObservationV1Schema),
  envelopes: z.array(ToolchainValidationResultSchema).min(1),
})

export const WorkerToServerMessageV1Schema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('progress'), progress: z.strictObject({
    ratio: FiniteNumberSchema.min(0).max(1),
    phase: IdentifierSchema,
    detail: z.string().max(8192),
  }) }),
  z.strictObject({
    type: z.literal('artifact'),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  }),
  z.strictObject({
    type: z.literal('result'),
    lane: ServerJobLaneV1Schema,
    result: z.union([
      ToolchainWorkerResultV1Schema,
      ExternalSimulatorResultSchema,
      WorkerAnalyticalPayloadV1Schema,
    ]),
  }),
  z.strictObject({ type: z.literal('error'), error: ServerJobErrorV1Schema }),
  z.strictObject({ type: z.literal('cancelled'), reason: z.string().min(1).max(2048) }),
])

export const RunnerIdentitySchema = z.strictObject({
  runnerId: IdentifierSchema,
  publicKey: Base64Schema,
  keyId: IdentifierSchema,
  issuedAt: TimestampSchema,
})
export const RunnerEnrollmentSchema = z.strictObject({
  enrollmentId: IdentifierSchema,
  runner: RunnerIdentitySchema,
  challenge: Base64Schema,
  requestedAt: TimestampSchema,
  attestationArtifact: ArtifactDescriptorSchema.optional(),
})
export const RunnerCapabilitySchema = z.strictObject({
  runnerId: IdentifierSchema,
  observedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  targets: z.array(TargetSchema).min(1),
  experiments: z.record(ExperimentKindSchema, CapabilityTierSchema),
  sensors: z.array(IdentifierSchema),
}).refine((value) => Date.parse(value.expiresAt) > Date.parse(value.observedAt), {
  path: ['expiresAt'],
  message: 'capabilities must expire after observation',
})
export const RunnerJobSchema = z.strictObject({
  job: DurableJobSchema,
  leaseId: IdentifierSchema,
  leaseExpiresAt: TimestampSchema,
  nonce: Base64Schema,
})

export const SensorSchema = z.strictObject({
  sensorId: IdentifierSchema,
  kind: z.enum(['power', 'energy', 'temperature', 'frequency', 'clock', 'other']),
  model: z.string().min(1).max(256),
  unit: z.string().min(1).max(64),
  calibrationArtifactId: Sha256Schema.optional(),
  resolution: PositiveFiniteSchema,
})
export const PerfCounterSchema = z.strictObject({
  name: IdentifierSchema,
  value: DecimalStringSchema,
  timeEnabledNs: DecimalStringSchema,
  timeRunningNs: DecimalStringSchema,
  multiplexed: z.boolean(),
}).superRefine((counter, ctx) => {
  if (BigInt(counter.timeRunningNs) > BigInt(counter.timeEnabledNs)) {
    ctx.addIssue({ code: 'custom', path: ['timeRunningNs'], message: 'running time exceeds enabled time' })
  }
})
export const EnvironmentSchema = z.strictObject({
  capturedAt: TimestampSchema,
  os: z.string().min(1).max(256),
  kernel: z.string().min(1).max(256),
  cpuModel: z.string().min(1).max(512),
  logicalCpuCount: SafeIntegerSchema.positive(),
  memoryBytes: DecimalStringSchema,
  governor: z.string().min(1).max(128).optional(),
  containerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  fingerprint: Sha256Schema,
})
export const RawSampleSchema = z.strictObject({
  sampleId: IdentifierSchema,
  startedAtUnixNs: DecimalStringSchema,
  durationNs: DecimalStringSchema,
  iterationCount: DecimalStringSchema,
  metrics: z.array(MetricSchema).min(1),
  perfCounters: z.array(PerfCounterSchema),
  sensorReadings: z.array(z.strictObject({
    sensorId: IdentifierSchema,
    timestampUnixNs: DecimalStringSchema,
    value: FiniteNumberSchema,
  })),
})
export const MeasurementBundleSchema = z.strictObject({
  bundleId: Sha256Schema,
  jobId: IdentifierSchema,
  runner: RunnerIdentitySchema,
  schemaVersion: VersionSchema,
  adapterVersion: VersionSchema,
  experimentKind: z.literal('empirical-measurement'),
  inputIdentity: Sha256Schema,
  artifactIdentities: z.array(Sha256Schema),
  target: TargetSchema,
  environment: EnvironmentSchema,
  sensors: z.array(SensorSchema),
  samples: z.array(RawSampleSchema).min(1),
  createdAt: TimestampSchema,
})

export const DatasetSplitSchema = z.strictObject({
  datasetArtifactId: Sha256Schema,
  strategy: z.enum(['random', 'grouped', 'temporal', 'leave-one-target-out']),
  seed: DecimalStringSchema,
  trainingIds: z.array(IdentifierSchema),
  selectionIds: z.array(IdentifierSchema),
  conformalIds: z.array(IdentifierSchema),
  holdoutIds: z.array(IdentifierSchema),
}).superRefine((split, ctx) => {
  const all = [...split.trainingIds, ...split.selectionIds, ...split.conformalIds, ...split.holdoutIds]
  if (new Set(all).size !== all.length) {
    ctx.addIssue({ code: 'custom', message: 'dataset split IDs must be disjoint' })
  }
})
export const CalibrationSchema = z.strictObject({
  calibrationId: Sha256Schema,
  method: z.string().min(1).max(256),
  modelVersion: VersionSchema,
  datasetSplit: DatasetSplitSchema,
  featureSchemaHash: Sha256Schema,
  parameterArtifactId: Sha256Schema,
  fittedAt: TimestampSchema,
})
export const EvaluationSchema = z.strictObject({
  calibrationId: Sha256Schema,
  split: z.enum(['selection', 'conformal', 'holdout']),
  metrics: z.array(z.strictObject({
    name: IdentifierSchema,
    value: FiniteNumberSchema,
    unit: z.string().min(1).max(64),
  })).min(1),
  sampleCount: DecimalStringSchema,
})
export const ApplicabilitySchema = z.strictObject({
  supportedTargets: z.array(TargetSchema).min(1),
  workloadSemanticClasses: z.array(IdentifierSchema).min(1),
  excludedConditions: z.array(z.string().min(1)),
  minFeatureValues: z.record(IdentifierSchema, FiniteNumberSchema),
  maxFeatureValues: z.record(IdentifierSchema, FiniteNumberSchema),
}).superRefine((value, ctx) => {
  for (const [feature, minimum] of Object.entries(value.minFeatureValues)) {
    const maximum = value.maxFeatureValues[feature]
    if (maximum !== undefined && minimum > maximum) {
      ctx.addIssue({ code: 'custom', path: ['minFeatureValues', feature], message: 'minimum exceeds maximum' })
    }
  }
})
export const UncertaintySchema = z.strictObject({
  method: z.enum(['bootstrap', 'conformal', 'posterior', 'analytical']),
  confidenceLevel: FiniteNumberSchema.gt(0).lt(1),
  lower: FiniteNumberSchema,
  upper: FiniteNumberSchema,
  unit: z.string().min(1).max(64),
  sampleCount: DecimalStringSchema.optional(),
}).refine((value) => value.lower <= value.upper, { message: 'lower must not exceed upper' })

export const SignedEnvelopeSchema = <T extends z.ZodType>(payload: T) => z.strictObject({
  algorithm: z.literal('Ed25519'),
  keyId: IdentifierSchema,
  payload,
  signature: Base64Schema,
  signedAt: TimestampSchema,
})
export const SignedRunnerIdentitySchema = SignedEnvelopeSchema(RunnerIdentitySchema)
export const SignedRunnerEnrollmentSchema = SignedEnvelopeSchema(RunnerEnrollmentSchema)
export const SignedRunnerCapabilitySchema = SignedEnvelopeSchema(RunnerCapabilitySchema)
export const SignedRunnerJobSchema = SignedEnvelopeSchema(RunnerJobSchema)
export const SignedMeasurementBundleSchema = SignedEnvelopeSchema(MeasurementBundleSchema)
export const SignedRawSampleSchema = SignedEnvelopeSchema(RawSampleSchema)
export const SignedSensorSchema = SignedEnvelopeSchema(SensorSchema)
export const SignedPerfCounterSchema = SignedEnvelopeSchema(PerfCounterSchema)
export const SignedEnvironmentSchema = SignedEnvelopeSchema(EnvironmentSchema)
export type SignedEnvelope<T extends JsonValue> = {
  readonly algorithm: 'Ed25519'
  readonly keyId: string
  readonly payload: T
  readonly signature: string
  readonly signedAt: string
}

export interface SignaturePayload<T extends JsonValue> {
  readonly protected: {
    readonly algorithm: 'Ed25519'
    readonly keyId: string
    readonly signedAt: string
  }
  readonly payload: T
}

export function createSignaturePayload<T extends JsonValue>(
  envelope: Pick<SignedEnvelope<T>, 'algorithm' | 'keyId' | 'payload' | 'signedAt'>,
): Uint8Array {
  const value: JsonValue = {
    protected: {
      algorithm: envelope.algorithm,
      keyId: envelope.keyId,
      signedAt: TimestampSchema.parse(envelope.signedAt),
    },
    payload: envelope.payload,
  }
  return new TextEncoder().encode(canonicalJson(value))
}

export const SIGNATURE_PROFILE = 'isa-sim-ed25519-canonical-json-v1' as const

export function decodeCanonicalBase64(value: string, expectedBytes?: number): Uint8Array {
  Base64Schema.parse(value)
  if (value.length % 4 !== 0) throw new Error('base64 must include canonical padding')
  const decoded = decodeBase64(value)
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} decoded bytes`)
  }
  let encoded = ''
  if (typeof globalThis.btoa === 'function') {
    encoded = globalThis.btoa(String.fromCharCode(...decoded))
  } else {
    throw new Error('base64 encoding is unavailable in this runtime')
  }
  if (encoded !== value) throw new Error('non-canonical base64')
  return decoded
}

function decodeBase64(value: string): Uint8Array {
  Base64Schema.parse(value)
  if (typeof globalThis.atob === 'function') {
    return Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0))
  }
  throw new Error('base64 decoding is unavailable in this runtime')
}

export interface Ed25519Verifier {
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}

export const webCryptoEd25519Verifier: Ed25519Verifier = {
  async verify(publicKey, message, signature) {
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      ownedBuffer(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      ownedBuffer(signature),
      ownedBuffer(message),
    )
  },
}

export async function verifySignedEnvelope<T extends JsonValue>(
  envelope: SignedEnvelope<T>,
  publicKey: Uint8Array,
  verifier: Ed25519Verifier = webCryptoEd25519Verifier,
): Promise<boolean> {
  if (envelope.algorithm !== 'Ed25519') return false
  return verifier.verify(publicKey, createSignaturePayload(envelope), decodeBase64(envelope.signature))
}
