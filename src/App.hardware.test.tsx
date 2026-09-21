// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App.tsx'
import { HARDWARE_PROFILES, ISA_META } from './engine/index.ts'
import { SAVE_KEY_V2 } from './ui/saves.ts'

/**
 * Hardware selection and the saved-run archive, which are the two parts of the
 * lane that change what a run means rather than just how it is displayed.
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

const chip = (short: string) =>
  screen.getByRole('button', { name: new RegExp(short.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i') })

describe('hardware selection', () => {
  it('starts on the shared model profile, which is the controlled comparison', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: /Shared model profile/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Named illustrative presets/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Shared model profile')).toBeInTheDocument()
  })

  it('switches to illustrative presets and back', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Named illustrative presets/ }))
    expect(screen.getByRole('button', { name: /Named illustrative presets/ })).toHaveAttribute('aria-pressed', 'true')
    // The shared-profile select belongs to the controlled mode only.
    expect(screen.queryByLabelText('Shared model profile')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Shared model profile/ }))
    expect(screen.getByLabelText('Shared model profile')).toBeInTheDocument()
  })

  it('applies a different shared profile', async () => {
    const user = userEvent.setup()
    render(<App />)
    const select = screen.getByLabelText('Shared model profile')
    const quad = HARDWARE_PROFILES.find((profile) => profile.id === 'equal-quad')!
    await user.selectOptions(select, quad.id)
    expect(select).toHaveValue(quad.id)
    // The blurb under the select is unique to the chosen profile.
    expect(screen.getByText(quad.blurb)).toBeInTheDocument()
  })

  it('reveals tuning sliders only while the custom overlay is on', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(screen.queryByText('Clock')).toBeNull()
    const overlay = screen.getByLabelText(/Custom overlay \/ tuning/)
    await user.click(overlay)
    expect(overlay).toBeChecked()
    for (const label of ['Clock', 'Issue width', 'DRAM miss', 'L1I', 'L1D', 'Mispredict']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    await user.click(overlay)
    expect(overlay).not.toBeChecked()
    expect(screen.queryByText('Clock')).toBeNull()
  })
})

describe('saved run archive', () => {
  async function runAndSave(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByRole('button', { name: 'NONE' }))
    await user.click(chip(ISA_META.riscv.short))
    const size = screen.getByLabelText(/N \(elements\)/i)
    await user.clear(size)
    await user.type(size, '8')
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await screen.findByText(/MODEL CONTRACT/, undefined, { timeout: 30_000 })
    const field = screen.getByLabelText('Saved run name')
    await user.clear(field)
    await user.type(field, name)
    await user.click(screen.getByRole('button', { name: 'SAVE RUN' }))
  }

  const panel = () => screen.getByRole('heading', { name: 'Saved runs' }).closest('section') as HTMLElement

  it('restores a saved run and drops it again', async () => {
    const user = userEvent.setup()
    render(<App />)
    await runAndSave(user, 'archive one')

    const saved = within(panel())
    expect(saved.getByText('archive one')).toBeInTheDocument()
    expect(saved.getByText(/restorable v2/)).toBeInTheDocument()

    await user.click(saved.getByRole('button', { name: 'RESTORE' }))
    // Restoring reinstates the archived run's own target selection.
    expect(chip(ISA_META.riscv.short)).toHaveAttribute('aria-pressed', 'true')
    expect(chip(ISA_META.mos.short)).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('alert')).toBeNull()

    await user.click(within(panel()).getByRole('button', { name: 'DROP' }))
    expect(within(panel()).queryByText('archive one')).toBeNull()
    expect(within(panel()).getByText(/After a reference match/)).toBeInTheDocument()
    expect(localStorage.getItem(SAVE_KEY_V2) ?? '').not.toContain('archive one')
  }, 90_000)
})
