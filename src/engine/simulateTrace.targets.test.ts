import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_ID, profileById } from './hardware.ts'
import { fixtureRealProvider } from './realProvider.node.ts'
import { simulateTrace } from './simulateTrace.ts'
import { ALL_ISAS, IsaId, type Metrics } from './types.ts'

/**
 * The timing model over every real target, checked for the things a trace
 * bug makes impossible rather than for particular numbers.
 *
 * Each of these once failed on one target while the others were fine: MIPS
 * recorded a branch's outcome on its delay slot and so never mispredicted;
 * MIPS and SPARC return past the slot, and a return stack that pushed the
 * address after the call missed every return; SPARC's `ret` was an indirect
 * jump; POWER's conditional returns popped the stack when they fell
 * through; WebAssembly pushed a return address for calls into the host. A
 * test over one target could not have seen any of them.
 */
const PROGRAM = 'fib'

async function timed(isa: IsaId): Promise<Metrics> {
  const binding = fixtureRealProvider(isa)!
  const bytes = (await binding.binary(PROGRAM))!
  const { interpreter } = binding.backend.load(bytes, { instructionBudget: 50_000_000 })
  return simulateTrace(interpreter, profileById(DEFAULT_PROFILE_ID), isa)
}

describe('trace-driven timing across every real target', () => {
  for (const isa of ALL_ISAS) {
    describe(isa, () => {
      it('mispredicts some conditional branches, as a finite predictor must', async () => {
        const row = await timed(isa)
        const executed = row.executed!
        expect(executed.conditionalBranches).toBeGreaterThan(100)
        expect(executed.takenConditionalBranches).toBeGreaterThan(0)
        expect(executed.takenConditionalBranches).toBeLessThan(executed.conditionalBranches)
        expect(row.mispredicts).toBeGreaterThan(0)
        expect(row.mispredicts).toBeLessThan(executed.conditionalBranches)
      })

      it('pairs calls with returns, and predicts nearly every return', async () => {
        const row = await timed(isa)
        const { calls, returns } = row.executed!
        expect(calls).toBeGreaterThan(50)
        // Startup and exit leave a few unpaired: the entry function is
        // called by nothing, and exit never returns.
        expect(Math.abs(calls - returns)).toBeLessThanOrEqual(Math.max(8, calls * 0.05))
        expect(row.rasMisses).toBeLessThanOrEqual(Math.max(3, returns * 0.02))
      })

      it('counts every instruction that touches data memory', async () => {
        const row = await timed(isa)
        const executed = row.executed!
        expect(executed.memoryInstructions).toBeGreaterThanOrEqual(Math.max(executed.loads, executed.stores))
        expect(executed.memoryInstructions).toBeLessThanOrEqual(executed.loads + executed.stores)
        // Class-based counting misses implicit accesses -- an x86 call's
        // push, a 6502 `jsr` -- so the counted figure is never smaller.
        expect(executed.memoryInstructions).toBeGreaterThanOrEqual(row.mix.ld + row.mix.st)
        expect(row.dcLineAccesses).toBeGreaterThanOrEqual(executed.memoryInstructions)
      })

      it('reports code footprint and fetched bytes consistently', async () => {
        const row = await timed(isa)
        const executed = row.executed!
        expect(executed.instructionBytes).toBe(row.fetchedBytes)
        expect(executed.codeFootprintBytes).toBeGreaterThan(0)
        expect(executed.codeFootprintBytes).toBeLessThanOrEqual(row.codeBytes)
        expect(executed.codeFootprintBytes).toBeLessThanOrEqual(executed.instructionBytes)
      })
    })
  }

  it('charges SPARC its register-window traps, and nobody else any', async () => {
    for (const isa of ALL_ISAS) {
      const row = await timed(isa)
      if (isa === IsaId.SPARC) {
        // fib recurses deeper than eight windows.
        expect(row.executed!.platformTraps).toBeGreaterThan(0)
      } else {
        expect(row.executed!.platformTraps).toBe(0)
      }
    }
  })
})
