import { describe, expect, it } from 'vitest'
import { validateWorkerResult } from './runner.js'

describe('lane-specific worker result validation', () => {
  it.each([
    'analytical-inorder',
    'analytical-ooo',
    'toolchain-validation',
    'gem5',
    'llvm-mca',
    'champsim',
  ])('rejects an empty %s result', async (lane) => {
    await expect(validateWorkerResult(lane, {}, request(lane, {}))).rejects.toThrow()
  })

  it('rejects OoO results with empty rows and envelopes', async () => {
    await expect(validateWorkerResult('analytical-ooo', {
      rows: [],
      envelopes: [],
    }, request('analytical-ooo', {}))).rejects.toThrow('rows must be nonempty')
  })
})

function request(lane: string, input: unknown) {
  return {
    schemaVersion: 'server-job-request-v1',
    lane,
    input,
  } as never
}
