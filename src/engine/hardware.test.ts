import { describe, expect, it } from 'vitest'
import { energyOf } from './energy.ts'
import {
  chipDefaults,
  DEFAULT_PROFILE_ID,
  HARDWARE_PROFILES,
  isaTiming,
  normalizeHw,
  overlayCustom,
  profileById,
} from './hardware.ts'
import { ALL_ISAS, IsaId, type InstClass } from './types.ts'

const emptyMix = (): Record<InstClass, number> => ({
  alu: 0,
  mul: 0,
  div: 0,
  ld: 0,
  st: 0,
  br: 0,
  fp: 0,
  mov: 0,
  nop: 0,
})

describe('chip topology defaults', () => {
  it('sizes L3 as min(128 MiB, max(2 MiB, 2 MiB × cores))', () => {
    expect(chipDefaults(1, 1).l3.sizeBytes).toBe(2 * 1048576)
    expect(chipDefaults(8, 8).l3.sizeBytes).toBe(16 * 1048576)
    expect(chipDefaults(96, 192).l3.sizeBytes).toBe(134217728)
  })

  it('scales DRAM channels with core count', () => {
    expect(chipDefaults(1, 1).memChannels).toBe(2)
    expect(chipDefaults(6, 6).memChannels).toBe(4)
    expect(chipDefaults(16, 32).memChannels).toBe(8)
  })

  it('fully resolves deterministic DRAM and coherence timing defaults', () => {
    const profile = profileById('equal-quad')
    expect(profile.dramIssueInterval).toBe(1)
    expect(profile.coherenceLatency).toBe(8)
    expect(() => overlayCustom(profile, { dramIssueInterval: 0 })).toThrow(/issue interval/)
    expect(() => overlayCustom(profile, { coherenceLatency: -1 })).toThrow(/Coherence latency/)
  })

  it('never lets threads fall below cores', () => {
    const d = chipDefaults(8, 2)
    expect(d.cores).toBe(8)
    expect(d.threads).toBe(8)
  })
})

describe('hardware profiles', () => {
  it('lists the six equal-silicon machines and resolves the default', () => {
    expect(HARDWARE_PROFILES.map((p) => p.id)).toEqual([
      'equal-inorder',
      'dual-issue',
      'wide',
      'equal-quad',
      'equal-smt',
      'embedded',
    ])
    expect(DEFAULT_PROFILE_ID).toBe('equal-inorder')
    expect(profileById('equal-inorder').issueWidth).toBe(1)
    expect(profileById('dual-issue').issueWidth).toBe(2)
    expect(profileById('wide').issueWidth).toBe(4)
    expect(profileById('equal-quad').cores).toBe(4)
    expect(profileById('equal-smt').threads).toBe(8)
    expect(profileById('embedded').clockMhz).toBe(400)
    expect(profileById('embedded').predictor).toBe('static')
  })

  it('rejects an unknown profile id', () => {
    expect(() => profileById('no-such-core')).toThrow(/Unknown hardware profile/)
  })

  it('overlays custom knobs without losing nested cache fields', () => {
    const base = profileById('equal-inorder')
    const hw = overlayCustom(base, {
      clockMhz: 1234,
      name: 'lab',
      l1d: { sizeBytes: 8192, ways: 4, lineBytes: 64 },
      cores: 2,
      threads: 2,
    })
    expect(hw.id).toBe('custom')
    expect(hw.name).toBe('lab')
    expect(hw.clockMhz).toBe(1234)
    expect(hw.l1d.sizeBytes).toBe(8192)
    expect(hw.l1d.ways).toBe(base.l1d.ways)
    expect(hw.l1i.sizeBytes).toBe(base.l1i.sizeBytes)
    expect(hw.cores).toBe(2)
  })

  it('rejects malformed topology instead of silently clamping it', () => {
    const malformed = {
      ...profileById('equal-inorder'),
      cores: 0,
      threads: 0,
    }
    expect(() => normalizeHw(malformed)).toThrow(/Cores must be a positive integer/)
    expect(() => normalizeHw({ ...profileById('equal-inorder'), cores: 2, threads: 1 }))
      .toThrow(/threads must be greater than or equal to cores/i)
  })

  it('rejects unequal configured cache-line domains and accepts tiny valid caches', () => {
    const base = profileById('equal-inorder')
    expect(() => normalizeHw({
      ...base,
      l1d: { ...base.l1d, lineBytes: 32 },
    })).toThrow(/canonical line size/)
    expect(() => normalizeHw({
      ...base,
      l1i: { sizeBytes: 0, ways: 1, lineBytes: 32 },
      l1d: { sizeBytes: 0, ways: 1, lineBytes: 32 },
      l2: { ...base.l2, lineBytes: 64 },
      l3: { ...base.l3, lineBytes: 64 },
    })).toThrow(/canonical line size/)
    expect(normalizeHw({
      ...base,
      l1i: { sizeBytes: 64, ways: 1, lineBytes: 64 },
      l1d: { sizeBytes: 64, ways: 1, lineBytes: 64 },
      l2: { sizeBytes: 0, ways: 1, lineBytes: 64 },
      l3: { sizeBytes: 0, ways: 1, lineBytes: 64 },
    }).l1d.sizeBytes).toBe(64)
  })

  it('validates every deterministic hardware field', () => {
    const base = profileById('equal-inorder')
    const bad = (patch: Partial<typeof base>, pattern: RegExp) => {
      expect(() => normalizeHw({ ...base, ...patch })).toThrow(pattern)
    }
    bad({ clockMhz: Number.NaN }, /Clock MHz/)
    bad({ fetchWidth: 0 }, /Fetch width/)
    bad({ issueWidth: 1.5 }, /Issue width/)
    bad({ pipelineStages: 0 }, /Pipeline stages/)
    bad({ aluCount: 0 }, /ALU count/)
    bad({ memPorts: 0 }, /Memory ports/)
    bad({ predEntries: 0 }, /Predictor entries/)
    bad({ complexDecodeBytes: 0 }, /Complex decode bytes/)
    bad({ memChannels: 0 }, /Memory channels/)
    bad({ dramIssueInterval: 0 }, /DRAM issue interval/)
    bad({ memLatency: -1 }, /Memory latency/)
    bad({ mispredictPenalty: -1 }, /Mispredict penalty/)
    bad({ indirectCallPenalty: -1 }, /Indirect call penalty/)
    bad({ rasDepth: -1 }, /RAS depth/)
    bad({ loadLatency: -1 }, /Load latency/)
    bad({ l2Latency: -1 }, /L2 latency/)
    bad({ coherenceLatency: -1 }, /Coherence latency/)
    bad({ staticPowerMw: Number.POSITIVE_INFINITY }, /Static power/)
    bad({ l1d: { sizeBytes: 63, ways: 1, lineBytes: 64 } }, /multiple/)
    bad({ l1d: { sizeBytes: -1, ways: 1, lineBytes: 64 } }, /L1D size/)
    bad({ l1d: { sizeBytes: 64, ways: 1, lineBytes: 4294967297 } }, /safe power of two/)
    bad({ l1d: { sizeBytes: 4294967297, ways: 1, lineBytes: 64 } }, /capacity exceeds/)
    bad({ l1d: { sizeBytes: 64, ways: 5000, lineBytes: 64 } }, /associativity exceeds/)
    bad({ predEntries: 4294967297 }, /safe power of two/)
  })

  it.each([
    ['mulLatency', 'Multiply latency'],
    ['divLatency', 'Divide latency'],
    ['fpAddLatency', 'FP add latency'],
    ['fpMulLatency', 'FP multiply latency'],
    ['fpDivLatency', 'FP divide latency'],
    ['loadLatency', 'Load latency'],
  ] as const)('requires %s to be positive while accepting latency one', (field, label) => {
    const base = profileById('equal-inorder')
    expect(() => normalizeHw({ ...base, [field]: 0 })).toThrow(new RegExp(label))
    expect(normalizeHw({ ...base, [field]: 1 })[field]).toBe(1)
  })
})

describe('ISA timing / energy multipliers', () => {
  it('charges MIPS a one-cycle load delay and SPARC a branch delay', () => {
    expect(isaTiming(IsaId.MIPS).loadDelay).toBe(1)
    expect(isaTiming(IsaId.SPARC).branchDelay).toBe(1)
    for (const isa of ALL_ISAS) {
      if (isa === IsaId.MIPS) continue
      expect(isaTiming(isa).loadDelay, isa).toBe(0)
    }
    for (const isa of ALL_ISAS) {
      if (isa === IsaId.SPARC) continue
      expect(isaTiming(isa).branchDelay, isa).toBe(0)
    }
  })

  it('ranks decode energy MOS < RISC-V = MIPS = SPARC < ARM < POWER < WASM < x86', () => {
    const e = (isa: typeof ALL_ISAS[number]) => isaTiming(isa).decodeEnergy
    expect(e(IsaId.MOS)).toBeLessThan(e(IsaId.RISCV))
    expect(e(IsaId.RISCV)).toBe(1)
    expect(e(IsaId.MIPS)).toBe(1)
    expect(e(IsaId.SPARC)).toBe(1)
    expect(e(IsaId.ARM)).toBeGreaterThan(e(IsaId.RISCV))
    expect(e(IsaId.POWER)).toBeGreaterThan(e(IsaId.ARM))
    expect(e(IsaId.WASM)).toBeGreaterThan(e(IsaId.POWER))
    expect(e(IsaId.X86)).toBeGreaterThan(e(IsaId.WASM))
  })
})

describe('energy model', () => {
  it('static energy is mW × µs = nJ', () => {
    const mix = emptyMix()
    const out = energyOf({
      isa: IsaId.RISCV,
      mix,
      instructions: 0,
      icMisses: 0,
      dcMisses: 0,
      mispredicts: 0,
      codeBytes: 0,
      timeUs: 2,
      staticPowerMw: 350,
    })
    expect(out.dynamicEnergyNj).toBe(0)
    expect(out.staticEnergyNj).toBe(700)
    expect(out.totalEnergyNj).toBe(700)
  })

  it('integrates per-core active, stalled, and idle cycle residency', () => {
    const out = energyOf({
      isa: IsaId.RISCV,
      mix: emptyMix(),
      mispredicts: 0,
      timeUs: 1,
      staticPowerMw: 100,
      clockMhz: 10,
      activeCoreCycles: 10,
      stalledCoreCycles: 20,
      idleCoreCycles: 30,
    })
    expect(out.staticEnergyNj).toBe(100 * (10 + 0.65 * 20 + 0.4 * 30) / 10)
  })

  it('applies ISA decode factor only to operation/decode energy', () => {
    const mix = emptyMix()
    mix.alu = 10
    mix.ld = 4
    const rv = energyOf({
      isa: IsaId.RISCV,
      mix,
      instructions: 14,
      decodedBytes: 100,
      icLineAccesses: 1,
      dcLineAccesses: 2,
      dramRequests: 3,
      mispredicts: 3,
      codeBytes: 100,
      timeUs: 0,
      staticPowerMw: 0,
    })
    const x86 = energyOf({
      isa: IsaId.X86,
      mix,
      instructions: 14,
      decodedBytes: 100,
      icLineAccesses: 1,
      dcLineAccesses: 2,
      dramRequests: 3,
      mispredicts: 3,
      codeBytes: 100,
      timeUs: 0,
      staticPowerMw: 0,
    })
    const opDecode = 10 * 0.8 + 4 * 2.4 + 100 * 0.04
    const nonDecode = 3 * 0.08 + 3 * 180 + 3 * 22
    expect(rv.dynamicEnergyNj).toBeCloseTo(opDecode + nonDecode, 8)
    expect(x86.dynamicEnergyNj).toBeCloseTo(opDecode * 1.55 + nonDecode, 8)
    expect(rv.nominalModelEnergyNj).toBe(
      rv.operationDecodeEnergyNj + rv.cacheEnergyNj +
      rv.memoryCoherenceEnergyNj + rv.recoveryEnergyNj + rv.staticEnergyNj
    )
    expect(rv.totalEnergyNj).toBe(rv.nominalModelEnergyNj)
    expect(rv.edp).toBe(rv.modeledEdpNjUs)
    expect(rv.energyModelClass).toBe('uncalibrated-event-model')
    expect(rv.energyUncertainty).toBe('not-quantified')
  })
})
