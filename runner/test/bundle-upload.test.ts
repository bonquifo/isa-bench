import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEmpiricalSchedule, canonicalJson } from '@isa-sim/contracts'
import { inspectJsonlBundle } from '@isa-sim/calibration'
import {
  bundlePaths, commitArtifactBeforeFinish, Identity, RawBundleWriter, verifyBundle, uploadResumable, verifySigned, type KeyStore, type UploadTransport,
} from '../src/index.js'

class MemoryStore implements KeyStore {
  value: Buffer | null = null
  async load(): Promise<Buffer | null> { return this.value }
  async store(_id: string, value: Buffer): Promise<void> { this.value = value }
}
const record = {
  kind: 'raw-run' as const, sampleId: 'sample', phase: 'measured' as const, block: 0, arm: 'A' as const,
  ordinal: 0, pairId: 'pair-0',
  valid: false, validityReasons: ['fixture'], monotonicStartedNs: '0', monotonicDurationNs: '1',
  userCpuNs: '0', systemCpuNs: '0', timedOut:false, exitCode: 0, signal: null, stdoutSha256: '0'.repeat(64),
  stderrSha256: '0'.repeat(64), oracle: { passed: true, detail: 'fixture',iterations:'1',nonce:Buffer.alloc(32).toString('base64') }, affinity: {},
  contextSwitches:{voluntary:0,involuntary:0},migrations:0,faults:{minor:0,major:0},clock:{source:'fixture',uncertaintyNs:'1'},adapterStatus:[],
  perf: [], energy: [], sensorStreamRefs: [], temperatureC: null, frequencyKHz: null, throttle: null,
  controlsBefore: {}, controlsAfter: {},
}

describe('raw bundles and uploads', () => {
  it('finalizes canonical runner evidence accepted by calibration inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-calibration-boundary-'))
    const identity = await Identity.loadOrCreate(new MemoryStore(), new Date('2026-08-27T12:00:00.000Z'))
    const partial = join(root, 'job-1.jsonl.partial')
    const writer = new RawBundleWriter(partial, { kind: 'header', schemaVersion: '1', jobId: 'job-1', runnerId: identity.value.runnerId, testOnly: false, createdAt: '2026-08-27T12:00:00.000Z' })
    const schedule = buildEmpiricalSchedule('shared-seed', 32, 0)
    const payload = { jobId: 'job-1', seed: 'shared-seed', entries: schedule.entries, protocol: schedule.protocol }
    writer.append({ kind: 'schedule', ...payload, signed: identity.sign(payload, new Date('2026-08-27T12:00:00.000Z')) })
    const raw = (sampleId: string, phase: 'pilot' | 'warmup' | 'measured' | 'idle', block: number, arm: 'A' | 'B', ordinal: number, pairId: string, start: number) =>
      ({ ...record, sampleId, phase, block, arm, ordinal, pairId, monotonicStartedNs: String(start), valid: false, validityReasons: ['fixture-cross-boundary'] })
    writer.append(raw('overhead', 'idle', -1, 'B', -100, 'instrumentation-overhead', 0))
    writer.append(raw('pilot-0', 'pilot', -1, 'A', -1, 'pilot-0', 2))
    schedule.entries.forEach((entry, index) => writer.append(raw(`sample-${index}`, entry.phase, entry.block, entry.arm, entry.ordinal, entry.pairId, 4 + index * 2)))
    const finalized = writer.finalize(identity, ['a'.repeat(64)])
    const bytes = readFileSync(finalized.path)
    expect(bytes.toString('utf8').split('\n').filter(Boolean).every((line) => canonicalJson(JSON.parse(line)) === line)).toBe(true)
    const inspection = inspectJsonlBundle(bytes, {
      production: true, now: Date.parse('2026-08-27T12:01:00.000Z'), signedIndex: finalized.signature,
      runner: { id: identity.value.runnerId, keyId: identity.value.keyId, publicKey: identity.value.publicKey, stateAtMeasurement: 'approved', stateAtImport: 'approved', credentialIssuedAt: '2026-08-27T11:00:00.000Z', credentialExpiresAt: '2026-08-28T11:00:00.000Z' },
      expected: { runnerId: identity.value.runnerId, jobId: 'job-1', leaseNonce: '', binarySha256: 'a'.repeat(64), seed: 'shared-seed', repetitions: 32, warmups: 0, adapters: [], controls: {} },
    })
    expect(inspection.reasons).toEqual([])
    expect(inspection.accepted).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('recovers partial append logs and signs the content index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-bundle-'))
    const partial = join(root, 'job.jsonl.partial')
    const identity = await Identity.loadOrCreate(new MemoryStore())
    const header = { kind: 'header' as const, schemaVersion: '1' as const, jobId: 'job', runnerId: identity.value.runnerId, testOnly: true as const, createdAt: new Date(0).toISOString() }
    new RawBundleWriter(partial, header).append(record)
    const writer = new RawBundleWriter(partial, header)
    const finalized = writer.finalize(identity)
    expect(() => verifyBundle(finalized.path, true)).toThrow('test-only')
    expect(verifyBundle(finalized.path, false, { runnerId: identity.value.runnerId, jobId: 'job', publicKey: identity.value.publicKey }).recordCount).toBe(1)
    expect(verifySigned(finalized.signature, identity.value.publicKey)).toBe(true)
    const body=readFileSync(finalized.path).subarray(0,Number(finalized.index.byteSize))
    writeFileSync(partial,body);rmSync(finalized.path);rmSync(`${finalized.path}.signature.json`)
    const recovered=new RawBundleWriter(partial,header).finalize(identity)
    expect(recovered.signature).toEqual(finalized.signature)
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects synthetic bundles in production', () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-synthetic-'))
    const path = join(root, 'synthetic.jsonl')
    writeFileSync(path, `${JSON.stringify({ kind: 'header', testOnly: true })}\n${JSON.stringify({ kind: 'index' })}\n`)
    expect(() => verifyBundle(path, true)).toThrow()
    rmSync(root, { recursive: true, force: true })
  })

  it('resumes uploads idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-upload-'))
    const path = join(root, 'artifact')
    writeFileSync(path, 'abcdefgh')
    let bytes = Buffer.from('ab')
    let complete = false
    const transport: UploadTransport = {
      async head() { return { complete, offset: bytes.byteLength } },
      async create() {},
      async patch(_hash, offset, chunk) {
        expect(offset).toBe(bytes.byteLength)
        bytes = Buffer.concat([bytes, chunk])
        return { offset: bytes.byteLength }
      },
      async complete() { complete = true },
    }
    const hash = await uploadResumable(path, transport, 2)
    expect(bytes.equals(readFileSync(path))).toBe(true)
    expect(await uploadResumable(path, transport, 2)).toBe(hash)
    rmSync(root, { recursive: true, force: true })
  })

  it('finishes only after artifact commit succeeds',async()=>{
    const root=mkdtempSync(join(tmpdir(),'runner-finish-')),path=join(root,'bundle');writeFileSync(path,'bundle')
    const order:string[]=[],transport:UploadTransport={async head(){return{complete:false,offset:0}},async create(){order.push('create')},async patch(_hash,offset,bytes){order.push('patch');return{offset:offset+bytes.byteLength}},async complete(){order.push('complete')}}
    await commitArtifactBeforeFinish(path,transport,async hash=>{expect(hash).toMatch(/^[a-f0-9]{64}$/);order.push('finish')})
    expect(order).toEqual(['create','patch','complete','finish'])
    let finished=false
    await expect(commitArtifactBeforeFinish(path,{...transport,async complete(){throw new Error('commit rejected')}},async()=>{finished=true})).rejects.toThrow('commit rejected')
    expect(finished).toBe(false);rmSync(root,{recursive:true,force:true})
  })

  it('truncates torn recovery records and rejects signature mismatch and Windows device IDs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-torn-'))
    const identity = await Identity.loadOrCreate(new MemoryStore())
    const header = { kind: 'header' as const, schemaVersion: '1' as const, jobId: 'safe-job', runnerId: identity.value.runnerId, testOnly: true as const, createdAt: new Date().toISOString() }
    const partial = join(root, 'safe-job.jsonl.partial')
    writeFileSync(partial, `${JSON.stringify(header)}\n${JSON.stringify(record)}\n{"kind":"raw`)
    const finalized = new RawBundleWriter(partial, header).finalize(identity)
    expect(finalized.index.recordCount).toBe(1)
    writeFileSync(`${finalized.path}.signature.json`, JSON.stringify({ ...finalized.signature, signature: Buffer.alloc(64).toString('base64') }))
    expect(() => verifyBundle(finalized.path, false, { runnerId: identity.value.runnerId, jobId: 'safe-job', publicKey: identity.value.publicKey })).toThrow('signature')
    expect(() => bundlePaths(root, 'file:stream')).toThrow('unsafe')
    expect(() => bundlePaths(root, 'CON')).toThrow('unsafe')
    rmSync(root, { recursive: true, force: true })
  })
})
