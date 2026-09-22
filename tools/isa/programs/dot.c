/*
 * A realistic loop: the workload shape the app actually compares across ISAs.
 *
 * Unlike the asm_* programs this one asserts nothing about individual
 * encodings. Its job is to be ordinary compiled code — a widening integer
 * reduction and a double-precision saxpy over arrays — long enough that the
 * timing model has something to say about it and short enough that the
 * lockstep fixture stays a reasonable size.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
#define N 64

static short xs[N];
static short ys[N];
static double fx[N];
static double fy[N];

volatile unsigned seed = 2463534242u;

long kernel(void) {
  unsigned s = seed;
  for (int i = 0; i < N; i++) {
    s = s * 1103515245u + 12345u;
    xs[i] = (short)(s >> 16);
    s = s * 1103515245u + 12345u;
    ys[i] = (short)(s >> 16);
    fx[i] = (double)xs[i] * 0.125;
    fy[i] = (double)ys[i] / 3.0;
  }

  long acc = 0;
  for (int i = 0; i < N; i++) acc += (long)xs[i] * (long)ys[i];

  double alpha = 2.5;
  double fsum = 0.0;
  for (int i = 0; i < N; i++) {
    fy[i] = alpha * fx[i] + fy[i];
    fsum += fy[i];
  }

  unsigned long hash = 1469598103934665603UL;
  for (int i = 0; i < N; i++) {
    hash ^= (unsigned long)(unsigned short)xs[i];
    hash *= 1099511628211UL;
  }

  SLOT(0) = (unsigned long)acc;
  SLOT(1) = hash;
  SLOT(2) = (unsigned long)s;
  /* Reading a double's bits through memory rather than a register move, so
     this program is ordinary C and can serve every target. */
  *(volatile double *)&SLOT(3) = fsum;
  SLOT(4) = (unsigned long)(long)xs[N - 1];
  SLOT(5) = (unsigned long)(long)ys[N - 1];
  *(volatile double *)&SLOT(6) = fy[N - 1];

  return acc ^ (long)hash;
}
