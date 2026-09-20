import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUEST_C_VERSION } from '../engine/c/compile_c.ts'

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx|md|html)$/.test(name) && !name.endsWith('terminology.test.ts') ? [path] : []
  })
}

describe('public terminology', () => {
  it('rejects deprecated active product claims in source and docs', () => {
    const root = resolve(import.meta.dirname, '../..')
    const files = [
      ...sourceFiles(join(root, 'src')),
      join(root, 'README.md'),
      join(root, 'index.html'),
    ]
    const forbidden = [
      new RegExp(['Real', 'CPUs'].join(' '), 'i'),
      new RegExp(['native', 'silicon'].join(' '), 'i'),
      new RegExp(['WALL', 'TIME'].join(' '), 'i'),
      /energy\s+(?:winner|wins|owns)/i,
    ]
    const violations = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`)
    })
    expect(violations).toEqual([])
  })

  it('rejects unqualified analysis labels and completion language', () => {
    const analysis = readFileSync(resolve(import.meta.dirname, 'analysis.ts'), 'utf8')
    const forbidden = [
      /label:\s*'CYCLES'/,
      /label:\s*'LIVE THREADS'/,
      /retired ops/i,
      /hardware threads retired/i,
      /higher CPI/i,
      /body:\s*`[^`]*\bCPI\b/i,
    ]
    expect(forbidden.filter((pattern) => pattern.test(analysis)).map(String)).toEqual([])
    expect(analysis).toContain('completed modeled operations after drain')
    expect(analysis).toContain('MODEL CYCLES')
    expect(analysis).toContain('EFFECTIVE ACTIVE WORKERS')
  })

  it('keeps every public Guest C version string synchronized', () => {
    const root = resolve(import.meta.dirname, '../..')
    const files = [...sourceFiles(join(root, 'src')), join(root, 'README.md')]
    const versions = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/Guest C v\d+(?:\.\d+)*/g)].map((match) => match[0])
    )
    expect(versions.length).toBeGreaterThan(0)
    expect([...new Set(versions)]).toEqual([GUEST_C_VERSION])
  })

  it('keeps modeled output labelled as modeled, never as measurement', () => {
    const root = resolve(import.meta.dirname, '../..')
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toMatch(/model cycles.*not nanoseconds|not stopwatch time/i)
    expect(readme).toMatch(/pseudo-backends/i)
    expect(readme).toMatch(/no claim about how fast real silicon/i)
  })
})
