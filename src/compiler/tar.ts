/**
 * Reads the toolchain's sysroot archive: a plain POSIX ustar file, as
 * tools/isa/build-toolchain.ts writes it (regular files and directories,
 * sorted, no owners or timestamps worth keeping).
 */
export interface TarEntry {
  path: string
  bytes: Uint8Array
}

function field(block: Uint8Array, offset: number, length: number): string {
  let end = offset
  while (end < offset + length && block[end] !== 0) end++
  return new TextDecoder().decode(block.subarray(offset, end))
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const text = field(block, offset, length).trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

/** Every regular file in `archive`, with its path relative to the root. */
export function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let at = 0
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512)
    // Two zero blocks end the archive; one is enough to stop reading.
    if (header.every((byte) => byte === 0)) break
    if (field(header, 257, 6) !== 'ustar') {
      throw new Error(`sysroot archive: entry at ${at} is not a ustar header`)
    }
    const name = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156]!)
    const path = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '')
    if (type === '0' || type === '\0') {
      entries.push({ path, bytes: archive.subarray(at + 512, at + 512 + size) })
    } else if (type !== '5') {
      throw new Error(`sysroot archive: ${path} has unsupported type ${JSON.stringify(type)}`)
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}
