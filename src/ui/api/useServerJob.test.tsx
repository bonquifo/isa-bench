import { describe, expect, it, vi } from 'vitest'
import type { BackendClient, BackendJob } from '../backendClient.ts'
import { submitWithAbortReconciliation } from './useServerJob.ts'

const accepted: BackendJob = {
  id: 'delayed-job', state: 'queued', version: 0, progress: 0, result: null, error: null,
}
const cancelled: BackendJob = { ...accepted, state: 'cancelled', version: 2 }

describe('server job pre-submission cancellation', () => {
  it('cancels a delayed accepted job exactly once and returns terminal status', async () => {
    let resolveSubmit!: (job: BackendJob) => void
    const submit = vi.fn((_signal: AbortSignal) => new Promise<BackendJob>((resolve) => { resolveSubmit = resolve }))
    const client = {
      cancel: vi.fn(async () => ({ ...accepted, state: 'cancelling' })),
      getJob: vi.fn(async () => cancelled),
    } as unknown as BackendClient
    const controller = new AbortController()
    const pending = submitWithAbortReconciliation(submit, controller.signal, client)
    controller.abort('cancel before acceptance')
    resolveSubmit(accepted)
    expect(await pending).toEqual({ job: cancelled, cancelledBeforeAcceptance: true })
    expect(client.cancel).toHaveBeenCalledOnce()
    expect(client.cancel).toHaveBeenCalledWith('delayed-job')
    expect(client.getJob).toHaveBeenCalledWith('delayed-job')
  })

  it('deduplicates cancel requests for the same accepted job', async () => {
    const client = {
      cancel: vi.fn(async () => cancelled),
      getJob: vi.fn(async () => cancelled),
    } as unknown as BackendClient
    const controller = new AbortController()
    controller.abort()
    const cancelledIds = new Set<string>()
    await submitWithAbortReconciliation(async () => accepted, controller.signal, client, cancelledIds)
    await submitWithAbortReconciliation(async () => accepted, controller.signal, client, cancelledIds)
    expect(client.cancel).toHaveBeenCalledOnce()
    expect(client.getJob).toHaveBeenCalledOnce()
  })
})
