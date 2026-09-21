/*
 * Loads and stores at every width, aligned and unaligned.
 *
 * The buffer under test lives inside the dump area, so the stores are part of
 * the compared architectural state rather than something the test has to go
 * and fetch. Addresses are formed with inline asm so the access really is
 * unaligned: a C-level `*(long *)(p + 3)` would let the compiler split it.
 *
 * RV64 under Linux permits unaligned access, which is why it is tested rather
 * than avoided. An interpreter that only ever handled the aligned case would
 * pass every fixture whose data happened to line up.
 */
#include "harness.h"

/* Bytes 0..255 of scratch are the buffer; results start at byte 256. */
#define BUF ((volatile unsigned char *)isa_dump.scratch)
#define SLOT(i) (((unsigned long *)isa_dump.scratch)[32 + (i)])

#define LOAD(insn, p) ({                                        \
  unsigned long r_;                                             \
  __asm__ volatile(insn " %0, 0(%1)"                            \
                   : "=r"(r_) : "r"(p) : "memory");             \
  r_;                                                           \
})

#define STORE(insn, p, v)                                       \
  __asm__ volatile(insn " %0, 0(%1)"                            \
                   :: "r"((unsigned long)(v)), "r"(p) : "memory")

volatile unsigned long pattern = 0x8899aabbccddeeffUL;

long kernel(void) {
  volatile unsigned char *buf = BUF;
  int k = 0;

  /* A pattern with the high bit set in every lane, so sign extension shows. */
  for (int i = 0; i < 64; i++) buf[i] = (unsigned char)(0x80 | (i * 7));

  /* Every load width, signed and unsigned, at offsets 0..7 so each one is
     tried aligned and every way of being unaligned. */
  for (int off = 0; off < 8; off++) {
    const volatile unsigned char *p = buf + off;
    SLOT(k++) = LOAD("lb", p);
    SLOT(k++) = LOAD("lbu", p);
    SLOT(k++) = LOAD("lh", p);
    SLOT(k++) = LOAD("lhu", p);
    SLOT(k++) = LOAD("lw", p);
    SLOT(k++) = LOAD("lwu", p);
    SLOT(k++) = LOAD("ld", p);
  }

  /* Stores at unaligned offsets, each into its own region of the buffer so
     they do not overwrite one another. */
  unsigned long v = pattern;
  STORE("sb", buf + 65, v);
  STORE("sh", buf + 67, v);
  STORE("sw", buf + 71, v);
  STORE("sd", buf + 79, v);
  STORE("sd", buf + 96, v);
  STORE("sw", buf + 105, v >> 32);
  STORE("sh", buf + 110, v >> 48);
  STORE("sb", buf + 113, v >> 56);

  /* Read the stores back at a different alignment than they were written. */
  SLOT(k++) = LOAD("ld", buf + 64);
  SLOT(k++) = LOAD("ld", buf + 72);
  SLOT(k++) = LOAD("ld", buf + 78);
  SLOT(k++) = LOAD("ld", buf + 96);
  SLOT(k++) = LOAD("ld", buf + 104);
  SLOT(k++) = LOAD("lw", buf + 110);

  return (long)k;
}
