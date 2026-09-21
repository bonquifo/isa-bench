import { describe, expect, it } from 'vitest'
import { IllegalInstruction, UnimplementedInstruction } from '../common/errors.ts'
import { Flow, Rv, decode32, decompress, isFullLength } from './decode.ts'
import { fixtureNames, readObjdump } from '../common/fixtures.node.ts'
import { RV64_FIXTURE_DIR } from './fixtures.node.ts'

interface DisasmLine {
  address: bigint
  word: number
  bytes: 2 | 4
  mnemonic: string
  text: string
}

function parseObjdump(text: string): DisasmLine[] {
  const out: DisasmLine[] = []
  for (const line of text.split('\n')) {
    const match = /^\s+([0-9a-f]+):\s+([0-9a-f]+)\s+(.*)$/.exec(line)
    if (!match) continue
    const hex = match[2]!
    if (hex.length !== 4 && hex.length !== 8) continue
    out.push({
      address: BigInt(`0x${match[1]!}`),
      word: Number.parseInt(hex, 16),
      bytes: hex.length === 4 ? 2 : 4,
      mnemonic: match[3]!.trim().split(/\s+/)[0]!,
      text: match[3]!.trim(),
    })
  }
  return out
}

/**
 * objdump prints pseudo-instructions. Each maps onto one or more canonical
 * operations, and which one depends on the operands, so the check is
 * membership rather than equality.
 */
const ALIASES: Record<string, readonly number[]> = {
  li: [Rv.ADDI, Rv.LUI],
  mv: [Rv.ADDI, Rv.ADD],
  nop: [Rv.ADDI],
  j: [Rv.JAL],
  jr: [Rv.JALR],
  ret: [Rv.JALR],
  call: [Rv.JALR, Rv.AUIPC],
  tail: [Rv.JALR, Rv.AUIPC],
  neg: [Rv.SUB],
  negw: [Rv.SUBW],
  not: [Rv.XORI],
  seqz: [Rv.SLTIU],
  snez: [Rv.SLTU],
  sltz: [Rv.SLT],
  sgtz: [Rv.SLT],
  'sext.w': [Rv.ADDIW],
  'zext.w': [Rv.ADD],
  beqz: [Rv.BEQ],
  bnez: [Rv.BNE],
  blez: [Rv.BGE],
  bgez: [Rv.BGE],
  bltz: [Rv.BLT],
  bgtz: [Rv.BLT],
  bgt: [Rv.BLT],
  ble: [Rv.BGE],
  bgtu: [Rv.BLTU],
  bleu: [Rv.BGEU],
  frcsr: [Rv.CSRRS],
  fscsr: [Rv.CSRRW],
  frrm: [Rv.CSRRS],
  fsrm: [Rv.CSRRW],
  frflags: [Rv.CSRRS],
  csrr: [Rv.CSRRS],
  csrw: [Rv.CSRRW],
  'fmv.d': [Rv.FSGNJ_D],
  'fneg.d': [Rv.FSGNJN_D],
  'fabs.d': [Rv.FSGNJX_D],
  'fmv.s': [Rv.FSGNJ_S],
  'fneg.s': [Rv.FSGNJN_S],
  'fabs.s': [Rv.FSGNJX_S],
}

function canonicalName(op: number): string {
  for (const [key, value] of Object.entries(Rv)) {
    if (value === op) return key.toLowerCase().replace(/_/g, '.')
  }
  return `?${op}`
}

function decodeLine(line: DisasmLine) {
  const word = line.bytes === 2 ? decompress(line.word, line.address) : line.word
  return decode32(word, line.bytes, line.address)
}

describe('decoder against llvm-objdump on the fixture corpus', () => {
  const names = fixtureNames(RV64_FIXTURE_DIR)

  it('has fixtures to check', () => {
    expect(names.length).toBeGreaterThan(0)
  })

  for (const name of names) {
    it(`decodes every instruction in ${name}`, () => {
      const lines = parseObjdump(readObjdump(RV64_FIXTURE_DIR, name))
      expect(lines.length).toBeGreaterThan(0)
      const problems: string[] = []
      for (const line of lines) {
        // `unimp` is not an instruction. The decoder must refuse it, which is
        // the behaviour this project cares most about: no silent fallthrough.
        if (line.mnemonic === 'unimp') {
          expect(() => decodeLine(line)).toThrow(IllegalInstruction)
          continue
        }
        let decoded
        try {
          decoded = decodeLine(line)
        } catch (error) {
          problems.push(
            `0x${line.address.toString(16)} ${line.text}: ${(error as Error).message}`,
          )
          continue
        }
        if (decoded.len !== line.bytes) {
          problems.push(`0x${line.address.toString(16)} ${line.text}: length ${decoded.len} != ${line.bytes}`)
        }
        const accepted = ALIASES[line.mnemonic] ?? []
        const actual = canonicalName(decoded.op)
        if (actual !== line.mnemonic && !accepted.includes(decoded.op)) {
          problems.push(
            `0x${line.address.toString(16)} ${line.text}: decoded as ${actual}`,
          )
        }
      }
      expect(problems.slice(0, 20).join('\n')).toBe('')
    })

    it(`derives the same instruction boundaries as objdump in ${name}`, () => {
      const lines = parseObjdump(readObjdump(RV64_FIXTURE_DIR, name))
      for (let i = 1; i < lines.length; i++) {
        const previous = lines[i - 1]!
        const here = lines[i]!
        // Sections are contiguous; a gap means a new one, which is fine.
        if (here.address !== previous.address + BigInt(previous.bytes)) continue
        const length = isFullLength(previous.word & 0xffff) ? 4 : 2
        expect(length).toBe(previous.bytes)
      }
    })
  }
})

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
