/**
 * Reading a disassembler's output back, so a decoder can be checked
 * against it.
 *
 * This is the tier that says a decoder agrees with LLVM's own tables
 * about what each instruction *is*, before any question of what it does.
 * RV64 has had it since the beginning; the reason to share it is that
 * writing an encoding table from memory and finding out at semantics
 * time is the most expensive way to be wrong, and the most avoidable.
 *
 * The one awkward part is that `llvm-objdump` prints the raw bytes
 * differently per target. RISC-V and AArch64 print the instruction word
 * as a single hexadecimal number; x86-64 and MIPS print the bytes
 * separately, in memory order. Both are unambiguous once you know which
 * one you are looking at, and telling them apart is what this file does
 * so that no backend has to.
 */

/** One disassembled instruction, with its bytes in memory order. */
export interface DisassembledLine {
  address: bigint
  bytes: Uint8Array
  /** The mnemonic alone, which may be a pseudo-instruction's name. */
  mnemonic: string
  /** The whole rendering, for a message that has to be readable. */
  text: string
}

/**
 * Parses `llvm-objdump -d` output.
 *
 * A line whose raw column is one run of hex digits is a word, printed
 * most significant digit first whatever the target's byte order; a line
 * whose raw column is space-separated pairs is already in memory order.
 * Everything that is neither -- headers, symbol names, `...` for elided
 * runs of zeroes -- is skipped.
 *
 * The address is not required to be indented, and that is not
 * cosmetic. `llvm-objdump` pads the address column to a fixed width, so
 * an object file or a program linked low leaves spaces in front of it
 * and a program linked high does not. POWER links its text above four
 * gigabytes, so its addresses fill the column exactly and every line of
 * a linked binary begins at the first character. A parser that required
 * the indentation read those files as containing no instructions at
 * all, and said so by reporting that the decoder agreed with the
 * disassembler about all zero of them.
 */
export function parseObjdump(text: string): DisassembledLine[] {
  const out: DisassembledLine[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2} )+|[0-9a-f]{4,16})\s+(\S.*)$/.exec(line)
    if (!match) continue
    const raw = match[2]!.trim()
    const bytes = raw.includes(' ')
      ? Uint8Array.from(raw.split(/\s+/).map((b) => Number.parseInt(b, 16)))
      : wordBytes(raw)
    if (bytes.length === 0) continue
    const text = match[3]!.trim()
    const address = BigInt(`0x${match[1]!}`)
    const previous = out[out.length - 1]
    if (previous !== undefined && SPLIT_PREFIXES.has(previous.text) &&
        previous.address + BigInt(previous.bytes.length) === address) {
      // The instruction a prefix printed on its own line belongs to.
      const joined = new Uint8Array(previous.bytes.length + bytes.length)
      joined.set(previous.bytes)
      joined.set(bytes, previous.bytes.length)
      out[out.length - 1] = {
        address: previous.address,
        bytes: joined,
        mnemonic: text.split(/\s+/)[0]!,
        text: `${previous.text} ${text}`,
      }
      continue
    }
    out.push({
      address,
      bytes,
      mnemonic: text.split(/\s+/)[0]!,
      text,
    })
  }
  return out
}

/**
 * x86 prefixes `llvm-objdump` sometimes prints as a line of their own.
 *
 * It does so when another prefix comes between them and the opcode --
 * `lock` before a REX byte, as in `f0 44 0f b1 07` -- and the two lines
 * are one instruction. Left apart, the first is a one-byte "instruction"
 * that no decoder can agree with, because it is not one.
 */
const SPLIT_PREFIXES = new Set(['lock', 'rep', 'repe', 'repne', 'data16'])

/** A hex word, least significant byte first, which is how memory holds it. */
function wordBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array(0)
  const value = BigInt(`0x${hex}`)
  const count = hex.length / 2
  const bytes = new Uint8Array(count)
  for (let i = 0; i < count; i++) bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn)
  return bytes
}
