/*
 * AArch64 integer ALU, including the operand forms the architecture has and
 * RISC-V does not: a second source register that is shifted or sign/zero
 * extended as part of the instruction, and separate flag-setting variants.
 *
 * Division is here because AArch64 defines the awkward cases differently
 * from RISC-V, which is exactly the sort of thing an interpreter written
 * from the wrong manual gets wrong:
 *
 *   sdiv by zero      -> 0            (RISC-V gives -1)
 *   udiv by zero      -> 0            (RISC-V gives all ones)
 *   INT_MIN / -1      -> INT_MIN      (same as RISC-V)
 *   there is no remainder instruction; msub computes it
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

#define RR(insn, a, b, out) do {                                        \
  unsigned long r_, x_ = (a), y_ = (b);                                 \
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "r"(x_), "r"(y_));   \
  (out) = r_; } while (0)

#define RRW(insn, a, b, out) do {                                       \
  unsigned long r_ = 0, x_ = (a), y_ = (b);                             \
  __asm__ volatile(insn " %w0, %w1, %w2" : "=r"(r_) : "r"(x_), "r"(y_)); \
  (out) = r_; } while (0)

#define RRMOD(insn, mod, a, b, out) do {                                \
  unsigned long r_, x_ = (a), y_ = (b);                                 \
  __asm__ volatile(insn " %0, %1, %2, " mod : "=r"(r_) : "r"(x_), "r"(y_)); \
  (out) = r_; } while (0)

/* An extension narrower than the register names the W view of the source:
   `add x0, x1, w2, uxth` is well formed where `add x0, x1, x2, uxth` is not. */
#define RREXT(insn, mod, a, b, out) do {                                \
  unsigned long r_, x_ = (a), y_ = (b);                                 \
  __asm__ volatile(insn " %0, %1, %w2, " mod : "=r"(r_) : "r"(x_), "r"(y_)); \
  (out) = r_; } while (0)

volatile unsigned long v[8] = {
  0, 1, 0xffffffffffffffffUL, 0x8000000000000000UL,
  0x7fffffffffffffffUL, 0x00000000ffffffffUL, 0x0123456789abcdefUL, 0xfedcba9876543210UL,
};

long kernel(void) {
  int k = 0;
  for (int i = 0; i < 8; i++) {
    unsigned long a = v[i];
    unsigned long b = v[(i + 3) % 8];
    RR("add", a, b, SLOT(k++));
    RR("sub", a, b, SLOT(k++));
    RR("and", a, b, SLOT(k++));
    RR("orr", a, b, SLOT(k++));
    RR("eor", a, b, SLOT(k++));
    RR("bic", a, b, SLOT(k++));
    RR("orn", a, b, SLOT(k++));
    RR("eon", a, b, SLOT(k++));
    RR("lsl", a, b, SLOT(k++));
    RR("lsr", a, b, SLOT(k++));
    RR("asr", a, b, SLOT(k++));
    RR("ror", a, b, SLOT(k++));
    RR("mul", a, b, SLOT(k++));
    RR("smulh", a, b, SLOT(k++));
    RR("umulh", a, b, SLOT(k++));
    RR("sdiv", a, b, SLOT(k++));
    RR("udiv", a, b, SLOT(k++));
    /* The 32-bit forms compute on the low half and zero the upper one,
       which is where AArch64 differs from RV64's sign extension. */
    RRW("add", a, b, SLOT(k++));
    RRW("sub", a, b, SLOT(k++));
    RRW("lsl", a, b, SLOT(k++));
    RRW("lsr", a, b, SLOT(k++));
    RRW("asr", a, b, SLOT(k++));
    RRW("ror", a, b, SLOT(k++));
    RRW("mul", a, b, SLOT(k++));
    RRW("sdiv", a, b, SLOT(k++));
    RRW("udiv", a, b, SLOT(k++));
  }

  /* Shifted and extended second operands, which fold a shift or a widening
     into the arithmetic instruction itself. */
  unsigned long a = v[6];
  unsigned long b = v[7];
  RRMOD("add", "lsl #12", a, b, SLOT(k++));
  RRMOD("add", "lsr #7", a, b, SLOT(k++));
  RRMOD("sub", "asr #33", a, b, SLOT(k++));
  /* Rotate is available to the logical instructions but not the
     arithmetic ones, which is itself worth encoding in a test. */
  RRMOD("orr", "ror #17", a, b, SLOT(k++));
  RRMOD("eor", "ror #53", a, b, SLOT(k++));
  RRMOD("and", "lsl #4", a, b, SLOT(k++));
  RREXT("add", "uxtb", a, b, SLOT(k++));
  RREXT("add", "uxth", a, b, SLOT(k++));
  RREXT("add", "uxtw #2", a, b, SLOT(k++));
  RREXT("sub", "sxtb", a, b, SLOT(k++));
  RREXT("sub", "sxth", a, b, SLOT(k++));
  RREXT("sub", "sxtw #3", a, b, SLOT(k++));
  RRMOD("add", "uxtx #1", a, b, SLOT(k++));
  RRMOD("sub", "sxtx #4", a, b, SLOT(k++));

  /* Three-source forms: multiply-add and multiply-subtract, and the widening
     variants. msub is how a remainder is computed. */
  unsigned long r;
  __asm__ volatile("madd %0, %1, %2, %3" : "=r"(r) : "r"(a), "r"(b), "r"(v[4]));
  SLOT(k++) = r;
  __asm__ volatile("msub %0, %1, %2, %3" : "=r"(r) : "r"(a), "r"(b), "r"(v[4]));
  SLOT(k++) = r;
  __asm__ volatile("smaddl %0, %w1, %w2, %3" : "=r"(r) : "r"(a), "r"(b), "r"(v[4]));
  SLOT(k++) = r;
  __asm__ volatile("umaddl %0, %w1, %w2, %3" : "=r"(r) : "r"(a), "r"(b), "r"(v[4]));
  SLOT(k++) = r;
  __asm__ volatile("umull %0, %w1, %w2" : "=r"(r) : "r"(a), "r"(b));
  SLOT(k++) = r;
  __asm__ volatile("smull %0, %w1, %w2" : "=r"(r) : "r"(a), "r"(b));
  SLOT(k++) = r;

  /* Bitfield and extension instructions. */
  __asm__ volatile("sxtb %0, %w1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("sxth %0, %w1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("sxtw %0, %w1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("uxtb %w0, %w1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("uxth %w0, %w1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("ubfx %0, %1, #9, #20" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("sbfx %0, %1, #9, #20" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("ubfiz %0, %1, #5, #12" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("extr %0, %1, %2, #29" : "=r"(r) : "r"(a), "r"(b)); SLOT(k++) = r;
  __asm__ volatile("rbit %0, %1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("rev %0, %1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("rev16 %0, %1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("rev32 %0, %1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("clz %0, %1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("cls %0, %1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("mvn %0, %1" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__ volatile("neg %0, %1" : "=r"(r) : "r"(a)); SLOT(k++) = r;

  return (long)k;
}
