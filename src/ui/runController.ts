import {
  runComparisonAsync,
  type CompareInput,
  type CompareResult,
  type JackProgress,
} from '../engine/index.ts'
import { BackendClient, eventProgress, type BackendJob, type BackendMode } from './backendClient.ts'
import { parseCompareResult } from '../engine/compareSchema.ts'

export interface RunOptions {
  mode?: BackendMode
  signal?: AbortSignal
  client?: BackendClient
  managedRun?: (submit: (signal: AbortSignal) => Promise<BackendJob>) => Promise<BackendJob | null>
  managedCancel?: () => void
}

export async function runControlled(
  input: CompareInput,
  onProgress: (progress: JackProgress) => void,
  options: RunOptions = {},
): Promise<CompareResult> {
  const mode = options.mode ?? parseMode(envValue('VITE_ISA_BACKEND_MODE'))
  if (mode === 'browser') return runComparisonAsync(input, onProgress, { signal: options.signal })
  const client = options.client ?? new BackendClient()
  let jobId: string | null = null
  try {
    if (!(await client.healthy(options.signal))) {
      if (mode === 'backend') throw new Error('Local backend is unavailable')
      return runComparisonAsync(input, onProgress, { signal: options.signal })
    }
    if (options.managedRun) {
      const cancelManaged = () => options.managedCancel?.()
      options.signal?.addEventListener('abort', cancelManaged, { once: true })
      try {
        const complete = await options.managedRun((signal) => client.submit(input, signal))
        if (!complete) throw new Error('Managed backend job did not produce a terminal record')
        if (complete.state !== 'succeeded' || !complete.result) {
          throw new Error(complete.error?.message ?? `Backend job ${complete.state}`)
        }
        return parseCompareResult(complete.result)
      } finally {
        options.signal?.removeEventListener('abort', cancelManaged)
      }
    }
    const job = await client.submit(input, options.signal)
    jobId = job.id
    const abort = () => {
      if (jobId) void client.cancel(jobId).catch(() => undefined)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      let after = 0
      for (let attempt = 0; ; attempt += 1) {
        try {
          await client.stream(job.id, (event) => {
            after = Math.max(after, event.id)
            const progress = eventProgress(event)
            if (progress) onProgress(progress)
          }, options.signal, after)
          const snapshot = await client.getJob(job.id, options.signal)
          if (['succeeded', 'failed', 'cancelled'].includes(snapshot.state)) break
        } catch (error) {
          if (options.signal?.aborted) throw error
        }
        await wait(Math.min(250 * 2 ** attempt, 4000), options.signal)
      }
      return parseCompareResult(await client.result<unknown>(job.id, options.signal))
    } finally {
      options.signal?.removeEventListener('abort', abort)
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (jobId) throw error
    if (mode === 'backend') throw error
    throw error
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

function parseMode(value: unknown): BackendMode {
  return value === 'browser' || value === 'backend' ? value : 'auto'
}

function envValue(name: string): string | undefined {
  const meta = import.meta as ImportMeta & { env?: Record<string, unknown> }
  const value = meta.env?.[name]
  return typeof value === 'string' ? value : undefined
}
