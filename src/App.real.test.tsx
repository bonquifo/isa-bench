// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { ISA_META } from './engine/index.ts'

/**
 * The comparison on real instruction sets, driven through the app itself.
 *
 * One thing is substituted: where the binaries come from. The app fetches
 * the shipped copies through the bundler, which jsdom cannot do, so the
 * provider is swapped for the one that reads the fixture files those
 * copies were made from. Everything else -- the choice, the run, the
 * report -- is the path a user takes.
 */
vi.mock('./lanes/realProvider.ts', async () => {
  const { fixtureRealProvider } = await import('./engine/realProvider.node.ts')
  return { shippedRealProvider: fixtureRealProvider }
})

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
  return screen.getByRole('button', {
    name: new RegExp(short.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i'),
  })
}

async function pickTwoTargetsAndFib(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'NONE' }))
  await user.click(isaChip(ISA_META.riscv.short))
  await user.click(isaChip(ISA_META.wasm.short))
  await user.selectOptions(screen.getByLabelText('Program'), 'c-fib')
}

function report() {
  return within(document.querySelector('main > section.min-w-0') as HTMLElement)
}

describe('choosing how the instructions are produced', () => {
  it('offers the choice for a canned C program, and defaults to real', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByLabelText('Program'), 'c-fib')
    expect(screen.getByRole('radio', { name: 'Real ISA' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Model lowering' }))
      .toHaveAttribute('aria-checked', 'false')
  })

  it('does not offer it for a workload that has no compiled binary', async () => {
    // The built-in kernels are IR, and nothing can compile IR or edited C
    // at runtime -- so there is nothing real to run.
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByLabelText('Program'), 'dot_product')
    expect(screen.queryByRole('radio', { name: 'Real ISA' })).toBeNull()
  })
})

describe('a real run, from the app', () => {
  it('runs each target on its real binary and says so', async () => {
    const user = userEvent.setup()
    render(<App />)
    await pickTwoTargetsAndFib(user)
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))

    await screen.findByText(/MODEL CONTRACT/, undefined, { timeout: 30_000 })
    expect(screen.queryByRole('alert')).toBeNull()
    // The timing is still the model, and the badge still says so.
    expect(screen.getByText('SIMULATED ANALYTICAL')).toBeInTheDocument()
    expect(report().getByText('REAL INSTRUCTIONS · MODELLED TIMING')).toBeInTheDocument()
    // Real names, not the lowering's.
    expect(report().getAllByText('RV64GC').length).toBeGreaterThan(0)
    expect(report().getAllByText('WebAssembly').length).toBeGreaterThan(0)
    expect(report().queryByText(ISA_META.riscv.short)).toBeNull()
  }, 60_000)

  it('runs the lowering instead when asked, and says that', async () => {
    // The counterfactual: the same program and targets on the other path
    // must read as the lowering, or the test above proves nothing.
    const user = userEvent.setup()
    render(<App />)
    await pickTwoTargetsAndFib(user)
    await user.click(screen.getByRole('radio', { name: 'Model lowering' }))
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))

    await screen.findByText(/MODEL CONTRACT/, undefined, { timeout: 30_000 })
    expect(report().queryByText('REAL INSTRUCTIONS · MODELLED TIMING')).toBeNull()
    expect(report().getAllByText(ISA_META.riscv.short).length).toBeGreaterThan(0)
    expect(report().queryByText('RV64GC')).toBeNull()
  }, 60_000)
})
