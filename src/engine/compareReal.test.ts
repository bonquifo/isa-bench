import { describe, expect, it } from 'vitest'
import { C_EXAMPLES } from './c/programs.ts'
import { runComparison, type CompareInput } from './compare.ts'
import { parseCompareResult } from './compareSchema.ts'
import {
  realExecutionAvailable,
  realExecutionRefusal,
  runRealComparisonAsync,
  type RealTargetProvider,
} from './compareReal.ts'
import { compilingProvider, type CompileFn } from '../compiler/provider.ts'
import { DEFAULT_PROFILE_ID } from './hardware.ts'
import { fixtureRealProvider } from './realProvider.node.ts'
import { ALL_ISAS, IsaId } from './types.ts'

function input(programId: string, overrides: Partial<CompareInput> = {}): CompareInput {
  return {
    workloadId: `c-${programId}`,
    n: 0,
    seed: 1,
    isas: [...ALL_ISAS],
    hardwareMode: 'same',
    profileId: DEFAULT_PROFILE_ID,
    execution: 'real-isa',
    ...overrides,
  }
}

const quiet = () => {}

describe('the comparison on real instruction sets', () => {
  it('runs every target on its real binary and agrees with the reference', async () => {
    const result = await runRealComparisonAsync(input('fib'), fixtureRealProvider, quiet)
    expect(result.rows.map((row) => row.isa)).toEqual(ALL_ISAS)
    for (const row of result.rows) {
      expect(`${row.isa} ${row.result}`).toBe(`${row.isa} ${result.gold}`)
      expect(row.matchedGold).toBe(true)
      expect(row.instructions).toBeGreaterThan(0)
    }
    expect(result.execution?.mode).toBe('real-isa')
    expect(result.execution?.targets.map((target) => target.verdict))
      .toEqual(ALL_ISAS.map(() => 'match'))
    expect(result.rerunInput.execution).toBe('real-isa')
  })

  it('counts instructions that actually retired, which differ between the architectures', async () => {
    // The whole reason for this path. The lowering's counts come from one
    // IR stream shaped eight ways; these come from eight compilers'
    // output, and they are not the same numbers.
    const real = await runRealComparisonAsync(input('fib'), fixtureRealProvider, quiet)
    const counts = new Set(real.rows.map((row) => row.instructions))
    expect(counts.size).toBe(real.rows.length)
    const lowered = runComparison(input('fib', { execution: undefined }))
    for (const isa of [IsaId.RISCV, IsaId.X86, IsaId.WASM]) {
      const a = real.rows.find((row) => row.isa === isa)!.instructions
      const b = lowered.rows.find((row) => row.isa === isa)!.instructions
      expect(`${isa}: ${a === b}`).toBe(`${isa}: false`)
    }
  })

  it('saves and reloads through the same schema as every other result', async () => {
    const result = await runRealComparisonAsync(input('hello'), fixtureRealProvider, quiet)
    const reloaded = parseCompareResult(JSON.parse(JSON.stringify(result)))
    expect(reloaded.execution).toEqual(result.execution)
    expect(reloaded.inputFingerprint).toBe(result.inputFingerprint)
  })

  it('fingerprints a real run differently from a lowered run of the same program', async () => {
    const real = await runRealComparisonAsync(input('sum'), fixtureRealProvider, quiet)
    const lowered = runComparison(input('sum', { execution: undefined }))
    expect(real.inputFingerprint).not.toBe(lowered.inputFingerprint)
    // And a lowered run's snapshot carries no mode, which is what keeps an
    // old save's fingerprint unchanged.
    expect('execution' in lowered.rerunInput).toBe(false)
    expect(lowered.execution).toBeUndefined()
  })

  it('reproduces itself exactly', async () => {
    const a = await runRealComparisonAsync(input('pi'), fixtureRealProvider, quiet)
    const b = await runRealComparisonAsync(input('pi'), fixtureRealProvider, quiet)
    expect(b.inputFingerprint).toBe(a.inputFingerprint)
    expect(b.rows.map((row) => row.cycles)).toEqual(a.rows.map((row) => row.cycles))
  })
})

describe('what the real comparison refuses, and what it states', () => {
  it('refuses a canned program whose source has been changed', async () => {
    // The binaries were compiled from the catalogue's source. A replay of
    // anything else has no binary, and running the catalogue's would be
    // answering a different question.
    const changed = input('fib', { effectiveSourceOverride: '/* edited */ int main(void) { return 1; }' })
    expect(realExecutionAvailable(changed)).toBe(false)
    await expect(runRealComparisonAsync(changed, fixtureRealProvider, quiet))
      .rejects.toThrow(/for the canned C programs, as shipped/)
  })

  it('refuses a workload that is neither a canned program nor C the user wrote', async () => {
    // A built-in IR kernel has no C source for any compiler to build.
    const kernel = input('fib', { workloadId: 'dot_product' })
    expect(realExecutionAvailable(kernel)).toBe(false)
    await expect(runRealComparisonAsync(kernel, fixtureRealProvider, quiet)).rejects.toThrow()
  })

  it('has no binary for custom C unless something compiles it', async () => {
    // The shipped provider knows only the catalogue's programs.
    const custom = input('fib', { workloadId: 'custom-c', customSource: 'int main(void){return 0;}' })
    await expect(runRealComparisonAsync(custom, fixtureRealProvider, quiet))
      .rejects.toThrow(/None of the selected targets could run this program/)
  })

  it('accepts the catalogue source replayed verbatim', () => {
    const fib = C_EXAMPLES.find((example) => example.id === 'fib')!
    expect(realExecutionAvailable(input('fib', { effectiveSourceOverride: fib.source }))).toBe(true)
  })

  it('states a target whose int cannot hold the answer, rather than failing it', async () => {
    // `wolf` returns more than a sixteen-bit int holds, so the 6502
    // computes a different value and is right to.
    const wolf = C_EXAMPLES.find((example) => example.id === 'wolf')!
    expect(Math.abs(wolf.expectedReturn)).toBeGreaterThan(32767)
    const result = await runRealComparisonAsync(
      input('wolf', { isas: [IsaId.RISCV, IsaId.MOS] }), fixtureRealProvider, quiet)
    const mos = result.execution!.targets.find((target) => target.isa === IsaId.MOS)!
    expect(mos.verdict).toBe('unreachable')
    const row = result.rows.find((candidate) => candidate.isa === IsaId.MOS)!
    expect(row.matchedGold).toBe(false)
    expect(Math.abs(row.result)).toBeLessThanOrEqual(32768)
    expect(result.rows.find((candidate) => candidate.isa === IsaId.RISCV)!.matchedGold).toBe(true)
  })

  it('names a target with no binary for the program, and runs the rest', async () => {
    // `struct` does not build for the 6502: its own assertion that the
    // struct is eight bytes is false where `int` is two.
    const result = await runRealComparisonAsync(
      input('struct', { isas: [IsaId.RISCV, IsaId.MOS] }), fixtureRealProvider, quiet)
    expect(result.rows.map((row) => row.isa)).toEqual([IsaId.RISCV])
    expect(result.execution!.unavailable).toEqual([
      { isa: IsaId.MOS, reason: 'MOS 6502 has no binary for this program' },
    ])
  })

  it('rejects a real row that disagrees with the reference', async () => {
    // The counterfactual for everything above: a target answering wrongly
    // must fail the run, not appear in the table.
    const lying: RealTargetProvider = (isa) => {
      const binding = fixtureRealProvider(isa)!
      return {
        ...binding,
        binary: () => fixtureRealProvider(IsaId.RISCV)!.binary('sum'),
      }
    }
    await expect(runRealComparisonAsync(
      input('fib', { isas: [IsaId.RISCV] }), lying, quiet))
      .rejects.toThrow(/but the IR reference result is 55/)
  })
})

describe('the real comparison on a program the user wrote', () => {
  const fib = C_EXAMPLES.find((example) => example.id === 'fib')!
  const custom = (overrides: Partial<CompareInput> = {}): CompareInput => ({
    workloadId: 'custom-c',
    customSource: fib.source,
    n: 1,
    seed: 1,
    isas: [IsaId.RISCV, IsaId.ARM],
    hardwareMode: 'same',
    profileId: DEFAULT_PROFILE_ID,
    execution: 'real-isa',
    ...overrides,
  })
  /** A compiler that hands back what the fixture builder built. */
  const shipped: CompileFn = async (isa) => {
    const bytes = await fixtureRealProvider(isa)!.binary('fib')
    return bytes ? { ok: true, binary: bytes, warnings: '' } : { ok: false, stage: 'compile', message: 'none' }
  }

  it('is offered for custom C, which the app compiles itself', () => {
    expect(realExecutionAvailable({ workloadId: 'custom-c' })).toBe(true)
  })

  it('runs what the compiler produced and checks it against the reference', async () => {
    const result = await runRealComparisonAsync(
      custom(), compilingProvider(fixtureRealProvider, fib.source, shipped), quiet)
    expect(result.rows.map((row) => row.result)).toEqual([55, 55])
    expect(result.execution?.unavailable).toEqual([])
  })

  it('records a target that could not compile the program, and runs the rest', async () => {
    const failsOnArm: CompileFn = async (isa, source, channel) => isa === IsaId.ARM
      ? { ok: false, stage: 'compile', message: "prog.c:3:5: error: use of undeclared identifier 'y'" }
      : shipped(isa, source, channel)
    const result = await runRealComparisonAsync(
      custom(), compilingProvider(fixtureRealProvider, fib.source, failsOnArm), quiet)
    expect(result.rows.map((row) => row.isa)).toEqual([IsaId.RISCV])
    expect(result.execution?.unavailable).toEqual([{
      isa: IsaId.ARM,
      reason: "AArch64 could not compile this program: prog.c:3:5: error: use of undeclared identifier 'y'",
    }])
  })

  it('says why when no target could build it', async () => {
    const never: CompileFn = async () => ({ ok: false, stage: 'link', message: 'ld.lld: error: undefined symbol: nope' })
    await expect(runRealComparisonAsync(
      custom(), compilingProvider(fixtureRealProvider, fib.source, never), quiet))
      .rejects.toThrow(/None of the selected targets could run this program\.\nRV64GC could not link this program: ld.lld: error: undefined symbol: nope/)
  })

  it('refuses a program that has no real counterpart, saying why', async () => {
    expect(realExecutionRefusal('int main(void) { return __tid(); }')).toMatch(/__tid\(\).*one thread/)
    expect(realExecutionRefusal('double main(void) { return 1.5; }')).toMatch(/returns a double/)
    expect(realExecutionRefusal(fib.source)).toBeNull()
    await expect(runRealComparisonAsync(
      custom({ customSource: 'int main(void) { __barrier(); return 0; }' }),
      compilingProvider(fixtureRealProvider, '', shipped), quiet))
      .rejects.toThrow(/__barrier\(\)/)
  })
})
