/*
 * Exclusive load and store, which is how AArch64 builds an atomic before
 * the large-system extensions add single-instruction ones.
 *
 * Single-threaded, so the content is not concurrency: it is that a store
 * exclusive must fail when no matching load exclusive reserved the address,
 * and must report that failure in its status register rather than silently
 * succeeding.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
#define CELL(i) ((volatile unsigned long *)isa_dump.scratch + (i))

long kernel(void) {
  int k = 16;
  volatile unsigned long *cell = CELL(0);
  unsigned long observed;
  unsigned int status;

  *cell = 0x1122334455667788UL;
  __asm__ volatile("ldxr %0, [%1]" : "=r"(observed) : "r"(cell) : "memory");
  SLOT(k++) = observed;
  __asm__ volatile("stxr %w0, %2, [%1]"
                   : "=&r"(status) : "r"(cell), "r"(0xdeadbeefcafef00dUL) : "memory");
  SLOT(k++) = status;
  SLOT(k++) = *cell;

  /* No reservation covers this address, so the store must not take effect. */
  volatile unsigned long *other = CELL(1);
  *other = 5;
  __asm__ volatile("clrex" ::: "memory");
  __asm__ volatile("stxr %w0, %2, [%1]"
                   : "=&r"(status) : "r"(other), "r"(99UL) : "memory");
  SLOT(k++) = status;
  SLOT(k++) = *other;

  /* The 32-bit and byte widths have their own encodings. */
  __asm__ volatile("ldxr %w0, [%1]" : "=r"(observed) : "r"(cell) : "memory");
  SLOT(k++) = observed;
  __asm__ volatile("stxr %w0, %w2, [%1]"
                   : "=&r"(status) : "r"(cell), "r"(0x99887766UL) : "memory");
  SLOT(k++) = status;
  SLOT(k++) = *cell;

  volatile unsigned char *byte = (volatile unsigned char *)CELL(2);
  *byte = 0x5a;
  __asm__ volatile("ldxrb %w0, [%1]" : "=r"(observed) : "r"(byte) : "memory");
  SLOT(k++) = observed;
  __asm__ volatile("stxrb %w0, %w2, [%1]"
                   : "=&r"(status) : "r"(byte), "r"(0xa5UL) : "memory");
  SLOT(k++) = status;
  SLOT(k++) = *byte;

  /* A complete compare-and-swap loop, the shape a libc actually uses. */
  volatile unsigned long *counter = CELL(3);
  *counter = 0;
  for (int i = 0; i < 8; i++) {
    unsigned long current;
    unsigned int failed;
    do {
      __asm__ volatile("ldaxr %0, [%1]" : "=r"(current) : "r"(counter) : "memory");
      __asm__ volatile("stlxr %w0, %2, [%1]"
                       : "=&r"(failed) : "r"(counter), "r"(current + 3) : "memory");
    } while (failed);
  }
  SLOT(k++) = *counter;

  return (long)k;
}
