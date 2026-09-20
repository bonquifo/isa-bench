import { useEffect, useState, type KeyboardEvent } from 'react'
import type { BackendState } from '../ui/api/useBackend.ts'
import type { BackendClient } from '../ui/backendClient.ts'
import { Unavailable } from './ToolchainLane.tsx'
import { EmpiricalAdminActions } from './EmpiricalAdminActions.tsx'
import { nextRovingIndex } from './types.ts'
import { LaneToolbar } from './LaneToolbar.tsx'

const TABS = ['Runners', 'Jobs & leases', 'Imports', 'Raw runs', 'Summaries', 'Datasets & splits', 'Calibration lifecycle'] as const

export function EmpiricalLane({ client, backend }: { client: BackendClient; backend: BackendState }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Runners')
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const selectedIndex = TABS.indexOf(tab)
  function keyNavigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextRovingIndex(event.key, index, TABS.length)
    if (next < 0) return
    event.preventDefault()
    setTab(TABS[next]!)
    document.getElementById(`empirical-tab-${next}`)?.focus()
  }
  useEffect(() => {
    if (backend.status !== 'online') return
    const controller = new AbortController()
    Promise.all([
      client.empiricalOverview(controller.signal),
      client.calibrationCatalog(controller.signal),
      client.calibrationStatus(controller.signal),
    ]).then(([empirical, calibration, status]) => setData({ ...empirical, ...calibration, status }), (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => controller.abort()
  }, [backend.status, client, revision])
  if (backend.status !== 'online') return <>
    <LaneToolbar
      title="Empirical Calibration Lab"
      kicker="EMPIRICAL ADMIN"
      running={false}
      disabled
      disabledReason={backend.reason}
      onRun={() => undefined}
    />
    <Unavailable reason={backend.reason} />
  </>
  const key = ({
    Runners: 'runners',
    'Jobs & leases': 'jobs',
    Imports: 'imports',
    'Raw runs': 'runs',
    Summaries: 'summaries',
    'Datasets & splits': 'datasets',
    'Calibration lifecycle': 'calibrations',
  } as const)[tab]
  const rows: Record<string, unknown>[] = tab === 'Datasets & splits'
    ? [
        ...(Array.isArray(data?.datasets) ? data.datasets as Record<string, unknown>[] : []).map((row) => ({ ...row, recordKind: 'dataset' })),
        ...(Array.isArray(data?.splits) ? data.splits as Record<string, unknown>[] : []).map((row) => ({ ...row, recordKind: 'split' })),
      ]
    : Array.isArray(data?.[key]) ? data[key] as Record<string, unknown>[] : []
  return (
    <section className="space-y-4">
      <LaneToolbar
        title="Empirical Calibration Lab"
        kicker="EMPIRICAL ADMIN"
        running={false}
        disabled
        disabledReason="This admin lab has no model to execute. RUN MODEL stays unavailable until a signed runner imports committed evidence."
        onRun={() => undefined}
      />
      <header className="hud-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="hud-title">Empirical Calibration Lab</h2><span className="category-label">EMPIRICAL ADMIN</span></div>
        <p className="mt-2 text-sm text-white/55">Only protocol-valid committed evidence can enter summaries or datasets. Quarantined imports are unverified admin records and cannot aggregate.</p>
      </header>
      <div className="tab-strip" role="tablist" aria-label="Empirical lab sections">
        {TABS.map((name, index) => <button key={name} id={`empirical-tab-${index}`} type="button" role="tab" aria-selected={selectedIndex === index} aria-controls={`empirical-panel-${index}`} tabIndex={selectedIndex === index ? 0 : -1} className={`hud-tab ${tab === name ? 'hud-tab-on' : ''}`} onKeyDown={(event) => keyNavigate(event, index)} onClick={() => setTab(name)}>{name}</button>)}
      </div>
      {TABS.map((name, index) => <div key={name} id={`empirical-panel-${index}`} role="tabpanel" aria-labelledby={`empirical-tab-${index}`} hidden={selectedIndex !== index} tabIndex={0} className="space-y-4">
        {selectedIndex === index && <>
          {error && <div role="alert" className="border border-magenta p-4 text-pink-200">{error}</div>}
          {!error && !data && <div className="hud-panel p-10 text-center" aria-live="polite">Loading authenticated production state…</div>}
          {data && rows.length === 0 && <HonestEmpty tab={tab} />}
          {rows.length > 0 && <ul className="space-y-3">{rows.map((row, rowIndex) => <li className="hud-panel p-4" key={String(row.id ?? rowIndex)}>
            <div className="flex flex-wrap justify-between gap-2"><strong>{String(row.id ?? row.hash ?? `${tab} record`)}</strong>{key === 'imports' && <span className="category-label">QUARANTINED IMPORT</span>}</div>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(row, null, 2)}</pre>
          </li>)}</ul>}
          {data && <EmpiricalAdminActions client={client} tab={tab} data={data} onChanged={() => setRevision((value) => value + 1)} />}
          <p className="font-mono text-xs text-white/40">Administrative mutations require a short-lived authenticated session, an explicit confirmation, and optimistic version matching. This screen performs no mutation implicitly.</p>
        </>}
      </div>)}
    </section>
  )
}

export function HonestEmpty({ tab }: { tab: string }) {
  return <div className="hud-panel p-10 text-center">
    <h3 className="font-display text-lg">No production {tab.toLowerCase()} data</h3>
    <p className="mx-auto mt-2 max-w-2xl text-white/50">This is the real empty database state. Enroll and approve a runner, submit an eligible job, then inspect and explicitly commit its signed evidence before creating summaries, frozen datasets, or calibrations.</p>
  </div>
}
