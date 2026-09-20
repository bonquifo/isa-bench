import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { taggedJsonParse, taggedJsonStringify } from '@isa-sim/contracts'
import { runComparison, type CompareInput } from '../../src/engine/compare.ts'
import { runOoOComparison } from '../../src/engine/ooo-compare.ts'
import { createBackend, type Backend } from './app.js'

let backend: Backend | null = null
let root = ''

afterEach(async () => {
  if (backend) await backend.app.close()
  if (root) rmSync(root, { recursive: true, force: true })
  backend = null
  root = ''
})

it('returns a byte-for-byte equivalent browser model result', async () => {
  root = mkdtempSync(join(tmpdir(), 'isa-sim-parity-'))
  backend = await createBackend({ dataDir: root, concurrency: 1, jobTimeoutMs: 30_000 })
  const input: CompareInput = {
    workloadId: 'int_sum',
    n: 8,
    seed: 42,
    isas: ['riscv'],
    hardwareMode: 'same',
    profileId: 'equal-inorder',
  }
  const session = await backend.app.inject({ method: 'POST', url: '/api/session' })
  const { token } = session.json() as { token: string }
  const submitted = await backend.app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: { 'x-session-token': token },
    payload: { lane: 'analytical-inorder', input },
  })
  const { id } = submitted.json() as { id: string }
  let result: unknown
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = backend.db.get(id)!
    if (job.state === 'succeeded') {
      result = taggedJsonParse(backend.artifacts.read(job.terminalResultArtifactId!).toString('utf8'))
      break
    }
    if (job.state === 'failed') throw new Error(job.error?.message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(taggedJsonStringify(result)).toBe(taggedJsonStringify(runComparison(input)))
})

it('runs the analytical OoO worker lane with browser-equivalent model rows', async () => {
  root = mkdtempSync(join(tmpdir(), 'isa-sim-ooo-parity-'))
  backend = await createBackend({ dataDir: root, concurrency: 1, jobTimeoutMs: 30_000 })
  const input: CompareInput = {
    workloadId: 'custom',
    n: 1,
    seed: 4,
    isas: ['riscv'],
    hardwareMode: 'same',
    profileId: 'equal-inorder',
    customSource: 'imm r0, 6\nimm r1, 7\nmul r2, r0, r1\nhalt r2',
  }
  const expected = runOoOComparison(input)
  const session = await backend.app.inject({ method: 'POST', url: '/api/session' })
  const { token } = session.json() as { token: string }
  const submitted = await backend.app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: { 'x-session-token': token },
    payload: { lane: 'analytical-ooo', input },
  })
  expect(submitted.statusCode).toBe(202)
  const { id } = submitted.json() as { id: string }
  let result: ReturnType<typeof runOoOComparison> | undefined
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = backend.db.get(id)!
    if (job.state === 'succeeded') {
      result = taggedJsonParse(backend.artifacts.read(job.terminalResultArtifactId!).toString('utf8')) as ReturnType<typeof runOoOComparison>
      break
    }
    if (job.state === 'failed') throw new Error(job.error?.message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(result?.rows).toEqual(expected.rows)
  expect(result?.envelopes[0]).toMatchObject({
    experimentKind: 'analytical-ooo',
    modelVersion: 'ooo-1.2.0',
  })
})
