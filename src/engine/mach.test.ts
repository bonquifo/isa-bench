import { describe, expect, it } from 'vitest'
import { assignAddresses, binClass, binOpcode, mach, resolveLabels } from './mach.ts'
import { InstClass, NONE, Opcode, type MachInst } from './types.ts'

describe('machine-instruction helpers', () => {
  it('fills structural defaults and memory flags from class', () => {
    const add = mach({
      op: Opcode.ADD,
      mnemonic: 'add',
      bytes: 4,
      cls: InstClass.ALU,
    })
    expect(add.dst).toBe(NONE)
    expect(add.srcA).toBe(NONE)
    expect(add.uops).toBe(1)
    expect(add.resourceReads).toEqual([])
    expect(add.resourceWrites).toEqual([])
    expect(add.serializing).toBe(false)
    expect(add.readsMem).toBe(false)
    expect(add.writesMem).toBe(false)

    const ld = mach({
      op: Opcode.LDW,
      mnemonic: 'lw',
      bytes: 4,
      cls: InstClass.LD,
      dst: 3,
    })
    expect(ld.readsMem).toBe(true)
    expect(ld.writesMem).toBe(false)

    const st = mach({
      op: Opcode.STW,
      mnemonic: 'sw',
      bytes: 4,
      cls: InstClass.ST,
    })
    expect(st.writesMem).toBe(true)
    expect(st.readsMem).toBe(false)
  })

  it('lays out addresses by instruction width', () => {
    const insts = [
      mach({ op: Opcode.LI, mnemonic: 'li', bytes: 4, cls: InstClass.ALU }),
      mach({ op: Opcode.ADD, mnemonic: 'add', bytes: 4, cls: InstClass.ALU }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 2, cls: InstClass.NOP }),
    ]
    expect(assignAddresses(insts)).toBe(10)
    expect(insts.map((i) => i.addr)).toEqual([0, 4, 8])
  })

  it('resolves branch labels and strips assembler label nops', () => {
    const insts: MachInst[] = [
      mach({ op: Opcode.NOP, mnemonic: '.Lloop', bytes: 0, cls: InstClass.NOP, label: 'loop' }),
      mach({ op: Opcode.ADDI, mnemonic: 'addi', bytes: 4, cls: InstClass.ALU, dst: 1 }),
      mach({ op: Opcode.BR, mnemonic: 'j loop', bytes: 4, cls: InstClass.BR, label: 'loop' }),
    ]
    resolveLabels(insts)
    expect(insts).toHaveLength(2)
    expect(insts[1].target).toBe(0)
  })

  it('rejects an unresolved branch label', () => {
    const insts: MachInst[] = [
      mach({ op: Opcode.BR, mnemonic: 'j missing', bytes: 4, cls: InstClass.BR, label: 'missing' }),
    ]
    expect(() => resolveLabels(insts)).toThrow(/Unresolved label missing/)
  })

  it('maps IR binops onto classes and opcodes', () => {
    expect(binClass('add')).toBe(InstClass.ALU)
    expect(binClass('mul')).toBe(InstClass.MUL)
    expect(binClass('mulf')).toBe(InstClass.FP)
    expect(binClass('div')).toBe(InstClass.DIV)
    expect(binClass('rem')).toBe(InstClass.DIV)
    expect(binClass('divf')).toBe(InstClass.FP)
    expect(binClass('eqf')).toBe(InstClass.FP)
    expect(binClass('addf')).toBe(InstClass.FP)
    expect(binOpcode('xor')).toBe(Opcode.XOR)
    expect(binOpcode('sar')).toBe(Opcode.SAR)
    expect(binOpcode('divf')).toBe(Opcode.DIVF)
    expect(() => binOpcode('frob')).toThrow(/Unknown binop/)
  })
})
