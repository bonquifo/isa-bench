import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The installers carry third-party software whose licenses ask for their
 * text to travel with it. This fails if packaging stops shipping the
 * notices, or if they stop covering a component the in-app compiler
 * bundles. The texts themselves come from scripts/notices.mjs.
 */
const ROOT = resolve(import.meta.dirname, '../..')

describe('licenses shipped with the app', () => {
  it('packages the project license and the third-party notices', () => {
    const build = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).build as {
      extraResources: { from: string; to: string }[]
    }
    const shipped = build.extraResources.map((entry) => `${entry.from} -> ${entry.to}`)
    expect(shipped).toContain('LICENSE -> LICENSE.txt')
    expect(shipped).toContain('THIRD-PARTY-NOTICES.txt -> THIRD-PARTY-NOTICES.txt')
  })

  it('covers every component the in-app compiler bundles', () => {
    const notices = readFileSync(resolve(ROOT, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
    for (const component of [
      'LLVM 23.1.0', 'compiler-rt', 'llvm-mos (commit c798c314)', 'llvm-mos SDK 23.0.1',
      'musl 1.2.5', 'picolibc 1.8.10', 'wasi-libc',
    ]) {
      expect(notices).toContain(component)
    }
    expect(notices).toContain('Apache License')
    expect(notices).toContain('Toby Buckmaster')
  })
})
