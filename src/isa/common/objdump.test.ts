import { describe, expect, it } from 'vitest'
import { parseObjdump } from './objdump.node.ts'

/**
 * The disassembly reader, which four targets' decode tiers are built on.
 *
 * Worth testing directly rather than only through them, because its
 * failure mode is silence: a line it does not recognise is skipped, so
 * a parser that recognises nothing reports that the decoder agreed with
 * the disassembler about every one of zero instructions. Two of the
 * cases below are exactly that failure, caught after it had happened.
 */
describe('reading llvm-objdump output', () => {
  it('reads the byte-per-column form, which is already in memory order', () => {
    const lines = parseObjdump([
      'a.o:\tfile format elf32-sparc',
      '',
      'Disassembly of section .text:',
      '',
      '00000000 <_start>:',
      '       0: 9d e3 bf a0  \tsave %sp, -0x60, %sp',
      '       4: 40 00 00 33  \tcall 0xd0',
    ].join('\n'))
    expect(lines).toHaveLength(2)
    expect(lines[0]!.address).toBe(0n)
    expect([...lines[0]!.bytes]).toEqual([0x9d, 0xe3, 0xbf, 0xa0])
    expect(lines[0]!.mnemonic).toBe('save')
    expect(lines[1]!.mnemonic).toBe('call')
  })

  it('reads the single-word form, least significant byte first', () => {
    // RISC-V and AArch64 print the instruction as one number, most
    // significant digit first, whatever the target's byte order is.
    const lines = parseObjdump('       0: 00000013     \tnop')
    expect([...lines[0]!.bytes]).toEqual([0x13, 0x00, 0x00, 0x00])
  })

  it('reads an address that is not indented', () => {
    // The address column is padded to a fixed width, so a program
    // linked low leaves spaces in front of it and one linked high does
    // not. POWER puts its text above four gigabytes, so every line of a
    // linked binary starts at the first character -- and a parser that
    // required the indentation read those files as empty.
    const lines = parseObjdump([
      '0000000010010e40 <_start>:',
      '10010e40: 02 00 4c 3c  \taddis 2, 12, 2',
      '10010e44: 58 0d 42 38  \taddi 2, 2, 3416',
    ].join('\n'))
    expect(lines).toHaveLength(2)
    expect(lines[0]!.address).toBe(0x10010e40n)
    expect(lines[0]!.mnemonic).toBe('addis')
    expect(lines[1]!.address).toBe(0x10010e44n)
  })

  it('keeps the whole rendering as well as the mnemonic', () => {
    const lines = parseObjdump('  100: 13 05 05 00 \taddi\ta0, a0, 16')
    expect(lines[0]!.mnemonic).toBe('addi')
    expect(lines[0]!.text).toBe('addi\ta0, a0, 16')
  })

  it('skips what is not an instruction', () => {
    const lines = parseObjdump([
      'out.elf:\tfile format elf64-powerpcle',
      '',
      'Disassembly of section .text:',
      '',
      '0000000010010e40 <main>:',
      '\t\t...',
      '10010e40: 02 00 4c 3c  \taddis 2, 12, 2',
    ].join('\n'))
    expect(lines).toHaveLength(1)
  })

  it('finds nothing in empty input rather than inventing a line', () => {
    expect(parseObjdump('')).toEqual([])
  })
})
