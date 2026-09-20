import { describe, expect, it } from 'vitest'
import {
  alignOf,
  cloneType,
  decay,
  emptyEnv,
  fieldOf,
  flattenFields,
  isAgg,
  isFloat,
  isPtr,
  layoutRecord,
  sizeOf,
  typesEq,
  type CType,
} from './ctypes.ts'

const INT: CType = { kind: 'int' }
const FLT: CType = { kind: 'double' }
const VOID: CType = { kind: 'void' }

describe('C type sizes (ILP32-like guest)', () => {
  const env = emptyEnv()

  it('gives int/ptr 4 bytes and double 8 bytes', () => {
    expect(sizeOf(INT, env)).toBe(4)
    expect(alignOf(INT, env)).toBe(4)
    expect(sizeOf({ kind: 'ptr', to: INT }, env)).toBe(4)
    expect(sizeOf(FLT, env)).toBe(8)
    expect(alignOf(FLT, env)).toBe(8)
    expect(sizeOf(VOID, env)).toBe(0)
    expect(sizeOf({ kind: 'array', to: INT, len: 10 }, env)).toBe(40)
  })

  it('decays arrays and functions to pointers', () => {
    expect(decay({ kind: 'array', to: INT, len: 4 })).toEqual({ kind: 'ptr', to: INT })
    const fn: CType = { kind: 'fn', ret: INT, params: [INT], variadic: false }
    expect(decay(fn)).toEqual({ kind: 'ptr', to: fn })
    expect(decay(INT)).toEqual(INT)
    expect(isPtr({ kind: 'array', to: INT, len: 2 })).toBe(true)
    expect(isAgg({ kind: 'array', to: INT, len: 2 })).toBe(true)
    expect(isFloat(FLT)).toBe(true)
  })

  it('clones through pointer/array/fn structure', () => {
    const ty: CType = { kind: 'ptr', to: { kind: 'array', to: INT, len: 3 } }
    const c = cloneType(ty)
    expect(c).toEqual(ty)
    expect(c).not.toBe(ty)
    if (c.kind === 'ptr' && ty.kind === 'ptr') expect(c.to).not.toBe(ty.to)
  })
})

describe('struct / union layout', () => {
  it('lays out two ints at 0 and 4 with size 8', () => {
    const env = emptyEnv()
    const rec = layoutRecord('struct', 'S', [
      { name: 'a', ty: INT },
      { name: 'b', ty: INT },
    ], env)
    expect(rec.size).toBe(8)
    expect(rec.fields[0].off).toBe(0)
    expect(rec.fields[1].off).toBe(4)
    expect(fieldOf({ kind: 'record', rec: 'struct', tag: 'S' }, 'b', env).off).toBe(4)
  })

  it('aligns a double member and pads the struct to its alignment', () => {
    const env = emptyEnv()
    const rec = layoutRecord('struct', 'P', [
      { name: 'i', ty: INT },
      { name: 'd', ty: FLT },
    ], env)
    expect(rec.fields[1].off).toBe(8)
    expect(rec.size).toBe(16)
    expect(rec.align).toBe(8)
  })

  it('overlays union members at offset 0', () => {
    const env = emptyEnv()
    const rec = layoutRecord('union', 'U', [
      { name: 'i', ty: INT },
      { name: 'd', ty: FLT },
    ], env)
    expect(rec.fields.every((f) => f.off === 0)).toBe(true)
    expect(rec.size).toBe(8)
  })

  it('packs adjacent int bitfields into one 32-bit word', () => {
    const env = emptyEnv()
    const rec = layoutRecord('struct', 'B', [
      { name: 'a', ty: INT, bits: 8 },
      { name: 'b', ty: INT, bits: 8 },
      { name: 'c', ty: INT, bits: 16 },
    ], env)
    expect(rec.fields[0].off).toBe(0)
    expect(rec.fields[1].off).toBe(0)
    expect(rec.fields[2].off).toBe(0)
    expect(rec.fields[0].bitOff).toBe(0)
    expect(rec.fields[1].bitOff).toBe(8)
    expect(rec.fields[2].bitOff).toBe(16)
    expect(rec.size).toBe(4)
  })

  it('starts a new word when a bitfield would overflow 32 bits', () => {
    const env = emptyEnv()
    const rec = layoutRecord('struct', 'W', [
      { name: 'a', ty: INT, bits: 24 },
      { name: 'b', ty: INT, bits: 16 },
    ], env)
    expect(rec.fields[0].off).toBe(0)
    expect(rec.fields[1].off).toBe(4)
    expect(rec.size).toBe(8)
  })

  it('flattens anonymous nested struct fields with adjusted offsets', () => {
    const env = emptyEnv()
    layoutRecord('struct', 'Inner', [
      { name: 'x', ty: INT },
      { name: 'y', ty: INT },
    ], env)
    const outer = layoutRecord('struct', 'Outer', [
      { name: 'h', ty: INT },
      { name: '', ty: { kind: 'record', rec: 'struct', tag: 'Inner' } },
    ], env)
    const flat = flattenFields(outer.fields, env)
    expect(flat.some((f) => f.name === 'x' && f.off === 4)).toBe(true)
    expect(flat.some((f) => f.name === 'y' && f.off === 8)).toBe(true)
  })

  it('rejects member access on a non-record and on a missing field', () => {
    const env = emptyEnv()
    expect(() => fieldOf(INT, 'x', env)).toThrow(/non-struct/)
    layoutRecord('struct', 'S', [{ name: 'a', ty: INT }], env)
    expect(() => fieldOf({ kind: 'record', rec: 'struct', tag: 'S' }, 'z', env)).toThrow(/no member/)
  })
})

describe('typesEq', () => {
  it('treats void* as compatible with other pointers', () => {
    expect(typesEq({ kind: 'ptr', to: VOID }, { kind: 'ptr', to: INT })).toBe(true)
    expect(typesEq({ kind: 'ptr', to: INT }, { kind: 'ptr', to: FLT })).toBe(false)
    expect(typesEq(INT, INT)).toBe(true)
    expect(typesEq(INT, FLT)).toBe(false)
    expect(typesEq(
      { kind: 'fn', ret: INT, params: [INT], variadic: false },
      { kind: 'fn', ret: INT, params: [INT], variadic: false },
    )).toBe(true)
    expect(typesEq(
      { kind: 'fn', ret: INT, params: [INT], variadic: false },
      { kind: 'fn', ret: INT, params: [], variadic: false },
    )).toBe(false)
    expect(typesEq(
      { kind: 'fn', ret: INT, params: [INT], variadic: false },
      { kind: 'fn', ret: INT, params: [INT], variadic: true },
    )).toBe(false)
  })
})
