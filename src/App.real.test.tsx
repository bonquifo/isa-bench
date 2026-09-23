// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { ISA_META } from './engine/index.ts'
import { C_EXAMPLES } from './engine/c/programs.ts'

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

/**
 * The in-app compiler is swapped too: whether it is present is a switch
 * the tests set, and "compiling" hands back what the fixture builder built
 * from the same source -- which is what the real compiler must produce,
 * as src/compiler/toolchain.test.ts checks where it is built.
 */
const compiler = vi.hoisted(() => ({ present: true, compiled: [] as string[] }))
vi.mock('./compiler/load.ts', () => ({
  toolchainAvailable: async () => compiler.present,
  toolchainBase: () => '',
}))
vi.mock('./compiler/workerCompile.ts', async () => {
  const { fixtureRealProvider } = await import('./engine/realProvider.node.ts')
  return {
    workerCompile: async (isa: string) => {
      compiler.compiled.push(isa)
      const binary = await fixtureRealProvider(isa as never)!.binary('fib')
      return { ok: true, binary, warnings: '' }
    },
  }
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
    // The built-in kernels are IR, which no C compiler can build -- so
    // there is nothing real to run.
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

describe('a program the user wrote, on real instruction sets', () => {
  const fib = C_EXAMPLES.find((example) => example.id === 'fib')!

  it('compiles it for each target in the app and runs the result', async () => {
    compiler.present = true
    compiler.compiled.length = 0
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'NONE' }))
    await user.click(isaChip(ISA_META.riscv.short))
    await user.click(isaChip(ISA_META.arm.short))
    await user.selectOptions(screen.getByLabelText('Program'), 'custom-c')
    fireEvent.change(screen.getByLabelText('Custom Guest C source'), { target: { value: fib.source } })
    const real = await screen.findByRole('radio', { name: 'Real ISA' })
    await vi.waitFor(() => expect(real).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByText(/compiled in the app by clang 23/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await screen.findByText(/MODEL CONTRACT/, undefined, { timeout: 30_000 })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(compiler.compiled.sort()).toEqual(['arm', 'riscv'])
    expect(report().getByText('REAL INSTRUCTIONS · MODELLED TIMING')).toBeInTheDocument()
    expect(report().getAllByText('RV64GC').length).toBeGreaterThan(0)
  }, 60_000)

  it('says so, and runs the lowering, when this build has no compiler', async () => {
    compiler.present = false
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByLabelText('Program'), 'custom-c')
    expect(await screen.findByText(/has no compiler for your program/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Model lowering' })).toHaveAttribute('aria-checked', 'true')
    compiler.present = true
  })

  it('explains why a program with no real counterpart runs on the lowering', async () => {
    compiler.present = true
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByLabelText('Program'), 'custom-c')
    fireEvent.change(screen.getByLabelText('Custom Guest C source'), {
      target: { value: 'int main(void) { __barrier(); return __tid(); }' },
    })
    expect(await screen.findByText(/Guest C built-in for the modelled multicore/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Model lowering' })).toHaveAttribute('aria-checked', 'true')
  })
})
