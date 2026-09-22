/*
 * The SSE subset ordinary compiled code reaches.
 *
 * None of this is here because the corpus does vector maths. It is here
 * because the x86-64 ABI assumes SSE2 exists: a double is passed in an xmm
 * register whether or not anything vectorises, a structure is copied
 * sixteen bytes at a time, and clang turns an unsigned-to-double
 * conversion into a fixed sequence of packed integer instructions because
 * the architecture has no instruction for it. An interpreter that stops at
 * the general registers cannot run a real program.
 *
 * Every lane of every operand holds a different value, which is what makes
 * a wrong lane index, a wrong element size or a wrong half visible rather
 * than merely possible. The moves are checked for what they do to the
 * bits they are not moving: some zero the rest of the destination and some
 * leave it alone, and that difference is invisible until it matters.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

typedef unsigned long u64x2 __attribute__((vector_size(16)));
typedef unsigned int u32x4 __attribute__((vector_size(16)));

union Wide {
  u64x2 v;
  unsigned long u[2];
};

#define PUT(k, expr) do {                                               \
  union Wide w_;                                                        \
  __asm__ volatile("movdqa %1, %0" : "=x"(w_.v) : "x"(expr));           \
  SLOT(k) = w_.u[0];                                                    \
  SLOT((k) + 1) = w_.u[1];                                              \
} while (0)

#define BIN(insn, a, b, out) do {                                       \
  u64x2 r_ = (a);                                                       \
  __asm__ volatile(insn " %1, %0" : "+x"(r_) : "x"((b)));               \
  PUT(out, r_); } while (0)

#define SHUF(sel, a, out) do {                                          \
  u64x2 r_;                                                             \
  __asm__ volatile("pshufd $" #sel ", %1, %0" : "=x"(r_) : "x"((a)));   \
  PUT(out, r_); } while (0)

/* Distinct in every lane at every element size, and with values that
   carry between lanes if an add is done at the wrong width. */
volatile unsigned long seed[6] = {
  0x8070605040302010UL, 0xf0e0d0c0b0a09080UL,
  0x0102030405060708UL, 0x8090a0b0c0d0e0f0UL,
  0xfffefdfcfbfaf9f8UL, 0x0001020304050607UL,
};

static inline u64x2 load(int i) {
  union Wide w;
  w.u[0] = seed[i * 2];
  w.u[1] = seed[i * 2 + 1];
  return w.v;
}

long kernel(void) {
  int k = 0;
  const u64x2 a = load(0);
  const u64x2 b = load(1);
  const u64x2 c = load(2);

  /* Lanewise add at each element size the corpus reaches. A carry that
     crossed a lane boundary would show here and nowhere else. */
  BIN("paddb", a, b, k); k += 2;
  BIN("paddw", a, b, k); k += 2;
  BIN("paddd", a, b, k); k += 2;
  BIN("paddq", a, b, k); k += 2;
  BIN("psubb", a, b, k); k += 2;
  BIN("psubd", a, b, k); k += 2;
  BIN("psubq", c, a, k); k += 2;

  /* Bitwise, where the element size is not part of the operation. */
  BIN("pand", a, b, k); k += 2;
  BIN("por", a, b, k); k += 2;
  BIN("pxor", a, b, k); k += 2;
  BIN("xorps", a, c, k); k += 2;
  BIN("andps", a, c, k); k += 2;

  /* Comparison, which produces a mask rather than a flag. */
  BIN("pcmpeqb", a, b, k); k += 2;
  BIN("pcmpeqd", a, a, k); k += 2;
  BIN("pcmpgtb", a, b, k); k += 2;
  BIN("pcmpgtd", c, a, k); k += 2;

  /* Interleaving the low halves, and the multiply that goes with it: the
     pair clang emits to turn a 64-bit integer into a double. */
  BIN("punpcklbw", a, b, k); k += 2;
  BIN("punpcklwd", a, b, k); k += 2;
  BIN("punpckldq", a, b, k); k += 2;
  BIN("punpcklqdq", a, b, k); k += 2;
  BIN("pmuludq", a, b, k); k += 2;

  /* Every lane selector that matters: identity, reversal, a broadcast and
     a swap of the halves. */
  SHUF(0xe4, a, k); k += 2;
  SHUF(0x1b, a, k); k += 2;
  SHUF(0x00, a, k); k += 2;
  SHUF(0x4e, a, k); k += 2;
  SHUF(0xff, b, k); k += 2;

  /*
   * The moves, and what they do to the bits they are not moving.
   *
   * movd and movq from a general register zero the rest of the register;
   * a scalar move between two vector registers leaves it alone. Getting
   * those the wrong way round produces a value that is right where anyone
   * would look and wrong above it.
   */
  {
    u64x2 r = a;
    unsigned long x = seed[4];
    unsigned int y = (unsigned int)seed[5];
    __asm__ volatile("movq %1, %0" : "=x"(r) : "r"(x));
    PUT(k, r); k += 2;
    __asm__ volatile("movd %1, %0" : "=x"(r) : "r"(y));
    PUT(k, r); k += 2;

    unsigned long back;
    __asm__ volatile("movq %1, %0" : "=r"(back) : "x"(b));
    SLOT(k++) = back;
    unsigned int backw;
    __asm__ volatile("movd %1, %0" : "=r"(backw) : "x"(b));
    SLOT(k++) = backw;

    /* movq between vector registers keeps the low half and zeroes the
       rest; movsd between vector registers keeps the rest. */
    r = a;
    __asm__ volatile("movq %1, %0" : "+x"(r) : "x"(b));
    PUT(k, r); k += 2;
    r = a;
    __asm__ volatile("movsd %1, %0" : "+x"(r) : "x"(b));
    PUT(k, r); k += 2;
    r = a;
    __asm__ volatile("movss %1, %0" : "+x"(r) : "x"(b));
    PUT(k, r); k += 2;
  }

  /* Through memory, aligned and not, at both widths. */
  {
    volatile unsigned char *buf = (volatile unsigned char *)isa_dump.scratch;
    u64x2 r;
    __asm__ volatile("movdqa %1, (%0)" :: "r"(buf + 512), "x"(a) : "memory");
    __asm__ volatile("movups %1, (%0)" :: "r"(buf + 531), "x"(b) : "memory");
    __asm__ volatile("movdqa (%1), %0" : "=x"(r) : "r"(buf + 512) : "memory");
    PUT(k, r); k += 2;
    __asm__ volatile("movups (%1), %0" : "=x"(r) : "r"(buf + 531) : "memory");
    PUT(k, r); k += 2;
    __asm__ volatile("movq (%1), %0" : "=x"(r) : "r"(buf + 520) : "memory");
    PUT(k, r); k += 2;
    r = a;
    __asm__ volatile("movq %1, (%0)" :: "r"(buf + 560), "x"(r) : "memory");
    __asm__ volatile("movdqu (%1), %0" : "=x"(r) : "r"(buf + 556) : "memory");
    PUT(k, r); k += 2;
  }

  return (long)k;
}
