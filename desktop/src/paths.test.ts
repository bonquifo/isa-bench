import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { desktopFromMain } from './paths.ts'

describe('desktop layout', () => {
  it('finds the built UI bundle beside the packaged app', () => {
    const root = mkdtempSync(join(tmpdir(), 'isa-desktop-'))
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.html'), '<html></html>')
    const main = pathToFileURL(join(root, 'desktop', 'dist', 'main.js')).href
    const found = desktopFromMain(main, [], {})
    expect(found.development).toBe(false)
    expect(found.layout.staticDir).toBe(join(root, 'dist'))
  })

  it('prefers an explicit static directory override', () => {
    const root = mkdtempSync(join(tmpdir(), 'isa-desktop-override-'))
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(join(root, 'custom', 'index.html'), '<html></html>')
    const main = pathToFileURL(join(root, 'desktop', 'dist', 'main.js')).href
    expect(desktopFromMain(main, [], { ISA_SIM_STATIC_DIR: join(root, 'custom') }).layout.staticDir)
      .toBe(join(root, 'custom'))
  })

  it('reports no static directory when nothing is built yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'isa-desktop-empty-'))
    const main = pathToFileURL(join(root, 'desktop', 'dist', 'main.js')).href
    expect(desktopFromMain(main, [], {}).layout.staticDir).toBeUndefined()
  })

  it('points at a CommonJS preload, which is the only kind a sandboxed renderer loads', () => {
    const layout = desktopFromMain(import.meta.url, [], {}).layout
    expect(layout.preloadPath.endsWith('preload.cjs')).toBe(true)
    expect(existsSync(fileURLToPath(new URL('preload.cts', import.meta.url)))).toBe(true)
    expect(existsSync(fileURLToPath(new URL('preload.ts', import.meta.url)))).toBe(false)
    const compiled = fileURLToPath(new URL('../dist/preload.cjs', import.meta.url))
    if (existsSync(compiled)) {
      const built = readFileSync(compiled, 'utf8')
      expect(built).toContain("require(\"electron\")")
      expect(built).not.toMatch(/^\s*import\s/m)
    }
  })

  it('treats --dev as the Vite development shell', () => {
    expect(desktopFromMain(import.meta.url, ['--dev'], {}).development).toBe(true)
    expect(desktopFromMain(import.meta.url, [], { ISA_BENCH_DEV_URL: 'http://127.0.0.1:5173' }).development).toBe(true)
    expect(desktopFromMain(import.meta.url, [], {}).development).toBe(false)
  })
})
