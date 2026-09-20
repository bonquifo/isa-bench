import type { BackendClient, BackendEvent, BackendJob } from '../backendClient.ts'
import { useManagedServerJob } from './ServerJobContext.ts'

export interface ServerJobState {
  job: BackendJob | null
  events: BackendEvent[]
  running: boolean
  error: string | null
}

export function useServerJob(client: BackendClient, lane: string) {
  return useManagedServerJob(client, lane)
}

export async function submitWithAbortReconciliation(
  submit: (signal: AbortSignal) => Promise<BackendJob>,
  signal: AbortSignal,
  client: BackendClient,
  cancelledIds = new Set<string>(),
): Promise<{ job: BackendJob; cancelledBeforeAcceptance: boolean }> {
  const accepted = await submit(signal)
  if (!signal.aborted) return { job: accepted, cancelledBeforeAcceptance: false }
  const terminal = await cancelAndWait(client, accepted.id, cancelledIds)
  return { job: terminal ?? accepted, cancelledBeforeAcceptance: true }
}

async function cancelAndWait(
  client: BackendClient,
  id: string,
  cancelledIds: Set<string>,
): Promise<BackendJob | null> {
  try {
    let job = cancelledIds.has(id) ? await client.getJob(id) : await client.cancel(id)
    cancelledIds.add(id)
    for (let attempt = 0; attempt < 40 && !['cancelled', 'failed', 'succeeded'].includes(job.state); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 25))
      job = await client.getJob(id)
    }
    return job
  } catch {
    return null
  }
}
