import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from './artifacts.js'
import { JobDatabase } from './database.js'

const roots: string[] = []
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'isa-sim-storage-'))
  roots.push(root)
  return root
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('artifact store', () => {
  it('addresses bytes by verified SHA-256 and rejects traversal and limits', () => {
    const store = new ArtifactStore(fresh(), 8, { count: 10, bytes: 100, ageMs: 10_000 })
    const metadata = store.put('hello', { mimeType: 'text/plain', filename: '../hello.txt' })
    expect(metadata.id).toBe(createHash('sha256').update('hello').digest('hex'))
    expect(store.read(metadata.id).toString()).toBe('hello')
    expect(() => store.read('../../etc/passwd')).toThrow('invalid artifact id')
    expect(() => store.put('too many bytes')).toThrow('size limit')
  })

  it('detects content tampering', () => {
    const root = fresh()
    const store = new ArtifactStore(root, 100, { count: 10, bytes: 100, ageMs: 10_000 })
    const metadata = store.put('original')
    writeFileSync(join(root, metadata.id.slice(0, 2), metadata.id), 'changed!')
    expect(() => store.read(metadata.id)).toThrow('hash mismatch')
  })
})

describe('durable state', () => {
  it('roundtrips tagged IEEE values through SQLite', () => {
    const database = new JobDatabase(join(fresh(), 'ieee.sqlite'))
    const created = database.create('ieee-job', {
      schemaVersion: 'server-job-request-v1',
      lane: 'analytical-inorder',
      input: { nan: Number.NaN, infinity: Infinity, negativeInfinity: -Infinity, negativeZero: -0 },
    })
    database.close()
    const reopened = new JobDatabase(join(roots.at(-1)!, 'ieee.sqlite'))
    const input = reopened.get(created.id)!.request.input as Record<string, number>
    expect(Number.isNaN(input.nan)).toBe(true)
    expect(input.infinity).toBe(Infinity)
    expect(input.negativeInfinity).toBe(-Infinity)
    expect(Object.is(input.negativeZero, -0)).toBe(true)
    reopened.close()
  })

  it('recovers a running job to interrupted failure once', () => {
    const path = join(fresh(), 'jobs.sqlite')
    const first = new JobDatabase(path)
    const queued = first.create('restart-job', {
      schemaVersion: 'server-job-request-v1',
      lane: 'analytical-inorder',
      input: 1,
    })
    const assigned = first.transition(queued.id, Number(queued.revision), 'assigned', 'test')
    first.transition(assigned.id, Number(assigned.revision), 'running', 'test')
    first.close()
    const second = new JobDatabase(path)
    const recovered = second.get('restart-job')!
    expect(recovered.state).toBe('failed')
    expect(recovered.error).toMatchObject({ code: 'interrupted', interrupted: true })
    expect(second.eventReplay('restart-job').filter((event) => event.type === 'error')).toHaveLength(1)
    second.close()
  })
})
