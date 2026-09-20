import { checksumI32, i32, imul, lcg } from './bits.ts'
import { applyData, IrBuilder, type IrProgram } from './ir.ts'
import { DATA_BASE, MEM_SIZE, PARTIAL_BASE, PARTIAL_STRIDE } from './types.ts'

export interface BuiltWorkload {
  ir: IrProgram
  memory: ArrayBuffer
  expected: number
  fp: boolean
  notes: string
  /** Useful SPMD width. Serial kernels stay 1. */
  maxWorkers: number
}

export type NRole = 'problem-size' | 'worker-cap' | 'unused'
export type ParallelSemantics = 'serial' | 'spmd-striped' | 'source-defined'
export type ReferenceOracle = 'independent-host-model' | 'ir-interpreter'

export interface WorkloadDef {
  id: string
  name: string
  blurb: string
  category: 'integer' | 'memory' | 'control' | 'fp' | 'mixed'
  defaultN: number
  minN: number
  maxN: number
  nLabel: string
  /** Whether changing the signed-i32 seed changes this workload. */
  usesSeed: boolean
  nRole: 'problem-size'
  parallelSemantics: Exclude<ParallelSemantics, 'source-defined'>
  referenceOracle: 'independent-host-model'
  hasIndependentExpectedCheck: true
  build: (n: number, seed: number) => BuiltWorkload
}

function freshMem(): ArrayBuffer {
  return new ArrayBuffer(MEM_SIZE)
}

function fillWords(view: DataView, addr: number, n: number, fn: (i: number) => number): void {
  for (let i = 0; i < n; i++) view.setInt32(addr + i * 4, i32(fn(i)), true)
}

function fillFloats(view: DataView, addr: number, n: number, fn: (i: number) => number): void {
  for (let i = 0; i < n; i++) view.setFloat64(addr + i * 8, fn(i), true)
}

function finish(
  b: IrBuilder,
  mem: ArrayBuffer,
  expected: number,
  fp: boolean,
  notes: string,
  maxWorkers = 1,
): BuiltWorkload {
  const ir = b.program()
  applyData(mem, ir.data)
  return { ir, memory: mem, expected, fp, notes, maxWorkers }
}

function reducePartials(b: IrBuilder, acc: number, tid: number, nth: number, fp: boolean): void {
  const base = b.imm(PARTIAL_BASE)
  const stride = b.imm(PARTIAL_STRIDE)
  const off = b.mul(tid, stride)
  const slot = b.add(base, off)
  if (fp) b.std(acc, slot, 0)
  else b.stw(acc, slot, 0)
  b.barrier()
  const zero = b.imm(0)
  const worker = b.lab()
  b.bne(tid, zero, worker)
  const j = b.imm(0)
  const tot = fp ? b.immf(0) : b.imm(0)
  const one = b.imm(1)
  const rtop = b.lab()
  const rdone = b.lab()
  b.label(rtop)
  b.bge(j, nth, rdone)
  const jo = b.mul(j, stride)
  const ja = b.add(base, jo)
  if (fp) {
    const v = b.ldd(ja, 0)
    b.addfTo(tot, tot, v)
  } else {
    const v = b.ldw(ja, 0)
    b.addTo(tot, tot, v)
  }
  b.addTo(j, j, one)
  b.br(rtop)
  b.label(rdone)
  b.halt(tot)
  b.label(worker)
  b.halt(zero)
}

function leadAfterBarrier(b: IrBuilder, tid: number): string {
  b.barrier()
  const worker = b.lab()
  const zero = b.imm(0)
  b.bne(tid, zero, worker)
  return worker
}

function intSum(n: number): BuiltWorkload {
  const b = new IrBuilder()
  const tid = b.tid()
  const nth = b.nthreads()
  const i = b.mov(tid)
  const acc = b.imm(0)
  const lim = b.imm(n)
  const top = b.lab()
  const done = b.lab()
  b.label(top)
  b.bge(i, lim, done)
  b.addTo(acc, acc, i)
  b.addTo(i, i, nth)
  b.br(top)
  b.label(done)
  reducePartials(b, acc, tid, nth, false)
  let expected = 0
  for (let k = 0; k < n; k++) expected = i32(expected + k)
  return finish(b, freshMem(), expected, false, 'Closed-form integer reduction. SPMD-striped across cores/SMT.', n)
}

function dotProduct(n: number, seed: number): BuiltWorkload {
  const aAddr = DATA_BASE
  const bAddr = DATA_BASE + n * 4
  const mem = freshMem()
  const view = new DataView(mem)
  const rng = lcg(seed)
  fillWords(view, aAddr, n, () => (rng() % 17) - 8)
  fillWords(view, bAddr, n, () => (rng() % 13) - 6)
  let expected = 0
  for (let i = 0; i < n; i++) {
    expected = i32(expected + imul(view.getInt32(aAddr + i * 4, true), view.getInt32(bAddr + i * 4, true)))
  }

  const b = new IrBuilder()
  const tid = b.tid()
  const nth = b.nthreads()
  const i = b.mov(tid)
  const acc = b.imm(0)
  const lim = b.imm(n)
  const baseA = b.imm(aAddr)
  const baseB = b.imm(bAddr)
  const top = b.lab()
  const done = b.lab()
  b.label(top)
  b.bge(i, lim, done)
  const av = b.ldwS(baseA, i, 4, 0)
  const bv = b.ldwS(baseB, i, 4, 0)
  const p = b.mul(av, bv)
  b.addTo(acc, acc, p)
  b.addTo(i, i, nth)
  b.br(top)
  b.label(done)
  reducePartials(b, acc, tid, nth, false)
  return finish(b, mem, expected, false, 'Indexed loads of two streams plus multiply-accumulate. SPMD-striped.', n)
}

function saxpy(n: number, seed: number): BuiltWorkload {
  const xAddr = DATA_BASE
  const yAddr = DATA_BASE + n * 4
  const mem = freshMem()
  const view = new DataView(mem)
  const rng = lcg(seed)
  const aImm = 3
  fillWords(view, xAddr, n, () => (rng() % 11) - 5)
  fillWords(view, yAddr, n, () => (rng() % 9) - 4)
  for (let i = 0; i < n; i++) {
    const x = view.getInt32(xAddr + i * 4, true)
    const y = view.getInt32(yAddr + i * 4, true)
    view.setInt32(yAddr + i * 4, i32(y + imul(aImm, x)), true)
  }
  const expected = checksumI32(view, yAddr, n)
  fillWords(view, xAddr, n, () => 0)
  const rng2 = lcg(seed)
  fillWords(view, xAddr, n, () => (rng2() % 11) - 5)
  fillWords(view, yAddr, n, () => (rng2() % 9) - 4)

  const b = new IrBuilder()
  const tid = b.tid()
  const nth = b.nthreads()
  const i = b.mov(tid)
  const lim = b.imm(n)
  const one = b.imm(1)
  const a = b.imm(aImm)
  const baseX = b.imm(xAddr)
  const baseY = b.imm(yAddr)
  const top = b.lab()
  const done = b.lab()
  b.label(top)
  b.bge(i, lim, done)
  const x = b.ldwS(baseX, i, 4, 0)
  const y = b.ldwS(baseY, i, 4, 0)
  const ax = b.mul(a, x)
  const ny = b.add(y, ax)
  b.stwS(ny, baseY, i, 4, 0)
  b.addTo(i, i, nth)
  b.br(top)
  b.label(done)
  const worker = leadAfterBarrier(b, tid)
  const j = b.imm(0)
  const h = b.imm(2166136261)
  const F = b.imm(16777619)
  const mix = b.lab()
  const mixDone = b.lab()
  b.label(mix)
  b.bge(j, lim, mixDone)
  const w = b.ldwS(baseY, j, 4, 0)
  b.binTo('xor', h, h, w)
  b.mulTo(h, h, F)
  b.addTo(j, j, one)
  b.br(mix)
  b.label(mixDone)
  b.halt(h)
  b.label(worker)
  b.halt(b.imm(0))
  return finish(b, mem, expected, false, 'Store-heavy triad: y[i] += a * x[i], then a memory checksum. Map is SPMD.', n)
}

function memcpyWords(n: number, seed: number): BuiltWorkload {
  const src = DATA_BASE
  const dst = DATA_BASE + n * 4
  const mem = freshMem()
  const view = new DataView(mem)
  const rng = lcg(seed)
  fillWords(view, src, n, () => rng())
  const expected = checksumI32(view, src, n)

  const b = new IrBuilder()
  const tid = b.tid()
  const nth = b.nthreads()
  const i = b.mov(tid)
  const lim = b.imm(n)
  const one = b.imm(1)
  const s = b.imm(src)
  const d = b.imm(dst)
  const top = b.lab()
  const done = b.lab()
  b.label(top)
  b.bge(i, lim, done)
  const v = b.ldwS(s, i, 4, 0)
  b.stwS(v, d, i, 4, 0)
  b.addTo(i, i, nth)
  b.br(top)
  b.label(done)
  const worker = leadAfterBarrier(b, tid)
  const j = b.imm(0)
  const h = b.imm(2166136261)
  const F = b.imm(16777619)
  const mix = b.lab()
  const mixDone = b.lab()
  b.label(mix)
  b.bge(j, lim, mixDone)
  const w = b.ldwS(d, j, 4, 0)
  b.binTo('xor', h, h, w)
  b.mulTo(h, h, F)
  b.addTo(j, j, one)
  b.br(mix)
  b.label(mixDone)
  b.halt(h)
  b.label(worker)
  b.halt(b.imm(0))
  return finish(b, mem, expected, false, 'Word copy striped across threads, then a leader checksum.', n)
}

function matmul(n: number, seed: number): BuiltWorkload {
  const aAddr = DATA_BASE
  const bAddr = aAddr + n * n * 4
  const cAddr = bAddr + n * n * 4
  const mem = freshMem()
  const view = new DataView(mem)
  const rng = lcg(seed)
  fillWords(view, aAddr, n * n, () => (rng() % 7) - 3)
  fillWords(view, bAddr, n * n, () => (rng() % 7) - 3)
  const C = new Int32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0
      for (let k = 0; k < n; k++) {
        const av = view.getInt32(aAddr + (i * n + k) * 4, true)
        const bv = view.getInt32(bAddr + (k * n + j) * 4, true)
        acc = i32(acc + imul(av, bv))
      }
      C[i * n + j] = acc
    }
  }
  const tmp = new ArrayBuffer(n * n * 4)
  const tv = new DataView(tmp)
  C.forEach((v, i) => tv.setInt32(i * 4, v, true))
  const expected = checksumI32(tv, 0, n * n)

  const b = new IrBuilder()
  const tid = b.tid()
  const nth = b.nthreads()
  const i = b.mov(tid)
  const nR = b.imm(n)
  const one = b.imm(1)
  const baseA = b.imm(aAddr)
  const baseB = b.imm(bAddr)
  const baseC = b.imm(cAddr)
  const iLoop = b.lab()
  const iDone = b.lab()
  b.label(iLoop)
  b.bge(i, nR, iDone)
  const j = b.imm(0)
  const jLoop = b.lab()
  const jDone = b.lab()
  b.label(jLoop)
  b.bge(j, nR, jDone)
  const acc = b.imm(0)
  const k = b.imm(0)
  const kLoop = b.lab()
  const kDone = b.lab()
  b.label(kLoop)
  b.bge(k, nR, kDone)
  const iN = b.mul(i, nR)
  const aIdx = b.add(iN, k)
  const kN = b.mul(k, nR)
  const bIdx = b.add(kN, j)
  const av = b.ldwS(baseA, aIdx, 4, 0)
  const bv = b.ldwS(baseB, bIdx, 4, 0)
  const p = b.mul(av, bv)
  b.addTo(acc, acc, p)
  b.addTo(k, k, one)
  b.br(kLoop)
  b.label(kDone)
  const cIdx = b.add(iN, j)
  b.stwS(acc, baseC, cIdx, 4, 0)
  b.addTo(j, j, one)
  b.br(jLoop)
  b.label(jDone)
  b.addTo(i, i, nth)
  b.br(iLoop)
  b.label(iDone)
  const worker = leadAfterBarrier(b, tid)
  const t = b.imm(0)
  const words = b.imm(n * n)
  const h = b.imm(2166136261)
  const F = b.imm(16777619)
  const mix = b.lab()
  const mixDone = b.lab()
  b.label(mix)
  b.bge(t, words, mixDone)
  const w = b.ldwS(baseC, t, 4, 0)
  b.binTo('xor', h, h, w)
  b.mulTo(h, h, F)
  b.addTo(t, t, one)
  b.br(mix)
  b.label(mixDone)
  b.halt(h)
  b.label(worker)
  b.halt(b.imm(0))
  return finish(b, mem, expected, false, 'Dense n×n integer GEMM. Rows are SPMD-striped, then a leader checksum.', n)
}

function insertionSort(n: number, seed: number): BuiltWorkload {
  const addr = DATA_BASE
  const mem = freshMem()
  const view = new DataView(mem)
  const rng = lcg(seed)
  const arr: number[] = []
  fillWords(view, addr, n, () => {
    const v = rng()
    arr.push(v)
    return v
  })
  const sorted = [...arr].sort((a, b) => ((a | 0) < (b | 0) ? -1 : (a | 0) > (b | 0) ? 1 : 0))
  const tmp = new ArrayBuffer(n * 4)
  const tv = new DataView(tmp)
  sorted.forEach((v, i) => tv.setInt32(i * 4, v, true))
  const expected = checksumI32(tv, 0, n)

  const b = new IrBuilder()
  const base = b.imm(addr)
  const nR = b.imm(n)
  const one = b.imm(1)
  const zero = b.imm(0)
  const i = b.imm(1)
  const outer = b.lab()
  const outerDone = b.lab()
  b.label(outer)
  b.bge(i, nR, outerDone)
  const key = b.ldwS(base, i, 4, 0)
  const j = b.sub(i, one)
  const inner = b.lab()
  const innerDone = b.lab()
  const shift = b.lab()
  b.label(inner)
  b.blt(j, zero, innerDone)
  const aj = b.ldwS(base, j, 4, 0)
  b.blt(key, aj, shift)
  b.br(innerDone)
  b.label(shift)
  const j1 = b.add(j, one)
  b.stwS(aj, base, j1, 4, 0)
  b.subTo(j, j, one)
  b.br(inner)
  b.label(innerDone)
  const dest = b.add(j, one)
  b.stwS(key, base, dest, 4, 0)
  b.addTo(i, i, one)
  b.br(outer)
  b.label(outerDone)
  const t = b.imm(0)
  const h = b.imm(2166136261)
  const F = b.imm(16777619)
  const mix = b.lab()
  const mixDone = b.lab()
  b.label(mix)
  b.bge(t, nR, mixDone)
  const w = b.ldwS(base, t, 4, 0)
  b.binTo('xor', h, h, w)
  b.mulTo(h, h, F)
  b.addTo(t, t, one)
  b.br(mix)
  b.label(mixDone)
  b.halt(h)
  return finish(b, mem, expected, false, 'Data-dependent inner loop. Branch predictor quality shows up clearly.')
}

function binarySearch(n: number, seed: number): BuiltWorkload {
  const arrAddr = DATA_BASE
  const keysAddr = DATA_BASE + n * 4
  const mem = freshMem()
  const view = new DataView(mem)
  const rng = lcg(seed)
  const vals: number[] = []
  for (let i = 0; i < n; i++) vals.push(i32(rng() % 10000))
  vals.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  vals.forEach((v, i) => view.setInt32(arrAddr + i * 4, v, true))
  const keys: number[] = []
  for (let i = 0; i < n; i++) {
    const k = i % 3 === 0 ? i32(rng() % 10000) : vals[i % n]
    keys.push(k)
    view.setInt32(keysAddr + i * 4, k, true)
  }
  let expected = 0
  for (const key of keys) {
    let lo = 0
    let hi = n - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const v = vals[mid]
      if (v === key) {
        found = mid
        break
      }
      if (v < key) lo = mid + 1
      else hi = mid - 1
    }
    expected = i32(expected + found)
  }

  const b = new IrBuilder()
  const tid = b.tid()
  const nth = b.nthreads()
  const base = b.imm(arrAddr)
  const kbase = b.imm(keysAddr)
  const nR = b.imm(n)
  const one = b.imm(1)
  const t = b.mov(tid)
  const acc = b.imm(0)
  const tLoop = b.lab()
  const tDone = b.lab()
  b.label(tLoop)
  b.bge(t, nR, tDone)
  const key = b.ldwS(kbase, t, 4, 0)
  const lo = b.imm(0)
  const hi = b.addi(nR, -1)
  const found = b.imm(-1)
  const inner = b.lab()
  const innerDone = b.lab()
  const goRight = b.lab()
  b.label(inner)
  b.blt(hi, lo, innerDone)
  const sum = b.add(lo, hi)
  const mid = b.shr(sum, one)
  const v = b.ldwS(base, mid, 4, 0)
  b.beq(v, key, 'foundhit')
  b.blt(v, key, goRight)
  b.subTo(hi, mid, one)
  b.br(inner)
  b.label(goRight)
  b.addTo(lo, mid, one)
  b.br(inner)
  b.label('foundhit')
  b.movTo(found, mid)
  b.label(innerDone)
  b.addTo(acc, acc, found)
  b.addTo(t, t, nth)
  b.br(tLoop)
  b.label(tDone)
  reducePartials(b, acc, tid, nth, false)
  return finish(b, mem, expected, false, 'Many short binary searches, striped across threads.', n)
}

function sieve(n: number): BuiltWorkload {
  const addr = DATA_BASE
  const mem = freshMem()
  const view = new DataView(mem)
  const mark = new Uint8Array(n + 1)
  mark.fill(1)
  if (n >= 0) mark[0] = 0
  if (n >= 1) mark[1] = 0
  for (let i = 2; i * i <= n; i++) {
    if (!mark[i]) continue
    for (let j = i * i; j <= n; j += i) mark[j] = 0
  }
  let expected = 0
  for (let i = 2; i <= n; i++) if (mark[i]) expected += 1
  fillWords(view, addr, n + 1, () => 1)

  const b = new IrBuilder()
  const base = b.imm(addr)
  const nR = b.imm(n)
  const one = b.imm(1)
  const zero = b.imm(0)
  b.stwS(zero, base, zero, 4, 0)
  b.stwS(zero, base, one, 4, 0)
  const i = b.imm(2)
  const outer = b.lab()
  const outerDone = b.lab()
  const nextI = b.lab()
  b.label(outer)
  const ii = b.mul(i, i)
  b.blt(nR, ii, outerDone)
  const flag = b.ldwS(base, i, 4, 0)
  b.beq(flag, zero, nextI)
  const j = b.mul(i, i)
  const inner = b.lab()
  const innerDone = b.lab()
  b.label(inner)
  b.blt(nR, j, innerDone)
  b.stwS(zero, base, j, 4, 0)
  b.addTo(j, j, i)
  b.br(inner)
  b.label(innerDone)
  b.label(nextI)
  b.addTo(i, i, one)
  b.br(outer)
  b.label(outerDone)
  const k = b.imm(2)
  const count = b.imm(0)
  const cLoop = b.lab()
  const cDone = b.lab()
  b.label(cLoop)
  b.blt(nR, k, cDone)
  const f = b.ldwS(base, k, 4, 0)
  b.beq(f, zero, 'skip')
  b.addTo(count, count, one)
  b.label('skip')
  b.addTo(k, k, one)
  b.br(cLoop)
  b.label(cDone)
  b.halt(count)
  return finish(b, mem, expected, false, 'Sieve of Eratosthenes. Strided stores and a final reduction.')
}

function checksum(n: number, seed: number): BuiltWorkload {
  const k0 = 0x9e3779b9
  let h = seed | 0
  for (let i = 0; i < n; i++) {
    h = i32(h ^ i)
    const rot = i32((h << 5) | (h >>> 27))
    h = i32(rot + k0)
    h = i32(h ^ (h >>> 7))
  }

  const b = new IrBuilder()
  const i = b.imm(0)
  const acc = b.imm(seed)
  const lim = b.imm(n)
  const one = b.imm(1)
  const five = b.imm(5)
  const tw7 = b.imm(27)
  const seven = b.imm(7)
  const gold = b.imm(k0)
  const top = b.lab()
  const done = b.lab()
  b.label(top)
  b.bge(i, lim, done)
  b.binTo('xor', acc, acc, i)
  const left = b.shl(acc, five)
  const right = b.shr(acc, tw7)
  const rot = b.or(left, right)
  b.addTo(acc, rot, gold)
  const hi = b.shr(acc, seven)
  b.binTo('xor', acc, acc, hi)
  b.addTo(i, i, one)
  b.br(top)
  b.label(done)
  b.halt(acc)
  return finish(b, freshMem(), h, false, 'Rotate-xor mix. ALU-bound, almost no memory traffic.')
}

function pointerChase(n: number, seed: number): BuiltWorkload {
  const addr = DATA_BASE
  const mem = freshMem()
  const view = new DataView(mem)
  const idx = Array.from({ length: n }, (_, i) => i)
  const rng = lcg(seed)
  for (let i = n - 1; i > 0; i--) {
    const j = (rng() >>> 0) % (i + 1)
    const tmp = idx[i]
    idx[i] = idx[j]
    idx[j] = tmp
  }
  const nextOf = new Int32Array(n)
  for (let i = 0; i < n; i++) nextOf[idx[i]] = idx[(i + 1) % n]
  for (let i = 0; i < n; i++) {
    view.setInt32(addr + i * 8, addr + nextOf[i] * 8, true)
    view.setInt32(addr + i * 8 + 4, (i * 17 + seed) | 0, true)
  }
  let p = addr
  let expected = 0
  for (let step = 0; step < n; step++) {
    expected = i32(expected + view.getInt32(p + 4, true))
    p = view.getInt32(p, true)
  }

  const b = new IrBuilder()
  const ptr = b.imm(addr)
  const steps = b.imm(0)
  const lim = b.imm(n)
  const one = b.imm(1)
  const acc = b.imm(0)
  const top = b.lab()
  const done = b.lab()
  b.label(top)
  b.bge(steps, lim, done)
  const val = b.ldw(ptr, 4)
  b.addTo(acc, acc, val)
  const nxt = b.ldw(ptr, 0)
  b.movTo(ptr, nxt)
  b.addTo(steps, steps, one)
  b.br(top)
  b.label(done)
  b.halt(acc)
  return finish(b, mem, expected, false, 'Pointer chasing through a random cycle. Memory-latency bound.')
}

function firFilter(n: number, seed: number): BuiltWorkload {
  const taps = 8
  const cAddr = DATA_BASE
  const xAddr = DATA_BASE + 64
  const yAddr = xAddr + n * 4
  const mem = freshMem()
  const view = new DataView(mem)
  const rng = lcg(seed)
  const coeffs = [1, -2, 3, -1, 2, 1, -1, 1]
  coeffs.forEach((c, i) => view.setInt32(cAddr + i * 4, c, true))
  fillWords(view, xAddr, n, () => (rng() % 21) - 10)
  let expected = 0
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let k = 0; k < taps; k++) {
      const idx = i - k
      const x = idx >= 0 ? view.getInt32(xAddr + idx * 4, true) : 0
      acc = i32(acc + imul(coeffs[k], x))
    }
    expected = i32(expected + acc)
  }

  const b = new IrBuilder()
  const tid = b.tid()
  const nth = b.nthreads()
  const i = b.mov(tid)
  const lim = b.imm(n)
  const one = b.imm(1)
  const zero = b.imm(0)
  const tapsR = b.imm(taps)
  const baseC = b.imm(cAddr)
  const baseX = b.imm(xAddr)
  const baseY = b.imm(yAddr)
  const total = b.imm(0)
  const outer = b.lab()
  const outerDone = b.lab()
  b.label(outer)
  b.bge(i, lim, outerDone)
  const acc = b.imm(0)
  const k = b.imm(0)
  const inner = b.lab()
  const innerDone = b.lab()
  const useZero = b.lab()
  const afterX = b.lab()
  b.label(inner)
  b.bge(k, tapsR, innerDone)
  const idx = b.sub(i, k)
  b.blt(idx, zero, useZero)
  const xv = b.ldwS(baseX, idx, 4, 0)
  b.br(afterX)
  b.label(useZero)
  b.movTo(xv, zero)
  b.label(afterX)
  const c = b.ldwS(baseC, k, 4, 0)
  const p = b.mul(c, xv)
  b.addTo(acc, acc, p)
  b.addTo(k, k, one)
  b.br(inner)
  b.label(innerDone)
  b.stwS(acc, baseY, i, 4, 0)
  b.addTo(total, total, acc)
  b.addTo(i, i, nth)
  b.br(outer)
  b.label(outerDone)
  reducePartials(b, total, tid, nth, false)
  return finish(b, mem, expected, false, '8-tap FIR striped across threads. Short inner kernel with sliding window loads.', n)
}

function fpSum(n: number, seed: number): BuiltWorkload {
  const addr = DATA_BASE
  const mem = freshMem()
  const view = new DataView(mem)
  const rng = lcg(seed)
  fillFloats(view, addr, n, () => ((rng() % 2001) - 1000) / 100)
  let expected = 0
  for (let i = 0; i < n; i++) expected += view.getFloat64(addr + i * 8, true)

  const b = new IrBuilder()
  const i = b.imm(0)
  const lim = b.imm(n)
  const one = b.imm(1)
  const acc = b.immf(0)
  const base = b.imm(addr)
  const top = b.lab()
  const done = b.lab()
  b.label(top)
  b.bge(i, lim, done)
  const v = b.lddS(base, i, 8, 0)
  b.addfTo(acc, acc, v)
  b.addTo(i, i, one)
  b.br(top)
  b.label(done)
  b.halt(acc)
  return finish(b, mem, expected, true, 'Streaming double-precision reduction.')
}

export const WORKLOADS: WorkloadDef[] = [
  {
    id: 'int_sum',
    name: 'Integer sum',
    blurb: 'Accumulate 0 .. N-1. The simplest equal-work loop.',
    category: 'integer',
    defaultN: 512,
    minN: 8,
    maxN: 20000,
    nLabel: 'N (terms)',
    usesSeed: false,
    nRole: 'problem-size',
    parallelSemantics: 'spmd-striped',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: (n) => intSum(n),
  },
  {
    id: 'dot_product',
    name: 'Dot product',
    blurb: 'Integer inner product of two length-N vectors.',
    category: 'integer',
    defaultN: 256,
    minN: 8,
    maxN: 8192,
    nLabel: 'N (elements)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'spmd-striped',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: dotProduct,
  },
  {
    id: 'saxpy',
    name: 'SAXPY',
    blurb: 'y[i] += a·x[i] over N elements, then checksum Y.',
    category: 'mixed',
    defaultN: 256,
    minN: 8,
    maxN: 4096,
    nLabel: 'N (elements)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'spmd-striped',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: saxpy,
  },
  {
    id: 'memcpy',
    name: 'Memcpy',
    blurb: 'Copy N words and checksum the destination.',
    category: 'memory',
    defaultN: 256,
    minN: 8,
    maxN: 4096,
    nLabel: 'N (words)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'spmd-striped',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: memcpyWords,
  },
  {
    id: 'matmul',
    name: 'Matrix multiply',
    blurb: 'Dense n×n integer GEMM with a result checksum.',
    category: 'mixed',
    defaultN: 8,
    minN: 2,
    maxN: 20,
    nLabel: 'n (dimension)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'spmd-striped',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: matmul,
  },
  {
    id: 'insertion_sort',
    name: 'Insertion sort',
    blurb: 'Sort N integers in place. Heavy on data-dependent branches.',
    category: 'control',
    defaultN: 48,
    minN: 4,
    maxN: 192,
    nLabel: 'N (elements)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'serial',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: insertionSort,
  },
  {
    id: 'binary_search',
    name: 'Binary search',
    blurb: 'N searches over a sorted table of N keys.',
    category: 'control',
    defaultN: 64,
    minN: 8,
    maxN: 512,
    nLabel: 'N (keys)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'spmd-striped',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: binarySearch,
  },
  {
    id: 'sieve',
    name: 'Prime sieve',
    blurb: 'Count primes up to N with the sieve of Eratosthenes.',
    category: 'integer',
    defaultN: 400,
    minN: 16,
    maxN: 4000,
    nLabel: 'N (limit)',
    usesSeed: false,
    nRole: 'problem-size',
    parallelSemantics: 'serial',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: (n) => sieve(n),
  },
  {
    id: 'checksum',
    name: 'Checksum mix',
    blurb: 'Rotate-xor integer mix. Almost purely ALU-bound.',
    category: 'integer',
    defaultN: 1024,
    minN: 16,
    maxN: 20000,
    nLabel: 'N (rounds)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'serial',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: checksum,
  },
  {
    id: 'pointer_chase',
    name: 'Pointer chase',
    blurb: 'Walk a random linked cycle for N steps.',
    category: 'memory',
    defaultN: 128,
    minN: 8,
    maxN: 1024,
    nLabel: 'N (nodes)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'serial',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: pointerChase,
  },
  {
    id: 'fir',
    name: 'FIR filter',
    blurb: '8-tap FIR over N samples, integer coefficients.',
    category: 'mixed',
    defaultN: 96,
    minN: 8,
    maxN: 512,
    nLabel: 'N (samples)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'spmd-striped',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: firFilter,
  },
  {
    id: 'fp_sum',
    name: 'FP reduction',
    blurb: 'Sum N IEEE-754 doubles.',
    category: 'fp',
    defaultN: 256,
    minN: 8,
    maxN: 2048,
    nLabel: 'N (values)',
    usesSeed: true,
    nRole: 'problem-size',
    parallelSemantics: 'serial',
    referenceOracle: 'independent-host-model',
    hasIndependentExpectedCheck: true,
    build: fpSum,
  },
]

export function workloadById(id: string): WorkloadDef {
  const w = WORKLOADS.find((x) => x.id === id)
  if (!w) throw new Error(`Unknown workload "${id}"`)
  return w
}
