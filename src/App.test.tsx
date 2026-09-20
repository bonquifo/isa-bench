import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'
import {
  ALL_ISAS,
  HARDWARE_PROFILES,
  ISA_META,
  WORKLOADS,
} from './engine/index.ts'

/**
 * The in-order lane is the app's front door. These assertions cover the
 * contract it has with the engine — every target offered, every workload
 * selectable, the honest modelling disclaimer present — rather than layout
 * details that are free to change.
 */
describe('in-order lane', () => {
  const html = renderToStaticMarkup(<App />)

  it('offers every modeled ISA, selected by default', () => {
    for (const isa of ALL_ISAS) {
      expect(html).toContain(ISA_META[isa].short)
    }
    // The lane uses aria-pressed chips rather than checkboxes for targets.
    expect(html.match(/aria-pressed="true"/g)?.length).toBeGreaterThanOrEqual(ALL_ISAS.length)
  })

  it('lists every workload the engine defines', () => {
    for (const workload of WORKLOADS) {
      expect(html).toContain(`value="${workload.id}"`)
    }
  })

  it('offers the shared model profile and the illustrative presets', () => {
    expect(html).toContain('aria-label="Shared model profile"')
    for (const profile of HARDWARE_PROFILES) {
      expect(html).toContain(`value="${profile.id}"`)
    }
  })

  it('never implies measurement of physical hardware', () => {
    expect(html).toContain('no physical hardware measurements or performance prediction')
    expect(html).toMatch(/ISA-INSPIRED TARGETS/i)
    expect(html).not.toMatch(/\bnanoseconds?\b/i)
    expect(html).not.toMatch(/\bwall[- ]clock\b/i)
  })

  it('starts idle with a run control and no result or error surface', () => {
    expect(html).toContain('RUN MODEL')
    expect(html).not.toContain('CANCEL RUN')
    // Unusable browser storage is not an error worth alarming about: with no
    // archives to read, the lane opens clean rather than showing a FAULT.
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('FAULT')
  })
})
