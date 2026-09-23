/**
 * A static linker for 32-bit SPARC, just large enough for the app's own
 * programs.
 *
 * lld cannot link 32-bit SPARC, and the fixtures are linked by GNU ld in a
 * container -- which the app, compiling a user's program on the user's
 * machine, does not have. So this does GNU ld's job for the one shape of
 * link the app needs: a handful of relocatable objects and two archives,
 * statically, into an executable the SPARC loader reads.
 *
 * It is deliberately narrow, and says so rather than guessing:
 *
 *   - Relocations: the five a non-PIC SPARC program and picolibc use --
 *     R_SPARC_32, WDISP30, WDISP22, HI22 and LO10. Any other stops the
 *     link with its name.
 *   - Layout: GNU ld's default for elf32_sparc -- text and read-only data
 *     from 0x10000, then writable data in the next 64 KiB page -- so the
 *     result looks to the loader like the binaries it already runs.
 *   - Symbols: strong beats weak, a weak undefined is zero, COMMON goes to
 *     .bss, and archive members are pulled until nothing more resolves
 *     (the `--start-group` rule). A symbol still undefined, or defined
 *     twice, is an error.
 *   - The linker-defined symbols picolibc reads: the bounds of the
 *     pre-init, init and fini arrays, and of .bss.
 *
 * Correctness is checked where it matters: the app's corpus, linked here
 * and by GNU ld, must produce the same output on the SPARC interpreter.
 */

const ET_REL = 1
const ET_EXEC = 2
const EM_SPARC = 2
const SHT_SYMTAB = 2
const SHT_RELA = 4
const SHT_NOBITS = 8
const SHT_INIT_ARRAY = 14
const SHT_FINI_ARRAY = 15
const SHT_PREINIT_ARRAY = 16
const SHF_WRITE = 0x1
const SHF_ALLOC = 0x2
const SHF_EXECINSTR = 0x4
const SHN_UNDEF = 0
const SHN_ABS = 0xfff1
const SHN_COMMON = 0xfff2
const STB_LOCAL = 0
const STB_WEAK = 2
const STT_SECTION = 3
const PT_LOAD = 1
const PT_GNU_STACK = 0x6474e551

const R_SPARC_32 = 3
const R_SPARC_WDISP30 = 7
const R_SPARC_WDISP22 = 8
const R_SPARC_HI22 = 9
const R_SPARC_LO10 = 12

const RELOCATION_NAMES: Readonly<Record<number, string>> = {
  [R_SPARC_32]: 'R_SPARC_32',
  [R_SPARC_WDISP30]: 'R_SPARC_WDISP30',
  [R_SPARC_WDISP22]: 'R_SPARC_WDISP22',
  [R_SPARC_HI22]: 'R_SPARC_HI22',
  [R_SPARC_LO10]: 'R_SPARC_LO10',
}

const TEXT_BASE = 0x10000
/** Two loadable segments and a non-executable-stack marker. */
const PROGRAM_HEADERS = 3
const PAGE = 0x10000

export class SparcLinkError extends Error {}

/** One input: an object file, or an archive to pull members from. */
export interface LinkInput {
  name: string
  bytes: Uint8Array
}

interface Section {
  index: number
  name: string
  type: number
  flags: number
  align: number
  size: number
  data: Uint8Array | null
  /** Where it landed in the output, once laid out. */
  address: number
  relocations: Relocation[]
}

interface Relocation {
  offset: number
  type: number
  symbol: number
  addend: number
}

interface ObjSymbol {
  name: string
  value: number
  size: number
  bind: number
  type: number
  section: number
}

interface ObjectFile {
  name: string
  sections: Section[]
  symbols: ObjSymbol[]
}

interface Definition {
  object: ObjectFile
  symbol: ObjSymbol
  weak: boolean
}

function read16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!
}

function read32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
}

function write32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff
  b[o + 1] = (v >>> 16) & 0xff
  b[o + 2] = (v >>> 8) & 0xff
  b[o + 3] = v & 0xff
}

function cstring(b: Uint8Array, o: number): string {
  let end = o
  while (end < b.length && b[end] !== 0) end++
  return new TextDecoder().decode(b.subarray(o, end))
}

function align(value: number, to: number): number {
  const a = Math.max(1, to)
  return Math.ceil(value / a) * a
}

/** Parses a big-endian ELF32 SPARC relocatable object. */
export function parseObject(name: string, b: Uint8Array): ObjectFile {
  if (b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46) {
    throw new SparcLinkError(`${name}: not an ELF file`)
  }
  if (b[4] !== 1 || b[5] !== 2) throw new SparcLinkError(`${name}: not 32-bit big-endian ELF`)
  if (read16(b, 16) !== ET_REL) throw new SparcLinkError(`${name}: not a relocatable object`)
  if (read16(b, 18) !== EM_SPARC) throw new SparcLinkError(`${name}: not a SPARC object`)
  const shoff = read32(b, 32)
  const shentsize = read16(b, 46)
  const shnum = read16(b, 48)
  const shstrndx = read16(b, 50)
  const header = (i: number) => {
    const o = shoff + i * shentsize
    return {
      name: read32(b, o), type: read32(b, o + 4), flags: read32(b, o + 8),
      offset: read32(b, o + 16), size: read32(b, o + 20), link: read32(b, o + 24),
      info: read32(b, o + 28), align: read32(b, o + 32),
    }
  }
  const names = header(shstrndx)
  const sections: Section[] = []
  const raw = Array.from({ length: shnum }, (_, i) => header(i))
  for (let i = 0; i < shnum; i++) {
    const h = raw[i]!
    sections.push({
      index: i,
      name: cstring(b, names.offset + h.name),
      type: h.type,
      flags: h.flags,
      align: h.align,
      size: h.size,
      data: h.type === SHT_NOBITS ? null : b.slice(h.offset, h.offset + h.size),
      address: 0,
      relocations: [],
    })
  }
  let symbols: ObjSymbol[] = []
  for (let i = 0; i < shnum; i++) {
    const h = raw[i]!
    if (h.type === SHT_SYMTAB) {
      const strtab = raw[h.link]!
      symbols = []
      for (let o = h.offset; o < h.offset + h.size; o += 16) {
        const info = b[o + 12]!
        symbols.push({
          name: cstring(b, strtab.offset + read32(b, o)),
          value: read32(b, o + 4),
          size: read32(b, o + 8),
          bind: info >> 4,
          type: info & 0xf,
          section: read16(b, o + 14),
        })
      }
    }
  }
  for (let i = 0; i < shnum; i++) {
    const h = raw[i]!
    if (h.type !== SHT_RELA) continue
    const target = sections[h.info]!
    for (let o = h.offset; o < h.offset + h.size; o += 12) {
      const info = read32(b, o + 4)
      target.relocations.push({
        offset: read32(b, o),
        type: info & 0xff,
        symbol: info >>> 8,
        addend: read32(b, o + 8) | 0,
      })
    }
  }
  return { name, sections, symbols }
}

/** The members of a GNU-format `ar` archive that are ELF objects. */
export function parseArchive(name: string, b: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const magic = new TextDecoder().decode(b.subarray(0, 8))
  if (magic !== '!<arch>\n') throw new SparcLinkError(`${name}: not an ar archive`)
  const members: { name: string; bytes: Uint8Array }[] = []
  let longNames = ''
  let o = 8
  while (o + 60 <= b.length) {
    const header = new TextDecoder().decode(b.subarray(o, o + 60))
    let memberName = header.slice(0, 16).trim()
    const size = Number(header.slice(48, 58).trim())
    const data = b.subarray(o + 60, o + 60 + size)
    if (memberName === '//') {
      longNames = new TextDecoder().decode(data)
    } else if (memberName !== '/' && memberName !== '/SYM64/') {
      if (memberName.startsWith('/')) {
        const at = Number(memberName.slice(1))
        memberName = longNames.slice(at, longNames.indexOf('/\n', at))
      } else if (memberName.endsWith('/')) {
        memberName = memberName.slice(0, -1)
      }
      members.push({ name: `${name}(${memberName})`, bytes: data })
    }
    o += 60 + size + (size % 2)
  }
  return members
}

function isArchive(b: Uint8Array): boolean {
  return new TextDecoder().decode(b.subarray(0, 8)) === '!<arch>\n'
}

/** Which output section an input section belongs to, or null to drop it. */
function outputOf(section: Section): string | null {
  if ((section.flags & SHF_ALLOC) === 0) return null
  const n = section.name
  if (section.type === SHT_PREINIT_ARRAY || n.startsWith('.preinit_array')) return '.preinit_array'
  if (section.type === SHT_INIT_ARRAY || n.startsWith('.init_array') || n.startsWith('.ctors')) return '.init_array'
  if (section.type === SHT_FINI_ARRAY || n.startsWith('.fini_array.') || n === '.fini_array' || n.startsWith('.dtors')) return '.fini_array'
  if (n === '.init' || n === '.fini') return n
  if ((section.flags & SHF_EXECINSTR) !== 0) return '.text'
  if (section.type === SHT_NOBITS) return '.bss'
  if ((section.flags & SHF_WRITE) === 0) return n.startsWith('.eh_frame') ? '.eh_frame' : '.rodata'
  if (n === '.fini_array_onexit') return '.fini_array_onexit'
  return '.data'
}

const TEXT_SEGMENT = ['.init', '.text', '.fini', '.rodata', '.eh_frame']
const DATA_SEGMENT = ['.preinit_array', '.init_array', '.fini_array', '.data', '.fini_array_onexit', '.bss']

/**
 * Links `inputs` -- objects and archives, in command-line order -- into an
 * executable whose entry point is `entry`.
 */
export function linkSparc(inputs: readonly LinkInput[], entry = '_start'): Uint8Array {
  const objects: ObjectFile[] = []
  const archives: { name: string; bytes: Uint8Array; used: boolean }[][] = []
  for (const input of inputs) {
    if (isArchive(input.bytes)) {
      archives.push(parseArchive(input.name, input.bytes).map((m) => ({ ...m, used: false })))
    } else {
      objects.push(parseObject(input.name, input.bytes))
    }
  }

  // ---- Resolution ------------------------------------------------------
  const defined = new Map<string, Definition>()
  const common = new Map<string, { size: number; align: number }>()
  const undefinedNames = new Set<string>()

  const add = (object: ObjectFile): void => {
    if (!objects.includes(object)) objects.push(object)
    for (const symbol of object.symbols) {
      if (symbol.bind === STB_LOCAL || symbol.name === '') continue
      if (symbol.section === SHN_UNDEF) {
        if (!defined.has(symbol.name) && !common.has(symbol.name)) undefinedNames.add(symbol.name)
        continue
      }
      if (symbol.section === SHN_COMMON) {
        if (defined.has(symbol.name)) continue
        const prior = common.get(symbol.name)
        common.set(symbol.name, {
          size: Math.max(prior?.size ?? 0, symbol.size),
          align: Math.max(prior?.align ?? 1, symbol.value),
        })
        undefinedNames.delete(symbol.name)
        continue
      }
      const weak = symbol.bind === STB_WEAK
      const prior = defined.get(symbol.name)
      if (prior && !prior.weak && !weak) {
        throw new SparcLinkError(`${symbol.name} is defined in both ${prior.object.name} and ${object.name}`)
      }
      if (!prior || (prior.weak && !weak)) defined.set(symbol.name, { object, symbol, weak })
      common.delete(symbol.name)
      undefinedNames.delete(symbol.name)
    }
  }

  for (const object of [...objects]) add(object)
  // Pull archive members until a full pass pulls nothing: members may need
  // each other in any order, which is what `--start-group` means.
  let pulled = true
  while (pulled) {
    pulled = false
    for (const archive of archives) {
      for (const member of archive) {
        if (member.used) continue
        const object = parseObject(member.name, member.bytes)
        const provides = object.symbols.some((s) =>
          s.bind !== STB_LOCAL && s.section !== SHN_UNDEF &&
          undefinedNames.has(s.name))
        if (!provides) continue
        member.used = true
        add(object)
        pulled = true
      }
    }
  }

  // ---- Layout ---------------------------------------------------------
  const groups = new Map<string, { object: ObjectFile; section: Section }[]>()
  for (const object of objects) {
    for (const section of object.sections) {
      const output = outputOf(section)
      if (output === null) continue
      if (!groups.has(output)) groups.set(output, [])
      groups.get(output)!.push({ object, section })
    }
  }
  // Initialisers run in priority order, as GNU ld sorts them.
  const priority = (name: string): number => {
    const match = /\.(\d+)$/.exec(name)
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
  }
  for (const name of ['.init_array', '.fini_array']) {
    groups.get(name)?.sort((a, b) => priority(a.section.name) - priority(b.section.name))
  }

  const outputs = new Map<string, { address: number; size: number }>()
  const commonAddresses = new Map<string, number>()

  /** Lays one output section's inputs out from `at`; returns where it ends. */
  const place = (name: string, at: number): number => {
    const members = groups.get(name) ?? []
    const start = align(at, Math.max(1, ...members.map(({ section }) => section.align)))
    let cursor = start
    for (const { section } of members) {
      cursor = align(cursor, section.align)
      section.address = cursor
      cursor += section.size
    }
    outputs.set(name, { address: start, size: cursor - start })
    return cursor
  }

  // Text and read-only data follow the ELF and program headers in the
  // first page, so the file maps from offset 0 at TEXT_BASE.
  const headerBytes = 52 + 32 * PROGRAM_HEADERS
  let address = TEXT_BASE + headerBytes
  for (const name of TEXT_SEGMENT) address = place(name, address)
  const textEnd = address

  // The writable segment starts a page further on, at the same offset
  // within its page as the file offset it is stored at: the file offset is
  // the end of the text, rounded up to a word.
  const dataFileOffset = align(textEnd - TEXT_BASE, 8)
  const dataStart = align(textEnd, PAGE) + (dataFileOffset % PAGE)
  address = dataStart
  for (const name of DATA_SEGMENT) {
    address = place(name, address)
    if (name !== '.bss') continue
    // COMMON symbols join .bss, in name order so the layout is stable.
    for (const [symbol, info] of [...common].sort((a, b) => a[0].localeCompare(b[0]))) {
      address = align(address, info.align)
      commonAddresses.set(symbol, address)
      address += info.size
    }
  }
  const bssStart = outputs.get('.bss')!.address
  const end = address

  // Linker-defined symbols: GNU ld's script provides these, and picolibc's
  // start-up code walks the arrays between them.
  const bounds = (name: string) => outputs.get(name) ?? { address: 0, size: 0 }
  const provided = new Map<string, number>([
    ['__preinit_array_start', bounds('.preinit_array').address],
    ['__preinit_array_end', bounds('.preinit_array').address + bounds('.preinit_array').size],
    ['__init_array_start', bounds('.init_array').address],
    ['__init_array_end', bounds('.init_array').address + bounds('.init_array').size],
    ['__fini_array_start', bounds('.fini_array').address],
    ['__fini_array_end', bounds('.fini_array').address + bounds('.fini_array').size],
    ['__bss_start', bssStart],
    ['_edata', bssStart],
    ['_end', end],
    ['end', end],
    ['_etext', textEnd],
  ])

  const resolve = (object: ObjectFile, index: number): number => {
    const symbol = object.symbols[index]
    if (!symbol) throw new SparcLinkError(`${object.name}: bad symbol index ${index}`)
    if (symbol.bind === STB_LOCAL || symbol.type === STT_SECTION) {
      if (symbol.section === SHN_ABS) return symbol.value
      const section = object.sections[symbol.section]
      if (!section) throw new SparcLinkError(`${object.name}: symbol in section ${symbol.section}`)
      return section.address + symbol.value
    }
    const definition = defined.get(symbol.name)
    if (definition) {
      const s = definition.symbol
      if (s.section === SHN_ABS) return s.value
      return definition.object.sections[s.section]!.address + s.value
    }
    const commonAt = commonAddresses.get(symbol.name)
    if (commonAt !== undefined) return commonAt
    const linkerDefined = provided.get(symbol.name)
    if (linkerDefined !== undefined) return linkerDefined
    if (symbol.bind === STB_WEAK) return 0
    throw new SparcLinkError(`undefined symbol ${symbol.name}, referenced from ${object.name}`)
  }

  // ---- Relocation ------------------------------------------------------
  for (const object of objects) {
    for (const section of object.sections) {
      if (outputOf(section) === null || section.data === null) continue
      for (const r of section.relocations) {
        const S = resolve(object, r.symbol)
        const P = section.address + r.offset
        const value = (S + r.addend) >>> 0
        const word = read32(section.data, r.offset)
        switch (r.type) {
          case R_SPARC_32:
            write32(section.data, r.offset, value)
            break
          case R_SPARC_WDISP30: {
            const disp = (value - P) | 0
            if (disp % 4 !== 0) throw new SparcLinkError(`${object.name}: misaligned call target`)
            write32(section.data, r.offset, ((word & 0xc0000000) | ((disp >> 2) & 0x3fffffff)) >>> 0)
            break
          }
          case R_SPARC_WDISP22: {
            const disp = ((value - P) | 0) >> 2
            if (disp < -(1 << 21) || disp >= (1 << 21)) {
              throw new SparcLinkError(`${object.name}: branch displacement out of range`)
            }
            write32(section.data, r.offset, ((word & 0xffc00000) | (disp & 0x3fffff)) >>> 0)
            break
          }
          case R_SPARC_HI22:
            write32(section.data, r.offset, ((word & 0xffc00000) | (value >>> 10)) >>> 0)
            break
          case R_SPARC_LO10:
            write32(section.data, r.offset, ((word & ~0x3ff) | (value & 0x3ff)) >>> 0)
            break
          default:
            throw new SparcLinkError(
              `${object.name}: relocation type ${RELOCATION_NAMES[r.type] ?? r.type} is not supported`)
        }
      }
    }
  }

  // ---- Output -----------------------------------------------------------
  const entryAddress = defined.get(entry)
  if (!entryAddress) throw new SparcLinkError(`no entry point ${entry}`)
  const entryValue = entryAddress.object.sections[entryAddress.symbol.section]!.address + entryAddress.symbol.value

  // The text segment is stored from offset 0, the data segment from
  // dataFileOffset; .bss takes no file space.
  const textFileSize = textEnd - TEXT_BASE
  const dataFileSize = bssStart - dataStart
  const file = new Uint8Array(dataFileOffset + dataFileSize)
  for (const [name, placed] of groups) {
    if (name === '.bss') continue
    for (const { section } of placed) {
      if (!section.data || section.size === 0) continue
      const offset = section.address >= dataStart
        ? dataFileOffset + (section.address - dataStart)
        : section.address - TEXT_BASE
      file.set(section.data, offset)
    }
  }

  // ELF header: 32-bit, big-endian, an executable for SPARC.
  file.set([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1, 0], 0)
  const half = (at: number, value: number): void => {
    file[at] = (value >>> 8) & 0xff
    file[at + 1] = value & 0xff
  }
  half(16, ET_EXEC)
  half(18, EM_SPARC)
  write32(file, 20, 1)
  write32(file, 24, entryValue)
  write32(file, 28, 52)
  write32(file, 32, 0)
  write32(file, 36, 0)
  half(40, 52)
  half(42, 32)
  half(44, PROGRAM_HEADERS)
  half(46, 40)
  half(48, 0)
  half(50, 0)
  const phdr = (i: number, type: number, offset: number, vaddr: number, filesz: number, memsz: number, flags: number, al: number) => {
    const o = 52 + i * 32
    write32(file, o, type)
    write32(file, o + 4, offset)
    write32(file, o + 8, vaddr)
    write32(file, o + 12, vaddr)
    write32(file, o + 16, filesz)
    write32(file, o + 20, memsz)
    write32(file, o + 24, flags)
    write32(file, o + 28, al)
  }
  phdr(0, PT_LOAD, 0, TEXT_BASE, textFileSize, textFileSize, 5, PAGE)
  phdr(1, PT_LOAD, dataFileOffset, dataStart, dataFileSize, end - dataStart, 6, PAGE)
  phdr(2, PT_GNU_STACK, 0, 0, 0, 0, 6, 16)
  return file
}
