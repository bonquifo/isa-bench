// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App.tsx'
import { ALL_ISAS, ISA_META, cpusForIsa } from './engine/index.ts'

/**
 * The illustrative-preset mode, the tuning sliders, and the two failure
 * branches around the archive. Between them these are the last parts of the
 * lane a user can reach that the other suites do not touch.
 */
interface StorageOptions { failWrites?: boolean }

function memoryStorage({ failWrites = false }: StorageOptions = {}): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => {
      if (failWrites) throw new DOMException('quota exceeded', 'QuotaExceededError')
      map.set(key, String(value))
    },
  }
}

function useStorage(options?: StorageOptions) {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(options), configurable: true })
}

beforeEach(() => useStorage())
afterEach(cleanup)

const chip = (short: string) =>
  screen.getByRole('button', { name: new RegExp(short.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i') })

describe('illustrative presets mode', () => {
  it('offers a preset picker per ISA, disabled for deselected targets', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(chip(ISA_META.mos.short))
    await user.click(screen.getByRole('button', { name: /Named illustrative presets/ }))

    for (const isa of ALL_ISAS) {
      expect(screen.getByLabelText(`${ISA_META[isa].short} illustrative preset`)).toBeInTheDocument()
    }
    // A deselected target keeps its picker, disabled, rather than vanishing.
    expect(screen.getByLabelText(`${ISA_META.mos.short} illustrative preset`)).toBeDisabled()
    expect(screen.getByLabelText(`${ISA_META.riscv.short} illustrative preset`)).toBeEnabled()
  })

  it('changes the preset chosen for one target without touching the others', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Named illustrative presets/ }))

    const riscv = screen.getByLabelText(`${ISA_META.riscv.short} illustrative preset`)
    const arm = screen.getByLabelText(`${ISA_META.arm.short} illustrative preset`)
    const armBefore = (arm as HTMLSelectElement).value
    const options = cpusForIsa('riscv')
    const next = options.find((cpu) => cpu.id !== (riscv as HTMLSelectElement).value)!

    await user.selectOptions(riscv, next.id)
    expect(riscv).toHaveValue(next.id)
    expect(arm).toHaveValue(armBefore)
  })

  it('warns that presets are parameter bundles rather than emulation', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Named illustrative presets/ }))
    expect(screen.getByText(/not CPU emulation or measurements/)).toBeInTheDocument()
  })
})

describe('custom tuning sliders', () => {
  it('moves a slider and shows the new value', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByLabelText(/Custom overlay \/ tuning/))

    const clock = screen.getByLabelText('Clock') as HTMLInputElement
    expect(clock.type).toBe('range')
    fireEvent.change(clock, { target: { value: '3200' } })
    expect(clock).toHaveValue('3200')
    expect(screen.getByText('3200 MHz')).toBeInTheDocument()

    const issue = screen.getByLabelText('Issue width') as HTMLInputElement
    fireEvent.change(issue, { target: { value: '3' } })
    expect(issue).toHaveValue('3')
  })
})

describe('archive failure paths', () => {
  async function runOnce(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'NONE' }))
    await user.click(chip(ISA_META.riscv.short))
    const size = screen.getByLabelText(/N \(elements\)/i)
    await user.clear(size)
    await user.type(size, '8')
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await screen.findByText(/MODEL CONTRACT/, undefined, { timeout: 30_000 })
  }

  it('reports a save that browser storage refuses, without losing the result', async () => {
    const user = userEvent.setup()
    useStorage({ failWrites: true })
    render(<App />)
    await runOnce(user)
    await user.click(screen.getByRole('button', { name: 'SAVE RUN' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/SAVE FAILED/)
    expect(alert).toHaveTextContent(/quota exceeded/)
    // The run itself is still on screen; only archiving failed.
    expect(screen.getByText(/MODEL CONTRACT/)).toBeInTheDocument()
  }, 90_000)

  it('reports a delete that browser storage refuses', async () => {
    const user = userEvent.setup()
    render(<App />)
    await runOnce(user)
    await user.click(screen.getByRole('button', { name: 'SAVE RUN' }))

    const panel = () => screen.getByRole('heading', { name: 'Saved runs' }).closest('section') as HTMLElement
    await within(panel()).findByRole('button', { name: 'DROP' })

    // Storage starts refusing writes only now, so the entry exists but cannot
    // be removed.
    const stored = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      value: { ...stored, getItem: stored.getItem.bind(stored), setItem: () => { throw new Error('read-only volume') } },
      configurable: true,
    })

    await user.click(within(panel()).getByRole('button', { name: 'DROP' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/DELETE FAILED/)
    expect(alert).toHaveTextContent(/read-only volume/)
  }, 90_000)
})
