/*
 * Every conditional branch, at the operand pairs where signed and unsigned
 * ordering disagree. blt and bltu differ only across the sign boundary, so a
 * test that never crosses it cannot tell them apart.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

#define I64_MIN (-9223372036854775807L - 1L)
#define I64_MAX 9223372036854775807L

/* Branch taken yields 1, not taken yields 0, via a forward local label. */
#define BR(insn, a, b) ({                                       \
  unsigned long r_;                                             \
  __asm__ volatile(insn " %1, %2, 1f\n\t"                       \
                   "li %0, 0\n\t"                               \
                   "j 2f\n"                                     \
                   "1:\tli %0, 1\n"                             \
                   "2:"                                         \
                   : "=r"(r_) : "r"(a), "r"(b));                \
  r_;                                                           \
})

volatile long lhs[8] = { 0, -1, 0, I64_MIN, I64_MAX, -1, 1, -1 };
volatile long rhs[8] = { 0, 0, -1, I64_MAX, I64_MIN, -1, -1, 1 };

volatile int trip = 37;

long kernel(void) {
  int k = 0;
  for (int i = 0; i < 8; i++) {
    long a = lhs[i];
    long b = rhs[i];
    SLOT(k++) = BR("beq", a, b);
    SLOT(k++) = BR("bne", a, b);
    SLOT(k++) = BR("blt", a, b);
    SLOT(k++) = BR("bge", a, b);
    SLOT(k++) = BR("bltu", a, b);
    SLOT(k++) = BR("bgeu", a, b);
  }

  /* A real loop, so the compiler's own branch shapes are covered too: a
     back edge, a nested conditional, and an early exit. */
  long acc = 0;
  int n = trip;
  for (int i = 0; i < n; i++) {
    if ((i & 3) == 0) acc += i * 3;
    else if (i & 1) acc -= i;
    else acc ^= (long)i << 8;
    if (acc > 100000) break;
  }
  SLOT(k++) = (unsigned long)acc;

  long j = 0;
  long sum = 0;
  while (j < n) {
    sum += (j % 5 == 0) ? j : -j;
    j += 2;
  }
  SLOT(k++) = (unsigned long)sum;

  return acc ^ sum;
}
