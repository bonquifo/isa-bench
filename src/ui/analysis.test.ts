import { describe, expect, it } from 'vitest'
import { runComparison, type CompareResult } from '../engine/compare.ts'
import { ALL_ISAS, IsaId, type InstClass, type Metrics } from '../engine/types.ts'
import { analyze, mixShare, pickModelRankLeaders, REPORT_METRICS } from './analysis.ts'

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

function row(over: Partial<Metrics> & Pick<Metrics, 'isa' | 'cycles' | 'instructions' | 'totalEnergyNj' | 'codeBytes'>): Metrics {
  return {
    ...analysisBase.rows[0],
    ...over,
    isa: over.isa,
    cycles: over.cycles,
    instructions: over.instructions,
    totalEnergyNj: over.totalEnergyNj,
    codeBytes: over.codeBytes,
    mix: over.mix ?? mix({ alu: over.instructions }),
  }
}

function result(rows: Metrics[], extra: Partial<CompareResult> = {}): CompareResult {
  return {
    ...analysisBase,
    ...extra,
    rows,
  }
}

describe('report analysis', () => {
  it('emits a lead brief and mix shares that sum to one', () => {
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
    expect(insights[0]?.body).toContain('Shared model profile')
    expect(insights.some((i) => i.tag === 'DENSITY')).toBe(true)
    const shares = mixShare(compared.rows[0])
    const sum = shares.reduce((s, p) => s + p.share, 0)
    expect(sum).toBeGreaterThan(0.99)
    expect(sum).toBeLessThan(1.01)
  })

  it('measures the leader gap against the runner-up it is compared with', () => {
    const insights = analyze(result([
      row({ isa: IsaId.RISCV, cycles: 75, instructions: 50, totalEnergyNj: 10, codeBytes: 10 }),
      row({ isa: IsaId.X86, cycles: 100, instructions: 50, totalEnergyNj: 10, codeBytes: 10 }),
    ]))
    const lead = insights.find((insight) => insight.tag === 'LEAD')
    // 75 is 25% below 100; dividing by the leader instead would claim 33.3%.
    expect(lead?.body).toContain('25.0% below')
    expect(lead?.body).not.toContain('33.3% below')
  })

  it('picks model-qualified rank leaders independently', () => {
    const rows = [
      row({ isa: IsaId.RISCV, cycles: 100, instructions: 80, totalEnergyNj: 50, codeBytes: 40 }),
      row({ isa: IsaId.X86, cycles: 90, instructions: 70, totalEnergyNj: 80, codeBytes: 20 }),
    ]
    expect(pickModelRankLeaders(rows)).toEqual({
      modelCycles: 'x86',
      nominalModelEnergy: 'riscv',
      modeledStreamBytes: 'x86',
    })
    expect(pickModelRankLeaders([])).toEqual({})
  })

  it('emits SOLO when only one ISA is on the bus', () => {
    const insights = analyze(result([row({ isa: IsaId.ARM, cycles: 10, instructions: 8, totalEnergyNj: 1, codeBytes: 4 })]))
    expect(insights[0]?.tag).toBe('SOLO')
    expect(insights[0]?.tone).toBe('lead')
    expect(insights[0]?.body).toContain('completed modeled operations after drain')
    expect(insights[0]?.body).not.toMatch(/\bCPI\b|retired ops|(?<!model )cycles/)
  })

  it('flags PRESSURE, CACHE, BRANCH, STDOUT, and CHIP when the signals fire', () => {
    const insights = analyze(
      result(
        [
          row({
            isa: IsaId.MOS,
            cycles: 200,
            instructions: 100,
            totalEnergyNj: 10,
            codeBytes: 80,
            spillSlots: 3,
            dcHits: 10,
            dcMisses: 10,
            branches: 20,
            mispredicts: 8,
            activeThreads: 4,
            threads: 8,
            cores: 4,
            busyCores: 4,
            ipc: 0.5,
          }),
          row({
            isa: IsaId.RISCV,
            cycles: 100,
            instructions: 90,
            totalEnergyNj: 8,
            codeBytes: 40,
            activeThreads: 4,
            threads: 8,
            cores: 4,
            busyCores: 4,
          }),
        ],
        { stdout: 'hello\n', hardwareMode: 'cpus' },
      ),
    )
    const tags = insights.map((i) => i.tag)
    expect(tags).toContain('LEAD')
    expect(tags).toContain('PRESSURE')
    expect(tags).toContain('STDOUT')
    expect(tags).toContain('CHIP')
    expect(insights[0]?.body).toContain('named illustrative parameter presets')
    expect(insights[0]?.body).toContain('not emulation or measurement')
    expect(insights.find((insight) => insight.tag === 'CHIP')?.body).toContain('stripes work and reduces partials')
    expect(insights.length).toBeLessThanOrEqual(5)
    expect(analyze(result([])).length).toBe(0)

    const mem = analyze(
      result([
        row({
          isa: IsaId.X86,
          cycles: 50,
          instructions: 40,
          totalEnergyNj: 3,
          codeBytes: 16,
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
    expect(cache.title).toContain('D-cache line misses')
    expect(cache.body).toContain('line misses')
    expect(cache.body).toContain('Coalesced requests')
    expect(cache.body).not.toContain(' fills.')
  })

  it('uses neutral worker language for source-defined custom programs', () => {
    const compared = result(
      [row({
        isa: IsaId.RISCV,
        cycles: 20,
        instructions: 12,
        totalEnergyNj: 2,
        codeBytes: 8,
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

  it('defines model-qualified inverse aggregate operation rates', () => {
    expect(REPORT_METRICS.map((m) => m.id)).toContain('cycles')
    const fake = row({ isa: IsaId.RISCV, cycles: 20, instructions: 10, totalEnergyNj: 1, codeBytes: 8 })
    const cpi = REPORT_METRICS.find((m) => m.id === 'cpi')!
    const ipc = REPORT_METRICS.find((m) => m.id === 'ipc')!
    expect(cpi.value(fake) * ipc.value(fake)).toBeCloseTo(1, 10)
    expect(cpi.better).toBe('low')
    expect(ipc.better).toBe('high')
  })

  it('drops zero-share mix buckets', () => {
    const shares = mixShare(row({ isa: IsaId.RISCV, cycles: 1, instructions: 4, totalEnergyNj: 1, codeBytes: 4, mix: mix({ alu: 3, ld: 1 }) }))
    expect(shares.map((s) => s.key)).toEqual(['alu', 'ld'])
    expect(shares.reduce((n, s) => n + s.share, 0)).toBe(1)
  })
})

