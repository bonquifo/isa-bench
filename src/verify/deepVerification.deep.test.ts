import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runComparison, type CompareInput, type CompareResult } from '../engine/compare.ts'
import { C_EXAMPLES, cWorkloadId } from '../engine/c/compile_c.ts'
import { fingerprint, stableSerialize } from '../engine/measurement.ts'
import { ALL_ISAS } from '../engine/types.ts'
import { resultToJson } from '../ui/exports.ts'
import { restoreInput, saveRun } from '../ui/saves.ts'
import { generateRandomIr } from './randomIr.ts'

const suiteStarted = performance.now()
const timingLines: string[] = []

function elapsed(started: number): string {
  return `${((performance.now() - started) / 1000).toFixed(2)}s`
}

function baseInput(overrides: Partial<CompareInput>): CompareInput {
  return {
    workloadId: 'int_sum',
    n: 24,
    seed: 1,
    isas: ALL_ISAS,
    hardwareMode: 'same',
    profileId: 'equal-inorder',
    ...overrides,
  }
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  return hash | 0
}

function expectComplete(result: CompareResult): void {
  expect(result.rows).toHaveLength(ALL_ISAS.length)
  expect(new Set(result.rows.map((row) => row.isa))).toEqual(new Set(ALL_ISAS))
  for (const row of result.rows) {
    expect(row.matchedGold, row.isa).toBe(true)
    expect(Object.values(row.mix).reduce((sum, count) => sum + count, 0), `${row.isa} operation classes`)
      .toBe(row.completedOperations)
    expect(Object.values(row.operationOrigins).reduce((sum, count) => sum + count, 0), `${row.isa} origins`)
      .toBe(row.completedOperations)
    expect(
      row.activeCoreCycles + row.stalledCoreCycles + row.idleCoreCycles,
      `${row.isa} residency`,
    ).toBe(row.cycles * row.cores)
    expect(
      row.operationDecodeEnergyNj + row.cacheEnergyNj +
        row.memoryCoherenceEnergyNj + row.recoveryEnergyNj,
      `${row.isa} dynamic energy`,
    ).toBeCloseTo(row.dynamicEnergyNj, 10)
    expect(row.dynamicEnergyNj + row.staticEnergyNj, `${row.isa} total energy`)
      .toBeCloseTo(row.nominalModelEnergyNj, 10)
    expect(row.totalEnergyNj, `${row.isa} compatibility total`).toBeCloseTo(row.nominalModelEnergyNj, 10)
  }
}

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>()

  get length(): number {
    return this.#values.size
  }

  clear(): void {
    this.#values.clear()
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.#values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value)
  }
}

describe('deep verification matrix', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    })
  })

  afterAll(() => {
    console.info([...timingLines, `[deep] total ${elapsed(suiteStarted)}`].join('\n'))
  })

  it('runs 32 deterministic random IR seeds through the reference and every backend', () => {
    const started = performance.now()
    const kinds = new Set<string>()
    for (let seed = 0; seed < 32; seed++) {
      const generated = generateRandomIr(seed)
      kinds.add(generated.kind)
      const result = runComparison(baseInput({
        workloadId: 'custom',
        customSource: generated.source,
      }))
      expect(result.gold, `seed ${seed} independent return`).toBe(generated.expectedReturn)
      expect(result.stdout, `seed ${seed} stdout`).toBe(generated.expectedStdout)
      expectComplete(result)
    }
    expect(kinds).toEqual(new Set(['straight-line', 'controlled-branch', 'memory']))
    timingLines.push(`[deep] random-ir-32 ${elapsed(started)}`)
  })

  it('runs every canned C fixture once across every backend with independent metadata', () => {
    const started = performance.now()
    for (const example of C_EXAMPLES) {
      const fixtureStarted = performance.now()
      const result = runComparison(baseInput({
        workloadId: cWorkloadId(example),
        n: 1,
      }))
      expect(result.gold, `${example.id} return`).toBe(example.expectedReturn)
      if ('exact' in example.expectedStdout) {
        expect(result.stdout, `${example.id} stdout`).toBe(example.expectedStdout.exact)
      } else {
        expect(result.stdout.length, `${example.id} stdout length`).toBe(example.expectedStdout.length)
        expect(fnv1a(result.stdout), `${example.id} stdout fingerprint`).toBe(example.expectedStdout.fnv1a)
      }
      expectComplete(result)
      timingLines.push(`[deep] c-${example.id} ${elapsed(fixtureStarted)}`)
    }
    timingLines.push(`[deep] c-matrix ${elapsed(started)}`)
  })

  it('covers both parallel profiles for int sum and dot product on all targets', () => {
    const started = performance.now()
    for (const workloadId of ['int_sum', 'dot_product']) {
      for (const profileId of ['equal-quad', 'equal-smt']) {
        const result = runComparison(baseInput({ workloadId, profileId, n: 32, seed: 17 }))
        expectComplete(result)
        expect(result.rows.every((row) => row.activeThreads > 1), `${workloadId}/${profileId}`).toBe(true)
      }
    }
    timingLines.push(`[deep] parallel-profile-matrix ${elapsed(started)}`)
  })

  it('is byte-identical across three runs for serial, parallel, custom IR, and custom C', () => {
    const started = performance.now()
    const generated = generateRandomIr(0x51a)
    const cases: Array<[string, CompareInput]> = [
      ['builtin-serial', baseInput({ workloadId: 'checksum', n: 40, seed: 7 })],
      ['builtin-parallel', baseInput({ workloadId: 'int_sum', n: 32, profileId: 'equal-quad' })],
      ['custom-ir', baseInput({ workloadId: 'custom', customSource: generated.source })],
      ['custom-c', baseInput({
        workloadId: 'custom-c',
        customSource: `
          int direct(int x) { return x + 3; }
          int twice(int x) { return x + x; }
          int main(void) {
            int (*indirect)(int) = twice;
            return direct(4) + indirect(5);
          }
        `,
      })],
    ]
    for (const [name, input] of cases) {
      const runs = [runComparison(input), runComparison(input), runComparison(input)]
      const json = runs.map(resultToJson)
      expect(json[1], `${name} second JSON`).toBe(json[0])
      expect(json[2], `${name} third JSON`).toBe(json[0])
      expect(runs.map((result) => fingerprint(result)), `${name} fingerprints`)
        .toEqual([fingerprint(runs[0]), fingerprint(runs[0]), fingerprint(runs[0])])
      expect(runs.map((result) => stableSerialize(result.resolvedHardware)), `${name} profiles`)
        .toEqual(Array(3).fill(stableSerialize(runs[0].resolvedHardware)))
      expectComplete(runs[0])
    }
    timingLines.push(`[deep] triple-determinism ${elapsed(started)}`)
  })

  it('round-trips canonical reruns and saved profile restores exactly', () => {
    const started = performance.now()
    const original = runComparison(baseInput({
      workloadId: 'dot_product',
      n: 24,
      seed: 19,
      profileId: 'equal-smt',
    }))
    const canonicalRerun = runComparison(original.rerunInput)
    expect(resultToJson(canonicalRerun)).toBe(resultToJson(original))

    localStorage.clear()
    const saved = saveRun('deep replay', original)
    expect(resultToJson(saved.result)).toBe(resultToJson(original))
    const restored = restoreInput(saved)
    expect(restored).not.toBeNull()
    const restoredRerun = runComparison(restored!)
    expect(resultToJson(restoredRerun)).toBe(resultToJson(original))
    expectComplete(restoredRerun)
    timingLines.push(`[deep] canonical-save-rerun ${elapsed(started)}`)
  })

  it('covers all-target arithmetic and scaled unaligned aliasing edges', () => {
    const started = performance.now()
    const arithmetic = runComparison(baseInput({
      workloadId: 'custom',
      customSource: `
        imm r0, -7
        imm r1, 2
        div r2, r0, r1
        rem r3, r0, r1
        imm r4, 31
        shl r5, r1, r4
        imm r6, 1
        shr r7, r5, r6
        sar r8, r5, r6
        add r9, r2, r3
        xor r10, r7, r8
        add r11, r9, r10
        halt r11
      `,
    }))
    expect(arithmetic.gold).toBe(-4)
    expectComplete(arithmetic)

    const memory = runComparison(baseInput({
      workloadId: 'custom',
      customSource: `
        .data 4096
        .word 11 22 33 44
        .text
        imm r0, 4096
        imm r1, 2
        ldw r2, 0(r0,r1,4)
        stw r2, 1(r0)
        ldw r3, 1(r0)
        halt r3
      `,
    }))
    expect(memory.gold).toBe(33)
    expectComplete(memory)
    timingLines.push(`[deep] arithmetic-memory-edges ${elapsed(started)}`)
  })

  it('covers direct/indirect calls and SPMD barrier/coherence on all targets', () => {
    const started = performance.now()
    const calls = runComparison(baseInput({
      workloadId: 'custom-c',
      customSource: `
        int add3(int x) { return x + 3; }
        int twice(int x) { return x + x; }
        int main(void) {
          int (*fp)(int) = twice;
          return add3(4) + fp(5);
        }
      `,
    }))
    expect(calls.gold).toBe(17)
    expectComplete(calls)
    expect(calls.rows.every((row) => row.calls > 0 && row.indirectCalls > 0)).toBe(true)

    const coherence = runComparison(baseInput({
      workloadId: 'custom',
      n: 4,
      profileId: 'equal-quad',
      customSource: `
        tid r0
        nthreads r1
        imm r2, 8192
        addi r3, r0, 1
        stw r3, 0(r2,r0,4)
        barrier
        imm r4, 0
        bne r0, r4, worker
        ldw r5, 0(r2)
        halt r5
        worker:
        halt r4
      `,
    }))
    expect(coherence.gold).toBe(1)
    expectComplete(coherence)
    expect(coherence.rows.every((row) => row.activeThreads === 4)).toBe(true)
    expect(coherence.rows.some((row) => row.coherenceTransfers + row.coherenceInvalidations > 0)).toBe(true)
    timingLines.push(`[deep] calls-barrier-coherence ${elapsed(started)}`)
  })
})
