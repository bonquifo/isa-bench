/**
 * ELF reader and loader for the real-ISA interpreters.
 *
 * Deliberately handles both classes and both byte orders even though
 * milestone 1 only needs ELF64 little-endian: the same loader has to serve
 * MIPS, POWER and SPARC later, and a second copy written under time pressure
 * for the big-endian targets is how the two quietly drift apart.
 *
 * Everything it will not do, it refuses by name. A dynamically linked or
 * position-independent executable needs relocation processing that does not
 * exist here yet, so it is rejected with an explanation rather than loaded
 * at the wrong address and executed into nonsense.
 */
import { GuestMemory, Prot } from './memory.ts'
import { IsaError } from './errors.ts'

export class ElfError extends IsaError {}

export const ElfMachine = {
  SPARC: 2,
  MIPS: 8,
  PPC64: 21,
  X86_64: 62,
  AARCH64: 183,
  RISCV: 243,
  /**
   * Not a registered value. LLVM picked 6502 for the 6502 -- the decimal
   * number, which as hex is 0x1966 -- and since llvm-mos is the only
   * toolchain that emits these objects, it is the value that exists.
   */
  MOS: 6502,
} as const

const ET_EXEC = 2
const ET_DYN = 3
const PT_LOAD = 1
const SHT_SYMTAB = 2
const PF_X = 1
const PF_W = 2
const PF_R = 4

export interface ElfSegment {
  vaddr: bigint
  offset: number
  filesz: number
  memsz: number
  flags: number
}

export interface ElfSection {
  name: string
  addr: bigint
  offset: number
  size: number
  type: number
}

export interface ElfSymbol {
  name: string
  value: bigint
  size: bigint
}

export interface ElfImage {
  bits: 32 | 64
  littleEndian: boolean
  machine: number
  entry: bigint
  segments: ElfSegment[]
  sections: ElfSection[]
  symbols: Map<string, ElfSymbol>
  /**
   * Where the program header table ends up in the guest's address space.
   * A libc reads it through the auxiliary vector at startup, so it has to be
   * translated from a file offset to an address here.
   */
  phdrAddress: bigint
  phentsize: number
  phnum: number
}

/** Reads the width-dependent fields so the header walk reads the same either way. */
class Reader {
  private readonly view: DataView
  readonly bits: 32 | 64
  readonly littleEndian: boolean

  constructor(bytes: Uint8Array, bits: 32 | 64, littleEndian: boolean) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.bits = bits
    this.littleEndian = littleEndian
  }

  u16(at: number): number {
    return this.view.getUint16(at, this.littleEndian)
  }

  u32(at: number): number {
    return this.view.getUint32(at, this.littleEndian)
  }

  /** An address- or offset-sized field: 4 bytes on ELF32, 8 on ELF64. */
  addr(at: number): bigint {
    return this.bits === 64
      ? this.view.getBigUint64(at, this.littleEndian)
      : BigInt(this.view.getUint32(at, this.littleEndian))
  }
}

const DECODER = new TextDecoder()

function cString(bytes: Uint8Array, at: number): string {
  let end = at
  while (end < bytes.length && bytes[end] !== 0) end += 1
  return DECODER.decode(bytes.subarray(at, end))
}

export function parseElf(bytes: Uint8Array): ElfImage {
  if (bytes.length < 52) throw new ElfError('not an ELF file: too short')
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new ElfError('not an ELF file: bad magic')
  }
  const klass = bytes[4]
  const data = bytes[5]
  if (klass !== 1 && klass !== 2) throw new ElfError(`unsupported ELF class ${klass}`)
  if (data !== 1 && data !== 2) throw new ElfError(`unsupported ELF data encoding ${data}`)
  const bits = klass === 2 ? 64 : 32
  const littleEndian = data === 1
  const r = new Reader(bytes, bits, littleEndian)

  const type = r.u16(16)
  const machine = r.u16(18)
  // Field offsets diverge after e_version because e_entry is address-sized.
  const wordSize = bits === 64 ? 8 : 4
  const eEntry = 24
  const ePhoff = eEntry + wordSize
  const eShoff = ePhoff + wordSize
  const eFlags = eShoff + wordSize
  const entry = r.addr(eEntry)
  const phoff = Number(r.addr(ePhoff))
  const shoff = Number(r.addr(eShoff))
  const phentsize = r.u16(eFlags + 6)
  const phnum = r.u16(eFlags + 8)
  const shentsize = r.u16(eFlags + 10)
  const shnum = r.u16(eFlags + 12)
  const shstrndx = r.u16(eFlags + 14)

  if (type === ET_DYN) {
    throw new ElfError(
      'position-independent executable: this loader applies no dynamic relocations. ' +
      'Link with -no-pie -static.',
    )
  }
  if (type !== ET_EXEC) throw new ElfError(`unsupported ELF type ${type}: expected ET_EXEC`)

  const segments: ElfSegment[] = []
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize
    if (at + phentsize > bytes.length) throw new ElfError('program header table runs past end of file')
    const pType = r.u32(at)
    if (pType !== PT_LOAD) continue
    const flags = bits === 64 ? r.u32(at + 4) : r.u32(at + 24)
    const base = bits === 64 ? at + 8 : at + 4
    const offset = Number(r.addr(base))
    const vaddr = r.addr(base + wordSize)
    const filesz = Number(r.addr(base + 3 * wordSize))
    const memsz = Number(r.addr(base + 4 * wordSize))
    if (offset + filesz > bytes.length) throw new ElfError('PT_LOAD segment runs past end of file')
    segments.push({ vaddr, offset, filesz, memsz, flags })
  }
  if (segments.length === 0) throw new ElfError('no PT_LOAD segments')

  const sections: ElfSection[] = []
  const symbols = new Map<string, ElfSymbol>()
  if (shoff > 0 && shnum > 0) {
    const rawSections: {
      nameOff: number
      type: number
      addr: bigint
      offset: number
      size: number
      link: number
    }[] = []
    for (let i = 0; i < shnum; i++) {
      const at = shoff + i * shentsize
      if (at + shentsize > bytes.length) throw new ElfError('section header table runs past end of file')
      const flagsAt = at + 8
      const addr = r.addr(flagsAt + wordSize)
      const offset = Number(r.addr(flagsAt + 2 * wordSize))
      const size = Number(r.addr(flagsAt + 3 * wordSize))
      const link = r.u32(flagsAt + 4 * wordSize)
      rawSections.push({ nameOff: r.u32(at), type: r.u32(at + 4), addr, offset, size, link })
    }
    const shstr = rawSections[shstrndx]
    const nameOf = (off: number): string =>
      shstr ? cString(bytes, shstr.offset + off) : ''
    for (const section of rawSections) {
      sections.push({
        name: nameOf(section.nameOff),
        addr: section.addr,
        offset: section.offset,
        size: section.size,
        type: section.type,
      })
    }
    for (const section of rawSections) {
      if (section.type !== SHT_SYMTAB) continue
      const strtab = rawSections[section.link]
      if (!strtab) continue
      const symSize = bits === 64 ? 24 : 16
      for (let at = section.offset; at + symSize <= section.offset + section.size; at += symSize) {
        const nameOff = r.u32(at)
        const value = bits === 64 ? r.addr(at + 8) : r.addr(at + 4)
        const size = bits === 64 ? r.addr(at + 16) : r.addr(at + 8)
        const name = cString(bytes, strtab.offset + nameOff)
        if (name) symbols.set(name, { name, value, size })
      }
    }
  }

  // AT_PHDR wants the address the program headers were loaded at. They sit at
  // a file offset, so the segment that contains that offset gives the mapping.
  let phdrAddress = 0n
  for (const segment of segments) {
    if (phoff >= segment.offset && phoff < segment.offset + segment.filesz) {
      phdrAddress = segment.vaddr + BigInt(phoff - segment.offset)
      break
    }
  }

  return {
    bits,
    littleEndian,
    machine,
    entry,
    segments,
    sections,
    symbols,
    phdrAddress,
    phentsize,
    phnum,
  }
}

function protOf(flags: number): number {
  let prot = 0
  if (flags & PF_R) prot |= Prot.READ
  if (flags & PF_W) prot |= Prot.WRITE
  if (flags & PF_X) prot |= Prot.EXEC
  // A segment with no flags at all would be unreachable; treat it as readable
  // rather than silently mapping something the guest cannot touch.
  return prot === 0 ? Prot.READ : prot
}

/**
 * Maps every PT_LOAD segment and copies its file contents in. `memsz` beyond
 * `filesz` is the .bss and stays zero, which is what the fresh page already is.
 */
export function loadElf(image: ElfImage, bytes: Uint8Array, mem: GuestMemory): void {
  if (image.littleEndian !== mem.littleEndian) {
    throw new ElfError(
      `ELF byte order does not match the guest memory it is being loaded into ` +
      `(ELF ${image.littleEndian ? 'LSB' : 'MSB'})`,
    )
  }
  for (const segment of image.segments) {
    mem.map(segment.vaddr, Math.max(segment.memsz, segment.filesz), protOf(segment.flags))
    if (segment.filesz > 0) {
      mem.writeBytesRaw(segment.vaddr, bytes.subarray(segment.offset, segment.offset + segment.filesz))
    }
  }
}

/** Highest byte any PT_LOAD segment occupies; where a heap can start. */
export function imageEnd(image: ElfImage): bigint {
  let end = 0n
  for (const segment of image.segments) {
    const segmentEnd = segment.vaddr + BigInt(Math.max(segment.memsz, segment.filesz))
    if (segmentEnd > end) end = segmentEnd
  }
  return end
}
