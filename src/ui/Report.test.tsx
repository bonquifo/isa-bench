import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_ID, runComparison } from '../engine/index.ts'
import { Report } from './Report.tsx'

describe('in-order report evidence contract', () => {
  it('shows analytical proof badge and model contract for strict current results', () => {
    const result = runComparison({
      workloadId: 'dot_product',
      n: 4,
      seed: 1,
      isas: ['riscv'],
      hardwareMode: 'same',
      profileId: DEFAULT_PROFILE_ID,
    })
    const html = renderToStaticMarkup(<Report result={result} />)
    expect(html).toContain('SIMULATED ANALYTICAL')
    expect(html).toContain('MODEL CONTRACT')
    expect(html).toContain('software-model-only')
  })

  it('labels legacy reports as unversioned and does not issue evidence badges', () => {
    const html = renderToStaticMarkup(<Report result={{
      gold: 1,
      workloadId: 'old',
      workloadName: 'Old result',
      hardwareMode: 'same',
      n: 1,
      seed: 1,
      rows: [],
    }} />)
    expect(html).toContain('LEGACY UNVERSIONED MODEL ARCHIVE')
    expect(html).not.toContain('SIMULATED ANALYTICAL')
  })

  it('omits empty separators for workloads that report neither N nor seed', () => {
    const result = runComparison({
      workloadId: 'c-fib',
      n: 1,
      seed: 1,
      isas: ['riscv'],
      hardwareMode: 'same',
      profileId: DEFAULT_PROFILE_ID,
    })
    const header = renderToStaticMarkup(<Report result={result} />)
      .replace(/<[^>]+>/g, '')
    expect(header).toContain('JOB/C-FIB · 1C/1T · 1 ACTIVE WORKERS')
    expect(header).not.toContain('· ·')
  })

  it('does not claim parity when a zero baseline has no defined relative change', () => {
    const result = runComparison({
      workloadId: 'dot_product',
      n: 8,
      seed: 1,
      isas: ['riscv', 'mos'],
      hardwareMode: 'same',
      profileId: DEFAULT_PROFILE_ID,
    })
    const baseline = result.rows.find((row) => row.isa === 'riscv')
    const other = result.rows.find((row) => row.isa === 'mos')
    expect(baseline?.spillSlots).toBe(0)
    expect(other?.spillSlots).toBeGreaterThan(0)
    const html = renderToStaticMarkup(<Report result={result} />)
    const spills = html.slice(html.indexOf('SPILL SLOTS'), html.indexOf('SPILL SLOTS') + 2000)
    expect(spills).toContain('∞')
    expect(spills).not.toContain('>0%<')
    expect(spills).toContain('>—<')
  })
})
