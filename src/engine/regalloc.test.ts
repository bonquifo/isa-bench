import { describe, expect, it } from 'vitest'
import { parseIr } from './ir.ts'
import { allocate, isaRegs, legalize } from './regalloc.ts'
import { ALL_ISAS, IsaId } from './types.ts'

const MANY = Array.from({ length: 20 }, (_, i) => `imm r${i}, ${i}`).join('\n') + '\n' +
  Array.from({ length: 19 }, (_, i) => `add r${i}, r${i}, r${i + 1}`).join('\n') + '\n' +
  'halt r0\n'

describe('ISA register files', () => {
  it('keeps SP and scratches out of the allocatable set', () => {
    for (const isa of ALL_ISAS) {
      const r = isaRegs(isa)
      expect(r.allocatable).not.toContain(r.sp)
      for (const s of r.scratches) {
        expect(r.allocatable, `${isa} scratch ${s}`).not.toContain(s)
      }
      expect(new Set(r.allocatable).size).toBe(r.allocatable.length)
      expect(r.scratches.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('gives x86 11 GPRs and MOS only 4 allocatable slots', () => {
    expect(isaRegs(IsaId.X86).allocatable).toHaveLength(11)
    expect(isaRegs(IsaId.X86).sp).toBe(4)
    expect(isaRegs(IsaId.MOS).allocatable).toHaveLength(4)
    expect(isaRegs(IsaId.RISCV).allocatable.length).toBeGreaterThan(isaRegs(IsaId.X86).allocatable.length)
    expect(isaRegs(IsaId.ARM).sp).toBe(31)
    expect(isaRegs(IsaId.MIPS).sp).toBe(29)
    expect(isaRegs(IsaId.POWER).sp).toBe(1)
    expect(isaRegs(IsaId.SPARC).sp).toBe(14)
  })
})

describe('linear-scan allocation', () => {
  it('maps every virtual that is used onto a physical or a spill slot', () => {
    const ir = parseIr('imm r0, 1\nimm r1, 2\nadd r2, r0, r1\nhalt r2')
    const alloc = allocate(ir.insts, IsaId.RISCV)
    for (const v of [0, 1, 2]) {
      expect(alloc.map.has(v) || alloc.spills.has(v)).toBe(true)
    }
    expect(alloc.stackSlots).toBe(0)
    expect(alloc.physUsed.size).toBeGreaterThanOrEqual(3)
  })

  it('spills when live ranges exceed the MOS file', () => {
    const ir = parseIr(MANY)
    const mos = allocate(ir.insts, IsaId.MOS)
    const rv = allocate(ir.insts, IsaId.RISCV)
    expect(mos.stackSlots).toBeGreaterThan(0)
    expect(rv.stackSlots).toBe(0)
  })

  it('rewrites spilled vregs into private allocator spill operations', () => {
    const ir = parseIr(MANY)
    const alloc = allocate(ir.insts, IsaId.MOS)
    const legal = legalize(ir.insts, alloc)
    expect(legal.some((i) => i.kind === 'spill_load' || i.kind === 'spill_store')).toBe(true)
    const spillSlots = new Set(alloc.spills.values())
    for (const slot of spillSlots) {
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(alloc.stackSlots)
    }
  })

  it('keeps a loop-carried accumulator live across the back-edge', () => {
    const ir = parseIr(`
      imm r0, 0
      imm r1, 4
      top:
        bge r0, r1, done
        addi r0, r0, 1
        br top
      done:
        halt r0
    `)
    const alloc = allocate(ir.insts, IsaId.RISCV)
    expect(alloc.map.has(0)).toBe(true)
    expect(alloc.spills.has(0)).toBe(false)
  })
})
