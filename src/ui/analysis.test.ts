import { describe, expect, it } from 'vitest'
import { runComparison, type CompareResult } from '../engine/compare.ts'
import { ALL_ISAS, ISA_META, IsaId, type ExecutionCounts, type InstClass, type Metrics } from '../engine/types.ts'
import {
  METRIC_DEFS,
  analyze,
  comparableRows,
  excludedRows,
  fmtClock,
  fmtTime,
  metricsFor,
  mixShare,
  primaryMeasure,
} from './analysis.ts'

function mix(partial: Partial<Record<InstClass, number>> = {}): Record<InstClass, number> {
  return {
    alu: 0,
    mul: 0,
    div: 0,
    ld: 0,
    st: 0,
    br: 0,
    fp: 0,
    mov: 0,
    nop: 0,
    ...partial,
  }
}

const analysisBase = runComparison({
  workloadId: 'int_sum',
  n: 8,
  seed: 1,
  isas: [IsaId.RISCV],
  hardwareMode: 'same',
  profileId: 'equal-inorder',
})

function row(over: Partial<Metrics> & Pick<Metrics, 'isa' | 'cycles' | 'instructions'>): Metrics {
  return {
    ...analysisBase.rows[0],
    ...over,
    mix: over.mix ?? mix({ alu: over.instructions }),
  }
}

function counts(over: Partial<ExecutionCounts> = {}): ExecutionCounts {
  return {
    instructionBytes: 400,
    loads: 20,
    stores: 10,
    memoryInstructions: 28,
    conditionalBranches: 30,
    takenConditionalBranches: 12,
    calls: 5,
    returns: 5,
    indirectJumps: 0,
    codeFootprintBytes: 200,
    platformTraps: 0,
    ...over,
  }
}

function result(rows: Metrics[], extra: Partial<CompareResult> = {}): CompareResult {
  return { ...analysisBase, ...extra, rows }
}

/** A real-ISA result, whose rows carry counted figures. */
function realResult(rows: Metrics[], extra: Partial<CompareResult> = {}): CompareResult {
  return result(rows, {
    execution: {
      mode: 'real-isa',
      targets: rows.map((r) => ({
        isa: r.isa,
        label: r.isa.toUpperCase(),
        libc: 'musl',
        oracle: 'qemu',
        verified: 'in lockstep',
        verdict: r.matchedGold ? 'match' as const : 'unreachable' as const,
      })),
      unavailable: [],
      timingModelVersion: '2',
    },
    ...extra,
  })
}

describe('report metrics', () => {
  it('reports counted figures for real runs only, and never for the lowering', () => {
    const real = realResult([
      row({ isa: IsaId.RISCV, cycles: 100, instructions: 80, executed: counts() }),
    ])
    const lowered = result([row({ isa: IsaId.RISCV, cycles: 100, instructions: 80 })])
    const realIds = metricsFor(real).map((m) => m.id)
    const loweredIds = metricsFor(lowered).map((m) => m.id)
    expect(realIds).toEqual(expect.arrayContaining([
      'instructions', 'instructionBytes', 'memoryInstructions', 'conditionalBranches', 'codeFootprint',
    ]))
    expect(metricsFor(real).filter((m) => m.basis === 'counted').length).toBeGreaterThan(0)
    expect(metricsFor(lowered).some((m) => m.basis === 'counted')).toBe(false)
    // The lowering's own figures do not apply to a real binary.
    for (const id of ['spills', 'streamBytes', 'operations']) {
      expect(realIds).not.toContain(id)
      expect(loweredIds).toContain(id)
    }
  })

  it('leaves out what cannot support a comparison', () => {
    const ids = METRIC_DEFS.map((m) => m.id)
    for (const gone of ['ipc', 'energy', 'l2miss', 'l3miss']) expect(ids).not.toContain(gone)
    expect(METRIC_DEFS.some((m) => /ENERGY/i.test(m.label))).toBe(false)
  })

  it('shows cycles per instruction without ranking it', () => {
    const real = realResult([row({ isa: IsaId.RISCV, cycles: 100, instructions: 80, executed: counts() })])
    const cpi = metricsFor(real).find((m) => m.id === 'cpi')!
    expect(cpi.better).toBe('none')
    expect(cpi.meaning).toMatch(/not ranked/i)
    expect(METRIC_DEFS.find((m) => m.id === 'cpo')!.better).toBe('none')
  })

  it('shows platform traps only when some target took one', () => {
    const none = realResult([row({ isa: IsaId.RISCV, cycles: 1, instructions: 1, executed: counts() })])
    const some = realResult([
      row({ isa: IsaId.RISCV, cycles: 1, instructions: 1, executed: counts() }),
      row({ isa: IsaId.SPARC, cycles: 1, instructions: 1, executed: counts({ platformTraps: 4 }) }),
    ])
    expect(metricsFor(none).map((m) => m.id)).not.toContain('platformTraps')
    expect(metricsFor(some).map((m) => m.id)).toContain('platformTraps')
  })

  it('ranks by modelled time when presets give the targets different clocks', () => {
    const same = result([row({ isa: IsaId.RISCV, cycles: 1, instructions: 1 })])
    const presets = result([row({ isa: IsaId.RISCV, cycles: 1, instructions: 1 })], { hardwareMode: 'cpus' })
    expect(primaryMeasure(same)).toBe('cycles')
    expect(primaryMeasure(presets)).toBe('time')
    expect(metricsFor(same).map((m) => m.id)).not.toContain('time')
    expect(metricsFor(presets).find((m) => m.id === 'time')!.better).toBe('low')
    // Cycles at different clocks are shown, and not ranked.
    expect(metricsFor(presets).map((m) => m.id)).not.toContain('cycles')
    expect(metricsFor(presets).find((m) => m.id === 'presetCycles')!.better).toBe('none')
  })

  it('formats clocks and times at a readable scale', () => {
    expect(fmtClock(1.023)).toBe('1.023 MHz')
    expect(fmtClock(3200)).toBe('3,200 MHz')
    expect(fmtTime(12.5)).toBe('12.50 µs')
    expect(fmtTime(2_500)).toBe('2.500 ms')
    expect(fmtTime(3_000_000)).toBe('3.000 s')
  })
})

describe('report analysis', () => {
  it('leads with the fewest model cycles and explains a shared profile', () => {
    const compared = runComparison({
      workloadId: 'dot_product',
      n: 32,
      seed: 1,
      isas: ALL_ISAS,
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    const insights = analyze(compared)
    expect(insights[0]?.tag).toBe('LEAD')
    expect(insights[0]?.title).toContain('least model cycles')
    expect(insights[0]?.body).toContain('same modelled in-order core')
    expect(insights.some((i) => i.tag === 'OPERATIONS')).toBe(true)
    const shares = mixShare(compared.rows[0])
    const sum = shares.reduce((s, p) => s + p.share, 0)
    expect(sum).toBeGreaterThan(0.99)
    expect(sum).toBeLessThan(1.01)
  })

  it('measures the leader gap against the runner-up it is compared with', () => {
    const insights = analyze(result([
      row({ isa: IsaId.RISCV, cycles: 75, instructions: 50 }),
      row({ isa: IsaId.X86, cycles: 100, instructions: 50 }),
    ]))
    const lead = insights.find((insight) => insight.tag === 'LEAD')
    // 75 is 25% below 100; dividing by the leader instead would claim 33.3%.
    expect(lead?.body).toContain('25.0% below')
    expect(lead?.body).not.toContain('33.3% below')
  })

  it('ranks presets by modelled time, not by cycles at different clocks', () => {
    const insights = analyze(result([
      // Fewer cycles, but at a hundredth of the clock: slower.
      row({ isa: IsaId.MOS, cycles: 100, instructions: 50, timeUs: 100, clockMhz: 1 }),
      row({ isa: IsaId.RISCV, cycles: 400, instructions: 50, timeUs: 4, clockMhz: 100 }),
    ], { hardwareMode: 'cpus' }))
    const lead = insights.find((insight) => insight.tag === 'LEAD')!
    expect(lead.title).toContain('least modelled time')
    expect(lead.title.startsWith(ISA_META[IsaId.RISCV].short)).toBe(true)
    expect(lead.body).toContain('illustrative preset')
    expect(lead.body).toContain('not emulation or measurement')
  })

  it('names instruction counts as counted on a real run', () => {
    const insights = analyze(realResult([
      row({ isa: IsaId.RISCV, cycles: 100, instructions: 90, executed: counts() }),
      row({ isa: IsaId.ARM, cycles: 120, instructions: 60, executed: counts() }),
    ]))
    const ins = insights.find((insight) => insight.tag === 'INSTRUCTIONS')!
    expect(ins.title).toContain('retired the fewest instructions')
    expect(ins.body).toMatch(/^Counted, not modelled/)
    expect(ins.body).toContain('still needed more model cycles')
  })

  it('leaves a target that computed a different answer out of every ranking', () => {
    const narrow = row({ isa: IsaId.MOS, cycles: 10, instructions: 5, matchedGold: false, result: 7, executed: counts() })
    const compared = realResult([
      narrow,
      row({ isa: IsaId.RISCV, cycles: 100, instructions: 90, executed: counts() }),
      row({ isa: IsaId.ARM, cycles: 120, instructions: 80, executed: counts() }),
    ], { stdout: 'x\n' })
    expect(comparableRows(compared).map((r) => r.isa)).toEqual([IsaId.RISCV, IsaId.ARM])
    expect(excludedRows(compared).map((e) => e.row.isa)).toEqual([IsaId.MOS])
    const insights = analyze(compared)
    // Fewest cycles and fewest instructions are both the 6502's, which
    // did different work; neither may lead.
    expect(insights.find((i) => i.tag === 'LEAD')!.title).toMatch(/^RISCV/)
    expect(insights.find((i) => i.tag === 'INSTRUCTIONS')!.title).toMatch(/^ARM/)
    expect(insights.find((i) => i.tag === 'NOT RANKED')!.title).toContain('computed a different answer')
    expect(insights.find((i) => i.tag === 'OUTPUT')!.title).toContain('2 of 3 targets')
  })

  it('emits SOLO when only one target is compared', () => {
    const insights = analyze(result([row({ isa: IsaId.ARM, cycles: 10, instructions: 8 })]))
    expect(insights[0]?.tag).toBe('SOLO')
    expect(insights[0]?.tone).toBe('lead')
    expect(insights[0]?.body).toContain('model cycles')
  })

  it('flags PRESSURE, CACHE, BRANCH, OUTPUT and CHIP when the signals fire', () => {
    const insights = analyze(
      result(
        [
          row({
            isa: IsaId.MOS,
            cycles: 200,
            instructions: 100,
            timeUs: 200,
            spillSlots: 3,
            activeThreads: 4,
            threads: 8,
            cores: 4,
            busyCores: 4,
          }),
          row({
            isa: IsaId.RISCV,
            cycles: 100,
            instructions: 90,
            timeUs: 100,
            activeThreads: 4,
            threads: 8,
            cores: 4,
            busyCores: 4,
          }),
        ],
        { stdout: 'hello\n' },
      ),
    )
    const tags = insights.map((i) => i.tag)
    expect(tags).toContain('LEAD')
    expect(tags).toContain('PRESSURE')
    expect(tags).toContain('OUTPUT')
    expect(tags).toContain('CHIP')
    expect(insights.find((insight) => insight.tag === 'CHIP')?.body).toContain('stripes work and reduces partials')
    expect(insights.length).toBeLessThanOrEqual(6)
    expect(analyze(result([])).length).toBe(0)

    const mem = analyze(
      result([
        row({
          isa: IsaId.X86,
          cycles: 50,
          instructions: 40,
          dcHits: 5,
          dcMisses: 5,
          branches: 20,
          mispredicts: 8,
        }),
      ]),
    )
    expect(mem.map((i) => i.tag)).toContain('CACHE')
    expect(mem.map((i) => i.tag)).toContain('BRANCH')
    const cache = mem.find((i) => i.tag === 'CACHE')!
    expect(cache.title).toContain('modelled data cache')
    expect(cache.body).toContain('line misses')
    expect(mem.find((i) => i.tag === 'BRANCH')!.body).toContain('modelled predictor')
  })

  it('uses neutral worker language for source-defined custom programs', () => {
    const compared = result(
      [row({
        isa: IsaId.RISCV,
        cycles: 20,
        instructions: 12,
        activeThreads: 2,
        threads: 2,
        cores: 2,
        coresThatIssued: 2,
      })],
      {
        workload: {
          kind: 'custom-ir',
          requestedN: 2,
          effectiveN: 2,
          nRole: 'worker-cap',
          requestedSeed: 1,
          effectiveSeed: null,
          seedUsed: false,
          requestedWorkerCap: 2,
          maxUsefulWorkers: 2,
          parallelSemantics: 'source-defined',
          referenceOracle: 'ir-interpreter',
          hasIndependentExpectedCheck: false,
        },
      },
    )
    const chip = analyze(compared).find((insight) => insight.tag === 'CHIP')
    expect(chip?.body).toContain('Worker behavior is defined by the custom source')
    expect(chip?.body).not.toMatch(/stripe|reduce/)
  })

  it('drops zero-share mix buckets', () => {
    const shares = mixShare(row({ isa: IsaId.RISCV, cycles: 1, instructions: 4, mix: mix({ alu: 3, ld: 1 }) }))
    expect(shares.map((s) => s.key)).toEqual(['alu', 'ld'])
    expect(shares.reduce((n, s) => n + s.share, 0)).toBe(1)
  })
})
