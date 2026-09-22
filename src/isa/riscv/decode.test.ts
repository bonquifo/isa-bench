import { describe, expect, it } from 'vitest'
import { IllegalInstruction, UnimplementedInstruction } from '../common/errors.ts'
import { Flow, Rv, decode32, decompress, isFullLength } from './decode.ts'

/*
 * The corpus-wide check against llvm-objdump moved into the shared
 * conformance suite, so every target inherits it rather than this one
 * having it alone. What stays here are the cases that are about this
 * encoding in particular: immediates that are scattered across the word,
 * shifts whose width depends on the register size, and the compressed
 * forms, none of which another architecture has an analogue of.
 */

describe('decoder unit cases', () => {
  const at = 0x1000n

  it('reads the I-type immediate as signed', () => {
    // addi a0, a1, -1  =  0xfff58513
    const inst = decode32(0xfff58513, 4, at)
    expect(inst.op).toBe(Rv.ADDI)
    expect(inst.rd).toBe(10)
    expect(inst.rs1).toBe(11)
    expect(inst.imm).toBe(-1n)
  })

  it('separates srli from srai by the high bits, not by funct7', () => {
    // RV64 shift immediates are six bits, so bit 25 belongs to the amount.
    const srli = decode32(0x02f55513, 4, at) // srli a0, a0, 47
    expect(srli.op).toBe(Rv.SRLI)
    expect(srli.imm).toBe(47n)
    const srai = decode32(0x42f55513, 4, at) // srai a0, a0, 47
    expect(srai.op).toBe(Rv.SRAI)
    expect(srai.imm).toBe(47n)
  })

  it('scales and sign-extends branch and jump displacements', () => {
    // beq a0, a1, -4  =  0xfeb50ee3
    const beq = decode32(0xfeb50ee3, 4, at)
    expect(beq.op).toBe(Rv.BEQ)
    expect(beq.imm).toBe(-4n)
    // jal ra, 2048: the displacement is scattered as imm[20|10:1|11|19:12],
    // and here only imm[11] is set.
    const jal = decode32(0x001000ef, 4, at)
    expect(jal.op).toBe(Rv.JAL)
    expect(jal.imm).toBe(2048n)
  })

  it('classifies jal and jalr by their link register', () => {
    expect(decode32(0x001000ef, 4, at).flow).toBe(Flow.CALL) // rd = ra
    expect(decode32(0x0010006f, 4, at).flow).toBe(Flow.JUMP) // rd = zero
    expect(decode32(0x00008067, 4, at).flow).toBe(Flow.RET)
    expect(decode32(0x00008567, 4, at).flow).toBe(Flow.CALL) // jalr a0, 0(ra)
  })

  it('sign-extends the U-type immediate into the full 64-bit value', () => {
    // lui a0, 0xfffff  ->  0xfffff537
    const inst = decode32(0xfffff537, 4, at)
    expect(inst.op).toBe(Rv.LUI)
    expect(inst.imm).toBe(-4096n)
  })
})

describe('decoder refuses rather than guessing', () => {
  const at = 0x2000n

  it('rejects an unknown opcode', () => {
    expect(() => decode32(0x0000007f, 4, at)).toThrow(IllegalInstruction)
  })

  it('rejects an atomic whose funct5 the architecture does not define', () => {
    // The A extension is implemented; an undefined operation within it must
    // still be refused rather than matched loosely onto a neighbour.
    expect(() => decode32(0x28b6252f, 4, at)).toThrow(UnimplementedInstruction)
    expect(() => decode32(0x28b6252f, 4, at)).toThrow(/funct5/)
  })

  it('rejects an atomic at a width the architecture does not define', () => {
    // funct3 of 000 is a byte-wide atomic, which RV64A has no such thing as.
    expect(() => decode32(0x00b6052f, 4, at)).toThrow(IllegalInstruction)
  })

  it('reports fence.i as unimplemented', () => {
    expect(() => decode32(0x0000100f, 4, at)).toThrow(UnimplementedInstruction)
  })

  it('rejects reserved compressed encodings instead of expanding them', () => {
    // 0x0000 is the canonical illegal instruction.
    expect(() => decompress(0x0000, at)).toThrow(IllegalInstruction)
    // c.addi16sp / c.lui with a zero immediate are reserved.
    expect(() => decompress(0x6101, at)).toThrow(IllegalInstruction)
  })

  it('names the address and the bytes in the message', () => {
    expect(() => decode32(0x0000007f, 4, 0xdeadn)).toThrow(/0xdead/)
    expect(() => decode32(0x0000007f, 4, 0xdeadn)).toThrow(/7f 00 00 00/)
  })
})

describe('compressed expansion', () => {
  it('expands c.addi4spn into an addi off the stack pointer', () => {
    // c.addi4spn a0, sp, 16  =  0x0800
    const word = decompress(0x0800, 0n)
    const inst = decode32(word, 2, 0n)
    expect(inst.op).toBe(Rv.ADDI)
    expect(inst.rd).toBe(8)
    expect(inst.rs1).toBe(2)
    expect(inst.imm).toBe(16n)
  })

  it('expands c.jr into jalr with no link register', () => {
    // c.jr ra  =  0x8082, the canonical `ret`
    const inst = decode32(decompress(0x8082, 0n), 2, 0n)
    expect(inst.op).toBe(Rv.JALR)
    expect(inst.rd).toBe(0)
    expect(inst.rs1).toBe(1)
    expect(inst.flow).toBe(Flow.RET)
  })

  it('keeps the two-byte length after expanding to a 32-bit form', () => {
    const inst = decode32(decompress(0x8082, 0n), 2, 0n)
    expect(inst.len).toBe(2)
  })

  it('recognises which halfwords begin a four-byte instruction', () => {
    expect(isFullLength(0x8082)).toBe(false)
    expect(isFullLength(0x0513)).toBe(true)
  })
})
