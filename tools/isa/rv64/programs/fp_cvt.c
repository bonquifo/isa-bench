/*
 * Conversions, classification, square root and single-precision NaN boxing.
 *
 * Float-to-integer conversion is where implementations quietly disagree.
 * RISC-V saturates rather than wrapping or trapping: NaN converts to the
 * maximum of the target type, out-of-range negatives to its minimum, and
 * out-of-range positives to its maximum. C's own float-to-int conversion is
 * undefined in exactly those cases, so this has to be inline asm.
 *
 * Single-precision values live NaN-boxed in a 64-bit f register: the upper
 * 32 bits must be all ones. An interpreter that stores a bare 32-bit pattern
 * produces a register file that diverges from the reference on the very next
 * fsd, which is why the raw boxed bits are recorded here and not just the value.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

static inline double from_bits(unsigned long b) {
  double d;
  __asm__("fmv.d.x %0, %1" : "=f"(d) : "r"(b));
  return d;
}

#define F_UN_F(insn, a) ({                                      \
  double r_; unsigned long b_;                                  \
  __asm__ volatile(insn " %0, %1" : "=f"(r_) : "f"(a));         \
  __asm__ volatile("fmv.x.d %0, %1" : "=r"(b_) : "f"(r_));      \
  b_;                                                           \
})

#define F_UN_X(insn, a) ({                                      \
  unsigned long r_;                                             \
  __asm__ volatile(insn " %0, %1" : "=r"(r_) : "f"(a));         \
  r_;                                                           \
})

#define X_TO_F(insn, a) ({                                      \
  double r_; unsigned long b_;                                  \
  __asm__ volatile(insn " %0, %1" : "=f"(r_) : "r"(a));         \
  __asm__ volatile("fmv.x.d %0, %1" : "=r"(b_) : "f"(r_));      \
  b_;                                                           \
})

volatile unsigned long values[10] = {
  0x0000000000000000UL, /* +0.0                 */
  0x8000000000000000UL, /* -0.0                 */
  0x3ff8000000000000UL, /* 1.5                  */
  0xc002000000000000UL, /* -2.25                */
  0x7ff0000000000000UL, /* +inf                 */
  0xfff0000000000000UL, /* -inf                 */
  0x7ff8000000000000UL, /* qNaN                 */
  0x7fefffffffffffffUL, /* DBL_MAX, out of range for every integer width */
  0xc1e0000000200000UL, /* -2147483649.0, just past INT32_MIN */
  0x41dfffffffc00000UL, /* 2147483647.0, exactly INT32_MAX    */
};

volatile long integers[8] = {
  0, 1, -1, 2147483647L, -2147483648L,
  9223372036854775807L, -9223372036854775807L - 1L, 0x0020000000000001L,
};

long kernel(void) {
  int k = 0;
  for (int i = 0; i < 10; i++) {
    double a = from_bits(values[i]);
    SLOT(k++) = F_UN_F("fsqrt.d", a);
    SLOT(k++) = F_UN_X("fclass.d", a);
    SLOT(k++) = F_UN_X("fcvt.w.d", a);
    SLOT(k++) = F_UN_X("fcvt.wu.d", a);
    SLOT(k++) = F_UN_X("fcvt.l.d", a);
    SLOT(k++) = F_UN_X("fcvt.lu.d", a);
    /* Narrow to single, keep the boxed bits, widen back. */
    double s;
    unsigned long boxed;
    __asm__ volatile("fcvt.s.d %0, %1" : "=f"(s) : "f"(a));
    __asm__ volatile("fmv.x.d %0, %1" : "=r"(boxed) : "f"(s));
    SLOT(k++) = boxed;
    SLOT(k++) = F_UN_X("fmv.x.w", s);
    SLOT(k++) = F_UN_F("fcvt.d.s", s);
  }

  for (int i = 0; i < 8; i++) {
    long v = integers[i];
    SLOT(k++) = X_TO_F("fcvt.d.w", v);
    SLOT(k++) = X_TO_F("fcvt.d.wu", v);
    SLOT(k++) = X_TO_F("fcvt.d.l", v);
    SLOT(k++) = X_TO_F("fcvt.d.lu", v);
  }

  return (long)k;
}
