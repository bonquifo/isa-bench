import { describe, expect, it } from 'vitest'
import { IR_REFERENCE_MODEL_VERSION, interpretIrWorkers, isParallelIr } from './ir-reference.ts'
import { applyData, parseIr } from './ir.ts'
import { MAX_HW_THREADS, MEM_SIZE } from './types.ts'

function run(source: string, workers: number) {
  const program = parseIr(source)
  const memory = new ArrayBuffer(MEM_SIZE)
  applyData(memory, program.data)
  return interpretIrWorkers(program, memory, workers)
}

/**
 * This executor is the oracle every parallel custom-IR run is checked against,
 * so its refusals matter as much as its results: an oracle that returns a
 * plausible number for a divergent or deadlocked program would let a wrong
 * answer through.
 */
describe('IR reference executor', () => {
  it('detects whether a program is thread-aware at all', () => {
    expect(isParallelIr(parseIr('imm r0, 1\nhalt r0'))).toBe(false)
    expect(isParallelIr(parseIr('tid r0\nhalt r0'))).toBe(true)
    expect(isParallelIr(parseIr('nthreads r0\nhalt r0'))).toBe(true)
  })

  it('gives every thread its own registers and a shared memory', () => {
    // Each thread stores its own id, barriers, then thread 0 reads slot 1.
    const result = run(`
      tid r0
      imm r1, 4096
      stw r0, 0(r1,r0,4)
      barrier
      imm r2, 4
      add r3, r1, r2
      ldw r4, 0(r3)
      halt r4
    `, 4)
    expect(result.value).toBe(1)
    expect(result.workers).toBe(4)
    expect(result.modelVersion).toBe(IR_REFERENCE_MODEL_VERSION)
    expect(result.steps).toBeGreaterThan(0)
  })

  it('reports nthreads as the effective worker count, not the requested one', () => {
    const source = 'nthreads r0\nhalt r0'
    expect(run(source, 3).value).toBe(3)
    // Clamped to at least one worker and at most the modeled thread ceiling.
    expect(run(source, 0).value).toBe(1)
    expect(run(source, -8).value).toBe(1)
    expect(run(source, MAX_HW_THREADS + 50).value).toBe(MAX_HW_THREADS)
    // A fractional request truncates rather than rounding up.
    expect(run(source, 2.9).value).toBe(2)
  })

  it('returns thread zero\'s halt value once every thread has halted', () => {
    const result = run(`
      tid r0
      imm r1, 100
      add r2, r1, r0
      halt r2
    `, 4)
    expect(result.value).toBe(100)
  })

  it('refuses a barrier that not every thread reaches', () => {
    // Thread 0 halts immediately; the rest block forever on the barrier.
    expect(() => run(`
      tid r0
      imm r1, 0
      beq r0, r1, leave
      barrier
      leave:
        halt r0
    `, 4)).toThrow(/divergent barrier/i)
  })

  it('is deterministic across repeated runs of the same parallel program', () => {
    const source = `
      tid r0
      nthreads r1
      imm r2, 4096
      stw r0, 0(r2,r0,4)
      barrier
      ldw r3, 0(r2)
      add r4, r3, r1
      halt r4
    `
    const first = run(source, 8)
    const second = run(source, 8)
    expect(second.value).toBe(first.value)
    expect(second.steps).toBe(first.steps)
  })

  it('rejects allocator-only instructions that cannot appear in source IR', () => {
    const program = parseIr('imm r0, 1\nhalt r0')
    const memory = new ArrayBuffer(MEM_SIZE)
    // spill_load/spill_store are produced by register allocation, never parsed.
    const patched = { ...program, insts: [{ kind: 'spill_store' as const, slot: 0, src: 0 }, ...program.insts] }
    expect(() => interpretIrWorkers(patched as never, memory, 1)).toThrow(/spill instruction is invalid/i)
  })
})
