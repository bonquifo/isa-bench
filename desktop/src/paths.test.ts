import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { desktopFromMain, listenPort, loopbackUrl } from './paths.ts'

describe('desktop layout', () => {
  it('resolves a packaged repository and UI directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'isa-desktop-'))
    mkdirSync(join(root, 'src', 'engine'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'src', 'engine', 'index.ts'), 'export {}')
    writeFileSync(join(root, 'dist', 'index.html'), '<html></html>')
    const main = pathToFileURL(join(root, 'desktop', 'dist', 'main.js')).href
    const found = desktopFromMain(main, [], { ISA_SIM_REPOSITORY_ROOT: root })
    expect(found.development).toBe(false)
    expect(found.layout.repositoryRoot).toBe(root)
    expect(found.layout.staticDir).toBe(join(root, 'dist'))
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
    expect(loopbackUrl(4317)).toBe('http://127.0.0.1:4317')
    expect(listenPort({ port: 4318 })).toBe(4318)
    expect(() => loopbackUrl(0)).toThrow(/invalid/)
  })
})
