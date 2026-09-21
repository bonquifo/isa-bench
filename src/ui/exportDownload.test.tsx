// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE_ID, runComparison } from '../engine/index.ts'
import { download } from './format.ts'
import { Report } from './Report.tsx'

/**
 * Exporting is the one path that leaves the app, so it is checked end to end:
 * the report's buttons, the blob they hand to the browser, and the filename
 * the reader ends up with.
 */
const result = runComparison({
  workloadId: 'dot_product',
  n: 8,
  seed: 1,
  isas: ['riscv', 'arm'],
  hardwareMode: 'same',
  profileId: DEFAULT_PROFILE_ID,
})

interface Captured { filename: string; type: string; text: string }

let captured: Captured[] = []
let revoked: string[] = []

beforeEach(() => {
  captured = []
  revoked = []
  // jsdom has Blob but neither object URLs nor navigation, so both are stubbed
  // and the blob's contents are read back synchronously from the stub.
  const blobs = new Map<string, Blob>()
  let counter = 0
  vi.stubGlobal('URL', Object.assign(Object.create(URL), {
    createObjectURL: (blob: Blob) => {
      const url = `blob:stub/${counter += 1}`
      blobs.set(url, blob)
      return url
    },
    revokeObjectURL: (url: string) => void revoked.push(url),
  }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href)
    if (!blob) throw new Error(`anchor clicked with an unknown href: ${this.href}`)
    captured.push({ filename: this.download, type: blob.type, text: '' })
    // Blob.text() is async; resolve it into the captured record.
    void blob.text().then((text) => {
      const entry = captured.find((item) => item.filename === this.download)
      if (entry) entry.text = text
    })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('download helper', () => {
  it('names the file, sets its media type, and releases the object URL', async () => {
    download('report.json', '{"ok":true}', 'application/json')
    expect(captured).toHaveLength(1)
    expect(captured[0]!.filename).toBe('report.json')
    expect(captured[0]!.type).toBe('application/json')
    expect(revoked).toHaveLength(1)
    await vi.waitFor(() => expect(captured[0]!.text).toBe('{"ok":true}'))
  })

  it('defaults to plain text when no media type is given', () => {
    download('notes.txt', 'hello')
    expect(captured[0]!.type).toBe('text/plain')
  })
})

describe('report exports', () => {
  it('exports JSON carrying the rerun input and the model contract', async () => {
    const user = userEvent.setup()
    render(<Report result={result} />)
    await user.click(screen.getByRole('button', { name: 'DUMP JSON' }))

    expect(captured).toHaveLength(1)
    expect(captured[0]!.filename).toBe(`isa-bench-${result.workloadId}.json`)
    expect(captured[0]!.type).toBe('application/json')
    await vi.waitFor(() => expect(captured[0]!.text.length).toBeGreaterThan(0))
    const parsed = JSON.parse(captured[0]!.text) as Record<string, unknown>
    expect(parsed.format).toBe('isa-bench-canonical-result')
    // The envelope has to carry enough to reproduce the run, and to say what
    // the numbers in it are and are not.
    expect(parsed).toHaveProperty('rerunInput')
    expect(parsed).toHaveProperty('contract')
    expect(parsed).toHaveProperty('resolvedProfiles')
    expect(parsed).toHaveProperty('disclaimer')
    expect((parsed.result as { rows: unknown[] }).rows).toHaveLength(result.rows.length)
  })

  it('exports CSV with a row per target', async () => {
    const user = userEvent.setup()
    render(<Report result={result} />)
    await user.click(screen.getByRole('button', { name: 'DUMP CSV' }))

    expect(captured[0]!.filename).toBe(`isa-bench-${result.workloadId}.csv`)
    expect(captured[0]!.type).toBe('text/csv')
    await vi.waitFor(() => expect(captured[0]!.text.length).toBeGreaterThan(0))
    const lines = captured[0]!.text.trim().split(/\r?\n/)
    // Header plus one line per requested target.
    expect(lines.length).toBe(result.rows.length + 1)
    expect(lines[0]).toContain('isa')
    expect(lines[0]).toContain('nominal_model_energy_nj_uncalibrated')
  })
})
