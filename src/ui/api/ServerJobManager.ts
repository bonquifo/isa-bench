import type { BackendClient, BackendEvent, BackendJob } from '../backendClient.ts'

export interface ManagedServerJob {
  lane: string
  job: BackendJob | null
  events: BackendEvent[]
  running: boolean
  error: string | null
  lastEventId: number
}

interface PersistedJob {
  id: string
  lane: string
  lastEventId: number
}

export interface JobStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const STORAGE_KEY = 'isa-sim.server-jobs.v1'
const TERMINAL = new Set<BackendJob['state']>(['succeeded', 'failed', 'cancelled'])

export class ServerJobManager {
  private readonly jobs = new Map<string, ManagedServerJob>()
  private readonly pending = new Map<string, AbortController>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly cancelledIds = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private reconnecting: Promise<void> | null = null
  private readonly client: BackendClient
  private readonly storage: JobStorage | null

  constructor(
    client: BackendClient,
    storage: JobStorage | null = browserStorage(),
  ) {
    this.client = client
    this.storage = storage
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): ManagedServerJob[] {
    return [...this.jobs.values()]
  }

  latest(lane: string): ManagedServerJob | null {
    return this.list().filter((entry) => entry.lane === lane).at(-1) ?? null
  }

  async reconnectPersisted(): Promise<void> {
    if (this.reconnecting) return this.reconnecting
    this.reconnecting = this.reconnectStored()
    try {
      await this.reconnecting
    } finally {
      this.reconnecting = null
    }
  }

  async run(
    lane: string,
    submit: (signal: AbortSignal) => Promise<BackendJob>,
  ): Promise<BackendJob | null> {
    if (this.pending.has(lane) || this.latest(lane)?.running) return this.latest(lane)?.job ?? null
    const controller = new AbortController()
    this.pending.set(lane, controller)
    this.jobs.set(`pending:${lane}`, {
      lane,
      job: null,
      events: [],
      running: true,
      error: null,
      lastEventId: 0,
    })
    this.emit()
    try {
      const accepted = await submit(controller.signal)
      this.jobs.delete(`pending:${lane}`)
      const entry: ManagedServerJob = {
        lane,
        job: accepted,
        events: [],
        running: !TERMINAL.has(accepted.state),
        error: accepted.state === 'failed' ? accepted.error?.message ?? 'Backend job failed.' : null,
        lastEventId: 0,
      }
      this.jobs.set(accepted.id, entry)
      this.controllers.set(accepted.id, controller)
      this.persist()
      this.emit()
      if (controller.signal.aborted) {
        await this.cancelAndFinish(accepted.id)
        return this.jobs.get(accepted.id)?.job ?? null
      }
      await this.monitor(accepted.id, controller)
      return this.jobs.get(accepted.id)?.job ?? null
    } catch (error) {
      this.jobs.delete(`pending:${lane}`)
      if (!controller.signal.aborted) {
        this.jobs.set(`error:${lane}:${Date.now()}`, {
          lane,
          job: null,
          events: [],
          running: false,
          error: error instanceof Error ? error.message : String(error),
          lastEventId: 0,
        })
      }
      this.emit()
      return null
    } finally {
      this.pending.delete(lane)
    }
  }

  cancelLane(lane: string): void {
    const pending = this.pending.get(lane)
    if (pending) {
      pending.abort('cancel requested before acceptance')
      return
    }
    const active = this.latest(lane)
    if (!active?.job || !active.running) return
    this.controllers.get(active.job.id)?.abort('cancel requested')
  }

  acknowledge(id: string): void {
    const entry = this.jobs.get(id)
    if (!entry?.job || !TERMINAL.has(entry.job.state)) return
    this.jobs.delete(id)
    this.persist()
    this.emit()
  }

  private async reconnectStored(): Promise<void> {
    for (const record of this.readPersisted()) {
      try {
        const job = await this.client.getJob(record.id)
        const entry: ManagedServerJob = {
          lane: record.lane,
          job,
          events: [],
          running: !TERMINAL.has(job.state),
          error: job.state === 'failed' ? job.error?.message ?? 'Backend job failed.' : null,
          lastEventId: record.lastEventId,
        }
        this.jobs.set(record.id, entry)
        this.emit()
        if (!TERMINAL.has(job.state)) {
          const controller = new AbortController()
          this.controllers.set(record.id, controller)
          void this.monitor(record.id, controller)
        }
      } catch (error) {
        this.jobs.set(record.id, {
          lane: record.lane,
          job: null,
          events: [],
          running: false,
          error: error instanceof Error ? error.message : String(error),
          lastEventId: record.lastEventId,
        })
      }
    }
    this.persist()
    this.emit()
  }

  private async monitor(id: string, controller: AbortController): Promise<void> {
    let attempts = 0
    try {
      for (;;) {
        const entry = this.jobs.get(id)
        if (!entry?.job || TERMINAL.has(entry.job.state)) break
        try {
          await this.client.stream(id, (event) => {
            const current = this.jobs.get(id)
            if (!current || event.id <= current.lastEventId) return
            current.lastEventId = event.id
            current.events = [...current.events, event]
            this.persist()
            this.emit()
          }, controller.signal, entry.lastEventId)
          const snapshot = await this.client.getJob(id, controller.signal)
          this.updateJob(id, snapshot)
          if (TERMINAL.has(snapshot.state)) break
        } catch (error) {
          if (controller.signal.aborted) throw error
        }
        attempts += 1
        await delay(Math.min(250 * 2 ** attempts, 4_000), controller.signal)
      }
      if (!controller.signal.aborted) this.updateJob(id, await this.client.getJob(id))
    } catch {
      if (controller.signal.aborted) await this.cancelAndFinish(id)
    } finally {
      this.controllers.delete(id)
    }
  }

  private async cancelAndFinish(id: string): Promise<void> {
    const current = this.jobs.get(id)
    if (!current?.job) return
    let job = this.cancelledIds.has(id)
      ? await this.client.getJob(id)
      : await this.client.cancel(id)
    this.cancelledIds.add(id)
    for (let attempt = 0; attempt < 40 && !TERMINAL.has(job.state); attempt += 1) {
      await delay(100 + attempt * 25)
      job = await this.client.getJob(id)
    }
    this.updateJob(id, job)
  }

  private updateJob(id: string, job: BackendJob): void {
    const entry = this.jobs.get(id)
    if (!entry) return
    entry.job = job
    entry.running = !TERMINAL.has(job.state)
    entry.error = job.state === 'failed' ? job.error?.message ?? 'Backend job failed.' : null
    this.persist()
    this.emit()
  }

  private readPersisted(): PersistedJob[] {
    try {
      const value = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? '[]') as unknown
      if (!Array.isArray(value)) return []
      return value.filter((item): item is PersistedJob => Boolean(
        item && typeof item === 'object' &&
        typeof (item as PersistedJob).id === 'string' &&
        typeof (item as PersistedJob).lane === 'string' &&
        Number.isSafeInteger((item as PersistedJob).lastEventId),
      ))
    } catch {
      return []
    }
  }

  private persist(): void {
    if (!this.storage) return
    const records = this.list().flatMap((entry): PersistedJob[] => entry.job
      ? [{ id: entry.job.id, lane: entry.lane, lastEventId: entry.lastEventId }]
      : [])
    try {
      if (records.length) this.storage.setItem(STORAGE_KEY, JSON.stringify(records))
      else this.storage.removeItem(STORAGE_KEY)
    } catch {}
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function browserStorage(): JobStorage | null {
  try {
    return globalThis.sessionStorage ?? globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}
