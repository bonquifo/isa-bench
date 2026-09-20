import type { BackendState } from './api/useBackend.ts'

export function BackendPanel({ backend, onRefresh }: { backend: BackendState; onRefresh: () => void }) {
  const capabilities = backend.capabilities
  const embedded = typeof globalThis.window !== 'undefined' && globalThis.window.isaBenchDesktop?.embedded === true
  return (
    <details className="backend-panel" open={backend.status !== 'online'}>
      <summary className="flex cursor-pointer items-center gap-2 font-mono text-xs">
        <span className={`led ${backend.status === 'online' ? 'led-ok' : 'bg-orange-400'}`} />
        {embedded ? 'EMBEDDED BACKEND' : 'BACKEND'} {backend.status.toUpperCase()}
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-white/60">{backend.reason}</p>
        {capabilities && (
          <>
            <dl className="capability-grid">
              {capabilities.lanes.map((lane) => (
                <div key={lane.id}>
                  <dt>{lane.id}</dt>
                  <dd className={lane.available ? 'text-lime-200' : 'text-orange-200'}>
                    {lane.available ? 'available' : 'unavailable'} · {lane.reason}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="font-mono text-xs text-white/45">
              Sandbox: {capabilities.sandbox.docker?.available ? 'ready' : 'unavailable'} ·{' '}
              {capabilities.sandbox.docker?.version ?? capabilities.sandbox.docker?.detail ?? 'no engine version'}
            </p>
            {Object.keys(capabilities.toolchains.images ?? {}).length > 0 && (
              <details>
                <summary className="hud-kicker cursor-pointer">Pinned image identities</summary>
                <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(capabilities.toolchains.images, null, 2)}</pre>
              </details>
            )}
          </>
        )}
        <button type="button" className="hud-tab" onClick={onRefresh}>RECHECK</button>
      </div>
    </details>
  )
}
