/*
 * The A extension. Every read-modify-write form at both widths, plus
 * load-reserved and store-conditional.
 *
 * Single-threaded, so the interesting content is not concurrency but the
 * arithmetic: amomin and amomax differ from their unsigned forms only across
 * the sign boundary, the W forms operate on the low half and sign-extend the
 * value they return, and a store-conditional with no matching reservation
 * has to fail rather than succeed quietly.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
/* The memory the atomics operate on lives in the dump, so the final values
   are compared as well as the values each instruction returned. */
#define CELL(i) ((volatile unsigned long *)isa_dump.scratch + (i))

#define AMO(insn, cell, value, out) do {                                \
  unsigned long r_, v_ = (value);                                       \
  volatile unsigned long *p_ = (cell);                                  \
  __asm__ volatile(insn " %0, %2, (%1)"                                 \
                   : "=r"(r_) : "r"(p_), "r"(v_) : "memory");           \
  (out) = r_;                                                           \
} while (0)

volatile unsigned long seeds[6] = {
  0, 1, 0xffffffffffffffffUL, 0x8000000000000000UL, 0x7fffffffffffffffUL, 0x00000000ffffffffUL,
};
volatile unsigned long operands[6] = {
  1, 0xffffffffffffffffUL, 0x8000000000000000UL, 7, 0x7fffffffffffffffUL, 0x123456789abcdefUL,
};

long kernel(void) {
  int k = 16;

  for (int i = 0; i < 6; i++) {
    for (int w = 0; w < 2; w++) {
      *CELL(i) = seeds[i];
      unsigned long v = operands[i];
      if (w == 0) {
        AMO("amoswap.d", CELL(i), v, SLOT(k++));
        SLOT(k++) = *CELL(i);
        *CELL(i) = seeds[i];
        AMO("amoadd.d", CELL(i), v, SLOT(k++));
        SLOT(k++) = *CELL(i);
        *CELL(i) = seeds[i];
        AMO("amoxor.d", CELL(i), v, SLOT(k++));
        *CELL(i) = seeds[i];
        AMO("amoand.d", CELL(i), v, SLOT(k++));
        *CELL(i) = seeds[i];
        AMO("amoor.d", CELL(i), v, SLOT(k++));
        *CELL(i) = seeds[i];
        AMO("amomin.d", CELL(i), v, SLOT(k++));
        SLOT(k++) = *CELL(i);
        *CELL(i) = seeds[i];
        AMO("amomax.d", CELL(i), v, SLOT(k++));
        *CELL(i) = seeds[i];
        AMO("amominu.d", CELL(i), v, SLOT(k++));
        *CELL(i) = seeds[i];
        AMO("amomaxu.d", CELL(i), v, SLOT(k++));
        SLOT(k++) = *CELL(i);
      } else {
        *CELL(i) = seeds[i];
        AMO("amoswap.w", CELL(i), v, SLOT(k++));
        SLOT(k++) = *CELL(i);
        *CELL(i) = seeds[i];
        AMO("amoadd.w", CELL(i), v, SLOT(k++));
        SLOT(k++) = *CELL(i);
        *CELL(i) = seeds[i];
        AMO("amomin.w", CELL(i), v, SLOT(k++));
        *CELL(i) = seeds[i];
        AMO("amomax.w", CELL(i), v, SLOT(k++));
        *CELL(i) = seeds[i];
        AMO("amominu.w", CELL(i), v, SLOT(k++));
        *CELL(i) = seeds[i];
        AMO("amomaxu.w", CELL(i), v, SLOT(k++));
        SLOT(k++) = *CELL(i);
      }
    }
  }

  /* Load-reserved then store-conditional: the paired case must succeed. */
  volatile unsigned long *cell = CELL(12);
  *cell = 0x1122334455667788UL;
  unsigned long observed, status;
  __asm__ volatile("lr.d %0, (%1)" : "=r"(observed) : "r"(cell) : "memory");
  SLOT(k++) = observed;
  __asm__ volatile("sc.d %0, %2, (%1)"
                   : "=r"(status) : "r"(cell), "r"(0xdeadbeefcafef00dUL) : "memory");
  SLOT(k++) = status;
  SLOT(k++) = *cell;

  /* A store-conditional to an address no reservation covers must fail. */
  volatile unsigned long *other = CELL(13);
  *other = 5;
  __asm__ volatile("sc.d %0, %2, (%1)" : "=r"(status) : "r"(other), "r"(99UL) : "memory");
  SLOT(k++) = status;
  SLOT(k++) = *other;

  /* And the word-width pair. */
  __asm__ volatile("lr.w %0, (%1)" : "=r"(observed) : "r"(cell) : "memory");
  SLOT(k++) = observed;
  __asm__ volatile("sc.w %0, %2, (%1)" : "=r"(status) : "r"(cell), "r"(0x99887766UL) : "memory");
  SLOT(k++) = status;
  SLOT(k++) = *cell;

  return (long)k;
}
