import { canonicalJson, type JsonValue } from '@isa-sim/contracts'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type Backend } from './app.js'
import { SequenceGuard, verifyJobSpec } from '../../runner/src/protocol.ts'

let backend: Backend | undefined
let root: string | undefined
afterEach(async () => { await backend?.app.close(); if (root) rmSync(root, { recursive: true, force: true }); backend = undefined })

function envelope(key: KeyObject, keyId: string, payload: Record<string, unknown>, timestamp = new Date().toISOString()) {
  const value = { algorithm: 'Ed25519' as const, keyId, payload, signedAt: timestamp }
  const bytes = Buffer.from(canonicalJson({ protected: { algorithm: value.algorithm, keyId, signedAt: timestamp }, payload } as JsonValue))
  return { ...value, signature: sign(null, bytes, key).toString('base64') }
}

describe('empirical adversarial protocol', () => {
  it('rejects unauthenticated uploads, route confusion, wrong jobs, oversize, revocation, and expires running leases', async () => {
    root = mkdtempSync(join(tmpdir(), 'empirical-security-'))
    backend = await createBackend({ dataDir: root, artifactMaxBytes: 1024 })
    const session = (await backend.app.inject({ method: 'POST', url: '/api/session' })).json() as { token: string }
    const admin = { 'x-session-token': session.token }
    const token = (await backend.app.inject({ method: 'POST', url: '/api/empirical/enrollment/tokens', headers: admin, payload: { ttlMs: 10_000 } })).json() as { id: string; token: string }
    const pair = generateKeyPairSync('ed25519')
    const der = pair.publicKey.export({ format: 'der', type: 'spki' })
    const digest = createHash('sha256').update(der).digest('hex')
    const runnerId = `runner:${digest}`, keyId = `ed25519:${digest}`
    const challenge = (await backend.app.inject({
      method: 'POST', url: '/api/empirical/enrollment/challenges',
      payload: { tokenId: token.id, token: token.token, identity: { runnerId, keyId, publicKey: der.toString('base64'), issuedAt: new Date().toISOString() } },
    })).json() as { id: string; nonce: string }
    const completed = (await backend.app.inject({
      method: 'POST', url: '/api/empirical/enrollment/complete',
      payload: envelope(pair.privateKey, keyId, { challengeId: challenge.id, nonce: challenge.nonce }),
    }))
    expect(completed.statusCode).toBe(200)
    const orchestratorPublicKey = (completed.json() as { orchestratorPublicKey: string }).orchestratorPublicKey
    expect((await backend.app.inject({ method: 'POST', url: `/api/empirical/runners/${runnerId}/approve`, headers: admin, payload: {} })).statusCode).toBe(200)
    const jobId = 'secure-job'
    expect((await backend.app.inject({
      method: 'POST', url: '/api/empirical/jobs', headers: admin,
      payload: { schemaVersion:'1',testOnly: false, jobId: 'override-job', runnerId: 'runner:evil', leaseId: 'evil', target: { isa: 'x64', os: 'win32', abi: 'msvc' }, binary: { eligible: true, corpusId: 'fixture', sha256: 'a'.repeat(64), size: '1' }, argv: [], repetitions: 32, warmups: 5, seed: 'seed', controls: {}, adapters: [], thresholds: {} },
    })).statusCode).toBe(400)
    const createdJob=await backend.app.inject({
      method: 'POST', url: '/api/empirical/jobs', headers: admin,
      payload: { schemaVersion:'1',testOnly: false, jobId, target: { isa: 'x64', os: 'win32', abi: 'msvc' }, binary: { eligible: true, corpusId: 'fixture', sha256: 'a'.repeat(64), size: '1' }, argv: [], repetitions: 32, warmups: 5, seed: 'seed', controls: {}, adapters: [], thresholds: {} },
    })
    expect(createdJob.statusCode,createdJob.body).toBe(200)
    let sequence = 0
    const operation = (operationName: string, extra: Record<string, unknown> = {}) => {
      const timestamp = new Date().toISOString()
      return envelope(pair.privateKey, keyId, {
        operation: operationName, runnerId, keyId, requestId: `request-${++sequence}`,
        sequence: String(sequence), nonce: Buffer.alloc(32, sequence).toString('base64'), timestamp, ...extra,
      }, timestamp)
    }
    const expiredManifest = {
      schemaVersion: '1', runnerId, sequence: '1',
      observedAt: new Date(Date.now() - 20_000).toISOString(),
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
      host: { os: { status: 'supported', value: 'test' } }, cpu: { identity: { status: 'unsupported', reason: 'test' } },
    }
    expect((await backend.app.inject({
      method: 'POST', url: '/api/empirical/runner/manifests',
      payload: operation('manifest.publish', { manifest: expiredManifest }),
    })).statusCode).toBe(401)
    expect((backend.db.sqlite.prepare('SELECT last_sequence FROM empirical_runners WHERE id=?').get(runnerId) as { last_sequence: number }).last_sequence).toBe(0)
    const leased = (await backend.app.inject({ method: 'POST', url: '/api/empirical/runner/jobs/lease', payload: operation('job.lease') })).json() as { payload: { leaseId: string; nonce: string } }
    expect(verifyJobSpec(leased as never, orchestratorPublicKey, runnerId, new SequenceGuard()).testOnly).toBe(false)
    const lease = { jobId, leaseId: leased.payload.leaseId, leaseNonce: leased.payload.nonce }
    expect((await backend.app.inject({ method: 'POST', url: `/api/empirical/runner/jobs/${jobId}/accept`, payload: operation('job.accept', { ...lease, kind: 'accept', data: {} }) })).statusCode).toBe(200)
    expect((await backend.app.inject({ method: 'POST', url: `/api/empirical/runner/jobs/${jobId}/start`, payload: operation('job.start', { ...lease, kind: 'start', data: {} }) })).statusCode).toBe(200)
    const renewed=(await backend.app.inject({ method: 'POST', url: `/api/empirical/runner/jobs/${jobId}/heartbeat`, payload: operation('job.heartbeat', { ...lease, kind: 'heartbeat', data: {} }) })).json() as {jobSpec:never}
    const renewedSpec=verifyJobSpec(renewed.jobSpec,orchestratorPublicKey,runnerId,new SequenceGuard())
    expect(renewedSpec.leaseId).toBe(lease.leaseId)
    expect((await backend.app.inject({method:'POST',url:`/api/empirical/runner/jobs/${jobId}/finish`,payload:operation('job.finish',{...lease,kind:'finish',data:{artifactHash:'d'.repeat(64)}})})).statusCode).toBe(401)
    expect((await backend.app.inject({ method: 'POST', url: `/api/empirical/runner/jobs/${jobId}/finish`, payload: operation('job.heartbeat', { ...lease, kind: 'heartbeat', data: {} }) })).statusCode).toBe(401)
    expect((await backend.app.inject({ method: 'POST', url: '/api/empirical/runner/jobs/wrong/finish', payload: operation('job.finish', { ...lease, kind: 'finish', data: {} }) })).statusCode).toBe(401)
    const uploadHash=createHash('sha256').update('x').digest('hex')
    expect((await backend.app.inject({method:'POST',url:`/api/empirical/runner/uploads/${uploadHash}`,payload:operation('upload.create',{uploadHash,...lease,totalSize:1})})).statusCode).toBe(200)
    const chunkHeader=(chunk:string)=>Buffer.from(JSON.stringify(operation('upload.chunk',{uploadHash,leaseId:lease.leaseId,leaseNonce:lease.leaseNonce,totalSize:1,offset:0,length:1,chunkHash:createHash('sha256').update(chunk).digest('hex')}))).toString('base64')
    expect((await backend.app.inject({method:'PATCH',url:`/api/empirical/runner/uploads/${uploadHash}`,headers:{'content-type':'application/offset+octet-stream','x-runner-operation':chunkHeader('x')},payload:Buffer.from('x')})).statusCode).toBe(200)
    for(let attempt=0;attempt<5;attempt++)expect((await backend.app.inject({method:'PATCH',url:`/api/empirical/runner/uploads/${uploadHash}`,headers:{'content-type':'application/offset+octet-stream','x-runner-operation':chunkHeader('y')},payload:Buffer.from('y')})).statusCode).toBe(401)
    expect((backend.db.sqlite.prepare('SELECT COUNT(*) count FROM empirical_upload_chunks WHERE upload_hash=?').get(uploadHash) as {count:number}).count).toBe(1)
    expect(readdirSync(join(root,'empirical-upload-chunks',uploadHash))).toHaveLength(1)
    expect((await backend.app.inject({ method: 'HEAD', url: `/api/empirical/runner/uploads/${'b'.repeat(64)}` })).statusCode).toBe(401)
    expect((await backend.app.inject({
      method: 'PATCH', url: `/api/empirical/runner/uploads/${'b'.repeat(64)}`,
      headers: { 'content-type': 'application/offset+octet-stream' }, payload: Buffer.from('x'),
    })).statusCode).toBe(401)
    expect((await backend.app.inject({
      method: 'POST', url: `/api/empirical/runner/uploads/${'b'.repeat(64)}`,
      payload: operation('upload.create', { uploadHash: 'b'.repeat(64), ...lease, totalSize: 1025 }),
    })).statusCode).toBe(401)
    backend.db.sqlite.prepare("UPDATE empirical_jobs SET lease_expires_at=? WHERE id=?").run(new Date(0).toISOString(), jobId)
    expect(backend.empirical.recoverExpiredLeases()).toBe(1)
    expect((backend.db.sqlite.prepare('SELECT state FROM empirical_jobs WHERE id=?').get(jobId) as { state: string }).state).toBe('failed')
    await backend.app.inject({ method: 'POST', url: `/api/empirical/runners/${runnerId}/revoke`, headers: admin, payload: {} })
    const patchAuth = Buffer.from(JSON.stringify(operation('upload.chunk', { uploadHash: 'b'.repeat(64), leaseId: lease.leaseId, leaseNonce: lease.leaseNonce, totalSize: 1, offset: 0, length: 1, chunkHash: 'c'.repeat(64) }))).toString('base64')
    expect((await backend.app.inject({ method: 'PATCH', url: `/api/empirical/runner/uploads/${'b'.repeat(64)}`, headers: { 'content-type': 'application/offset+octet-stream', 'x-runner-operation': patchAuth }, payload: Buffer.from('x') })).statusCode).toBe(401)
    const audit = backend.db.sqlite.prepare('SELECT previous_hash,entry_hash FROM empirical_audit_chain ORDER BY id').all() as { previous_hash: string; entry_hash: string }[]
    expect(audit.length).toBeGreaterThan(5)
    expect(audit.slice(1).every((row, index) => row.previous_hash === audit[index]!.entry_hash)).toBe(true)
  })
})
