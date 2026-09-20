import { useEffect, useMemo, useState } from 'react'
import { EnvelopeBadges } from '../ui/Evidence.tsx'
import { JobConsole } from '../ui/JobConsole.tsx'
import type { BackendState } from '../ui/api/useBackend.ts'
import { useServerJob } from '../ui/api/useServerJob.ts'
import type { BackendClient, CorpusIndex } from '../ui/backendClient.ts'
import { Unavailable } from './ToolchainLane.tsx'
import { canonicalDownload, externalClaim, parseExternalResult } from './externalResult.ts'
import { LaneToolbar } from './LaneToolbar.tsx'

type Engine = 'gem5' | 'llvm-mca' | 'champsim'

export function ExternalLane({ client, backend }: { client: BackendClient; backend: BackendState }) {
  const [engine, setEngine] = useState<Engine>('gem5')
  const [corpus, setCorpus] = useState<CorpusIndex | null>(null)
  const [corpusError, setCorpusError] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const [iterations, setIterations] = useState(100)
  const job = useServerJob(client, engine)
  useEffect(() => {
    if (backend.status !== 'online') return
    const controller = new AbortController()
    client.corpus(true, controller.signal).then(setCorpus, (error: unknown) => {
      if (controller.signal.aborted) return
      const detail = error instanceof Error ? error.message : String(error)
      // An unbuilt native corpus is a normal capability-gated state; only a
      // genuinely unexpected failure belongs in the error slot.
      if (detail.includes('native_corpus_not_found')) {
        setCorpus({ schemaVersion: 0, corpusVersion: '', records: [] })
        setCorpusError(null)
        return
      }
      setCorpusError(detail)
    })
    return () => controller.abort()
  }, [backend.status, client])
  const capabilities = useMemo(
    () => backend.status === 'online'
      ? backend.capabilities.external.filter((item) => item.engine === engine)
      : [],
    [backend, engine],
  )
  const records = useMemo(() => engine === 'champsim' ? [] : (corpus?.records ?? []).filter((record) =>
    capabilities.some((item) => item.target === record.target && item.tier === 'execute')), [capabilities, corpus, engine])
  const record = records.find((item) => artifactId(item) === selected) ?? records[0]
  const exactCapability = capabilities.find((item) => item.target === record?.target)
  const available = engine !== 'champsim' && Boolean(record && exactCapability?.tier === 'execute')
  const corpusReason = backend.status === 'online' ? backend.capabilities.nativeCorpus.reason : undefined
  const unavailableDetail = corpusError ?? [
    backend.reason,
    corpusReason ? `Native corpus: ${corpusReason}.` : null,
    'No executable engine/target and eligible native corpus artifact pair is available.',
  ].filter(Boolean).join(' ')
  const disabledReason = engine === 'champsim'
    ? 'ChampSim is import-only until an approved committed microtrace exists.'
    : unavailableDetail
  return (
    <div>
      <LaneToolbar
        title="Research simulators"
        kicker="EXTERNAL LAB"
        running={job.state.running}
        disabled={!available}
        disabledReason={!available ? disabledReason : undefined}
        onRun={() => {
          if (!record) return
          const id = artifactId(record)
          void job.run((signal) => client.submitJob(engine, {
            target: record.target,
            artifactId: id,
            ...(engine === 'llvm-mca' ? { iterations } : {}),
          }, signal))
        }}
        onCancel={job.cancel}
      />
    <div className="lane-grid">
      <aside className="hud-panel space-y-4 p-4">
        <span className="category-label">EXTERNAL LAB</span>
        <p className="text-sm text-white/55">RUN MODEL starts gem5 or llvm-mca. ChampSim has no execute path.</p>
        <label className="block"><span className="hud-kicker">Engine</span><select className="hud-input mt-1" value={engine} onChange={(event) => {
          setEngine(event.target.value as Engine)
          setSelected('')
        }}><option value="gem5">gem5 O3 dynamic</option><option value="llvm-mca">llvm-mca static region</option><option value="champsim">ChampSim committed trace</option></select></label>
        {engine !== 'champsim' && <label className="block"><span className="hud-kicker">Eligible native corpus artifact</span><select className="hud-input mt-1" value={record ? artifactId(record) : ''} onChange={(event) => setSelected(event.target.value)}>
          {records.length === 0 && <option value="">No eligible record</option>}
          {records.map((item) => <option key={artifactId(item)} value={artifactId(item)}>{item.workload} · {item.target}</option>)}
        </select></label>}
        {engine === 'llvm-mca' && <label className="block"><span className="hud-kicker">Iterations</span><input className="hud-input mt-1" type="number" min={1} max={1_000_000} value={iterations} onChange={(event) => setIterations(Number(event.target.value))} /></label>}
        {engine === 'champsim' && <Unavailable reason="Import-only: no approved, producer-bound committed microtrace/manifest pair exists. Native corpus binaries are never accepted by ChampSim." />}
        {exactCapability && <div className="text-sm"><p>{exactCapability.tier} · {exactCapability.reason}</p><p className="font-mono text-xs text-white/45">{exactCapability.image}</p></div>}
        {!available && engine !== 'champsim' && <Unavailable reason={unavailableDetail} />}
      </aside>
      <section className="min-w-0">
        <JobConsole client={client} state={job.state} onCancel={job.cancel} />
        {job.state.job?.state === 'succeeded' && <ExternalReport client={client} value={job.state.job.result} />}
      </section>
    </div>
    </div>
  )
}

export function ExternalReport({ client, value }: { client: BackendClient; value: unknown }) {
  let result
  try {
    result = parseExternalResult(value)
  } catch (error) {
    return <div className="mt-4 border border-magenta p-4 text-pink-200" role="alert">INVALID EXTERNAL RESULT ENVELOPE · {error instanceof Error ? error.message : String(error)}</div>
  }
  return <article className="hud-panel mt-4 p-4">
    <div className="flex flex-wrap justify-between gap-3"><h2 className="hud-title">{result.simulator.name} report</h2><EnvelopeBadges envelope={result} primary="EXTERNAL SIMULATOR" /></div>
    <p className="mt-2">{externalClaim(result)}</p>
    <p className="font-mono text-xs text-white/50">group {result.comparisonGroupKey} · ROI {result.comparison.roiDefinitionHash}</p>
    <dl className="metric-grid mt-4">{result.metrics.map((metric) => <div key={`${metric.domain}:${metric.name}`}><dt>{metric.name}</dt><dd>{metric.value} <small>{metric.unit} · {metric.domain}</small></dd></div>)}</dl>
    <dl className="metric-grid mt-4">
      <div><dt>Target</dt><dd>{result.target ? `${result.target.triple} · ${result.target.abi} · ${result.target.endianness}` : 'not declared'}</dd></div>
      <div><dt>Engine/version</dt><dd>{result.simulator.name} {result.simulator.version}</dd></div>
      <div><dt>Image identity</dt><dd className="break-all">{result.build?.image ? `${result.build.image.imageReference} · ${result.build.image.digest}` : 'not supplied'}</dd></div>
      <div><dt>Raw artifact</dt><dd className="break-all">{result.rawOutputArtifact.sha256}</dd></div>
    </dl>
    <p className="mt-3 text-sm">Diagnostics: {result.diagnostics?.join(' · ') || 'none'}</p>
    <details className="mt-3"><summary className="hud-kicker cursor-pointer">Configuration and provenance</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ configuration: result.configuration, normalized: result.normalized, build: result.build, artifacts: result.artifactIdentities }, null, 2)}</pre></details>
    <div className="mt-4 flex flex-wrap gap-2">
      <a className="hud-tab" href={client.artifactUrl(result.rawOutputArtifact.id)}>DOWNLOAD RAW OUTPUT</a>
      <button className="hud-tab" type="button" onClick={() => canonicalDownload(result, `${result.experimentKind}-${result.inputIdentity}.envelope.json`)}>EXPORT VALIDATED ENVELOPE</button>
    </div>
  </article>
}

function artifactId(record: Record<string, unknown>): string {
  const direct = stringValue(record.artifactId ?? record.id)
  if (direct) return direct
  const directory = stringValue(record.artifactDirectory)
  return directory?.split(/[\\/]/).at(-1) ?? ''
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
