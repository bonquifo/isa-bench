// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AARCH64_FIXTURE_DIR } from '../isa/aarch64/fixtures.node.ts'
import { RV64_FIXTURE_DIR } from '../isa/riscv/fixtures.node.ts'

/**
 * The lane reads its binaries through a URL, which a bundler turns into a
 * data URI and a development server into an http path. Neither exists under
 * vitest, so the reader is replaced with one that loads the same files from
 * disk. Everything else is real: the real ELF bytes, the real decoder, the
 * real interpreter and the real timing model all run in this test.
 */
vi.mock('../isa/riscv/shipped.ts', async () => {
  const actual = await vi.importActual<typeof import('../isa/riscv/shipped.ts')>(
    '../isa/riscv/shipped.ts',
  )
  return {
    ...actual,
    loadShippedElf: async (url: string) => {
      const name = url.slice(url.lastIndexOf('corpus-'))
      return new Uint8Array(readFileSync(join(RV64_FIXTURE_DIR, name)))
    },
  }
})

vi.mock('../isa/aarch64/shipped.ts', async () => {
  const actual = await vi.importActual<typeof import('../isa/aarch64/shipped.ts')>(
    '../isa/aarch64/shipped.ts',
  )
  return {
    ...actual,
    loadShippedElf: async (url: string) => {
      const name = url.slice(url.lastIndexOf('corpus-'))
      return new Uint8Array(readFileSync(join(AARCH64_FIXTURE_DIR, name)))
    },
  }
})

const { RealIsaLane } = await import('./RealIsaLane.tsx')

afterEach(cleanup)

describe('the real-ISA lane', () => {
  it('says plainly what is executed and what is modelled', () => {
    render(<RealIsaLane />)
    expect(screen.getByText(/executes real RISC-V instructions/i)).toBeInTheDocument()
    expect(screen.getByText(/Nothing here is measured on hardware/i)).toBeInTheDocument()
    expect(screen.getByText(/Not comparable to the other lanes/i)).toBeInTheDocument()
  })

  it('offers every shipped program and a microarchitecture to model', () => {
    render(<RealIsaLane />)
    const programs = screen.getByLabelText('Program') as HTMLSelectElement
    expect(programs.options.length).toBeGreaterThanOrEqual(14)
    expect(screen.getByLabelText('Modelled microarchitecture')).toBeInTheDocument()
    expect(screen.queryByText(/No binary yet for/)).not.toBeInTheDocument()
  })

  it('executes a program and reports the answer the app expects', async () => {
    const user = userEvent.setup()
    render(<RealIsaLane />)
    await user.selectOptions(screen.getByLabelText('Program'), 'fib')
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))

    await waitFor(() => {
      expect(screen.getByText(/Matches the answer the app records/i)).toBeInTheDocument()
    }, { timeout: 20_000 })
    // fib(10) through a real RV64 binary, printed by a real musl printf.
    expect(screen.getByText('fib(10) = 55')).toBeInTheDocument()
  }, 30_000)

  it('checks a hashed expectation as well as an exact one', async () => {
    // Most corpus programs record their output exactly; the graphical ones
    // record a hash and a length because the output is hundreds of bytes.
    const user = userEvent.setup()
    render(<RealIsaLane />)
    await user.selectOptions(screen.getByLabelText('Program'), 'mandelbrot')
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await waitFor(() => {
      expect(screen.getByText(/Matches the answer the app records/i)).toBeInTheDocument()
    }, { timeout: 20_000 })
  }, 30_000)

  it('separates what it counted from what it modelled', async () => {
    const user = userEvent.setup()
    render(<RealIsaLane />)
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await waitFor(
      () => expect(screen.getByText('Executed · RV64GC')).toBeInTheDocument(),
      { timeout: 20_000 },
    )

    expect(screen.getByText('Counted, not modelled.')).toBeInTheDocument()
    expect(screen.getByText(/Deterministic software model/i)).toBeInTheDocument()
    expect(screen.getByText('Instructions')).toBeInTheDocument()
    expect(screen.getByText('Model cycles')).toBeInTheDocument()
    // The disassembly is read from the real encoding, so it must be present.
    expect(screen.getByText('Decoded instructions')).toBeInTheDocument()
  }, 30_000)

  it('runs the same program on a second real instruction set', async () => {
    // The two backends share nothing but the contract: different decoders,
    // different interpreters, different binaries built by different
    // compilations. Agreeing on the answer is the point of running both.
    const user = userEvent.setup()
    render(<RealIsaLane />)
    await user.selectOptions(screen.getByLabelText('Instruction set'), 'arm')
    expect(screen.getByText(/executes real AArch64 instructions/i)).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Program'), 'fib')
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await waitFor(() => {
      expect(screen.getByText(/Matches the answer the app records/i)).toBeInTheDocument()
    }, { timeout: 20_000 })
    expect(screen.getByText('fib(10) = 55')).toBeInTheDocument()
    expect(screen.getByText('Executed · AArch64')).toBeInTheDocument()
  }, 30_000)

  it('does not carry a result across a change of instruction set', async () => {
    const user = userEvent.setup()
    render(<RealIsaLane />)
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await waitFor(
      () => expect(screen.getByText('Executed · RV64GC')).toBeInTheDocument(),
      { timeout: 20_000 },
    )
    await user.selectOptions(screen.getByLabelText('Instruction set'), 'arm')
    expect(screen.queryByText('Executed · RV64GC')).not.toBeInTheDocument()
    expect(screen.queryByText('Executed · AArch64')).not.toBeInTheDocument()
  }, 30_000)

  it('reports a failure to load rather than showing nothing', async () => {
    const shipped = await import('../isa/riscv/shipped.ts')
    const spy = vi.spyOn(shipped, 'loadShippedElf')
      .mockRejectedValueOnce(new Error('could not read the binary'))
    const user = userEvent.setup()
    render(<RealIsaLane />)
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not read the binary'))
    spy.mockRestore()
  }, 30_000)
})
