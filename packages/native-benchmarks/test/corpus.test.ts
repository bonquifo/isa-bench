import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workloadById } from '../../../src/engine/workloads.ts'
import {
  WORKLOAD_IDS, assertSafeBuildArg, expectedRaw, loadManifest, parseV1Frame,
  sourceSha256, validateEligibility, validateManifest, type EligibilityRecord,
} from '../src/index.ts'

const packageRoot = resolve(import.meta.dirname, '..')
const manifest = loadManifest(resolve(packageRoot, 'manifest.json'))

describe('native corpus semantic mappings', () => {
  it('contains one complete versioned mapping per built-in workload', () => {
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.corpusVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.workloads.map((item) => item.id)).toEqual(WORKLOAD_IDS)
    expect(new Set(manifest.workloads.map((item) => `${item.id}@${item.version}`)).size).toBe(12)
    for (const item of manifest.workloads) {
      expect(item.family).not.toBe('')
      expect(item.n.meaning).not.toBe('')
      expect(item.seed.meaning).not.toBe('')
      expect(item.inputLayout).not.toBe('')
      expect(item.oracle).not.toBe('')
      expect(item.roi).not.toBe('')
    }
  })

  it('pins the reviewed source bytes without an observed artifact hash', () => {
    expect(sourceSha256(resolve(packageRoot, manifest.source.path))).toBe(manifest.source.sha256)
    expect(JSON.stringify(manifest)).not.toMatch(/binarySha|objectSha|observed/i)
  })

  it('rejects missing and malformed mappings', () => {
    const missing = structuredClone(manifest) as unknown as { workloads: unknown[] }
    missing.workloads.pop()
    expect(() => validateManifest(missing)).toThrow(/twelve/)
    const malformed = structuredClone(manifest) as unknown as { workloads: Array<{ roi: string }> }
    malformed.workloads[0]!.roi = ''
    expect(() => validateManifest(malformed)).toThrow(/invalid workload/)
    ;(malformed.workloads[0] as unknown as { n: { min: number } }).n.min = 999999
    expect(() => validateManifest(malformed)).toThrow(/invalid workload/)
  })
})

describe('independent native oracles', () => {
  it('matches every existing built-in expected value over bounds and seed edges', () => {
    const seeds = [-2147483648, -1, 0, 1, 2147483647]
    for (const mapping of manifest.workloads) {
      const ns = [...new Set([mapping.n.min, mapping.n.default, mapping.n.max])]
      for (const n of ns) {
        for (const seed of mapping.seed.used ? seeds : [0]) {
          const built = workloadById(mapping.id).build(n, seed)
          const expected = expectedRaw(mapping.id, n, seed)
          if (mapping.id === 'fp_sum') {
            const bytes = new ArrayBuffer(8)
            const view = new DataView(bytes)
            view.setFloat64(0, built.expected, true)
            expect(expected, `${mapping.id} N=${n} seed=${seed}`).toBe(view.getBigUint64(0, true))
          } else {
            expect(expected, `${mapping.id} N=${n} seed=${seed}`).toBe(BigInt(built.expected >>> 0))
          }
        }
      }
    }
  }, 30_000)

  it('is deterministic and checks UB-sensitive wrapping edges', () => {
    for (const mapping of manifest.workloads) {
      const first = expectedRaw(mapping.id, mapping.n.min, -2147483648)
      const second = expectedRaw(mapping.id, mapping.n.min, -2147483648)
      expect(first).toBe(second)
      expect(first).toBeGreaterThanOrEqual(0n)
      expect(first).toBeLessThanOrEqual(0xffffffffffffffffn)
    }
    expect(() => expectedRaw('int_sum', 7, 0)).toThrow(/outside/)
  })
})

describe('ROI, frame and eligibility enforcement', () => {
  it('keeps preparation and the volatile sink outside ROI', () => {
    const source = readFileSync(resolve(packageRoot, 'native/core.c'), 'utf8')
    const harness = source.slice(source.indexOf('u64 isa_bench_inner_iteration'))
    expect(harness.indexOf('isa_bench_prepare()')).toBeLessThan(harness.indexOf('isa_bench_roi_begin()'))
    expect(harness.indexOf('isa_bench_roi_end()')).toBeLessThan(harness.indexOf('isa_bench_result_sink'))
    expect(source).toContain('volatile u64 isa_bench_result_sink')
    expect(source).toContain('NOINLINE_USED u64 isa_bench_core')
  })

  it('accepts only exact successful v1 frames and exposes wrong results', () => {
    const bytes = new Uint8Array(24)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 0x46415349, true)
    view.setUint16(4, 1, true)
    view.setUint32(8, 42, true)
    expect(parseV1Frame(bytes)).toEqual({ kind: 'i32', rawBits: 42n })
    expect(parseV1Frame(bytes).rawBits).not.toBe(41n)
    expect(() => parseV1Frame(new Uint8Array(25))).toThrow(/exactly/)
    bytes[6] = 1
    expect(() => parseV1Frame(bytes)).toThrow(/invalid/)
  })

  it('rejects missing marker, target, and reproducibility evidence', () => {
    const base: EligibilityRecord = { workload: 'int_sum', target: 'x86_64-linux', eligible: true }
    expect(() => validateEligibility(base)).toThrow(/lacks evidence/)
    expect(() => validateEligibility({ ...base, eligible: false })).toThrow(/reason/)
    expect(() => validateEligibility({
      ...base,
      eligible: false,
      reason: 'explicitly unsupported',
    })).not.toThrow()
  })

  it('records honest 6502 limits and a binary64 reason', () => {
    const fp = manifest.workloads.find((item) => item.id === 'fp_sum')!
    expect(fp.targets.mos).toMatchObject({ supported: false })
    expect('reason' in fp.targets.mos ? fp.targets.mos.reason : '').toMatch(/binary64.*64 KiB/)
    for (const item of manifest.workloads.filter((candidate) => candidate.id !== 'fp_sum')) {
      expect('maxN' in item.targets.mos && item.targets.mos.maxN).toBeTruthy()
    }
  })

  it('allows only inert build arguments', () => {
    for (const safe of ['-O2', '-DBENCH_N=8', 'riscv64-unknown-linux-gnu', '/artifacts/core.o']) {
      expect(() => assertSafeBuildArg(safe)).not.toThrow()
    }
    for (const unsafe of ['../secret', 'x;whoami', '$(bad)', 'a b']) {
      expect(() => assertSafeBuildArg(unsafe)).toThrow(/unsafe/)
    }
  })
})
