/*
 * Standard library, through a real libc: formatted output of every common
 * conversion, at widths and precisions that exercise the formatter rather
 * than just reaching it.
 */
#include <stdio.h>
#include <string.h>
#include <limits.h>

int main(void) {
  printf("%d %i %u %x %X %o\n", -42, 42, 4000000000u, 0xdeadbeef, 0xdeadbeef, 0777);
  printf("%ld %lu %lld %llu\n", LONG_MIN, ULONG_MAX, LLONG_MIN, ULLONG_MAX);
  printf("[%8d][%-8d][%08d][%+d]\n", 123, 123, 123, 123);
  printf("[%s][%10s][%-10s][%.3s]\n", "abc", "abc", "abc", "abcdef");
  printf("%c%c%c %%\n", 'a', 'b', 'c');
  printf("%f %e %g\n", 3.14159265358979, 3.14159265358979, 3.14159265358979);
  printf("%.0f %.15f %e\n", 0.5, 1.0 / 3.0, 1e-300);
  printf("%f %f %f\n", 0.0, -0.0, 1.0 / 0.0 - 1.0 / 0.0);

  char buf[128];
  int n = snprintf(buf, sizeof buf, "%s=%d;%s=%d", "alpha", 1, "beta", 22);
  printf("snprintf n=%d buf=%s len=%zu\n", n, buf, strlen(buf));

  char small[8];
  int truncated = snprintf(small, sizeof small, "%s", "0123456789");
  printf("truncated n=%d small=%s\n", truncated, small);
  return 0;
}
