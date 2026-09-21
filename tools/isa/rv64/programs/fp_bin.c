/*
 * Double-precision arithmetic, comparison, min/max and sign injection over
 * the values that break naive implementations.
 *
 * Operands are built from bit patterns with fmv.d.x rather than from C
 * literals, so a signalling NaN really is signalling and a negative zero
 * really is negative. Results come back out with fmv.x.d for the same reason:
 * the comparison is on bits, not on values, because two NaNs compare unequal
 * and two zeroes compare equal however different they are.
 *
 * Points of interest RISC-V gets right and intuition gets wrong:
 *   - every NaN-producing arithmetic result is the canonical quiet NaN,
 *     0x7ff8000000000000, regardless of the input payload;
 *   - fmin/fmax return the non-NaN operand when exactly one is NaN, and
 *     order -0.0 below +0.0;
 *   - fsgnj/fsgnjn/fsgnjx are bit operations and pass NaN payloads through.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

static inline double from_bits(unsigned long b) {
  double d;
  __asm__("fmv.d.x %0, %1" : "=f"(d) : "r"(b));
  return d;
}

static inline unsigned long to_bits(double d) {
  unsigned long b;
  __asm__("fmv.x.d %0, %1" : "=r"(b) : "f"(d));
  return b;
}

#define F_BIN(insn, a, b) ({                                    \
  double r_;                                                    \
  __asm__ volatile(insn " %0, %1, %2" : "=f"(r_) : "f"(a), "f"(b)); \
  to_bits(r_);                                                  \
})

#define F_CMP(insn, a, b) ({                                    \
  unsigned long r_;                                             \
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "f"(a), "f"(b)); \
  r_;                                                           \
})

volatile unsigned long left[8] = {
  0x0000000000000000UL, /* +0.0    */
  0x8000000000000000UL, /* -0.0    */
  0x3ff8000000000000UL, /* 1.5     */
  0x7ff0000000000000UL, /* +inf    */
  0x7ff8000000000000UL, /* qNaN    */
  0x7ff0000000000001UL, /* sNaN    */
  0x7fefffffffffffffUL, /* DBL_MAX */
  0x0000000000000001UL, /* smallest subnormal */
};

volatile unsigned long right[8] = {
  0x8000000000000000UL, /* -0.0    */
  0x0000000000000000UL, /* +0.0    */
  0xc002000000000000UL, /* -2.25   */
  0xfff0000000000000UL, /* -inf    */
  0x3ff8000000000000UL, /* 1.5     */
  0x7ff8000000000000UL, /* qNaN    */
  0x7fefffffffffffffUL, /* DBL_MAX */
  0x0010000000000000UL, /* smallest normal */
};

long kernel(void) {
  int k = 0;
  for (int i = 0; i < 8; i++) {
    double a = from_bits(left[i]);
    double b = from_bits(right[i]);
    SLOT(k++) = F_BIN("fadd.d", a, b);
    SLOT(k++) = F_BIN("fsub.d", a, b);
    SLOT(k++) = F_BIN("fmul.d", a, b);
    SLOT(k++) = F_BIN("fdiv.d", a, b);
    SLOT(k++) = F_BIN("fmin.d", a, b);
    SLOT(k++) = F_BIN("fmax.d", a, b);
    SLOT(k++) = F_BIN("fsgnj.d", a, b);
    SLOT(k++) = F_BIN("fsgnjn.d", a, b);
    SLOT(k++) = F_BIN("fsgnjx.d", a, b);
    SLOT(k++) = F_CMP("feq.d", a, b);
    SLOT(k++) = F_CMP("flt.d", a, b);
    SLOT(k++) = F_CMP("fle.d", a, b);
  }
  return (long)k;
}
