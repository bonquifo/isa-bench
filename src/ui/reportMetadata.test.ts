import { describe, expect, it } from 'vitest'
import { runComparison } from '../engine/compare.ts'
import { IsaId } from '../engine/types.ts'
import { reportContractLabels, reportParameterLabels } from './reportMetadata.ts'

function run(workloadId: string, n: number, seed = 4, customSource?: string) {
  return runComparison({
    workloadId,
    n,
    seed,
    isas: [IsaId.RISCV],
    hardwareMode: 'same',
    profileId: 'equal-inorder',
    customSource,
  })
}

describe('report metadata labels', () => {
  it('reports effective N and a clamp note but hides an unused seed', () => {
    const result = run('int_sum', -3)
    expect(reportParameterLabels(result)).toContain(`EFFECTIVE N ${result.workload.effectiveN}`)
    expect(reportParameterLabels(result)).toContain('CLAMPED FROM -3')
    expect(reportParameterLabels(result).some((label) => label.startsWith('SEED'))).toBe(false)
  })

  it('shows seed only when used and no N or seed for fixed C', () => {
    expect(reportParameterLabels(run('dot_product', 8))).toContain('SEED 4')
    expect(reportParameterLabels(run('c-fib', 99))).toEqual([])
  })

  it('labels custom parallel input as worker cap and active workers', () => {
    const custom = run('custom', 3, 1, 'tid r0\nnthreads r1\nhalt r0')
    expect(reportParameterLabels(custom)).toEqual(['WORKER CAP 3', 'EFFECTIVE ACTIVE WORKERS 1'])
  })

  it('always reports contract versions and comparison mode', () => {
    const labels = reportContractLabels(run('int_sum', 8))
    expect(labels).toContain('MODEL 9')
    expect(labels).toContain('BACKEND 5')
    expect(labels.at(-1)).toContain('CONTROLLED')
  })
})
