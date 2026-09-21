/*
 * Calls, returns and an indirect call.
 *
 * Recursion exercises the return-address register through a real stack rather
 * than the engine's synthetic call frames, and the indirect call through a
 * function pointer is the case the timing model treats separately from a
 * direct one. Everything here is ordinary C; the point is the control flow,
 * not any particular encoding.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

volatile int depth = 14;
volatile int selector = 2;

static long fib(int n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

static long ackermann_ish(int m, int n) {
  if (m == 0) return n + 1;
  if (n == 0) return ackermann_ish(m - 1, 1);
  return ackermann_ish(m - 1, ackermann_ish(m, n - 1));
}

static long triple(long v) { return v * 3; }
static long negate(long v) { return -v; }
static long square(long v) { return v * v; }

typedef long (*Unary)(long);
/* volatile so the call really is indirect: with a plain const table clang
   devirtualises all three targets and the indirect path is never tested. */
static Unary volatile table[3] = { triple, negate, square };

long kernel(void) {
  SLOT(0) = (unsigned long)fib(depth);
  SLOT(1) = (unsigned long)ackermann_ish(2, 3);

  long acc = 0;
  for (int i = 0; i < 12; i++) {
    Unary f = table[(i + selector) % 3];
    acc = f(acc + i);
  }
  SLOT(2) = (unsigned long)acc;

  /* A deep-then-shallow pattern, so the modelled return stack both fills
     and drains rather than staying at one depth. */
  long deep = 0;
  for (int i = 0; i < 4; i++) deep += fib(i + 6);
  SLOT(3) = (unsigned long)deep;

  return (long)(SLOT(0) ^ SLOT(2) ^ SLOT(3));
}
