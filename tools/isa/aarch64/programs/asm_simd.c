/*
 * The Advanced SIMD subset ordinary compiled code reaches.
 *
 * None of this is here because the app needs vector maths. It is here
 * because on AArch64 the vector unit is not optional: the ABI assumes it,
 * so clang splats a byte across a register to search a string, gathers four
 * scattered words into one register before adding them, and widens a run of
 * 32-bit values into 64-bit accumulators. A libc's memset reaches further
 * still and asks the hardware to zero a cache line outright. An interpreter
 * that stops at scalar instructions cannot run a real program.
 *
 * The inputs are chosen so that a structural mistake cannot hide. Every
 * lane of every operand holds a different value, which is what makes a
 * wrong lane index, a wrong element size or the wrong half of a widening
 * operation visible rather than merely possible. The shift amounts include
 * a negative one and one at least as wide as the element, because those are
 * the two cases a shift implementation gets wrong.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

typedef unsigned char u8x8 __attribute__((vector_size(8)));
typedef unsigned short u16x4 __attribute__((vector_size(8)));
typedef unsigned int u32x2 __attribute__((vector_size(8)));
typedef unsigned char u8x16 __attribute__((vector_size(16)));
typedef unsigned short u16x8 __attribute__((vector_size(16)));
typedef unsigned int u32x4 __attribute__((vector_size(16)));
typedef unsigned long u64x2 __attribute__((vector_size(16)));

union Wide {
  u64x2 v;
  unsigned long u[2];
};
union Narrow {
  u32x2 v;
  unsigned long u;
};

#define PUT128(k, expr) do {                                            \
  union Wide w_;                                                        \
  __asm__ volatile("mov %0.16b, %1.16b" : "=w"(w_.v) : "w"(expr));      \
  SLOT(k) = w_.u[0];                                                    \
  SLOT((k) + 1) = w_.u[1];                                              \
} while (0)

#define PUT64(k, expr) do {                                             \
  union Narrow n_;                                                      \
  __asm__ volatile("mov %0.8b, %1.8b" : "=w"(n_.v) : "w"(expr));        \
  SLOT(k) = n_.u;                                                       \
} while (0)

/* Distinct in every lane at every element size, and sign bits set in some. */
volatile unsigned long seed_a[2] = { 0x8070605040302010UL, 0xf0e0d0c0b0a09080UL };
volatile unsigned long seed_b[2] = { 0x0102030405060708UL, 0x8090a0b0c0d0e0f0UL };
/* Shift amounts: zero, positive, negative, and wider than the element. */
volatile unsigned long seed_s[2] = { 0x2000ff01e0031004UL, 0x40ff00e1002008e5UL };
volatile unsigned int words[8] = {
  0x11111111u, 0x22222222u, 0x33333333u, 0x44444444u,
  0x55555555u, 0x66666666u, 0x77777777u, 0x88888888u,
};

/*
 * A separate region for the cache-line operation, because it has to be
 * aligned to the block it clears and has to hold more than one of them, so
 * that clearing the wrong block or the wrong amount shows up. Two blocks at
 * the largest size the architecture permits, which is 2048 bytes.
 */
#define ZONE_WORDS 512
__attribute__((aligned(2048))) volatile unsigned long zone[ZONE_WORDS];

static inline u64x2 load_wide(volatile unsigned long *from) {
  union Wide w;
  w.u[0] = from[0];
  w.u[1] = from[1];
  return w.v;
}

long kernel(void) {
  int k = 0;
  const u64x2 a = load_wide(seed_a);
  const u64x2 b = load_wide(seed_b);
  const u64x2 s = load_wide(seed_s);
  u64x2 r;
  u32x2 h;
  unsigned long x;
  unsigned int w;

  /* Immediates. The control field is not a shift amount, so each of its
     interpretations needs its own case. */
  __asm__ volatile("movi %0.16b, #0x5a" : "=w"(r));
  PUT128(k, r); k += 2;
  __asm__ volatile("movi %0.4s, #0x37, lsl #8" : "=w"(r));
  PUT128(k, r); k += 2;
  __asm__ volatile("movi %0.4s, #0x37, lsl #24" : "=w"(r));
  PUT128(k, r); k += 2;
  __asm__ volatile("mvni %0.4s, #0x37, lsl #16" : "=w"(r));
  PUT128(k, r); k += 2;
  __asm__ volatile("movi %0.8h, #0x37, lsl #8" : "=w"(r));
  PUT128(k, r); k += 2;
  __asm__ volatile("movi %0.4s, #0x37, msl #8" : "=w"(r));
  PUT128(k, r); k += 2;
  __asm__ volatile("movi %0.2d, #0xff00ff0000ff00ff" : "=w"(r));
  PUT128(k, r); k += 2;
  __asm__ volatile("movi %0.8b, #0x5a" : "=w"(h));
  PUT64(k, h); k += 1;

  /* Duplicating a general register, at each element size. */
  x = seed_a[0];
  __asm__ volatile("dup %0.16b, %w1" : "=w"(r) : "r"(x));
  PUT128(k, r); k += 2;
  __asm__ volatile("dup %0.8h, %w1" : "=w"(r) : "r"(x));
  PUT128(k, r); k += 2;
  __asm__ volatile("dup %0.4s, %w1" : "=w"(r) : "r"(x));
  PUT128(k, r); k += 2;
  __asm__ volatile("dup %0.2d, %1" : "=w"(r) : "r"(x));
  PUT128(k, r); k += 2;
  __asm__ volatile("dup %0.8b, %w1" : "=w"(h) : "r"(x));
  PUT64(k, h); k += 1;

  /* Duplicating a lane, including the scalar form that is spelled `mov`. */
  __asm__ volatile("dup %0.4s, %1.s[2]" : "=w"(r) : "w"(a));
  PUT128(k, r); k += 2;
  __asm__ volatile("dup %0.16b, %1.b[11]" : "=w"(r) : "w"(a));
  PUT128(k, r); k += 2;
  __asm__ volatile("mov %d0, %1.d[1]" : "=w"(r) : "w"(a));
  PUT128(k, r); k += 2;

  /* Inserting a general register into one lane, which leaves the rest. */
  r = a;
  __asm__ volatile("mov %0.s[1], %w1" : "+w"(r) : "r"(x));
  PUT128(k, r); k += 2;
  __asm__ volatile("mov %0.b[5], %w1" : "+w"(r) : "r"(x));
  PUT128(k, r); k += 2;
  __asm__ volatile("mov %0.d[1], %1" : "+w"(r) : "r"(x));
  PUT128(k, r); k += 2;

  /* Reading one lane back out into a general register. */
  __asm__ volatile("umov %w0, %1.s[1]" : "=r"(w) : "w"(a));
  SLOT(k++) = w;
  __asm__ volatile("umov %w0, %1.b[3]" : "=r"(w) : "w"(a));
  SLOT(k++) = w;
  __asm__ volatile("umov %w0, %1.h[5]" : "=r"(w) : "w"(a));
  SLOT(k++) = w;
  __asm__ volatile("umov %0, %1.d[1]" : "=r"(x) : "w"(a));
  SLOT(k++) = x;

  /* Bitwise. The size field selects the operation rather than a lane. */
  __asm__ volatile("orr %0.16b, %1.16b, %2.16b" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("and %0.16b, %1.16b, %2.16b" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("eor %0.16b, %1.16b, %2.16b" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("and %0.8b, %1.8b, %2.8b" : "=w"(h) : "w"(a), "w"(b));
  PUT64(k, h); k += 1;

  /* Lanewise add, at every element size. Each lane wraps within itself,
     which is what a carry crossing a lane boundary would break. */
  __asm__ volatile("add %0.2d, %1.2d, %2.2d" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("add %0.4s, %1.4s, %2.4s" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("add %0.8h, %1.8h, %2.8h" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("add %0.16b, %1.16b, %2.16b" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("add %0.2s, %1.2s, %2.2s" : "=w"(h) : "w"(a), "w"(b));
  PUT64(k, h); k += 1;

  /* Lanewise multiply, including the form that takes one operand from a
     single lane of the second register. */
  __asm__ volatile("mul %0.4s, %1.4s, %2.4s" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("mul %0.8h, %1.8h, %2.8h" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("mul %0.16b, %1.16b, %2.16b" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("mul %0.4s, %1.4s, %2.s[3]" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("mul %0.8h, %1.8h, %2.h[6]" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("mul %0.2s, %1.2s, %2.2s" : "=w"(h) : "w"(a), "w"(b));
  PUT64(k, h); k += 1;

  /* Widening adds. The `2` forms read the upper half of their narrow
     sources and are otherwise identical, so a pair that agrees has taken
     the wrong half. */
  __asm__ volatile("saddl %0.2d, %1.2s, %2.2s" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("saddl2 %0.2d, %1.4s, %2.4s" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("saddl %0.8h, %1.8b, %2.8b" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("saddl2 %0.4s, %1.8h, %2.8h" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("saddw %0.2d, %1.2d, %2.2s" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("saddw2 %0.2d, %1.2d, %2.4s" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("saddw %0.4s, %1.4s, %2.4h" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("saddw2 %0.8h, %1.8h, %2.16b" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;

  /* A shift whose amount is per-lane and signed. */
  __asm__ volatile("ushl %0.4s, %1.4s, %2.4s" : "=w"(r) : "w"(a), "w"(s));
  PUT128(k, r); k += 2;
  __asm__ volatile("ushl %0.2d, %1.2d, %2.2d" : "=w"(r) : "w"(a), "w"(s));
  PUT128(k, r); k += 2;
  __asm__ volatile("ushl %0.16b, %1.16b, %2.16b" : "=w"(r) : "w"(a), "w"(s));
  PUT128(k, r); k += 2;
  __asm__ volatile("ushl %0.8h, %1.8h, %2.8h" : "=w"(r) : "w"(a), "w"(s));
  PUT128(k, r); k += 2;

  /* Narrowing, and the paired form that appends above a half left alone. */
  __asm__ volatile("xtn %0.4h, %1.4s" : "=w"(r) : "w"(a));
  PUT128(k, r); k += 2;
  r = b;
  __asm__ volatile("xtn2 %0.8h, %1.4s" : "+w"(r) : "w"(a));
  PUT128(k, r); k += 2;
  __asm__ volatile("xtn %0.2s, %1.2d" : "=w"(r) : "w"(a));
  PUT128(k, r); k += 2;

  /* Deinterleaving two registers laid end to end. */
  __asm__ volatile("uzp1 %0.16b, %1.16b, %2.16b" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("uzp1 %0.4s, %1.4s, %2.4s" : "=w"(r) : "w"(a), "w"(b));
  PUT128(k, r); k += 2;
  __asm__ volatile("uzp1 %0.8b, %1.8b, %2.8b" : "=w"(h) : "w"(a), "w"(b));
  PUT64(k, h); k += 1;

  /* Reductions across the lanes of one register. */
  __asm__ volatile("addv %s0, %1.4s" : "=w"(r) : "w"(a));
  PUT128(k, r); k += 2;
  __asm__ volatile("addv %b0, %1.16b" : "=w"(r) : "w"(a));
  PUT128(k, r); k += 2;
  __asm__ volatile("addv %h0, %1.8h" : "=w"(r) : "w"(a));
  PUT128(k, r); k += 2;
  __asm__ volatile("addp %d0, %1.2d" : "=w"(r) : "w"(a));
  PUT128(k, r); k += 2;

  /* Loading a single lane, with and without the pointer update. */
  {
    volatile unsigned int *p = words;
    r = a;
    __asm__ volatile("ld1 { %0.s }[2], [%1]" : "+w"(r) : "r"(&words[3]) : "memory");
    PUT128(k, r); k += 2;
    __asm__ volatile("ld1 { %0.s }[1], [%1], #4" : "+w"(r), "+r"(p) : : "memory");
    PUT128(k, r); k += 2;
    SLOT(k++) = (unsigned long)(p - words);
    __asm__ volatile("ld1 { %0.b }[7], [%1]" : "+w"(r) : "r"(&words[2]) : "memory");
    PUT128(k, r); k += 2;
    __asm__ volatile("ld1 { %0.h }[3], [%1]" : "+w"(r) : "r"(&words[5]) : "memory");
    PUT128(k, r); k += 2;
    __asm__ volatile("ld1 { %0.d }[1], [%1], #8" : "+w"(r), "+r"(p) : : "memory");
    PUT128(k, r); k += 2;
    SLOT(k++) = (unsigned long)(p - words);
  }

  /* Zeroing a cache line. The block size is read from the register that
     reports it, and the address deliberately points into the middle of a
     block rather than at its start: the operation clears the block that
     contains the address, which is the behaviour a libc relies on. The
     bitmap says which eight-word run came out zero, so a block cleared at
     the wrong offset or with the wrong length is visible rather than
     merely summed away. */
  {
    unsigned long dczid;
    unsigned long cleared = 0;
    unsigned long sum = 0;
    __asm__ volatile("mrs %0, dczid_el0" : "=r"(dczid));
    SLOT(k++) = dczid;
    for (int i = 0; i < ZONE_WORDS; i++) {
      zone[i] = 0x1111111111111111UL * (unsigned long)(i + 1);
    }
    __asm__ volatile("dc zva, %0" : : "r"(&zone[ZONE_WORDS / 2 + 5]) : "memory");
    for (int i = 0; i < ZONE_WORDS; i += 8) {
      int zero = 1;
      for (int j = 0; j < 8; j++) {
        sum += zone[i + j];
        if (zone[i + j] != 0) zero = 0;
      }
      if (zero) cleared |= 1UL << (i / 8);
    }
    SLOT(k++) = cleared;
    SLOT(k++) = sum;
  }

  return (long)k;
}
