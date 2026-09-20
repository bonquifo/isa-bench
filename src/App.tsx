import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ALL_ISAS,
  CPU_CATALOG,
  DEFAULT_PROFILE_ID,
  HARDWARE_PROFILES,
  ISA_META,
  C_EXAMPLES,
  GUEST_C_VERSION,
  SAMPLE_C,
  SAMPLE_IR,
  WORKLOADS,
  cExampleByWorkloadId,
  cWorkloadId,
  cpusForIsa,
  defaultCpuByIsa,
  groupCpus,
  fingerprint,
  type HardwareProfile,
  type HardwareMode,
  type IsaId,
  type JackProgress,
} from './engine/index.ts'
import { JackIn } from './ui/JackIn.tsx'
import { Report } from './ui/Report.tsx'
import { isCurrentCompareResult, type ReportableResult } from './ui/reportLegacy.ts'
import { currentCatalogProfile, replayProfileState } from './ui/replayProfile.ts'
import { deleteSave, loadSavesState, restoreInput, saveRun, type StoredRun } from './ui/saves.ts'
import { runControlled } from './ui/runController.ts'
import { BackendClient, eventProgress } from './ui/backendClient.ts'
import { useServerJob } from './ui/api/useServerJob.ts'
import { CompareResultSchema } from './engine/compareSchema.ts'

export default function App({ backendClient }: { backendClient?: BackendClient } = {}) {
  const client = useMemo(() => backendClient ?? new BackendClient(), [backendClient])
  const serverJob = useServerJob(client, 'analytical-inorder')
  const [workloadId, setWorkloadId] = useState('dot_product')
  const [n, setN] = useState(256)
  const [seed, setSeed] = useState(42)
  const [isas, setIsas] = useState<IsaId[]>([...ALL_ISAS])
  const [hardwareMode, setHardwareMode] = useState<'same' | 'cpus'>('same')
  const [cpuByIsa, setCpuByIsa] = useState<Record<IsaId, string>>(defaultCpuByIsa)
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE_ID)
  const [tune, setTune] = useState(false)
  const [clockMhz, setClockMhz] = useState(2000)
  const [issueWidth, setIssueWidth] = useState(1)
  const [memLatency, setMemLatency] = useState(80)
  const [iCacheKb, setICacheKb] = useState(32)
  const [dCacheKb, setDCacheKb] = useState(32)
  const [mispredictPenalty, setMispredictPenalty] = useState(7)
  const [cores, setCores] = useState(1)
  const [smt, setSmt] = useState(1)
  const [customSource, setCustomSource] = useState(SAMPLE_IR)
  const [customC, setCustomC] = useState(SAMPLE_C)
  const [replayProfiles, setReplayProfiles] = useState<
    Partial<Record<IsaId, HardwareProfile>> | undefined
  >()
  const [replayCustomHw, setReplayCustomHw] = useState<Partial<HardwareProfile> | undefined>()
  const [effectiveSourceOverride, setEffectiveSourceOverride] = useState<string | undefined>()
  const initialSaves = useMemo(() => loadSavesState(), [])
  const [saves, setSaves] = useState<StoredRun[]>(initialSaves.saves)
  const [result, setResult] = useState<ReportableResult | null>(null)
  const [error, setError] = useState<string | null>(
    initialSaves.issues.length ? initialSaves.issues.join(' ') : null,
  )
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<JackProgress>({
    ratio: 0,
    phase: 'IDLE',
    detail: '',
  })
  const runAbort = useRef<AbortController | null>(null)
  const serverResult = useMemo(() => {
    const value = serverJob.state.job?.state === 'succeeded' ? serverJob.state.job.result : null
    if (!value) return { result: null, error: null }
    const parsed = CompareResultSchema.safeParse(value)
    return parsed.success
      ? { result: parsed.data, error: null }
      : { result: null, error: `INVALID BACKEND RESULT · ${parsed.error.message}` }
  }, [serverJob.state.job])
  const shownResult = result ?? serverResult.result
  const shownError = error ?? serverResult.error ?? serverJob.state.error
  const visibleRunning = running || serverJob.state.running
  const latestServerEvent = serverJob.state.events.at(-1)
  const visibleProgress = (latestServerEvent ? eventProgress(latestServerEvent) : null) ?? progress

  const workload = WORKLOADS.find((w) => w.id === workloadId)
  const cProgram = cExampleByWorkloadId(workloadId)
  const catalogProfile = HARDWARE_PROFILES.find((p) => p.id === profileId)
  const replayDisplayProfile = isas
    .map((isa) => replayProfiles?.[isa])
    .find((item): item is HardwareProfile => item !== undefined)
  const profile = replayDisplayProfile ?? catalogProfile ?? HARDWARE_PROFILES[0]
  const archivedProfileActive = replayDisplayProfile !== undefined && catalogProfile === undefined

  function applyProfileControls(next: HardwareProfile) {
    setClockMhz(next.clockMhz)
    setIssueWidth(next.issueWidth)
    setMemLatency(next.memLatency)
    setICacheKb(next.l1i.sizeBytes / 1024)
    setDCacheKb(next.l1d.sizeBytes / 1024)
    setMispredictPenalty(next.mispredictPenalty)
    setCores(next.cores)
    setSmt(Math.max(1, Math.round(next.threads / Math.max(1, next.cores))))
    setTune(false)
  }

  function clearReplayHardware() {
    setReplayProfiles(undefined)
    setReplayCustomHw(undefined)
    if (!HARDWARE_PROFILES.some((item) => item.id === profileId)) {
      const current = currentCatalogProfile(profileId, HARDWARE_PROFILES)
      setProfileId(current.id)
      applyProfileControls(current)
    }
  }

  function selectProfile(id: string) {
    clearReplayHardware()
    const next = currentCatalogProfile(id, HARDWARE_PROFILES)
    setProfileId(next.id)
    applyProfileControls(next)
  }

  function selectWorkload(id: string) {
    setEffectiveSourceOverride(undefined)
    setWorkloadId(id)
    if (id === 'custom' || id === 'custom-c') setN(4)
    else {
      const next = WORKLOADS.find((item) => item.id === id)
      if (next) setN(next.defaultN)
    }
  }

  function restoreSave(save: StoredRun) {
    setResult(save.result)
    setError(null)
    const input = restoreInput(save)
    if (!input) return
    setWorkloadId(input.workloadId)
    setN(input.n)
    setSeed(input.seed)
    setIsas([...input.selectedIsas])
    setHardwareMode(input.hardwareMode as HardwareMode)
    setCpuByIsa((current) => ({ ...current, ...input.cpuByIsa, ...input.resolvedCpuByIsa }))
    const restored = replayProfileState(input, HARDWARE_PROFILES)
    const restoredProfile = restored.profile
    setProfileId(restored.profileId)
    applyProfileControls(restoredProfile)
    const overlay = input.customHw
    if (overlay) {
      setTune(
        overlay.clockMhz !== undefined ||
        overlay.issueWidth !== undefined ||
        overlay.memLatency !== undefined ||
        overlay.mispredictPenalty !== undefined ||
        overlay.l1i !== undefined ||
        overlay.l1d !== undefined,
      )
      if (overlay.clockMhz !== undefined) setClockMhz(overlay.clockMhz)
      if (overlay.issueWidth !== undefined) setIssueWidth(overlay.issueWidth)
      if (overlay.memLatency !== undefined) setMemLatency(overlay.memLatency)
      if (overlay.mispredictPenalty !== undefined) setMispredictPenalty(overlay.mispredictPenalty)
      if (overlay.l1i) setICacheKb(overlay.l1i.sizeBytes / 1024)
      if (overlay.l1d) setDCacheKb(overlay.l1d.sizeBytes / 1024)
      if (overlay.cores !== undefined) setCores(overlay.cores)
      if (overlay.threads !== undefined) {
        const restoredCores = overlay.cores ?? restoredProfile.cores
        setSmt(Math.max(1, Math.round(overlay.threads / Math.max(1, restoredCores))))
      }
    }
    const source = input.customSource ?? input.effectiveSource
    if (source !== undefined) {
      if (input.workloadId === 'custom-c') setCustomC(source)
      else setCustomSource(source)
    }
    setReplayProfiles(structuredClone(input.resolvedProfileByIsa))
    setReplayCustomHw(input.customHw ? structuredClone(input.customHw) : undefined)
    setEffectiveSourceOverride(
      save.rerunnable && save.result.workload.kind === 'fixed-c'
        ? input.effectiveSourceOverride
        : undefined,
    )
  }

  const logicalThreads = cores * smt
  const customHw = useMemo<Partial<HardwareProfile> | undefined>(() => {
    if (hardwareMode !== 'same') return undefined
    const chipChanged = cores !== profile.cores || logicalThreads !== profile.threads
    if (!tune && !chipChanged) return undefined
    return {
      ...(tune
        ? {
            clockMhz,
            issueWidth,
            memLatency,
            mispredictPenalty,
            l1i: { ...profile.l1i, sizeBytes: iCacheKb * 1024 },
            l1d: { ...profile.l1d, sizeBytes: dCacheKb * 1024 },
          }
        : {}),
      cores,
      threads: logicalThreads,
      name: tune
        ? `${profile.name} (tuned)`
        : chipChanged
          ? `${profile.name} · ${cores}C/${logicalThreads}T`
          : profile.name,
    }
  }, [
    tune,
    hardwareMode,
    clockMhz,
    issueWidth,
    memLatency,
    mispredictPenalty,
    iCacheKb,
    dCacheKb,
    cores,
    logicalThreads,
    profile,
  ])

  async function run() {
    if (isas.length === 0) {
      setError('Select at least one ISA.')
      return
    }
    setRunning(true)
    const controller = new AbortController()
    runAbort.current = controller
    setError(null)
    setProgress({ ratio: 0.02, phase: 'MODEL', detail: 'opening the pipeline' })
    try {
      const next = await runControlled(
        {
          workloadId,
          n,
          seed,
          isas,
          hardwareMode,
          profileId,
          customHw: replayProfiles ? replayCustomHw : customHw,
          ...(workloadId === 'custom'
            ? { customSource }
            : workloadId === 'custom-c'
              ? { customSource: customC }
              : {}),
          ...(effectiveSourceOverride !== undefined ? { effectiveSourceOverride } : {}),
          ...(replayProfiles ? { resolvedProfileByIsa: replayProfiles } : {}),
          cpuByIsa,
        },
        setProgress,
        {
          signal: controller.signal,
          client,
          managedRun: serverJob.run,
          managedCancel: serverJob.cancel,
        },
      )
      setResult(next)
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      runAbort.current = null
      setRunning(false)
    }
  }

  return (
    <div className="min-h-svh">
      <div className="border-b border-orange-400/40 bg-orange-950/60 px-4 py-2 text-center text-xs text-orange-100" role="note">
        Deterministic educational software model · no physical hardware measurements or performance prediction.
      </div>
      <header className="topbar">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-3">
            <Mark />
            <div>
              <div className="flicker font-mono text-[11px] tracking-[0.32em] text-magenta">
                NET//ISA
              </div>
              <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-white">
                Bench <span className="text-cyan-300">2077</span>
              </h1>
            </div>
          </div>
          {!visibleRunning && (
            <p className="hidden max-w-md text-right font-mono text-[10px] leading-4 text-cyan-100/40 xl:block">
              EIGHT ISA-INSPIRED TARGETS · SHARED MODEL PROFILE OR NAMED ILLUSTRATIVE PRESETS
            </p>
          )}
          <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
            {visibleRunning && <JackIn progress={visibleProgress} />}
            <button
              type="button"
              onClick={visibleRunning ? () => {
                runAbort.current?.abort()
                serverJob.cancel()
              } : run}
              className="jack-btn"
            >
              {visibleRunning ? 'CANCEL RUN' : 'RUN MODEL'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1500px] grid-cols-1 gap-5 px-5 py-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <Panel kicker="01" title="Workload">
            <label className="hud-kicker" htmlFor="workload-select">Program</label>
            <select
              id="workload-select"
              className="hud-input mt-1"
              value={workloadId}
              onChange={(e) => selectWorkload(e.target.value)}
            >
              <optgroup label="IR kernels">
                {WORKLOADS.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="C · gfx / game / math">
                {C_EXAMPLES.filter((e) => e.kind === 'heavy').map((ex) => (
                  <option key={cWorkloadId(ex)} value={cWorkloadId(ex)}>
                    {ex.menuName}
                  </option>
                ))}
              </optgroup>
              <optgroup label="C · tutorial">
                {C_EXAMPLES.filter((e) => e.kind === 'tutorial').map((ex) => (
                  <option key={cWorkloadId(ex)} value={cWorkloadId(ex)}>
                    {ex.menuName}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Custom">
                <option value="custom">Custom IR…</option>
                <option value="custom-c">Custom C…</option>
              </optgroup>
            </select>
            <p className="mt-2 text-sm leading-relaxed text-white/45">
              {workloadId === 'custom'
                  ? 'Write portable IR. Every selected pseudo-backend lowers and models it independently.'
                : workloadId === 'custom-c'
                  ? `${GUEST_C_VERSION} subset. It lowers to shared IR; the reference checks main’s return value and stdout, not ISO C or full memory.`
                  : cProgram
                    ? cProgram.blurb
                    : workload?.blurb}
            </p>
            {cProgram && (
              <details className="mt-3">
                <summary className="hud-kicker cursor-pointer text-cyan-100/50">C source</summary>
                <pre className="hud-input mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5">
                  {cProgram.source}
                </pre>
              </details>
            )}
            {workload && workloadId !== 'custom' && workloadId !== 'custom-c' && !cProgram && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label={workload.nLabel} id="workload-n">
                  <input
                    id="workload-n"
                    type="number"
                    min={workload.minN}
                    max={workload.maxN}
                    value={n}
                    onChange={(e) => setN(Number(e.target.value))}
                    className="hud-input font-mono"
                  />
                </Field>
                {workload.usesSeed && <Field label="Seed" id="workload-seed">
                  <input
                    id="workload-seed"
                    type="number"
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value))}
                    className="hud-input font-mono"
                  />
                </Field>}
              </div>
            )}
            {workloadId === 'custom' && (
              <>
                <Field label="Worker cap (used only when source requests workers)" id="ir-worker-cap">
                  <input
                    id="ir-worker-cap"
                    type="number"
                    min={1}
                    max={64}
                    value={n}
                    onChange={(e) => setN(Number(e.target.value))}
                    className="hud-input font-mono"
                  />
                </Field>
                <textarea
                  aria-label="Custom IR source"
                  value={customSource}
                  onChange={(e) => {
                    setEffectiveSourceOverride(undefined)
                    setCustomSource(e.target.value)
                  }}
                  spellCheck={false}
                  className="hud-input mt-3 h-56 resize-y font-mono text-xs leading-5"
                />
              </>
            )}
            {workloadId === 'custom-c' && (
              <>
                <Field label="Worker cap (if you call __tid)" id="worker-cap">
                  <input
                    id="worker-cap"
                    type="number"
                    min={1}
                    max={64}
                    value={n}
                    onChange={(e) => setN(Number(e.target.value))}
                    className="hud-input font-mono"
                  />
                </Field>
                <label className="hud-kicker mt-3 block" htmlFor="c-example">Example</label>
                <p className="mt-1 font-mono text-[10px] leading-4 text-mute">
                  ▸ heavy = software gfx / games / math. No GPU — every pixel is integer work the ISAs share.
                </p>
                <select
                  id="c-example"
                  className="hud-input mt-1"
                  defaultValue="fib"
                  onChange={(e) => {
                    const ex = C_EXAMPLES.find((x) => x.id === e.target.value)
                    if (ex) {
                      setEffectiveSourceOverride(undefined)
                      setCustomC(ex.source)
                    }
                  }}
                >
                  {C_EXAMPLES.map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {ex.name}
                    </option>
                  ))}
                </select>
                <textarea
                  aria-label="Custom Guest C source"
                  value={customC}
                  onChange={(e) => {
                    setEffectiveSourceOverride(undefined)
                    setCustomC(e.target.value)
                  }}
                  spellCheck={false}
                  className="hud-input mt-3 h-64 resize-y font-mono text-xs leading-5"
                />
              </>
            )}
          </Panel>

          <Panel kicker="02" title="Hardware">
            {replayProfiles && (
              <div className="mb-3 border border-lime-300/40 bg-lime-950/30 px-3 py-2 font-mono text-[10px] text-lime-200" role="status">
                EXACT SAVED PROFILE SNAPSHOT ACTIVE UNTIL HARDWARE CHANGES
              </div>
            )}
            {effectiveSourceOverride !== undefined && (
              <div className="mb-3 border border-lime-300/40 bg-lime-950/30 px-3 py-2 font-mono text-[10px] text-lime-200" role="status">
                SAVED FIXED-C EFFECTIVE SOURCE ACTIVE FOR REPLAY
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <ModeBtn
                active={hardwareMode === 'same'}
                onClick={() => {
                  clearReplayHardware()
                  setHardwareMode('same')
                }}
                label="Shared model profile"
                hint="Controlled comparison"
              />
              <ModeBtn
                active={hardwareMode === 'cpus'}
                onClick={() => {
                  clearReplayHardware()
                  setHardwareMode('cpus')
                }}
                label="Named illustrative presets"
                hint="Illustrative"
              />
            </div>
            {hardwareMode === 'same' ? (
              <>
                <select
                  aria-label="Shared model profile"
                  className="hud-input mt-3"
                  value={profileId}
                  onChange={(e) => selectProfile(e.target.value)}
                >
                  {archivedProfileActive && (
                    <option value={profileId}>
                      {profile.name} · archived saved snapshot
                    </option>
                  )}
                  {HARDWARE_PROFILES.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.cores}C/{p.threads}T
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-sm text-white/45">
                  {archivedProfileActive
                    ? `${profile.blurb} Archived catalog entry; controls reflect the saved resolved snapshot.`
                    : profile.blurb}
                </p>
                <div className="mt-3 space-y-2 text-sm">
                  <Slider label="Cores" value={cores} min={1} max={64} step={1} onChange={(value) => { clearReplayHardware(); setCores(value) }} />
                  <Slider label="SMT / core" value={smt} min={1} max={8} step={1} suffix="×" onChange={(value) => { clearReplayHardware(); setSmt(value) }} />
                  <p className="font-mono text-[11px] text-cyan-200/70">
                    {cores}C / {logicalThreads}T
                    {logicalThreads > 64 ? ' · large chips take longer to cycle' : ''}
                  </p>
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={tune}
                    onChange={(e) => {
                      clearReplayHardware()
                      setTune(e.target.checked)
                    }}
                  />
                  Custom overlay / tuning
                </label>
                {tune && (
                  <div className="mt-3 space-y-2 text-sm">
                    <Slider label="Clock" value={clockMhz} min={100} max={5000} step={50} suffix=" MHz" onChange={(value) => { clearReplayHardware(); setClockMhz(value) }} />
                    <Slider label="Issue width" value={issueWidth} min={1} max={4} step={1} onChange={(value) => { clearReplayHardware(); setIssueWidth(value) }} />
                    <Slider label="DRAM miss" value={memLatency} min={2} max={200} step={1} suffix=" cyc" onChange={(value) => { clearReplayHardware(); setMemLatency(value) }} />
                    <Slider label="L1I" value={iCacheKb} min={4} max={128} step={4} suffix=" KB" onChange={(value) => { clearReplayHardware(); setICacheKb(value) }} />
                    <Slider label="L1D" value={dCacheKb} min={4} max={128} step={4} suffix=" KB" onChange={(value) => { clearReplayHardware(); setDCacheKb(value) }} />
                    <Slider label="Mispredict" value={mispredictPenalty} min={1} max={20} step={1} suffix=" cyc" onChange={(value) => { clearReplayHardware(); setMispredictPenalty(value) }} />
                  </div>
                )}
              </>
            ) : (
              <div className="mt-3 space-y-2">
                <p className="text-sm leading-relaxed text-white/45">
                  {CPU_CATALOG.length} named illustrative parameter presets on the same in-order
                  software model. They are not CPU emulation or measurements. Parallel kernels use
                  the available modeled threads up to the workload&apos;s useful-worker limit.
                </p>
                {ALL_ISAS.map((id) => {
                  const on = isas.includes(id)
                  const list = cpusForIsa(id)
                  return (
                    <label key={id} className={`block ${on ? '' : 'opacity-40'}`}>
                      <span className="hud-kicker" style={{ color: on ? ISA_META[id].color : undefined }}>
                        {ISA_META[id].short}
                      </span>
                      <select
                        aria-label={`${ISA_META[id].short} illustrative preset`}
                        className="hud-input mt-1"
                        disabled={!on}
                        value={cpuByIsa[id]}
                        onChange={(e) => {
                          clearReplayHardware()
                          setCpuByIsa((cur) => ({ ...cur, [id]: e.target.value }))
                        }}
                      >
                        {groupCpus(list).map((g) => {
                          const opts = g.items.map((cpu) => (
                            <option key={cpu.id} value={cpu.id} title={cpu.blurb}>
                              {cpu.name} · {cpu.year} · {cpu.profile.cores}C/{cpu.profile.threads}T
                            </option>
                          ))
                          return g.group ? (
                            <optgroup key={g.group} label={g.group}>
                              {opts}
                            </optgroup>
                          ) : (
                            opts
                          )
                        })}
                      </select>
                    </label>
                  )
                })}
              </div>
            )}
          </Panel>

          <Panel kicker="03" title="ISA uplink">
            <div className="mb-2 flex justify-end gap-2">
              <button type="button" className="hud-tab" onClick={() => { clearReplayHardware(); setIsas([...ALL_ISAS]) }}>
                ALL
              </button>
              <button type="button" className="hud-tab" onClick={() => { clearReplayHardware(); setIsas([]) }}>
                NONE
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {ALL_ISAS.map((id) => {
                const on = isas.includes(id)
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      clearReplayHardware()
                      setIsas((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
                    }}
                    className="isa-chip"
                    aria-pressed={on}
                    style={{
                      borderColor: on ? ISA_META[id].color : 'rgba(255,255,255,0.08)',
                      boxShadow: on ? `0 0 14px ${ISA_META[id].color}44` : undefined,
                    }}
                  >
                    <div className="font-display text-sm" style={{ color: ISA_META[id].color }}>
                      {ISA_META[id].short}
                    </div>
                    <div className="font-mono text-[10px] text-white/40">{ISA_META[id].family}</div>
                  </button>
                )
              })}
            </div>
          </Panel>

          <Panel kicker="04" title="Saved runs">
            {saves.length === 0 ? (
              <p className="text-sm text-white/40">
                After a reference match, save the report. Archives stay in this browser.
              </p>
            ) : (
              <ul className="space-y-2">
                {saves.map((s) => (
                  <li key={s.id} className="border border-white/10 px-2 py-2">
                    <div className="font-display text-sm text-white">{s.name}</div>
                    <div className="font-mono text-[10px] text-white/40">
                      {new Date(s.savedAt).toLocaleString()} · {s.result.workloadName} ·{' '}
                      {s.result.rows.length} targets · {s.rerunnable ? 'restorable v2' : 'legacy view-only'}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        className="hud-tab"
                        onClick={() => {
                          restoreSave(s)
                        }}
                      >
                        {s.rerunnable ? 'RESTORE' : 'OPEN REPORT'}
                      </button>
                      <button
                        type="button"
                        className="hud-tab"
                        onClick={() => {
                          try {
                            setSaves(deleteSave(s.id))
                          } catch (deleteError) {
                            setError(`DELETE FAILED · ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`)
                          }
                        }}
                      >
                        DROP
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>

        <section className="min-w-0">
          {shownError && (
            <div className="mb-4 border border-magenta bg-[#2a041c] px-4 py-3 font-mono text-sm text-pink-200" role="alert">
              FAULT · {shownError}
            </div>
          )}
          {shownResult && (
            <Report
              key={isCurrentCompareResult(shownResult)
                ? shownResult.inputFingerprint
                : `legacy:${fingerprint(shownResult)}`}
              result={shownResult}
              onSave={isCurrentCompareResult(shownResult) ? (name) => {
                try {
                  saveRun(name, shownResult)
                  const loaded = loadSavesState()
                  setSaves(loaded.saves)
                  setError(loaded.issues.length ? loaded.issues.join(' ') : null)
                } catch (saveError) {
                  setError(`SAVE FAILED · ${saveError instanceof Error ? saveError.message : String(saveError)}`)
                }
              } : undefined}
            />
          )}
          {!shownResult && !shownError && (
            <div className="hud-panel flex min-h-[36rem] items-center justify-center px-6 py-16 text-center font-mono text-sm text-white/40">
              AWAITING RUN — SELECT RUN MODEL
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function Panel({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return (
    <section className="hud-panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-white">
          {title}
        </h2>
        <span className="font-mono text-[10px] text-magenta">{kicker}</span>
      </div>
      {children}
    </section>
  )
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="block">
      <label className="hud-kicker" htmlFor={id}>{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function ModeBtn({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean
  onClick: () => void
  label: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`isa-chip ${active ? 'hud-tab-on' : ''}`}
    >
      <div className="font-medium">{label}</div>
      <div className="font-mono text-[10px] text-white/40">{hint}</div>
    </button>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (n: number) => void
}) {
  const id = useId()
  return (
    <div className="block">
      <div className="flex justify-between font-mono text-[11px] text-white/45">
        <label htmlFor={id}>{label}</label>
        <span className="text-cyan-200">
          {value}
          {suffix}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#ff2bd6]"
      />
    </div>
  )
}

function Mark() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
      <path d="M3 8 L19 2 L35 8 L35 30 L19 36 L3 30 Z" fill="#0a0314" stroke="#00f0ff" />
      <path d="M8 12 H30 M8 26 H30 M14 8 V30 M24 8 V30" stroke="#ff2bd6" strokeOpacity="0.55" />
      <rect x="16" y="16" width="6" height="6" fill="#c8ff3d" />
    </svg>
  )
}
