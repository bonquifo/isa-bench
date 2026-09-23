// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE_ID, ISA_META, runComparison } from '../engine/index.ts'
import { Report } from './Report.tsx'

/**
 * The report is where a run is actually read, so its panes and baseline
 * control are driven here against a real comparison rather than a fixture.
 */
const result = runComparison({
  workloadId: 'dot_product',
  n: 8,
  seed: 1,
  isas: ['riscv', 'arm', 'x86'],
  hardwareMode: 'same',
  profileId: DEFAULT_PROFILE_ID,
})

afterEach(cleanup)

const pane = (name: string) => screen.getByRole('button', { name })
const PANES = ['METRICS', 'INSTRUCTION MIX', 'TRACE', 'PROTOCOL'] as const

describe('report panes', () => {
  it('opens on the metrics', () => {
    render(<Report result={result} />)
    expect(pane('METRICS')).toHaveAttribute('aria-pressed', 'true')
    for (const other of PANES.filter((item) => item !== 'METRICS')) {
      expect(pane(other)).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('switches to every other pane and shows exactly one at a time', async () => {
    const user = userEvent.setup()
    render(<Report result={result} />)
    for (const name of [...PANES.slice(1), 'METRICS'] as const) {
      await user.click(pane(name))
      const selected = PANES.filter((item) => pane(item).getAttribute('aria-pressed') === 'true')
      expect(selected).toEqual([name])
    }
  })

  it('renormalizes the matrix when the baseline target changes', async () => {
    const user = userEvent.setup()
    render(<Report result={result} />)
    const baseline = screen.getByRole('combobox')
    expect(baseline).toHaveValue('leader')
    await user.selectOptions(baseline, 'x86')
    expect(baseline).toHaveValue('x86')
    // The label tracks the chosen baseline rather than staying on the leader.
    expect(screen.getByText(new RegExp(`vs ${ISA_META.x86.short}`))).toBeInTheDocument()
  })

  it('shows the lowering stream of whichever target is chosen', async () => {
    const user = userEvent.setup()
    render(<Report result={result} />)
    await user.click(pane('TRACE'))
    // The trace pane names targets in full, unlike the ranked matrix.
    const riscv = screen.getByRole('button', { name: ISA_META.riscv.full })
    const arm = screen.getByRole('button', { name: ISA_META.arm.full })
    expect(riscv).toHaveAttribute('aria-pressed', 'true')

    const stream = () => document.querySelector('pre.crt')?.textContent ?? ''
    const riscvStream = stream()
    expect(riscvStream.length).toBeGreaterThan(0)
    expect(riscvStream).toBe(result.rows.find((row) => row.isa === 'riscv')!.disasm.join('\n'))

    await user.click(arm)
    expect(arm).toHaveAttribute('aria-pressed', 'true')
    expect(riscv).toHaveAttribute('aria-pressed', 'false')
    expect(stream()).toBe(result.rows.find((row) => row.isa === 'arm')!.disasm.join('\n'))
    expect(stream()).not.toBe(riscvStream)
    // The pane must keep saying this is a model, not real disassembly.
    expect(screen.getByText(/not executable disassembly or a generated binary/)).toBeInTheDocument()
  })
})

describe('report save control', () => {
  it('is absent when the report has no save handler', () => {
    render(<Report result={result} />)
    expect(screen.queryByRole('button', { name: 'SAVE RUN' })).toBeNull()
  })

  it('hands the edited name to the save handler', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<Report result={result} onSave={onSave} />)
    const field = screen.getByLabelText('Saved run name')
    expect(field).toHaveValue(result.workloadName)
    await user.clear(field)
    await user.type(field, 'renamed archive')
    await user.click(screen.getByRole('button', { name: 'SAVE RUN' }))
    expect(onSave).toHaveBeenCalledExactlyOnceWith('renamed archive')
  })
})
