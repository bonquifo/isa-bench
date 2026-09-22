import { useMemo, useState } from 'react'
import { HARDWARE_PROFILES, type HardwareProfile, type Metrics } from '../engine/index.ts'
import { simulateTrace } from '../engine/simulateTrace.ts'
import { RETURN_SEPARATOR } from '../isa/shipped.ts'
import { LaneToolbar } from './LaneToolbar.tsx'
import { REAL_TARGETS } from './realTargets.ts'

interface RealRun {
  programId: string
  targetLabel: string
  profileName: string
  metrics: Metrics
  stdout: string
  returned: number
  expectedReturn: number
  /**
   * `unreachable` means the app's recorded answer needs a wider `int`
   * than this target has, so the program cannot produce it and a
   * mismatch says nothing about the interpreter.
   */
  verdict: 'match' | 'differs' | 'unreachable'
}

/**
 * Formats a count without pretending to more precision than a model has.
 */
function count(value: number): string {
  return value.toLocaleString('en-US')
}

function fnv1a(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash | 0
}

/** Whether a value is one this target's C `int` can hold. */
function fitsInInt(value: number, bits: 16 | 32): boolean {
  const limit = 2 ** (bits - 1)
  return value >= -limit && value < limit
}

function stdoutMatches(text: string, expected: { exact: string } | { fnv1a: number; length: number }): boolean {
  return 'exact' in expected
    ? text === expected.exact
    : text.length === expected.length && fnv1a(text) === expected.fnv1a
}

export function RealIsaLane() {
  const [targetId, setTargetId] = useState(REAL_TARGETS[0]!.id)
  const [programId, setProgramId] = useState(REAL_TARGETS[0]!.shipped.shippedPrograms()[0]?.id ?? '')
  const [profileId, setProfileId] = useState(HARDWARE_PROFILES[0]!.id)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<RealRun | null>(null)

  const target = REAL_TARGETS.find((item) => item.id === targetId) ?? REAL_TARGETS[0]!
  const programs = useMemo(() => target.shipped.shippedPrograms(), [target])
  const missing = useMemo(() => target.shipped.unshippedProgramIds(), [target])

  const program = programs.find((item) => item.id === programId)
  const profile = HARDWARE_PROFILES.find((item) => item.id === profileId) as HardwareProfile

  async function execute() {
    if (!program) return
    setRunning(true)
    setError(null)
    setRun(null)
    try {
      const bytes = await target.shipped.loadShippedElf(program.url)
      const { interpreter } = target.backend.load(bytes, { instructionBudget: 200_000_000 })
      const metrics = simulateTrace(interpreter, profile, target.id)
      const decoder = new TextDecoder()
      // The corpus driver reports the full 32-bit return value separately
      // from the program's own output, because a process exit status
      // carries only eight bits of it. Where the platform has two output
      // streams that means stderr; where it has one -- the 6502's port is
      // a single address -- the two share a stream and are framed apart.
      const raw = decoder.decode(interpreter.stdout())
      const framed = target.returnChannel === 'framed'
      const split = framed ? raw.lastIndexOf(RETURN_SEPARATOR) : -1
      const stdout = split >= 0 ? raw.slice(0, split) : raw
      const returned = Number(
        framed
          ? (split >= 0 ? raw.slice(split + 1) : '')
          : decoder.decode(interpreter.stderr()),
      )
      setRun({
        programId: program.id,
        targetLabel: target.label,
        profileName: profile.name,
        metrics,
        stdout,
        returned,
        expectedReturn: program.example.expectedReturn,
        verdict: !fitsInInt(program.example.expectedReturn, target.intBits)
          ? 'unreachable'
          : returned === program.example.expectedReturn &&
              stdoutMatches(stdout, program.example.expectedStdout)
            ? 'match'
            : 'differs',
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <LaneToolbar
        title={`Real ${target.label}`}
        kicker="EXECUTION + MODEL"
        running={running}
        disabled={!program}
        disabledReason={program ? undefined : 'No precompiled binary is available.'}
        onRun={() => void execute()}
      />

      <div className="brief brief-warn mt-4" role="note">
        <p className="brief-lead">
          This lane executes real {target.instructions} instructions. It does not compare
          targets.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>
            <strong>Real:</strong> the instructions. These binaries were compiled by clang,
            linked against {target.libc}, and are executed here by an {target.label}{' '}
            interpreter that is verified against{' '}
            <span className="font-mono">{target.oracle}</span> {target.verified}.
          </li>
          <li>
            <strong>Modelled:</strong> every number below except the program&apos;s own output
            and return value. Cycles, cache behaviour and energy come from the same
            deterministic model the other lanes use. Nothing here is measured on hardware.
          </li>
          <li>
            <strong>Not comparable to the other lanes.</strong> The remaining targets are
            pseudo-backends driven by the engine&apos;s own lowering. Putting a real
            instruction stream beside a lowering in one table would invite reading them as
            equivalent, so this lane runs one target at a time and says which.
          </li>
          <li>
            <strong>Fixed programs.</strong> The app cannot compile at runtime, so these are
            precompiled. Editing the C and re-running is an in-order-lane feature.
          </li>
        </ul>
      </div>

      <div className="lane-grid mt-4">
        <aside className="hud-panel space-y-4 p-4">
          <span className="category-label">EXECUTION</span>
          <label className="block">
            <span className="hud-kicker">Instruction set</span>
            <select
              className="hud-input mt-1"
              aria-label="Instruction set"
              value={targetId}
              onChange={(event) => {
                setTargetId(event.target.value as typeof targetId)
                // A result belongs to the target that produced it, and every
                // target ships the same corpus, so the program stays put.
                setRun(null)
                setError(null)
              }}
            >
              {REAL_TARGETS.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="hud-kicker">Program</span>
            <select
              className="hud-input mt-1"
              aria-label="Program"
              value={programId}
              onChange={(event) => setProgramId(event.target.value)}
            >
              {programs.map((item) => (
                <option key={item.id} value={item.id}>{item.example.menuName}</option>
              ))}
            </select>
          </label>
          {program && <p className="text-sm text-white/55">{program.example.blurb}</p>}
          {missing.length > 0 && (
            <p className="text-sm text-orange-200">
              No binary yet for: {missing.join(', ')}.
            </p>
          )}
          <label className="block">
            <span className="hud-kicker">Modelled microarchitecture</span>
            <select
              className="hud-input mt-1"
              aria-label="Modelled microarchitecture"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
            >
              {HARDWARE_PROFILES.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <p className="text-sm text-white/55">{profile.blurb}</p>
        </aside>

        <section className="min-w-0 space-y-4">
          {error && (
            <div className="border border-magenta p-4 text-pink-200" role="alert">{error}</div>
          )}
          {!run && !error && (
            <div className="hud-panel p-4 font-mono text-xs" aria-live="polite" aria-busy={running}>
              {running
                ? `EXECUTING · real ${target.label} instructions`
                : 'IDLE · choose a program and run'}
            </div>
          )}

          {run && (
            <>
              <div className="hud-panel p-4">
                <h3 className="hud-title">Program output</h3>
                <pre className="guest-out mt-2 whitespace-pre-wrap break-all">{run.stdout || '(no output)'}</pre>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-white/55">Returned</dt>
                  <dd className="font-mono">{run.returned}</dd>
                  <dt className="text-white/55">Expected</dt>
                  <dd className="font-mono">{run.expectedReturn}</dd>
                </dl>
                <p
                  className={`mt-2 text-sm ${
                    run.verdict === 'match'
                      ? 'text-emerald-200'
                      : run.verdict === 'unreachable'
                        ? 'text-amber-200'
                        : 'text-pink-200'
                  }`}
                >
                  {run.verdict === 'match' &&
                    'Matches the answer the app records for this program, which was produced by a different compiler and a different engine.'}
                  {run.verdict === 'differs' &&
                    'Does NOT match the answer the app records for this program.'}
                  {run.verdict === 'unreachable' && (
                    <>
                      The app&apos;s recorded answer needs a 32-bit <code>int</code>, and{' '}
                      <code>int</code> is {target.intBits} bits on {target.label}. This
                      program cannot reach that value, and computes a different one for
                      that reason rather than because anything is wrong. What verifies it
                      here is the whole-program comparison against{' '}
                      <span className="font-mono">{target.oracle}</span>.
                    </>
                  )}
                </p>
              </div>

              <div className="hud-panel p-4">
                <h3 className="hud-title">Executed · {run.targetLabel}</h3>
                <p className="text-sm text-white/55">Counted, not modelled.</p>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                  <Figure label="Instructions" value={count(run.metrics.instructions)} />
                  <Figure label="Code bytes" value={count(run.metrics.codeBytes)} />
                  <Figure label="Bytes fetched" value={count(run.metrics.fetchedBytes)} />
                  <Figure label="Conditional branches" value={count(run.metrics.conditionalBranches)} />
                  <Figure label="Calls" value={count(run.metrics.calls)} />
                  <Figure label="Returns" value={count(run.metrics.returns)} />
                  <Figure label="Indirect calls" value={count(run.metrics.indirectCalls)} />
                  <Figure label="Loads + stores" value={count(run.metrics.mix.ld + run.metrics.mix.st)} />
                </dl>
              </div>

              <div className="hud-panel p-4">
                <h3 className="hud-title">Modelled · {run.profileName}</h3>
                <p className="text-sm text-white/55">
                  Deterministic software model. Not a measurement, not a prediction of any
                  physical part.
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                  <Figure label="Model cycles" value={count(run.metrics.cycles)} />
                  <Figure label="Model cycles / op" value={run.metrics.cpi.toFixed(3)} />
                  <Figure label="I-cache misses" value={count(run.metrics.icMisses)} />
                  <Figure label="D-cache misses" value={count(run.metrics.dcMisses)} />
                  <Figure label="Mispredicts" value={count(run.metrics.mispredicts)} />
                  <Figure label="Return-stack misses" value={count(run.metrics.rasMisses)} />
                  <Figure label="DRAM requests" value={count(run.metrics.dramRequests)} />
                  <Figure label="Stall cycles" value={count(run.metrics.stalls)} />
                </dl>
              </div>

              <div className="hud-panel p-4">
                <h3 className="hud-title">Decoded instructions</h3>
                <p className="text-sm text-white/55">
                  Read from the real encoding, in the order first executed. Two-byte entries
                  are compressed instructions.
                </p>
                <pre className="guest-out mt-2 max-h-80 overflow-auto text-xs">
                  {run.metrics.disasm.join('\n')}
                </pre>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="hud-kicker">{label}</dt>
      <dd className="font-mono text-base">{value}</dd>
    </div>
  )
}
