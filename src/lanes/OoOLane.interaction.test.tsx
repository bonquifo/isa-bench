// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runOoOComparisonAsync, type OoOCompareInput } from '../engine/index.ts'
import { OoOLane } from './OoOLane.tsx'

/**
 * The lane offloads the model to a module Worker, which jsdom does not
 * provide. This stub keeps the real protocol — the same message shapes, the
 * same engine call — so the lane's result, progress, error and cancel paths
 * are exercised rather than stubbed out.
 */
type Mode = 'resolve' | 'reject' | 'hang'
let mode: Mode = 'resolve'
let terminated = 0

class StubWorker extends EventTarget {
  terminate() { terminated += 1 }
  postMessage(request: { type: string; input: OoOCompareInput }) {
    if (request.type !== 'run') return
    if (mode === 'hang') {
      // Never resolves, so the running state is stable enough to cancel.
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: { type: 'progress', progress: { phase: 'ISSUE', ratio: 0.5, detail: 'holding' } },
      })))
      return
    }
    if (mode === 'reject') {
      queueMicrotask(() => this.dispatchEvent(
        new MessageEvent('message', { data: { type: 'error', error: 'stub worker failed' } }),
      ))
      return
    }
    void runOoOComparisonAsync(
      request.input,
      (progress) => this.dispatchEvent(new MessageEvent('message', { data: { type: 'progress', progress } })),
      {},
    ).then(
      (result) => this.dispatchEvent(new MessageEvent('message', { data: { type: 'result', result } })),
      (error: unknown) => this.dispatchEvent(new MessageEvent('message', {
        data: { type: 'error', error: error instanceof Error ? error.message : String(error) },
      })),
    )
  }
}

beforeEach(() => {
  mode = 'resolve'
  terminated = 0
  vi.stubGlobal('Worker', StubWorker)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Leaves exactly one target selected, so a run stays quick. */
async function selectOnlyFirstTarget(user: ReturnType<typeof userEvent.setup>) {
  const boxes = screen.getAllByRole('checkbox')
  for (const box of boxes.slice(1)) await user.click(box)
  return boxes[0]!
}

describe('detailed OoO lane interaction', () => {
  it('refuses to run with no target selected and says why', async () => {
    const user = userEvent.setup()
    render(<OoOLane />)
    for (const box of screen.getAllByRole('checkbox')) await user.click(box)
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/select at least one target/i)
  })

  it('runs the model and replaces the empty state with a report', async () => {
    const user = userEvent.setup()
    render(<OoOLane />)
    await selectOnlyFirstTarget(user)
    expect(screen.getByText(/Run the browser OoO model/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    await screen.findByText('MODEL RESULT', undefined, { timeout: 30_000 })

    expect(screen.queryByText(/Run the browser OoO model/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('SIMULATED ANALYTICAL')).toBeInTheDocument()
    expect(screen.getByText(/analytical-model-cycles/)).toBeInTheDocument()
    expect(screen.getByText(/Model cycles/)).toBeInTheDocument()
  }, 60_000)

  it('reports worker progress in its live region while running', async () => {
    const user = userEvent.setup()
    render(<OoOLane />)
    await selectOnlyFirstTarget(user)
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live).toHaveTextContent('IDLE')
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    // Progress text is "PHASE · NN% · detail" and must appear before the result.
    await waitFor(() => expect(live.textContent).toMatch(/·\s*\d+%\s*·/), { timeout: 30_000 })
    await screen.findByText('MODEL RESULT', undefined, { timeout: 30_000 })
  }, 60_000)

  it('surfaces a worker failure as an alert and stops running', async () => {
    const user = userEvent.setup()
    mode = 'reject'
    render(<OoOLane />)
    await selectOnlyFirstTarget(user)
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('stub worker failed')
    expect(screen.getByRole('button', { name: 'RUN MODEL' })).toBeInTheDocument()
    expect(screen.queryByText('MODEL RESULT')).toBeNull()
  }, 30_000)

  it('terminates the worker when a run is cancelled', async () => {
    const user = userEvent.setup()
    mode = 'hang'
    render(<OoOLane />)
    await selectOnlyFirstTarget(user)
    await user.click(screen.getByRole('button', { name: 'RUN MODEL' }))
    const cancel = await screen.findByRole('button', { name: 'CANCEL RUN' })
    await user.click(cancel)
    await waitFor(() => expect(screen.getByRole('button', { name: 'RUN MODEL' })).toBeInTheDocument())
    expect(terminated).toBeGreaterThan(0)
    // Cancelling is not an error, so nothing is reported to the user.
    expect(screen.queryByRole('alert')).toBeNull()
  }, 30_000)

  it('retunes the model profile from the control panel', async () => {
    const user = userEvent.setup()
    render(<OoOLane />)
    const issueWidth = screen.getByLabelText('Issue width')
    await user.clear(issueWidth)
    await user.type(issueWidth, '2')
    expect(issueWidth).toHaveValue(2)
    const rob = screen.getByLabelText('ROB entries')
    await user.clear(rob)
    await user.type(rob, '64')
    expect(rob).toHaveValue(64)
  })
})
