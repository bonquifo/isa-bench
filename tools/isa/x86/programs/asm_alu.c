/*
 * The arithmetic, and the flags it leaves behind.
 *
 * On this architecture the flags are not a side channel, they are the
 * result. A compare produces nothing else, and the branch, the conditional
 * move and the conditional set that follow it read nothing else.
 *
 * The operands are chosen so the six flags disagree with each other. The
 * carry flag and the overflow flag differ exactly when the unsigned and
 * signed readings of the same addition differ, which needs operands either
 * side of both boundaries; the adjust flag is carry out of bit three,
 * which needs operands whose low nibbles overflow independently of the
 * rest; and the parity flag is computed from the low byte alone, which
 * needs results whose low byte varies while the rest does not.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

/*
 * The flags are not recorded here.
 *
 * The lockstep tier compares the flag register before every instruction,
 * excluding the bits the architecture leaves undefined after whatever
 * wrote them -- the adjust flag after a logical operation, the overflow
 * flag after a shift by more than one. Reading the flags into a register
 * instead would copy those same bits into an ordinary value, where nothing
 * can exclude them and any interpreter would be held to reproducing
 * whatever this particular processor happened to leave behind.
 */
#define RR(insn, reg, a, b, out) do {                                   \
  unsigned long r_ = (a), y_ = (b);                                     \
  __asm__ volatile(insn " " reg "2, " reg "0"                           \
                   : "+r"(r_) : "r"(y_) : "cc");                        \
  (out) = r_; } while (0)

#define UN(insn, reg, a, out) do {                                      \
  unsigned long r_ = (a);                                               \
  __asm__ volatile(insn " " reg "0" : "+r"(r_) :: "cc");                \
  (out) = r_; } while (0)

#define CMP_SET(cc, a, b, out) do {                                     \
  unsigned long r_ = 0, x_ = (a), y_ = (b);                             \
  __asm__ volatile("cmpq %2, %1\n\tset" cc " %b0"                       \
                   : "+r"(r_) : "r"(x_), "r"(y_) : "cc");               \
  (out) = r_; } while (0)

/* An addition whose carry the next instruction consumes, and a subtract
   that consumes it again: the only way to see that the carry survives. */
#define CARRY_CHAIN(a, b, c, out) do {                                  \
  unsigned long r_ = (a), y_ = (b), z_ = (c);                           \
  __asm__ volatile("addq %1, %0\n\tadcq %2, %0\n\tsbbq %1, %0"          \
                   : "+r"(r_) : "r"(y_), "r"(z_) : "cc");               \
  (out) = r_; } while (0)

/*
 * Values that make the flags disagree. Each is interesting against several
 * of the others rather than on its own.
 */
volatile unsigned long v[16] = {
  0x0000000000000000UL, 0x0000000000000001UL, 0xffffffffffffffffUL,
  0x7fffffffffffffffUL, 0x8000000000000000UL, 0x8000000000000001UL,
  0x000000007fffffffUL, 0x0000000080000000UL, 0x00000000ffffffffUL,
  0x000000000000000fUL, 0x0000000000000010UL, 0x00000000000000ffUL,
  0x5555555555555555UL, 0xaaaaaaaaaaaaaaaaUL, 0x0123456789abcdefUL,
  0xfedcba9876543210UL,
};

long kernel(void) {
  int k = 0;

  /* Every pair, at 64 and at 32 bits. The 32-bit forms matter separately
     because their result zeroes the upper half of the register rather than
     leaving it, and because their flags come from the narrow result. */
  for (int i = 0; i < 16; i++) {
    int j = (i * 7 + 3) & 15;
    RR("addq", "%", v[i], v[j], SLOT(k++));
    RR("subq", "%", v[i], v[j], SLOT(k++));
    RR("andq", "%", v[i], v[j], SLOT(k++));
    RR("orq", "%", v[i], v[j], SLOT(k++));
    RR("xorq", "%", v[i], v[j], SLOT(k++));
    RR("addl", "%k", v[i], v[j], SLOT(k++));
    RR("subl", "%k", v[i], v[j], SLOT(k++));
  }

  /* The narrow widths, whose results leave the rest of the register alone. */
  for (int i = 0; i < 8; i++) {
    int j = (i * 5 + 1) & 15;
    RR("addw", "%w", v[i], v[j], SLOT(k++));
    RR("addb", "%b", v[i], v[j], SLOT(k++));
    RR("subb", "%b", v[i], v[j], SLOT(k++));
    RR("andb", "%b", v[i], v[j], SLOT(k++));
  }

  /* Increment and decrement, which leave the carry flag alone -- the one
     thing that separates them from adding one. */
  for (int i = 0; i < 8; i++) {
    UN("incq", "%", v[i], SLOT(k++));
    UN("decq", "%", v[i], SLOT(k++));
    UN("negq", "%", v[i], SLOT(k++));
    UN("notq", "%", v[i], SLOT(k++));
    UN("incl", "%k", v[i], SLOT(k++));
    UN("negb", "%b", v[i], SLOT(k++));
  }

  /* Add with carry and subtract with borrow, chained so the carry produced
     by one instruction is consumed by the next. */
  for (int i = 0; i < 8; i++) {
    CARRY_CHAIN(v[i], v[(i + 5) & 15], v[(i + 11) & 15], SLOT(k++));
  }

  /* Every condition code against the same comparison, which is the only
     way to tell the signed ones from the unsigned ones apart. */
  for (int i = 0; i < 6; i++) {
    int j = (i * 3 + 2) & 15;
    CMP_SET("o", v[i], v[j], SLOT(k++));
    CMP_SET("no", v[i], v[j], SLOT(k++));
    CMP_SET("b", v[i], v[j], SLOT(k++));
    CMP_SET("ae", v[i], v[j], SLOT(k++));
    CMP_SET("e", v[i], v[j], SLOT(k++));
    CMP_SET("ne", v[i], v[j], SLOT(k++));
    CMP_SET("be", v[i], v[j], SLOT(k++));
    CMP_SET("a", v[i], v[j], SLOT(k++));
    CMP_SET("s", v[i], v[j], SLOT(k++));
    CMP_SET("ns", v[i], v[j], SLOT(k++));
    CMP_SET("p", v[i], v[j], SLOT(k++));
    CMP_SET("np", v[i], v[j], SLOT(k++));
    CMP_SET("l", v[i], v[j], SLOT(k++));
    CMP_SET("ge", v[i], v[j], SLOT(k++));
    CMP_SET("le", v[i], v[j], SLOT(k++));
    CMP_SET("g", v[i], v[j], SLOT(k++));
  }

  return (long)k;
}
