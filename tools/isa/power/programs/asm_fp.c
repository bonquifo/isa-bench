/*
 * Floating-point values reaching registers by every route the compiler
 * uses on this target.
 *
 * The shared programs cover arithmetic; what they do not cover is how a
 * `double` gets into a register in the first place, and on powerpc64le
 * that is where the target is unusual. Constants come from the table of
 * contents through `lfd`, arrays come through `lxvd2x` followed by
 * `xxswapd` -- because the vector load leaves the elements in the order
 * the other byte order wants them -- and integers arrive through the
 * vector unit with `mtvsrwa` or `mtvsrd` and a conversion.
 *
 * Each of those is a different instruction with a different rule about
 * which half of a 128-bit register the value ends up in, and a backend
 * can get the arithmetic entirely right while getting this wrong.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
#define BITS(x) (*(volatile unsigned long *)&(x))

/* Constants, which the compiler places in memory and loads. */
static volatile double values[12] = {
  0.0, -0.0, 1.0, -1.0, 0.5, 2.0, 3.0,
  1e-300, 1e300, 4503599627370497.0, -2.5, 0.1,
};
static volatile float singles[4] = { 1.0f, -0.25f, 3.5f, 1e30f };
static volatile long integers[4] = { 0, 1, -1, 1234567890123456789L };
static volatile int words[4] = { 0, -1, 2000000000, -2000000000 };

/* Somewhere for a double to be written and read back. */
static volatile double sink[4];

long kernel(void) {
  unsigned n = 0;

  /* Each constant straight out of memory, as bits. */
  for (unsigned i = 0; i < 12; i++) {
    double v = values[i];
    SLOT(n++) = BITS(v);
  }

  /* Single-precision loads, which widen on the way in. */
  for (unsigned i = 0; i < 4; i++) {
    double v = singles[i];
    SLOT(n++) = BITS(v);
  }

  /* Integer to double, both widths, signed and unsigned. */
  for (unsigned i = 0; i < 4; i++) {
    double a = (double)integers[i];
    double b = (double)(unsigned long)integers[i];
    double c = (double)words[i];
    double d = (double)(unsigned)words[i];
    SLOT(n++) = BITS(a);
    SLOT(n++) = BITS(b);
    SLOT(n++) = BITS(c);
    SLOT(n++) = BITS(d);
  }

  /* And back, which truncates toward zero. */
  for (unsigned i = 0; i < 12; i++) {
    double v = values[i];
    SLOT(n++) = (unsigned long)(long)v;
    SLOT(n++) = (unsigned long)(int)v;
  }

  /* A store and a reload, so the value makes a round trip through
     memory in whichever order the vector forms use. */
  for (unsigned i = 0; i < 4; i++) {
    sink[i] = values[i + 2] * 3.0 + 1.0;
  }
  for (unsigned i = 0; i < 4; i++) {
    double v = sink[i];
    SLOT(n++) = BITS(v);
  }

  /* Comparisons, which write a condition-register field that only a
     branch can read. */
  unsigned mask = 0;
  for (unsigned i = 0; i < 12; i++) {
    double v = values[i];
    if (v < 0.0) mask |= 1u << i;
    if (v == 0.0) mask |= 1u << (i + 12);
  }
  SLOT(n++) = mask;

  return 0;
}
