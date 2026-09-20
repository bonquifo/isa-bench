import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { EnrollmentAuthority, Identity, LeaseSession, SequenceGuard, validateRunnerIdentity, verifyJobSpec, verifySigned, type KeyStore } from '../src/index.js'

class MemoryStore implements KeyStore {
  value: Buffer | null = null
  async load(): Promise<Buffer | null> { return this.value }
  async store(_id: string, value: Buffer): Promise<void> { this.value = value }
}

describe('identity and enrollment protocol', () => {
  it('rejects replay, wrong keys, expiry, revocation, and sequence rollback', async () => {
    const authorityIdentity = await Identity.loadOrCreate(new MemoryStore())
    const runner = await Identity.loadOrCreate(new MemoryStore())
    const wrong = await Identity.loadOrCreate(new MemoryStore())
    const authority = new EnrollmentAuthority(authorityIdentity)
    const enrollment = authority.issueToken(1000, 0)
    const challenge = authority.challenge(enrollment.id, enrollment.secret, runner.value, 1)
    expect(() => authority.complete(challenge.id, wrong.sign({ challengeId: challenge.id, nonce: challenge.nonce }), 2)).toThrow('invalid')
    const credential = authority.complete(challenge.id, runner.sign({ challengeId: challenge.id, nonce: challenge.nonce }), 2)
    expect(verifySigned(credential, authorityIdentity.value.publicKey)).toBe(true)
    expect(() => authority.complete(challenge.id, runner.sign({ challengeId: challenge.id, nonce: challenge.nonce }), 2)).toThrow('replay')
    authority.setState(runner.value.runnerId, 'revoked', 3)
    expect(() => authority.setState(runner.value.runnerId, 'approved', 4)).toThrow('permanent')
    const expired = authority.issueToken(1, 0)
    expect(() => authority.challenge(expired.id, expired.secret, runner.value, 2)).toThrow('expired')
    const guard = new SequenceGuard()
    guard.accept('stream', '1')
    expect(() => guard.accept('stream', '1')).toThrow('rollback')
  })

  it('rejects mutated and expired signed JobSpecs', async () => {
    const orchestrator = await Identity.loadOrCreate(new MemoryStore())
    const runner = await Identity.loadOrCreate(new MemoryStore())
    const payload = {
      schemaVersion: '1' as const, testOnly:false, jobId: 'job', leaseId: 'lease', runnerId: runner.value.runnerId,
      sequence: '1', nonce: Buffer.alloc(32).toString('base64'), issuedAt: new Date(0).toISOString(), expiresAt: new Date(1000).toISOString(),
      leaseExpiresAt: new Date(1000).toISOString(), target: { isa: 'x64', os: 'linux', abi: 'gnu' },
      binary: { corpusId: 'c', sha256: '0'.repeat(64), size: '1', eligible: true as const },
      argv: [], seed: 'seed', controls: {}, adapters: [], thresholds: {},
    }
    expect(() => verifyJobSpec(orchestrator.sign(payload, new Date(0)), orchestrator.value.publicKey, runner.value.runnerId, new SequenceGuard(), 1001)).toThrow('expired')
    const signed = orchestrator.sign({ ...payload, expiresAt: new Date(2000).toISOString(), leaseExpiresAt: new Date(2000).toISOString() }, new Date(0))
    signed.payload.seed = 'mutation'
    expect(() => verifyJobSpec(signed, orchestrator.value.publicKey, runner.value.runnerId, new SequenceGuard(), 1)).toThrow('signature')
  })

  it('rejects lease events after expiry and invalid transitions', async () => {
    const runner = await Identity.loadOrCreate(new MemoryStore())
    const job = {
      schemaVersion: '1' as const, testOnly:false, jobId: 'job', leaseId: 'lease', runnerId: runner.value.runnerId,
      sequence: '1', nonce: Buffer.alloc(32).toString('base64'), issuedAt: new Date(0).toISOString(), expiresAt: new Date(100).toISOString(),
      leaseExpiresAt: new Date(100).toISOString(), target: { isa: 'x64', os: 'win32', abi: 'msvc' },
      binary: { corpusId: 'corpus', sha256: '0'.repeat(64), size: '1', eligible: true as const },
      argv: [], seed: 'seed', controls: {}, adapters: [], thresholds: {},
    }
    const lease = new LeaseSession(job, runner)
    expect(() => lease.event('start', {}, 1)).toThrow('invalid')
    expect(() => lease.event('accept', {}, 101)).toThrow('expired')
  })

  it('rejects non-Ed25519, trailing DER, noncanonical base64, bad signature length, and arbitrary IDs', async () => {
    const runner = await Identity.loadOrCreate(new MemoryStore())
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    expect(() => validateRunnerIdentity({ ...runner.value, publicKey: rsa })).toThrow('Ed25519')
    expect(() => validateRunnerIdentity({ ...runner.value, publicKey: `${runner.value.publicKey}AA==` })).toThrow()
    expect(() => validateRunnerIdentity({ ...runner.value, publicKey: runner.value.publicKey.replace(/=+$/, '') })).toThrow()
    expect(() => validateRunnerIdentity({ ...runner.value, runnerId: 'runner:arbitrary' })).toThrow('IDs')
    const signed = runner.sign({ value: true })
    expect(verifySigned({ ...signed, signature: Buffer.alloc(63).toString('base64') }, runner.value.publicKey)).toBe(false)
  })
})
