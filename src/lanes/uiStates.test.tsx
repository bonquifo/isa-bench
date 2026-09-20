import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EnvelopeBadges } from '../ui/Evidence.tsx'
import { CalibratedEmptyState } from './CalibratedLane.tsx'
import { LaneToolbar } from './LaneToolbar.tsx'
import { EmpiricalLane, HonestEmpty } from './EmpiricalLane.tsx'
import { EmpiricalAdminActions } from './EmpiricalAdminActions.tsx'
import MultiLaneApp from './MultiLaneApp.tsx'
import type { BackendClient } from '../ui/backendClient.ts'

describe('multi-lane rendered states', () => {
  it('renders a visible RUN MODEL control for every non-in-order lane toolbar', () => {
    const enabled = renderToStaticMarkup(<LaneToolbar title="Detailed OoO" kicker="MODEL" running={false} onRun={() => undefined} />)
    const blocked = renderToStaticMarkup(<LaneToolbar title="Empirical Calibration Lab" kicker="EMPIRICAL ADMIN" running={false} disabled disabledReason="empty lab" onRun={() => undefined} />)
    expect(enabled).toContain('RUN MODEL')
    expect(enabled).not.toContain('disabled')
    expect(blocked).toContain('RUN MODEL')
    expect(blocked).toContain('disabled')
    expect(blocked).toContain('empty lab')
  })

  it('renders honest empirical and calibrated empty states without evidence badges', () => {
    const html = renderToStaticMarkup(<><HonestEmpty tab="Runners" /><CalibratedEmptyState /></>)
    expect(html).toContain('No production runners data')
    expect(html).toContain('No approved applicable calibration')
    expect(html).not.toContain('PHYSICALLY MEASURED')
    expect(html).not.toContain('CALIBRATED PREDICTION')
  })

  it('does not render evidence badges for an unvalidated shape', () => {
    expect(renderToStaticMarkup(<EnvelopeBadges envelope={{ experimentKind: 'gem5' }} primary="EXTERNAL SIMULATOR" />)).toBe('')
  })

  it('renders complete top-level and nested tab semantics', () => {
    const shell = renderToStaticMarkup(<MultiLaneApp />)
    expect(shell.match(/role="tab"/g)).toHaveLength(6)
    expect(shell.match(/role="tabpanel"/g)).toHaveLength(6)
    expect(shell).toContain('role="tablist"')
    expect(shell).toContain('tabindex="0"')
    expect(shell).toContain('tabindex="-1"')
    expect(shell).toContain('RUN MODEL')
    expect(shell).toContain('Use RUN MODEL in the top cyan/magenta bar.')

    const client = {} as BackendClient
    const empirical = renderToStaticMarkup(<EmpiricalLane client={client} backend={{
      status: 'online',
      reason: 'online',
      capabilities: {} as never,
    }} />)
    expect(empirical.match(/role="tab"/g)).toHaveLength(7)
    expect(empirical.match(/role="tabpanel"/g)).toHaveLength(7)
    expect(empirical).toContain('aria-controls="empirical-panel-0"')
    expect(empirical).toContain('aria-labelledby="empirical-tab-0"')
    expect(empirical).toContain('RUN MODEL')
    expect(empirical).toContain('This admin lab has no model to execute')
  })

  it('labels every administrative JSON editor', () => {
    const tabs = ['Jobs & leases', 'Raw runs', 'Datasets & splits', 'Calibration lifecycle'] as const
    for (const tab of tabs) {
      const html = renderToStaticMarkup(<EmpiricalAdminActions client={{} as BackendClient} tab={tab} data={{}} onChanged={() => undefined} />)
      const textareas = html.match(/<textarea\b[^>]*>/g) ?? []
      expect(textareas.length).toBeGreaterThan(0)
      expect(textareas.every((element) => /aria-label=/.test(element))).toBe(true)
    }
  })
})
