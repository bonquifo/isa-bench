import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { BackendClient, BackendJob } from '../backendClient.ts'
import { ServerJobManager } from './ServerJobManager.ts'

export const ServerJobContext = createContext<ServerJobManager | null>(null)

export function useManagedServerJob(client: BackendClient, lane: string) {
  const shared = useContext(ServerJobContext)
  const fallback = useMemo(() => new ServerJobManager(client), [client])
  const manager = shared ?? fallback
  const [, render] = useState(0)
  useEffect(() => {
    if (!shared) void manager.reconnectPersisted()
    return manager.subscribe(() => render((value) => value + 1))
  }, [manager, shared])
  const state = manager.latest(lane) ?? {
    lane,
    job: null,
    events: [],
    running: false,
    error: null,
    lastEventId: 0,
  }
  return {
    state,
    run: (submit: (signal: AbortSignal) => Promise<BackendJob>) => manager.run(lane, submit),
    cancel: () => manager.cancelLane(lane),
  }
}
