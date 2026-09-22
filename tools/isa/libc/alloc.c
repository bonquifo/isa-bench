/*
 * The allocator and the string functions, which between them are most of
 * what a C program actually calls. Sizes straddle musl's internal thresholds
 * so both the small-bin path and the mmap path are taken.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int compare(const void *a, const void *b) {
  int x = *(const int *)a, y = *(const int *)b;
  return (x > y) - (x < y);
}

int main(void) {
  unsigned seed = 12345;
  const size_t sizes[] = { 1, 7, 64, 1000, 65536, 300000 };
  unsigned long hash = 1469598103934665603UL;
  for (size_t i = 0; i < sizeof sizes / sizeof *sizes; i++) {
    unsigned char *p = malloc(sizes[i]);
    if (!p) { printf("malloc %zu failed\n", sizes[i]); return 1; }
    memset(p, (int)(i + 1), sizes[i]);
    hash ^= (unsigned long)p[0] ^ (unsigned long)p[sizes[i] - 1] ^ sizes[i];
    hash *= 1099511628211UL;
    free(p);
  }
  printf("alloc hash=%lu\n", hash);

  int *values = calloc(64, sizeof(int));
  for (int i = 0; i < 64; i++) {
    seed = seed * 1103515245u + 12345u;
    values[i] = (int)(seed >> 17) - 8000;
  }
  qsort(values, 64, sizeof(int), compare);
  printf("sorted %d %d %d %d\n", values[0], values[1], values[62], values[63]);

  values = realloc(values, 128 * sizeof(int));
  memcpy(values + 64, values, 64 * sizeof(int));
  long total = 0;
  for (int i = 0; i < 128; i++) total += values[i];
  printf("total=%ld\n", total);
  free(values);

  char a[32] = "hello";
  char b[32];
  strcpy(b, a);
  strcat(b, ", world");
  printf("%s|%d|%d|%p\n", b, strcmp(a, b) < 0, (int)strlen(b), (void *)0);
  printf("memcmp=%d strchr=%s strstr=%s\n",
         memcmp(a, b, 5), strchr(b, 'w'), strstr(b, "lo,"));
  return 0;
}
