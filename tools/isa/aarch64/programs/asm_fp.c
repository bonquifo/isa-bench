/*
 * Floating point, over the values that separate a correct implementation
 * from a nearly correct one.
 *
 * Two places AArch64 differs from RISC-V and the difference is easy to miss:
 *
 *   fmin and fmax propagate a NaN operand rather than ignoring it, which is
 *   the opposite of RISC-V. fminnm and fmaxnm are the IEEE forms that do
 *   ignore it, and both are here.
 *
 *   fcmp writes the condition flags rather than a general register, and an
 *   unordered comparison sets a distinct flag pattern rather than simply
 *   answering false.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

static inline double from_bits(unsigned long bits) {
  double d;
  __asm__("fmov %d0, %1" : "=w"(d) : "r"(bits));
  return d;
}

static inline unsigned long to_bits(double d) {
  unsigned long bits;
  __asm__("fmov %0, %d1" : "=r"(bits) : "w"(d));
  return bits;
}

#define F_BIN(insn, a, b) ({                                            \
  double r_;                                                            \
  __asm__ volatile(insn " %d0, %d1, %d2" : "=w"(r_) : "w"(a), "w"(b));  \
  to_bits(r_); })

#define F_UN(insn, a) ({                                                \
  double r_;                                                            \
  __asm__ volatile(insn " %d0, %d1" : "=w"(r_) : "w"(a));               \
  to_bits(r_); })

#define F_CMP(insn, a, b) ({                                            \
  unsigned long n_;                                                     \
  __asm__ volatile(insn " %d1, %d2\n\tmrs %0, nzcv"                     \
                   : "=r"(n_) : "w"(a), "w"(b) : "cc");                 \
  n_; })

#define F_TO_X(insn, a) ({                                              \
  unsigned long r_;                                                     \
  __asm__ volatile(insn " %0, %d1" : "=r"(r_) : "w"(a));                \
  r_; })

#define X_TO_F(insn, a) ({                                              \
  double r_;                                                            \
  __asm__ volatile(insn " %d0, %1" : "=w"(r_) : "r"((unsigned long)(a))); \
  to_bits(r_); })

volatile unsigned long left[8] = {
  0x0000000000000000UL, 0x8000000000000000UL, 0x3ff8000000000000UL, 0x7ff0000000000000UL,
  0x7ff8000000000000UL, 0x7ff0000000000001UL, 0x7fefffffffffffffUL, 0x0000000000000001UL,
};
volatile unsigned long right[8] = {
  0x8000000000000000UL, 0x0000000000000000UL, 0xc002000000000000UL, 0xfff0000000000000UL,
  0x3ff8000000000000UL, 0x7ff8000000000000UL, 0x7fefffffffffffffUL, 0x0010000000000000UL,
};
volatile long integers[6] = {
  0, 1, -1, 2147483647L, -9223372036854775807L - 1L, 0x0020000000000001L,
};

long kernel(void) {
  int k = 0;
  for (int i = 0; i < 8; i++) {
    double a = from_bits(left[i]);
    double b = from_bits(right[i]);
    SLOT(k++) = F_BIN("fadd", a, b);
    SLOT(k++) = F_BIN("fsub", a, b);
    SLOT(k++) = F_BIN("fmul", a, b);
    SLOT(k++) = F_BIN("fdiv", a, b);
    /* fmin propagates NaN; fminnm does not. The pair only disagrees when
       one operand is a NaN, which half of these are. */
    SLOT(k++) = F_BIN("fmin", a, b);
    SLOT(k++) = F_BIN("fmax", a, b);
    SLOT(k++) = F_BIN("fminnm", a, b);
    SLOT(k++) = F_BIN("fmaxnm", a, b);
    SLOT(k++) = F_BIN("fnmul", a, b);
    SLOT(k++) = F_UN("fsqrt", a);
    SLOT(k++) = F_UN("fneg", a);
    SLOT(k++) = F_UN("fabs", a);
    SLOT(k++) = F_UN("frinta", a);
    SLOT(k++) = F_UN("frintm", a);
    SLOT(k++) = F_UN("frintp", a);
    SLOT(k++) = F_UN("frintz", a);
    SLOT(k++) = F_UN("frintn", a);
    /* An unordered comparison is a distinct flag pattern, not a false. */
    SLOT(k++) = F_CMP("fcmp", a, b);
    SLOT(k++) = F_CMP("fcmpe", a, b);
    SLOT(k++) = F_TO_X("fcvtzs", a);
    SLOT(k++) = F_TO_X("fcvtzu", a);
    SLOT(k++) = F_TO_X("fcvtas", a);
    SLOT(k++) = F_TO_X("fcvtms", a);
    SLOT(k++) = F_TO_X("fcvtps", a);
    SLOT(k++) = F_TO_X("fcvtns", a);
    SLOT(k++) = F_TO_X("fmov", a);
  }

  for (int i = 0; i < 6; i++) {
    SLOT(k++) = X_TO_F("scvtf", integers[i]);
    SLOT(k++) = X_TO_F("ucvtf", integers[i]);
    SLOT(k++) = X_TO_F("fmov", integers[i]);
  }

  /* Single precision, including the narrowing and widening conversions and
     the fused multiply-add the compiler emits for a * b + c. */
  for (int i = 0; i < 8; i++) {
    double wide = from_bits(left[i]);
    float narrow;
    double back;
    unsigned int single;
    __asm__ volatile("fcvt %s0, %d1" : "=w"(narrow) : "w"(wide));
    __asm__ volatile("fmov %w0, %s1" : "=r"(single) : "w"(narrow));
    SLOT(k++) = single;
    __asm__ volatile("fcvt %d0, %s1" : "=w"(back) : "w"(narrow));
    SLOT(k++) = to_bits(back);

    double x = from_bits(left[i]);
    double y = from_bits(right[i]);
    double z = from_bits(left[(i + 3) % 8]);
    double r;
    __asm__ volatile("fmadd %d0, %d1, %d2, %d3" : "=w"(r) : "w"(x), "w"(y), "w"(z));
    SLOT(k++) = to_bits(r);
    __asm__ volatile("fmsub %d0, %d1, %d2, %d3" : "=w"(r) : "w"(x), "w"(y), "w"(z));
    SLOT(k++) = to_bits(r);
    __asm__ volatile("fnmadd %d0, %d1, %d2, %d3" : "=w"(r) : "w"(x), "w"(y), "w"(z));
    SLOT(k++) = to_bits(r);
    __asm__ volatile("fnmsub %d0, %d1, %d2, %d3" : "=w"(r) : "w"(x), "w"(y), "w"(z));
    SLOT(k++) = to_bits(r);
  }

  return (long)k;
}
