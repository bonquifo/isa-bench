import { Suspense, lazy, useEffect, useState, type KeyboardEvent } from 'react'
import ControlledInOrderApp from '../App.tsx'
import { LANES, nextLaneIndex, type LaneId } from './types.ts'
import { OoOLane } from './OoOLane.tsx'
// Loaded on demand. The lane carries the precompiled RV64 binaries inlined,
// which is half a megabyte that nobody who stays on the modelling lanes
// should have to download or parse.
const RealIsaLane = lazy(() =>
  import('./RealIsaLane.tsx').then((module) => ({ default: module.RealIsaLane })))

function initialLane(): LaneId {
  const value = globalThis.location?.hash.replace(/^#\//, '') as LaneId
  return LANES.some((item) => item.id === value) ? value : 'inorder'
}

export default function MultiLaneApp() {
  const [lane, setLane] = useState<LaneId>(initialLane)
  const descriptor = LANES.find((item) => item.id === lane)!
  useEffect(() => {
    const listener = () => setLane(initialLane())
    globalThis.addEventListener('hashchange', listener)
    return () => globalThis.removeEventListener('hashchange', listener)
  }, [])
  function navigate(next: LaneId) {
    globalThis.history.pushState(null, '', `#/${next}`)
    setLane(next)
  }
  function keyNavigate(event: KeyboardEvent<HTMLElement>, index: number) {
    const next = nextLaneIndex(event.key, index)
    if (next < 0) return
    event.preventDefault()
    navigate(LANES[next]!.id)
    document.getElementById(`lane-tab-${LANES[next]!.id}`)?.focus()
  }
  return (
    <div className="min-h-svh">
      <a className="skip-link" href={`#lane-panel-${lane}`}>Skip to experiment</a>
      <header className="experiment-header">
        <div className="mx-auto max-w-[1600px] px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><p className="hud-kicker">NET//ISA · SIMULATION WORKBENCH</p><h1 className="font-display text-2xl font-bold uppercase tracking-wider">Timing models</h1></div>
            <span className="category-label">{descriptor.category}</span>
          </div>
          <nav className="experiment-nav mt-4" role="tablist" aria-label="Model selector">
            {LANES.map((item, index) => <button key={item.id} id={`lane-tab-${item.id}`} type="button" role="tab" aria-selected={lane === item.id} aria-controls={`lane-panel-${item.id}`} tabIndex={lane === item.id ? 0 : -1} className={lane === item.id ? 'active' : ''} onKeyDown={(event) => keyNavigate(event, index)} onClick={() => navigate(item.id)}>
              <span>{item.title}</span><small>{item.short}</small>
            </button>)}
          </nav>
          <p className="lane-run-hint mt-4" role="note">
            <strong>{descriptor.runLabel}</strong>
            <span>{descriptor.runHint}</span>
          </p>
        </div>
      </header>
      <main>
        {LANES.map((item) => <section
          key={item.id}
          id={`lane-panel-${item.id}`}
          role="tabpanel"
          aria-labelledby={`lane-tab-${item.id}`}
          aria-live={lane === item.id ? 'polite' : undefined}
          hidden={lane !== item.id}
          className={item.id === 'inorder' ? '' : 'mx-auto max-w-[1600px] px-4 py-5'}
          tabIndex={0}
        >
          {lane === item.id && item.id === 'inorder' && <ControlledInOrderApp />}
          {lane === item.id && item.id === 'ooo' && <OoOLane />}
          {lane === item.id && item.id === 'realisa' && (
            <Suspense fallback={<div className="hud-panel p-4 font-mono text-xs">LOADING · real RV64GC binaries</div>}>
              <RealIsaLane />
            </Suspense>
          )}
        </section>)}
      </main>
    </div>
  )
}
