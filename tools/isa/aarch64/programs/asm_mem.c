/*
 * Loads and stores at every width, and the addressing modes AArch64 has
 * that a fixed-offset architecture does not: pre- and post-indexed forms
 * that write the address back, a register offset that can be shifted or
 * extended as part of the access, and paired load/store.
 *
 * The buffer lives inside the dump, so stores are part of the compared
 * state rather than something the test must go and fetch.
 */
#include "harness.h"

#define BUF ((volatile unsigned char *)isa_dump.scratch)
#define SLOT(i) (((unsigned long *)isa_dump.scratch)[32 + (i)])

#define LOAD(insn, reg, p) ({                                           \
  unsigned long r_ = 0;                                                 \
  __asm__ volatile(insn " " reg "0, [%1]" : "=r"(r_) : "r"(p) : "memory"); \
  r_; })

#define STORE(insn, reg, p, v)                                          \
  __asm__ volatile(insn " " reg "0, [%1]"                               \
                   :: "r"((unsigned long)(v)), "r"(p) : "memory")

volatile unsigned long pattern = 0x8899aabbccddeeffUL;

long kernel(void) {
  volatile unsigned char *buf = BUF;
  int k = 0;

  for (int i = 0; i < 64; i++) buf[i] = (unsigned char)(0x80 | (i * 7));

  /* Every width, signed and unsigned, at offsets that cover aligned and
     every way of being unaligned. */
  for (int off = 0; off < 8; off++) {
    const volatile unsigned char *p = buf + off;
    SLOT(k++) = LOAD("ldrb", "%w", p);
    SLOT(k++) = LOAD("ldrsb", "%w", p);
    SLOT(k++) = LOAD("ldrsb", "%x", p);
    SLOT(k++) = LOAD("ldrh", "%w", p);
    SLOT(k++) = LOAD("ldrsh", "%x", p);
    SLOT(k++) = LOAD("ldr", "%w", p);
    SLOT(k++) = LOAD("ldrsw", "%x", p);
    SLOT(k++) = LOAD("ldr", "%x", p);
  }

  unsigned long value = pattern;
  STORE("strb", "%w", buf + 65, value);
  STORE("strh", "%w", buf + 67, value);
  STORE("str", "%w", buf + 71, value);
  STORE("str", "%x", buf + 79, value);
  STORE("str", "%x", buf + 96, value);
  SLOT(k++) = LOAD("ldr", "%x", buf + 64);
  SLOT(k++) = LOAD("ldr", "%x", buf + 72);
  SLOT(k++) = LOAD("ldr", "%x", buf + 78);

  /* Pre-index and post-index write the updated address back, so the test has
     to observe the pointer as well as the value. */
  volatile unsigned char *p = buf + 16;
  unsigned long loaded;
  __asm__ volatile("ldr %0, [%1, #8]!" : "=r"(loaded), "+r"(p) :: "memory");
  SLOT(k++) = loaded;
  SLOT(k++) = (unsigned long)(p - buf);
  __asm__ volatile("ldr %0, [%1], #16" : "=r"(loaded), "+r"(p) :: "memory");
  SLOT(k++) = loaded;
  SLOT(k++) = (unsigned long)(p - buf);
  __asm__ volatile("str %2, [%1, #-8]!" : "+r"(p) : "r"(p), "r"(value) : "memory");
  SLOT(k++) = (unsigned long)(p - buf);

  /* Register offset, optionally shifted or extended by the access itself. */
  unsigned long index = 3;
  __asm__ volatile("ldr %0, [%1, %2, lsl #3]" : "=r"(loaded) : "r"(buf), "r"(index) : "memory");
  SLOT(k++) = loaded;
  __asm__ volatile("ldrb %w0, [%1, %2]" : "=r"(loaded) : "r"(buf), "r"(index) : "memory");
  SLOT(k++) = loaded;
  unsigned long negative = 0xfffffffffffffff8UL;
  __asm__ volatile("ldr %0, [%1, %w2, sxtw]" : "=r"(loaded) : "r"(buf + 32), "r"(negative) : "memory");
  SLOT(k++) = loaded;

  /* Paired access, which moves two registers in one instruction. */
  unsigned long first, second;
  __asm__ volatile("ldp %0, %1, [%2]" : "=r"(first), "=r"(second) : "r"(buf + 32) : "memory");
  SLOT(k++) = first;
  SLOT(k++) = second;
  __asm__ volatile("stp %0, %1, [%2, #16]" :: "r"(second), "r"(first), "r"(buf + 96) : "memory");
  SLOT(k++) = LOAD("ldr", "%x", buf + 112);
  SLOT(k++) = LOAD("ldr", "%x", buf + 120);
  __asm__ volatile("ldpsw %0, %1, [%2]" : "=r"(first), "=r"(second) : "r"(buf + 40) : "memory");
  SLOT(k++) = first;
  SLOT(k++) = second;

  /* Unscaled signed offsets, which reach places the scaled forms cannot. */
  __asm__ volatile("ldur %0, [%1, #-7]" : "=r"(loaded) : "r"(buf + 48) : "memory");
  SLOT(k++) = loaded;
  __asm__ volatile("stur %0, [%1, #-3]" :: "r"(value), "r"(buf + 160) : "memory");
  SLOT(k++) = LOAD("ldr", "%x", buf + 152);

  return (long)k;
}
