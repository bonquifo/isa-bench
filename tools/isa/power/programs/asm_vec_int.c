/*
 * The vector integer operations, each on four operand pairs.
 *
 * These are what musl's string functions and the compiler's own
 * vectorised loops reach, and until they were implemented the only
 * evidence about them was whether a whole program printed the right
 * thing -- which says nothing about an element that happens not to
 * matter to the output. Here each result has its own slot in the dump,
 * so a wrong element is a named difference.
 *
 * The operands are chosen for the edges: sign bits, all ones, equal and
 * unequal elements for the comparisons, and shift amounts at and past
 * the element width, because a vector shift takes its count modulo the
 * width and getting that wrong is invisible for every smaller count.
 *
 * Every instruction is written out in inline assembly rather than left
 * to the compiler, so that what is tested is the named instruction and
 * not whatever the optimiser chose that day.
 */
#include "harness.h"

typedef struct { unsigned long d[2]; } vec;

static volatile vec a[4] = {
  {{ 0x0123456789abcdefUL, 0xfedcba9876543210UL }},
  {{ 0x800000007fffffffUL, 0xffffffff00000001UL }},
  {{ 0xffffffffffffffffUL, 0x8000000000000000UL }},
  {{ 0x0000000100000002UL, 0x7fffffffffffffffUL }},
};
static volatile vec b[4] = {
  {{ 0x0000000100000002UL, 0x0000000300000004UL }},
  {{ 0x800000007ffffffeUL, 0xffffffff00000002UL }},
  {{ 0x0000001f00000020UL, 0x000000000000003fUL }},
  {{ 0x0000002100000041UL, 0x0000000000000040UL }},
};

#define OUT(n) ((vec *)(isa_dump.scratch + 16 * (n)))

/* v2 <- op(v0, v1), with v0 and v1 loaded from memory. */
#define BINARY(insn, n, i)                                              \
  __asm__ volatile("lxvd2x 32, 0, %1\n\t"                              \
                   "lxvd2x 33, 0, %2\n\t"                              \
                   insn " 2, 0, 1\n\t"                                 \
                   "stxvd2x 34, 0, %0\n\t"                             \
                   : : "b"(OUT(n)), "b"(&a[i]), "b"(&b[i])             \
                   : "v0", "v1", "v2", "memory")

long kernel(void) {
  unsigned n = 0;
  for (unsigned i = 0; i < 4; i++) {
    BINARY("vadduwm", n++, i);
    BINARY("vsubuwm", n++, i);
    BINARY("vmuluwm", n++, i);
    BINARY("vslw", n++, i);
    BINARY("vsrw", n++, i);
    BINARY("vsraw", n++, i);
    BINARY("vcmpequw", n++, i);
    BINARY("vcmpgtuw", n++, i);
    BINARY("vaddudm", n++, i);
    BINARY("vsubudm", n++, i);
    BINARY("vsld", n++, i);
    BINARY("vsrad", n++, i);
    BINARY("vcmpequd", n++, i);
    BINARY("vcmpgtud", n++, i);
    BINARY("vpkudum", n++, i);
  }
  return n;
}
