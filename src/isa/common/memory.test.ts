import { describe, expect, it } from 'vitest'
import { GuestFault } from './errors.ts'
import { GuestMemory, PAGE_SIZE, Prot } from './memory.ts'

const RW = Prot.READ | Prot.WRITE

function fresh(littleEndian = true): GuestMemory {
  const mem = new GuestMemory(littleEndian)
  mem.map(0x10000n, 4 * PAGE_SIZE, RW)
  return mem
}

describe('GuestMemory widths and signedness', () => {
  it('round-trips every width', () => {
    const mem = fresh()
    for (const [width, value] of [[1, 0x7fn], [2, 0x7fffn], [4, 0x7fffffffn], [8, 2n ** 63n - 1n]] as const) {
      mem.store(0x10000n, width, value)
      expect(mem.load(0x10000n, width, false)).toBe(value)
      expect(mem.load(0x10000n, width, true)).toBe(value)
    }
  })

  it('sign-extends and zero-extends the same bytes differently', () => {
    const mem = fresh()
    mem.store(0x10010n, 1, 0xffn)
    expect(mem.load(0x10010n, 1, true)).toBe(-1n)
    expect(mem.load(0x10010n, 1, false)).toBe(0xffn)

    mem.store(0x10020n, 2, 0x8000n)
    expect(mem.load(0x10020n, 2, true)).toBe(-32768n)
    expect(mem.load(0x10020n, 2, false)).toBe(0x8000n)

    mem.store(0x10030n, 4, 0x80000000n)
    expect(mem.load(0x10030n, 4, true)).toBe(-2147483648n)
    expect(mem.load(0x10030n, 4, false)).toBe(0x80000000n)

    mem.store(0x10040n, 8, -1n)
    expect(mem.load(0x10040n, 8, true)).toBe(-1n)
    expect(mem.load(0x10040n, 8, false)).toBe(2n ** 64n - 1n)
  })

  it('truncates a store to its width and leaves neighbours alone', () => {
    const mem = fresh()
    mem.store(0x10100n, 8, 0n)
    mem.store(0x10100n, 1, 0x1234n)
    expect(mem.load(0x10100n, 1, false)).toBe(0x34n)
    expect(mem.load(0x10101n, 1, false)).toBe(0n)
  })
})

describe('GuestMemory endianness', () => {
  it('lays bytes out little-endian', () => {
    const mem = fresh(true)
    mem.store(0x10000n, 4, 0x11223344n)
    expect([...mem.readBytes(0x10000n, 4)]).toEqual([0x44, 0x33, 0x22, 0x11])
  })

  it('lays bytes out big-endian', () => {
    const mem = fresh(false)
    mem.store(0x10000n, 4, 0x11223344n)
    expect([...mem.readBytes(0x10000n, 4)]).toEqual([0x11, 0x22, 0x33, 0x44])
  })

  it('agrees between the fast and page-crossing paths in both orders', () => {
    for (const littleEndian of [true, false]) {
      const mem = new GuestMemory(littleEndian)
      mem.map(0x10000n, 2 * PAGE_SIZE, RW)
      const straddle = 0x10000n + BigInt(PAGE_SIZE) - 3n
      mem.store(straddle, 8, 0x0123456789abcdefn)
      expect(mem.load(straddle, 8, false)).toBe(0x0123456789abcdefn)
      const bytes = mem.readBytes(straddle, 8)
      const aligned = new GuestMemory(littleEndian)
      aligned.map(0x20000n, PAGE_SIZE, RW)
      aligned.store(0x20000n, 8, 0x0123456789abcdefn)
      expect([...bytes]).toEqual([...aligned.readBytes(0x20000n, 8)])
    }
  })
})

describe('GuestMemory unaligned and page-crossing access', () => {
  it('handles every unaligned offset for every width', () => {
    const mem = fresh()
    for (let offset = 0; offset < 16; offset++) {
      const at = 0x10200n + BigInt(offset)
      mem.store(at, 8, 0x8899aabbccddeeffn)
      expect(mem.load(at, 8, false)).toBe(0x8899aabbccddeeffn)
      mem.store(at, 2, 0xbeefn)
      expect(mem.load(at, 2, false)).toBe(0xbeefn)
    }
  })

  it('crosses a page boundary at every straddling offset', () => {
    const mem = fresh()
    const boundary = 0x10000n + BigInt(PAGE_SIZE)
    for (let back = 1; back <= 7; back++) {
      const at = boundary - BigInt(back)
      mem.store(at, 8, 0x0f1e2d3c4b5a6978n)
      expect(mem.load(at, 8, false)).toBe(0x0f1e2d3c4b5a6978n)
    }
  })

  it('faults when only one side of a straddling access is mapped', () => {
    const mem = new GuestMemory(true)
    mem.map(0x10000n, PAGE_SIZE, RW)
    const at = 0x10000n + BigInt(PAGE_SIZE) - 2n
    expect(() => mem.load(at, 8, false)).toThrow(GuestFault)
    expect(() => mem.store(at, 8, 1n)).toThrow(GuestFault)
  })
})

describe('GuestMemory faults', () => {
  it('faults on an unmapped address rather than conjuring a page', () => {
    const mem = fresh()
    expect(() => mem.load(0x90000n, 4, false)).toThrow(/unmapped/)
    expect(() => mem.store(0x90000n, 4, 1n)).toThrow(/unmapped/)
    expect(mem.ranges()).toHaveLength(1)
  })

  it('faults on a write to a read-only page', () => {
    const mem = new GuestMemory(true)
    mem.map(0x10000n, PAGE_SIZE, Prot.READ | Prot.EXEC)
    expect(mem.load(0x10000n, 4, false)).toBe(0n)
    expect(() => mem.store(0x10000n, 4, 1n)).toThrow(/protection/)
  })

  it('faults on execute from a page without EXEC', () => {
    const mem = fresh()
    expect(() => mem.fetchHalf(0x10000n)).toThrow(/protection/)
  })

  it('faults beyond the supported address range instead of losing precision', () => {
    const mem = fresh()
    expect(() => mem.load(-1n, 8, false)).toThrow(/supported address range/)
    expect(() => mem.map(2n ** 50n, 16, RW)).toThrow(/supported address range/)
  })

  it('reports the faulting address in the message', () => {
    const mem = fresh()
    expect(() => mem.load(0x90000n, 4, false)).toThrow(/0x90000/)
  })
})

describe('GuestMemory bulk access', () => {
  it('writes and reads byte runs', () => {
    const mem = fresh()
    const data = Uint8Array.from([1, 2, 3, 4, 5])
    mem.writeBytes(0x10050n, data)
    expect([...mem.readBytes(0x10050n, 5)]).toEqual([1, 2, 3, 4, 5])
  })

  it('writeBytesRaw bypasses protection but not mapping', () => {
    const mem = new GuestMemory(true)
    mem.map(0x10000n, PAGE_SIZE, Prot.READ | Prot.EXEC)
    mem.writeBytesRaw(0x10000n, Uint8Array.from([0xaa, 0xbb]))
    expect(mem.load(0x10000n, 2, false)).toBe(0xbbaan)
    expect(() => mem.writeBytesRaw(0x20000n, Uint8Array.from([1]))).toThrow(GuestFault)
  })

  it('fetches instruction halfwords including across a page boundary', () => {
    const mem = new GuestMemory(true)
    mem.map(0x10000n, 2 * PAGE_SIZE, Prot.READ | Prot.EXEC)
    mem.writeBytesRaw(0x10000n, Uint8Array.from([0x82, 0x80]))
    expect(mem.fetchHalf(0x10000n)).toBe(0x8082)
    const boundary = 0x10000n + BigInt(PAGE_SIZE) - 1n
    mem.writeBytesRaw(boundary, Uint8Array.from([0x13, 0x05]))
    expect(mem.fetchHalf(boundary)).toBe(0x0513)
  })
})

describe('GuestMemory mapping', () => {
  it('ignores an empty map and coalesces adjacent pages', () => {
    const mem = new GuestMemory(true)
    mem.map(0x10000n, 0, RW)
    expect(mem.ranges()).toEqual([])
    mem.map(0x10000n, PAGE_SIZE, RW)
    mem.map(0x11000n, PAGE_SIZE, RW)
    expect(mem.ranges()).toEqual([{ start: 0x10000n, end: 0x12000n, prot: RW }])
  })

  it('splits ranges that differ in protection and widens on re-map', () => {
    const mem = new GuestMemory(true)
    mem.map(0x10000n, PAGE_SIZE, Prot.READ)
    mem.map(0x11000n, PAGE_SIZE, RW)
    expect(mem.ranges()).toHaveLength(2)
    mem.map(0x10000n, PAGE_SIZE, Prot.WRITE)
    expect(mem.ranges()).toEqual([{ start: 0x10000n, end: 0x12000n, prot: RW }])
  })
})
