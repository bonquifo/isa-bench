import { describe, expect, it } from 'vitest'
import { ElfMachine, imageEnd, loadElf, parseElf } from './elf.ts'
import { GuestMemory, Prot } from './memory.ts'
import { readElf } from './fixtures.node.ts'
import { RV64_FIXTURE_DIR } from '../riscv/fixtures.node.ts'

/**
 * Exercised against a real linked binary rather than a synthetic one, with
 * mutated copies for the rejection cases. A hand-built ELF would only prove
 * the parser agrees with whatever the test author believed the format to be.
 */
const REAL = readElf(RV64_FIXTURE_DIR, 'alu')

function mutate(change: (bytes: Uint8Array, view: DataView) => void): Uint8Array {
  const copy = REAL.slice()
  change(copy, new DataView(copy.buffer))
  return copy
}

describe('parseElf on a real linked object', () => {
  it('reads the identification fields', () => {
    const image = parseElf(REAL)
    expect(image.bits).toBe(64)
    expect(image.littleEndian).toBe(true)
    expect(image.machine).toBe(ElfMachine.RISCV)
    expect(image.entry).toBeGreaterThan(0n)
  })

  it('finds the loadable segments and the symbols', () => {
    const image = parseElf(REAL)
    expect(image.segments.length).toBeGreaterThan(0)
    expect(image.segments.some((s) => (s.flags & 1) !== 0)).toBe(true)
    expect(image.symbols.has('_start')).toBe(true)
    expect(image.symbols.has('kernel')).toBe(true)
    expect(image.symbols.get('_start')!.value).toBe(image.entry)
  })

  it('names the sections', () => {
    const image = parseElf(REAL)
    const names = image.sections.map((s) => s.name)
    expect(names).toContain('.text')
    expect(names).toContain('.bss')
  })

  it('reports the end of the loaded image above every segment', () => {
    const image = parseElf(REAL)
    const end = imageEnd(image)
    for (const segment of image.segments) {
      expect(end).toBeGreaterThanOrEqual(segment.vaddr + BigInt(segment.memsz))
    }
  })
})

describe('loadElf', () => {
  it('maps every segment with the protection its flags ask for', () => {
    const image = parseElf(REAL)
    const memory = new GuestMemory(true)
    loadElf(image, REAL, memory)
    const ranges = memory.ranges()
    expect(ranges.length).toBeGreaterThan(0)
    expect(ranges.some((r) => (r.prot & Prot.EXEC) !== 0)).toBe(true)
    expect(ranges.some((r) => (r.prot & Prot.WRITE) !== 0)).toBe(true)
  })

  it('copies the text so the entry point is fetchable', () => {
    const image = parseElf(REAL)
    const memory = new GuestMemory(true)
    loadElf(image, REAL, memory)
    // Not zero: the entry point holds a real instruction.
    expect(memory.fetchHalf(image.entry)).not.toBe(0)
  })

  it('refuses to load into memory of the wrong byte order', () => {
    const image = parseElf(REAL)
    expect(() => loadElf(image, REAL, new GuestMemory(false))).toThrow(/byte order/)
  })
})

describe('parseElf refuses what it cannot load', () => {
  it('rejects a file that is not an ELF', () => {
    expect(() => parseElf(new Uint8Array(8))).toThrow(/too short/)
    expect(() => parseElf(mutate((bytes) => { bytes[1] = 0x00 }))).toThrow(/bad magic/)
  })

  it('rejects an unsupported class or data encoding', () => {
    expect(() => parseElf(mutate((bytes) => { bytes[4] = 9 }))).toThrow(/ELF class/)
    expect(() => parseElf(mutate((bytes) => { bytes[5] = 9 }))).toThrow(/data encoding/)
  })

  it('explains what to do about a position-independent executable', () => {
    // e_type at offset 16; ET_DYN is 3.
    const pie = mutate((_bytes, view) => { view.setUint16(16, 3, true) })
    expect(() => parseElf(pie)).toThrow(/position-independent/)
    expect(() => parseElf(pie)).toThrow(/-no-pie/)
  })

  it('rejects an object file, which has no segments to load', () => {
    // ET_REL is 1.
    expect(() => parseElf(mutate((_b, view) => { view.setUint16(16, 1, true) })))
      .toThrow(/expected ET_EXEC/)
  })

  it('rejects a program header table that runs past the end of the file', () => {
    // e_phnum at offset 56 on ELF64.
    expect(() => parseElf(mutate((_b, view) => { view.setUint16(56, 4000, true) })))
      .toThrow(/program header table/)
  })

  it('rejects a section header table that runs past the end of the file', () => {
    // e_shnum at offset 60 on ELF64.
    expect(() => parseElf(mutate((_b, view) => { view.setUint16(60, 4000, true) })))
      .toThrow(/section header table/)
  })

  it('rejects a segment whose contents lie past the end of the file', () => {
    const image = parseElf(REAL)
    const first = image.segments[0]!
    // p_filesz of the first PT_LOAD, found by walking to it the same way.
    const view = new DataView(REAL.buffer, REAL.byteOffset)
    const phoff = Number(view.getBigUint64(32, true))
    const phentsize = view.getUint16(54, true)
    const phnum = view.getUint16(56, true)
    let target = -1
    for (let i = 0; i < phnum; i++) {
      const at = phoff + i * phentsize
      if (view.getUint32(at, true) === 1) {
        target = at
        break
      }
    }
    expect(target).toBeGreaterThanOrEqual(0)
    expect(first.filesz).toBeGreaterThan(0)
    expect(() => parseElf(mutate((_b, v) => {
      v.setBigUint64(target + 32, 0xffffffn, true)
    }))).toThrow(/past end of file/)
  })

  it('rejects an executable with no loadable segments', () => {
    const stripped = mutate((_b, view) => {
      const phoff = Number(view.getBigUint64(32, true))
      const phentsize = view.getUint16(54, true)
      const phnum = view.getUint16(56, true)
      // PT_NULL every entry.
      for (let i = 0; i < phnum; i++) view.setUint32(phoff + i * phentsize, 0, true)
    })
    expect(() => parseElf(stripped)).toThrow(/no PT_LOAD/)
  })
})
