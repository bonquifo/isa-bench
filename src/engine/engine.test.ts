import { describe, expect, it } from 'vitest'
import { runComparison } from './compare.ts'
import { CPU_CATALOG, DEFAULT_CPU_ID, cpuById, cpusForIsa } from './cpus.ts'
import { x86Chip } from './cpus_topo.ts'
import { X86_MODELS } from './cpus_x86.ts'
import { parseIr, SAMPLE_IR } from './ir.ts'
import { ALL_ISAS, IsaId } from './types.ts'
import { WORKLOADS } from './workloads.ts'

const smallN: Record<string, number> = {
  int_sum: 40,
  dot_product: 24,
  saxpy: 20,
  memcpy: 20,
  matmul: 4,
  insertion_sort: 10,
  binary_search: 12,
  sieve: 40,
  checksum: 64,
  pointer_chase: 16,
  fir: 12,
  fp_sum: 16,
}

describe('ISA Bench engine', () => {
  it('parses and runs the sample IR on every ISA', () => {
    const parsed = parseIr(SAMPLE_IR)
    expect(parsed.insts.some((i) => i.kind === 'halt')).toBe(true)
    const result = runComparison({
      workloadId: 'custom',
      n: 256,
      seed: 1,
      isas: ALL_ISAS,
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: SAMPLE_IR,
    })
    expect(result.gold).toBe(32640)
    expect(result.rows).toHaveLength(ALL_ISAS.length)
    for (const row of result.rows) {
      expect(row.matchedGold).toBe(true)
      expect(row.cycles).toBeGreaterThan(0)
      expect(row.instructions).toBeGreaterThan(0)
    }
  })

  it('matches the IR reference on every built-in workload', () => {
    for (const w of WORKLOADS) {
      const result = runComparison({
        workloadId: w.id,
        n: smallN[w.id] ?? w.defaultN,
        seed: 42,
        isas: ALL_ISAS,
        hardwareMode: 'same',
        profileId: 'equal-inorder',
      })
      expect(result.rows).toHaveLength(ALL_ISAS.length)
      for (const row of result.rows) {
        expect(row.matchedGold, `${w.id} ${row.isa}`).toBe(true)
        expect(row.cycles).toBeGreaterThan(0)
      }
    }
  })

  it('matches every parallel built-in on four padded-slot cores', () => {
    for (const w of WORKLOADS.filter((item) => item.parallelSemantics === 'spmd-striped')) {
      const result = runComparison({
        workloadId: w.id,
        n: smallN[w.id] ?? w.minN,
        seed: 42,
        isas: [IsaId.RISCV],
        hardwareMode: 'same',
        profileId: 'equal-quad',
      })
      expect(result.rows[0].matchedGold, w.id).toBe(true)
      expect(result.rows[0].activeThreads, w.id).toBeGreaterThan(1)
    }
  })

  it('is deterministic', () => {
    const input = {
      workloadId: 'dot_product',
      n: 32,
      seed: 7,
      isas: [IsaId.RISCV, IsaId.X86],
      hardwareMode: 'same' as const,
      profileId: 'equal-inorder',
    }
    const a = runComparison(input)
    const b = runComparison(input)
    expect(a.rows[0].cycles).toBe(b.rows[0].cycles)
    expect(a.rows[1].instructions).toBe(b.rows[1].instructions)
    expect(a.gold).toBe(b.gold)
  })

  it('gives RISC-V more instructions than ARM/x86 on indexed loads', () => {
    const result = runComparison({
      workloadId: 'dot_product',
      n: 32,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.ARM, IsaId.X86],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    const rv = result.rows.find((r) => r.isa === 'riscv')!
    const arm = result.rows.find((r) => r.isa === 'arm')!
    const x86 = result.rows.find((r) => r.isa === 'x86')!
    expect(rv.instructions).toBeGreaterThan(arm.instructions)
    expect(rv.instructions).toBeGreaterThan(x86.instructions)
  })

  it('illustrative associated presets resolve independently per target', () => {
    const result = runComparison({
      workloadId: 'int_sum',
      n: 32,
      seed: 1,
      isas: ALL_ISAS,
      hardwareMode: 'cpus',
      profileId: 'equal-inorder',
    })
    const ids = new Set(result.rows.map((r) => r.hardwareId))
    expect(ids.size).toBe(ALL_ISAS.length)
    for (const row of result.rows) {
      const cpu = cpuById(DEFAULT_CPU_ID[row.isa])
      expect(cpu.isa).toBe(row.isa)
      expect(row.hardwareId).toBe(cpu.profile.id)
      expect(row.matchedGold).toBe(true)
    }
  })

  it('rejects a CPU on the wrong ISA', () => {
    expect(() =>
      runComparison({
        workloadId: 'int_sum',
        n: 16,
        seed: 1,
        isas: [IsaId.RISCV],
        hardwareMode: 'cpus',
        profileId: 'equal-inorder',
        cpuByIsa: { riscv: 'r9-7950x' },
      }),
    ).toThrow(/cannot be used for RISC-V/)
  })

  it('x86 catalog covers desktop, HEDT, Xeon, and EPYC', () => {
    const x86 = cpusForIsa('x86')
    expect(x86.length).toBeGreaterThan(250)
    expect(x86.every((c) => c.isa === 'x86')).toBe(true)
    expect(x86.every((c) => c.vendor === 'Intel' || c.vendor === 'AMD')).toBe(true)
    const ids = x86.map((c) => c.id)
    expect(ids).toContain('i9-14900k')
    expect(ids).toContain('r7-7800x3d')
    expect(ids).toContain('r9-7950x')
    expect(ids).toContain('tr-3990x')
    expect(ids).toContain('i7-2600k')
    expect(ids).toContain('xeon-e5-2670')
    expect(ids).toContain('xeon-platinum-8380')
    expect(ids).toContain('xeon-platinum-8592p')
    expect(ids).toContain('epyc-7601')
    expect(ids).toContain('epyc-7763')
    expect(ids).toContain('epyc-9654')
    expect(ids).toContain('epyc-9755')
    expect(ids).toContain('tr-7995wx')
    expect(new Set(ids).size).toBe(ids.length)
    expect(x86.some((c) => c.vendor === 'Intel')).toBe(true)
    expect(x86.some((c) => c.vendor === 'AMD')).toBe(true)
  })

  it('every ISA catalog lists multiple named silicon families', () => {
    const min = { riscv: 30, arm: 40, x86: 250, mips: 25, power: 25, sparc: 25, wasm: 12, mos: 15 }
    for (const isa of ALL_ISAS) {
      const list = cpusForIsa(isa)
      expect(list.length, isa).toBeGreaterThanOrEqual(min[isa])
      expect(list.every((c) => c.group)).toBe(true)
    }
  })

  it('catalog covers every ISA and never cross-lists a core', () => {
    for (const isa of ALL_ISAS) {
      const list = cpusForIsa(isa)
      expect(list.length, isa).toBeGreaterThan(0)
      expect(list.some((c) => c.id === DEFAULT_CPU_ID[isa])).toBe(true)
      for (const cpu of list) expect(cpu.isa).toBe(isa)
    }
    const ids = CPU_CATALOG.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every illustrative catalog preset matches the reference on its associated target', { timeout: 120_000 }, () => {
    for (const cpu of CPU_CATALOG) {
      const result = runComparison({
        workloadId: 'int_sum',
        n: 16,
        seed: 1,
        isas: [cpu.isa],
        hardwareMode: 'cpus',
        profileId: 'equal-inorder',
        cpuByIsa: { [cpu.isa]: cpu.id },
      })
      expect(result.rows[0].matchedGold, cpu.id).toBe(true)
      expect(result.rows[0].hardwareId).toBe(cpu.profile.id)
    }
  })

  it('rejects programs without halt', () => {
    expect(() => parseIr('imm r0, 1\nadd r0, r0, r0')).toThrow(/halt/)
  })

  it('runs every equal-hardware profile', () => {
    for (const profileId of ['equal-inorder', 'dual-issue', 'wide', 'embedded', 'equal-quad', 'equal-smt']) {
      const result = runComparison({
        workloadId: 'checksum',
        n: 48,
        seed: 3,
        isas: ALL_ISAS,
        hardwareMode: 'same',
        profileId,
      })
      expect(result.rows.every((r) => r.matchedGold)).toBe(true)
    }
  })

  it('every catalog CPU has a legal chip topology', () => {
    for (const cpu of CPU_CATALOG) {
      expect(cpu.profile.cores, cpu.id).toBeGreaterThanOrEqual(1)
      expect(cpu.profile.threads, cpu.id).toBeGreaterThanOrEqual(cpu.profile.cores)
    }
    for (const m of X86_MODELS) {
      const chip = x86Chip(m.id)
      expect(chip.cores).toBeGreaterThanOrEqual(1)
      expect(chip.threads).toBeGreaterThanOrEqual(chip.cores)
    }
    expect(cpuById('r9-7950x').profile.cores).toBe(16)
    expect(cpuById('r9-7950x').profile.threads).toBe(32)
    expect(cpuById('i7-2600k').profile.threads).toBe(8)
    expect(cpuById('epyc-9654').profile.cores).toBe(96)
    expect(cpuById('power9').profile.threads).toBe(96)
    expect(cpuById('niagara-t1').profile.threads).toBe(32)
  })

  it('parallel reduce is faster on more cores and still matches gold', () => {
    const input = {
      workloadId: 'int_sum',
      n: 80,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same' as const,
      profileId: 'equal-inorder',
    }
    const one = runComparison({ ...input, customHw: { cores: 1, threads: 1, name: '1c' } })
    const quad = runComparison({ ...input, customHw: { cores: 4, threads: 4, name: '4c' } })
    expect(one.rows[0].matchedGold).toBe(true)
    expect(quad.rows[0].matchedGold).toBe(true)
    expect(one.rows[0].activeThreads).toBe(1)
    expect(quad.rows[0].activeThreads).toBe(4)
    expect(quad.rows[0].busyCores).toBe(4)
    expect(quad.rows[0].cycles).toBeLessThan(one.rows[0].cycles)
    expect(one.gold).toBe(quad.gold)
  })

  it('SMT siblings share a core issue budget', () => {
    const input = {
      workloadId: 'int_sum',
      n: 120,
      seed: 2,
      isas: [IsaId.RISCV],
      hardwareMode: 'same' as const,
      profileId: 'equal-inorder',
    }
    const smt = runComparison({
      ...input,
      customHw: { cores: 1, threads: 2, name: 'smt' },
    })
    const pair = runComparison({
      ...input,
      customHw: { cores: 2, threads: 2, name: 'pair' },
    })
    expect(smt.rows[0].matchedGold).toBe(true)
    expect(pair.rows[0].matchedGold).toBe(true)
    expect(smt.rows[0].activeThreads).toBe(2)
    expect(pair.rows[0].activeThreads).toBe(2)
    expect(smt.rows[0].busyCores).toBe(1)
    expect(pair.rows[0].busyCores).toBe(2)
    expect(pair.rows[0].cycles).toBeLessThan(smt.rows[0].cycles)
  })

  it('serial kernels ignore extra cores for the result and the live width', () => {
    const input = {
      workloadId: 'insertion_sort',
      n: 12,
      seed: 3,
      isas: [IsaId.RISCV],
      hardwareMode: 'same' as const,
      profileId: 'equal-inorder',
    }
    const one = runComparison({ ...input, customHw: { cores: 1, threads: 1, name: '1c' } })
    const quad = runComparison({ ...input, customHw: { cores: 4, threads: 8, name: '4c8t' } })
    expect(quad.rows[0].matchedGold).toBe(true)
    expect(quad.rows[0].activeThreads).toBe(1)
    expect(quad.rows[0].result).toBe(one.rows[0].result)
    expect(quad.rows[0].cycles).toBe(one.rows[0].cycles)
  })
})
