/*
 * The delay slot, which is the one thing about this architecture that
 * cannot be tested by accident.
 *
 * Every branch here is written with .set noreorder so the instruction in
 * the slot is the one intended rather than whatever the assembler chose,
 * and each case puts something observable there: a register written in
 * the slot must take effect whether or not the branch is taken, and the
 * value the branch itself read must be the one from *before* the slot ran.
 *
 * The link registers are the sharp edge. A jal writes the return address
 * before the slot runs, so a slot that reads ra sees the new value; and
 * the linking conditional branches write it even when they do not branch.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

volatile int v[12] = {
  0, 1, -1, 2, -2, 0x7fffffff, (int)0x80000000, 255, -255, 65536, 3, -3,
};

/* A branch whose delay slot changes the register the branch tested. */
#define SLOT_AFTER_TEST(a, out) do {                                    \
  unsigned int r_ = 0, x_ = (unsigned)(a);                              \
  __asm__ volatile(".set noreorder\n\t"                                 \
                   "beqz %1, 1f\n\t"                                    \
                   "addiu %1, %1, 1\n\t"                                \
                   "ori %0, %0, 0x10\n"                                 \
                   "1:\n\t"                                             \
                   "or %0, %0, %1\n\t"                                  \
                   ".set reorder"                                       \
                   : "+r"(r_), "+r"(x_));                               \
  (out) = r_; } while (0)

/* A call whose delay slot reads the return address the call just wrote. */
#define SLOT_READS_LINK(out) do {                                       \
  unsigned int r_;                                                      \
  __asm__ volatile(".set noreorder\n\t"                                 \
                   "bal 1f\n\t"                                         \
                   "move %0, $ra\n"                                     \
                   "1:\n\t"                                             \
                   ".set reorder"                                       \
                   : "=r"(r_) :: "ra");                                 \
  (out) = r_ != 0; } while (0)

/* A conditional branch that links whether or not it is taken. */
#define LINK_WITHOUT_BRANCH(a, out) do {                                \
  unsigned int r_ = 0, x_ = (unsigned)(a);                              \
  __asm__ volatile(".set noreorder\n\t"                                 \
                   "bltzal %1, 1f\n\t"                                  \
                   "addiu %0, $zero, 7\n"                               \
                   "1:\n\t"                                             \
                   ".set reorder"                                       \
                   : "+r"(r_) : "r"(x_) : "ra");                        \
  (out) = r_; } while (0)

/* The unaligned word accesses, which a compiler emits in pairs. */
#define UNALIGNED(offset, out) do {                                     \
  unsigned int r_ = 0xdeadbeef;                                         \
  volatile unsigned char *p_ = (volatile unsigned char *)isa_dump.scratch + (offset); \
  __asm__ volatile("lwl %0, 3(%1)\n\tlwr %0, 0(%1)"                     \
                   : "+r"(r_) : "r"(p_) : "memory");                    \
  (out) = r_; } while (0)

#define UNALIGNED_STORE(offset, value, out) do {                        \
  unsigned int x_ = (unsigned)(value), r_ = 0;                          \
  volatile unsigned char *p_ = (volatile unsigned char *)isa_dump.scratch + (offset); \
  __asm__ volatile("swl %2, 3(%1)\n\tswr %2, 0(%1)\n\t"                 \
                   "lwl %0, 3(%1)\n\tlwr %0, 0(%1)"                     \
                   : "=&r"(r_) : "r"(p_), "r"(x_) : "memory");          \
  (out) = r_; } while (0)

/* The pair that only multiply and divide touch. */
#define HILO(a, b, lo_out, hi_out) do {                                 \
  unsigned int l_, h_, x_ = (unsigned)(a), y_ = (unsigned)(b);          \
  __asm__ volatile("mult %2, %3\n\tmflo %0\n\tmfhi %1"                  \
                   : "=r"(l_), "=r"(h_) : "r"(x_), "r"(y_) : "hi", "lo"); \
  (lo_out) = l_; (hi_out) = h_; } while (0)

#define MADD(a, b, c, lo_out, hi_out) do {                              \
  unsigned int l_, h_, x_ = (unsigned)(a), y_ = (unsigned)(b);          \
  unsigned int z_ = (unsigned)(c);                                      \
  __asm__ volatile("mtlo %3\n\tmthi %4\n\tmadd %2, %3\n\tmflo %0\n\tmfhi %1" \
                   : "=&r"(l_), "=&r"(h_) : "r"(x_), "r"(y_), "r"(z_)   \
                   : "hi", "lo");                                       \
  (lo_out) = l_; (hi_out) = h_; } while (0)

long kernel(void) {
  int k = 0;
  for (int i = 0; i < 64; i++) {
    ((volatile unsigned char *)isa_dump.scratch)[512 + i] = (unsigned char)(i * 11 + 3);
  }

  for (int i = 0; i < 12; i++) {
    SLOT_AFTER_TEST(v[i], SLOT(k++));
    LINK_WITHOUT_BRANCH(v[i], SLOT(k++));
  }
  SLOT_READS_LINK(SLOT(k++));

  for (int i = 0; i < 4; i++) {
    UNALIGNED(512 + i, SLOT(k++));
    UNALIGNED_STORE(516 + i, v[i + 2], SLOT(k++));
  }

  for (int i = 0; i < 12; i++) {
    int j = (i * 5 + 1) % 12;
    HILO(v[i], v[j], SLOT(k), SLOT(k + 1)); k += 2;
    MADD(v[i], v[j], v[(i + 3) % 12], SLOT(k), SLOT(k + 1)); k += 2;
  }

  return (long)k;
}
