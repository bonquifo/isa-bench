import { randomBytes } from 'node:crypto'
import type { Identity, RunnerIdentity } from './identity.js'
import { token, validateRunnerIdentity, verifySigned } from './identity.js'
import { EmpiricalJobSpecSchema } from '@isa-sim/contracts'
import type { JobSpec, LeaseEvent, RunnerCredential, RunnerState, Signed } from './types.js'

export interface EnrollmentToken {
  id: string
  secret: string
  expiresAt: string
  used: boolean
}

export interface EnrollmentChallenge {
  id: string
  tokenId: string
  runner: RunnerIdentity
  nonce: string
  expiresAt: string
  used: boolean
}

export class EnrollmentAuthority {
  private readonly tokens = new Map<string, EnrollmentToken>()
  private readonly challenges = new Map<string, EnrollmentChallenge>()
  private readonly runners = new Map<string, RunnerCredential>()
  constructor(private readonly orchestrator: Identity) {}

  issueToken(ttlMs = 10 * 60_000, now = Date.now()): EnrollmentToken {
    const value = { id: token(18), secret: token(), expiresAt: new Date(now + ttlMs).toISOString(), used: false }
    this.tokens.set(value.id, value)
    return { ...value }
  }

  challenge(tokenId: string, secret: string, runner: RunnerIdentity, now = Date.now()): EnrollmentChallenge {
    validateRunnerIdentity(runner)
    const enrollment = this.tokens.get(tokenId)
    if (!enrollment || enrollment.used || enrollment.secret !== secret) throw new Error('invalid enrollment token')
    if (Date.parse(enrollment.expiresAt) <= now) throw new Error('enrollment token expired')
    enrollment.used = true
    const challenge = {
      id: token(18), tokenId, runner, nonce: randomBytes(32).toString('base64'),
      expiresAt: new Date(now + 5 * 60_000).toISOString(), used: false,
    }
    this.challenges.set(challenge.id, challenge)
    return { ...challenge }
  }

  complete(challengeId: string, response: Signed<{ challengeId: string; nonce: string }>, now = Date.now()): Signed<RunnerCredential> {
    const challenge = this.challenges.get(challengeId)
    if (!challenge || challenge.used) throw new Error('challenge replay')
    if (Date.parse(challenge.expiresAt) <= now) throw new Error('challenge expired')
    if (response.keyId !== challenge.runner.keyId ||
      response.payload.challengeId !== challengeId ||
      response.payload.nonce !== challenge.nonce ||
      !verifySigned(response, challenge.runner.publicKey)) throw new Error('invalid challenge response')
    challenge.used = true
    const credential: RunnerCredential = {
      ...challenge.runner, state: 'pending', sequence: '0',
      expiresAt: new Date(now + 365 * 24 * 60 * 60_000).toISOString(),
    }
    this.runners.set(credential.runnerId, credential)
    return this.orchestrator.sign(credential, new Date(now))
  }

  setState(runnerId: string, state: Exclude<RunnerState, 'expired'>, now = Date.now()): Signed<RunnerCredential> {
    const current = this.runners.get(runnerId)
    if (!current) throw new Error('runner not found')
    if (current.state === 'revoked') throw new Error('revocation is permanent')
    const next: RunnerCredential = { ...current, state, sequence: (BigInt(current.sequence) + 1n).toString() }
    if (Date.parse(next.expiresAt) <= now) next.state = 'expired'
    this.runners.set(runnerId, next)
    return this.orchestrator.sign(next, new Date(now))
  }
}

export class SequenceGuard {
  private readonly sequences = new Map<string, bigint>()
  accept(stream: string, sequence: string): void {
    if (!/^(0|[1-9]\d*)$/.test(sequence)) throw new Error('invalid sequence')
    const next = BigInt(sequence)
    const previous = this.sequences.get(stream)
    if (previous !== undefined && next <= previous) throw new Error('replay or sequence rollback')
    this.sequences.set(stream, next)
  }
}

export function verifyJobSpec(
  envelope: Signed<JobSpec>,
  orchestratorPublicKey: string,
  runnerId: string,
  sequences: SequenceGuard,
  now = Date.now(),
): JobSpec {
  if (!verifySigned(envelope, orchestratorPublicKey)) throw new Error('invalid JobSpec signature')
  const job = EmpiricalJobSpecSchema.parse(envelope.payload)
  if (job.runnerId !== runnerId) throw new Error('JobSpec addressed to another runner')
  const issued = Date.parse(job.issuedAt)
  if (!Number.isFinite(issued) || Math.abs(now - issued) > 5 * 60_000 || Date.parse(envelope.signedAt) !== issued) throw new Error('stale JobSpec signature')
  if (Date.parse(job.expiresAt) <= now || Date.parse(job.leaseExpiresAt) <= now ||
      Date.parse(job.leaseExpiresAt) > Date.parse(job.expiresAt)) throw new Error('JobSpec expired')
  sequences.accept(`job:${job.jobId}`, job.sequence)
  return job
}

export class LeaseSession {
  private sequence: bigint
  private state: 'leased' | 'accepted' | 'running' | 'finished' | 'failed' = 'leased'
  constructor(readonly job: JobSpec, private readonly identity: Identity, startSequence = 0n) {
    this.sequence = startSequence
  }
  get currentSequence(): bigint { return this.sequence }
  syncSequence(sequence: bigint): void { if(sequence>this.sequence)this.sequence=sequence }
  renew(envelope: Signed<JobSpec>, orchestratorPublicKey: string, sequences: SequenceGuard, now = Date.now()): void {
    const renewed = verifyJobSpec(envelope, orchestratorPublicKey, this.job.runnerId, sequences, now)
    if (renewed.jobId !== this.job.jobId || renewed.leaseId !== this.job.leaseId || renewed.nonce !== this.job.nonce) throw new Error('lease renewal binding mismatch')
    Object.assign(this.job, renewed)
  }
  event(kind: LeaseEvent['kind'], payload: Record<string, unknown> = {}, now = Date.now()): Signed<LeaseEvent> {
    const transitions: Record<typeof this.state, readonly LeaseEvent['kind'][]> = {
      leased: ['accept'], accepted: ['heartbeat', 'start', 'fail'],
      running: ['heartbeat', 'event', 'finish', 'fail'], finished: [], failed: [],
    }
    const allowed = transitions[this.state]
    if (!allowed.includes(kind)) throw new Error(`invalid lease event ${this.state} -> ${kind}`)
    if (Date.parse(this.job.leaseExpiresAt) <= now && kind !== 'fail') throw new Error('lease expired')
    if (kind === 'accept') this.state = 'accepted'
    else if (kind === 'start') this.state = 'running'
    else if (kind === 'finish') this.state = 'finished'
    else if (kind === 'fail') this.state = 'failed'
    this.sequence += 1n
    const timestamp = new Date(now).toISOString()
    return this.identity.sign({
      operation: `job.${kind}`, runnerId: this.job.runnerId, keyId: this.identity.value.keyId,
      requestId: crypto.randomUUID(), jobId: this.job.jobId, leaseId: this.job.leaseId,
      leaseNonce: this.job.nonce, sequence: this.sequence.toString(), kind, timestamp,
      nonce: randomBytes(32).toString('base64'), data: payload,
    }, new Date(now))
  }
}
