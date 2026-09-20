import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalJson, decodeCanonicalBase64, type JsonValue } from '@isa-sim/contracts'
import type { Signed } from './types.js'

export interface KeyStore {
  load(keyId: string): Promise<Buffer | null>
  store(keyId: string, pkcs8: Buffer): Promise<void>
}

export class OwnerOnlyFileKeyStore implements KeyStore {
  constructor(private readonly path: string) {}
  async load(): Promise<Buffer | null> {
    try {
      return readFileSync(this.path)
    } catch {
      return null
    }
  }
  async store(_keyId: string, pkcs8: Buffer): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(this.path, pkcs8, { flag: 'wx', mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(this.path, 0o600)
  }
}

export interface RunnerIdentity {
  runnerId: string
  keyId: string
  publicKey: string
  issuedAt: string
}

export class Identity {
  private constructor(readonly value: RunnerIdentity, private readonly privateKey: KeyObject) {}

  static async loadOrCreate(store: KeyStore, now = new Date()): Promise<Identity> {
    const existing = await store.load('identity')
    let privateKey: KeyObject
    if (existing) {
      privateKey = createPrivateKey({ key: existing, format: 'der', type: 'pkcs8' })
    } else {
      const pair = generateKeyPairSync('ed25519')
      privateKey = pair.privateKey
      await store.store('identity', privateKey.export({ format: 'der', type: 'pkcs8' }))
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('identity key is not Ed25519')
    const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
    const digest = createHash('sha256').update(publicDer).digest('hex')
    return new Identity({
      runnerId: `runner:${digest}`,
      keyId: `ed25519:${digest}`,
      publicKey: publicDer.toString('base64'),
      issuedAt: now.toISOString(),
    }, privateKey)
  }

  sign<T>(payload: T, now = new Date()): Signed<T> {
    const envelope = {
      algorithm: 'Ed25519' as const,
      keyId: this.value.keyId,
      payload,
      signedAt: now.toISOString(),
    }
    return { ...envelope, signature: sign(null, signatureBytes(envelope), this.privateKey).toString('base64') }
  }
}

export function signatureBytes(value: Pick<Signed<unknown>, 'algorithm' | 'keyId' | 'payload' | 'signedAt'>): Buffer {
  return Buffer.from(canonicalJson({
    protected: { algorithm: value.algorithm, keyId: value.keyId, signedAt: value.signedAt },
    payload: value.payload,
  } as JsonValue))
}

export function verifySigned<T>(envelope: Signed<T>, publicKeyBase64: string): boolean {
  if (envelope.algorithm !== 'Ed25519') return false
  try {
    const der = Buffer.from(decodeCanonicalBase64(publicKeyBase64))
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519' ||
        !key.export({ format: 'der', type: 'spki' }).equals(der)) return false
    const signature = Buffer.from(decodeCanonicalBase64(envelope.signature, 64))
    return verify(null, signatureBytes(envelope), key, signature)
  } catch {
    return false
  }
}

export function validateRunnerIdentity(value: RunnerIdentity): RunnerIdentity {
  if (!Number.isFinite(Date.parse(value.issuedAt))) throw new Error('invalid identity timestamp')
  const der = Buffer.from(decodeCanonicalBase64(value.publicKey))
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('runner key must be Ed25519')
  if (!key.export({ format: 'der', type: 'spki' }).equals(der)) throw new Error('non-canonical SPKI')
  const digest = sha256(der)
  if (value.runnerId !== `runner:${digest}` || value.keyId !== `ed25519:${digest}`) {
    throw new Error('identity IDs do not match canonical Ed25519 SPKI')
  }
  return value
}

export interface OperationPayload extends Record<string, JsonValue> {
  operation: string
  runnerId: string
  keyId: string
  requestId: string
  sequence: string
  nonce: string
  timestamp: string
}

export function signOperation<T extends OperationPayload>(identity: Identity, operation: T, now = new Date()): Signed<T> {
  if (operation.runnerId !== identity.value.runnerId || operation.keyId !== identity.value.keyId) {
    throw new Error('operation identity mismatch')
  }
  return identity.sign(operation, now)
}

export class CredentialFileStore {
  constructor(private readonly path: string) {}
  save(value: { orchestratorPublicKey: string; credential: Signed<unknown> }): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, this.path)
  }
  load(): { orchestratorPublicKey: string; credential: Signed<unknown> } | null {
    try { return JSON.parse(readFileSync(this.path, 'utf8')) as { orchestratorPublicKey: string; credential: Signed<unknown> } } catch { return null }
  }
}

export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

