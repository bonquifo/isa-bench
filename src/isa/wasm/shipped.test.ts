import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { C_EXAMPLES } from '../../engine/c/programs.ts'
import { WASM_FIXTURE_DIR } from './fixtures.node.ts'
import { loadWasm } from './load.ts'
import { shippedPrograms, unshippedProgramIds } from './shipped.ts'

describe('the precompiled WebAssembly modules the app ships', () => {
  const programs = shippedPrograms()

  it('covers every program the app offers', () => {
    // The import list in shipped.ts is written out by hand, because a
    // bundler has to see each import statically. This is what notices
    // when the corpus gains a program and the list does not.
    expect(unshippedProgramIds()).toEqual([])
    expect(programs).toHaveLength(C_EXAMPLES.length)
    expect(programs.map((p) => p.id).sort()).toEqual(C_EXAMPLES.map((e) => e.id).sort())
  })

  it('points each program at its own module', () => {
    const urls = programs.map((program) => program.url)
    expect(new Set(urls).size).toBe(urls.length)
    for (const program of programs) {
      expect(program.url).toContain(`corpus-${program.id}.wasm`)
      expect(program.example.id).toBe(program.id)
    }
  })

  it('ships the bytes the conformance suite verified, not a rebuild', () => {
    for (const program of programs) {
      const verified = new Uint8Array(
        readFileSync(join(WASM_FIXTURE_DIR, `corpus-${program.id}.wasm`)),
      )
      expect([...verified.slice(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d])
      expect(verified.length).toBeGreaterThan(1024)
      // And it must load: the entry point is resolved from the module's
      // own exports rather than from a header field, so a module that
      // exported nothing would be a file the app could not start.
      const loaded = loadWasm(verified)
      expect(loaded.entryFunction).toBeGreaterThanOrEqual(0)
      expect(loaded.image.codeBytes).toBeGreaterThan(0)
    }
  })

  it('stays smaller than the statically linked targets', () => {
    // Measured, not assumed: 234 KiB for the fourteen here against 347
    // for RISC-V and 413 for MIPS. Asserted because a regression would
    // mean the linker had stopped eliminating what the programs never
    // call, and the size is the only place that would show.
    const total = programs.reduce((sum, program) =>
      sum + readFileSync(join(WASM_FIXTURE_DIR, `corpus-${program.id}.wasm`)).length, 0)
    expect(total).toBeGreaterThan(150_000)
    expect(total).toBeLessThan(300_000)
  })
})
