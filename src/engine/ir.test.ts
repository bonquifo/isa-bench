import { describe, expect, it } from 'vitest'
import { imul } from './bits.ts'
import {
  applyData,
  evalBin,
  evalCond,
  interpretIr,
  IrBuilder,
  parseIr,
  SAMPLE_IR,
  virtDef,
  virtUses,
} from './ir.ts'
import { DATA_BASE, MEM_SIZE, NONE } from './types.ts'

function run(src: string, mem = new ArrayBuffer(MEM_SIZE)) {
  const ir = parseIr(src)
  applyData(mem, ir.data)
  return interpretIr(ir, mem)
}

describe('evalBin / evalCond (ISA-independent IR semantics)', () => {
  it('implements wrapping integer ALU ops', () => {
    expect(evalBin('add', 2147483647, 1)).toBe(-2147483648)
    expect(evalBin('sub', -2147483648, 1)).toBe(2147483647)
    expect(evalBin('mul', 65536, 65536)).toBe(0)
    expect(evalBin('div', -7, 2)).toBe(-3)
    expect(evalBin('div', 9, 0)).toBe(0)
    expect(evalBin('rem', -7, 3)).toBe(-1)
    expect(evalBin('and', 0xf0, 0x3c)).toBe(0x30)
    expect(evalBin('or', 0xf0, 0x0f)).toBe(0xff)
    expect(evalBin('xor', 0xff, 0x0f)).toBe(0xf0)
    expect(evalBin('shl', 1, 31)).toBe(-2147483648)
    expect(evalBin('shr', -1, 1)).toBe(0x7fffffff)
    expect(evalBin('sar', -8, 1)).toBe(-4)
  })

  it('implements IEEE binary64 including division by zero', () => {
    expect(evalBin('addf', 0.1, 0.2)).toBeCloseTo(0.3, 12)
    expect(evalBin('subf', 1.5, 0.5)).toBe(1)
    expect(evalBin('mulf', 2.5, 4)).toBe(10)
    expect(evalBin('divf', 1, 4)).toBe(0.25)
    expect(evalBin('divf', 3, 0)).toBe(Number.POSITIVE_INFINITY)
    expect(Number.isNaN(evalBin('divf', 0, 0))).toBe(true)
  })

  it('compares as signed 32-bit integers', () => {
    expect(evalCond('eq', 1, 1)).toBe(true)
    expect(evalCond('ne', 1, 2)).toBe(true)
    expect(evalCond('lt', -1, 0)).toBe(true)
    expect(evalCond('ge', -1, -1)).toBe(true)
    expect(evalCond('lt', 0xffffffff, 0)).toBe(true)
    expect(evalCond('lt', 1.9, 2)).toBe(true)
  })
})

describe('use / def analysis', () => {
  it('reports virtual-register uses and the defined dest', () => {
    expect(virtUses({ kind: 'imm', dst: 0, value: 1 })).toEqual([])
    expect(virtDef({ kind: 'imm', dst: 7, value: 1 })).toBe(7)
    expect(virtUses({ kind: 'binop', op: 'add', dst: 2, a: 0, b: 1 })).toEqual([0, 1])
    expect(virtUses({ kind: 'stw_s', src: 1, base: 2, index: 3, scale: 4, off: 0 })).toEqual([1, 2, 3])
    expect(virtDef({ kind: 'stw', src: 1, base: 0, off: 0 })).toBe(NONE)
    expect(virtUses({ kind: 'icall', fn: 9 })).toEqual([9])
    expect(virtDef({ kind: 'labaddr', dst: 4, label: 'f' })).toBe(4)
    expect(virtUses({ kind: 'barrier' })).toEqual([])
  })
})

describe('IR parser', () => {
  it('parses the sample program and the closed-form sum 0..255', () => {
    const ir = parseIr(SAMPLE_IR)
    expect(ir.insts.filter((i) => i.kind === 'label').map((i) => (i.kind === 'label' ? i.name : ''))).toEqual([
      'loop',
      'done',
    ])
    expect(interpretIr(ir, new ArrayBuffer(MEM_SIZE)).value).toBe((256 * 255) / 2)
  })

  it('accepts hex, comments, same-line labels, and j as br', () => {
    const ir = parseIr(`
      imm r0, 0x10   # sixteen
      L: addi r0, r0, 1 ; plus one
      j done
      done: halt r0
    `)
    expect(interpretIr(ir, new ArrayBuffer(MEM_SIZE)).value).toBe(17)
  })

  it('loads .word / .double blobs at .data addresses', () => {
    const ir = parseIr(`
      .data ${DATA_BASE}
      .word 11 22
      .double 0.5
      .text
      imm r0, ${DATA_BASE}
      ldw r1, 0(r0)
      ldw r2, 4(r0)
      add r3, r1, r2
      halt r3
    `)
    const mem = new ArrayBuffer(MEM_SIZE)
    applyData(mem, ir.data)
    expect(new DataView(mem).getInt32(DATA_BASE, true)).toBe(11)
    expect(new DataView(mem).getFloat64(DATA_BASE + 8, true)).toBe(0.5)
    expect(interpretIr(ir, mem).value).toBe(33)
  })

  it('parses scaled word addressing even after comma tokenization', () => {
    const mem = new ArrayBuffer(MEM_SIZE)
    const view = new DataView(mem)
    view.setInt32(DATA_BASE + 8, 99, true)
    expect(
      run(
        `
        imm r0, ${DATA_BASE}
        imm r1, 2
        ldw r2, 0(r0,r1,4)
        halt r2
      `,
        mem,
      ).value,
    ).toBe(99)
    expect(
      run(
        `
        .data ${DATA_BASE}
        .word 0 0 77
        .text
        imm r0, ${DATA_BASE}
        imm r1, 2
        ldw r2, 0(r0, r1, 4)
        halt r2
      `,
      ).value,
    ).toBe(77)
  })

  it('parses scaled double addressing', () => {
    const ir = parseIr(`
      imm r0, ${DATA_BASE}
      imm r1, 1
      ldd r2, 0(r0,r1,8)
      halt r2
    `)
    const scaled = ir.insts.find((i) => i.kind === 'ldd_s' || i.kind === 'ldd')
    expect(scaled?.kind).toBe('ldd_s')
    if (scaled?.kind === 'ldd_s') {
      expect(scaled.scale).toBe(8)
      expect(scaled.index).toBe(1)
    }
  })

  it('rejects programs without halt, unknown opcodes, and bad registers', () => {
    expect(() => parseIr('imm r0, 1')).toThrow(/halt/)
    expect(() => parseIr('frob r0\nhalt r0')).toThrow(/Unknown opcode/)
    expect(() => parseIr('imm x0, 1\nhalt r0')).toThrow(/Expected register/)
    expect(() => parseIr('br nowhere\nhalt r0')).not.toThrow()
    expect(() => interpretIr(parseIr('br nowhere\nhalt r0'), new ArrayBuffer(MEM_SIZE))).toThrow(/Unknown label/)
  })

  it('rejects instructions inside a .data section', () => {
    expect(() => parseIr('.data 4096\nimm r0, 1\nhalt r0')).toThrow(/unexpected instruction/)
  })
})

describe('IR interpreter', () => {
  it('executes every integer opcode against independent arithmetic', () => {
    const src = `
      imm r0, 20
      imm r1, 6
      add r2, r0, r1
      sub r3, r0, r1
      mul r4, r0, r1
      div r5, r0, r1
      rem r6, r0, r1
      and r7, r0, r1
      or  r8, r0, r1
      xor r9, r0, r1
      shl r10, r0, r1
      shr r11, r0, r1
      sar r12, r0, r1
      addi r13, r2, 1
      halt r13
    `
    expect(run(src).value).toBe(20 + 6 + 1)
    const b = new IrBuilder()
    const a = b.imm(20)
    const c = b.imm(6)
    const acc = b.add(a, c)
    b.halt(acc)
    expect(interpretIr(b.program(), new ArrayBuffer(MEM_SIZE)).value).toBe(26)
  })

  it('stores and loads words and doubles, including scaled forms', () => {
    const mem = new ArrayBuffer(MEM_SIZE)
    const ir = parseIr(`
      imm r0, ${DATA_BASE}
      imm r1, 7
      imm r2, 1
      stw r1, 0(r0,r2,4)
      ldw r3, 4(r0)
      immf r4, 2.5
      std r4, 16(r0)
      ldd r5, 16(r0)
      addf r6, r5, r5
      halt r3
    `)
    const out = interpretIr(ir, mem)
    expect(out.value).toBe(7)
    expect(new DataView(mem).getFloat64(DATA_BASE + 16, true)).toBe(2.5)
  })

  it('implements call / ret and labaddr + icall', () => {
    expect(
      run(`
        call leaf
        halt r1
        leaf:
          imm r1, 77
          ret
      `).value,
    ).toBe(77)

    expect(
      run(`
        la r0, leaf
        icall r0
        halt r1
        leaf:
          imm r1, 9
          ret
      `).value,
    ).toBe(9)
  })

  it('treats tid as 0 and nthreads as 1 in the gold interpreter', () => {
    expect(
      run(`
        tid r0
        nthreads r1
        add r2, r0, r1
        barrier
        halt r2
      `).value,
    ).toBe(1)
  })

  it('throws on ret with an empty stack and on a non-halting loop', () => {
    expect(() => run('ret\nhalt r0')).toThrow(/empty call stack/)
    expect(() => run('loop:\n  br loop\nhalt r0')).toThrow(/did not halt/)
  })

  it('reports structured memory faults and permits unaligned boundary accesses', () => {
    const mem = new ArrayBuffer(64)
    expect(run('imm r0, 60\nimm r1, 7\nstw r1, 0(r0)\nldw r2, 0(r0)\nhalt r2', mem).value).toBe(7)
    expect(() => run('imm r0, -1\nldw r1, 0(r0)\nhalt r1', mem))
      .toThrow(/IR ldw.*address -1.*width 4/)
    expect(() => run('imm r0, 61\nimm r1, 1\nstw r1, 0(r0)\nhalt r1', mem))
      .toThrow(/IR stw.*address 61.*width 4/)
    expect(() => run('imm r0, 57\nldd r1, 0(r0)\nhalt r1', mem))
      .toThrow(/IR ldd.*address 57.*width 8/)
    expect(() => run('imm r0, 57\nimmf r1, 1\nstd r1, 0(r0)\nhalt r1', mem))
      .toThrow(/IR std.*address 57.*width 8/)

    expect(() => applyData(mem, [{ addr: 62, bytes: [], words: [1], floats: [] }]))
      .toThrow(/applyData word store.*address 62.*width 4/)
    expect(() => applyData(mem, [{ addr: -1, bytes: [], words: [], floats: [1] }]))
      .toThrow(/applyData float store.*address -1.*width 8/)
  })

  it('counts interpreter steps including taken branches', () => {
    const { steps } = run(SAMPLE_IR)
    expect(steps).toBeGreaterThan(256)
  })
})

describe('IrBuilder data helpers', () => {
  it('writes word and binary64 blobs that applyData materializes', () => {
    const b = new IrBuilder()
    b.words(DATA_BASE, [3, 4])
    b.floats(DATA_BASE + 16, [1.25])
    const r0 = b.imm(DATA_BASE)
    const x = b.ldw(r0, 0)
    const y = b.ldw(r0, 4)
    b.halt(b.mul(x, y))
    const mem = new ArrayBuffer(MEM_SIZE)
    applyData(mem, b.data)
    expect(interpretIr(b.program(), mem).value).toBe(imul(3, 4))
    expect(new DataView(mem).getFloat64(DATA_BASE + 16, true)).toBe(1.25)
  })
})
