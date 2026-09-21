// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App.tsx'
import { ALL_ISAS, ISA_META, WORKLOADS } from './engine/index.ts'
import { SAVE_KEY_V2 } from './ui/saves.ts'

/**
 * Interaction coverage for the in-order lane. These drive the real component
 * against the real engine, so a run here proves the whole path a user takes:
 * pick targets, pick a workload, run the model, read a report, save it.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
})
afterEach(cleanup)

function isaChip(short: string) {
  return screen.getByRole('button', { name: new RegExp(short.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i') })
}

describe('target selection', () => {
  it('starts with every target selected', () => {
    render(<App />)
    for (const isa of ALL_ISAS) {
      expect(isaChip(ISA_META[isa].short)).toHaveAttribute('aria-pressed', 'true')
    }
  })

  it('toggles a single target off and back on', async () => {
    const user = userEvent.setup()
    render(<App />)
    const chip = isaChip(ISA_META.x86.short)
    await user.click(chip)
    expect(isaChip(ISA_META.x86.short)).toHaveAttribute('aria-pressed', 'false')
    await user.click(isaChip(ISA_META.x86.short))
    expect(isaChip(ISA_META.x86.short)).toHaveAttribute('aria-pressed', 'true')
  })

  it('clears and restores the whole selection with NONE and ALL', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'NONE' }))
    for (const isa of ALL_ISAS) {
      expect(isaChip(ISA_META[isa].short)).toHaveAttribute('aria-pressed', 'false')
    }
    await user.click(screen.getByRole('button', { name: 'ALL' }))
    for (const isa of ALL_ISAS) {
      expect(isaChip(ISA_META[isa].short)).toHaveAttribute('aria-pressed', 'true')
    }
  })

  it('refuses to run with no target selected and says why', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'NONE' }))
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/select at least one isa/i)
  })
})

describe('workload selection', () => {
  it('applies each workload\'s own default size when picked', async () => {
    const user = userEvent.setup()
    render(<App />)
    const select = screen.getByLabelText('Program')
    const matmul = WORKLOADS.find((item) => item.id === 'matmul')!
    await user.selectOptions(select, 'matmul')
    expect(screen.getByLabelText(matmul.nLabel)).toHaveValue(matmul.defaultN)
    const sieve = WORKLOADS.find((item) => item.id === 'sieve')!
    await user.selectOptions(select, 'sieve')
    expect(screen.getByLabelText(sieve.nLabel)).toHaveValue(sieve.defaultN)
  })

  it('reveals a C editor for the custom C workload and an IR editor for custom IR', async () => {
    const user = userEvent.setup()
    render(<App />)
    const select = screen.getByLabelText('Program')
    expect(screen.queryByLabelText('Custom Guest C source')).toBeNull()
    await user.selectOptions(select, 'custom-c')
    expect(screen.getByLabelText('Custom Guest C source')).toBeInstanceOf(HTMLTextAreaElement)
    await user.selectOptions(select, 'custom')
    expect(screen.getByLabelText('Custom IR source')).toBeInstanceOf(HTMLTextAreaElement)
    expect(screen.queryByLabelText('Custom Guest C source')).toBeNull()
  })
})

describe('running the model', () => {
  it('runs the real engine and reports cycles for each selected target', async () => {
    const user = userEvent.setup()
    render(<App />)
    // Keep the run small: two targets, smallest allowed N.
    await user.click(screen.getByRole('button', { name: 'NONE' }))
    await user.click(isaChip(ISA_META.riscv.short))
    await user.click(isaChip(ISA_META.arm.short))
    const size = screen.getByLabelText(/N \(elements\)/i)
    await user.clear(size)
    await user.type(size, '8')

    expect(screen.getByText(/AWAITING RUN/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))

    // The contract line interpolates versions, so the text spans several nodes.
    const contract = await screen.findByText(/MODEL CONTRACT/, undefined, { timeout: 30_000 })
    expect(contract).toBeInTheDocument()
    expect(screen.queryByText(/AWAITING RUN/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('SIMULATED ANALYTICAL')).toBeInTheDocument()
    // Scoped to the report: the target picker on the left always lists all
    // eight, so only the report can show which ones actually ran.
    const report = within(document.querySelector('main > section.min-w-0') as HTMLElement)
    expect(report.getAllByText(ISA_META.riscv.short).length).toBeGreaterThan(0)
    expect(report.getAllByText(ISA_META.arm.short).length).toBeGreaterThan(0)
    expect(report.queryByText(ISA_META.mos.short)).toBeNull()
  }, 60_000)

  it('saves a completed run into browser storage and lists it', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'NONE' }))
    await user.click(isaChip(ISA_META.riscv.short))
    const size = screen.getByLabelText(/N \(elements\)/i)
    await user.clear(size)
    await user.type(size, '8')
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await screen.findByText(/MODEL CONTRACT/, undefined, { timeout: 30_000 })

    const nameField = screen.getByLabelText('Saved run name')
    await user.clear(nameField)
    await user.type(nameField, 'audit run')
    await user.click(screen.getByRole('button', { name: 'SAVE RUN' }))

    const panel = screen.getByRole('heading', { name: 'Saved runs' }).closest('section')!
    expect(within(panel).getByText('audit run')).toBeInTheDocument()
    expect(within(panel).queryByText(/After a reference match/)).toBeNull()
    // Archives really are in browser storage, not just component state.
    expect(localStorage.getItem(SAVE_KEY_V2)).toContain('audit run')
  }, 60_000)
})
