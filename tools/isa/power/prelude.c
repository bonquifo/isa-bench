
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
#define BUF ((volatile unsigned char *)(isa_dump.scratch + 512))

/* Register to register, no condition register. */
#define RR(insn, a, b, out) do {                                        \
  unsigned long r_, x_ = (a), y_ = (b);                                 \
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "r"(x_), "r"(y_));   \
  (out) = r_; } while (0)

/* The record form, which writes condition-register field zero. That
   field is only reachable through mfcr, so it is read straight back. */
#define RRCC(insn, a, b, out, cr_out) do {                              \
  unsigned long r_, c_, x_ = (a), y_ = (b);                             \
  __asm__ volatile(insn ". %0, %2, %3\n\tmfcr %1"                       \
                   : "=&r"(r_), "=&r"(c_) : "r"(x_), "r"(y_) : "cr0");  \
  (out) = r_; (cr_out) = c_; } while (0)

#define IMM(insn, a, imm, out) do {                                     \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile(insn " %0, %1, " #imm : "=r"(r_) : "r"(x_));         \
  (out) = r_; } while (0)

/*
 * The rotate-and-mask family, which is how this architecture shifts,
 * extracts and inserts, and which is where the mask boundaries are
 * encoded in two pieces with the high bit somewhere unexpected. Each
 * one is generated across the whole range of shift and mask values,
 * because the encoding only goes wrong above 31.
 */
#define RLWINM(a, sh, mb, me, out) do {                                 \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile("rlwinm %0, %1, " #sh ", " #mb ", " #me              \
                   : "=r"(r_) : "r"(x_));                               \
  (out) = r_; } while (0)

#define RLWIMI(a, b, sh, mb, me, out) do {                              \
  unsigned long r_ = (b), x_ = (a);                                     \
  __asm__ volatile("rlwimi %0, %1, " #sh ", " #mb ", " #me              \
                   : "+r"(r_) : "r"(x_));                               \
  (out) = r_; } while (0)

#define RLDICL(a, sh, mb, out) do {                                     \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile("rldicl %0, %1, " #sh ", " #mb : "=r"(r_) : "r"(x_)); \
  (out) = r_; } while (0)

#define RLDICR(a, sh, me, out) do {                                     \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile("rldicr %0, %1, " #sh ", " #me : "=r"(r_) : "r"(x_)); \
  (out) = r_; } while (0)

#define RLDIC(a, sh, mb, out) do {                                      \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile("rldic %0, %1, " #sh ", " #mb : "=r"(r_) : "r"(x_)); \
  (out) = r_; } while (0)

#define RLDIMI(a, b, sh, mb, out) do {                                  \
  unsigned long r_ = (b), x_ = (a);                                     \
  __asm__ volatile("rldimi %0, %1, " #sh ", " #mb : "+r"(r_) : "r"(x_)); \
  (out) = r_; } while (0)

/*
 * A 128-bit add and subtract out of two 64-bit ones.
 *
 * Carry is a register here rather than a flag, written by `addc` and
 * both read and written by `adde`, so this is a chain through one
 * resource. An implementation that set carry on every add would give
 * the right answer for this and the wrong dependences.
 */
#define ADD128(alo, ahi, blo, bhi, lo_out, hi_out) do {                 \
  unsigned long l_, h_, al_ = (alo), ah_ = (ahi), bl_ = (blo), bh_ = (bhi); \
  __asm__ volatile("addc %0, %2, %4\n\tadde %1, %3, %5"                 \
                   : "=&r"(l_), "=&r"(h_)                               \
                   : "r"(al_), "r"(ah_), "r"(bl_), "r"(bh_) : "xer");   \
  (lo_out) = l_; (hi_out) = h_; } while (0)

#define SUB128(alo, ahi, blo, bhi, lo_out, hi_out) do {                 \
  unsigned long l_, h_, al_ = (alo), ah_ = (ahi), bl_ = (blo), bh_ = (bhi); \
  __asm__ volatile("subfc %0, %4, %2\n\tsubfe %1, %5, %3"               \
                   : "=&r"(l_), "=&r"(h_)                               \
                   : "r"(al_), "r"(ah_), "r"(bl_), "r"(bh_) : "xer");   \
  (lo_out) = l_; (hi_out) = h_; } while (0)

/* The carry-extending forms that take their second operand from carry
   alone, which is how a comparison becomes a zero-or-one. */
#define CARRYEXT(insn, a, seed, out) do {                               \
  unsigned long r_, x_ = (a), s_ = (seed);                              \
  __asm__ volatile("addic %%r0, %2, 0\n\taddc %%r0, %%r0, %2\n\t"       \
                   insn " %0, %1"                                       \
                   : "=&r"(r_) : "r"(x_), "r"(s_) : "r0", "xer");       \
  (out) = r_; } while (0)

/*
 * Two comparisons into two different condition-register fields, then a
 * logical operation between single bits of them.
 *
 * This is the shape the eight-field design exists for: neither compare
 * waits for the other. An implementation with one condition register
 * would compute the same answer through a false dependence.
 */
#define CRLOGIC(insn, a, b, c, d, out) do {                             \
  unsigned long r_, w_ = (a), x_ = (b), y_ = (c), z_ = (d);             \
  __asm__ volatile("cmpd 0, %1, %2\n\tcmpd 1, %3, %4\n\t"               \
                   insn " 8, 0, 4\n\tmfcr %0"                           \
                   : "=&r"(r_) : "r"(w_), "r"(x_), "r"(y_), "r"(z_)     \
                   : "cr0", "cr1", "cr2");                              \
  (out) = r_; } while (0)

/* Select without branching, on a bit of a field the compare just set. */
#define ISEL(a, b, c, d, out) do {                                      \
  unsigned long r_, w_ = (a), x_ = (b), y_ = (c), z_ = (d);             \
  __asm__ volatile("cmpld 3, %1, %2\n\tisel %0, %3, %4, 12"             \
                   : "=&r"(r_) : "r"(w_), "r"(x_), "r"(y_), "r"(z_)     \
                   : "cr3");                                            \
  (out) = r_; } while (0)

/* The counter register, which a loop counts down without touching a
   general register or a condition. */
#define COUNTED(n, a, out) do {                                         \
  unsigned long r_ = 0, x_ = (a), c_ = (n);                             \
  __asm__ volatile("mtctr %2\n\t"                                       \
                   "1:\n\tadd %0, %0, %1\n\tbdnz 1b"                    \
                   : "+r"(r_) : "r"(x_), "r"(c_) : "ctr");              \
  (out) = r_; } while (0)

/*
 * The base register of an address is constrained to "b" rather than
 * "r", and that is not a stylistic choice.
 *
 * In the displacement forms, a base of r0 means the literal zero rather
 * than the contents of r0. So if the compiler happens to allocate the
 * pointer into r0, the address becomes the displacement alone and the
 * access goes to the bottom of memory. That is exactly what happened
 * here, and it is the same architectural rule the interpreter
 * implements -- found from the other side.
 */
#define ST(insn, off, a) do {                                           \
  unsigned long x_ = (a);                                               \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " %0, 0(%1)" :: "r"(x_), "b"(p_) : "memory");   \
} while (0)

#define LD(insn, off, out) do {                                         \
  unsigned long r_;                                                     \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " %0, 0(%1)" : "=r"(r_) : "b"(p_) : "memory");  \
  (out) = r_; } while (0)

/* The byte-reversing pair, which matter more here than elsewhere
   because this is a little-endian machine with a big-endian heritage
   and the compiler reaches for them on any network-order field.
   Both are indexed forms: they take two registers rather than a
   displacement, and a zero in the first means no base at all. */
#define BREV(sti, ldi, off, a, out) do {                                \
  unsigned long r_, x_ = (a);                                           \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(sti " %1, 0, %2\n\t" ldi " %0, 0, %2"                \
                   : "=&r"(r_) : "r"(x_), "r"(p_) : "memory");          \
  (out) = r_; } while (0)

/*
 * Double-precision arithmetic, which at -O2 for this target is the
 * vector unit operating on one element. The operands travel through
 * memory rather than through constraints so that the instruction
 * reaching the assembler is the one named here.
 */
#define F2(insn, x, y, out) do {                                        \
  __asm__ volatile("lfd 0, %1\n\tlfd 1, %2\n\t"                         \
                   insn " 2, 0, 1\n\tstfd 2, %0"                        \
                   : "=m"(out) : "m"(x), "m"(y) : "f0", "f1", "f2");    \
} while (0)

#define F1(insn, x, out) do {                                           \
  __asm__ volatile("lfd 0, %1\n\t" insn " 2, 0\n\tstfd 2, %0"           \
                   : "=m"(out) : "m"(x) : "f0", "f2");                  \
} while (0)

/* Fused multiply-add, which rounds once. Computing it as a multiply
   and then an add rounds twice and differs in the last bit. */
#define FMA(insn, x, y, z, out) do {                                    \
  __asm__ volatile("lfd 0, %1\n\tlfd 1, %2\n\tlfd 2, %3\n\t"            \
                   insn " 2, 0, 1, 2\n\tstfd 2, %0"                     \
                   : "=m"(out) : "m"(x), "m"(y), "m"(z)                 \
                   : "f0", "f1", "f2");                                 \
} while (0)

/* A floating-point comparison writes a condition-register field, which
   only mfcr can read back. */
#define FCMP(x, y, out) do {                                            \
  unsigned long r_;                                                     \
  __asm__ volatile("lfd 0, %1\n\tlfd 1, %2\n\tfcmpu 5, 0, 1\n\tmfcr %0" \
                   : "=r"(r_) : "m"(x), "m"(y) : "f0", "f1", "cr5");    \
  (out) = r_; } while (0)

/*
 * Recursion, so the call and return paths run through the link
 * register rather than only falling through.
 */
__attribute__((noinline)) static unsigned long deep(unsigned long n, unsigned long acc) {
  if (n == 0) return acc;
  unsigned long a = acc ^ (n * 2654435761UL);
  return deep(n - 1, a + n) ^ (a >> 3) ^ (n << 8);
}
