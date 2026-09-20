import { describe, expect, it } from 'vitest'
import {
  AnalyticalOoOResultSchema,
  ArtifactDescriptorSchema,
  CapabilityTierSchema,
  ComparisonDimensionsSchema,
  DatasetSplitSchema,
  DurableJobSchema,
  EmpiricalJobTemplateSchema,
  EmpiricalResultSchema,
  EvidenceProofSchema,
  JobEventSchema,
  MeasurementBundleSchema,
  MetricSchema,
  RawSampleSchema,
  RunnerIdentitySchema,
  SignedEnvelopeSchema,
  WorkerToServerMessageV1Schema,
  assertComparable,
  assertResultIdentity,
  buildEmpiricalSchedule,
  buildComparisonGroupKey,
  canonicalJson,
  createSignaturePayload,
  decodeCanonicalBase64,
  parseEmpiricalAdapter,
  taggedJsonParse,
  taggedJsonStringify,
  sha256Canonical,
  sha256Utf8,
} from './index.ts'

describe('verified evidence proof', () => {
  const hash = 'a'.repeat(64)
  it('accepts independently complete signature and attestation proofs', () => {
    expect(EvidenceProofSchema.parse({
      signatureVerified: true,
      signatureVerifier: 'ed25519-verifier-v1',
      signatureIdentityHash: hash,
      attestationVerified: true,
      attestationType: 'runner-manifest',
      attestationVerifier: 'runner-policy-v1',
      attestationEvidenceHash: hash,
    })).toMatchObject({ signatureVerified: true, attestationVerified: true })
  })
  it('rejects forged flags, incomplete proofs, and unknown fields', () => {
    expect(() => EvidenceProofSchema.parse({ signatureVerified: false })).toThrow()
    expect(() => EvidenceProofSchema.parse({ signatureVerified: true })).toThrow()
    expect(() => EvidenceProofSchema.parse({
      attestationVerified: true,
      attestationType: 'runner-manifest',
      attestationVerifier: 'runner-policy-v1',
    })).toThrow()
    expect(() => EvidenceProofSchema.parse({ unknownVerification: true })).toThrow()
  })
})

describe('empirical job policy',()=>{
  const job={schemaVersion:'1',testOnly:true,jobId:'testOnly-job',target:{isa:'x64',os:'win32',abi:'msvc'},binary:{corpusId:'testOnly:fixture',sha256:'a'.repeat(64),size:'1',eligible:true},argv:[],warmups:0,seed:'seed',controls:{},adapters:['optional:rapl-powercap'],thresholds:{}}
  it('requires full four-pair blocks and normalizes optional adapters',()=>{
    expect(EmpiricalJobTemplateSchema.parse({...job,repetitions:32}).repetitions).toBe(32)
    expect(()=>EmpiricalJobTemplateSchema.parse({...job,repetitions:30})).toThrow()
    expect(()=>EmpiricalJobTemplateSchema.parse({...job,repetitions:34})).toThrow()
    expect(parseEmpiricalAdapter('optional:rapl-powercap')).toEqual({name:'rapl-powercap',required:false})
    expect(()=>EmpiricalJobTemplateSchema.parse({...job,repetitions:32,adapters:['rapl-powercap','optional:rapl-powercap']})).toThrow()
  })
  it('owns the exact signed 32-pair schedule and all phase descriptors',()=>{
    const schedule=buildEmpiricalSchedule('shared',32,5)
    expect(schedule.entries).toHaveLength(69)
    expect(schedule.entries.map(entry=>entry.ordinal)).toEqual(Array.from({length:69},(_,index)=>index))
    expect(schedule.protocol).toMatchObject({
      schemaVersion:'1',warmups:{count:5},pairedMeasurements:{repetitions:32,pairsPerBlock:4,blockPatterns:['ABBA','BAAB']},
      pilots:{phase:'pilot'},instrumentationOverhead:{phase:'idle'},
    })
    for(let block=0;block<8;block+=1){
      const entries=schedule.entries.filter(entry=>entry.block===block),pairs=[...new Set(entries.map(entry=>entry.pairId))]
      expect(entries).toHaveLength(8);expect(pairs).toHaveLength(4)
      expect(['ABBA','BAAB']).toContain(pairs.map(pair=>entries.find(entry=>entry.pairId===pair)!.arm).join(''))
    }
  })
})

describe('tagged analytical boundary JSON', () => {
  it('roundtrips every non-JSON IEEE-754 value canonically', () => {
    const value = taggedJsonParse(taggedJsonStringify({
      nan: Number.NaN,
      positive: Infinity,
      negative: -Infinity,
      negativeZero: -0,
    })) as Record<string, number>
    expect(Number.isNaN(value.nan)).toBe(true)
    expect(value.positive).toBe(Infinity)
    expect(value.negative).toBe(-Infinity)
    expect(Object.is(value.negativeZero, -0)).toBe(true)
    expect(() => taggedJsonParse('{"$isaSimIeee754":"bogus"}')).toThrow()
  })
})

describe('canonical signature profile vectors', () => {
  it('has stable canonical bytes and rejects noncanonical base64', () => {
    const bytes = createSignaturePayload({
      algorithm: 'Ed25519', keyId: 'ed25519:test', signedAt: at,
      payload: { z: 1, a: 'vector' },
    })
    expect(new TextDecoder().decode(bytes)).toBe(`{"payload":{"a":"vector","z":1},"protected":{"algorithm":"Ed25519","keyId":"ed25519:test","signedAt":"${at}"}}`)
    expect(Array.from(decodeCanonicalBase64('AQID', 3))).toEqual([1, 2, 3])
    expect(() => decodeCanonicalBase64('AQID==')).toThrow()
  })
})

const hash = (digit: string) => digit.repeat(64)
const at = '2026-08-27T04:00:00.000Z'

function comparison(overrides: Record<string, unknown> = {}) {
  return {
    experimentKind: 'analytical-ooo',
    modelVersion: 'ooo-1.0.0',
    workloadSemanticHash: hash('1'),
    artifactPipelineHash: hash('2'),
    roiDefinitionHash: hash('3'),
    profileConfigFingerprint: hash('4'),
    metricDomain: 'analytical-model-cycles',
    unit: 'model-cycle',
    ...overrides,
  }
}

describe('canonical JSON and cryptographic identities', () => {
  it('is stable across key order and hashes known UTF-8', async () => {
    const first = { z: [3, true, null], a: { y: 'é', x: -0 } }
    const second = { a: { x: 0, y: 'é' }, z: [3, true, null] }
    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(await sha256Canonical(first)).toBe(await sha256Canonical(second))
    expect(await sha256Utf8('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('rejects non-JSON and ambiguous numeric values', () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/)
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/non-finite/)
    expect(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/unsafe/)
    const sparse: unknown[] = []
    sparse[1] = 'x'
    expect(() => canonicalJson(sparse as never)).toThrow(/sparse/)
  })

  it('constructs a stable signature payload independent of payload key order', () => {
    const common = { algorithm: 'Ed25519' as const, keyId: 'runner-key', signedAt: at }
    const left = createSignaturePayload({ ...common, payload: { b: 2, a: 1 } })
    const right = createSignaturePayload({ ...common, payload: { a: 1, b: 2 } })
    expect(left).toEqual(right)
  })
})

describe('strict boundary validation', () => {
  it('rejects empty and untagged worker results', () => {
    expect(() => WorkerToServerMessageV1Schema.parse({
      type: 'result',
      result: {},
    })).toThrow()
    expect(() => WorkerToServerMessageV1Schema.parse({
      type: 'result',
      lane: 'analytical-inorder',
      result: {},
    })).toThrow()
  })
  it('rejects mutations and unknown fields', () => {
    const artifact = {
      id: hash('a'),
      sha256: hash('a'),
      byteSize: '12',
      mimeType: 'application/octet-stream',
      role: 'binary',
    }
    expect(ArtifactDescriptorSchema.parse(artifact)).toEqual(artifact)
    expect(() => ArtifactDescriptorSchema.parse({ ...artifact, id: hash('b') })).toThrow()
    expect(() => ArtifactDescriptorSchema.parse({ ...artifact, mutablePath: '/tmp/x' })).toThrow()

    const signed = SignedEnvelopeSchema(RunnerIdentitySchema)
    const envelope = {
      algorithm: 'Ed25519',
      keyId: 'key-1',
      signedAt: at,
      signature: 'AA==',
      payload: { runnerId: 'runner-1', publicKey: 'AA==', keyId: 'key-1', issuedAt: at },
    }
    expect(signed.parse(envelope)).toEqual(envelope)
    expect(() => signed.parse({ ...envelope, unsignedMetadata: true })).toThrow()
    expect(() => signed.parse({ ...envelope, payload: { ...envelope.payload, admin: true } })).toThrow()
  })

  it('rejects nonfinite empirical values and unsafe numeric counters', () => {
    const sample = {
      sampleId: 'sample-1',
      startedAtUnixNs: '1770000000000000000',
      durationNs: '100',
      iterationCount: '1',
      metrics: [{ name: 'time', domain: 'physical-time-ns', unit: 'ns', value: 12.5 }],
      perfCounters: [],
      sensorReadings: [],
    }
    expect(RawSampleSchema.parse(sample)).toEqual(sample)
    expect(() => RawSampleSchema.parse({
      ...sample,
      metrics: [{ name: 'time', domain: 'physical-time-ns', unit: 'ns', value: Infinity }],
    })).toThrow()
    expect(() => RawSampleSchema.parse({ ...sample, durationNs: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(() => RawSampleSchema.parse({ ...sample, startedAtUnixNs: '01' })).toThrow()
  })

  it('enforces metric domains and capability reasons', () => {
    expect(MetricSchema.parse({
      name: 'cycles',
      domain: 'external-simulator-cycles',
      unit: 'sim-cycle',
      value: '900719925474099312345',
    })).toBeTruthy()
    expect(() => MetricSchema.parse({
      name: 'cycles',
      domain: 'external-simulator-cycles',
      unit: 'model-cycle',
      value: 0,
    })).toThrow()

    for (const tier of ['execute', 'codegen-only', 'unsupported']) {
      expect(CapabilityTierSchema.parse({ tier, reason: 'explicitly detected' })).toBeTruthy()
      expect(() => CapabilityTierSchema.parse({ tier, reason: '' })).toThrow()
    }
    expect(() => CapabilityTierSchema.parse({ tier: 'unsupported', value: 0, reason: 'missing' })).toThrow()
  })
})

describe('comparison groups', () => {
  it('builds canonical keys and accepts valid minimal results', async () => {
    const dimensions = ComparisonDimensionsSchema.parse(comparison())
    const comparisonGroupKey = await buildComparisonGroupKey(dimensions)
    const result = AnalyticalOoOResultSchema.parse({
      schemaVersion: '0.1.0',
      modelVersion: 'ooo-1.0.0',
      adapterVersion: 'adapter-1.0.0',
      experimentKind: 'analytical-ooo',
      claimClass: 'analytical-estimate',
      evidenceClass: 'model-output',
      inputIdentity: hash('5'),
      artifactIdentities: [hash('6')],
      comparisonGroupKey,
      comparison: dimensions,
      createdAt: at,
      metrics: [{ name: 'cycles', domain: 'analytical-model-cycles', unit: 'model-cycle', value: 42 }],
      modelPayload: { opaque: true },
    })
    await expect(assertResultIdentity(result)).resolves.toBeUndefined()
    expect(() => assertComparable([result, structuredClone(result)])).not.toThrow()
  })

  it.each([
    ['experimentKind', 'gem5'],
    ['modelVersion', 'ooo-2.0.0'],
    ['workloadSemanticHash', hash('7')],
    ['artifactPipelineHash', hash('8')],
    ['roiDefinitionHash', hash('9')],
    ['profileConfigFingerprint', hash('a')],
    ['metricDomain', 'analytical-model-nj'],
    ['unit', 'model-nJ'],
  ])('rejects mixed %s', (field, value) => {
    const first = ComparisonDimensionsSchema.parse(comparison())
    const related = field === 'metricDomain'
      ? comparison({ metricDomain: value, unit: 'model-nJ' })
      : field === 'unit'
        ? comparison({ metricDomain: 'analytical-model-nj', unit: value })
        : comparison({ [field]: value })
    const second = ComparisonDimensionsSchema.parse(related)
    expect(() => assertComparable([first, second])).toThrow(new RegExp(field))
  })
})

describe('jobs, measurements, and datasets', () => {
  const artifact = {
    id: hash('a'),
    sha256: hash('a'),
    byteSize: '12',
    mimeType: 'application/octet-stream',
    role: 'binary',
  }
  const target = { triple: 'x86_64-unknown-linux-gnu', abi: 'sysv', endianness: 'little', addressWidth: 64 }

  it('accepts minimal durable jobs and events', () => {
    const request = {
      requestId: 'request-1',
      experimentKind: 'gem5',
      inputArtifact: artifact,
      requestedCapability: 'execute',
      target,
      parameters: {},
    }
    expect(DurableJobSchema.parse({
      id: 'job-1',
      state: 'queued',
      revision: '0',
      request,
      createdAt: at,
      updatedAt: at,
    })).toBeTruthy()
    expect(JobEventSchema.parse({
      jobId: 'job-1',
      sequence: '1',
      at,
      type: 'progress',
      fraction: 0.5,
      phase: 'simulate',
      detail: 'running',
    })).toBeTruthy()
  })

  it('accepts a strict minimal measurement bundle', () => {
    const bundle = {
      bundleId: hash('b'),
      jobId: 'job-1',
      runner: { runnerId: 'runner-1', publicKey: 'AA==', keyId: 'key-1', issuedAt: at },
      schemaVersion: '0.1.0',
      adapterVersion: 'adapter-1.0.0',
      experimentKind: 'empirical-measurement',
      inputIdentity: hash('c'),
      artifactIdentities: [hash('a')],
      target,
      environment: {
        capturedAt: at,
        os: 'linux',
        kernel: '6.10',
        cpuModel: 'test cpu',
        logicalCpuCount: 8,
        memoryBytes: '17179869184',
        fingerprint: hash('d'),
      },
      sensors: [],
      samples: [{
        sampleId: 'sample-1',
        startedAtUnixNs: '1770000000000000000',
        durationNs: '100',
        iterationCount: '1',
        metrics: [{ name: 'time', domain: 'physical-time-ns', unit: 'ns', value: 12.5 }],
        perfCounters: [],
        sensorReadings: [],
      }],
      createdAt: at,
    }
    expect(MeasurementBundleSchema.parse(bundle)).toEqual(bundle)
    expect(() => MeasurementBundleSchema.parse({ ...bundle, samples: [{ ...bundle.samples[0], extra: 1 }] })).toThrow()
  })

  it('rejects overlapping dataset splits', () => {
    const split = {
      datasetArtifactId: hash('e'),
      strategy: 'grouped',
      seed: '42',
      trainingIds: ['a'],
      selectionIds: ['b'],
      conformalIds: ['c'],
      holdoutIds: ['d'],
    }
    expect(DatasetSplitSchema.parse(split)).toEqual(split)
    expect(() => DatasetSplitSchema.parse({ ...split, holdoutIds: ['a'] })).toThrow(/disjoint/)
  })

  it('keeps empirical results strict', () => {
    const dimensions = comparison({
      experimentKind: 'empirical-measurement',
      modelVersion: 'measurement-1',
      metricDomain: 'physical-energy-j',
      unit: 'J',
    })
    expect(() => EmpiricalResultSchema.parse({
      schemaVersion: '0.1.0',
      modelVersion: 'measurement-1',
      adapterVersion: 'adapter-1',
      experimentKind: 'empirical-measurement',
      claimClass: 'empirical-observation',
      evidenceClass: 'aggregated-measurement',
      inputIdentity: hash('1'),
      artifactIdentities: [],
      comparisonGroupKey: hash('2'),
      comparison: dimensions,
      createdAt: at,
      measurementBundleId: hash('3'),
      sampleCount: '1',
      metrics: [{ name: 'energy', domain: 'physical-energy-j', unit: 'J', value: NaN }],
    })).toThrow()
  })
})
