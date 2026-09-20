import { useEffect, useState } from 'react'
import { CalibratedPredictionResultSchema } from '@isa-sim/contracts'
import { EnvelopeBadges } from '../ui/Evidence.tsx'
import type { BackendState } from '../ui/api/useBackend.ts'
import type { BackendClient } from '../ui/backendClient.ts'
import { Unavailable } from './ToolchainLane.tsx'
import { canonicalDownload } from './externalResult.ts'
import { LaneToolbar } from './LaneToolbar.tsx'

export function CalibratedLane({ client, backend }: { client: BackendClient; backend: BackendState }) {
  const [calibrations, setCalibrations] = useState<Record<string, unknown>[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [workloadId, setWorkloadId] = useState('dot_product')
  const [target, setTarget] = useState('x86_64-linux')
  const [modelVersion, setModelVersion] = useState('inorder-1.0.0')
  const [profileId, setProfileId] = useState('same-mid')
  const [simulatorVersion, setSimulatorVersion] = useState('')
  const [toolchainHash, setToolchainHash] = useState('')
  const [corpusId, setCorpusId] = useState('')
  const [roiDefinitionHash, setRoiDefinitionHash] = useState('')
  const [workloadSemanticHash, setWorkloadSemanticHash] = useState('')
  const [parametersJson, setParametersJson] = useState('{"validCount":32,"invalidCount":0,"flaggedFraction":0,"sampleSd":1}')
  const [result, setResult] = useState<ReturnType<typeof CalibratedPredictionResultSchema.parse> | null>(null)
  const [running, setRunning] = useState(false)
  useEffect(() => {
    if (backend.status !== 'online') return
    const controller = new AbortController()
    client.calibrationCatalog(controller.signal).then((value) => {
      const rows = Array.isArray(value.calibrations) ? value.calibrations as Record<string, unknown>[] : []
      const approved=rows.filter((item) => item.state === 'approved')
      setCalibrations(approved)
      // A stored specification that will not parse is a data fault to report,
      // not an unhandled rejection that leaves the form silently blank.
      if(approved[0]&&typeof approved[0].specification_json==='string'){
        try{
          const specification=JSON.parse(approved[0].specification_json) as {domain?:Record<string,string[]>;parameterRanges?:Record<string,[number,number]>}
          const domain=specification.domain??{}
          setWorkloadId(domain.workloadIds?.[0]??'');setTarget(domain.targets?.[0]??'');setModelVersion(domain.modelVersions?.[0]??'');setProfileId(domain.profileIds?.[0]??'')
          setSimulatorVersion(domain.simulatorVersions?.[0]??'');setToolchainHash(domain.toolchainHashes?.[0]??'');setCorpusId(domain.corpusIds?.[0]??'')
          setRoiDefinitionHash(domain.roiDefinitionHashes?.[0]??'');setWorkloadSemanticHash(domain.workloadSemanticHashes?.[0]??'')
          setParametersJson(JSON.stringify(Object.fromEntries(Object.entries(specification.parameterRanges??{}).map(([name,[lower,upper]])=>[name,(lower+upper)/2]))))
        }catch(reason){
          setError(`Approved calibration specification is unreadable: ${reason instanceof Error?reason.message:String(reason)}`)
        }
      }
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => controller.abort()
  }, [backend.status, client])
  const canPredict = backend.status === 'online' && Boolean(calibrations && calibrations.length > 0)
  function predict() {
    if (!canPredict || running) return
    setRunning(true)
    setError(null)
    setResult(null)
    let parameters: Record<string, number>
    try { parameters = JSON.parse(parametersJson) as Record<string, number> }
    catch (reason) { setRunning(false); setError(reason instanceof Error ? reason.message : String(reason)); return }
    // .catch, not a rejection handler: a prediction that fails strict validation
    // must surface as a lane error rather than an unhandled rejection.
    void client.calibratedPrediction({ workloadId, target, modelVersion, profileId, simulatorVersion, toolchainHash, corpusId, roiDefinitionHash, workloadSemanticHash, parameters })
      .then((value) => setResult(CalibratedPredictionResultSchema.parse(value)))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setRunning(false))
  }
  if (backend.status !== 'online') return <>
    <LaneToolbar
      title="Calibrated Predictions"
      kicker="CALIBRATION"
      running={false}
      disabled
      disabledReason={backend.reason}
      onRun={() => undefined}
    />
    <Unavailable reason={backend.reason} />
  </>
  return <section className="space-y-4">
    <LaneToolbar
      title="Calibrated Predictions"
      kicker="CALIBRATION"
      running={running}
      disabled={!canPredict}
      disabledReason={!canPredict ? 'No approved applicable calibration. RUN MODEL stays unavailable until one exists.' : undefined}
      onRun={predict}
    />
    <header className="hud-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="hud-title">Calibrated Predictions</h2><span className="category-label">CALIBRATION</span></div>
      <p className="mt-2 text-white/55">Calibration is a separate evidence lane. It never silently replaces illustrative analytical profiles.</p>
    </header>
    {error && <div role="alert" className="border border-magenta p-4 text-pink-200">{error}</div>}
    {calibrations === null && !error && <div className="hud-panel p-10 text-center">Loading approved calibrations…</div>}
    {calibrations?.length === 0 && <CalibratedEmptyState />}
    {calibrations && calibrations.length > 0 && <form className="hud-panel grid gap-3 p-4 md:grid-cols-2" onSubmit={(event) => {
      event.preventDefault()
      predict()
    }}>
      <TextField label="Workload" value={workloadId} onChange={setWorkloadId} />
      <TextField label="Target" value={target} onChange={setTarget} />
      <TextField label="Model version" value={modelVersion} onChange={setModelVersion} />
      <TextField label="Profile" value={profileId} onChange={setProfileId} />
      <TextField label="Simulator version" value={simulatorVersion} onChange={setSimulatorVersion} />
      <TextField label="Toolchain hash" value={toolchainHash} onChange={setToolchainHash} />
      <TextField label="Corpus ID" value={corpusId} onChange={setCorpusId} />
      <TextField label="ROI definition hash" value={roiDefinitionHash} onChange={setRoiDefinitionHash} />
      <label className="md:col-span-2"><span className="hud-kicker">Workload semantic hash</span><input className="hud-input mt-1" value={workloadSemanticHash} onChange={(event) => setWorkloadSemanticHash(event.target.value)} /></label>
      <label className="md:col-span-2"><span className="hud-kicker">Exact registered feature parameters (JSON)</span><textarea className="hud-input mt-1 h-24 font-mono text-xs" value={parametersJson} onChange={(event) => setParametersJson(event.target.value)} /></label>
    </form>}
    {result && <PredictionReport result={result} />}
  </section>
}

export function CalibratedEmptyState() {
  return <div className="hud-panel p-10 text-center">
    <h3 className="font-display text-lg">No approved applicable calibration</h3>
    <p className="mx-auto mt-2 max-w-2xl text-white/50">Predictions stay empty until an approved calibration has a frozen dataset, completed one-time holdout evaluation, and a domain that applies to this request.</p>
  </div>
}

function PredictionReport({ result }: { result: ReturnType<typeof CalibratedPredictionResultSchema.parse> }) {
  return <article className="hud-panel p-4">
    <div className="flex flex-wrap justify-between gap-3"><h3 className="font-display text-lg">Validated calibrated prediction</h3><EnvelopeBadges envelope={result} primary="CALIBRATED PREDICTION" /></div>
    <dl className="metric-grid mt-4">
      <Item name="Point" value={`${result.metrics[0]?.value} ${result.metrics[0]?.unit}`} />
      <Item name="50% interval" value={result.uncertainty.interval50 ? `${result.uncertainty.interval50.lower}–${result.uncertainty.interval50.upper} ${result.uncertainty.unit}` : 'not supplied'} />
      <Item name="95% interval" value={result.uncertainty.interval95 ? `${result.uncertainty.interval95.lower}–${result.uncertainty.interval95.upper} ${result.uncertainty.unit}` : `${result.uncertainty.lower}–${result.uncertainty.upper}`} />
      <Item name="Uncertainty components" value={result.uncertainty.components} />
      <Item name="Dataset hash" value={result.datasetId} />
      <Item name="Calibration hash" value={result.calibrationId} />
      <Item name="Model hash" value={result.modelHash} />
      <Item name="Applicability" value={result.applicability} />
      <Item name="Extrapolation" value={result.applicability?.extrapolated === false ? 'rejected outside domain; this result is in-domain' : 'unknown'} />
    </dl>
    <button className="hud-tab mt-4" type="button" onClick={() => canonicalDownload(result, `calibrated-${result.inputIdentity}.envelope.json`)}>EXPORT CALIBRATED ENVELOPE</button>
  </article>
}
function Item({ name, value }: { name: string; value: unknown }) {
  return <div><dt>{name}</dt><dd className="break-all">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>
}
function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label><span className="hud-kicker">{label}</span><input className="hud-input mt-1" value={value} onChange={(event) => onChange(event.target.value)} /></label>
}
