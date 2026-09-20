export function i32(n: number): number {
  return n | 0
}

export function u32(n: number): number {
  return n >>> 0
}

/** Exact for the full JavaScript safe-integer domain; does not truncate to 32 bits. */
export function isSafePowerOfTwo(n: number): boolean {
  if (!Number.isSafeInteger(n) || n <= 0) return false
  const exponent = Math.log2(n)
  return Number.isInteger(exponent) && 2 ** exponent === n
}

export function imul(a: number, b: number): number {
  return Math.imul(a | 0, b | 0)
}

export function idiv(a: number, b: number): number {
  const d = b | 0
  if (d === 0) return 0
  return (a / d) | 0
}

export function irem(a: number, b: number): number {
  const d = b | 0
  if (d === 0) return 0
  return (a | 0) % d | 0
}

export function ishl(a: number, b: number): number {
  return (a | 0) << ((b | 0) & 31)
}

export function ishr(a: number, b: number): number {
  return (a | 0) >>> ((b | 0) & 31)
}

export function isar(a: number, b: number): number {
  return (a | 0) >> ((b | 0) & 31)
}

export function inSigned(n: number, bits: number): boolean {
  const min = -(1 << (bits - 1))
  const max = (1 << (bits - 1)) - 1
  return n >= min && n <= max
}

export function inUnsigned(n: number, bits: number): boolean {
  return n >= 0 && n < 1 << bits
}

export function splitLui12(imm: number): { upper: number; lower: number } {
  const lower = (imm << 20) >> 20
  const upper = ((imm - lower) >>> 12) & 0xfffff
  return { upper, lower }
}

export function checksumI32(view: DataView, addr: number, words: number): number {
  let h = 2166136261
  for (let i = 0; i < words; i++) {
    h ^= view.getInt32(addr + i * 4, true)
    h = Math.imul(h, 16777619)
  }
  return h | 0
}

export function lcg(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0
    return s
  }
}

export function valuesEqual(a: number, b: number, fp: boolean): boolean {
  if (!fp) {
    const isI32 = (value: number) =>
      Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff
    return isI32(a) && isI32(b) && a === b
  }
  // Every backend executes the same ordered binary64 operations. NaN is the
  // single deliberate equivalence class; all other observables, including
  // infinities and the sign of zero, therefore use exact IEEE identity.
  if (Number.isNaN(a) && Number.isNaN(b)) return true
  return Object.is(a, b)
}
