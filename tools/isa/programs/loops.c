/*
 * Control flow the compiler chooses for itself: a back edge, a nested
 * conditional, an early exit, a while loop with a modulus test, and a switch.
 *
 * Ordinary C, so every target compiles the same source. What each one emits
 * for it -- conditional branches, conditional selects, jump tables -- is
 * precisely the difference the comparison is about, so the program must not
 * prescribe any of it.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

volatile int trip = 37;
volatile int selector = 2;

static long classify(int value) {
  switch (value & 7) {
    case 0: return value * 3;
    case 1: return value - 11;
    case 2: return value ^ 0x5a;
    case 3: return -value;
    case 4: return value << 2;
    case 5: return value / 3;
    case 6: return value % 5;
    default: return ~value;
  }
}

long kernel(void) {
  int k = 0;

  long acc = 0;
  int n = trip;
  for (int i = 0; i < n; i++) {
    if ((i & 3) == 0) acc += i * 3;
    else if (i & 1) acc -= i;
    else acc ^= (long)i << 8;
    if (acc > 100000) break;
  }
  SLOT(k++) = (unsigned long)acc;

  long j = 0;
  long sum = 0;
  while (j < n) {
    sum += (j % 5 == 0) ? j : -j;
    j += 2;
  }
  SLOT(k++) = (unsigned long)sum;

  long table = 0;
  for (int i = 0; i < n * 2; i++) table += classify(i + selector);
  SLOT(k++) = (unsigned long)table;

  /* A loop whose trip count the compiler cannot know, with a carried
     dependence, so it cannot be unrolled into straight-line code. */
  unsigned long state = 0x9e3779b97f4a7c15UL;
  int steps = 0;
  while (state != 1 && steps < 500) {
    state = (state & 1) ? (state * 3 + 1) : (state >> 1);
    steps++;
  }
  SLOT(k++) = state;
  SLOT(k++) = (unsigned long)steps;

  return acc ^ sum ^ table;
}
