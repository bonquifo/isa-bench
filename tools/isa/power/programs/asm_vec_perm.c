/*
 * The vector operations that move elements rather than compute them,
 * and the scalar forms that move a value between a vector register and
 * memory.
 *
 * These are the ones where a plausible mistake is easy. A merge that
 * takes words where it should take doublewords, a permute that reads its
 * control bytes in the other order, or a scalar store that writes the
 * whole register all produce the right values in the wrong places --
 * and several of exactly those were in this backend until the libc
 * tier reached them. Each result has its own slot in the dump, and the
 * two scalar stores are written over a marker so that a store that is
 * too wide shows as an overwritten marker.
 */
#include "harness.h"

typedef struct { unsigned long d[2]; } vec;

static volatile vec a[4] = {
  {{ 0x0123456789abcdefUL, 0xfedcba9876543210UL }},
  {{ 0x800000007fffffffUL, 0xffffffff00000001UL }},
  {{ 0xffffffffffffffffUL, 0x8000000000000000UL }},
  {{ 0x1111111122222222UL, 0x3333333344444444UL }},
};
static volatile vec b[4] = {
  {{ 0xa0a1a2a3a4a5a6a7UL, 0xa8a9aaabacadaeafUL }},
  {{ 0x0000000100000002UL, 0x0000000300000004UL }},
  {{ 0x5555555566666666UL, 0x7777777788888888UL }},
  {{ 0xdeadbeefcafef00dUL, 0x0badc0de8badf00dUL }},
};
/* Permute controls: identity over A, identity over B, reversed across
   both, and bytes with their top bits set, which the instruction masks. */
static volatile vec control[4] = {
  {{ 0x0001020304050607UL, 0x08090a0b0c0d0e0fUL }},
  {{ 0x1011121314151617UL, 0x18191a1b1c1d1e1fUL }},
  {{ 0x1f1e1d1c1b1a1918UL, 0x0706050403020100UL }},
  {{ 0xe0c1a2831f00ff7fUL, 0x4b2a9c3d5e6f7081UL }},
};
static volatile vec mask[4] = {
  {{ 0, 0 }},
  {{ ~0UL, ~0UL }},
  {{ 0xffffffff00000000UL, 0x00000000ffffffffUL }},
  {{ 0x0f0f0f0f0f0f0f0fUL, 0xf0f0f0f0f0f0f0f0UL }},
};
/* Doubles for the word conversions: in range, negative, a NaN, and one
   too large for a word. */
static volatile vec doubles[4] = {
  {{ 0x41bc000000000000UL, 0 }},  /* 469762048.0 */
  {{ 0xc00c000000000000UL, 0 }},  /* -3.5 */
  {{ 0x7ff8000000000000UL, 0 }},  /* NaN */
  {{ 0x4415af1d78b58c40UL, 0 }},  /* 1e20 */
};

#define OUT(n) ((vec *)(isa_dump.scratch + 16 * (n)))
#define MARK 0x5a5a5a5a5a5a5a5aUL

#define BINARY(insn, n, i)                                              \
  __asm__ volatile("lxvd2x 32, 0, %1\n\t"                              \
                   "lxvd2x 33, 0, %2\n\t"                              \
                   insn "\n\t"                                         \
                   "stxvd2x 34, 0, %0\n\t"                             \
                   : : "b"(OUT(n)), "b"(&a[i]), "b"(&b[i])             \
                   : "v0", "v1", "v2", "memory")

/* Three sources: v0, v1 and a third in v3. */
#define TERNARY(insn, n, i, third)                                      \
  __asm__ volatile("lxvd2x 32, 0, %1\n\t"                              \
                   "lxvd2x 33, 0, %2\n\t"                              \
                   "lxvd2x 35, 0, %3\n\t"                              \
                   insn "\n\t"                                         \
                   "stxvd2x 34, 0, %0\n\t"                             \
                   : : "b"(OUT(n)), "b"(&a[i]), "b"(&b[i]), "b"(&third[i]) \
                   : "v0", "v1", "v2", "v3", "memory")

/* Nothing loaded: the instruction makes its own value. */
#define NULLARY(insn, n)                                                \
  __asm__ volatile(insn "\n\t"                                         \
                   "stxvd2x 34, 0, %0\n\t"                             \
                   : : "b"(OUT(n)) : "v2", "memory")

/* A double in f0, a conversion into f1, and doubleword 0 stored. */
#define CONVERT(insn, n, i)                                             \
  __asm__ volatile("lxvd2x 0, 0, %1\n\t"                               \
                   insn " 1, 0\n\t"                                    \
                   "stxsdx 1, 0, %0\n\t"                               \
                   : : "b"(OUT(n)), "b"(&doubles[i])                   \
                   : "vs0", "vs1", "memory")

long kernel(void) {
  unsigned n = 0;

  for (unsigned i = 0; i < 4; i++) {
    BINARY("xxmrghw 34, 32, 33", n++, i);
    BINARY("xxmrglw 34, 32, 33", n++, i);
    BINARY("vupklsw 2, 1", n++, i);
    TERNARY("vperm 2, 0, 1, 3", n++, i, control);
    TERNARY("xxsel 34, 32, 33, 35", n++, i, mask);
  }

  /* The forms whose immediate is an operand, one of each value. */
  BINARY("xxspltw 34, 32, 0", n++, 0);
  BINARY("xxspltw 34, 32, 1", n++, 0);
  BINARY("xxspltw 34, 32, 2", n++, 0);
  BINARY("xxspltw 34, 32, 3", n++, 0);
  BINARY("xxsldwi 34, 32, 33, 0", n++, 0);
  BINARY("xxsldwi 34, 32, 33, 1", n++, 0);
  BINARY("xxsldwi 34, 32, 33, 2", n++, 0);
  BINARY("xxsldwi 34, 32, 33, 3", n++, 0);
  BINARY("xxpermdi 34, 32, 33, 0", n++, 0);
  BINARY("xxpermdi 34, 32, 33, 1", n++, 0);
  BINARY("xxpermdi 34, 32, 33, 2", n++, 0);
  BINARY("xxpermdi 34, 32, 33, 3", n++, 0);
  NULLARY("vspltisw 2, -16", n++);
  NULLARY("vspltisw 2, -1", n++);
  NULLARY("vspltisw 2, 0", n++);
  NULLARY("vspltisw 2, 15", n++);

  /* The word conversions, both signs, into doubleword 0. */
  for (unsigned i = 0; i < 4; i++) {
    CONVERT("xscvdpsxws", n++, i);
    CONVERT("xscvdpuxws", n++, i);
  }

  /* The scalar stores, each over a marker, so a store that writes too
     much shows as a marker that is gone. */
  for (unsigned i = 0; i < 2; i++) {
    OUT(n)->d[0] = MARK;
    OUT(n)->d[1] = MARK;
    __asm__ volatile("lxvd2x 0, 0, %1\n\t"
                     "stxsdx 0, 0, %0\n\t"
                     : : "b"(OUT(n)), "b"(&a[i]) : "vs0", "memory");
    n++;
    OUT(n)->d[0] = MARK;
    OUT(n)->d[1] = MARK;
    __asm__ volatile("lxvd2x 0, 0, %1\n\t"
                     "stfiwx 0, 0, %0\n\t"
                     : : "b"(OUT(n)), "b"(&a[i]) : "vs0", "memory");
    n++;
    /* And the scalar load, which reads one word and must not read more. */
    OUT(n)->d[0] = MARK;
    OUT(n)->d[1] = MARK;
    __asm__ volatile("lxsiwzx 0, 0, %1\n\t"
                     "stxsdx 0, 0, %0\n\t"
                     : : "b"(OUT(n)), "b"(&a[i]) : "vs0", "memory");
    n++;
  }
  return n;
}
