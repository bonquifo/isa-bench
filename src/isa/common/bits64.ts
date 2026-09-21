/**
 * Width-exact integer primitives for the real-ISA interpreters.
 *
 * The engine's legacy register file is a `Float64Array`, which holds only
 * 53 bits of integer exactly and so cannot represent a 64-bit architectural
 * register at all. Real interpreters use `bigint` instead: `BigInt.asIntN` and
 * `BigInt.asUintN` express "this result is N bits wide, interpreted signed or
 * unsigned" directly, which is precisely the operation every fixed-width ISA
 * is specified in terms of.
 *
 * Measured cost of that choice on a dispatch-plus-arithmetic microbenchmark is
 * 1.36x versus hand-rolled 32-bit lo/hi pairs. The pairs were rejected at that
 * price: they put the awkward cases (mulh, INT_MIN / -1, shift amounts of 0,
 * 32 and 63) into code we would have to get right by hand, and those are
 * exactly the cases this project must not get wrong.
 *
 * Nothing here encodes an ISA's *policy* — what division by zero produces, how
 * many bits of a shift amount are honoured — because that genuinely differs
 * between architectures. Policy lives in the per-ISA module.
 */

/** Truncate to 64 bits and interpret the result as signed. */
export function s64(v: bigint): bigint {
  return BigInt.asIntN(64, v)
}

/** Truncate to 64 bits and interpret the result as unsigned. */
export function u64(v: bigint): bigint {
  return BigInt.asUintN(64, v)
}

/** Truncate to `bits` and sign-extend back out to a signed bigint. */
export function sext(v: bigint, bits: number): bigint {
  return BigInt.asIntN(bits, v)
}

/** Truncate to `bits` and zero-extend back out to a non-negative bigint. */
export function zext(v: bigint, bits: number): bigint {
  return BigInt.asUintN(bits, v)
}

/** Upper 64 bits of the 128-bit product, both operands signed. */
export function mulhs(a: bigint, b: bigint): bigint {
  return s64((s64(a) * s64(b)) >> 64n)
}

/** Upper 64 bits of the 128-bit product, both operands unsigned. */
export function mulhu(a: bigint, b: bigint): bigint {
  return s64((u64(a) * u64(b)) >> 64n)
}

/** Upper 64 bits of the 128-bit product, first operand signed, second unsigned. */
export function mulhsu(a: bigint, b: bigint): bigint {
  return s64((s64(a) * u64(b)) >> 64n)
}

/** Hex for diagnostics, always 16 digits so mismatches line up when printed. */
export function hex64(v: bigint): string {
  return `0x${u64(v).toString(16).padStart(16, '0')}`
}
