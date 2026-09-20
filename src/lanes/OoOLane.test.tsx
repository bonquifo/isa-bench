import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ALL_ISAS,
  DEFAULT_OOO_PROFILE,
  DEFAULT_PROFILE_ID,
  ISA_META,
  OOO_ENERGY_MODEL_VERSION,
  OOO_MODEL_VERSION,
  WORKLOADS,
  runOoOComparison,
  type OoOCompareInput,
} from '../engine/index.ts'
import { OoOLane, OoOReport } from './OoOLane.tsx'

/**
 * The lane creates its Web Worker only inside run(), so the control surface
 * renders in the node test environment. What is asserted here is the contract
 * between the lane and the engine: every target is offered and selected, the
 * tuning fields are seeded from the shared default profile, and nothing claims
 * a result before one has been produced.
 */
describe('detailed OoO lane', () => {
  const html = renderToStaticMarkup(<OoOLane />)

  it('offers every modeled ISA, selected by default', () => {
    for (const isa of ALL_ISAS) {
      expect(html).toContain(ISA_META[isa].short)
    }
    expect(html.match(/type="checkbox"/g)).toHaveLength(ALL_ISAS.length)
    expect(html.match(/checked=""/g)).toHaveLength(ALL_ISAS.length)
  })

  it('lists the runnable workloads and excludes the custom-IR entry', () => {
    const selectable = WORKLOADS.filter((item) => item.id !== 'custom')
    for (const workload of selectable) {
      expect(html).toContain(`value="${workload.id}"`)
    }
    expect(html).not.toContain('value="custom"')
    expect(html.match(/<option/g)).toHaveLength(selectable.length)
  })

  it('seeds the tuning fields from the shared default OoO profile', () => {
    expect(html).toContain(DEFAULT_OOO_PROFILE.name)
    for (const value of [
      DEFAULT_OOO_PROFILE.issueWidth,
      DEFAULT_OOO_PROFILE.robEntries,
      DEFAULT_OOO_PROFILE.physicalRegisters,
      DEFAULT_OOO_PROFILE.recoveryCycles,
    ]) {
      expect(html).toContain(`value="${value}"`)
    }
  })

  it('shows an idle empty state rather than implying a result exists', () => {
    expect(html).toContain('IDLE')
    expect(html).toContain('Run the browser OoO model')
    expect(html).toContain('RUN MODEL')
    expect(html).not.toContain('MODEL RESULT')
    expect(html).not.toContain('role="alert"')
  })

  it('marks the progress region as a live region for assistive technology', () => {
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-busy="false"')
  })
})

describe('detailed OoO report', () => {
  // A real engine result, so the report is asserted against numbers the model
  // actually produced rather than a hand-written fixture that cannot drift.
  const input: OoOCompareInput = {
    workloadId: 'custom',
    n: 1,
    seed: 1,
    isas: ['riscv', 'arm'],
    hardwareMode: 'same',
    profileId: DEFAULT_PROFILE_ID,
    oooProfile: DEFAULT_OOO_PROFILE,
    customSource: `
      imm r0, 3
      imm r1, 4
      add r2, r0, r1
      mul r3, r2, r0
      halt r3
    `,
  }
  const result = runOoOComparison(input)
  const html = renderToStaticMarkup(<OoOReport result={result} rerunInput={input} />)

  it('renders one labelled section per requested target', () => {
    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(html).toContain(ISA_META[row.isa].full)
    }
    expect(html.match(/SIMULATED ANALYTICAL/g)).toHaveLength(2)
  })

  it('shows the cycle counts the model actually produced', () => {
    for (const row of result.rows) {
      expect(html).toContain(String(row.cycles))
      expect(html).toContain(row.ipc.toFixed(3))
      expect(html).toContain(String(row.counts.retiredOps))
    }
    // 3 * (3 + 4) = 21, so the report is showing a correct run.
    expect(result.rows.every((row) => row.result === 21)).toBe(true)
  })

  it('states the model and energy versions and keeps energy labelled uncalibrated', () => {
    expect(html).toContain(OOO_MODEL_VERSION)
    expect(html).toContain(OOO_ENERGY_MODEL_VERSION)
    expect(html).toContain('uncalibrated event estimate and not measured energy')
    expect(html).toContain('analytical-model-cycles')
  })

  it('gives every target in one run the same comparison group key, which is what makes them rankable', () => {
    const keys = result.envelopes.map((envelope) => envelope.comparisonGroupKey)
    expect(keys).toHaveLength(2)
    // The key deliberately excludes the ISA: same workload, same model, same
    // profile means these two results may be compared to each other.
    expect(new Set(keys).size).toBe(1)
    expect(html).toContain(String(keys[0]))
    for (const envelope of result.envelopes) {
      expect(envelope.comparison.metricDomain).toBe('analytical-model-cycles')
      expect(envelope.comparison.unit).toBe('model-cycle')
    }
  })

  it('changes the comparison group key when the model profile changes', () => {
    const retuned = runOoOComparison({
      ...input,
      oooProfile: { ...DEFAULT_OOO_PROFILE, issueWidth: 2, robEntries: 64 },
    })
    // A different profile is a different experiment, so its results must not
    // land in the same rankable group as the default-profile run.
    expect(retuned.envelopes[0]!.comparisonGroupKey)
      .not.toBe(result.envelopes[0]!.comparisonGroupKey)
  })
})
