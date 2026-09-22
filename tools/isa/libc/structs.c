/*
 * Language features the in-house Guest C compiler rejected outright: varargs,
 * struct return and pass by value, unions, bitfields, function pointers in
 * structs, and recursion over a linked structure.
 */
#include <stdio.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>

struct Point { double x, y; };
struct Packed { unsigned a : 3; signed b : 5; unsigned c : 24; };
union Bits { double d; uint64_t u; };

static struct Point add(struct Point p, struct Point q) {
  return (struct Point){ p.x + q.x, p.y + q.y };
}

static long total(int count, ...) {
  va_list args;
  va_start(args, count);
  long sum = 0;
  for (int i = 0; i < count; i++) sum += va_arg(args, int);
  double extra = va_arg(args, double);
  va_end(args);
  return sum + (long)extra;
}

struct Node { int value; struct Node *next; };

static int depth(const struct Node *node) {
  return node ? 1 + depth(node->next) : 0;
}

int main(void) {
  struct Point p = add((struct Point){ 1.5, -2.5 }, (struct Point){ 0.25, 4.0 });
  printf("point %.3f %.3f\n", p.x, p.y);

  struct Packed packed = { 5, -7, 1000000 };
  printf("packed %u %d %u size=%zu\n", packed.a, packed.b, packed.c, sizeof packed);

  union Bits bits;
  bits.d = -2.25;
  printf("union %016llx\n", (unsigned long long)bits.u);

  printf("varargs %ld\n", total(4, 1, 2, 3, 4, 2.75));

  struct Node c = { 3, NULL }, b = { 2, &c }, a = { 1, &b };
  printf("depth %d head %d\n", depth(&a), a.value);

  bool flag = depth(&a) > 2;
  printf("bool %d short %hd char %hhd\n", flag, (short)-40000, (signed char)-200);
  return 0;
}
