/**
 * Seeded generator for randomised RV64 differential programs.
 *
 * Fixed test programs cover the cases someone thought of. These cover the
 * ones nobody did: a seed picks a sequence of instructions and a set of
 * operands, the program is compiled and run under qemu-riscv64 like any other
 * fixture, and the result is committed. A failure is reproducible by name,
 * because the seed is in the fixture's filename and in index.json.
 *
 * Every operation is emitted as inline assembly. Generating C expressions
 * instead would mean generating undefined behaviour — a shift wider than the
 * type, INT_MIN / -1, signed overflow — and a program whose meaning C does
 * not define cannot be a differential test of anything.
 *
 * Operands are drawn from a mixture of boundary values and uniform random
 * bits. Uniform random alone almost never produces zero, one, INT64_MIN, or
 * two values that differ only in sign, which is where the interesting
 * disagreements live.
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
  0x0000000000000000n, // +0
  0x8000000000000000n, // -0
  0x3ff0000000000000n, // 1
  0xbff0000000000000n, // -1
  0x7ff0000000000000n, // +inf
  0xfff0000000000000n, // -inf
  0x7ff8000000000000n, // quiet NaN
  0x7ff0000000000001n, // signalling NaN
  0x0000000000000001n, // smallest subnormal
  0x0010000000000000n, // smallest normal
  0x7fefffffffffffffn, // largest finite
  0x3fe5555555555555n, // 2/3, inexact in every operation
  0x4340000000000000n, // 2^53, the last exactly representable integer
  0xc340000000000001n,
  0x0008000000000000n, // subnormal with a long significand
  0x43e0000000000000n, // 2^63
]

const INT_RR = [
  'add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and',
  'addw', 'subw', 'sllw', 'srlw', 'sraw',
  'mul', 'mulh', 'mulhu', 'mulhsu', 'mulw',
  'div', 'divu', 'rem', 'remu', 'divw', 'divuw', 'remw', 'remuw',
]

const INT_RI = ['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi', 'addiw']
const SHIFT_RI = ['slli', 'srli', 'srai']
const SHIFT_RI_W = ['slliw', 'srliw', 'sraiw']

const FP_RR_D = [
  'fadd.d', 'fsub.d', 'fmul.d', 'fdiv.d', 'fmin.d', 'fmax.d',
  'fsgnj.d', 'fsgnjn.d', 'fsgnjx.d',
]
const FP_RR_S = [
  'fadd.s', 'fsub.s', 'fmul.s', 'fdiv.s', 'fmin.s', 'fmax.s',
  'fsgnj.s', 'fsgnjn.s', 'fsgnjx.s',
]
const FP_CMP_D = ['feq.d', 'flt.d', 'fle.d']
const FP_CMP_S = ['feq.s', 'flt.s', 'fle.s']
const FP_UN_D = ['fsqrt.d']
const FP_UN_S = ['fsqrt.s']
const FP_TO_INT = [
  'fcvt.w.d', 'fcvt.wu.d', 'fcvt.l.d', 'fcvt.lu.d', 'fclass.d',
  'fcvt.w.s', 'fcvt.wu.s', 'fcvt.l.s', 'fcvt.lu.s', 'fclass.s', 'fmv.x.w',
]
const INT_TO_FP = [
  'fcvt.d.w', 'fcvt.d.wu', 'fcvt.d.l', 'fcvt.d.lu',
  'fcvt.s.w', 'fcvt.s.wu', 'fcvt.s.l', 'fcvt.s.lu', 'fmv.d.x',
]
const FP_FMA = ['fmadd.d', 'fmsub.d', 'fnmadd.d', 'fnmsub.d',
  'fmadd.s', 'fmsub.s', 'fnmadd.s', 'fnmsub.s']
const LOADS = ['lb', 'lbu', 'lh', 'lhu', 'lw', 'lwu', 'ld']
const STORES = ['sb', 'sh', 'sw', 'sd']

const RESULT_SLOTS = 96
/** Results start past the 256-byte region the memory operations use. */
const RESULT_BASE = 32

export interface RandomProgram {
  seed: number
  source: string
  operations: number
}

export function generateRandomProgram(seed: number): RandomProgram {
  const next = rng(seed)
  const pick = <T,>(items: readonly T[]): T => items[Number(next() % BigInt(items.length))]!

  const value = (): bigint =>
    next() % 3n === 0n ? pick(BOUNDARY_INTS) : next()
  const floatValue = (): bigint =>
    next() % 2n === 0n ? pick(BOUNDARY_FLOATS) : next()

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
    if (kind <= 2) {
      body.push(`  ASM_RR("${pick(INT_RR)}", ${iv()}, ${iv()}, ${slot()});`)
    } else if (kind === 3) {
      const shift = Number(next() % 64n)
      const list = next() % 2n === 0n ? SHIFT_RI : SHIFT_RI_W
      const amount = list === SHIFT_RI ? shift : shift % 32
      body.push(`  ASM_RI("${pick(list)}", ${iv()}, ${amount}, ${slot()});`)
    } else if (kind === 4) {
      const imm = Number(BigInt.asIntN(12, next()))
      body.push(`  ASM_RI("${pick(INT_RI)}", ${iv()}, ${imm}, ${slot()});`)
    } else if (kind === 5) {
      const offset = Number(next() % 200n)
      body.push(`  ASM_STORE("${pick(STORES)}", ${offset}, ${iv()});`)
      body.push(`  ASM_LOAD("${pick(LOADS)}", ${Number(next() % 200n)}, ${slot()});`)
    } else if (kind === 6) {
      const single = next() % 2n === 0n
      const macro = single ? 'ASM_FRR_S' : 'ASM_FRR'
      body.push(
        `  ${macro}("${pick(single ? FP_RR_S : FP_RR_D)}", ` +
        `${fvIndex()}, ${fvIndex()}, ${slot()});`,
      )
    } else if (kind === 7) {
      const single = next() % 2n === 0n
      body.push(
        `  ${single ? 'ASM_FCMP_S' : 'ASM_FCMP'}("${pick(single ? FP_CMP_S : FP_CMP_D)}", ` +
        `${fvIndex()}, ${fvIndex()}, ${slot()});`,
      )
      body.push(
        `  ${single ? 'ASM_FUN_S' : 'ASM_FUN'}("${pick(single ? FP_UN_S : FP_UN_D)}", ` +
        `${fvIndex()}, ${slot()});`,
      )
    } else if (kind === 8) {
      // Deliberately fed from an unboxed 64-bit pattern: a single-precision
      // operation reading a register that is not NaN-boxed must see the
      // canonical NaN, and that rule is easy to implement by accident.
      body.push(`  ASM_FTOX("${pick(FP_TO_INT)}", ${fvIndex()}, ${slot()});`)
      body.push(`  ASM_XTOF("${pick(INT_TO_FP)}", ${iv()}, ${slot()});`)
    } else {
      const single = next() % 2n === 0n
      const ops = FP_FMA.filter((name) => name.endsWith(single ? '.s' : '.d'))
      body.push(
        `  ${single ? 'ASM_FMA_S' : 'ASM_FMA'}("${pick(ops)}", ` +
        `${fvIndex()}, ${fvIndex()}, ${fvIndex()}, ${slot()});`,
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
${body.join('\n')}
  return (long)SLOT(${RESULT_BASE});
}
`
  return { seed, source, operations: used }
}

/**
 * The macro prelude every generated program shares. Each macro emits exactly
 * one instruction of the named kind, so the generated text maps one to one
 * onto the instruction being tested.
 */
const PRELUDE = `/*
 * GENERATED by tools/isa/rv64/random.ts — do not edit.
 *
 * A randomised differential program. Every operation is inline assembly so
 * that nothing here depends on behaviour C leaves undefined.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
#define BUF ((volatile unsigned char *)isa_dump.scratch)

#define ASM_RR(insn, a, b, out) do {                                    \\
  unsigned long r_, x_ = (a), y_ = (b);                                 \\
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "r"(x_), "r"(y_));   \\
  (out) = r_;                                                           \\
} while (0)

#define ASM_RI(insn, a, imm, out) do {                                  \\
  unsigned long r_, x_ = (a);                                           \\
  __asm__ volatile(insn " %0, %1, " #imm : "=r"(r_) : "r"(x_));         \\
  (out) = r_;                                                           \\
} while (0)

#define ASM_STORE(insn, off, a) do {                                    \\
  unsigned long x_ = (a);                                               \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile(insn " %0, 0(%1)" :: "r"(x_), "r"(p_) : "memory");   \\
} while (0)

#define ASM_LOAD(insn, off, out) do {                                   \\
  unsigned long r_;                                                     \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile(insn " %0, 0(%1)" : "=r"(r_) : "r"(p_) : "memory");  \\
  (out) = r_;                                                           \\
} while (0)

#define ASM_FRR(insn, i, j, out) do {                                   \\
  double a_, b_, r_;                                                    \\
  unsigned long bits_;                                                  \\
  __asm__("fmv.d.x %0, %1" : "=f"(a_) : "r"(fv[i]));                    \\
  __asm__("fmv.d.x %0, %1" : "=f"(b_) : "r"(fv[j]));                    \\
  __asm__ volatile(insn " %0, %1, %2" : "=f"(r_) : "f"(a_), "f"(b_));   \\
  __asm__ volatile("fmv.x.d %0, %1" : "=r"(bits_) : "f"(r_));           \\
  (out) = bits_;                                                        \\
} while (0)

#define ASM_FCMP(insn, i, j, out) do {                                  \\
  double a_, b_;                                                        \\
  unsigned long r_;                                                     \\
  __asm__("fmv.d.x %0, %1" : "=f"(a_) : "r"(fv[i]));                    \\
  __asm__("fmv.d.x %0, %1" : "=f"(b_) : "r"(fv[j]));                    \\
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "f"(a_), "f"(b_));   \\
  (out) = r_;                                                           \\
} while (0)

#define ASM_FUN(insn, i, out) do {                                      \\
  double a_, r_;                                                        \\
  unsigned long bits_;                                                  \\
  __asm__("fmv.d.x %0, %1" : "=f"(a_) : "r"(fv[i]));                    \\
  __asm__ volatile(insn " %0, %1" : "=f"(r_) : "f"(a_));                \\
  __asm__ volatile("fmv.x.d %0, %1" : "=r"(bits_) : "f"(r_));           \\
  (out) = bits_;                                                        \\
} while (0)

#define ASM_FTOX(insn, i, out) do {                                     \\
  double a_;                                                            \\
  unsigned long r_;                                                     \\
  __asm__("fmv.d.x %0, %1" : "=f"(a_) : "r"(fv[i]));                    \\
  __asm__ volatile(insn " %0, %1" : "=r"(r_) : "f"(a_));                \\
  (out) = r_;                                                           \\
} while (0)

#define ASM_XTOF(insn, a, out) do {                                     \\
  double r_;                                                            \\
  unsigned long x_ = (a), bits_;                                        \\
  __asm__ volatile(insn " %0, %1" : "=f"(r_) : "r"(x_));                \\
  __asm__ volatile("fmv.x.d %0, %1" : "=r"(bits_) : "f"(r_));           \\
  (out) = bits_;                                                        \\
} while (0)

#define ASM_FRR_S(insn, i, j, out) do {                                 \\
  float a_, b_, r_;                                                     \\
  unsigned long bits_;                                                  \\
  __asm__("fmv.w.x %0, %1" : "=f"(a_) : "r"(fv[i]));                    \\
  __asm__("fmv.w.x %0, %1" : "=f"(b_) : "r"(fv[j]));                    \\
  __asm__ volatile(insn " %0, %1, %2" : "=f"(r_) : "f"(a_), "f"(b_));   \\
  __asm__ volatile("fmv.x.d %0, %1" : "=r"(bits_) : "f"(r_));           \\
  (out) = bits_;                                                        \\
} while (0)

#define ASM_FCMP_S(insn, i, j, out) do {                                \\
  float a_, b_;                                                         \\
  unsigned long r_;                                                     \\
  __asm__("fmv.w.x %0, %1" : "=f"(a_) : "r"(fv[i]));                    \\
  __asm__("fmv.w.x %0, %1" : "=f"(b_) : "r"(fv[j]));                    \\
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "f"(a_), "f"(b_));   \\
  (out) = r_;                                                           \\
} while (0)

#define ASM_FUN_S(insn, i, out) do {                                    \\
  float a_, r_;                                                         \\
  unsigned long bits_;                                                  \\
  __asm__("fmv.w.x %0, %1" : "=f"(a_) : "r"(fv[i]));                    \\
  __asm__ volatile(insn " %0, %1" : "=f"(r_) : "f"(a_));                \\
  __asm__ volatile("fmv.x.d %0, %1" : "=r"(bits_) : "f"(r_));           \\
  (out) = bits_;                                                        \\
} while (0)

#define ASM_FMA_S(insn, i, j, k, out) do {                              \\
  float a_, b_, c_, r_;                                                 \\
  unsigned long bits_;                                                  \\
  __asm__("fmv.w.x %0, %1" : "=f"(a_) : "r"(fv[i]));                    \\
  __asm__("fmv.w.x %0, %1" : "=f"(b_) : "r"(fv[j]));                    \\
  __asm__("fmv.w.x %0, %1" : "=f"(c_) : "r"(fv[k]));                    \\
  __asm__ volatile(insn " %0, %1, %2, %3"                               \\
                   : "=f"(r_) : "f"(a_), "f"(b_), "f"(c_));             \\
  __asm__ volatile("fmv.x.d %0, %1" : "=r"(bits_) : "f"(r_));           \\
  (out) = bits_;                                                        \\
} while (0)

#define ASM_FMA(insn, i, j, k, out) do {                                \\
  double a_, b_, c_, r_;                                                \\
  unsigned long bits_;                                                  \\
  __asm__("fmv.d.x %0, %1" : "=f"(a_) : "r"(fv[i]));                    \\
  __asm__("fmv.d.x %0, %1" : "=f"(b_) : "r"(fv[j]));                    \\
  __asm__("fmv.d.x %0, %1" : "=f"(c_) : "r"(fv[k]));                    \\
  __asm__ volatile(insn " %0, %1, %2, %3"                               \\
                   : "=f"(r_) : "f"(a_), "f"(b_), "f"(c_));             \\
  __asm__ volatile("fmv.x.d %0, %1" : "=r"(bits_) : "f"(r_));           \\
  (out) = bits_;                                                        \\
} while (0)
`
