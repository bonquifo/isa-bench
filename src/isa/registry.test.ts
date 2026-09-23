import { describe, expect, it } from 'vitest'
import { ALL_ISAS, IsaId } from '../engine/types.ts'
import { backendFor, hasRealBackend, realBackends } from './registry.ts'
import { rv64Backend } from './riscv/backend.ts'

describe('real-ISA registry', () => {
  it('resolves a registered target to its backend', () => {
    expect(backendFor(IsaId.RISCV)).toBe(rv64Backend)
    expect(hasRealBackend(IsaId.RISCV)).toBe(true)
  })

  it('has a real backend for every target the app offers', () => {
    // None remain. Asserted as an equality rather than a count so that
    // removing one is as deliberate an act as adding one was.
    const pending = ALL_ISAS.filter((isa) => !hasRealBackend(isa))
    expect(pending).toEqual([])
    expect(realBackends()).toHaveLength(ALL_ISAS.length)
  })

  it('names the one target that is not an ELF target', () => {
    const notElf = realBackends().filter((backend) => backend.elfMachine === 0)
    expect(notElf.map((backend) => backend.id)).toEqual([IsaId.WASM])
  })

  it('registers each target at most once', () => {
    const ids = realBackends().map((backend) => backend.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has every backend declare a coherent contract', () => {
    for (const backend of realBackends()) {
      expect(ALL_ISAS).toContain(backend.id)
      expect(backend.name.length).toBeGreaterThan(0)
      // An ELF machine, or zero for a target whose container is not ELF.
      // WebAssembly is the only one: a module is its own format, there is
      // no registered `e_machine` to give, and inventing one would mean
      // claiming the loader accepts something it cannot read.
      expect(backend.elfMachine).toBeGreaterThanOrEqual(0)
      if (backend.id !== IsaId.WASM) expect(backend.elfMachine).toBeGreaterThan(0)
      expect(backend.gprCount).toBeGreaterThan(0)
      // Register naming must cover at least the general-purpose file.
      expect(backend.naming.count).toBeGreaterThanOrEqual(backend.gprCount)
      for (let r = 0; r < backend.gprCount; r++) {
        expect(backend.naming.name(r).length).toBeGreaterThan(0)
      }
    }
  })
})
