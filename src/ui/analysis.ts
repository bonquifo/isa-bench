/**
 * What the report measures, and what it says about it.
 *
 * Every metric states its basis. **Counted** figures are exact counts of
 * what a verified interpreter executed -- they exist only for real-ISA
 * rows, and two targets' counts differ only because their instruction
 * sets, compilers and libraries do. **Modelled** figures come from the
 * deterministic timing model, the same one for every target.
 *
 * A metric is ranked only where less (or more) of it is better for the
 * same work. Model cycles per instruction is shown but not ranked: an x86
 * instruction and a WebAssembly one do different amounts of work, so a
 * target with more, simpler instructions gets a lower figure without being
 * any faster.
 *
 * Deliberately absent: the reciprocal of cycles per instruction, which
 * says nothing the figure itself does not; L2 and L3 miss rates, which for
 * these working sets are every-first-touch misses and so near 100% on every
 * target; and energy, which is an uncalibrated estimate built on per-ISA
 * weights nobody measured, and cannot support a comparison. Energy stays in
 * the JSON export for compatibility, and is not reported.
 */
import { type IsaId, type Metrics } from '../engine/types.ts'
import type { CompareResult } from '../engine/compare.ts'
import { fmtFixed, fmtInt, pct } from './format.ts'
import { isRealResult, targetShort } from './targetNames.ts'

export interface Insight {
  tag: string
  title: string
  body: string
  tone: 'lead' | 'warn' | 'info'
}

export type MetricBasis = 'counted' | 'modelled'

export interface MetricDef {
  id: string
  label: string
  unit: string
  basis: MetricBasis
  /** Which way is better for the same work; 'none' is shown, not ranked. */
  better: 'low' | 'high' | 'none'
  /** One line on what the figure is, shown beside its label. */
  meaning: string
  value: (r: Metrics) => number
  display: (r: Metrics) => string
  /** Whether this metric applies to a result at all. */
  applies: (result: CompareResult) => boolean
}

/** The rows a ranking may include: those that did the reference's work. */
export function comparableRows(result: CompareResult): Metrics[] {
  return result.rows.filter((row) => row.matchedGold)
}

/** Rows shown but left out of every ranking, with the reason. */
export function excludedRows(result: CompareResult): { row: Metrics; reason: string }[] {
  return result.rows
    .filter((row) => !row.matchedGold)
    .map((row) => ({
      row,
      reason: 'Its C int is too narrow to hold this answer, so it computed a different value -- different work, so it is not ranked.',
    }))
}

/**
 * What the ranking at the top of the report orders by.
 *
 * With one shared profile every target runs at the same clock, so model
 * cycles and modelled time order identically and cycles are the plainer
 * unit. With a preset per target the clocks differ, cycles stop being
 * comparable, and only modelled time is.
 */
export function primaryMeasure(result: CompareResult): 'cycles' | 'time' {
  return result.hardwareMode === 'same' ? 'cycles' : 'time'
}

export function primaryValue(result: CompareResult, row: Metrics): number {
  return primaryMeasure(result) === 'cycles' ? row.cycles : row.timeUs
}

/** Modelled time, in the largest unit that keeps it readable. */
export function fmtTime(us: number): string {
  if (us >= 1_000_000) return `${fmtFixed(us / 1_000_000, 3)} s`
  if (us >= 1000) return `${fmtFixed(us / 1000, 3)} ms`
  return `${fmtFixed(us, 2)} µs`
}

/** A clock parameter, precise enough to tell a 1.023 MHz part from 1 MHz. */
export function fmtClock(mhz: number): string {
  return mhz >= 100 ? `${fmtInt(mhz)} MHz` : `${Number(mhz.toPrecision(4))} MHz`
}

export function displayPrimary(result: CompareResult, row: Metrics): string {
  return primaryMeasure(result) === 'cycles' ? fmtInt(row.cycles) : fmtTime(row.timeUs)
}

const real = (result: CompareResult): boolean => isRealResult(result)
const lowered = (result: CompareResult): boolean => !isRealResult(result)
const always = (): boolean => true

function counted(row: Metrics): NonNullable<Metrics['executed']> {
  if (!row.executed) throw new Error(`${row.isa} has no counted execution figures`)
  return row.executed
}

export const METRIC_DEFS: readonly MetricDef[] = [
  // ---- Counted: exact, from the real execution -------------------------
  {
    id: 'instructions',
    label: 'INSTRUCTIONS RETIRED',
    unit: 'instructions',
    basis: 'counted',
    better: 'low',
    meaning: 'Every instruction the program executed, library code included.',
    value: (r) => r.instructions,
    display: (r) => fmtInt(r.instructions),
    applies: real,
  },
  {
    id: 'instructionBytes',
    label: 'INSTRUCTION BYTES EXECUTED',
    unit: 'bytes',
    basis: 'counted',
    better: 'low',
    meaning: 'The encoded size of every instruction retired: what instruction fetch had to read.',
    value: (r) => counted(r).instructionBytes,
    display: (r) => `${fmtInt(counted(r).instructionBytes)} B`,
    applies: real,
  },
  {
    id: 'memoryInstructions',
    label: 'DATA-MEMORY INSTRUCTIONS',
    unit: 'instructions',
    basis: 'counted',
    better: 'low',
    meaning: 'Instructions that read or wrote data memory, including implicit stack traffic such as a call that pushes its return address. One that both reads and writes is one instruction, counted in both columns.',
    value: (r) => counted(r).memoryInstructions,
    display: (r) => {
      const e = counted(r)
      return `${fmtInt(e.memoryInstructions)} · ${fmtInt(e.loads)} read · ${fmtInt(e.stores)} write`
    },
    applies: real,
  },
  {
    id: 'conditionalBranches',
    label: 'CONDITIONAL BRANCHES',
    unit: 'branches',
    basis: 'counted',
    better: 'low',
    meaning: 'Branches that depended on a condition, and the share that were taken.',
    value: (r) => counted(r).conditionalBranches,
    display: (r) => {
      const e = counted(r)
      return `${fmtInt(e.conditionalBranches)} · ${pct(e.takenConditionalBranches, e.conditionalBranches)} taken`
    },
    applies: real,
  },
  {
    id: 'codeFootprint',
    label: 'CODE EXECUTED',
    unit: 'distinct bytes',
    basis: 'counted',
    better: 'low',
    meaning: 'Distinct instruction bytes executed at least once: the code this run needed, library code included.',
    value: (r) => counted(r).codeFootprintBytes,
    display: (r) => `${fmtInt(counted(r).codeFootprintBytes)} B`,
    applies: real,
  },
  {
    id: 'platformTraps',
    label: 'PLATFORM TRAPS',
    unit: 'traps',
    basis: 'counted',
    better: 'low',
    meaning: 'Traps taken on the program\'s behalf, such as SPARC register-window spills and fills.',
    value: (r) => counted(r).platformTraps,
    display: (r) => fmtInt(counted(r).platformTraps),
    applies: (result) => real(result) &&
      result.rows.some((row) => (row.executed?.platformTraps ?? 0) > 0),
  },

  // ---- Modelled: the timing model ---------------------------------------
  {
    id: 'time',
    label: 'MODELLED TIME',
    unit: 'model µs',
    basis: 'modelled',
    better: 'low',
    meaning: 'Model cycles divided by each preset\'s clock parameter. Not stopwatch time.',
    value: (r) => r.timeUs,
    display: (r) => fmtTime(r.timeUs),
    applies: (result) => result.hardwareMode !== 'same',
  },
  {
    id: 'cycles',
    label: 'MODEL CYCLES',
    unit: 'model cycles',
    basis: 'modelled',
    better: 'low',
    meaning: 'Cycles on the modelled in-order core, from first instruction to last completion.',
    value: (r) => r.cycles,
    display: (r) => fmtInt(r.cycles),
    applies: (result) => result.hardwareMode === 'same',
  },
  {
    id: 'presetCycles',
    label: 'MODEL CYCLES',
    unit: 'model cycles',
    basis: 'modelled',
    better: 'none',
    meaning: 'Not ranked: each preset has its own clock, so cycles do not compare across them. Modelled time does.',
    value: (r) => r.cycles,
    display: (r) => `${fmtInt(r.cycles)} at ${fmtClock(r.clockMhz)}`,
    applies: (result) => result.hardwareMode !== 'same',
  },
  {
    id: 'operations',
    label: 'DYNAMIC MODELED OPERATIONS',
    unit: 'modeled ops',
    basis: 'modelled',
    better: 'low',
    meaning: 'The lowering the engine produced for each target: completed modeled operations after drain.',
    value: (r) => r.completedOperations,
    display: (r) => fmtInt(r.completedOperations),
    applies: lowered,
  },
  {
    id: 'cpi',
    label: 'MODEL CYCLES PER INSTRUCTION',
    unit: 'model cycles / instruction',
    basis: 'modelled',
    better: 'none',
    meaning: 'Not ranked: instructions do different amounts of work on different instruction sets, so a lower figure is not faster by itself.',
    value: (r) => r.modelCyclesPerAggregateOp,
    display: (r) => fmtFixed(r.modelCyclesPerAggregateOp, 3),
    applies: real,
  },
  {
    id: 'cpo',
    label: 'MODEL CYCLES PER MODELED OPERATION',
    unit: 'model cycles / op',
    basis: 'modelled',
    better: 'none',
    meaning: 'Not ranked: each target\'s operations do different amounts of work, so a lower figure is not faster by itself.',
    value: (r) => r.modelCyclesPerAggregateOp,
    display: (r) => fmtFixed(r.modelCyclesPerAggregateOp, 3),
    applies: lowered,
  },
  {
    id: 'mispredicts',
    label: 'BRANCH MISPREDICTIONS',
    unit: 'mispredictions',
    basis: 'modelled',
    better: 'low',
    meaning: 'Conditional branches the modelled predictor guessed wrongly, and the rate per conditional branch.',
    value: (r) => r.mispredicts,
    display: (r) => `${fmtInt(r.mispredicts)} · ${pct(r.mispredicts, r.branches)}`,
    applies: always,
  },
  {
    id: 'icMisses',
    label: 'I-CACHE MISSES',
    unit: 'line misses',
    basis: 'modelled',
    better: 'low',
    meaning: 'Instruction-cache line misses, and the miss rate per line access.',
    value: (r) => r.icMisses,
    display: (r) => `${fmtInt(r.icMisses)} · ${pct(r.icMisses, r.icHits + r.icMisses)}`,
    applies: always,
  },
  {
    id: 'dcMisses',
    label: 'D-CACHE MISSES',
    unit: 'line misses',
    basis: 'modelled',
    better: 'low',
    meaning: 'Data-cache line misses, and the miss rate per line access.',
    value: (r) => r.dcMisses,
    display: (r) => `${fmtInt(r.dcMisses)} · ${pct(r.dcMisses, r.dcHits + r.dcMisses)}`,
    applies: always,
  },
  {
    id: 'memoryRequests',
    label: 'MEMORY LINE REQUESTS',
    unit: 'lines',
    basis: 'modelled',
    better: 'low',
    meaning: 'Cache lines that had to come from main memory, instruction and data together.',
    value: (r) => r.dramRequests,
    display: (r) => fmtInt(r.dramRequests),
    applies: always,
  },
  {
    id: 'spills',
    label: 'SPILL SLOTS',
    unit: 'slots',
    basis: 'modelled',
    better: 'low',
    meaning: 'Live ranges the engine\'s register allocator could not keep in registers.',
    value: (r) => r.spillSlots,
    display: (r) => String(r.spillSlots),
    applies: lowered,
  },
  {
    id: 'streamBytes',
    label: 'MODELED STREAM BYTES',
    unit: 'bytes',
    basis: 'modelled',
    better: 'low',
    meaning: 'Bytes the lowering assigned to its instruction stream. Not the size of a real binary.',
    value: (r) => r.codeBytes,
    display: (r) => `${fmtInt(r.codeBytes)} B`,
    applies: lowered,
  },
  {
    id: 'workers',
    label: 'EFFECTIVE ACTIVE WORKERS',
    unit: 'workers',
    basis: 'modelled',
    better: 'none',
    meaning: 'Modeled workers that completed operations, of the hardware threads available.',
    value: (r) => r.activeThreads,
    display: (r) => `${r.activeThreads} / ${r.threads} · ${r.coresThatIssued} cores issued`,
    applies: (result) => lowered(result) && result.rows.some((row) => row.activeThreads > 1),
  },
]

/** The metrics that apply to this result, counted ones first. */
export function metricsFor(result: CompareResult): MetricDef[] {
  return METRIC_DEFS.filter((metric) => metric.applies(result))
}

export function analyze(result: CompareResult): Insight[] {
  const rows = comparableRows(result)
  if (rows.length === 0) return []
  const name = (id: IsaId) => targetShort(result, id)
  const isReal = isRealResult(result)
  const byTime = primaryMeasure(result) === 'time'
  const unitWord = byTime ? 'modelled time' : 'model cycles'
  const ranked = [...rows].sort((a, b) => primaryValue(result, a) - primaryValue(result, b))
  const lead = ranked[0]!
  const out: Insight[] = []

  const why = result.hardwareMode === 'same'
    ? isReal
      ? 'Every target ran on the same modelled in-order core, so the difference comes from the instruction streams.'
      : 'Every target ran on the same modelled in-order core, so the difference comes from the engine\'s lowering for each target.'
    : 'Each target ran on its own illustrative preset: named parameter sets on the same in-order model, not emulation or measurement.'

  if (ranked.length === 1) {
    out.push({
      tag: 'SOLO',
      title: `${name(lead.isa)} is the only target compared`,
      body: `${displayPrimary(result, lead)} ${byTime ? 'of modelled time' : 'model cycles'}.`,
      tone: 'lead',
    })
  } else {
    const runner = ranked[1]!
    const leadValue = primaryValue(result, lead)
    const runnerValue = primaryValue(result, runner)
    // "below the runner-up" is measured against the runner-up, so the
    // runner-up is the denominator; dividing by the leader would overstate
    // the margin.
    const gap = runnerValue === 0 ? 0 : ((runnerValue - leadValue) / runnerValue) * 100
    out.push({
      tag: 'LEAD',
      title: `${name(lead.isa)} needed the least ${unitWord}`,
      body: `${displayPrimary(result, lead)}${byTime ? '' : ' model cycles'} — ${fmtFixed(gap, 1)}% below ${name(runner.isa)}. ${why}`,
      tone: 'lead',
    })
  }

  for (const { row } of excludedRows(result)) {
    out.push({
      tag: 'NOT RANKED',
      title: `${name(row.isa)} computed a different answer`,
      body: `It returned ${row.result} where the reference returned ${result.gold}: its C int is too narrow to hold the answer. It did different work, so it is shown but left out of every ranking.`,
      tone: 'warn',
    })
  }

  if (rows.length > 1) {
    const fewest = [...rows].sort((a, b) => a.instructions - b.instructions)[0]!
    const most = [...rows].sort((a, b) => b.instructions - a.instructions)[0]!
    const what = isReal ? 'instructions' : 'modeled operations'
    const basis = isReal ? 'Counted, not modelled: ' : ''
    const spread = `${fmtInt(fewest.instructions)} against ${fmtInt(most.instructions)} for ${name(most.isa)}, ${fmtFixed(most.instructions / Math.max(1, fewest.instructions), 2)}× as many.`
    const relation = fewest.isa === lead.isa
      ? `${name(lead.isa)} also needed the least ${unitWord}.`
      : `It still needed more ${unitWord} than ${name(lead.isa)}, which retired ${fmtInt(lead.instructions)}.`
    out.push({
      tag: isReal ? 'INSTRUCTIONS' : 'OPERATIONS',
      title: `${name(fewest.isa)} ${isReal ? 'retired' : 'completed'} the fewest ${what}`,
      body: `${basis}${spread} ${relation}`,
      tone: 'info',
    })
  }

  if (result.stdout) {
    const shown = result.stdout.length > 80 ? `${result.stdout.slice(0, 77)}…` : result.stdout
    const checked = rows.length === result.rows.length
      ? 'every target'
      : `${rows.length} of ${result.rows.length} targets`
    out.push({
      tag: 'OUTPUT',
      title: `Output matched the reference on ${checked}`,
      body: `${JSON.stringify(shown)} — the same bytes and the same return value, checked before anything was ranked.`,
      tone: 'info',
    })
  }

  const parallel = [...rows].sort((a, b) => b.activeThreads - a.activeThreads)[0]
  if (parallel && parallel.activeThreads > 1) {
    const workerDetail = result.workload.parallelSemantics === 'spmd-striped'
      ? 'The built-in workload stripes work and reduces partials; its reference runs as tid=0 / nthreads=1.'
      : 'Worker behavior is defined by the custom source; the reference runs as tid=0 / nthreads=1.'
    out.push({
      tag: 'CHIP',
      title: `${parallel.activeThreads} modeled workers completed operations`,
      body: `${parallel.coresThatIssued} core${parallel.coresThatIssued === 1 ? '' : 's'} issued of ${parallel.cores} · ${parallel.threads} logical. ${workerDetail}`,
      tone: 'info',
    })
  }

  const spilled = [...rows].filter((r) => r.spillSlots > 0).sort((a, b) => b.spillSlots - a.spillSlots)
  if (spilled[0]) {
    out.push({
      tag: 'PRESSURE',
      title: `${name(spilled[0].isa)} spilled ${spilled[0].spillSlots} live range${spilled[0].spillSlots === 1 ? '' : 's'}`,
      body: 'The engine\'s register allocator ran out of registers on this target and kept values on the stack, which shows up as extra modeled loads and stores.',
      tone: 'warn',
    })
  }

  const memBound = [...rows]
    .map((r) => ({ r, rate: r.dcMisses / Math.max(1, r.dcHits + r.dcMisses) }))
    .sort((a, b) => b.rate - a.rate)[0]
  if (memBound && memBound.rate >= 0.08) {
    out.push({
      tag: 'CACHE',
      title: `${name(memBound.r.isa)} missed the modelled data cache most often`,
      body: `${pct(memBound.r.dcMisses, memBound.r.dcHits + memBound.r.dcMisses)} of its data-cache line accesses missed · ${fmtInt(memBound.r.dcMisses)} line misses.`,
      tone: 'warn',
    })
  }

  const pred = [...rows]
    .map((r) => ({ r, rate: r.mispredicts / Math.max(1, r.branches) }))
    .sort((a, b) => b.rate - a.rate)[0]
  if (pred && pred.r.branches >= 8 && pred.rate >= 0.18) {
    out.push({
      tag: 'BRANCH',
      title: `${name(pred.r.isa)} had the highest modelled misprediction rate`,
      body: `${fmtInt(pred.r.mispredicts)} of ${fmtInt(pred.r.branches)} conditional branches (${pct(pred.r.mispredicts, pred.r.branches)}) were guessed wrongly by the modelled predictor, each costing a pipeline refill.`,
      tone: 'warn',
    })
  }

  return out.slice(0, 6)
}

export function mixShare(row: Metrics): { key: string; n: number; share: number }[] {
  const keys = ['alu', 'mul', 'div', 'ld', 'st', 'br', 'fp', 'mov', 'nop'] as const
  const total = Math.max(1, keys.reduce((s, k) => s + row.mix[k], 0))
  return keys
    .map((key) => ({ key, n: row.mix[key], share: row.mix[key] / total }))
    .filter((x) => x.n > 0)
}

export const MIX_COLORS: Record<string, string> = {
  alu: '#00f0ff',
  mul: '#ff6b2b',
  div: '#ff2bd6',
  ld: '#c8ff3d',
  st: '#7cffb2',
  br: '#ff4d6d',
  fp: '#b388ff',
  mov: '#8ea2c6',
  nop: '#4a5568',
}
