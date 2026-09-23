// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompareResult } from '../engine/compare.ts'
import { runRealComparisonAsync } from '../engine/compareReal.ts'
import { DEFAULT_PROFILE_ID } from '../engine/hardware.ts'
import { fixtureRealProvider } from '../engine/realProvider.node.ts'
import { IsaId } from '../engine/types.ts'
import { Report } from './Report.tsx'

/**
 * The report over a real run: what it counts, what it models, and what it
 * refuses to rank. Driven by a real comparison rather than a fixture, so
 * the counted figures are the interpreters' own.
 */
const real = await runRealComparisonAsync({
  workloadId: 'c-fib',
  n: 0,
  seed: 1,
  isas: [IsaId.RISCV, IsaId.SPARC, IsaId.MOS],
  hardwareMode: 'same',
  profileId: DEFAULT_PROFILE_ID,
  execution: 'real-isa',
}, fixtureRealProvider, () => {})

/** The same run, with the 6502 as if its int had been too narrow. */
function withNarrow(result: CompareResult, narrow: IsaId[]): CompareResult {
  return {
    ...result,
    rows: result.rows.map((row) => narrow.includes(row.isa) ? { ...row, matchedGold: false, result: 7 } : row),
    execution: {
      ...result.execution!,
      targets: result.execution!.targets.map((target) =>
        narrow.includes(target.isa) ? { ...target, verdict: 'unreachable' as const } : target),
    },
  }
}

afterEach(cleanup)

describe('the report over a real run', () => {
  it('separates what it counted from what it modelled', () => {
    render(<Report result={real} />)
    expect(screen.getByText('Counted from execution')).toBeInTheDocument()
    expect(screen.getByText('Modelled')).toBeInTheDocument()
    expect(screen.getByText(/INSTRUCTIONS RETIRED/)).toBeInTheDocument()
    expect(screen.getByText(/DATA-MEMORY INSTRUCTIONS/)).toBeInTheDocument()
    // SPARC took window traps on fib, so the figure appears.
    expect(screen.getByText(/PLATFORM TRAPS/)).toBeInTheDocument()
    expect(screen.getByText(/MODEL CYCLES PER INSTRUCTION · NOT RANKED/)).toBeInTheDocument()
    // Nothing the report does not stand behind.
    expect(screen.queryByText(/MODEL ENERGY/)).not.toBeInTheDocument()
    expect(screen.queryByText(/L2 MISS|L3 MISS/)).not.toBeInTheDocument()
    expect(screen.queryByText(/SPILL SLOTS|MODELED STREAM BYTES/)).not.toBeInTheDocument()
  })

  it('explains in its protocol what is counted, what is modelled, and what is left out', async () => {
    const user = userEvent.setup()
    render(<Report result={real} />)
    await user.click(screen.getByRole('button', { name: 'PROTOCOL' }))
    expect(screen.getByRole('heading', { name: 'Counted' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Modelled' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Not reported' })).toBeInTheDocument()
    expect(screen.getByText(/No target gets a timing adjustment of its own/)).toBeInTheDocument()
    expect(screen.getByText(/register-window\s+spill or fill moves 64 bytes/)).toBeInTheDocument()
    expect(screen.getByText(/uncalibrated/)).toBeInTheDocument()
  })

  it('shows a target that computed a different answer, and ranks it nowhere', () => {
    render(<Report result={withNarrow(real, [IsaId.MOS])} />)
    expect(screen.getAllByText(/NOT RANKED · Its C int is too narrow/).length).toBe(1)
    const baseline = screen.getByRole('combobox')
    expect(within(baseline).queryByRole('option', { name: /6502/ })).not.toBeInTheDocument()
    expect(screen.getByText(/computed a different answer/)).toBeInTheDocument()
  })

  it('says so when nothing is left to rank', () => {
    render(<Report result={withNarrow(real, [IsaId.RISCV, IsaId.SPARC, IsaId.MOS])} />)
    expect(screen.getByText('Nothing to rank')).toBeInTheDocument()
    expect(screen.getAllByText(/Its C int is too narrow/).length).toBe(3)
  })
})
