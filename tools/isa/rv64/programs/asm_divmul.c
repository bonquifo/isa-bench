/*
 * Division and multiplication at the boundaries, pinned down with inline asm.
 *
 * RV64 defines what C leaves undefined, and the definitions are unusual enough
 * that an interpreter written from intuition gets them wrong:
 *
 *   div  by zero  -> -1            divu by zero  -> 2^64 - 1
 *   rem  by zero  -> the dividend  remu by zero  -> the dividend
 *   INT64_MIN / -1 -> INT64_MIN    INT64_MIN % -1 -> 0        (no trap)
 *
 * The W forms operate on the low 32 bits and sign-extend the result, so
 * INT32_MIN / -1 has the same shape one width down.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

#define I64_MIN (-9223372036854775807L - 1L)
#define I64_MAX 9223372036854775807L

volatile long dividend[10] = {
  I64_MIN, I64_MIN, -1, 7, 7, -7, -7, I64_MAX, 0, 0x100000000L,
};
volatile long divisor[10] = {
  -1, 0, 0, 0, -2, 2, -2, -1, 0, 3,
};

long kernel(void) {
  int k = 0;
  for (int i = 0; i < 10; i++) {
    long a = dividend[i];
    long b = divisor[i];
    unsigned long r;
    __asm__("div   %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("divu  %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("rem   %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("remu  %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("divw  %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("divuw %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("remw  %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("remuw %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
  }

  /* The four multiply-high forms differ only in how they treat the signs, so
     they diverge exactly on operands where the signs disagree. */
  for (int i = 0; i < 6; i++) {
    long a = dividend[i];
    long b = dividend[9 - i];
    unsigned long r;
    __asm__("mul    %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("mulh   %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("mulhu  %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("mulhsu %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
    __asm__("mulw   %0, %1, %2" : "=r"(r) : "r"(a), "r"(b));
    SLOT(k++) = r;
  }

  return (long)k;
}
