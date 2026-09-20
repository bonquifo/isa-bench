import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('reduced motion stylesheet', () => {
  it('stops continuous indicators and progress transitions', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../index.css'), 'utf8')
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/)?.[1] ?? ''
    for (const selector of ['.led-ok', '.flicker', '.jack-spin', '.jack-spin-rev']) {
      expect(block).toContain(selector)
    }
    expect(block).toMatch(/animation:\s*none/)
    expect(block).toMatch(/\.jack-bar-fill\s*\{[\s\S]*transition:\s*none/)
  })
})
