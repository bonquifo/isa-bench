import { describe, expect, it, vi } from 'vitest'
import { BackendClient } from './backendClient.ts'

const job = {
  schemaVersion: 'server-job-v1',
  id: '5f3a4a0e-9f2a-4b1e-9d2f-6a1b2c3d4e5f',
  state: 'queued',
  revision: '0',
  progress: 0,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  request: {
    schemaVersion: 'server-job-request-v1',
    lane: 'analytical-inorder',
    input: {},
  },
}

const input = {
  workloadId: 'int_sum',
  n: 4,
  seed: 1,
  isas: ['riscv'] as const,
  hardwareMode: 'same' as const,
  profileId: 'equal-inorder',
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('backend session lifetime', () => {
  it('mints a fresh token and retries once when a cached session has expired', async () => {
    const tokens = ['expired-token', 'fresh-token']
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url)
      if (path.endsWith('/api/session')) return jsonResponse(200, { token: tokens.shift() ?? 'unused' })
      const headers = (init?.headers ?? {}) as Record<string, string>
      const token = String(headers['x-session-token'])
      seen.push(token)
      return token === 'fresh-token'
        ? jsonResponse(202, job)
        : jsonResponse(401, { error: 'session_required' })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = new BackendClient('http://127.0.0.1:4317')
      expect((await client.submit({ ...input, isas: [...input.isas] })).id).toBe(job.id)
      expect(seen).toEqual(['expired-token', 'fresh-token'])
      // The refreshed token is then reused rather than re-minted per request.
      expect((await client.submit({ ...input, isas: [...input.isas] })).id).toBe(job.id)
      expect(seen).toEqual(['expired-token', 'fresh-token', 'fresh-token'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('surfaces a persistent 401 instead of retrying forever', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/api/session')
        ? jsonResponse(200, { token: 'never-valid' })
        : jsonResponse(401, { error: 'session_required' }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = new BackendClient('http://127.0.0.1:4317')
      await expect(client.submit({ ...input, isas: [...input.isas] })).rejects.toThrow('Backend HTTP 401')
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/jobs'))).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
