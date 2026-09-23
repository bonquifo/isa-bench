import { type IsaId, type Metrics } from '../engine/types.ts'
import type { CompareResult } from '../engine/compare.ts'
import { fmtFixed, fmtInt, pct } from './format.ts'
import { targetShort } from './targetNames.ts'

export interface Insight {
  tag: string
  title: string
  body: string
  tone: 'lead' | 'warn' | 'info'
}

export interface MetricDef {
  id: string
  label: string
  unit: string
  better: 'low' | 'high'
  value: (r: Metrics) => number
  display: (r: Metrics) => string
}

export const REPORT_METRICS: MetricDef[] = [
  {
    id: 'cycles',
    label: 'MODEL CYCLES',
    unit: 'model cyc',
    better: 'low',
    value: (r) => r.cycles,
    display: (r) => fmtInt(r.cycles),
  },
  {
    id: 'insts',
    label: 'DYNAMIC MODELED OPS',
    unit: 'ops',
    better: 'low',
    value: (r) => r.completedOperations,
    display: (r) => fmtInt(r.completedOperations),
  },
  {
    id: 'cpi',
    label: 'MODEL CYCLES/AGGREGATE OP',
    unit: 'model cyc/op',
    better: 'low',
    value: (r) => r.modelCyclesPerAggregateOp,
    display: (r) => fmtFixed(r.modelCyclesPerAggregateOp, 3),
  },
  {
    id: 'ipc',
    label: 'AGGREGATE MODELED OPS/CYCLE',
    unit: 'modeled ops/model cyc',
    better: 'high',
    value: (r) => r.aggregateModeledOpsPerCycle,
    display: (r) => fmtFixed(r.aggregateModeledOpsPerCycle, 3),
  },
  {
    id: 'threads',
    label: 'EFFECTIVE ACTIVE WORKERS',
    unit: '',
    better: 'high',
    value: (r) => r.activeThreads,
    display: (r) => `${r.activeThreads} / ${r.threads} · ${r.coresThatIssued} cores issued`,
  },
  {
    id: 'l2miss',
    label: 'L2 MISS',
    unit: '%',
    better: 'low',
    value: (r) => r.l2Misses / Math.max(1, r.l2Hits + r.l2Misses),
    display: (r) => pct(r.l2Misses, r.l2Hits + r.l2Misses),
  },
  {
    id: 'l3miss',
    label: 'L3 MISS',
    unit: '%',
    better: 'low',
    value: (r) => r.l3Misses / Math.max(1, r.l3Hits + r.l3Misses),
    display: (r) => pct(r.l3Misses, r.l3Hits + r.l3Misses),
  },
  {
    id: 'time',
    label: 'MODELED ELAPSED TIME',
    unit: 'µs',
    better: 'low',
    value: (r) => r.timeUs,
    display: (r) =>
      r.timeUs >= 1000 ? `${fmtFixed(r.timeUs / 1000, 3)} ms` : `${fmtFixed(r.timeUs, 2)} µs`,
  },
  {
    id: 'energy',
    label: 'NOMINAL MODEL ENERGY (UNCALIBRATED)',
    unit: 'nJ',
    better: 'low',
    value: (r) => r.totalEnergyNj,
    display: (r) => `${fmtFixed(r.totalEnergyNj, 1)} nJ`,
  },
  {
    id: 'code',
    label: 'MODELED STREAM BYTES',
    unit: 'B',
    better: 'low',
    value: (r) => r.codeBytes,
    display: (r) => `${fmtInt(r.codeBytes)} B`,
  },
  {
    id: 'icmiss',
    label: 'I$ MISS',
    unit: '%',
    better: 'low',
    value: (r) => r.icMisses / Math.max(1, r.icHits + r.icMisses),
    display: (r) => pct(r.icMisses, r.icHits + r.icMisses),
  },
  {
    id: 'dcmiss',
    label: 'D$ MISS',
    unit: '%',
    better: 'low',
    value: (r) => r.dcMisses / Math.max(1, r.dcHits + r.dcMisses),
    display: (r) => pct(r.dcMisses, r.dcHits + r.dcMisses),
  },
  {
    id: 'mispred',
    label: 'MISPREDICT',
    unit: '',
    better: 'low',
    value: (r) => r.mispredicts / Math.max(1, r.branches),
    display: (r) => `${r.mispredicts}/${r.branches}`,
  },
  {
    id: 'spills',
    label: 'SPILLS',
    unit: 'slots',
    better: 'low',
    value: (r) => r.spillSlots,
    display: (r) => String(r.spillSlots),
  },
]

export function pickModelRankLeaders(
  rows: Metrics[],
): { modelCycles?: IsaId; nominalModelEnergy?: IsaId; modeledStreamBytes?: IsaId } {
  if (!rows.length) return {}
  const minOf = (fn: (r: Metrics) => number) =>
    rows.reduce((best, r) => (fn(r) < fn(best) ? r : best)).isa
  return {
    modelCycles: minOf((r) => r.cycles),
    nominalModelEnergy: minOf((r) => r.nominalModelEnergyNj),
    modeledStreamBytes: minOf((r) => r.codeBytes),
  }
}

export function analyze(result: CompareResult): Insight[] {
  const rows = result.rows
  if (rows.length === 0) return []
  const name = (id: IsaId) => targetShort(result, id)
  const byCycles = [...rows].sort((a, b) => a.cycles - b.cycles)
  const lead = byCycles[0]
  const out: Insight[] = []

  if (byCycles.length === 1) {
    out.push({
      tag: 'SOLO',
      title: `${name(lead.isa)} is the only signal on the bus`,
      body: `${fmtInt(lead.cycles)} model cycles, ${fmtInt(lead.completedOperations)} completed modeled operations after drain, ${fmtFixed(lead.modelCyclesPerAggregateOp, 3)} model cycles per aggregate operation.`,
      tone: 'lead',
    })
  } else {
    const runner = byCycles[1]
    // "below the runner-up" is measured against the runner-up, so the runner-up
    // is the denominator; dividing by the leader would overstate the margin.
    const gap = ((runner.cycles - lead.cycles) / Math.max(1, runner.cycles)) * 100
    out.push({
      tag: 'LEAD',
      title: `${name(lead.isa)} ranked lowest in model cycles`,
      body: `${fmtInt(lead.cycles)} model cycles — ${fmtFixed(gap, 1)}% below ${name(runner.isa)}. ${
        result.hardwareMode === 'same'
          ? 'Shared model profile gives every target the same microarchitectural budget.'
          : `${lead.hardwareName} vs ${runner.hardwareName}: named illustrative parameter presets on the same in-order model, not emulation or measurement.`
      }`,
      tone: 'lead',
    })
  }

  const byInst = [...rows].sort((a, b) => a.completedOperations - b.completedOperations)
  const dense = byInst[0]
  if (rows.length > 1 && dense.isa !== lead.isa) {
    const saved = ((lead.completedOperations - dense.completedOperations) / Math.max(1, lead.completedOperations)) * 100
    out.push({
      tag: 'DENSITY',
      title: `${name(dense.isa)} completed the fewest modeled operations`,
      body: `${fmtInt(dense.completedOperations)} vs ${fmtInt(lead.completedOperations)} for the model-cycle leader (${fmtFixed(saved, 1)}% fewer). It still ranked higher in model cycles because model cycles per aggregate operation were ${fmtFixed(dense.modelCyclesPerAggregateOp, 2)} against ${fmtFixed(lead.modelCyclesPerAggregateOp, 2)}.`,
      tone: 'info',
    })
  } else if (rows.length > 1 && dense.isa === lead.isa) {
    out.push({
      tag: 'DENSITY',
      title: `${name(lead.isa)} ranked lowest on model cycles and completed modeled operations`,
      body: `The model-cycle leader also completed the fewest dynamic modeled operations after drain (${fmtInt(lead.completedOperations)} ops).`,
      tone: 'info',
    })
  }

  if (result.stdout) {
    const shown = result.stdout.length > 80 ? `${result.stdout.slice(0, 77)}…` : result.stdout
    out.push({
      tag: 'STDOUT',
      title: 'Guest printf matched across every ISA',
      body: `The reference captured ${result.stdout.length} byte${result.stdout.length === 1 ? '' : 's'} of stdout. ${JSON.stringify(shown)} — same return code and same bytes before model-cycle ranking.`,
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
      body: `${parallel.coresThatIssued} core${parallel.coresThatIssued === 1 ? '' : 's'} issued of ${parallel.cores} · ${parallel.threads} logical · aggregate modeled ops/cycle ${fmtFixed(parallel.aggregateModeledOpsPerCycle, 2)}. ${workerDetail}`,
      tone: 'info',
    })
  }

  const spilled = [...rows].filter((r) => r.spillSlots > 0).sort((a, b) => b.spillSlots - a.spillSlots)
  if (spilled[0]) {
    out.push({
      tag: 'PRESSURE',
      title: `${name(spilled[0].isa)} spilled ${spilled[0].spillSlots} live range${spilled[0].spillSlots === 1 ? '' : 's'}`,
      body: 'Architectural GPR scarcity forced stack traffic the wider register files avoided. That shows up as extra modeled loads and more model cycles per aggregate operation.',
      tone: 'warn',
    })
  }

  const memBound = [...rows]
    .map((r) => ({
      r,
      rate: r.dcMisses / Math.max(1, r.dcHits + r.dcMisses),
    }))
    .sort((a, b) => b.rate - a.rate)[0]
  if (memBound && memBound.rate >= 0.08) {
    out.push({
      tag: 'CACHE',
      title: `${name(memBound.r.isa)} is adding model cycles for D-cache line misses`,
      body: `${pct(memBound.r.dcMisses, memBound.r.dcHits + memBound.r.dcMisses)} miss rate · ${fmtInt(memBound.r.dcMisses)} line misses. Coalesced requests can share one lower-level fill.`,
      tone: 'warn',
    })
  }

  const pred = [...rows]
    .map((r) => ({
      r,
      rate: r.mispredicts / Math.max(1, r.branches),
    }))
    .sort((a, b) => b.rate - a.rate)[0]
  if (pred && pred.r.branches >= 8 && pred.rate >= 0.18) {
    out.push({
      tag: 'BRANCH',
      title: `${name(pred.r.isa)} is eating mispredict penalties`,
      body: `${pred.r.mispredicts} misses on ${pred.r.branches} branches (${pct(pred.r.mispredicts, pred.r.branches)}). Control-heavy kernels punish a cold or weak predictor.`,
      tone: 'warn',
    })
  }

  return out.slice(0, 5)
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
