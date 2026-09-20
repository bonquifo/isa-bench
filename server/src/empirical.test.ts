import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type Backend } from './app.js'

let value: Backend | undefined
let root: string | undefined
afterEach(async () => {
  await value?.app.close()
  if (root) rmSync(root, { recursive: true, force: true })
  value = undefined
  root = undefined
})

describe('empirical orchestrator is data-empty', () => {
  it('creates one-use enrollment tokens and no empirical result table', async () => {
    root = mkdtempSync(join(tmpdir(), 'isa-sim-empirical-'))
    value = await createBackend({ dataDir: root })
    const session = await value.app.inject({ method: 'POST', url: '/api/session' })
    const auth = (session.json() as { token: string }).token
    const issued = await value.app.inject({
      method: 'POST', url: '/api/empirical/enrollment/tokens',
      headers: { 'x-session-token': auth }, payload: { ttlMs: 1000 },
    })
    expect(issued.statusCode).toBe(200)
    const token = issued.json() as { id: string; token: string }
    const der = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' })
    const digest = createHash('sha256').update(der).digest('hex')
    const identity = { runnerId: `runner:${digest}`, keyId: `ed25519:${digest}`, publicKey: der.toString('base64'), issuedAt: new Date().toISOString() }
    expect((await value.app.inject({
      method: 'POST', url: '/api/empirical/enrollment/challenges',
      payload: { tokenId: token.id, token: token.token, identity },
    })).statusCode).toBe(200)
    expect((await value.app.inject({
      method: 'POST', url: '/api/empirical/enrollment/challenges',
      payload: { tokenId: token.id, token: token.token, identity },
    })).statusCode).toBe(400)
    const tables = value.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    expect(tables.some((table) => /empirical.*result/i.test(table.name))).toBe(false)
    expect(value.db.sqlite.prepare('SELECT count(*) count FROM empirical_artifacts').get()).toMatchObject({ count: 0 })
  })
})
