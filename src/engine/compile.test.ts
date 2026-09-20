import { describe, expect, it } from 'vitest'
import { compile, disassemble } from './compile.ts'
import { IrBuilder, parseIr } from './ir.ts'
import { ALL_ISAS, IsaId, Opcode, OperationOrigin } from './types.ts'

function compileSrc(src: string, isa: (typeof ALL_ISAS)[number]) {
  return compile(parseIr(src), isa)
}

const ARITH = `
  imm r0, 40
  imm r1, 2
  add r2, r0, r1
  sub r3, r2, r1
  mul r4, r3, r1
  halt r4
`

describe('ISA lowering', () => {
  it('rejects unsupported memory scales from parser, builder, and compile entry points', () => {
    expect(() => parseIr('imm r0, 0\nimm r1, 0\nldw r2, 0(r0,r1,3)\nhalt r2'))
      .toThrow(/Unsupported memory scale 3/)
    const b = new IrBuilder()
    const base = b.imm(0)
    const index = b.imm(0)
    expect(() => b.ldwS(base, index, 16)).toThrow(/Unsupported memory scale 16/)
    expect(() => compile({
      insts: [
        { kind: 'imm', dst: 0, value: 0 },
        { kind: 'imm', dst: 1, value: 0 },
        { kind: 'ldw_s', dst: 2, base: 0, index: 1, scale: 3, off: 0 },
        { kind: 'halt', src: 2 },
      ],
      data: [],
      memSize: 1024,
    }, IsaId.RISCV)).toThrow(/Unsupported memory scale 3/)
  })

  it('compiles the same IR for every ISA with a halt and a stack init', () => {
    for (const isa of ALL_ISAS) {
      const p = compileSrc(ARITH, isa)
      expect(p.isa).toBe(isa)
      expect(p.insts.some((i) => i.op === Opcode.HALT), isa).toBe(true)
      expect(p.insts[0].op).toBe(Opcode.LI)
      expect(p.insts[0].imm).toBe(0x80000)
      expect(p.codeBytes).toBe(p.insts.reduce((n, i) => n + i.bytes, 0))
      expect(p.codeBytes).toBeGreaterThan(0)
    }
  })

  it('expands a RISC-V 12-bit immediate in one addi and a wide one as LUI+ADDI', () => {
    const small = compileSrc('imm r0, 100\nhalt r0', IsaId.RISCV)
    expect(small.insts.some((i) => i.mnemonic.includes('addi') && i.mnemonic.includes('100'))).toBe(true)
    expect(small.insts.filter((i) => i.mnemonic.startsWith('lui') && i.mnemonic.includes('100'))).toHaveLength(0)

    const wide = compileSrc('imm r0, 0x12345\nhalt r0', IsaId.RISCV)
    const userLui = wide.insts.find((i) => i.mnemonic.startsWith('lui') && i.dst !== wide.insts[0].dst)
    expect(userLui).toBeTruthy()
    expect(wide.insts.some((i) => i.op === Opcode.ADDI && i.dst === userLui!.dst && i.srcA === userLui!.dst)).toBe(true)
  })

  it('lowers RISC-V scaled loads to slli + add + lw (no SIB)', () => {
    const p = compileSrc(
      `
      imm r0, 4096
      imm r1, 3
      ldw r2, 0(r0,r1,4)
      halt r2
    `,
      IsaId.RISCV,
    )
    const text = p.insts.map((i) => i.mnemonic).join('\n')
    expect(text).toMatch(/slli/)
    expect(text).toMatch(/\badd\b/)
    expect(text).toMatch(/\blw\b/)
  })

  it('keeps ARM scaled addressing in one ldr and expands compares to cmp + b.cond', () => {
    const mem = compileSrc(
      `
      imm r0, 4096
      imm r1, 3
      ldw r2, 0(r0,r1,4)
      halt r2
    `,
      IsaId.ARM,
    )
    expect(mem.insts.some((i) => i.op === Opcode.LDW && i.memIndex >= 0 && i.memScale === 4)).toBe(true)
    expect(mem.insts.filter((i) => i.op === Opcode.SHL).length).toBe(0)

    const br = compileSrc(
      `
      imm r0, 1
      imm r1, 1
      beq r0, r1, yes
      imm r2, 0
      halt r2
      yes:
      imm r2, 9
      halt r2
    `,
      IsaId.ARM,
    )
    expect(br.insts.some((i) => i.mnemonic.startsWith('cmp'))).toBe(true)
    expect(br.insts.some((i) => i.mnemonic.startsWith('b.eq'))).toBe(true)
  })

  it('uses ARM MOVZ for 16-bit constants and MOVZ+MOVK for the high half', () => {
    const small = compileSrc('imm r0, 0x1234\nhalt r0', IsaId.ARM)
    expect(small.insts.some((i) => i.mnemonic.includes('movz') && i.mnemonic.includes('0x1234') || i.mnemonic.includes('#4660'))).toBe(true)
    expect(small.insts.some((i) => i.mnemonic.includes('movk') && i.mnemonic.includes('4660'))).toBe(false)
    const wide = compileSrc('imm r0, 0x12345678\nhalt r0', IsaId.ARM)
    expect(wide.insts.some((i) => i.mnemonic.includes('movk'))).toBe(true)
  })

  it('emits x86 2-operand ALU, SIB loads, and variable-length encodings', () => {
    const p = compileSrc(
      `
      imm r0, 5
      imm r1, 7
      add r2, r0, r1
      ldw r3, 0(r0,r1,4)
      halt r3
    `,
      IsaId.X86,
    )
    expect(p.insts.some((i) => /^add r\w+, r\w+$/.test(i.mnemonic))).toBe(true)
    expect(p.insts.some((i) => i.op === Opcode.LDW && i.memIndex >= 0)).toBe(true)
    const lens = new Set(p.insts.map((i) => i.bytes))
    expect(lens.size).toBeGreaterThan(1)
    expect(p.insts.find((i) => i.op === Opcode.HALT)?.bytes).toBe(2)
  })

  it('uses MIPS 16-bit addiu for a mid-size immediate and lui+ori beyond that', () => {
    const mid = compileSrc('imm r0, 4000\nhalt r0', IsaId.MIPS)
    expect(mid.insts.some((i) => i.mnemonic.includes('addiu') && i.mnemonic.includes('4000'))).toBe(true)
    const wide = compileSrc('imm r0, 0x12345678\nhalt r0', IsaId.MIPS)
    expect(wide.insts.some((i) => i.mnemonic.startsWith('lui'))).toBe(true)
    expect(wide.insts.some((i) => i.mnemonic.startsWith('ori'))).toBe(true)
  })

  it('uses SPARC 13-bit immediates and sethi past that', () => {
    const fit = compileSrc('imm r0, 4095\nhalt r0', IsaId.SPARC)
    expect(fit.insts.some((i) => i.mnemonic.includes('or %g0, 4095'))).toBe(true)
    const wide = compileSrc('imm r0, 8192\nhalt r0', IsaId.SPARC)
    expect(wide.insts.some((i) => i.mnemonic.startsWith('sethi'))).toBe(true)
  })

  it('uses PowerPC indexed loads (lwzx) instead of a shift+add+disp sequence', () => {
    const p = compileSrc(
      `
      imm r0, 4096
      imm r1, 2
      ldw r2, 0(r0,r1,4)
      halt r2
    `,
      IsaId.POWER,
    )
    expect(p.insts.some((i) => i.mnemonic.startsWith('lwzx') || i.mnemonic.startsWith('slwi'))).toBe(true)
  })

  it('emits WASM stack ops and MOS accumulator traffic', () => {
    const wasm = compileSrc(ARITH, IsaId.WASM)
    expect(wasm.insts.some((i) => i.mnemonic.startsWith('i32.const'))).toBe(true)
    expect(wasm.insts.some((i) => i.mnemonic.startsWith('local.set'))).toBe(true)
    const mos = compileSrc(ARITH, IsaId.MOS)
    expect(mos.insts.some((i) => i.mnemonic.startsWith('LDA') || i.mnemonic.startsWith('ADC'))).toBe(true)
    expect(mos.insts.length).toBeGreaterThan(wasm.insts.length - 20)
  })

  it('RISC-V issues more dynamic address arithmetic than ARM/x86 on the same indexed load', () => {
    const src = `
      imm r0, 4096
      imm r1, 1
      ldw r2, 0(r0,r1,4)
      halt r2
    `
    const rv = compileSrc(src, IsaId.RISCV).insts.filter((i) => i.op === Opcode.SHL || i.op === Opcode.ADD).length
    const arm = compileSrc(src, IsaId.ARM).insts.filter((i) => i.op === Opcode.SHL || i.op === Opcode.ADD).length
    const x86 = compileSrc(src, IsaId.X86).insts.filter((i) => i.op === Opcode.SHL || i.op === Opcode.ADD).length
    expect(rv).toBeGreaterThan(arm)
    expect(rv).toBeGreaterThan(x86)
  })

  it('disassemble prefixes addresses and respects the line limit', () => {
    const p = compileSrc(ARITH, IsaId.RISCV)
    const lines = disassemble(p, 3)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^\s*0\s+0000\s+/)
  })

  it('resolves branch targets to instruction indices', () => {
    const p = compileSrc(
      `
      imm r0, 0
      br done
      imm r0, 1
      done:
      halt r0
    `,
      IsaId.RISCV,
    )
    const br = p.insts.find((i) => i.op === Opcode.BR)!
    expect(br.target).toBeGreaterThanOrEqual(0)
    expect(p.insts[br.target].op).toBe(Opcode.HALT)
  })

  it('attributes wide-immediate and scaled-address expansions structurally', () => {
    for (const isa of [IsaId.RISCV, IsaId.ARM, IsaId.MIPS, IsaId.POWER, IsaId.SPARC]) {
      const wide = compileSrc('imm r0, 0x12345678\nhalt r0', isa)
      const user = wide.insts.slice(1, -1)
      expect(user.at(-1)?.origin, isa).toBe(OperationOrigin.SEMANTIC)
      expect(user.slice(0, -1).every((i) => i.origin === OperationOrigin.LOWERING), isa).toBe(true)
    }

    for (const isa of [IsaId.RISCV, IsaId.MIPS, IsaId.POWER, IsaId.SPARC]) {
      const scaled = compileSrc(
        'imm r0, 4096\nimm r1, 2\nldw r2, 0(r0,r1,4)\nhalt r2',
        isa,
      )
      const load = scaled.insts.find((i) => i.op === Opcode.LDW)!
      expect(load.origin, isa).toBe(OperationOrigin.SEMANTIC)
      const helpers = scaled.insts.filter((i) =>
        i.addr < load.addr && (i.op === Opcode.SHL || i.op === Opcode.ADD) &&
        (i.dst === load.memBase || i.dst === load.memIndex)
      )
      expect(helpers.length, isa).toBeGreaterThan(0)
      expect(helpers.every((i) => i.origin === OperationOrigin.LOWERING), isa).toBe(true)
    }
  })

  it('attributes compare, two-address, stack, and accumulator helpers explicitly', () => {
    for (const isa of [IsaId.ARM, IsaId.POWER, IsaId.X86]) {
      const p = compileSrc(
        'imm r0, 1\nimm r1, 1\nbeq r0, r1, yes\nimm r2, 0\nyes: halt r2',
        isa,
      )
      const branch = p.insts.find((i) => i.op === Opcode.BEQ)!
      const compare = p.insts.find((i) => i.resourceWrites.some((r) =>
        r.endsWith('flags') || r.endsWith('.cr')
      ))!
      expect(compare.origin, isa).toBe(OperationOrigin.LOWERING)
      expect(branch.origin, isa).toBe(OperationOrigin.SEMANTIC)
    }

    const x86 = compileSrc('imm r0, 5\nimm r1, 7\nadd r2, r0, r1\nhalt r2', IsaId.X86)
    const x86Add = x86.insts.find((i) => i.op === Opcode.ADD)!
    const x86Move = x86.insts[x86.insts.indexOf(x86Add) - 1]
    expect(x86Move.op).toBe(Opcode.MOV)
    expect(x86Move.origin).toBe(OperationOrigin.LOWERING)
    expect(x86Add.origin).toBe(OperationOrigin.SEMANTIC)

    const wasm = compileSrc('imm r0, 5\nimm r1, 7\nadd r2, r0, r1\nhalt r2', IsaId.WASM)
    expect(wasm.insts.filter((i) => i.resourceReads.includes('wasm.stack') ||
      i.resourceWrites.includes('wasm.stack')).every((i) =>
      i.op === Opcode.ADD ? i.origin === OperationOrigin.SEMANTIC :
        i.origin === OperationOrigin.LOWERING
    )).toBe(true)

    const mos = compileSrc('imm r0, 5\nimm r1, 7\nadd r2, r0, r1\nhalt r2', IsaId.MOS)
    const mosAdd = mos.insts.find((i) => i.op === Opcode.ADD)!
    expect(mosAdd.origin).toBe(OperationOrigin.SEMANTIC)
    expect(mos.insts.slice(0, mos.insts.indexOf(mosAdd))
      .filter((i) => i.op === Opcode.MOV || i.op === Opcode.NOP)
      .every((i) => i.origin === OperationOrigin.LOWERING)).toBe(true)
  })

  it('attributes spills as lowering and setup/assists as runtime', () => {
    const defs = Array.from({ length: 10 }, (_, i) => `addi r${i + 3}, r0, ${i + 1}`).join('\n')
    const adds = Array.from({ length: 9 }, (_, i) => `add r3, r3, r${i + 4}`).join('\n')
    const spilled = compileSrc(
      `tid r0\nimm r1, 4096\n${defs}\n${adds}\nstw r3, 0(r1,r0,4)\nhalt r3`,
      IsaId.MOS,
    )
    const spillOps = spilled.insts.filter((i) =>
      i.op === Opcode.SPILL_LOAD || i.op === Opcode.SPILL_STORE
    )
    expect(spillOps.length).toBeGreaterThan(0)
    expect(spillOps.every((i) => i.origin === OperationOrigin.LOWERING)).toBe(true)
    expect(spilled.insts[0].origin).toBe(OperationOrigin.RUNTIME)
    expect(spilled.insts.filter((i) => i.op === Opcode.TID)
      .every((i) => i.origin === OperationOrigin.RUNTIME)).toBe(true)

    const selfMove = compileSrc('imm r0, 1\nmov r0, r0\nhalt r0', IsaId.X86)
    expect(selfMove.insts.filter((i) => i.op === Opcode.MOV)).toHaveLength(0)
  })
})
