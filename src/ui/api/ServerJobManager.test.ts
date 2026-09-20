import { describe, expect, it, vi } from 'vitest'
import type { BackendClient, BackendJob } from '../backendClient.ts'
import { ServerJobManager, type JobStorage } from './ServerJobManager.ts'

const queued: BackendJob = {
  id: 'job-1',
  state: 'queued',
  version: 0,
  progress: 0,
  result: null,
  error: null,
}
const succeeded: BackendJob = { ...queued, state: 'succeeded', version: 2, progress: 1 }
const cancelled: BackendJob = { ...queued, state: 'cancelled', version: 2 }

class MemoryStorage implements JobStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

describe('shared server job ownership', () => {
  it('continues monitoring when a lane view unsubscribes', async () => {
    let finishStream!: () => void
    const client = {
      stream: vi.fn(() => new Promise<void>((resolve) => { finishStream = resolve })),
      getJob: vi.fn(async () => succeeded),
      cancel: vi.fn(),
    } as unknown as BackendClient
    const manager = new ServerJobManager(client, new MemoryStorage())
    const detach = manager.subscribe(() => undefined)
    const run = manager.run('gem5', async () => queued)
    await vi.waitFor(() => expect(client.stream).toHaveBeenCalled())
    detach()
    finishStream()
    await run
    expect(manager.latest('gem5')?.job?.state).toBe('succeeded')
    expect(client.cancel).not.toHaveBeenCalled()
  })

  it('reloads persisted ownership and removes terminal jobs only after acknowledgement', async () => {
    const storage = new MemoryStorage()
    storage.setItem('isa-sim.server-jobs.v1', JSON.stringify([{ id: 'job-1', lane: 'llvm-mca', lastEventId: 7 }]))
    const client = {
      getJob: vi.fn()
        .mockResolvedValueOnce({ ...queued, state: 'running' })
        .mockResolvedValue(succeeded),
      stream: vi.fn(async () => undefined),
    } as unknown as BackendClient
    const manager = new ServerJobManager(client, storage)
    await manager.reconnectPersisted()
    await vi.waitFor(() => expect(manager.latest('llvm-mca')?.job?.state).toBe('succeeded'))
    expect(manager.latest('llvm-mca')).toMatchObject({ lastEventId: 7, job: { state: 'succeeded' } })
    expect(client.stream).toHaveBeenCalledWith('job-1', expect.any(Function), expect.any(AbortSignal), 7)
    expect(storage.values.size).toBe(1)
    manager.acknowledge('job-1')
    expect(manager.latest('llvm-mca')).toBeNull()
    expect(storage.values.size).toBe(0)
  })

  it('cancels once when acceptance arrives after pre-accept cancellation', async () => {
    let accept!: (job: BackendJob) => void
    const client = {
      cancel: vi.fn(async () => cancelled),
      getJob: vi.fn(async () => cancelled),
    } as unknown as BackendClient
    const manager = new ServerJobManager(client, new MemoryStorage())
    const run = manager.run('toolchain-validation', () => new Promise<BackendJob>((resolve) => { accept = resolve }))
    manager.cancelLane('toolchain-validation')
    accept(queued)
    await run
    expect(client.cancel).toHaveBeenCalledTimes(1)
    expect(manager.latest('toolchain-validation')?.job?.state).toBe('cancelled')
  })
})
