import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompareInput, CompareResult } from '../engine/index.ts'
import type { BackendClient } from './backendClient.ts'

const browserResult = { source: 'browser' } as unknown as CompareResult
const browserRun = vi.fn(async () => browserResult)

vi.mock('../engine/index.ts', async (original) => ({
  ...await original(),
  runComparisonAsync: browserRun,
}))

const { runControlled } = await import('./runController.ts')

const input = {
  workloadId: 'dot_product',
  n: 4,
  seed: 1,
  isas: ['riscv'],
  hardwareMode: 'same',
  profileId: 'equal-inorder',
} as unknown as CompareInput
const actualEngine = await vi.importActual<typeof import('../engine/index.ts')>('../engine/index.ts')
const backendResult = actualEngine.runComparison(input)

beforeEach(() => browserRun.mockClear())

describe('run controller', () => {
  it('returns a healthy backend result and forwards progress', async () => {
    const progress = vi.fn()
    const client = {
      healthy: vi.fn(async () => true),
      submit: vi.fn(async () => ({ id: 'job-1' })),
      stream: vi.fn(async (_id: string, listener: (event: unknown) => void) => {
        listener({
          id: 1,
          jobId: 'job-1',
          kind: 'progress',
          at: new Date().toISOString(),
          data: { fraction: 0.5, phase: 'MODEL', detail: 'working' },
        })
      }),
      getJob: vi.fn(async () => ({ id: 'job-1', state: 'succeeded' })),
      result: vi.fn(async () => backendResult),
      cancel: vi.fn(),
    } as unknown as BackendClient
    await expect(runControlled(input, progress, { mode: 'auto', client })).resolves.toEqual(backendResult)
    expect(progress).toHaveBeenCalledWith({ ratio: 0.5, phase: 'MODEL', detail: 'working' })
    expect(browserRun).not.toHaveBeenCalled()
  })

  it('rejects malformed or unknown-field backend CompareResult payloads', async () => {
    const client = {
      healthy: vi.fn(async () => true),
      submit: vi.fn(async () => ({ id: 'job-1' })),
      stream: vi.fn(async () => undefined),
      getJob: vi.fn(async () => ({ id: 'job-1', state: 'succeeded' })),
      result: vi.fn(async () => ({ ...backendResult, forged: true })),
    } as unknown as BackendClient
    await expect(runControlled(input, vi.fn(), { mode: 'backend', client })).rejects.toThrow()
  })

  it('falls back only when health proves no submission was accepted', async () => {
    const client = {
      healthy: vi.fn(async () => false),
      submit: vi.fn(),
    } as unknown as BackendClient
    await expect(runControlled(input, vi.fn(), { mode: 'auto', client })).resolves.toBe(browserResult)
    expect(browserRun).toHaveBeenCalledOnce()
    expect(client.submit).not.toHaveBeenCalled()
  })

  it('never silently falls back after submission is attempted or accepted', async () => {
    const client = {
      healthy: vi.fn(async () => true),
      submit: vi.fn(async () => { throw new Error('submission outcome unknown') }),
    } as unknown as BackendClient
    await expect(runControlled(input, vi.fn(), { mode: 'auto', client })).rejects.toThrow('submission outcome unknown')
    expect(browserRun).not.toHaveBeenCalled()
  })
})
