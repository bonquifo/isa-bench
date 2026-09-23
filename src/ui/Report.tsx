import { useMemo, useState, type CSSProperties } from 'react'
import { ISA_META, type IsaId } from '../engine/types.ts'
import { GUEST_C_VERSION } from '../engine/c/compile_c.ts'
import type { CompareResult } from '../engine/compare.ts'
import { download, fmtInt, fmtMult, fmtNum, signedPct } from './format.ts'
import { MIX_COLORS, REPORT_METRICS, analyze, mixShare, type MetricDef } from './analysis.ts'
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
  const ranked = useMemo(
    () => [...result.rows].sort((a, b) => a.cycles - b.cycles),
    [result],
  )
  const lead = ranked[0]
  const baselineRow =
    baseline === 'leader'
      ? lead
      : (result.rows.find((r) => r.isa === baseline) ?? lead)

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
                ...(lead ? [`${lead.cores}C/${lead.threads}T`, `${lead.activeThreads} ACTIVE WORKERS`] : []),
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
            {isRealResult(result) ? <RealExecutionNote result={result} /> : null}
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

      <section className="hud-panel p-4 reveal" style={delay(90)}>
        <div className="hud-kicker mb-3">Model-cycle rank · vs {targetShort(result, baselineRow.isa)}</div>
        <div className="space-y-2">
          {ranked.map((row, i) => {
            const rel = row.cycles / Math.max(1, lead.cycles)
            const vsBase = ((row.cycles - baselineRow.cycles) / Math.max(1, baselineRow.cycles)) * 100
            const width = (lead.cycles / Math.max(row.cycles, lead.cycles)) * 100
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
                    {result.hardwareMode !== 'same' ? `${row.hardwareName} · illustrative · ` : ''}
                    {row.cores}C/{row.threads}T · {row.activeThreads} active
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
                  <span className="text-white">{fmtInt(row.cycles)}</span>
                  <span className="ml-2 text-white/40">{fmtMult(rel)}</span>
                  <span className={`ml-2 ${vsBase > 0.05 ? 'text-magenta' : 'text-lime-300'}`}>
                    {i === 0 && baseline === 'leader' ? 'LOWEST' : signedPct(vsBase)}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        {insights.map((ins, i) => (
          <article
            key={ins.tag}
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
            ['matrix', 'METRIC MATRIX'],
            ['mix', 'OPCODE MIX'],
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

      {pane === 'matrix' && (
        <section className="hud-panel pane-enter p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="hud-kicker">Normalized to baseline · lower bar is better unless marked</div>
            <label className="flex items-center gap-2 font-mono text-[11px] text-white/50">
              BASE
              <select
                value={baseline}
                onChange={(e) => setBaseline(e.target.value as 'leader' | IsaId)}
                className="hud-input py-1"
              >
                <option value="leader">Lowest model cycles</option>
                {result.rows.map((r) => (
                  <option key={r.isa} value={r.isa}>
                    {targetShort(result, r.isa)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="space-y-5">
            {REPORT_METRICS.map((metric) => (
              <MetricRow
                key={metric.id}
                metric={metric}
                result={result}
                baselineRow={baselineRow}
              />
            ))}
          </div>
        </section>
      )}

      {pane === 'mix' && (
        <section className="hud-panel pane-enter space-y-5 p-4">
          {result.rows.map((row) => {
            const parts = mixShare(row)
            return (
              <div key={row.isa}>
                <div className="mb-1 flex items-center justify-between font-mono text-[11px]">
                  <span style={{ color: ISA_META[row.isa].color }}>{targetFull(result, row.isa)}</span>
                  <span className="text-white/40">{fmtInt(row.completedOperations)} completed modeled ops after drain</span>
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
            {isRealResult(result)
              ? 'The first instructions this binary executed, as the verified decoder renders them. Real instructions, compiled by clang; the timing beside them is the model.'
              : 'Modeled lowering stream for this pseudo-backend; not executable disassembly or a generated binary.'}
          </p>
          <pre className="crt max-h-[560px] overflow-auto p-4 font-mono text-xs leading-6 text-cyan-100/80">
            {(result.rows.find((r) => r.isa === traceIsa) ?? result.rows[0]).disasm.join('\n')}
          </pre>
        </section>
      )}

      {pane === 'protocol' && (isRealResult(result) ? <RealProtocol result={result} /> : <Protocol />)}
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
  baselineRow,
}: {
  metric: MetricDef
  result: CompareResult
  baselineRow: CompareResult['rows'][number]
}) {
  const baseVal = metric.value(baselineRow)
  const ranked = [...result.rows].sort((a, b) => {
    const av = metric.value(a)
    const bv = metric.value(b)
    return metric.better === 'low' ? av - bv : bv - av
  })
  const best = ranked[0]
  const worstVal = metric.value(ranked[ranked.length - 1])
  const bestVal = metric.value(best)
  const span = Math.max(Math.abs(worstVal - bestVal), Math.abs(bestVal), 1e-9)

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <div className="hud-kicker">
          {metric.label}
          {metric.better === 'high' ? ' · RANKED HIGHEST UNDER THIS MODEL' : ' · RANKED LOWEST UNDER THIS MODEL'}
        </div>
        <div className="font-mono text-[10px] text-white/35">{metric.unit}</div>
      </div>
      <div className="space-y-1.5">
        {result.rows.map((row) => {
          const v = metric.value(row)
          const rel = baseVal === 0 ? (v === 0 ? 1 : Infinity) : v / baseVal
          // A zero baseline has no defined relative change; reporting 0% would
          // claim parity where the row actually differs.
          const delta = baseVal === 0
            ? (v === 0 ? 0 : Infinity)
            : ((v - baseVal) / Math.abs(baseVal)) * 100
          const goodness = metric.better === 'low' ? (worstVal - v) / span : (v - (worstVal === bestVal ? 0 : worstVal)) / span
          const fill = Math.max(8, Math.min(100, goodness * 100))
          const isBest = row.isa === best.isa
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
                    width: `${fill}%`,
                    background: ISA_META[row.isa].color,
                    opacity: isBest ? 1 : 0.72,
                    boxShadow: isBest ? `0 0 10px ${ISA_META[row.isa].color}` : undefined,
                  }}
                />
              </div>
              <div className="min-w-[168px] text-right font-mono text-[11px]">
                <span className={isBest ? 'text-white' : 'text-white/70'}>{metric.display(row)}</span>
                <span className="ml-2 text-white/35">{Number.isFinite(rel) ? fmtMult(rel) : '∞'}</span>
                <span className={`ml-2 ${delta > 0.05 ? 'text-magenta' : delta < -0.05 ? 'text-lime-300' : 'text-white/30'}`}>
                  {row.isa === baselineRow.isa ? 'BASE' : signedPct(delta)}
                </span>
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
        real C library, executed by an interpreter that is verified against a reference. The
        instructions and the program&apos;s own output are real. Everything else here -- model cycles,
        cache behaviour, energy -- comes from the same deterministic model as every other result.
        This is a deterministic educational software model, with no physical hardware measurements
        or performance prediction.
      </p>
      <p>
        Every row answers to the IR interpreter reference: its return value and its output must
        equal the reference&apos;s, or the run is rejected. The one exception is stated rather than
        excused -- a target whose C int is too narrow to hold the answer computes a different value,
        and must still return one its int can hold.
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
      <p>
        The timing model consumes the instructions that actually retired: their classes, the
        registers they read and wrote, which way each branch went and which address each access
        touched. It models one core and one thread, in order, with the same caches, branch predictor
        and energy accounting as the lowering. The libraries differ between targets -- most link
        musl, SPARC links picolibc, WebAssembly links wasi-libc and the 6502 llvm-mos&apos;s own -- so
        instructions inside library calls are that library&apos;s.
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
        Nominal model energy is an uncalibrated event model plus integrated per-core residency.
        Its uncertainty is not quantified, so it does not predict joules on hardware. {GUEST_C_VERSION}
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
