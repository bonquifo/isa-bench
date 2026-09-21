// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import MultiLaneApp from './MultiLaneApp.tsx'
import { LANES } from './types.ts'

/**
 * Lane navigation is a tablist, so it has to work by pointer, by keyboard, and
 * by URL. Only the selected lane is mounted, which is why the OoO lane never
 * renders until its tab is chosen.
 */

beforeEach(() => {
  globalThis.history.replaceState(null, '', '/')
})
afterEach(cleanup)

const tab = (name: RegExp | string) => screen.getByRole('tab', { name })

describe('lane navigation', () => {
  it('opens on the in-order lane with exactly one selected tab', () => {
    render(<MultiLaneApp />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(LANES.length)
    expect(tabs.filter((item) => item.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(tab(/IN-ORDER/)).toHaveAttribute('aria-selected', 'true')
  })

  it('switches lanes on click and records the lane in the URL', async () => {
    const user = userEvent.setup()
    render(<MultiLaneApp />)
    await user.click(tab(/DETAILED OOO/))
    expect(tab(/DETAILED OOO/)).toHaveAttribute('aria-selected', 'true')
    expect(tab(/IN-ORDER/)).toHaveAttribute('aria-selected', 'false')
    expect(globalThis.location.hash).toBe('#/ooo')
    // Only the selected lane is mounted, so its controls appear now.
    expect(screen.getByText(/Deterministic decoded-op out-of-order model/)).toBeInTheDocument()
  })

  it('moves between tabs with arrow keys and wraps at both ends', async () => {
    const user = userEvent.setup()
    render(<MultiLaneApp />)
    const first = tab(/IN-ORDER/)
    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(tab(/DETAILED OOO/)).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowRight}')
    expect(tab(/REAL ISA/)).toHaveAttribute('aria-selected', 'true')
    // Wraps past the last tab back to the first.
    await user.keyboard('{ArrowRight}')
    expect(tab(/IN-ORDER/)).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowLeft}')
    expect(tab(/REAL ISA/)).toHaveAttribute('aria-selected', 'true')
  })

  it('jumps to the first and last lane with Home and End', async () => {
    const user = userEvent.setup()
    render(<MultiLaneApp />)
    tab(/IN-ORDER/).focus()
    await user.keyboard('{End}')
    expect(tab(/REAL ISA/)).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(tab(/IN-ORDER/)).toHaveAttribute('aria-selected', 'true')
  })

  it('ignores keys that are not navigation keys', async () => {
    const user = userEvent.setup()
    render(<MultiLaneApp />)
    tab(/IN-ORDER/).focus()
    await user.keyboard('{PageDown}')
    expect(tab(/IN-ORDER/)).toHaveAttribute('aria-selected', 'true')
  })

  it('follows browser navigation back to a previously visited lane', async () => {
    const user = userEvent.setup()
    render(<MultiLaneApp />)
    await user.click(tab(/DETAILED OOO/))
    expect(tab(/DETAILED OOO/)).toHaveAttribute('aria-selected', 'true')
    // Back/forward changes the hash without a click, so the lane follows it.
    act(() => {
      window.history.replaceState(null, '', '#/inorder')
      fireEvent(window, new Event('hashchange'))
    })
    expect(tab(/IN-ORDER/)).toHaveAttribute('aria-selected', 'true')
  })

  it('falls back to the in-order lane for an unknown hash', () => {
    globalThis.history.replaceState(null, '', '#/does-not-exist')
    render(<MultiLaneApp />)
    expect(tab(/IN-ORDER/)).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps a roving tabindex so the tablist is one tab stop', async () => {
    const user = userEvent.setup()
    render(<MultiLaneApp />)
    expect(tab(/IN-ORDER/)).toHaveAttribute('tabindex', '0')
    expect(tab(/DETAILED OOO/)).toHaveAttribute('tabindex', '-1')
    await user.click(tab(/DETAILED OOO/))
    expect(tab(/DETAILED OOO/)).toHaveAttribute('tabindex', '0')
    expect(tab(/IN-ORDER/)).toHaveAttribute('tabindex', '-1')
  })
})
