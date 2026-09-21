/**
 * The guest address space shared by every real-ISA interpreter.
 *
 * Sparse and page-granular, because a statically linked ELF puts its text near
 * 0x10000 and its stack near the top of the address space, and materialising
 * everything between them is not an option. Pages are 4 KiB, allocated on map
 * and never on access: touching an unmapped address is a fault, loudly, rather
 * than a silently conjured page of zeroes.
 *
 * Endianness is a constructor argument rather than a constant. RV64, AArch64
 * and x86-64 are little-endian; MIPS, POWER and SPARC in the configurations
 * this project targets are not. Getting that wrong produces plausible-looking
 * wrong answers, so there is one implementation and it is parameterised.
 */
import { GuestFault, type AccessKind } from './errors.ts'
import { u64 } from './bits64.ts'

const PAGE_BITS = 12
export const PAGE_SIZE = 1 << PAGE_BITS

/**
 * Addresses at or above this are unmapped without consulting the page table.
 * It keeps every address that can reach the page table inside the exactly
 * representable integer range, so the arithmetic below can use `number` rather
 * than `bigint` on the hot path. No target here maps anything this high; a
 * guest pointer that large is a wild pointer and faulting is the right answer.
 */
const ADDRESS_LIMIT = 2 ** 48

export const Prot = {
  READ: 1,
  WRITE: 2,
  EXEC: 4,
} as const

export type AccessWidth = 1 | 2 | 4 | 8

interface Page {
  bytes: Uint8Array
  view: DataView
  prot: number
}

export interface MappedRange {
  start: bigint
  end: bigint
  prot: number
}

export class GuestMemory {
  readonly littleEndian: boolean
  private readonly pages = new Map<number, Page>()
  /** Last page touched. Guest access is overwhelmingly local; this skips the Map. */
  private cachedIndex = -1
  private cachedPage: Page | null = null

  constructor(littleEndian: boolean) {
    this.littleEndian = littleEndian
  }

  /** Rounds out to page boundaries and zero-fills. Re-mapping widens protection. */
  map(addr: bigint, length: number, prot: number): void {
    if (length <= 0) return
    const start = Number(u64(addr))
    if (start >= ADDRESS_LIMIT) {
      throw new GuestFault('read', addr, length, 'map outside the supported address range')
    }
    const first = Math.floor(start / PAGE_SIZE)
    const last = Math.floor((start + length - 1) / PAGE_SIZE)
    for (let index = first; index <= last; index++) {
      const existing = this.pages.get(index)
      if (existing) {
        existing.prot |= prot
        continue
      }
      const bytes = new Uint8Array(PAGE_SIZE)
      this.pages.set(index, { bytes, view: new DataView(bytes.buffer), prot })
    }
    this.cachedIndex = -1
    this.cachedPage = null
  }

  /** Every mapped page, coalesced. For diagnostics and fault messages. */
  ranges(): MappedRange[] {
    const indices = [...this.pages.keys()].sort((a, b) => a - b)
    const out: MappedRange[] = []
    for (const index of indices) {
      const prot = this.pages.get(index)!.prot
      const last = out[out.length - 1]
      if (last && last.end === BigInt(index * PAGE_SIZE) && last.prot === prot) {
        last.end = BigInt((index + 1) * PAGE_SIZE)
        continue
      }
      out.push({
        start: BigInt(index * PAGE_SIZE),
        end: BigInt((index + 1) * PAGE_SIZE),
        prot,
      })
    }
    return out
  }

  private page(index: number): Page | undefined {
    if (index === this.cachedIndex) return this.cachedPage ?? undefined
    const found = this.pages.get(index)
    if (found) {
      this.cachedIndex = index
      this.cachedPage = found
    }
    return found
  }

  /** Resolves one byte, checking protection. Returns its page and page offset. */
  private locate(
    address: number,
    original: bigint,
    kind: AccessKind,
    width: number,
    need: number,
  ): { page: Page; offset: number } {
    if (address < 0 || address >= ADDRESS_LIMIT) {
      throw new GuestFault(kind, original, width, 'outside the supported address range')
    }
    const index = Math.floor(address / PAGE_SIZE)
    const page = this.page(index)
    if (!page) throw new GuestFault(kind, original, width, 'unmapped')
    if ((page.prot & need) === 0) {
      throw new GuestFault(kind, original, width, `protection: page has ${page.prot}, needs ${need}`)
    }
    return { page, offset: address - index * PAGE_SIZE }
  }

  /**
   * Reads `width` bytes. `signed` selects sign- or zero-extension to 64 bits,
   * which is what a load instruction ultimately asks for. Unaligned and
   * page-crossing accesses are supported: RV64 under Linux permits them, and a
   * model that mishandled them would diverge from the reference only on inputs
   * that happen to straddle a boundary, which is the worst way to be wrong.
   */
  load(addr: bigint, width: AccessWidth, signed: boolean): bigint {
    const address = Number(u64(addr))
    const index = Math.floor(address / PAGE_SIZE)
    const offset = address - index * PAGE_SIZE
    if (address < ADDRESS_LIMIT && offset + width <= PAGE_SIZE) {
      const { page } = this.locate(address, addr, 'read', width, Prot.READ)
      const view = page.view
      switch (width) {
        case 1:
          return BigInt(signed ? view.getInt8(offset) : view.getUint8(offset))
        case 2:
          return BigInt(signed
            ? view.getInt16(offset, this.littleEndian)
            : view.getUint16(offset, this.littleEndian))
        case 4:
          return BigInt(signed
            ? view.getInt32(offset, this.littleEndian)
            : view.getUint32(offset, this.littleEndian))
        default:
          return signed
            ? view.getBigInt64(offset, this.littleEndian)
            : view.getBigUint64(offset, this.littleEndian)
      }
    }
    return this.loadSlow(addr, address, width, signed)
  }

  /** Page-crossing path: assemble byte by byte, each byte permission-checked. */
  private loadSlow(addr: bigint, address: number, width: AccessWidth, signed: boolean): bigint {
    let value = 0n
    for (let i = 0; i < width; i++) {
      const { page, offset } = this.locate(address + i, addr, 'read', width, Prot.READ)
      const byte = BigInt(page.bytes[offset]!)
      value |= byte << BigInt(8 * (this.littleEndian ? i : width - 1 - i))
    }
    return signed ? BigInt.asIntN(8 * width, value) : value
  }

  store(addr: bigint, width: AccessWidth, value: bigint): void {
    const address = Number(u64(addr))
    const index = Math.floor(address / PAGE_SIZE)
    const offset = address - index * PAGE_SIZE
    if (address < ADDRESS_LIMIT && offset + width <= PAGE_SIZE) {
      const { page } = this.locate(address, addr, 'write', width, Prot.WRITE)
      const view = page.view
      switch (width) {
        case 1:
          view.setUint8(offset, Number(BigInt.asUintN(8, value)))
          return
        case 2:
          view.setUint16(offset, Number(BigInt.asUintN(16, value)), this.littleEndian)
          return
        case 4:
          view.setUint32(offset, Number(BigInt.asUintN(32, value)), this.littleEndian)
          return
        default:
          view.setBigUint64(offset, u64(value), this.littleEndian)
          return
      }
    }
    const bits = BigInt.asUintN(8 * width, value)
    for (let i = 0; i < width; i++) {
      const { page, offset: pageOffset } = this.locate(address + i, addr, 'write', width, Prot.WRITE)
      const shift = BigInt(8 * (this.littleEndian ? i : width - 1 - i))
      page.bytes[pageOffset] = Number((bits >> shift) & 0xffn)
    }
  }

  /**
   * Reads two bytes of instruction stream. Fetch is separate from load because
   * it needs EXEC rather than READ, and because a 4-byte instruction can
   * straddle a page boundary wherever the ISA allows 2-byte alignment, as
   * RISC-V does with the C extension.
   */
  fetchHalf(addr: bigint): number {
    const address = Number(u64(addr))
    const index = Math.floor(address / PAGE_SIZE)
    const offset = address - index * PAGE_SIZE
    if (address < ADDRESS_LIMIT && offset + 2 <= PAGE_SIZE) {
      const { page } = this.locate(address, addr, 'execute', 2, Prot.EXEC)
      return page.view.getUint16(offset, this.littleEndian)
    }
    const lo = this.locate(address, addr, 'execute', 2, Prot.EXEC)
    const hi = this.locate(address + 1, addr, 'execute', 2, Prot.EXEC)
    const a = lo.page.bytes[lo.offset]!
    const b = hi.page.bytes[hi.offset]!
    return this.littleEndian ? a | (b << 8) : (a << 8) | b
  }

  readBytes(addr: bigint, length: number): Uint8Array {
    const out = new Uint8Array(length)
    const address = Number(u64(addr))
    for (let i = 0; i < length; i++) {
      const { page, offset } = this.locate(address + i, addr, 'read', length, Prot.READ)
      out[i] = page.bytes[offset]!
    }
    return out
  }

  writeBytes(addr: bigint, data: Uint8Array): void {
    const address = Number(u64(addr))
    for (let i = 0; i < data.length; i++) {
      const { page, offset } = this.locate(address + i, addr, 'write', data.length, Prot.WRITE)
      page.bytes[offset] = data[i]!
    }
  }

  /**
   * Loader path: writes through protection so a read-only text segment can be
   * populated before the guest starts. Not reachable from guest execution.
   */
  writeBytesRaw(addr: bigint, data: Uint8Array): void {
    const address = Number(u64(addr))
    for (let i = 0; i < data.length; i++) {
      const target = address + i
      const index = Math.floor(target / PAGE_SIZE)
      const page = this.page(index)
      if (!page) throw new GuestFault('write', BigInt(target), data.length, 'unmapped')
      page.bytes[target - index * PAGE_SIZE] = data[i]!
    }
  }
}
