import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ALL_ISAS,
  DEFAULT_OOO_PROFILE,
  DEFAULT_PROFILE_ID,
  ISA_META,
  OOO_ENERGY_MODEL_VERSION,
  OOO_MODEL_VERSION,
  WORKLOADS,
  type IsaId,
  type OoOProfile,
  type OoOCompareInput,
  type OoOResult,
} from '../engine/index.ts'
import { EvidenceBadgeView } from '../ui/Evidence.tsx'
import { LaneToolbar } from './LaneToolbar.tsx'

export function OoOLane() {
  const [workloadId, setWorkloadId] = useState('dot_product')
  const [n, setN] = useState(256)
  const [seed, setSeed] = useState(42)
  const [isas, setIsas] = useState<IsaId[]>([...ALL_ISAS])
  const [profile, setProfile] = useState<OoOProfile>(() => structuredClone(DEFAULT_OOO_PROFILE))
  const [result, setResult] = useState<OoOResult | null>(null)
  const [rerunInput, setRerunInput] = useState<OoOCompareInput | null>(null)
  const [progress, setProgress] = useState('IDLE')
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const worker = useRef<Worker | null>(null)
  const cancelReject = useRef<((reason: Error) => void) | null>(null)
  const workload = useMemo(() => WORKLOADS.find((item) => item.id === workloadId)!, [workloadId])

  useEffect(() => () => worker.current?.terminate(), [])

  function cancel() {
    worker.current?.terminate()
    worker.current = null
    cancelReject.current?.(new DOMException('OoO run cancelled', 'AbortError'))
    cancelReject.current = null
    setRunning(false)
    setProgress('CANCELLED · browser OoO worker terminated')
  }

  async function run() {
    if (!isas.length) return setError('Select at least one target.')
    const active = new Worker(new URL('./ooo.worker.ts', import.meta.url), { type: 'module' })
    worker.current = active
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const next = await new Promise<OoOResult>((resolve, reject) => {
        cancelReject.current = reject
        active.addEventListener('message', (event: MessageEvent<{ type: string; progress?: { phase: string; ratio: number; detail: string }; result?: OoOResult; error?: string }>) => {
          if (event.data.type === 'progress' && event.data.progress) {
            const value = event.data.progress
            setProgress(`${value.phase} · ${Math.round(value.ratio * 100)}% · ${value.detail}`)
          } else if (event.data.type === 'result' && event.data.result) resolve(event.data.result)
          else if (event.data.type === 'error') reject(new Error(event.data.error ?? 'OoO worker failed'))
        })
        active.addEventListener('error', (event) => reject(new Error(event.message)))
        const input: OoOCompareInput = {
        workloadId,
        n,
        seed,
        isas,
        hardwareMode: 'same',
        profileId: DEFAULT_PROFILE_ID,
        oooProfile: profile,
        }
        setRerunInput(structuredClone(input))
        active.postMessage({ type: 'run', input })
      })
      setResult(next)
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      setRunning(false)
      active.terminate()
      if (worker.current === active) worker.current = null
      cancelReject.current = null
    }
  }

  return (
    <div>
      <LaneToolbar
        title="Detailed OoO"
        kicker="MODEL"
        running={running}
        onRun={() => void run()}
        onCancel={cancel}
      />
    <div className="lane-grid">
      <aside className="hud-panel space-y-4 p-4">
        <span className="category-label">MODEL</span>
        <p className="text-sm text-white/55">Deterministic decoded-op out-of-order model. It is not a physical CPU measurement.</p>
        <label className="block">
          <span className="hud-kicker">Workload</span>
          <select className="hud-input mt-1" value={workloadId} onChange={(event) => {
            const selected = WORKLOADS.find((item) => item.id === event.target.value)!
            setWorkloadId(selected.id)
            setN(selected.defaultN)
          }}>
            {WORKLOADS.filter((item) => item.id !== 'custom').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <NumberField label={workload.nLabel} value={n} min={workload.minN} max={workload.maxN} onChange={setN} />
        {workload.usesSeed && <NumberField label="Seed" value={seed} onChange={setSeed} />}
        <fieldset>
          <legend className="hud-kicker">Targets</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {ALL_ISAS.map((isa) => <label key={isa} className="text-sm">
              <input type="checkbox" checked={isas.includes(isa)} onChange={() => setIsas((value) =>
                value.includes(isa) ? value.filter((item) => item !== isa) : [...value, isa])} /> {ISA_META[isa].short}
            </label>)}
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="hud-kicker">Validated OoO tuning · {profile.name}</legend>
          <NumberField label="Issue width" value={profile.issueWidth} min={1} max={8} onChange={(value) =>
            setProfile((current) => ({ ...current, issueWidth: value }))} />
          <NumberField label="ROB entries" value={profile.robEntries} min={16} max={512} onChange={(value) =>
            setProfile((current) => ({ ...current, robEntries: value }))} />
          <NumberField label="Physical registers" value={profile.physicalRegisters} min={64} max={512} onChange={(value) =>
            setProfile((current) => ({ ...current, physicalRegisters: value }))} />
          <NumberField label="Recovery cycles" value={profile.recoveryCycles} min={0} max={64} onChange={(value) =>
            setProfile((current) => ({ ...current, recoveryCycles: value }))} />
        </fieldset>
      </aside>
      <section className="min-w-0">
        <div className="hud-panel p-4 font-mono text-xs" aria-live="polite" aria-busy={running}>{progress}</div>
        {error && <div className="mt-4 border border-magenta p-4 text-pink-200" role="alert">{error}</div>}
        {result && rerunInput && <OoOReport result={result} rerunInput={rerunInput} />}
        {!result && !error && <Empty text="Run the browser OoO model to create a dedicated analytical report." />}
      </section>
    </div>
    </div>
  )
}

function OoOReport({ result, rerunInput }: { result: OoOResult; rerunInput: OoOCompareInput }) {
  return (
    <article className="mt-4 space-y-4">
      <header className="hud-panel p-4">
        <div className="flex flex-wrap justify-between gap-3"><h2 className="hud-title">{result.workloadName}</h2><span className="category-label">MODEL RESULT</span></div>
        <p className="mt-2 font-mono text-xs text-white/50">model {OOO_MODEL_VERSION} · metric domain analytical-model-cycles · unit model-cycle</p>
        <p className="mt-2 text-sm text-orange-200">Energy uses {OOO_ENERGY_MODEL_VERSION}; model-nJ is an uncalibrated event estimate and not measured energy.</p>
        <EnvelopeExport value={{ result, rerunInput }} filename={`ooo-${result.envelopes[0]?.inputIdentity ?? 'result'}.result.json`} label="EXPORT WHOLE OOO RESULT + EXACT RERUN INPUT" />
      </header>
      {result.rows.map((row, index) => (
        <section className="hud-panel p-4" key={row.isa}>
          <div className="flex flex-wrap justify-between gap-3">
            <div><h3 className="font-display text-lg">{ISA_META[row.isa].full}</h3><EvidenceBadgeView /></div>
            <span className="font-mono text-xs text-white/45">comparisonGroupKey {result.envelopes[index]?.comparisonGroupKey}</span>
          </div>
          <dl className="metric-grid mt-4">
            <Metric name="Model cycles" value={row.cycles} unit="model-cycle" />
            <Metric name="IPC" value={row.ipc.toFixed(3)} unit="retired op/model-cycle" />
            <Metric name="Retired" value={row.counts.retiredOps} unit="ops" />
            <Metric name="Squashed" value={row.counts.squashedOps} unit="ops" />
            <Metric name="Wrong path" value={row.counts.wrongPathOps} unit="ops" />
            <Metric name="Branch recovery" value={row.counts.branchRecoveryCycles} unit="model-cycle" />
          </dl>
          <h4 className="hud-kicker mt-5">Occupancy peak / full cycles</h4>
          <dl className="metric-grid mt-2">
            {Object.entries(row.occupancy).map(([name, value]) => <Metric key={name} name={name.toUpperCase()} value={`${value.peak} / ${value.fullCycles}`} unit="entries / model-cycles" />)}
          </dl>
          <h4 className="hud-kicker mt-5">Functional-unit utilization</h4>
          <dl className="metric-grid mt-2">
            {Object.entries(row.fuUtilization).map(([name, value]) => <Metric key={name} name={name.toUpperCase()} value={`${(value * 100).toFixed(1)}%`} unit="busy/model-cycle" />)}
          </dl>
          <details className="mt-4">
            <summary className="hud-kicker cursor-pointer">Forwarding, cache, speculation and trace</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({
              forwarding: {
                loads: row.counts.forwardedLoads,
                bytes: row.counts.forwardedBytes,
                nonaliasBypasses: row.counts.nonaliasBypasses,
              },
              branch: {
                predictions: row.counts.branchPredictions,
                mispredicts: row.counts.branchMispredicts,
                recoveryCycles: row.counts.branchRecoveryCycles,
              },
              memory: row.memory,
              trace: row.disasm,
            }, null, 2)}</pre>
          </details>
          <EnvelopeExport value={result.envelopes[index]} filename={`ooo-${row.isa}-${result.envelopes[index]?.inputIdentity ?? 'envelope'}.envelope.json`} label="EXPORT TARGET ENVELOPE" />
        </section>
      ))}
    </article>
  )
}

function EnvelopeExport({ value, filename, label }: { value: unknown; filename: string; label: string }) {
  const download = () => {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return <button type="button" className="hud-tab mt-4" onClick={download}>{label}</button>
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return <label className="block"><span className="hud-kicker">{label}</span><input className="hud-input mt-1" type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /></label>
}
function Metric({ name, value, unit }: { name: string; value: string | number; unit: string }) {
  return <div><dt>{name}</dt><dd>{value} <small>{unit}</small></dd></div>
}
function Empty({ text }: { text: string }) {
  return <div className="hud-panel mt-4 p-10 text-center text-white/45">{text}</div>
}
