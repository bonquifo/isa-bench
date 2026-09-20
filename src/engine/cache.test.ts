import { describe, expect, it } from 'vitest'
import { DramScheduler, SetCache } from './cache.ts'

function cache(sizeBytes: number, ways: number, lineBytes = 64): SetCache {
  return new SetCache({ sizeBytes, ways, lineBytes })
}

describe('set-associative LRU cache', () => {
  it('treats exactly zero as disabled and positive sub-KiB sizes as enabled', () => {
    const disabled = cache(0, 1, 64)
    expect(disabled.lookup(0)).toBe(false)
    disabled.fill(0)
    expect(disabled.has(0)).toBe(false)

    const tiny = cache(64, 1, 64)
    expect(tiny.lookup(0)).toBe(false)
    tiny.fill(0)
    expect(tiny.has(0)).toBe(true)
    expect(tiny.lookup(0)).toBe(true)
  })

  it('computes the set count from capacity / (line × ways)', () => {
    const c = cache(1024, 4, 64)
    expect(c.sets).toBe(4)
    expect(c.ways).toBe(4)
    expect(c.lineBytes).toBe(64)
  })

  it('treats a cold access as a compulsory miss, then hits the same line', () => {
    const c = cache(1024, 2, 64)
    expect(c.probe(0x1000)).toBe(false)
    expect(c.probe(0x1000)).toBe(true)
    expect(c.probe(0x1004)).toBe(true)
    expect(c.probe(0x103f)).toBe(true)
    expect(c.hits).toBe(3)
    expect(c.misses).toBe(1)
  })

  it('does not share a fill across a line boundary', () => {
    const c = cache(4096, 1, 64)
    expect(c.probe(0x1000)).toBe(false)
    expect(c.probe(0x1040)).toBe(false)
    expect(c.misses).toBe(2)
  })

  it('conflicts in a direct-mapped cache when tags share a set', () => {
    const c = cache(128, 1, 64)
    expect(c.sets).toBe(2)
    expect(c.probe(0x0000)).toBe(false)
    expect(c.probe(0x0080)).toBe(false)
    expect(c.probe(0x0000)).toBe(false)
    expect(c.hits).toBe(0)
    expect(c.misses).toBe(3)
  })

  it('keeps two conflicting lines in a 2-way set (no ping-pong)', () => {
    const c = cache(128, 2, 64)
    expect(c.sets).toBe(1)
    expect(c.probe(0x0000)).toBe(false)
    expect(c.probe(0x0040)).toBe(false)
    expect(c.probe(0x0000)).toBe(true)
    expect(c.probe(0x0040)).toBe(true)
    expect(c.hits).toBe(2)
    expect(c.misses).toBe(2)
  })

  it('evicts the least-recently-used way', () => {
    const c = cache(128, 2, 64)
    c.probe(0x0000)
    c.probe(0x0040)
    c.probe(0x0000)
    expect(c.probe(0x0080)).toBe(false)
    expect(c.probe(0x0000)).toBe(true)
    expect(c.probe(0x0040)).toBe(false)
  })

  it('resets hit/miss counters without flushing tags', () => {
    const c = cache(256, 1, 64)
    c.probe(0)
    c.resetStats()
    expect(c.hits).toBe(0)
    expect(c.misses).toBe(0)
    expect(c.probe(0)).toBe(true)
    expect(c.hits).toBe(1)
  })

  it('rejects invalid geometry and non-power-of-two lines', () => {
    expect(() => cache(16, 8, 64)).toThrow(/sizeBytes/)
    expect(() => cache(1024, 0, 64)).toThrow(/ways/)
    expect(() => cache(1024, 1, 48)).toThrow(/power of two/)
    expect(() => cache(1024, 1, 4294967297)).toThrow(/safe power of two/)
    expect(() => cache(4294967297, 1, 64)).toThrow(/capacity exceeds/)
    expect(() => cache(64, 5000, 64)).toThrow(/associativity exceeds/)
  })

  it('separates lookup, fill, touch, and invalidation', () => {
    const c = cache(256, 1, 64)
    expect(c.lookup(4)).toBe(false)
    expect(c.lookup(4)).toBe(false)
    c.fill(4)
    expect(c.lookup(63)).toBe(true)
    expect(c.invalidate(32)).toBe(true)
    expect(c.invalidate(32)).toBe(false)
    expect(c.lookup(4)).toBe(false)
  })

  it('enumerates every line intersecting a byte range', () => {
    const c = cache(256, 1, 64)
    expect(c.lineAddresses(63, 1)).toEqual([0])
    expect(c.lineAddresses(63, 2)).toEqual([0, 64])
    expect(c.lineAddresses(60, 132)).toEqual([0, 64, 128])
  })
})

describe('deterministic DRAM channels', () => {
  it('uses earliest-channel availability and stable ties exactly', () => {
    const dram = new DramScheduler(2, 3)
    const requests = [
      dram.request(10, 20),
      dram.request(10, 20),
      dram.request(10, 20),
      dram.request(10, 20),
      dram.request(12, 20),
    ]
    expect(requests.map((r) => [r.channel, r.start, r.ready, r.queueCycles])).toEqual([
      [0, 10, 30, 0],
      [1, 10, 30, 0],
      [0, 13, 33, 3],
      [1, 13, 33, 3],
      [0, 16, 36, 4],
    ])
  })
})
