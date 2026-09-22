import { describe, expect, it } from 'vitest'
import { ALL_ISAS, IsaId } from '../engine/types.ts'
import { backendFor, hasRealBackend, realBackends } from './registry.ts'
import { rv64Backend } from './riscv/backend.ts'

describe('real-ISA registry', () => {
  it('resolves a registered target to its backend', () => {
    expect(backendFor(IsaId.RISCV)).toBe(rv64Backend)
    expect(hasRealBackend(IsaId.RISCV)).toBe(true)
  })

  it('reports the targets that still run a pseudo-backend', () => {
    const pending = ALL_ISAS.filter((isa) => !hasRealBackend(isa))
    // Two remain. This number is expected to fall; it is asserted so that
    // adding a backend is a deliberate act that updates the count here.
    expect(pending).toHaveLength(2)
    expect(pending).not.toContain(IsaId.RISCV)
    expect(pending).not.toContain(IsaId.ARM)
    expect(pending).not.toContain(IsaId.X86)
    expect(pending).not.toContain(IsaId.MIPS)
    expect(pending).not.toContain(IsaId.MOS)
    expect(pending).not.toContain(IsaId.SPARC)
    for (const isa of pending) expect(backendFor(isa)).toBeUndefined()
  })

  it('registers each target at most once', () => {
    const ids = realBackends().map((backend) => backend.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has every backend declare a coherent contract', () => {
    for (const backend of realBackends()) {
      expect(ALL_ISAS).toContain(backend.id)
      expect(backend.name.length).toBeGreaterThan(0)
      expect(backend.elfMachine).toBeGreaterThan(0)
      expect(backend.gprCount).toBeGreaterThan(0)
      // Register naming must cover at least the general-purpose file.
      expect(backend.naming.count).toBeGreaterThanOrEqual(backend.gprCount)
      for (let r = 0; r < backend.gprCount; r++) {
        expect(backend.naming.name(r).length).toBeGreaterThan(0)
      }
    }
  })
})
