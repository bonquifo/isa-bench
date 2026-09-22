/*
 * Condition flags and everything that reads them.
 *
 * This is the structural difference between AArch64 and RISC-V. RISC-V
 * compares and branches in one instruction and has no flags at all;
 * AArch64 sets N, Z, C and V as a side effect and then branches, selects or
 * increments on them. Getting carry and overflow right is the whole job: the
 * two are easy to conflate and only disagree on operands that straddle a
 * boundary, so every pair here straddles one.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

/*
 * Two families, because the architecture spells them differently. cmp, cmn
 * and tst are two-operand aliases that discard the result and keep only the
 * flags; adds, subs and ands are three-operand forms that keep both.
 */
#define FLAGS2(insn, a, b) ({                                           \
  unsigned long n_, x_ = (a), y_ = (b);                                 \
  __asm__ volatile(insn " %1, %2\n\tmrs %0, nzcv"                       \
                   : "=r"(n_) : "r"(x_), "r"(y_) : "cc");               \
  n_; })

#define FLAGS3(insn, a, b) ({                                           \
  unsigned long n_, d_, x_ = (a), y_ = (b);                             \
  __asm__ volatile(insn " %1, %2, %3\n\tmrs %0, nzcv"                   \
                   : "=r"(n_), "=&r"(d_) : "r"(x_), "r"(y_) : "cc");    \
  n_; })

#define FLAGS3W(insn, a, b) ({                                          \
  unsigned long n_, d_ = 0, x_ = (a), y_ = (b);                         \
  __asm__ volatile(insn " %w1, %w2, %w3\n\tmrs %0, nzcv"                \
                   : "=r"(n_), "=&r"(d_) : "r"(x_), "r"(y_) : "cc");    \
  n_; })

/* Compares, then reports whether the named condition holds. */
#define COND(cc, a, b) ({                                               \
  unsigned long r_, x_ = (a), y_ = (b);                                 \
  __asm__ volatile("cmp %1, %2\n\tcset %0, " cc                         \
                   : "=r"(r_) : "r"(x_), "r"(y_) : "cc");               \
  r_; })

/* Compares, then takes a branch on the condition, so the branch itself and
   not only the flag read is exercised. */
#define BRANCH(cc, a, b) ({                                             \
  unsigned long r_, x_ = (a), y_ = (b);                                 \
  __asm__ volatile("cmp %1, %2\n\t"                                     \
                   "b." cc " 1f\n\t"                                    \
                   "mov %0, #0\n\t"                                     \
                   "b 2f\n"                                             \
                   "1:\tmov %0, #1\n"                                   \
                   "2:"                                                 \
                   : "=r"(r_) : "r"(x_), "r"(y_) : "cc");               \
  r_; })

#define I64_MIN 0x8000000000000000UL
#define I64_MAX 0x7fffffffffffffffUL

volatile unsigned long lhs[8] = { 0, 1, I64_MAX, I64_MIN, 0xffffffffffffffffUL, 1, I64_MIN, 0x7fffffff };
volatile unsigned long rhs[8] = { 0, 0, 1, 1, 1, 0xffffffffffffffffUL, I64_MAX, 0x80000000 };

long kernel(void) {
  int k = 0;
  for (int i = 0; i < 8; i++) {
    unsigned long a = lhs[i];
    unsigned long b = rhs[i];
    SLOT(k++) = FLAGS2("cmp", a, b);
    SLOT(k++) = FLAGS2("cmn", a, b);
    SLOT(k++) = FLAGS2("tst", a, b);
    SLOT(k++) = FLAGS3("adds", a, b);
    SLOT(k++) = FLAGS3("subs", a, b);
    SLOT(k++) = FLAGS3("ands", a, b);
    SLOT(k++) = FLAGS3("bics", a, b);
    SLOT(k++) = FLAGS3W("adds", a, b);
    SLOT(k++) = FLAGS3W("subs", a, b);
    /* Carry differs from overflow exactly here: one is unsigned, the other
       signed, and a pair that wraps one way need not wrap the other. */
    SLOT(k++) = COND("eq", a, b);
    SLOT(k++) = COND("ne", a, b);
    SLOT(k++) = COND("hs", a, b);
    SLOT(k++) = COND("lo", a, b);
    SLOT(k++) = COND("mi", a, b);
    SLOT(k++) = COND("pl", a, b);
    SLOT(k++) = COND("vs", a, b);
    SLOT(k++) = COND("vc", a, b);
    SLOT(k++) = COND("hi", a, b);
    SLOT(k++) = COND("ls", a, b);
    SLOT(k++) = COND("ge", a, b);
    SLOT(k++) = COND("lt", a, b);
    SLOT(k++) = COND("gt", a, b);
    SLOT(k++) = COND("le", a, b);
    SLOT(k++) = BRANCH("lt", a, b);
    SLOT(k++) = BRANCH("lo", a, b);
    SLOT(k++) = BRANCH("vs", a, b);
  }

  /* The conditional select family, which is how AArch64 avoids branching. */
  unsigned long a = lhs[3];
  unsigned long b = rhs[6];
  unsigned long r;
  __asm__ volatile("cmp %1, %2\n\tcsel %0, %1, %2, lt"
                   : "=r"(r) : "r"(a), "r"(b) : "cc"); SLOT(k++) = r;
  __asm__ volatile("cmp %1, %2\n\tcsinc %0, %1, %2, ge"
                   : "=r"(r) : "r"(a), "r"(b) : "cc"); SLOT(k++) = r;
  __asm__ volatile("cmp %1, %2\n\tcsinv %0, %1, %2, lo"
                   : "=r"(r) : "r"(a), "r"(b) : "cc"); SLOT(k++) = r;
  __asm__ volatile("cmp %1, %2\n\tcsneg %0, %1, %2, hi"
                   : "=r"(r) : "r"(a), "r"(b) : "cc"); SLOT(k++) = r;
  __asm__ volatile("cmp %1, %2\n\tcinc %0, %1, eq"
                   : "=r"(r) : "r"(a), "r"(b) : "cc"); SLOT(k++) = r;
  __asm__ volatile("cmp %1, %2\n\tcsetm %0, ne"
                   : "=r"(r) : "r"(a), "r"(b) : "cc"); SLOT(k++) = r;
  /* Carry in as well as out: adc and sbc read C. */
  __asm__ volatile("subs xzr, %1, %2\n\tadc %0, %1, %2"
                   : "=r"(r) : "r"(a), "r"(b) : "cc"); SLOT(k++) = r;
  __asm__ volatile("subs xzr, %1, %2\n\tsbc %0, %1, %2"
                   : "=r"(r) : "r"(a), "r"(b) : "cc"); SLOT(k++) = r;

  /* Compare-and-branch and test-bit-and-branch read no flags at all. */
  for (int i = 0; i < 8; i++) {
    unsigned long value = lhs[i];
    __asm__ volatile("cbz %1, 1f\n\tmov %0, #7\n\tb 2f\n1:\tmov %0, #9\n2:"
                     : "=r"(r) : "r"(value)); SLOT(k++) = r;
    __asm__ volatile("cbnz %1, 1f\n\tmov %0, #7\n\tb 2f\n1:\tmov %0, #9\n2:"
                     : "=r"(r) : "r"(value)); SLOT(k++) = r;
    __asm__ volatile("tbz %1, #63, 1f\n\tmov %0, #7\n\tb 2f\n1:\tmov %0, #9\n2:"
                     : "=r"(r) : "r"(value)); SLOT(k++) = r;
    __asm__ volatile("tbnz %1, #31, 1f\n\tmov %0, #7\n\tb 2f\n1:\tmov %0, #9\n2:"
                     : "=r"(r) : "r"(value)); SLOT(k++) = r;
  }

  return (long)k;
}
