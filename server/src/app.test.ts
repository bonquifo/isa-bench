import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, prepareToolchainInput, type Backend } from './app.js'

const roots: string[] = []
const backends: Backend[] = []

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.app.close()))
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

async function backend(): Promise<Backend> {
  const dataDir = mkdtempSync(join(tmpdir(), 'isa-sim-server-'))
  roots.push(dataDir)
  const value = await createBackend({ dataDir, concurrency: 1, jobTimeoutMs: 30_000 })
  backends.push(value)
  return value
}

async function token(value: Backend): Promise<string> {
  const response = await value.app.inject({ method: 'POST', url: '/api/session' })
  return (response.json() as { token: string }).token
}

describe('local backend API', () => {
  it('serves health and rejects hostile origins', async () => {
    const value = await backend()
    expect((await value.app.inject({ url: '/api/health' })).statusCode).toBe(200)
    expect((await value.app.inject({
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    })).statusCode).toBe(403)
  })

  it('serves structured capabilities with immutable toolchain image identities', async () => {
    const value = await backend()
    const response = await value.app.inject({ method: 'GET', url: '/api/capabilities' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      toolchains: {
        available: boolean
        reason: string
        images: Record<string, { reference: string; imageId: string }>
      }
    }
    expect(typeof body.toolchains.available).toBe('boolean')
    expect(body.toolchains.reason).toBeTruthy()
    for (const image of Object.values(body.toolchains.images)) {
      expect(image.reference).toMatch(/^isa-sim\//)
      expect(image.imageId).toMatch(/^sha256:[a-f0-9]{64}$/)
    }
  }, 120_000)

  it('requires session auth and strict job bodies', async () => {
    const value = await backend()
    expect((await value.app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { input: {} },
    })).statusCode).toBe(401)
    const auth = await token(value)
    expect((await value.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-session-token': auth },
      payload: { input: {}, extra: true },
    })).statusCode).toBe(400)
    expect((await value.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-session-token': auth },
      payload: {
        lane: 'toolchain-validation',
        input: { canonicalIr: 'client supplied', expectedFrame: {} },
      },
    })).statusCode).toBe(400)
    expect((await value.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-session-token': auth },
      payload: { lane: 'analytical-inorder', input: {}, timeoutMs: '1000' },
    })).statusCode).toBe(400)
  })

  it('rejects host paths and commands at the high-level toolchain boundary', async () => {
    const value = await backend()
    const auth = await token(value)
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/toolchain/prepare',
      headers: { 'x-session-token': auth },
      payload: {
        input: { workloadId: 'dot_product', n: 4, seed: 1 },
        targets: ['x86_64-linux'],
        command: ['clang', 'C:\\host\\secret.ll'],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('host paths and commands are forbidden')
  })

  it('keeps ChampSim import-only without an approved trace producer', async () => {
    const value = await backend()
    const auth = await token(value)
    const index = await value.app.inject({ url: '/api/trace-corpus' })
    expect(index.statusCode).toBe(200)
    expect(index.json()).toMatchObject({
      mode: 'import-only',
      producerLockAvailable: false,
      records: [],
    })
    const imported = await value.app.inject({
      method: 'POST',
      url: '/api/trace-corpus',
      headers: { 'x-session-token': auth },
      payload: { traceArtifactId: 'a'.repeat(64), manifest: {} },
    })
    expect(imported.statusCode).toBe(422)
  })

  it('prepares canonical IR with an independent exact reference frame', async () => {
    const prepared = await prepareToolchainInput({
      workloadId: 'custom',
      n: 1,
      seed: 0,
      isas: ['x86'],
      hardwareMode: 'same',
      profileId: 'same-mid',
      customSource: 'imm r0, -1\nhalt r0\n',
    }, ['x86_64-linux']) as unknown as {
      payloadSha256: string
      payload: {
        canonicalIr: string
        targets: string[]
        expectedFrame: { kind: string; rawBits: string; stdoutBase64: string }
      }
    }
    expect(prepared.payload.canonicalIr).toContain('isa-sim canonical LLVM IR')
    expect(prepared.payload.targets).toEqual(['x86_64-linux'])
    expect(prepared.payload.expectedFrame).toEqual({
      kind: 'i32',
      rawBits: '00000000ffffffff',
      stdoutBase64: '',
    })
    expect(Object.keys(prepared.payload).sort()).toEqual([
      'canonicalIr', 'emitterVersion', 'expectedFrame', 'memoryBytes', 'targets',
    ])
    expect(Object.keys(prepared.payload.expectedFrame).sort()).toEqual(['kind', 'rawBits', 'stdoutBase64'])
    expect(prepared.payloadSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns 404s and makes queued cancellation idempotent', async () => {
    const value = await backend()
    const auth = await token(value)
    expect((await value.app.inject({ url: '/api/jobs/missing' })).statusCode).toBe(404)
    const job = value.db.create('cancel-me', jobRequest({}))
    expect(job.state).toBe('queued')
    const first = await value.app.inject({
      method: 'POST',
      url: '/api/jobs/cancel-me/cancel',
      headers: { 'x-session-token': auth },
    })
    expect(first.json().state).toBe('cancelled')
    const second = await value.app.inject({
      method: 'POST',
      url: '/api/jobs/cancel-me/cancel',
      headers: { 'x-session-token': auth },
    })
    expect(second.json().state).toBe('cancelled')
  })

  it('uses tagged IEEE JSON on REST responses', async () => {
    const value = await backend()
    value.db.create('ieee-rest', jobRequest({ nan: Number.NaN, negativeZero: -0 }))
    const response = await value.app.inject({ url: '/api/jobs/ieee-rest' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('$isaSimIeee754')
    expect(response.body).not.toContain('"nan":null')
  })

  it('serves a packaged desktop UI only from the configured static directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'isa-sim-server-'))
    const ui = join(dataDir, 'ui')
    roots.push(dataDir)
    mkdirSync(join(ui, 'assets'), { recursive: true })
    writeFileSync(join(ui, 'index.html'), '<!doctype html><title>ISA Bench Desktop</title>')
    writeFileSync(join(ui, 'assets', 'app.js'), 'window.__isaBenchDesktop=true')
    const value = await createBackend({ dataDir, staticDir: ui, concurrency: 1 })
    backends.push(value)
    const page = await value.app.inject({ url: '/' })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('ISA Bench Desktop')
    const asset = await value.app.inject({ url: '/assets/app.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.body).toContain('__isaBenchDesktop')
    expect((await value.app.inject({ url: '/missing-route' })).body).toContain('ISA Bench Desktop')
    expect((await value.app.inject({ url: '/api/not-a-route' })).statusCode).toBe(404)
    expect((await value.app.inject({
      url: '/',
      headers: { origin: 'https://evil.example' },
    })).statusCode).toBe(403)
  })

  it('reports client-side request faults as 4xx rather than internal_error', async () => {
    const value = await backend()
    const session = await token(value)
    const empty = await value.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'content-type': 'application/json' },
      payload: '',
    })
    expect(empty.statusCode).toBeGreaterThanOrEqual(400)
    expect(empty.statusCode).toBeLessThan(500)
    const malformed = await value.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'content-type': 'application/json', 'x-session-token': session },
      payload: '{ not json',
    })
    expect(malformed.statusCode).toBeGreaterThanOrEqual(400)
    expect(malformed.statusCode).toBeLessThan(500)
    expect(malformed.json()).not.toMatchObject({ error: 'internal_error' })
  })

  it('answers external lanes with a named capability or request fault, never a 500', async () => {
    const value = await backend()
    const session = await token(value)
    const submit = (input: unknown) => value.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'content-type': 'application/json', 'x-session-token': session },
      payload: { lane: 'gem5', input },
    })
    const wellFormed = await submit({ target: 'x86_64-linux', artifactId: 'a'.repeat(64) })
    expect([202, 422]).toContain(wellFormed.statusCode)
    if (wellFormed.statusCode === 422) {
      expect(wellFormed.json()).toMatchObject({ error: 'capability_unavailable', lane: 'gem5' })
      expect(String((wellFormed.json() as { detail: string }).detail).length).toBeGreaterThan(0)
    }
    const hostPath = await submit({ target: 'x86_64-linux', artifactId: 'C:\\secret\\binary.exe' })
    expect(hostPath.statusCode).toBe(400)
    expect(hostPath.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('replays terminal SSE events and closes the stream', async () => {
    const value = await backend()
    const queued = value.db.create('replay-me', jobRequest({}))
    value.db.transition(queued.id, Number(queued.revision), 'cancelled', 'test')
    const response = await value.app.inject({ url: '/api/jobs/replay-me/events?after=0' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('event: state')
    expect(response.body).toContain('event: cancelled')
  })
})

function jobRequest(input: unknown) {
  return {
    schemaVersion: 'server-job-request-v1' as const,
    lane: 'analytical-inorder' as const,
    input,
  }
}
