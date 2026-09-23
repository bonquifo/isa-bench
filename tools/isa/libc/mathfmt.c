/*
 * Floating point through libm, including the values that expose a difference
 * between a correct implementation and a nearly correct one.
 */
#include <stdio.h>
#include <math.h>

int main(void) {
  static const double values[] = {
    0.0, -0.0, 1.0, -1.0, 0.5, 2.0, 3.0, 1e-300, 1e300, 0.1,
  };
  for (unsigned i = 0; i < sizeof values / sizeof *values; i++) {
    double v = values[i];
    printf("%.17g sqrt=%.17g fabs=%.17g floor=%.17g ceil=%.17g\n",
           v, sqrt(fabs(v)), fabs(v), floor(v), ceil(v));
  }
  printf("inf=%f -inf=%f nan=%f\n", INFINITY, -INFINITY, NAN);
  printf("isnan=%d isinf=%d signbit=%d\n", isnan(NAN), isinf(INFINITY), signbit(-0.0));
  printf("fmod=%.17g remainder=%.17g copysign=%.17g\n",
         fmod(7.5, 2.0), remainder(7.5, 2.0), copysign(3.0, -1.0));
  printf("ldexp=%.17g frexp=%.17g\n", ldexp(1.0, 60), frexp(96.0, &(int){0}));

  float f = 1.0f / 3.0f;
  printf("float=%.9g double=%.17g\n", (double)f, 1.0 / 3.0);
  long double l = 1.0L / 3.0L;
#ifdef ISA_NO_LONG_DOUBLE_VARARGS
  /* Defined only for 32-bit SPARC, where clang's lowering of a long double
     passed through `...` disagrees with itself: `va_arg` in a trivial
     variadic function returns bytes of the stack rather than the value.
     The reference runs the same wrong code, so `%Lf` prints something that
     depends on where each process's stack sits and cannot be compared. The
     value is printed through double instead, and every other target's
     output is unchanged because the macro is not defined for them. */
  printf("longdouble=%.17g\n", (double)l);
#else
  printf("longdouble=%.20Lf\n", l);
#endif
  return 0;
}
