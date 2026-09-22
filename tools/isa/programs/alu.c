/*
 * Integer ALU through the compiler: whatever clang chooses to emit at -O2 for
 * ordinary 64-bit and 32-bit C arithmetic. This is the "does real compiled
 * code work" case, as distinct from the asm_* programs, which pin down
 * individual instruction semantics.
 *
 * Inputs come from volatile globals so nothing here is constant-folded away.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

volatile unsigned long seed_u = 0x0123456789abcdefUL;
volatile long seed_s = -8070450532247928833L; /* 0x8fff0000ffff7fff */
volatile int seed_i = -2000000000;
volatile unsigned seed_w = 4000000000u;
volatile short seed_h = -31000;
volatile signed char seed_b = -120;

long kernel(void) {
  unsigned long u = seed_u;
  long s = seed_s;
  int i = seed_i;
  unsigned w = seed_w;

  SLOT(0) = u + 0x1000;
  SLOT(1) = u - 0x7fffffffUL;
  SLOT(2) = u * 3;
  SLOT(3) = u & 0xff00ff00ff00ff00UL;
  SLOT(4) = u | 0x00ff00ff00ff00ffUL;
  SLOT(5) = u ^ 0xffffffffffffffffUL;
  SLOT(6) = (unsigned long)(-s);
  SLOT(7) = (unsigned long)(s >> 7);
  SLOT(8) = u >> 9;
  SLOT(9) = u << 11;

  /* 32-bit forms: every result must be sign-extended into the 64-bit register,
     which is where an interpreter that forgets addw/sllw/sraw goes wrong. */
  SLOT(10) = (unsigned long)(long)(i + 2000000000);
  SLOT(11) = (unsigned long)(long)(i - 2000000000);
  SLOT(12) = (unsigned long)(long)(i * 3);
  SLOT(13) = (unsigned long)(long)(int)(w + 1000000000u);
  SLOT(14) = (unsigned long)(long)(i >> 5);
  SLOT(15) = (unsigned long)(long)(int)(w >> 5);
  SLOT(16) = (unsigned long)(long)(i << 5);

  /* Sign and zero extension at every width. */
  SLOT(17) = (unsigned long)(long)seed_b;
  SLOT(18) = (unsigned long)(unsigned char)seed_b;
  SLOT(19) = (unsigned long)(long)seed_h;
  SLOT(20) = (unsigned long)(unsigned short)seed_h;
  SLOT(21) = (unsigned long)(long)seed_i;
  SLOT(22) = (unsigned long)(unsigned)seed_i;

  /* Comparisons, which lower to slt/sltu/seqz/snez. */
  SLOT(23) = (unsigned long)(s < 0);
  SLOT(24) = (unsigned long)(u < 0x8000000000000000UL);
  SLOT(25) = (unsigned long)(s == 0);
  SLOT(26) = (unsigned long)(u != 0);
  SLOT(27) = (unsigned long)(i < 0 ? -i : i);

  return (long)(SLOT(0) ^ SLOT(12) ^ SLOT(21));
}
