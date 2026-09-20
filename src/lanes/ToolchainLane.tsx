import { useState } from 'react'
import { ToolchainValidationResultSchema } from '@isa-sim/contracts'
import {
  ALL_ISAS,
  C_EXAMPLES,
  DEFAULT_PROFILE_ID,
  GUEST_C_VERSION,
  SAMPLE_C,
  SAMPLE_IR,
  WORKLOADS,
  cWorkloadId,
  type CompareInput,
} from '../engine/index.ts'
import { JobConsole } from '../ui/JobConsole.tsx'
import { EnvelopeBadges } from '../ui/Evidence.tsx'
import { capabilityReason, type BackendState } from '../ui/api/useBackend.ts'
import { useServerJob } from '../ui/api/useServerJob.ts'
import type { BackendClient } from '../ui/backendClient.ts'
import { canonicalDownload } from './externalResult.ts'
import { LaneToolbar } from './LaneToolbar.tsx'

const TARGETS = [
  'x86_64-linux', 'aarch64-linux', 'riscv64-linux', 'mipsel-o32',
  'powerpc64le-elfv2', 'sparc-v8', 'wasm32-wasip1', 'mos-sim',
]

export function ToolchainLane({ client, backend }: { client: BackendClient; backend: BackendState }) {
  const [workloadId, setWorkloadId] = useState('dot_product')
  const [n, setN] = useState(256)
  const [seed, setSeed] = useState(42)
  const [targets, setTargets] = useState<string[]>(['x86_64-linux'])
  const [customSource, setCustomSource] = useState(SAMPLE_IR)
  const [customC, setCustomC] = useState(SAMPLE_C)
  const job = useServerJob(client, 'toolchain-validation')
  const capability = capabilityReason(backend, 'toolchain-validation')
  const input: CompareInput = {
    workloadId,
    n,
    seed,
    isas: [...ALL_ISAS],
    hardwareMode: 'same',
    profileId: DEFAULT_PROFILE_ID,
    ...((workloadId === 'custom' || workloadId === 'custom-c') ? { customSource: workloadId === 'custom' ? customSource : customC } : {}),
  }
  const result = job.state.job?.state === 'succeeded' ? job.state.job.result as {
    claim?: string
    emitterVersion?: string
    targets?: Record<string, Record<string, unknown>>
    envelopes?: unknown[]
  } | null : null
  const canRun = capability.available && targets.length > 0
  return (
    <div>
      <LaneToolbar
        title="Toolchain validation"
        kicker="VALIDATION"
        running={job.state.running}
        disabled={!canRun}
        disabledReason={!capability.available ? capability.reason : !targets.length ? 'Select at least one validation target.' : undefined}
        onRun={() => void job.run((signal) => client.prepareToolchain(input, targets, signal))}
        onCancel={job.cancel}
      />
    <div className="lane-grid">
      <aside className="hud-panel space-y-4 p-4">
        <span className="category-label">VALIDATION</span>
        <p className="text-sm text-white/55">RUN MODEL starts functional codegen validation through the embedded backend. It does not produce a timing rank.</p>
        {!capability.available && <Unavailable reason={capability.reason} />}
        <label className="block"><span className="hud-kicker">Workload</span><select className="hud-input mt-1" value={workloadId} onChange={(event) => {
          const nextId = event.target.value
          const workload = WORKLOADS.find((item) => item.id === nextId)
          setWorkloadId(nextId)
          setN(workload?.defaultN ?? 4)
        }}><optgroup label="Built-in IR">{WORKLOADS.filter((item) => item.id !== 'custom').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>
          <optgroup label={`Fixed ${GUEST_C_VERSION}`}>{C_EXAMPLES.map((item) => <option key={item.id} value={cWorkloadId(item)}>{item.menuName}</option>)}</optgroup>
          <optgroup label="Custom"><option value="custom">Custom IR</option><option value="custom-c">Custom Guest C</option></optgroup>
        </select></label>
        <label className="block"><span className="hud-kicker">Problem size</span><input className="hud-input mt-1" type="number" value={n} onChange={(event) => setN(Number(event.target.value))} /></label>
        <label className="block"><span className="hud-kicker">Seed</span><input className="hud-input mt-1" type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
        {workloadId === 'custom' && <label className="block"><span className="hud-kicker">Custom IR · worker cap {n}</span><textarea aria-label="Toolchain custom IR" className="hud-input mt-1 h-56 font-mono text-xs" value={customSource} onChange={(event) => setCustomSource(event.target.value)} /></label>}
        {workloadId === 'custom-c' && <label className="block"><span className="hud-kicker">Custom {GUEST_C_VERSION} · worker cap {n}</span><textarea aria-label="Toolchain custom Guest C" className="hud-input mt-1 h-64 font-mono text-xs" value={customC} onChange={(event) => setCustomC(event.target.value)} /></label>}
        <fieldset><legend className="hud-kicker">Validation targets</legend><div className="mt-2 space-y-1">
          {TARGETS.map((target) => {
            const targetCapability = backend.status === 'online'
              ? backend.capabilities.toolchains.targets?.find((item) => item.target === target)
              : undefined
            const unsupported = targetCapability?.tier === 'unsupported'
            return <label key={target} className={`block text-sm ${unsupported ? 'opacity-50' : ''}`}><input type="checkbox" disabled={unsupported} checked={targets.includes(target)} onChange={() =>
              setTargets((current) => current.includes(target) ? current.filter((item) => item !== target) : [...current, target])} /> {target}
              <small className="ml-2 text-white/45">{String(targetCapability?.tier ?? 'unprobed')} · {String(targetCapability?.reason ?? '')}</small>
            </label>
          })}
        </div></fieldset>
      </aside>
      <section className="min-w-0">
        <JobConsole client={client} state={job.state} onCancel={job.cancel} />
        {result && <article className="mt-4 space-y-3">
          <div className="hud-panel p-4"><h2 className="hud-title">Functional validation</h2><p>{result.claim}</p><p className="font-mono text-xs text-white/45">emitter {result.emitterVersion} · no timing rank</p><button className="hud-tab mt-3" type="button" onClick={() => canonicalDownload(result, `toolchain-validation-${job.state.job?.id ?? 'result'}.json`)}>EXPORT TOOLCHAIN RESULT</button></div>
          {Object.entries(result.targets ?? {}).map(([target, value], index) => {
            const parsed = ToolchainValidationResultSchema.safeParse(result.envelopes?.[index])
            return <section className="hud-panel p-4" key={target}>
            <div className="flex flex-wrap justify-between gap-2"><h3 className="font-display text-lg">{target}</h3>{parsed.success && <EnvelopeBadges envelope={parsed.data} primary="GENERATED CODE VALIDATION" />}</div>
            <dl className="metric-grid mt-3">{Object.entries(value).filter(([key]) => key !== 'commands').map(([key, item]) =>
              <div key={key}><dt>{key}</dt><dd className="break-all">{Array.isArray(item) ? item.join(', ') : String(item)}</dd></div>)}</dl>
            {!parsed.success && <p className="mt-3 text-sm text-orange-200">No evidence badge: target envelope failed strict validation.</p>}
          </section>})}
        </article>}
      </section>
    </div>
    </div>
  )
}

export function Unavailable({ reason }: { reason: string }) {
  return <div className="border border-orange-300/40 bg-orange-950/30 p-3 text-sm text-orange-100" role="status"><strong>UNAVAILABLE</strong><br />{reason}</div>
}
