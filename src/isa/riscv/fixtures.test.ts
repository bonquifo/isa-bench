import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readDumpBytes,
  readElf,
  readIndex,
  readLockstep,
} from '../common/fixtures.node.ts'
import { rv64Backend } from './backend.ts'
import {
  RV64_FIXTURE_DIR,
  RV64_SCRATCH_BYTES,
  decodeDump,
  readDump,
} from './fixtures.node.ts'

/**
 * Integrity of the committed oracle data.
 *
 * The differential suite runs against these files rather than against a live
 * qemu, so a partial or botched regeneration would quietly weaken every test
 * that depends on them. These checks are what notice.
 */
describe('committed fixtures', () => {
  const index = readIndex(RV64_FIXTURE_DIR)

  it('records the toolchain and oracle it was generated against', () => {
    expect(index.codegen).toMatch(/codegen-min/)
    expect(index.oracle).toMatch(/qemu-user/)
    expect(index.target).toBe('riscv64-unknown-linux-gnu')
    expect(index.march).toBe('rv64gc')
    expect(index.fixtures.length).toBeGreaterThanOrEqual(12)
  })

  it('has every file each listed fixture needs', () => {
    for (const fixture of index.fixtures) {
      for (const suffix of ['elf', 'objdump.txt', 'final.bin', 'lockstep.txt']) {
        const path = join(RV64_FIXTURE_DIR, `${fixture.name}.${suffix}`)
        expect(`${fixture.name}.${suffix}: ${existsSync(path)}`).toBe(`${fixture.name}.${suffix}: true`)
      }
      expect(fixture.steps).toBeGreaterThan(0)
    }
  })

  it('keeps the generated source of every randomised fixture, and its seed', () => {
    const random = index.fixtures.filter((f) => f.name.startsWith('random-'))
    expect(random.length).toBeGreaterThan(0)
    for (const fixture of random) {
      expect(fixture.seed).toBe(Number(fixture.name.slice('random-'.length)))
      expect(existsSync(join(RV64_FIXTURE_DIR, `${fixture.name}.c`))).toBe(true)
    }
    // A failing seed must be reproducible from what is recorded.
    expect(index.randomSeeds).toEqual(random.map((f) => f.seed))
  })

  it('agrees with itself on how many steps each lockstep trace holds', () => {
    for (const fixture of index.fixtures) {
      let counted = 0
      for (const _step of readLockstep(RV64_FIXTURE_DIR, fixture.name, rv64Backend.gprCount)) {
        counted += 1
      }
      expect(`${fixture.name}: ${counted}`).toBe(`${fixture.name}: ${fixture.steps}`)
    }
  })

  it('agrees with the backend on the size of a state dump', () => {
    for (const fixture of index.fixtures) {
      expect(readDumpBytes(RV64_FIXTURE_DIR, fixture.name).length)
        .toBe(rv64Backend.dumpBytes)
    }
  })

  it('holds a dump of the declared size for every fixture', () => {
    for (const fixture of index.fixtures) {
      const dump = readDump(fixture.name)
      expect(dump.x).toHaveLength(32)
      expect(dump.f).toHaveLength(32)
      expect(dump.scratch.length).toBe(RV64_SCRATCH_BYTES)
    }
  })

  it('rejects a dump of the wrong size rather than misreading it', () => {
    expect(() => decodeDump(new Uint8Array(16))).toThrow(/expected 1552/)
  })

  it('holds real ELF images', () => {
    for (const fixture of index.fixtures) {
      const elf = readElf(RV64_FIXTURE_DIR, fixture.name)
      expect([elf[0], elf[1], elf[2], elf[3]]).toEqual([0x7f, 0x45, 0x4c, 0x46])
    }
  })
})
