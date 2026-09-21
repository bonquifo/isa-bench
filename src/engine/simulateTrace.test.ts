import { describe, expect, it } from 'vitest'
import { HARDWARE_PROFILES, profileById } from './hardware.ts'
import { simulateTrace } from './simulateTrace.ts'
import { IsaId, type InstClass } from './types.ts'
import { fixtureNames, initialState, readElf, readIndex } from '../isa/common/fixtures.node.ts'
import { rv64Backend } from '../isa/riscv/backend.ts'
import { RV64_FIXTURE_DIR, readDump } from '../isa/riscv/fixtures.node.ts'

function run(name: string, profileId: string) {
  const start = initialState(RV64_FIXTURE_DIR, name, rv64Backend.gprCount)
  const { interpreter } = rv64Backend.load(readElf(RV64_FIXTURE_DIR, name), {
    initialRegisters: start.x.map((value) => BigInt.asIntN(64, value)),
  })
  const metrics = simulateTrace(interpreter, profileById(profileId), IsaId.RISCV)
  return { metrics, interpreter }
}

describe('trace-driven timing over real RV64 execution', () => {
  const index = readIndex(RV64_FIXTURE_DIR)

  it('times every instruction the reference executed, and no others', () => {
    for (const name of fixtureNames(RV64_FIXTURE_DIR)) {
      const { metrics } = run(name, 'equal-inorder')
      const declared = index.fixtures.find((f) => f.name === name)!
      expect(`${name}: ${metrics.instructions}`).toBe(`${name}: ${declared.steps}`)
    }
  })

  it('preserves the guest output through the timing path', () => {
    const { metrics, interpreter } = run('dot', 'equal-inorder')
    // The guest writes its state dump to fd 1, so the bytes that reach the
    // metrics are the same ones the differential comparison checks.
    expect(interpreter.stdout().length).toBe(1552)
    expect(metrics.stdout.length).toBeGreaterThan(0)
    expect(metrics.result).toBe(0)
  })

  it('keeps its counters self-consistent', () => {
    const { metrics } = run('call', 'equal-inorder')
    const mixTotal = Object.values(metrics.mix as Record<InstClass, number>)
      .reduce((sum, n) => sum + n, 0)
    expect(mixTotal).toBe(metrics.instructions)
    expect(metrics.issuedOperations).toBe(metrics.instructions)
    expect(metrics.completedOperations).toBe(metrics.instructions)
    const originTotal = Object.values(metrics.operationOrigins).reduce((sum, n) => sum + n, 0)
    expect(originTotal).toBe(metrics.instructions)
    expect(metrics.cycles).toBeGreaterThanOrEqual(metrics.instructions)
    expect(metrics.cpi).toBeGreaterThan(0)
    expect(metrics.ipc).toBeGreaterThan(0)
    expect(metrics.timeUs).toBeGreaterThan(0)
  })

  it('sees the real code, not a nominal four bytes per instruction', () => {
    const { metrics } = run('dot', 'equal-inorder')
    expect(metrics.fetchedBytes).toBeLessThan(metrics.instructions * 4)
    expect(metrics.fetchedBytes).toBeGreaterThan(metrics.instructions * 2)
    expect(metrics.decodedBytes).toBe(metrics.fetchedBytes)
  })

  it('exercises the memory hierarchy and the predictor', () => {
    const { metrics } = run('dot', 'equal-inorder')
    expect(metrics.icLineAccesses).toBeGreaterThan(0)
    expect(metrics.dcLineAccesses).toBeGreaterThan(0)
    expect(metrics.icMisses).toBeGreaterThan(0)
    expect(metrics.branches).toBeGreaterThan(0)
    expect(metrics.dramRequests).toBeGreaterThan(0)
  })

  it('counts calls and returns from the real control flow', () => {
    const { metrics } = run('call', 'equal-inorder')
    expect(metrics.calls).toBeGreaterThan(0)
    expect(metrics.indirectCalls).toBeGreaterThan(0)
    // Every call in this program returns, so the two must balance exactly.
    expect(metrics.calls + metrics.indirectCalls).toBe(metrics.returns)
  })

  it('predicts returns from the modelled return stack, and misses past it', () => {
    // fib(14) nests fifteen frames deep counting the harness, so a sixteen
    // entry return stack predicts every return and an eight entry one cannot.
    expect(run('call', 'equal-inorder').metrics.rasMisses).toBe(0)
    expect(run('call', 'embedded').metrics.rasMisses).toBeGreaterThan(0)
  })

  it('reports disassembly taken from the real encoding', () => {
    const { metrics } = run('alu', 'equal-inorder')
    expect(metrics.disasm.length).toBeGreaterThan(0)
    expect(metrics.disasm[0]).toMatch(/^[0-9a-f]{8} {2}\S+/)
  })

  it('responds to the hardware profile rather than ignoring it', () => {
    const cycles = new Map<string, number>()
    for (const profile of HARDWARE_PROFILES) {
      cycles.set(profile.id, run('dot', profile.id).metrics.cycles)
    }
    // A model that ignored its inputs would return one number for all of them.
    expect(new Set(cycles.values()).size).toBeGreaterThan(1)
    for (const count of cycles.values()) expect(count).toBeGreaterThan(0)
  })

  it('produces energy figures flagged as modelled, never measured', () => {
    const { metrics } = run('dot', 'equal-inorder')
    expect(metrics.totalEnergyNj).toBeGreaterThan(0)
    expect(metrics.energyModelClass).toBe('uncalibrated-event-model')
    expect(metrics.energyUncertainty).toBe('not-quantified')
  })

  it('agrees with the reference on the final state it timed', () => {
    // Timing must not perturb execution: the same dump comes out either way.
    const { interpreter } = run('fp_cvt', 'equal-inorder')
    const reference = readDump('fp_cvt')
    const produced = interpreter.stdout()
    const view = new DataView(produced.buffer, produced.byteOffset)
    for (let r = 0; r < 32; r++) {
      expect(view.getBigUint64(256 + r * 8, true)).toBe(reference.f[r])
    }
  })
})
