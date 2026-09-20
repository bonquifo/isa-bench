import { describe, expect, it } from 'vitest'
import {
  CPU_CATALOG,
  DEFAULT_CPU_ID,
  assertCpuCatalog,
  cpuById,
  cpuSupportsIsa,
  cpusForIsa,
  defaultCpuByIsa,
  groupCpus,
} from './cpus.ts'
import { x86Chip } from './cpus_topo.ts'
import { X86_MODELS, X86_UARCH } from './cpus_x86.ts'
import { ALL_ISAS, IsaId } from './types.ts'

describe('CPU catalog', () => {
  it('passes the built-in catalog invariants', () => {
    expect(() => assertCpuCatalog()).not.toThrow()
  })

  it('looks up models and rejects unknown ids', () => {
    expect(cpuById('sifive-u74').isa).toBe('riscv')
    expect(() => cpuById('no-such-sku')).toThrow(/Unknown CPU/)
  })

  it('never claims a core can execute a foreign ISA', () => {
    for (const cpu of CPU_CATALOG) {
      expect(cpuSupportsIsa(cpu, cpu.isa)).toBe(true)
      for (const isa of ALL_ISAS) {
        if (isa !== cpu.isa) expect(cpuSupportsIsa(cpu, isa)).toBe(false)
      }
    }
  })

  it('returns a copy of the default map', () => {
    const a = defaultCpuByIsa()
    a.riscv = 'mutated'
    expect(DEFAULT_CPU_ID.riscv).toBe('sifive-u74')
    expect(defaultCpuByIsa().riscv).toBe('sifive-u74')
  })

  it('groups catalog entries by the group label, preserving order', () => {
    const list = cpusForIsa(IsaId.RISCV)
    const groups = groupCpus(list)
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.every((g) => g.group && g.items.length > 0)).toBe(true)
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(list.length)
    const flat = groupCpus(list.map((c) => ({ ...c, group: undefined })))
    expect(flat).toHaveLength(1)
    expect(flat[0].items).toHaveLength(list.length)
  })

  it('gives every x86 model a µarch and a topology with threads ≥ cores', () => {
    for (const m of X86_MODELS) {
      expect(X86_UARCH[m.uarch], m.id).toBeTruthy()
      const chip = x86Chip(m.id)
      expect(chip.cores).toBeGreaterThanOrEqual(1)
      expect(chip.threads).toBeGreaterThanOrEqual(chip.cores)
    }
    expect(() => x86Chip('not-a-chip')).toThrow(/Missing x86 topology/)
  })

  it('records historically correct core/thread counts for well-known SKUs', () => {
    expect(x86Chip('i7-2600k')).toEqual({ cores: 4, threads: 8 })
    expect(x86Chip('r9-7950x')).toEqual({ cores: 16, threads: 32 })
    expect(x86Chip('epyc-9654')).toEqual({ cores: 96, threads: 192 })
    expect(cpuById('power9').profile.threads).toBe(96)
    expect(cpuById('niagara-t1').profile.threads).toBe(32)
    expect(cpuById('mos-6502').profile.cores).toBe(1)
  })

  it('keeps every profile’s issue width, clock, and caches legal', () => {
    for (const cpu of CPU_CATALOG) {
      expect(cpu.profile.issueWidth, cpu.id).toBeGreaterThanOrEqual(1)
      expect(cpu.profile.clockMhz, cpu.id).toBeGreaterThanOrEqual(1)
      expect(cpu.profile.l1d.lineBytes, cpu.id).toBeGreaterThan(0)
      expect(cpu.year, cpu.id).toBeGreaterThan(1970)
      expect(cpu.vendor.length, cpu.id).toBeGreaterThan(0)
    }
  })
})
