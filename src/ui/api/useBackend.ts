import { useEffect, useMemo, useState } from 'react'
import { BackendClient, type BackendCapabilities } from '../backendClient.ts'

export type BackendState =
  | { status: 'checking'; capabilities: null; reason: string }
  | { status: 'online'; capabilities: BackendCapabilities; reason: string }
  | { status: 'offline'; capabilities: null; reason: string }

export function useBackend(): { client: BackendClient; backend: BackendState; refresh: () => void } {
  const client = useMemo(() => new BackendClient(), [])
  const [revision, setRevision] = useState(0)
  const [backend, setBackend] = useState<BackendState>({
    status: 'checking',
    capabilities: null,
    reason: 'Probing the local backend…',
  })
  useEffect(() => {
    const controller = new AbortController()
    client.capabilities(controller.signal).then(
      (capabilities) => setBackend({
        status: 'online',
        capabilities,
        reason: desktopEmbedded()
          ? 'Embedded backend is running inside this program.'
          : 'Local backend connected.',
      }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        setBackend({
          status: 'offline',
          capabilities: null,
          reason: desktopBackendReason(error),
        })
      },
    )
    return () => controller.abort()
  }, [client, revision])
  return {
    client,
    backend,
    refresh: () => {
      setBackend({ status: 'checking', capabilities: null, reason: 'Probing the local backend…' })
      setRevision((value) => value + 1)
    },
  }
}

function desktopEmbedded(): boolean {
  return typeof globalThis.window !== 'undefined' && globalThis.window.isaBenchDesktop?.embedded === true
}

function desktopBackendReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return desktopEmbedded()
    ? `Embedded backend unavailable: ${detail}. Controlled models remain available in this window.`
    : `Local backend unavailable: ${detail}. Start it with npm run server. Controlled models remain available.`
}

export function capabilityReason(backend: BackendState, lane: string): { available: boolean; reason: string } {
  if (backend.status !== 'online') return { available: false, reason: backend.reason }
  const capability = backend.capabilities.lanes.find((item) => item.id === lane)
  return capability ?? { available: false, reason: `Backend did not advertise ${lane}.` }
}
