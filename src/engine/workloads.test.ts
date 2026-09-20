import { describe, expect, it } from 'vitest'
import { checksumI32, i32, imul, lcg } from './bits.ts'
import { applyData, interpretIr } from './ir.ts'
import { DATA_BASE, MAX_HW_THREADS, MEM_SIZE, PARTIAL_BASE, PARTIAL_STRIDE, STACK_TOP } from './types.ts'
import { WORKLOADS, workloadById } from './workloads.ts'

function isPrime(n: number): boolean {
  if (n < 2) return false
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false
  return true
}

function fnv1a(words: number[]): number {
  let h = 2166136261
  for (const w of words) {
    h ^= w | 0
    h = Math.imul(h, 16777619)
  }
  return h | 0
}

function mixHash(seed: number, n: number): number {
  const k0 = 0x9e3779b9
  let h = seed | 0
  for (let i = 0; i < n; i++) {
    h = i32(h ^ i)
    const rot = i32((h << 5) | (h >>> 27))
    h = i32(rot + k0)
    h = i32(h ^ (h >>> 7))
  }
  return h
}

describe('built-in workloads', () => {
  it('pads reduction slots to one modeled line within the memory map', () => {
    expect(PARTIAL_STRIDE).toBe(64)
    expect(PARTIAL_BASE % PARTIAL_STRIDE).toBe(0)
    expect(PARTIAL_BASE + MAX_HW_THREADS * PARTIAL_STRIDE).toBeLessThanOrEqual(STACK_TOP)
  })

  it('registers unique ids, categories, and N bounds', () => {
    const ids = WORKLOADS.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      'int_sum',
      'dot_product',
      'saxpy',
      'memcpy',
      'matmul',
      'insertion_sort',
      'binary_search',
      'sieve',
      'checksum',
      'pointer_chase',
      'fir',
      'fp_sum',
    ])
    for (const w of WORKLOADS) {
      expect(w.minN).toBeLessThan(w.maxN)
      expect(w.defaultN).toBeGreaterThanOrEqual(w.minN)
      expect(w.defaultN).toBeLessThanOrEqual(w.maxN)
      expect(w.nRole).toBe('problem-size')
      expect(w.referenceOracle).toBe('independent-host-model')
      expect(w.hasIndependentExpectedCheck).toBe(true)
    }
    expect(WORKLOADS.filter((w) => !w.usesSeed).map((w) => w.id)).toEqual([
      'int_sum',
      'sieve',
    ])
    expect(WORKLOADS.filter((w) => w.usesSeed).map((w) => w.id)).toHaveLength(
      WORKLOADS.length - 2,
    )
    expect(() => workloadById('nope')).toThrow(/Unknown workload/)
  })

  it('integer sum equals the closed form n(n-1)/2', () => {
    const n = 40
    const built = workloadById('int_sum').build(n, 0)
    expect(built.expected).toBe((n * (n - 1)) / 2)
    expect(built.maxWorkers).toBe(n)
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(built.expected)
  })

  it('dot product matches an independent MAC of the same LCG streams', () => {
    const n = 24
    const seed = 42
    const built = workloadById('dot_product').build(n, seed)
    const rng = lcg(seed)
    const a = Array.from({ length: n }, () => (rng() % 17) - 8)
    const b = Array.from({ length: n }, () => (rng() % 13) - 6)
    let gold = 0
    for (let i = 0; i < n; i++) gold = i32(gold + imul(a[i], b[i]))
    expect(built.expected).toBe(gold)
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(gold)
  })

  it('SAXPY checksums y[i] += 3*x[i] with FNV-1a', () => {
    const n = 20
    const seed = 7
    const built = workloadById('saxpy').build(n, seed)
    const rng = lcg(seed)
    const x = Array.from({ length: n }, () => (rng() % 11) - 5)
    const y = Array.from({ length: n }, () => (rng() % 9) - 4)
    const out = y.map((yi, i) => i32(yi + imul(3, x[i])))
    expect(built.expected).toBe(fnv1a(out))
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(fnv1a(out))
  })

  it('memcpy checksums the source (destination after the copy)', () => {
    const n = 16
    const seed = 3
    const built = workloadById('memcpy').build(n, seed)
    const rng = lcg(seed)
    const src = Array.from({ length: n }, () => rng())
    expect(built.expected).toBe(fnv1a(src))
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(fnv1a(src))
  })

  it('integer GEMM matches a textbook ijk multiply then FNV-1a', () => {
    const n = 4
    const seed = 1
    const built = workloadById('matmul').build(n, seed)
    const rng = lcg(seed)
    const A = Array.from({ length: n * n }, () => (rng() % 7) - 3)
    const B = Array.from({ length: n * n }, () => (rng() % 7) - 3)
    const C: number[] = []
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let acc = 0
        for (let k = 0; k < n; k++) acc = i32(acc + imul(A[i * n + k], B[k * n + j]))
        C.push(acc)
      }
    }
    expect(built.expected).toBe(fnv1a(C))
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(fnv1a(C))
  })

  it('insertion sort checksums the signed-int ordered permutation', () => {
    const n = 10
    const seed = 9
    const built = workloadById('insertion_sort').build(n, seed)
    const rng = lcg(seed)
    const arr = Array.from({ length: n }, () => rng())
    arr.sort((a, b) => ((a | 0) < (b | 0) ? -1 : (a | 0) > (b | 0) ? 1 : 0))
    expect(built.expected).toBe(fnv1a(arr))
    expect(built.maxWorkers).toBe(1)
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(fnv1a(arr))
  })

  it('binary-search gold is the sum of first-hit indices (−1 if absent)', () => {
    const n = 12
    const seed = 5
    const built = workloadById('binary_search').build(n, seed)
    const rng = lcg(seed)
    const vals = Array.from({ length: n }, () => i32(rng() % 10000))
    vals.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const keys: number[] = []
    for (let i = 0; i < n; i++) keys.push(i % 3 === 0 ? i32(rng() % 10000) : vals[i % n])
    let expected = 0
    for (const key of keys) {
      let lo = 0
      let hi = n - 1
      let found = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (vals[mid] === key) {
          found = mid
          break
        }
        if (vals[mid] < key) lo = mid + 1
        else hi = mid - 1
      }
      expected = i32(expected + found)
    }
    expect(built.expected).toBe(expected)
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(expected)
  })

  it('sieve counts primes ≤ N by an independent trial-division oracle', () => {
    const n = 40
    const built = workloadById('sieve').build(n, 0)
    let primes = 0
    for (let i = 2; i <= n; i++) if (isPrime(i)) primes += 1
    expect(primes).toBe(12)
    expect(built.expected).toBe(12)
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(12)
  })

  it('checksum mix is a rotate-xor of the golden-ratio constant', () => {
    const n = 64
    const seed = 3
    const built = workloadById('checksum').build(n, seed)
    expect(built.expected).toBe(mixHash(seed, n))
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(mixHash(seed, n))
  })

  it('pointer chase walks a Fisher–Yates cycle and sums payloads', () => {
    const n = 16
    const seed = 11
    const built = workloadById('pointer_chase').build(n, seed)
    const idx = Array.from({ length: n }, (_, i) => i)
    const rng = lcg(seed)
    for (let i = n - 1; i > 0; i--) {
      const j = (rng() >>> 0) % (i + 1)
      ;[idx[i], idx[j]] = [idx[j], idx[i]]
    }
    const nextOf = new Int32Array(n)
    for (let i = 0; i < n; i++) nextOf[idx[i]] = idx[(i + 1) % n]
    let p = 0
    let expected = 0
    for (let step = 0; step < n; step++) {
      expected = i32(expected + ((p * 17 + seed) | 0))
      p = nextOf[p]
    }
    expect(built.expected).toBe(expected)
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(expected)
  })

  it('FIR is an 8-tap convolution with zero padding, then a sum', () => {
    const n = 12
    const seed = 2
    const built = workloadById('fir').build(n, seed)
    const coeffs = [1, -2, 3, -1, 2, 1, -1, 1]
    const rng = lcg(seed)
    const x = Array.from({ length: n }, () => (rng() % 21) - 10)
    let expected = 0
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let k = 0; k < 8; k++) {
        const idx = i - k
        const xv = idx >= 0 ? x[idx] : 0
        acc = i32(acc + imul(coeffs[k], xv))
      }
      expected = i32(expected + acc)
    }
    expect(built.expected).toBe(expected)
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBe(expected)
  })

  it('FP reduction sums IEEE-754 doubles from the same LCG', () => {
    const n = 16
    const seed = 4
    const built = workloadById('fp_sum').build(n, seed)
    expect(built.fp).toBe(true)
    const rng = lcg(seed)
    let expected = 0
    for (let i = 0; i < n; i++) expected += ((rng() % 2001) - 1000) / 100
    expect(built.expected).toBeCloseTo(expected, 12)
    expect(interpretIr(built.ir, built.memory.slice(0)).value).toBeCloseTo(expected, 12)
  })

  it('pre-fills guest memory for data-heavy kernels (not IR .word blobs)', () => {
    const n = 8
    const seed = 1
    const built = workloadById('dot_product').build(n, seed)
    expect(built.memory.byteLength).toBe(MEM_SIZE)
    expect(built.ir.data).toHaveLength(0)
    const rng = lcg(seed)
    const view = new DataView(built.memory)
    for (let i = 0; i < n; i++) {
      expect(view.getInt32(DATA_BASE + i * 4, true)).toBe((rng() % 17) - 8)
    }
    for (let i = 0; i < n; i++) {
      expect(view.getInt32(DATA_BASE + n * 4 + i * 4, true)).toBe((rng() % 13) - 6)
    }
    applyData(built.memory, built.ir.data)
    expect(checksumI32(view, DATA_BASE, n)).not.toBe(2166136261 | 0)
  })
})
