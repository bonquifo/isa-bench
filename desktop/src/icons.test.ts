import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The icon has one source, desktop/icon.svg; the PNGs the installers and the
 * window use are rendered from it. This fails when someone edits one and not
 * the other, rather than letting the app ship two icons again.
 */
describe('the app icon', () => {
  it('is rendered from its source, and the committed rasters are current', () => {
    const root = resolve(import.meta.dirname, '../..')
    expect(() => execFileSync(process.execPath, ['scripts/icons.mjs', '--check'], { cwd: root, stdio: 'pipe' }))
      .not.toThrow()
  })
})
