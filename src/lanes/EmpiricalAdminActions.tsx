import { useState, type FormEvent } from 'react'
import type { BackendClient } from '../ui/backendClient.ts'

type Tab = 'Runners' | 'Jobs & leases' | 'Imports' | 'Raw runs' | 'Summaries' | 'Datasets & splits' | 'Calibration lifecycle'

const HASH = '0'.repeat(64)

export function EmpiricalAdminActions({
  client,
  tab,
  data,
  onChanged,
}: {
  client: BackendClient
  tab: Tab
  data: Record<string, unknown>
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<unknown>(null)
  const [json, setJson] = useState('{}')
  const [selectedId, setSelectedId] = useState('')
  const [version, setVersion] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const rows = tab === 'Runners' ? list(data.runners)
    : tab === 'Jobs & leases' ? list(data.jobs)
      : tab === 'Imports' ? list(data.imports)
        : tab === 'Raw runs' || tab === 'Summaries' ? list(data.runs)
          : tab === 'Datasets & splits' ? list(data.datasets)
            : list(data.calibrations)

  async function perform(label: string, operation: () => Promise<unknown>) {
    if (!globalThis.confirm(`Confirm administrative action: ${label}`)) return
    setError(null)
    try {
      const result = await operation()
      setOutput(result)
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const parsed = () => JSON.parse(json) as Record<string, unknown>
  const submit = (event: FormEvent) => event.preventDefault()
  return <form className="hud-panel space-y-3 p-4" onSubmit={submit}>
    <h3 className="font-display text-sm uppercase tracking-widest">Authenticated administration</h3>
    {rows.length > 0 && <label className="block"><span className="hud-kicker">Record</span><select className="hud-input mt-1" value={selectedId} onChange={(event) => {
      setSelectedId(event.target.value)
      const row = rows.find((item) => String(item.id) === event.target.value)
      setVersion(Number(row?.version ?? 0))
    }}><option value="">Select…</option>{rows.map((row) => <option key={String(row.id)} value={String(row.id)}>{String(row.id)} · {String(row.state ?? '')}</option>)}</select></label>}
    {tab === 'Runners' && <div className="flex flex-wrap gap-2">
      <button className="hud-tab" type="button" onClick={() => void perform('issue one-time enrollment token', () => client.adminRequest('/api/empirical/enrollment/tokens', { ttlMs: 600_000 }))}>ISSUE ENROLLMENT TOKEN</button>
      <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`approve runner ${selectedId}`, () => client.adminRequest(`/api/empirical/runners/${encodeURIComponent(selectedId)}/approve`, {}))}>APPROVE</button>
      <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`revoke runner ${selectedId}`, () => client.adminRequest(`/api/empirical/runners/${encodeURIComponent(selectedId)}/revoked`, {}))}>REVOKE</button>
    </div>}
    {tab === 'Jobs & leases' && <JsonAction json={json} setJson={setJson} hint="Paste eligible empirical JobSpec JSON. Protected fields and ineligible binaries are rejected." label="CREATE JOB" onClick={() => void perform('create empirical runner job', () => client.adminRequest('/api/empirical/jobs', parsed()))} />}
    {tab === 'Imports' && <>
      <label className="block"><span className="hud-kicker">Evidence bundle (.jsonl or .tar.zst)</span><input className="hud-input mt-1" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      <div className="flex flex-wrap gap-2">
        <button className="hud-tab" type="button" disabled={!file} onClick={() => void perform('inspect evidence into quarantine', async () => client.adminRequest('/api/calibration/imports/inspect', { bundleBase64: await base64(file!), format: file!.name.endsWith('.zst') ? 'tar.zst' : 'jsonl' }))}>INSPECT</button>
        <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`read signed import report ${selectedId}`, () => client.adminRead(`/api/calibration/imports/${encodeURIComponent(selectedId)}/report`))}>REPORT</button>
        <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`commit quarantine ${selectedId}`, () => client.adminRequest(`/api/calibration/imports/${encodeURIComponent(selectedId)}/commit`, {}, { version }))}>COMMIT</button>
        <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`delete quarantine ${selectedId}`, () => client.adminRequest(`/api/calibration/imports/${encodeURIComponent(selectedId)}/delete`, {}, { version }))}>DELETE</button>
      </div>
    </>}
    {tab === 'Raw runs' && <JsonAction json={json} setJson={setJson} hint={`Summary JSON: {"runIds":[...],"policyHash":"${HASH}","codeHash":"${HASH}","confidenceMethod":"bootstrap","confidenceLevel":0.95,"clusterUnit":null,"seed":"..."}`} label="SUMMARIZE SELECTED RUNS" onClick={() => void perform('create aggregate summary from committed valid runs', () => client.adminRequest('/api/empirical/runs/summarize', parsed()))} />}
    {tab === 'Datasets & splits' && <>
      <JsonAction json={json} setJson={setJson} hint='Dataset JSON: {"summaryIds":[...],"featureExtractor":"summary-basic","featureVersion":"1"}' label="CREATE DATASET" onClick={() => void perform('create materialized dataset', () => client.adminRequest('/api/calibration/datasets', parsed()))} />
      <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`freeze dataset ${selectedId}`, () => client.adminRequest(`/api/calibration/datasets/${encodeURIComponent(selectedId)}/freeze`, parsed(), { version }))}>FREEZE SELECTED DATASET</button>
    </>}
    {tab === 'Calibration lifecycle' && <div className="flex flex-wrap gap-2">
      <JsonAction json={json} setJson={setJson} hint='Create: {"datasetId":"…","modelKind":"ridge","acceptanceThresholds":{"maxRmse":1,"maxMae":1,"minR2":0,"minCoverage50":0.4,"minCoverage95":0.9}}. Fit accepts only version/configs.' label="CREATE CALIBRATION" onClick={() => void perform('create calibration', () => client.adminRequest('/api/calibration/calibrations', parsed()))} />
      <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`fit calibration ${selectedId}`, () => client.adminRequest(`/api/calibration/calibrations/${encodeURIComponent(selectedId)}/fit`, parsed(), { version }))}>FIT</button>
      <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`evaluate one-time holdout for ${selectedId}`, () => client.adminRequest(`/api/calibration/calibrations/${encodeURIComponent(selectedId)}/evaluate-holdout`, {}, { version }))}>EVALUATE HOLDOUT</button>
      <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`apply preregistered approval gate for ${selectedId}`, () => client.adminRequest(`/api/calibration/calibrations/${encodeURIComponent(selectedId)}/approve`, {}, { version }))}>APPROVE</button>
      <button className="hud-tab" type="button" disabled={!selectedId} onClick={() => void perform(`retire calibration ${selectedId}`, () => client.adminRequest(`/api/calibration/calibrations/${encodeURIComponent(selectedId)}/retire`, {}, { version }))}>RETIRE</button>
    </div>}
    {error && <pre className="border border-magenta p-3 text-xs text-pink-200" role="alert">{error}</pre>}
    {output !== null && <details><summary className="hud-kicker cursor-pointer">Action result</summary><pre className="mt-2 max-h-64 overflow-auto text-xs">{JSON.stringify(output, null, 2)}</pre></details>}
  </form>
}

function JsonAction({ json, setJson, hint, label, onClick }: { json: string; setJson: (value: string) => void; hint: string; label: string; onClick: () => void }) {
  return <div className="w-full"><label className="block"><span className="text-xs text-white/60">{hint}</span><textarea aria-label={`${label} JSON input`} className="hud-input mt-1 h-28 font-mono text-xs" value={json} onChange={(event) => setJson(event.target.value)} /></label><button className="hud-tab mt-2" type="button" onClick={onClick}>{label}</button></div>
}
function list(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value as Record<string, unknown>[] : [] }
async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
