import { useMemo, useState, type CSSProperties } from 'react'
import { ISA_META, type IsaId } from '../engine/types.ts'
import { GUEST_C_VERSION } from '../engine/c/compile_c.ts'
import type { CompareResult } from '../engine/compare.ts'
import { download, fmtInt, fmtMult, fmtNum, signedPct } from './format.ts'
import {
  MIX_COLORS,
  analyze,
  comparableRows,
  displayPrimary,
  excludedRows,
  metricsFor,
  mixShare,
  primaryMeasure,
  primaryValue,
  type MetricDef,
} from './analysis.ts'
import { resultToCsv, resultToJson } from './exports.ts'
import { reportContractLabels, reportParameterLabels } from './reportMetadata.ts'
import { EvidenceBadgeView } from './Evidence.tsx'
import { isRealResult, targetFull, targetShort } from './targetNames.ts'
import {
  buildLegacyReportView,
  isCurrentCompareResult,
  type LegacyCompareResult,
  type ReportableResult,
} from './reportLegacy.ts'

type Pane = 'matrix' | 'mix' | 'trace' | 'protocol'

function delay(ms: number): CSSProperties {
  return { ['--d' as string]: `${ms}ms` } as CSSProperties
}

export function Report({
  result,
  onSave,
}: {
  result: ReportableResult
  onSave?: (name: string) => void
}) {
  if (!isCurrentCompareResult(result)) return <LegacyReport result={result} />
  return <CurrentReport result={result} onSave={onSave} />
}

function CurrentReport({
  result,
  onSave,
}: {
  result: CompareResult
  onSave?: (name: string) => void
}) {
  const [pane, setPane] = useState<Pane>('matrix')
  const [baseline, setBaseline] = useState<'leader' | IsaId>('leader')
  const [traceIsa, setTraceIsa] = useState<IsaId>(result.rows[0]?.isa ?? 'riscv')
  const [saveName, setSaveName] = useState(result.workloadName)
  const insights = useMemo(() => analyze(result), [result])
  const comparable = useMemo(() => comparableRows(result), [result])
  const excluded = useMemo(() => excludedRows(result), [result])
  const ranked = useMemo(
    () => [...comparable].sort((a, b) => primaryValue(result, a) - primaryValue(result, b)),
    [comparable, result],
  )
  const metrics = useMemo(() => metricsFor(result), [result])
  const real = isRealResult(result)
  const byTime = primaryMeasure(result) === 'time'
  const lead = ranked[0]
  const baselineRow =
    baseline === 'leader'
      ? lead
      : (comparable.find((r) => r.isa === baseline) ?? lead)

  return (
    <div className="report-enter space-y-4">
      <section className="hud-panel report-hero relative overflow-hidden p-4 reveal" style={delay(0)}>
        <div className="pointer-events-none absolute inset-0 scan" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="hud-kicker max-w-4xl">
              {[
                `JOB/${result.workloadId.toUpperCase()}`,
                ...reportParameterLabels(result),
                ...(lead && !real ? [`${lead.cores}C/${lead.threads}T`, `${lead.activeThreads} ACTIVE WORKERS`] : []),
                ...(real ? ['ONE THREAD'] : []),
              ].join(' · ')}
            </div>
            <div className="mt-1 font-mono text-[9px] leading-4 text-white/35">
              {reportContractLabels(result).join(' · ')}
            </div>
            <h2 className="hud-title">{result.workloadName}</h2>
            <p className="mt-1 max-w-2xl text-sm text-cyan-100/55">{result.notes}</p>
            {result.stdout ? (
              <pre className="guest-out crt mt-3 max-h-40 overflow-auto p-3 font-mono text-xs text-lime-200/90">
                {result.stdout}
              </pre>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-2">
            <EvidenceBadgeView badge="SIMULATED ANALYTICAL" />
            <div className="font-mono text-[9px] text-cyan-100/55">
              MODEL CONTRACT {result.contract.schemaVersion}/{result.contract.modelVersion} · {result.contract.claimScope}
            </div>
            <div className="gold-lock flex items-center gap-2 font-mono text-[11px] text-lime-300">
              <span className="led led-ok" />
              REFERENCE MATCH {fmtNum(result.gold, result.fp)}
            </div>
            {real ? <RealExecutionNote result={result} /> : null}
            <div className="flex flex-wrap justify-end gap-2">
              {onSave && result.contract && (
                <div className="flex gap-2">
                  <label className="sr-only" htmlFor="save-run-name">Saved run name</label>
                  <input
                    id="save-run-name"
                    value={saveName}
                    onChange={(event) => setSaveName(event.target.value)}
                    className="hud-input max-w-44 py-1"
                  />
                  <Ghost onClick={() => onSave(saveName)}>SAVE RUN</Ghost>
                </div>
              )}
              {result.contract && (
                <>
                  <Ghost onClick={() => exportJson(result)}>DUMP JSON</Ghost>
                  <Ghost onClick={() => exportCsv(result)}>DUMP CSV</Ghost>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {lead && baselineRow ? (
        <section className="hud-panel p-4 reveal" style={delay(90)}>
          <div className="hud-kicker">
            {byTime ? 'Modelled-time rank · illustrative presets' : 'Model-cycle rank'} · vs {targetShort(result, baselineRow.isa)}
          </div>
          <p className="mb-3 mt-1 text-xs text-white/45">
            {byTime
              ? 'Each target ran on its own preset, so the clocks differ and only modelled time compares across them.'
              : real
                ? 'Every target on the same modelled in-order core. The instructions are real; the cycles are the model\'s.'
                : 'Every target on the same modelled in-order core, timing the engine\'s lowering for each.'}
          </p>
          <div className="space-y-2">
            {ranked.map((row, i) => {
              const leadValue = primaryValue(result, lead)
              const value = primaryValue(result, row)
              const baseValue = primaryValue(result, baselineRow)
              const rel = leadValue === 0 ? 1 : value / leadValue
              const vsBase = baseValue === 0 ? 0 : ((value - baseValue) / baseValue) * 100
              const width = value === 0 ? 100 : (leadValue / Math.max(value, leadValue)) * 100
              return (
                <div
                  key={row.isa}
                  className="reveal grid grid-cols-[minmax(7.5rem,9rem)_1fr_auto] items-center gap-3"
                  style={delay(140 + i * 70)}
                >
                  <div className="font-display text-sm" style={{ color: ISA_META[row.isa].color }}>
                    <span className="mr-2 font-mono text-[10px] text-white/35">0{i + 1}</span>
                    {targetShort(result, row.isa)}
                    <div className="mt-0.5 font-mono text-[9px] leading-tight text-white/35">
                      {[
                        ...(result.hardwareMode !== 'same' ? [`${row.hardwareName} · illustrative`] : []),
                        ...(real ? [] : [`${row.cores}C/${row.threads}T · ${row.activeThreads} active`]),
                        ...(real && row.isa === 'wasm' ? ['bytecode timed as if run directly'] : []),
                      ].join(' · ')}
                    </div>
                  </div>
                  <div className="race-track">
                    <div
                      className="race-fill"
                      style={{
                        ...delay(180 + i * 70),
                        width: `${width}%`,
                        background: `linear-gradient(90deg, ${ISA_META[row.isa].color}33, ${ISA_META[row.isa].color})`,
                        boxShadow: `0 0 12px ${ISA_META[row.isa].color}66`,
                      }}
                    />
                  </div>
                  <div className="min-w-[168px] text-right font-mono text-xs">
                    <span className="text-white">{displayPrimary(result, row)}</span>
                    <span className="ml-2 text-white/40">{fmtMult(rel)}</span>
                    <span className={`ml-2 ${vsBase > 0.05 ? 'text-magenta' : 'text-lime-300'}`}>
                      {i === 0 && baseline === 'leader' ? 'LOWEST' : signedPct(vsBase)}
                    </span>
                  </div>
                </div>
              )
            })}
            {excluded.map(({ row, reason }) => (
              <div key={row.isa} className="grid grid-cols-[minmax(7.5rem,9rem)_1fr] items-center gap-3">
                <div className="font-display text-sm opacity-60" style={{ color: ISA_META[row.isa].color }}>
                  <span className="mr-2 font-mono text-[10px] text-white/35">—</span>
                  {targetShort(result, row.isa)}
                </div>
                <div className="font-mono text-[10px] text-amber-200/80">NOT RANKED · {reason}</div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="hud-panel p-4">
          <div className="hud-kicker">Nothing to rank</div>
          {excluded.map(({ row, reason }) => (
            <p key={row.isa} className="mt-2 text-sm text-amber-200/80">
              {targetShort(result, row.isa)}: {reason}
            </p>
          ))}
        </section>
      )}

      <section className="grid gap-3 md:grid-cols-2">
        {insights.map((ins, i) => (
          <article
            key={`${ins.tag}-${i}`}
            className={`brief brief-${ins.tone} reveal`}
            style={delay(260 + i * 80)}
          >
            <div className="hud-kicker">{ins.tag}</div>
            <h3 className="mt-1 font-display text-base text-white">{ins.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-white/60">{ins.body}</p>
          </article>
        ))}
      </section>

      <nav className="reveal flex flex-wrap gap-2" style={delay(420)}>
        {(
          [
            ['matrix', 'METRICS'],
            ['mix', 'INSTRUCTION MIX'],
            ['trace', 'TRACE'],
            ['protocol', 'PROTOCOL'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setPane(id)}
            className={`hud-tab ${pane === id ? 'hud-tab-on' : ''}`}
            aria-pressed={pane === id}
          >
            {label}
          </button>
        ))}
      </nav>

      {pane === 'matrix' && baselineRow && (
        <section className="hud-panel pane-enter p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="hud-kicker">Relative to the baseline · the best value is highlighted where a direction is better</div>
            <label className="flex items-center gap-2 font-mono text-[11px] text-white/50">
              BASE
              <select
                value={baseline}
                onChange={(e) => setBaseline(e.target.value as 'leader' | IsaId)}
                className="hud-input py-1"
              >
                <option value="leader">{byTime ? 'Least modelled time' : 'Fewest model cycles'}</option>
                {comparable.map((r) => (
                  <option key={r.isa} value={r.isa}>
                    {targetShort(result, r.isa)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(['counted', 'modelled'] as const).map((basis) => {
            const group = metrics.filter((metric) => metric.basis === basis)
            if (group.length === 0) return null
            return (
              <div key={basis} className="mb-6">
                <h3 className="hud-title text-sm">{basis === 'counted' ? 'Counted from execution' : 'Modelled'}</h3>
                <p className="mb-3 mt-1 text-xs text-white/45">
                  {basis === 'counted'
                    ? 'Exact counts of what the verified interpreters executed. They include library code, and the libraries differ between targets.'
                    : 'From the deterministic in-order timing model, the same model for every target. Nothing here is measured on hardware.'}
                </p>
                <div className="space-y-5">
                  {group.map((metric) => (
                    <MetricRow
                      key={metric.id}
                      metric={metric}
                      result={result}
                      comparable={comparable}
                      baselineRow={baselineRow}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </section>
      )}

      {pane === 'mix' && (
        <section className="hud-panel pane-enter space-y-5 p-4">
          <p className="text-xs text-white/45">
            {real
              ? 'Retired instructions by class. An instruction that both computes and touches memory, as x86 allows, is counted under its operation.'
              : 'Completed modeled operations after drain, by class.'}
          </p>
          {result.rows.map((row) => {
            const parts = mixShare(row)
            return (
              <div key={row.isa}>
                <div className="mb-1 flex items-center justify-between font-mono text-[11px]">
                  <span style={{ color: ISA_META[row.isa].color }}>{targetFull(result, row.isa)}</span>
                  <span className="text-white/40">
                    {real
                      ? `${fmtInt(row.instructions)} instructions retired`
                      : `${fmtInt(row.completedOperations)} completed modeled ops after drain`}
                  </span>
                </div>
                <div className="mix-track">
                  {parts.map((p) => (
                    <div
                      key={p.key}
                      title={`${p.key} ${p.n}`}
                      style={{
                        width: `${p.share * 100}%`,
                        background: MIX_COLORS[p.key],
                      }}
                    />
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-white/45">
                  {parts.map((p) => (
                    <span key={p.key}>
                      <i
                        className="mr-1 inline-block h-2 w-2 align-middle"
                        style={{ background: MIX_COLORS[p.key] }}
                      />
                      {p.key.toUpperCase()} {p.n}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </section>
      )}

      {pane === 'trace' && (
        <section className="hud-panel pane-enter overflow-hidden">
          <div className="flex flex-wrap gap-2 border-b border-cyan-400/20 p-3">
            {result.rows.map((r) => (
              <button
                key={r.isa}
                type="button"
                onClick={() => setTraceIsa(r.isa)}
                className="hud-tab"
                aria-pressed={traceIsa === r.isa}
                style={{
                  color: ISA_META[r.isa].color,
                  borderColor: traceIsa === r.isa ? ISA_META[r.isa].color : undefined,
                  boxShadow: traceIsa === r.isa ? `0 0 12px ${ISA_META[r.isa].color}55` : undefined,
                }}
              >
                {targetFull(result, r.isa)}
              </button>
            ))}
          </div>
          <p className="border-b border-cyan-400/20 px-4 py-2 text-xs text-white/45">
            {real
              ? 'The first distinct instructions this binary executed, in the order first reached, as the verified decoder renders them.'
              : 'Modeled lowering stream for this pseudo-backend; not executable disassembly or a generated binary.'}
          </p>
          <pre className="crt max-h-[560px] overflow-auto p-4 font-mono text-xs leading-6 text-cyan-100/80">
            {(result.rows.find((r) => r.isa === traceIsa) ?? result.rows[0]).disasm.join('\n')}
          </pre>
        </section>
      )}

      {pane === 'protocol' && (real ? <RealProtocol result={result} /> : <Protocol />)}
    </div>
  )
}

function LegacyReport({ result }: { result: LegacyCompareResult }) {
  const view = buildLegacyReportView(result)
  return (
    <div className="report-enter space-y-4">
      <section className="hud-panel border-orange-400/50 p-5">
        <div className="hud-kicker text-orange-300">
          LEGACY UNVERSIONED MODEL ARCHIVE · VIEW ONLY · NON-RERUNNABLE · SAVE AND EXPORT DISABLED
        </div>
        <h2 className="hud-title mt-2">{view.title}</h2>
        <p className="mt-1 text-sm text-white/55">{view.subtitle}</p>
        <p className="mt-3 font-mono text-xs text-orange-200">{view.reference}</p>
        <p className="mt-1 font-mono text-[10px] text-white/40">{view.parameters}</p>
        {view.stdout && (
          <pre className="guest-out crt mt-3 max-h-40 overflow-auto p-3 font-mono text-xs text-lime-200/90">
            {view.stdout}
          </pre>
        )}
      </section>
      {view.rows.map((row) => (
        <section key={row.key} className="hud-panel p-4">
          <h3 className="font-display text-sm text-white">{row.target}</h3>
          <p className="font-mono text-[10px] text-white/40">{row.hardware}</p>
          <ul className="mt-3 space-y-1 font-mono text-xs text-cyan-100/70">
            {row.fields.map((field) => <li key={field}>{field}</li>)}
          </ul>
          {row.trace.length > 0 && (
            <>
              <p className="mt-3 text-xs text-white/45">
                Archived old-model lowering text; not executable disassembly.
              </p>
              <pre className="crt mt-1 max-h-72 overflow-auto p-3 font-mono text-xs text-cyan-100/70">
                {row.trace.join('\n')}
              </pre>
            </>
          )}
        </section>
      ))}
    </div>
  )
}

function MetricRow({
  metric,
  result,
  comparable,
  baselineRow,
}: {
  metric: MetricDef
  result: CompareResult
  comparable: CompareResult['rows']
  baselineRow: CompareResult['rows'][number]
}) {
  const ranks = metric.better !== 'none'
  const baseVal = metric.value(baselineRow)
  const values = comparable.map((row) => metric.value(row))
  const bestVal = metric.better === 'high' ? Math.max(...values) : Math.min(...values)
  const worstVal = metric.better === 'high' ? Math.min(...values) : Math.max(...values)
  const top = Math.max(...values, 0)
  const span = Math.abs(worstVal - bestVal)

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <div className="hud-kicker">
          {metric.label}
          {metric.better === 'low' ? ' · LOWER IS BETTER' : metric.better === 'high' ? ' · HIGHER IS BETTER' : ' · NOT RANKED'}
        </div>
        <div className="font-mono text-[10px] text-white/35">{metric.unit}</div>
      </div>
      <p className="mb-1.5 text-[11px] leading-snug text-white/40">{metric.meaning}</p>
      <div className="space-y-1.5">
        {result.rows.map((row) => {
          const inRanking = row.matchedGold
          const v = metric.value(row)
          const rel = baseVal === 0 ? (v === 0 ? 1 : Infinity) : v / baseVal
          // A zero baseline has no defined relative change; reporting 0% would
          // claim parity where the row actually differs.
          const delta = baseVal === 0
            ? (v === 0 ? 0 : Infinity)
            : ((v - baseVal) / Math.abs(baseVal)) * 100
          // A ranked metric's bar is longest at the best value; an unranked
          // one's is proportional, so a longer bar is simply a larger number.
          const fill = ranks
            ? (span === 0 ? 100 : Math.max(8, Math.min(100, (1 - Math.abs(v - bestVal) / span) * 100)))
            : (top === 0 ? 0 : Math.max(4, Math.min(100, (v / top) * 100)))
          const isBest = ranks && inRanking && v === bestVal
          const better = metric.better === 'low' ? delta < -0.05 : delta > 0.05
          const worse = metric.better === 'low' ? delta > 0.05 : delta < -0.05
          return (
            <div key={row.isa} className="grid grid-cols-[72px_1fr_auto] items-center gap-3">
              <div className="font-mono text-[11px]" style={{ color: ISA_META[row.isa].color }}>
                {targetShort(result, row.isa)}
              </div>
              <div className="race-track h-2">
                <div
                  className="race-fill"
                  style={{
                    ...delay(80),
                    width: `${inRanking ? fill : 0}%`,
                    background: ISA_META[row.isa].color,
                    opacity: isBest ? 1 : 0.72,
                    boxShadow: isBest ? `0 0 10px ${ISA_META[row.isa].color}` : undefined,
                  }}
                />
              </div>
              <div className="min-w-[168px] text-right font-mono text-[11px]">
                <span className={isBest ? 'text-white' : 'text-white/70'}>{metric.display(row)}</span>
                {inRanking ? (
                  <>
                    <span className="ml-2 text-white/35">{Number.isFinite(rel) ? fmtMult(rel) : '∞'}</span>
                    <span className={`ml-2 ${!ranks ? 'text-white/30' : better ? 'text-lime-300' : worse ? 'text-magenta' : 'text-white/30'}`}>
                      {row.isa === baselineRow.isa ? 'BASE' : signedPct(delta)}
                    </span>
                  </>
                ) : (
                  <span className="ml-2 text-amber-200/70">NOT RANKED</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** What a real run executed, what it could not, and what it did not claim. */
function RealExecutionNote({ result }: { result: CompareResult }) {
  const execution = result.execution!
  const narrow = execution.targets.filter((target) => target.verdict === 'unreachable')
  return (
    <div className="max-w-xs text-right font-mono text-[10px] leading-4 text-cyan-100/70">
      <div className="text-cyan-200">REAL INSTRUCTIONS · MODELLED TIMING</div>
      {narrow.map((target) => (
        <div key={target.isa} className="text-amber-200/80">
          {target.label}: its C int is too narrow to hold this answer, so it computes a different value
        </div>
      ))}
      {execution.unavailable.map((item) => (
        <div key={item.isa} className="text-white/45">{item.reason}</div>
      ))}
    </div>
  )
}

function RealProtocol({ result }: { result: CompareResult }) {
  const execution = result.execution!
  return (
    <section className="hud-panel pane-enter space-y-4 p-5 text-sm leading-relaxed text-white/65">
      <p>
        Each target ran this program compiled by clang for that instruction set and linked against a
        real C library, executed by an interpreter that is verified against a reference. This is a
        deterministic educational software model, with no physical hardware measurements or
        performance prediction.
      </p>
      <p>
        Every row answers to the IR interpreter reference: its return value and its output must
        equal the reference&apos;s, or the run is rejected. The one exception is stated rather than
        excused -- a target whose C int is too narrow to hold the answer computes a different value,
        must still return one its int can hold, and is left out of every ranking because it did
        different work.
      </p>
      <ul className="space-y-2 font-mono text-xs">
        {execution.targets.map((target) => (
          <li key={target.isa} style={{ color: ISA_META[target.isa].color }}>
            {target.label} — linked against {target.libc}; verified against {target.oracle},{' '}
            {target.verified}.
            {target.verdict === 'unreachable' ? ' Its int cannot hold this answer.' : ''}
          </li>
        ))}
        {execution.unavailable.map((item) => (
          <li key={item.isa} className="text-white/45">{item.reason}.</li>
        ))}
      </ul>
      <h3 className="hud-title text-sm">Counted</h3>
      <p>
        Instructions retired, the bytes they occupied, the instructions that read or wrote data
        memory, conditional branches and how many were taken, and the distinct code executed are
        exact counts of what the interpreter ran. Data-memory instructions include implicit stack
        traffic -- an x86 call pushes its return address, a 6502 <span className="font-mono">jsr</span>{' '}
        pushes two bytes -- because the instruction set makes that traffic, not the program. Every
        count includes library code, and the libraries differ: most targets link musl, SPARC links
        picolibc, WebAssembly links wasi-libc and the 6502 llvm-mos&apos;s own, so a difference inside
        <span className="font-mono"> printf</span> is partly a difference of library.
      </p>
      <h3 className="hud-title text-sm">Modelled</h3>
      <p>
        Everything else comes from one in-order core with the same caches, branch predictor and
        return-address stack for every target, fed the instructions that actually retired: their
        classes, the registers they read and wrote, which way each branch went and which address
        each access touched. No target gets a timing adjustment of its own. A delay slot is an
        instruction that retires and is timed like one; a call on MIPS and SPARC returns past its
        slot, and the return stack is checked against where control really went.
      </p>
      <p>
        Two things the reference does out of sight are charged here. A SPARC register-window
        spill or fill moves 64 bytes through the data cache and costs two pipeline refills, into
        the trap and back; the handler&apos;s own instructions are not counted, because the
        reference does not execute them either. A system call, and a WebAssembly call into its
        host, drains the pipeline and is otherwise free on every target, since no target&apos;s kernel
        is modelled.
      </p>
      <p>
        WebAssembly&apos;s model cycles time its bytecode as if a machine executed it directly. No
        machine does -- every engine compiles it first -- so its counted figures describe the
        bytecode exactly, and its modelled ones describe a hypothetical machine.
      </p>
      <h3 className="hud-title text-sm">Not reported</h3>
      <p>
        Energy: the model&apos;s estimate is uncalibrated, its uncertainty is not quantified, and it
        cannot support a comparison. It stays in the JSON export, without any per-target weight.
        L2 and L3 miss rates: these programs&apos; working sets are small enough that nearly every
        lower-level access is a first touch, so the rate is close to 100% on every target and says
        nothing; lines fetched from memory are reported instead. Model cycles per instruction is
        shown but not ranked, because instructions do different amounts of work on different
        instruction sets.
      </p>
    </section>
  )
}

function Protocol() {
  return (
    <section className="hud-panel pane-enter space-y-4 p-5 text-sm leading-relaxed text-white/65">
      <p>
        This is a deterministic educational software model, with no physical hardware measurements
        or performance prediction. Built-in workloads have an independent expected-value check plus
        the IR interpreter reference. Custom C validates {GUEST_C_VERSION} lowering, generated IR, and
        pseudo-backends—not ISO C. Observable checks cover return value and stdout; full memory is
        not generally an observable. Binary64 results use exact ordered-operation identity:
        NaN matches NaN, while all other values use Object.is so infinities and signed zero remain
        distinct. A reference mismatch rejects the run.
      </p>
      <ul className="space-y-2 font-mono text-xs">
        <li className="text-orange-400">
          RISC-V-style pseudo-backend — integer-style encodings plus modeled FP pseudo-ops.
        </li>
        <li className="text-cyan-300">
          AArch64-like — shifted-register addressing, CMP+B.cond, MOVZ/MOVK.
        </li>
        <li className="text-fuchsia-400">
          x86-64-style subset — 2-operand form, SIB addressing, 11 GPRs, modeled decode delay on long ops.
        </li>
        <li className="text-lime-300">
          MIPS32-like — 16-bit immediates, no scaled addressing, 1-cycle load delay.
        </li>
        <li className="text-amber-300">
          PowerPC/POWER-like pseudo-backend — 16-bit immediates and indexed modeled loads.
        </li>
        <li className="text-indigo-300">
          SPARC V8-like — 13-bit immediates, sethi+or constants, and a fixed one-model-cycle
          control-transfer bubble; no delay-slot instruction executes.
        </li>
        <li className="text-teal-300">
          WebAssembly-like pseudo-backend — modeled stack-machine lowering.
        </li>
        <li className="text-rose-300">
          MOS 6502-style pseudo-backend — modeled accumulator form and constrained registers.
        </li>
      </ul>
      <p>
        At the start of model cycle c, completions scheduled for c run in issue order; issue then
        reads operands. An operation of latency L completes at c+L, and results, loads, and stores
        become visible only then. Termination drains retained completion events. RAW/WAW/WAR and
        hidden resources are scoreboarded; each thread has one outstanding memory operation.
        HALT, BARRIER, CALL, ICALL, and RET drain older operations. Issue arbitration is core order,
        round-robin thread order, then program order.
      </p>
      <p>
        Prediction applies only to conditional BEQ/BNE/BLT/BGE. Direct jumps and calls are
        direction-known; indirect calls pay a fixed redirect; returns use a bounded perfect RAS.
        L1/L2/L3 are set-associative line caches. Instruction and data accesses split by cache line;
        private L1D ownership transfers use deterministic invalidation/coherence events. Shared L3
        and DRAM channels are modeled. Cache geometry and timings are parameters, not measurements.
      </p>
      <p>
        An uncalibrated nominal energy estimate is kept in the JSON export for compatibility and
        is not reported: its uncertainty is not quantified and its per-target weights were never
        measured, so it cannot support a comparison. Model cycles per operation is shown but not
        ranked, because each target&apos;s operations do different amounts of work. {GUEST_C_VERSION}
        retains bounded 32-bit guest addresses, a bounded heap/stdout region, 4 KiB worker stacks,
        4096 call frames, 256 modeled hardware threads, deterministic library helpers, and no
        operating system, files, sockets, signals, dynamic linking, or ISO C conformance claim.
        Shared model profile mode is controlled; named illustrative presets are parameter presets
        on this same in-order model, not emulation or measurement. Current saved runs retain the
        exact effective fixed-C source and complete resolved profile per target; RESTORE replays
        those snapshots without consulting mutable catalogs. Canonical JSON and saved runs use
        tagged IEEE values so NaN, infinities, and negative zero round-trip exactly.
      </p>
    </section>
  )
}

function Ghost({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="hud-tab">
      {children}
    </button>
  )
}

function exportJson(result: CompareResult): void {
  download(`isa-bench-${result.workloadId}.json`, resultToJson(result), 'application/json')
}

function exportCsv(result: CompareResult): void {
  download(`isa-bench-${result.workloadId}.csv`, resultToCsv(result), 'text/csv')
}
