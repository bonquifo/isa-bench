import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyData, interpretIr, IrBuilder, parseIr } from '../engine/ir.ts'
import { emitCanonicalLlvmIr } from './llvmEmitter.ts'

function reference(source: string): number {
  const program = parseIr(source)
  const memory = new ArrayBuffer(program.memSize)
  applyData(memory, program.data)
  return interpretIr(program, memory).value
}

describe('canonical LLVM IR emitter', () => {
  it('is byte deterministic and includes bounded state-machine semantics', () => {
    const program = parseIr('imm r0, -2147483648\nimm r1, -1\ndiv r2, r0, r1\nhalt r2')
    const first = emitCanonicalLlvmIr(program)
    const second = emitCanonicalLlvmIr(program)
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(second).digest('hex'),
    )
    expect(first).toContain('switch i32 %pcv')
    expect(first).toContain('icmp uge i32 %step0, 100000000')
    expect(first).toContain('define internal i1 @bounds')
    expect(reference('imm r0, -2147483648\nimm r1, -1\ndiv r2, r0, r1\nhalt r2')).toBe(-2147483648)
  })

  it('emits branches, calls, masked shifts, and little-endian unaligned memory', () => {
    const source = [
      'imm r0, 257',
      'imm r1, 40',
      'imm r2, 1',
      'stw r0, 1(r2)',
      'ldw r3, 1(r2)',
      'call f',
      'halt r3',
      'f:',
      'shl r3, r3, r1',
      'ret',
    ].join('\n')
    const ir = emitCanonicalLlvmIr(parseIr(source))
    expect(ir).toContain('@load_i32le')
    expect(ir).toContain('@store_i32le')
    expect(ir).toContain('and i32')
    expect(ir).toContain('[4096 x i32]')
    expect(reference(source)).toBe(65792)
  })

  it('separates divide-by-zero from signed overflow and tracks runtime result kinds', () => {
    const source = 'imm r0, 123\nimm r1, 0\ndiv r2, r0, r1\nhalt r2'
    const ir = emitCanonicalLlvmIr(parseIr(source))
    expect(reference(source)).toBe(0)
    expect(ir).toContain('select i1 %zero2, i32 0')
    expect(ir).toContain('%kinds = alloca')
    expect(ir).toContain('%isfloat3 = icmp eq i8')
  })

  it('serializes exact IEEE constants and stack/memory faults', () => {
    const builder = new IrBuilder()
    const value = builder.immf(-0)
    builder.halt(value)
    const ir = emitCanonicalLlvmIr(builder.program())
    expect(ir).toContain('0x8000000000000000')
    expect(ir).toContain('fault_memory:')
    expect(ir).toContain('fault_callstack:')
  })
})
