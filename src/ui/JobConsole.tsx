import type { BackendClient } from './backendClient.ts'
import type { ServerJobState } from './api/useServerJob.ts'

export function JobConsole({
  client,
  state,
  onCancel,
}: {
  client: BackendClient
  state: ServerJobState
  onCancel: () => void
}) {
  const artifacts = state.events.flatMap((event) => {
    const artifact = event.data.artifact
    return artifact && typeof artifact === 'object' ? [artifact as { id?: string; filename?: string; sha256?: string }] : []
  })
  return (
    <section className="hud-panel mt-4 p-4" aria-live="polite" aria-busy={state.running}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-sm uppercase tracking-widest">Job progress</h3>
        {state.running && <button type="button" className="hud-tab" onClick={onCancel}>CANCEL JOB</button>}
      </div>
      {state.job && (
        <p className="mt-2 font-mono text-xs text-cyan-100/70">
          immutable job {state.job.id} · {state.job.state} · {Math.round(state.job.progress * 100)}%
        </p>
      )}
      <ol className="job-log mt-3" aria-label="Backend event log">
        {state.events.map((event) => (
          <li key={event.id}>
            <time>{event.at}</time> <strong>{event.kind}</strong>{' '}
            {String(event.data.detail ?? event.data.message ?? event.data.reason ?? '')}
          </li>
        ))}
      </ol>
      {artifacts.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {artifacts.map((artifact) => artifact.id && (
            <li key={artifact.id}>
              <a className="text-cyan-300 underline" href={client.artifactUrl(artifact.id)}>
                {artifact.filename ?? artifact.id}
              </a>
              <span className="ml-2 font-mono text-xs text-white/40">sha256 {artifact.sha256 ?? artifact.id}</span>
            </li>
          ))}
        </ul>
      )}
      {state.error && (
        <details className="mt-3 border border-magenta/50 bg-[#2a041c] p-3 text-pink-100" open>
          <summary className="font-mono text-xs">TERMINAL ERROR DETAILS</summary>
          <pre className="mt-2 whitespace-pre-wrap text-xs">{state.error}</pre>
        </details>
      )}
    </section>
  )
}
