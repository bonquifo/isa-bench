/*
 * The x87 stack, in the 80-bit format only it uses.
 *
 * A compiler does not emit any of this for ordinary arithmetic on this
 * target -- that is all SSE. It appears for one reason: a `long double` is
 * this format, and a libc's printf converts every floating-point value
 * through one before it prints it. So the correctness of `printf("%f")`
 * rests entirely on the code below.
 *
 * Three things here are not true of any other floating-point unit in this
 * project, and each has its own section.
 *
 * The significand's leading bit is stored rather than implied, so the
 * encoding can hold bit patterns the format cannot interpret, and the
 * round trip through memory is itself worth testing.
 *
 * The precision is a control-register field rather than a property of the
 * type: the same fmul rounds to 64, 53 or 24 significant bits depending on
 * what was last loaded into the control word. A libc changes it mid-way.
 *
 * And it is a stack with a moving top, so which physical register st(1)
 * means depends on how many values have been pushed.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

/* An 80-bit value occupies ten bytes; the pair of slots holds all of it. */
#define PUT80(k, expr) do {                                             \
  long double v_ = (expr);                                              \
  unsigned char b_[16] = { 0 };                                         \
  __asm__ volatile("fldt %1\n\tfstpt %0" : "=m"(b_) : "m"(v_));         \
  SLOT(k) = *(unsigned long *)b_;                                       \
  SLOT((k) + 1) = (unsigned long)*(unsigned short *)(b_ + 8);           \
} while (0)

#define BIN(insn, a, b, out) do {                                       \
  long double x_ = (a), y_ = (b), r_;                                   \
  __asm__ volatile("fldt %1\n\tfldt %2\n\t" insn "\n\tfstpt %0"         \
                   : "=m"(r_) : "m"(x_), "m"(y_));                      \
  PUT80(out, r_); } while (0)

/* The forms that take their second operand straight from memory. */
#define MEM64(insn, a, b, out) do {                                     \
  long double x_ = (a), r_; double y_ = (b);                            \
  __asm__ volatile("fldt %1\n\t" insn " %2\n\tfstpt %0"                 \
                   : "=m"(r_) : "m"(x_), "m"(y_));                      \
  PUT80(out, r_); } while (0)

#define MEM32I(insn, a, b, out) do {                                    \
  long double x_ = (a), r_; int y_ = (b);                               \
  __asm__ volatile("fldt %1\n\t" insn " %2\n\tfstpt %0"                 \
                   : "=m"(r_) : "m"(x_), "m"(y_));                      \
  PUT80(out, r_); } while (0)

#define UNARY(insn, a, out) do {                                        \
  long double x_ = (a), r_;                                             \
  __asm__ volatile("fldt %1\n\t" insn "\n\tfstpt %0" : "=m"(r_) : "m"(x_)); \
  PUT80(out, r_); } while (0)

/* A compare that writes the integer flags, read through the instruction
   that exists to read one of them. */
#define UCOMI(a, b, out) do {                                           \
  long double x_ = (a), y_ = (b);                                       \
  unsigned long e_ = 0, c_ = 0, p_ = 0;                                 \
  __asm__ volatile("fldt %4\n\tfldt %3\n\tfucomip %%st(1), %%st\n\tfstp %%st(0)\n\t" \
                   "sete %b0\n\tsetc %b1\n\tsetp %b2"                   \
                   : "+r"(e_), "+r"(c_), "+r"(p_) : "m"(x_), "m"(y_) : "cc"); \
  (out) = e_ | (c_ << 8) | (p_ << 16); } while (0)

/* Rounding to an integer, which is a store rather than an operation. */
#define TO_INT(insn, type, a, out) do {                                 \
  long double x_ = (a); type r_ = 0;                                    \
  __asm__ volatile("fldt %1\n\t" insn " %0" : "=m"(r_) : "m"(x_));      \
  (out) = (unsigned long)(long)r_; } while (0)

#define FROM_INT(insn, type, a, out) do {                               \
  type x_ = (a); long double r_;                                        \
  __asm__ volatile(insn " %1\n\tfstpt %0" : "=m"(r_) : "m"(x_));        \
  PUT80(out, r_); } while (0)

/*
 * Values that make the rounding visible. The ratios are ones whose binary
 * expansion does not end, so every one of them is a different answer at 64
 * bits than at 53 or 24; the boundary cases are there because that is
 * where a rounding rule that is nearly right stops being right.
 */
volatile double dv[10] = {
  1.75, 1.5, 0.1, 1.0 / 3.0, 1e300, 5e-324, 2.2250738585072014e-308,
  -0.0, 123456789.0, 1e-200,
};
volatile int iv[6] = { 0, 1, -1, 1000000000, -2147483647 - 1, 7 };

long kernel(void) {
  int k = 0;

  /* Loading each width and storing it back at the widest, which is the
     only way to see what a narrowing load kept. */
  for (int i = 0; i < 10; i++) {
    PUT80(k, (long double)dv[i]); k += 2;
    PUT80(k, (long double)(float)dv[i]); k += 2;
  }
  for (int i = 0; i < 6; i++) {
    FROM_INT("fildl", int, iv[i], k); k += 2;
    FROM_INT("filds", short, (short)iv[i], k); k += 2;
    FROM_INT("fildll", long, (long)iv[i] * 1000000007L, k); k += 2;
  }

  /* Arithmetic between two stack slots, both ways round. The reversed
     forms exist because the destination is fixed, and they are where an
     implementation that swapped the operands would show. */
  for (int i = 0; i < 8; i++) {
    long double a = (long double)dv[i];
    long double b = (long double)dv[(i + 3) % 10];
    BIN("faddp %%st, %%st(1)", a, b, k); k += 2;
    BIN("fsubp %%st, %%st(1)", a, b, k); k += 2;
    BIN("fsubrp %%st, %%st(1)", a, b, k); k += 2;
    BIN("fmulp %%st, %%st(1)", a, b, k); k += 2;
    BIN("fdivp %%st, %%st(1)", a, b, k); k += 2;
    BIN("fdivrp %%st, %%st(1)", a, b, k); k += 2;
    BIN("fxch %%st(1)\n\tfaddp %%st, %%st(1)", a, b, k); k += 2;
  }

  /* The forms whose second operand is memory rather than the stack, at
     both the real widths and as an integer. */
  for (int i = 0; i < 6; i++) {
    long double a = (long double)dv[i];
    MEM64("faddl", a, dv[(i + 5) % 10], k); k += 2;
    MEM64("fsubl", a, dv[(i + 5) % 10], k); k += 2;
    MEM64("fsubrl", a, dv[(i + 5) % 10], k); k += 2;
    MEM64("fmull", a, dv[(i + 5) % 10], k); k += 2;
    MEM64("fdivl", a, dv[(i + 5) % 10], k); k += 2;
    MEM32I("fiaddl", a, iv[i % 6], k); k += 2;
    MEM32I("fimull", a, iv[i % 6], k); k += 2;
  }

  /* Sign, and the compare that reports unordered as a pattern of its own. */
  for (int i = 0; i < 8; i++) {
    UNARY("fchs", (long double)dv[i], k); k += 2;
    UNARY("fabs", (long double)dv[i], k); k += 2;
    UCOMI((long double)dv[i], (long double)dv[(i + 2) % 10], SLOT(k)); k += 1;
  }

  /* Rounding to an integer at each width, including the values that do
     not fit and become the indefinite one rather than saturating. */
  for (int i = 0; i < 8; i++) {
    long double a = (long double)dv[i];
    TO_INT("fistpl", int, a, SLOT(k)); k += 1;
    TO_INT("fistps", short, a, SLOT(k)); k += 1;
    TO_INT("fistpll", long, a, SLOT(k)); k += 1;
  }

  /*
   * The control word. Each setting rounds the same division differently,
   * and an implementation that ignored the word would give the same answer
   * three times.
   */
  {
    unsigned short saved = 0, cw;
    __asm__ volatile("fnstcw %0" : "=m"(saved));
    SLOT(k++) = saved;
    /* 0x0c00 is round-to-zero, 0x0800 up, 0x0400 down; the 0x0300 field
       is the precision, and 0x0000 in it means 24 bits. */
    static const unsigned short settings[] = {
      0x037f, 0x027f, 0x007f, 0x0f7f, 0x0b7f, 0x077f,
    };
    for (unsigned i = 0; i < sizeof settings / sizeof settings[0]; i++) {
      cw = settings[i];
      __asm__ volatile("fldcw %0" :: "m"(cw));
      long double one = 1.0L, three = 3.0L, r;
      __asm__ volatile("fldt %1\n\tfldt %2\n\tfdivp %%st, %%st(1)\n\tfstpt %0"
                       : "=m"(r) : "m"(one), "m"(three));
      PUT80(k, r); k += 2;
      __asm__ volatile("fldt %1\n\tfldt %2\n\tfaddp %%st, %%st(1)\n\tfstpt %0"
                       : "=m"(r) : "m"(r), "m"(one));
      PUT80(k, r); k += 2;
      unsigned short readback = 0;
      __asm__ volatile("fnstcw %0" : "=m"(readback));
      SLOT(k++) = readback;
    }
    __asm__ volatile("fldcw %0" :: "m"(saved));
  }

  return (long)k;
}
