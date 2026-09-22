/**
 * Seeded generator for randomised AArch64 differential programs.
 *
 * Same shape as the RV64 generator, and for the same reasons: fixed programs
 * cover what someone thought of, and everything is inline assembly because
 * generating C expressions would mean generating undefined behaviour.
 *
 * What differs is what there is to cover. AArch64 folds a shift or an
 * extension into the second operand of most arithmetic, has a separate
 * flag-setting form of nearly every instruction, and then has a whole family
 * that reads those flags. Those combinations are where a hand-written test
 * runs out of patience and a generator does not.
 */

/** xorshift64*, so a seed reproduces a program exactly on any machine. */
function rng(seed: number): () => bigint {
  let state = BigInt.asUintN(64, BigInt(seed) * 0x9e3779b97f4a7c15n + 1n) || 1n
  return () => {
    state ^= state >> 12n
    state = BigInt.asUintN(64, state ^ (state << 25n))
    state ^= state >> 27n
    return BigInt.asUintN(64, state * 0x2545f4914f6cdd1dn)
  }
}

const BOUNDARY_INTS = [
  0n, 1n, 0xffffffffffffffffn, 2n, 0x7fffffffffffffffn, 0x8000000000000000n,
  0x7fffffffn, 0x80000000n, 0xffffffffn, 0x100000000n, 3n, 0xfffffffffffffffen,
  0x5555555555555555n, 0xaaaaaaaaaaaaaaaan, 0x8000000000000001n, 0x0000000100000000n,
]

const BOUNDARY_FLOATS = [
  0x0000000000000000n, 0x8000000000000000n, 0x3ff0000000000000n, 0xbff0000000000000n,
  0x7ff0000000000000n, 0xfff0000000000000n, 0x7ff8000000000000n, 0x7ff0000000000001n,
  0x0000000000000001n, 0x0010000000000000n, 0x7fefffffffffffffn, 0x3fe5555555555555n,
  0x4340000000000000n, 0xc340000000000001n, 0x0008000000000000n, 0x43e0000000000000n,
]

const INT_RR = [
  'add', 'sub', 'and', 'orr', 'eor', 'bic', 'orn', 'eon',
  'lsl', 'lsr', 'asr', 'ror', 'mul', 'smulh', 'umulh', 'sdiv', 'udiv',
]
/**
 * The subset that has a 32-bit form. smulh and umulh do not: they exist to
 * produce the high half of a 64-by-64 product, which has no 32-bit meaning.
 */
const INT_RR_W = [
  'add', 'sub', 'and', 'orr', 'eor', 'bic', 'orn', 'eon',
  'lsl', 'lsr', 'asr', 'ror', 'mul', 'sdiv', 'udiv',
]
/** Arithmetic that also writes the condition flags. */
const INT_RR_S = ['adds', 'subs', 'ands', 'bics']
const SHIFTS = ['lsl', 'lsr', 'asr']
const EXTENDS = ['uxtb', 'uxth', 'uxtw', 'sxtb', 'sxth', 'sxtw']
const CONDITIONS = [
  'eq', 'ne', 'hs', 'lo', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le',
]
const SELECTS = ['csel', 'csinc', 'csinv', 'csneg']
const FP_RR = ['fadd', 'fsub', 'fmul', 'fdiv', 'fmin', 'fmax', 'fminnm', 'fmaxnm', 'fnmul']
const FP_UN = ['fsqrt', 'fneg', 'fabs', 'frinta', 'frintm', 'frintp', 'frintz', 'frintn']
const FP_TO_X = ['fcvtzs', 'fcvtzu', 'fcvtas', 'fcvtms', 'fcvtps', 'fcvtns', 'fmov']
const X_TO_FP = ['scvtf', 'ucvtf', 'fmov']
const FP_FMA = ['fmadd', 'fmsub', 'fnmadd', 'fnmsub']
const LOADS: readonly (readonly [string, string])[] = [
  ['ldrb', '%w'],
  ['ldrsb', '%x'],
  ['ldrh', '%w'],
  ['ldrsh', '%x'],
  ['ldrsw', '%x'],
  ['ldr', '%w'],
  ['ldr', '%x'],
]
const STORES: readonly (readonly [string, string])[] = [
  ['strb', '%w'],
  ['strh', '%w'],
  ['str', '%w'],
  ['str', '%x'],
]

const RESULT_SLOTS = 96
const RESULT_BASE = 32

export interface RandomProgram {
  seed: number
  source: string
  operations: number
}

export function generateRandomProgram(seed: number): RandomProgram {
  const next = rng(seed)
  const pick = <T,>(items: readonly T[]): T => items[Number(next() % BigInt(items.length))]!
  const value = (): bigint => (next() % 3n === 0n ? pick(BOUNDARY_INTS) : next())
  const floatValue = (): bigint => (next() % 2n === 0n ? pick(BOUNDARY_FLOATS) : next())

  const ints: bigint[] = []
  const floats: bigint[] = []
  for (let i = 0; i < 24; i++) ints.push(value())
  for (let i = 0; i < 24; i++) floats.push(floatValue())

  const body: string[] = []
  let used = 0
  const slot = (): string => `SLOT(${RESULT_BASE + used++})`
  const iv = (): string => `v[${Number(next() % BigInt(ints.length))}]`
  const fvIndex = (): number => Number(next() % BigInt(floats.length))

  while (used < RESULT_SLOTS - 4) {
    const kind = Number(next() % 10n)
    if (kind <= 1) {
      body.push(`  RR("${pick(INT_RR)}", ${iv()}, ${iv()}, ${slot()});`)
    } else if (kind === 2) {
      body.push(`  RRW("${pick(INT_RR_W)}", ${iv()}, ${iv()}, ${slot()});`)
    } else if (kind === 3) {
      // A shift folded into the operand, which has its own encoding field.
      body.push(
        `  RRMOD("${pick(['add', 'sub', 'and', 'orr', 'eor'])}", ` +
        `"${pick(SHIFTS)} #${Number(next() % 64n)}", ${iv()}, ${iv()}, ${slot()});`,
      )
    } else if (kind === 4) {
      body.push(
        `  RREXT("${pick(['add', 'sub'])}", ` +
        `"${pick(EXTENDS)} #${Number(next() % 5n)}", ${iv()}, ${iv()}, ${slot()});`,
      )
    } else if (kind === 5) {
      // Set the flags, read them back, then consume them two ways.
      body.push(`  FLAGS3("${pick(INT_RR_S)}", ${iv()}, ${iv()}, ${slot()});`)
      body.push(`  COND("${pick(CONDITIONS)}", ${iv()}, ${iv()}, ${slot()});`)
      body.push(`  SEL("${pick(SELECTS)}", "${pick(CONDITIONS)}", ${iv()}, ${iv()}, ${slot()});`)
    } else if (kind === 6) {
      const offset = Number(next() % 200n)
      const store = pick(STORES)
      const load = pick(LOADS)
      body.push(`  ST("${store[0]}", "${store[1]}", ${offset}, ${iv()});`)
      body.push(`  LD("${load[0]}", "${load[1]}", ${Number(next() % 200n)}, ${slot()});`)
    } else if (kind === 7) {
      body.push(`  F_BIN("${pick(FP_RR)}", ${fvIndex()}, ${fvIndex()}, ${slot()});`)
      body.push(`  F_UN("${pick(FP_UN)}", ${fvIndex()}, ${slot()});`)
    } else if (kind === 8) {
      body.push(`  F_CMP("${pick(['fcmp', 'fcmpe'])}", ${fvIndex()}, ${fvIndex()}, ${slot()});`)
      body.push(`  F_TO_X("${pick(FP_TO_X)}", ${fvIndex()}, ${slot()});`)
      body.push(`  X_TO_F("${pick(X_TO_FP)}", ${iv()}, ${slot()});`)
    } else {
      body.push(
        `  F_FMA("${pick(FP_FMA)}", ${fvIndex()}, ${fvIndex()}, ${fvIndex()}, ${slot()});`,
      )
    }
  }

  const source = `${PRELUDE}
volatile unsigned long v[${ints.length}] = {
${ints.map((n) => `  0x${n.toString(16)}UL,`).join('\n')}
};

volatile unsigned long fv[${floats.length}] = {
${floats.map((n) => `  0x${n.toString(16)}UL,`).join('\n')}
};

long kernel(void) {
  for (int i = 0; i < 256; i++) BUF[i] = (unsigned char)(0x80 | (i * 7));
${body.join('\n')}
  return (long)SLOT(${RESULT_BASE});
}
`
  return { seed, source, operations: used }
}

const PRELUDE = `/*
 * GENERATED by tools/isa/aarch64/random.ts — do not edit.
 *
 * A randomised differential program. Every operation is inline assembly so
 * that nothing here depends on behaviour C leaves undefined.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
#define BUF ((volatile unsigned char *)isa_dump.scratch)

#define RR(insn, a, b, out) do {                                        \\
  unsigned long r_, x_ = (a), y_ = (b);                                 \\
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "r"(x_), "r"(y_));   \\
  (out) = r_; } while (0)

#define RRW(insn, a, b, out) do {                                       \\
  unsigned long r_ = 0, x_ = (a), y_ = (b);                             \\
  __asm__ volatile(insn " %w0, %w1, %w2" : "=r"(r_) : "r"(x_), "r"(y_)); \\
  (out) = r_; } while (0)

#define RRMOD(insn, mod, a, b, out) do {                                \\
  unsigned long r_, x_ = (a), y_ = (b);                                 \\
  __asm__ volatile(insn " %0, %1, %2, " mod : "=r"(r_) : "r"(x_), "r"(y_)); \\
  (out) = r_; } while (0)

#define RREXT(insn, mod, a, b, out) do {                                \\
  unsigned long r_, x_ = (a), y_ = (b);                                 \\
  __asm__ volatile(insn " %0, %1, %w2, " mod : "=r"(r_) : "r"(x_), "r"(y_)); \\
  (out) = r_; } while (0)

#define FLAGS3(insn, a, b, out) do {                                    \\
  unsigned long n_, d_, x_ = (a), y_ = (b);                             \\
  __asm__ volatile(insn " %1, %2, %3\\n\\tmrs %0, nzcv"                   \\
                   : "=r"(n_), "=&r"(d_) : "r"(x_), "r"(y_) : "cc");    \\
  (out) = n_; } while (0)

#define COND(cc, a, b, out) do {                                        \\
  unsigned long r_, x_ = (a), y_ = (b);                                 \\
  __asm__ volatile("cmp %1, %2\\n\\tcset %0, " cc                         \\
                   : "=r"(r_) : "r"(x_), "r"(y_) : "cc");               \\
  (out) = r_; } while (0)

#define SEL(insn, cc, a, b, out) do {                                   \\
  unsigned long r_, x_ = (a), y_ = (b);                                 \\
  __asm__ volatile("cmp %1, %2\\n\\t" insn " %0, %1, %2, " cc             \\
                   : "=r"(r_) : "r"(x_), "r"(y_) : "cc");               \\
  (out) = r_; } while (0)

#define ST(insn, reg, off, a) do {                                      \\
  unsigned long x_ = (a);                                               \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile(insn " " reg "0, [%1]" :: "r"(x_), "r"(p_) : "memory"); \\
} while (0)

#define LD(insn, reg, off, out) do {                                    \\
  unsigned long r_ = 0;                                                 \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile(insn " " reg "0, [%1]" : "=r"(r_) : "r"(p_) : "memory"); \\
  (out) = r_; } while (0)

#define F_LOAD(dst, i) __asm__("fmov %d0, %1" : "=w"(dst) : "r"(fv[i]))
#define F_BITS(src, out) __asm__("fmov %0, %d1" : "=r"(out) : "w"(src))

#define F_BIN(insn, i, j, out) do {                                     \\
  double a_, b_, r_; unsigned long bits_;                               \\
  F_LOAD(a_, i); F_LOAD(b_, j);                                         \\
  __asm__ volatile(insn " %d0, %d1, %d2" : "=w"(r_) : "w"(a_), "w"(b_)); \\
  F_BITS(r_, bits_); (out) = bits_; } while (0)

#define F_UN(insn, i, out) do {                                         \\
  double a_, r_; unsigned long bits_;                                   \\
  F_LOAD(a_, i);                                                        \\
  __asm__ volatile(insn " %d0, %d1" : "=w"(r_) : "w"(a_));              \\
  F_BITS(r_, bits_); (out) = bits_; } while (0)

#define F_CMP(insn, i, j, out) do {                                     \\
  double a_, b_; unsigned long n_;                                      \\
  F_LOAD(a_, i); F_LOAD(b_, j);                                         \\
  __asm__ volatile(insn " %d1, %d2\\n\\tmrs %0, nzcv"                     \\
                   : "=r"(n_) : "w"(a_), "w"(b_) : "cc");               \\
  (out) = n_; } while (0)

#define F_TO_X(insn, i, out) do {                                       \\
  double a_; unsigned long r_;                                          \\
  F_LOAD(a_, i);                                                        \\
  __asm__ volatile(insn " %0, %d1" : "=r"(r_) : "w"(a_));               \\
  (out) = r_; } while (0)

#define X_TO_F(insn, a, out) do {                                       \\
  double r_; unsigned long x_ = (a), bits_;                             \\
  __asm__ volatile(insn " %d0, %1" : "=w"(r_) : "r"(x_));               \\
  F_BITS(r_, bits_); (out) = bits_; } while (0)

#define F_FMA(insn, i, j, k, out) do {                                  \\
  double a_, b_, c_, r_; unsigned long bits_;                           \\
  F_LOAD(a_, i); F_LOAD(b_, j); F_LOAD(c_, k);                          \\
  __asm__ volatile(insn " %d0, %d1, %d2, %d3"                           \\
                   : "=w"(r_) : "w"(a_), "w"(b_), "w"(c_));             \\
  F_BITS(r_, bits_); (out) = bits_; } while (0)
`
