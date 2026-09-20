import { describe, expect, it } from 'vitest'
import { runComparison, runComparisonAsync } from './compare.ts'
import { C_EXAMPLES, cExampleByWorkloadId } from './c/compile_c.ts'
import { CPU_CATALOG, DEFAULT_CPU_ID } from './cpus.ts'
import {
  MEASUREMENT_CLAIM_SCOPE,
  MEASUREMENT_CONTRACT,
  fingerprint,
  stableSerialize,
} from './measurement.ts'
import { ALL_ISAS, IsaId } from './types.ts'
import { WORKLOADS } from './workloads.ts'

describe('comparison pipeline', () => {
  it('defaults to every ISA and reports gold steps plus matching rows', () => {
    const result = runComparison({
      workloadId: 'checksum',
      n: 32,
      seed: 1,
      isas: [],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    expect(result.rows).toHaveLength(ALL_ISAS.length)
    expect(result.rows.every((r) => r.matchedGold)).toBe(true)
    expect(result.goldSteps).toBeGreaterThan(32)
    expect(result.workloadName).toBe('Checksum mix')
    expect(result.fp).toBe(false)
  })

  it('deduplicates requested ISAs', () => {
    const result = runComparison({
      workloadId: 'int_sum',
      n: 16,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.RISCV, IsaId.ARM],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    expect(result.rows.map((r) => r.isa)).toEqual(['riscv', 'arm'])
    expect(result.rerunInput.isas).toEqual([IsaId.RISCV, IsaId.ARM])
    expect(result.rerunInput.selectedIsas).toEqual([IsaId.RISCV, IsaId.ARM])
  })

  it('clamps N to the workload’s [min, max]', () => {
    const def = WORKLOADS.find((w) => w.id === 'int_sum')!
    const lo = runComparison({
      workloadId: 'int_sum',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    const hi = runComparison({
      workloadId: 'int_sum',
      n: 1_000_000,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    expect(lo.gold).toBe((def.minN * (def.minN - 1)) / 2)
    expect(hi.gold).toBe((def.maxN * (def.maxN - 1)) / 2)
    expect(lo.n).toBe(def.minN)
    expect(hi.n).toBe(def.maxN)
    expect(lo.workload).toMatchObject({
      requestedN: 1,
      effectiveN: def.minN,
      nRole: 'problem-size',
      seedUsed: false,
      effectiveSeed: 1,
      kind: 'builtin-ir',
      referenceOracle: 'independent-host-model',
      hasIndependentExpectedCheck: true,
    })
  })

  it('records signed-i32 seed semantics and the measurement contract', () => {
    const result = runComparison({
      workloadId: 'checksum',
      n: 16,
      seed: 0x1ffffffff,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    expect(result.contract).toEqual(MEASUREMENT_CONTRACT)
    expect(result.contract.claimScope).toBe(MEASUREMENT_CLAIM_SCOPE)
    expect(result.workload.effectiveSeed).toBe(-1)
    expect(result.workload.seedUsed).toBe(true)
    expect(result.workload.requestedSeed).toBe(0x1ffffffff)
  })

  it('rejects an unknown workload', () => {
    expect(() =>
      runComparison({
        workloadId: 'not-a-kernel',
        n: 8,
        seed: 1,
        isas: [IsaId.RISCV],
        hardwareMode: 'same',
        profileId: 'equal-inorder',
      }),
    ).toThrow(/Unknown workload/)
  })

  it('resolves named illustrative presets per ISA', () => {
    const result = runComparison({
      workloadId: 'int_sum',
      n: 16,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.X86],
      hardwareMode: 'cpus',
      profileId: 'equal-inorder',
    })
    expect(result.rows[0].hardwareId).toBe(`cpu-${DEFAULT_CPU_ID.riscv}`)
    expect(result.rows[1].hardwareId).toBe(`cpu-${DEFAULT_CPU_ID.x86}`)
    expect(result.rows[0].hardwareId).not.toBe(result.rows[1].hardwareId)
    expect(result.rerunInput.resolvedCpuByIsa).toEqual({
      riscv: DEFAULT_CPU_ID.riscv,
      x86: DEFAULT_CPU_ID.x86,
    })
  })

  it('executes README-style scaled addressing on every ISA', () => {
    const src = `
      .data 4096
      .word 10 20 30 40
      .text
      imm r0, 4096
      imm r1, 3
      ldw r2, 0(r0,r1,4)
      halt r2
    `
    const result = runComparison({
      workloadId: 'custom',
      n: 1,
      seed: 1,
      isas: ALL_ISAS,
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: src,
    })
    expect(result.gold).toBe(40)
    expect(result.rows.every((r) => r.matchedGold && r.result === 40)).toBe(true)
  })

  it('records custom IR source and uses the interpreter as gold', () => {
    const src = 'imm r0, 6\nimm r1, 7\nmul r2, r0, r1\nhalt r2\n'
    const result = runComparison({
      workloadId: 'custom',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.MOS],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: src,
    })
    expect(result.gold).toBe(42)
    expect(result.source).toBe(src)
    expect(result.workloadName).toBe('Custom IR')
    expect(result.rows.every((r) => r.matchedGold && r.result === 42)).toBe(true)
  })

  it('enables SPMD workers for custom IR that mentions tid', () => {
    const result = runComparison({
      workloadId: 'custom',
      n: 4,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customHw: { cores: 4, threads: 4, name: '4c' },
      customSource: `
        tid r0
        nthreads r1
        halt r0
      `,
    })
    expect(result.rows[0].activeThreads).toBe(4)
    expect(result.gold).toBe(0)
    expect(result.workload).toMatchObject({
      kind: 'custom-ir',
      nRole: 'worker-cap',
      requestedWorkerCap: 4,
      maxUsefulWorkers: 4,
      effectiveN: 4,
      effectiveSeed: null,
      seedUsed: false,
      parallelSemantics: 'source-defined',
      referenceOracle: 'ir-interpreter',
      hasIndependentExpectedCheck: false,
    })
  })

  it('records custom threaded C worker-cap semantics', () => {
    const source = 'int main(void) { __tid(); __nthreads(); return 0; }\n'
    const result = runComparison({
      workloadId: 'custom-c',
      n: 3,
      seed: 77,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customHw: { cores: 4, threads: 4 },
      customSource: source,
    })
    expect(result.source).toBe(source)
    expect(result.workload).toMatchObject({
      kind: 'custom-c',
      nRole: 'worker-cap',
      requestedWorkerCap: 3,
      maxUsefulWorkers: 3,
      parallelSemantics: 'source-defined',
    })
  })

  it('marks fixed C inputs unused and preserves the exact canned source', () => {
    const canned = cExampleByWorkloadId('c-sum')!
    const result = runComparison({
      workloadId: 'c-sum',
      n: 999,
      seed: 123,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    expect(result.source).toBe(canned.source)
    expect(result.rerunInput.effectiveSource).toBe(canned.source)
    expect(result.rerunInput.effectiveSourceOverride).toBe(canned.source)
    expect(result.workload).toMatchObject({
      kind: 'fixed-c',
      nRole: 'unused',
      effectiveN: null,
      requestedWorkerCap: null,
      effectiveSeed: null,
      seedUsed: false,
      parallelSemantics: 'serial',
    })
  })

  it('snapshots complete resolved profiles and custom hardware input', () => {
    const result = runComparison({
      workloadId: 'int_sum',
      n: 16,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.ARM],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customHw: {
        name: 'snapshot',
        cores: 2,
        threads: 4,
        l1i: { sizeBytes: 4096, ways: 2, lineBytes: 32 },
        l1d: { sizeBytes: 4096, ways: 2, lineBytes: 32 },
        l2: { sizeBytes: 262144, ways: 8, lineBytes: 32 },
        l3: { sizeBytes: 2097152, ways: 16, lineBytes: 32 },
      },
    })
    expect(result.resolvedHardware.map((entry) => entry.isa)).toEqual([
      IsaId.RISCV,
      IsaId.ARM,
    ])
    for (const { profile } of result.resolvedHardware) {
      expect(profile).toMatchObject({
        id: 'custom',
        name: 'snapshot',
        cores: 2,
        threads: 4,
        l1d: { sizeBytes: 4096, ways: 2, lineBytes: 32 },
      })
      expect(profile.l2).toBeDefined()
      expect(profile.l3).toBeDefined()
    }
    expect(result.rerunInput.customHw).toEqual({
      name: 'snapshot',
      cores: 2,
      threads: 4,
      l1i: { sizeBytes: 4096, ways: 2, lineBytes: 32 },
      l1d: { sizeBytes: 4096, ways: 2, lineBytes: 32 },
      l2: { sizeBytes: 262144, ways: 8, lineBytes: 32 },
      l3: { sizeBytes: 2097152, ways: 16, lineBytes: 32 },
    })
    expect(Object.keys(result.rerunInput.resolvedProfileByIsa)).toEqual([
      IsaId.RISCV,
      IsaId.ARM,
    ])
  })

  it('replays saved profiles without consulting changed or removed preset definitions', () => {
    const original = runComparison({
      workloadId: 'int_sum',
      n: 32,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'cpus',
      profileId: 'equal-inorder',
    })
    const id = original.rerunInput.resolvedCpuByIsa!.riscv!
    const index = CPU_CATALOG.findIndex((cpu) => cpu.id === id)
    const [removed] = CPU_CATALOG.splice(index, 1)
    try {
      const replay = runComparison(original.rerunInput)
      expect(replay.rows).toEqual(original.rows)
      expect(replay.resolvedHardware).toEqual(original.resolvedHardware)
      expect(replay.inputFingerprint).toBe(original.inputFingerprint)
    } finally {
      CPU_CATALOG.splice(index, 0, removed)
    }
  })

  it('rejects malformed resolved-profile overrides before modeling', () => {
    const original = runComparison({
      workloadId: 'int_sum',
      n: 8,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    const malformed = structuredClone(original.rerunInput.resolvedProfileByIsa)
    malformed.riscv!.clockMhz = Number.NaN
    expect(() => runComparison({
      ...original.rerunInput,
      resolvedProfileByIsa: malformed,
    })).toThrow(/profile snapshot|invalid values|finite and positive/i)
  })

  it('replays fixed C from saved effective source after the fixture changes', () => {
    const canned = cExampleByWorkloadId('c-sum')!
    const originalSource = canned.source
    const original = runComparison({
      workloadId: 'c-sum',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    try {
      canned.source = 'int main(void) { return 999; }\n'
      const currentFixture = runComparison({
        ...original.rerunInput,
        effectiveSourceOverride: undefined,
      })
      const replay = runComparison(original.rerunInput)
      expect(currentFixture.gold).toBe(999)
      expect(replay.gold).toBe(original.gold)
      expect(replay.source).toBe(originalSource)
      expect(replay.inputFingerprint).toBe(original.inputFingerprint)
    } finally {
      canned.source = originalSource
    }
  })

  it('replays archived fixed C after its catalog fixture is removed or renamed', () => {
    const original = runComparison({
      workloadId: 'c-sum',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    const index = C_EXAMPLES.findIndex((example) => example.id === 'sum')
    const [removed] = C_EXAMPLES.splice(index, 1)
    try {
      const replay = runComparison(original.rerunInput)
      expect(replay.gold).toBe(original.gold)
      expect(replay.workload.kind).toBe('fixed-c')
      expect(replay.workloadName).toBe('Archived C fixture (c-sum)')
      expect(replay.notes).toContain('saved effective-source snapshot')
      expect(replay.inputFingerprint).toBe(original.inputFingerprint)
    } finally {
      C_EXAMPLES.splice(index, 0, removed)
    }
  })

  it('accepts an unknown archived c-* id only with a saved effective source', () => {
    const source = 'int main(void) { return 73; }\n'
    const archived = runComparison({
      workloadId: 'c-removed-example',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      effectiveSourceOverride: source,
    })
    expect(archived.gold).toBe(73)
    expect(archived.workload.kind).toBe('fixed-c')
    expect(archived.source).toBe(source)
    expect(() => runComparison({
      workloadId: 'c-removed-example',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })).toThrow(/Unknown C program/)
  })

  it('ignores hidden editor source for built-in fingerprints and snapshots', () => {
    const base = {
      workloadId: 'int_sum',
      n: 16,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same' as const,
      profileId: 'equal-inorder',
    }
    const a = runComparison({ ...base, customSource: 'hidden editor A' })
    const b = runComparison({ ...base, customSource: 'hidden editor B' })
    expect(a.rerunInput).not.toHaveProperty('customSource')
    expect(a.rerunInput).not.toHaveProperty('effectiveSource')
    expect(a.inputFingerprint).toBe(b.inputFingerprint)
  })

  it('stable serialization and fingerprints ignore object key insertion order', () => {
    const a = { z: [3, { b: 2, a: 1 }], a: 'x' }
    const b = { a: 'x', z: [3, { a: 1, b: 2 }] }
    expect(stableSerialize(a)).toBe(stableSerialize(b))
    expect(fingerprint(a)).toBe(fingerprint(b))
    expect(fingerprint(a)).toMatch(/^fnv1a32:[0-9a-f]{8}$/)
  })

  it('throws when a compiled ISA disagrees with gold', () => {
    expect(() =>
      runComparison({
        workloadId: 'custom',
        n: 1,
        seed: 1,
        isas: [IsaId.RISCV],
        hardwareMode: 'same',
        profileId: 'equal-inorder',
        customSource: 'br missing\nhalt r0',
      }),
    ).toThrow()
  })

  it('streams progress callbacks and agrees with the sync path', async () => {
    const input = {
      workloadId: 'checksum' as const,
      n: 24,
      seed: 2,
      isas: [IsaId.RISCV],
      hardwareMode: 'same' as const,
      profileId: 'equal-inorder',
    }
    const phases: string[] = []
    const asyncResult = await runComparisonAsync(input, (p) => {
      phases.push(p.phase)
      expect(p.ratio).toBeGreaterThanOrEqual(0)
      expect(p.ratio).toBeLessThanOrEqual(1)
    })
    const sync = runComparison(input)
    expect(asyncResult).toEqual(sync)
    expect(phases[0]).toBe('LINK')
    expect(phases).toContain('REFERENCE')
    expect(phases.at(-1)).toBe('MATCH')
  })
})
