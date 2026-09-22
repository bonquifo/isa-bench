import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { C_EXAMPLES } from '../../engine/c/programs.ts'
import { MOS_FIXTURE_DIR } from './fixtures.node.ts'
import { loadMos } from './load.ts'
import { shippedPrograms, unshippedProgramIds } from './shipped.ts'

describe('the precompiled MOS 6502 images the app ships', () => {
  const programs = shippedPrograms()

  it('ships every corpus program the machine can hold, and names the one it cannot', () => {
    // The other targets assert this list is empty. Here it is not, and
    // the difference is the point: a 16-bit `int` makes one program's own
    // assertion about its struct size false, so the compiler refuses it.
    // Asserting the exact contents is what stops a second program going
    // missing later without anyone noticing.
    expect(unshippedProgramIds()).toEqual(['struct'])
    expect(programs).toHaveLength(C_EXAMPLES.length - 1)
  })

  it('points each program at its own image', () => {
    const urls = programs.map((program) => program.url)
    expect(new Set(urls).size).toBe(urls.length)
    for (const program of programs) {
      expect(program.url).toContain(`corpus-${program.id}.bin`)
      expect(program.example.id).toBe(program.id)
    }
  })

  it('ships the bytes the corpus tier verified, not a rebuild', () => {
    for (const program of programs) {
      const verified = new Uint8Array(
        readFileSync(join(MOS_FIXTURE_DIR, `corpus-${program.id}.bin`)),
      )
      // The image is what the simulator ran, so the check is that it
      // loads: the first chunk's length must account for the file, and
      // the reset vector must point somewhere real.
      const { interpreter } = loadMos(verified)
      expect(interpreter.programCounter).toBeGreaterThanOrEqual(0x200n)
      expect(interpreter.programCounter).toBeLessThan(0x10000n)
      expect(verified.length).toBeGreaterThan(256)
    }
  })
})
