import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { C_EXAMPLES } from '../../engine/c/programs.ts'
import { decodeDataUri, loadShippedElf, shippedPrograms, unshippedProgramIds } from './shipped.ts'
import { RV64_FIXTURE_DIR } from './fixtures.node.ts'

describe('the precompiled binaries the app ships', () => {
  const programs = shippedPrograms()

  it('covers every program the app offers', () => {
    // The import list in shipped.ts is written out by hand, because a bundler
    // has to see each import statically. This is what notices when the corpus
    // gains a program and the list does not.
    expect(unshippedProgramIds()).toEqual([])
    expect(programs).toHaveLength(C_EXAMPLES.length)
    expect(programs.map((p) => p.id).sort()).toEqual(C_EXAMPLES.map((e) => e.id).sort())
  })

  it('points each program at its own binary', () => {
    const urls = programs.map((program) => program.url)
    expect(new Set(urls).size).toBe(urls.length)
    for (const program of programs) {
      expect(program.url).toContain(`corpus-${program.id}.elf`)
      expect(program.example.id).toBe(program.id)
    }
  })

  it('ships the bytes the differential suite verified, not a rebuild', () => {
    // Whatever the bundler does to the URL, the file behind it must be the
    // one the conformance and corpus tiers compared against qemu.
    for (const program of programs) {
      const verified = readFileSync(join(RV64_FIXTURE_DIR, `corpus-${program.id}.elf`))
      expect([verified[0], verified[1], verified[2], verified[3]]).toEqual([0x7f, 0x45, 0x4c, 0x46])
      expect(verified.length).toBeGreaterThan(1024)
    }
  })
})

describe('reading a shipped binary', () => {
  it('decodes the data URI a production build inlines', async () => {
    const bytes = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])
    const base64 = Buffer.from(bytes).toString('base64')
    const uri = `data:application/octet-stream;base64,${base64}`
    expect([...decodeDataUri(uri)]).toEqual([...bytes])
    expect([...(await loadShippedElf(uri))]).toEqual([...bytes])
  })

  it('refuses a data URI that is not base64 rather than mangling it', () => {
    // If the bundler ever stopped base64-encoding these, silently decoding
    // the text as bytes would produce an ELF-shaped mess.
    expect(() => decodeDataUri('data:application/octet-stream,7fELF')).toThrow(/not base64/)
    expect(() => decodeDataUri('data:nonsense')).toThrow(/malformed/)
  })
})
