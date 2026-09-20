import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LaneToolbar } from './LaneToolbar.tsx'
import MultiLaneApp from './MultiLaneApp.tsx'

describe('rendered lane states', () => {
  it('always renders a labelled RUN MODEL control, enabled or explained', () => {
    const enabled = renderToStaticMarkup(<LaneToolbar title="Detailed OoO" kicker="MODEL" running={false} onRun={() => undefined} />)
    const blocked = renderToStaticMarkup(<LaneToolbar title="Detailed OoO" kicker="MODEL" running={false} disabled disabledReason="select at least one ISA" onRun={() => undefined} />)
    expect(enabled).toContain('RUN MODEL')
    expect(enabled).not.toContain('disabled')
    expect(blocked).toContain('RUN MODEL')
    expect(blocked).toContain('disabled')
    expect(blocked).toContain('select at least one ISA')
  })

  it('switches a running toolbar to a cancel control', () => {
    const running = renderToStaticMarkup(<LaneToolbar title="Detailed OoO" kicker="MODEL" running onRun={() => undefined} onCancel={() => undefined} />)
    expect(running).toContain('CANCEL RUN')
    expect(running).not.toContain('disabled')
  })

  it('renders one tab and one panel per timing model with complete tab semantics', () => {
    const shell = renderToStaticMarkup(<MultiLaneApp />)
    expect(shell.match(/role="tab"/g)).toHaveLength(2)
    expect(shell.match(/role="tabpanel"/g)).toHaveLength(2)
    expect(shell).toContain('role="tablist"')
    expect(shell).toContain('tabindex="0"')
    expect(shell).toContain('tabindex="-1"')
    expect(shell).toContain('RUN MODEL')
  })
})
