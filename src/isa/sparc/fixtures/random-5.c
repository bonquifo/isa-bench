
#include "harness.h"

#define SLOT(i) (((unsigned int *)isa_dump.scratch)[i])
#define BUF ((volatile unsigned char *)(isa_dump.scratch + 512))

/* Plain register-to-register, no flags. */
#define RR(insn, a, b, out) do {                                        \
  unsigned int r_, x_ = (a), y_ = (b);                                  \
  __asm__ volatile(insn " %1, %2, %0" : "=r"(r_) : "r"(x_), "r"(y_));   \
  (out) = r_; } while (0)

/* The flag-setting form, with the carry read straight back out. addx
   of two zeroes is zero plus zero plus carry, which is the only way a
   user-mode program can see that bit. */
#define RRCC(insn, a, b, out, cy) do {                                  \
  unsigned int r_, c_, x_ = (a), y_ = (b);                              \
  __asm__ volatile(insn "cc %2, %3, %0\n\t"                             \
                   "addx %%g0, %%g0, %1"                                \
                   : "=&r"(r_), "=&r"(c_) : "r"(x_), "r"(y_) : "cc");   \
  (out) = r_; (cy) = c_; } while (0)

#define IMM(insn, a, imm, out) do {                                     \
  unsigned int r_, x_ = (a);                                            \
  __asm__ volatile(insn " %1, " #imm ", %0" : "=r"(r_) : "r"(x_));      \
  (out) = r_; } while (0)

#define SH(insn, a, b, out) do {                                        \
  unsigned int r_, x_ = (a), y_ = (b);                                  \
  __asm__ volatile(insn " %1, %2, %0" : "=r"(r_) : "r"(x_), "r"(y_));   \
  (out) = r_; } while (0)

/* A 64-bit add out of two 32-bit ones, which is what the carry flag is
   for and where a wrong sense of it shows up immediately. */
#define ADD64(alo, ahi, blo, bhi, lo_out, hi_out) do {                  \
  unsigned int l_, h_, al_ = (alo), ah_ = (ahi), bl_ = (blo), bh_ = (bhi); \
  __asm__ volatile("addcc %2, %4, %0\n\t"                               \
                   "addx %3, %5, %1"                                    \
                   : "=&r"(l_), "=&r"(h_)                               \
                   : "r"(al_), "r"(ah_), "r"(bl_), "r"(bh_) : "cc");    \
  (lo_out) = l_; (hi_out) = h_; } while (0)

/* And the subtraction, where C is a borrow rather than a carry. */
#define SUB64(alo, ahi, blo, bhi, lo_out, hi_out) do {                  \
  unsigned int l_, h_, al_ = (alo), ah_ = (ahi), bl_ = (blo), bh_ = (bhi); \
  __asm__ volatile("subcc %2, %4, %0\n\t"                               \
                   "subx %3, %5, %1"                                    \
                   : "=&r"(l_), "=&r"(h_)                               \
                   : "r"(al_), "r"(ah_), "r"(bl_), "r"(bh_) : "cc");    \
  (lo_out) = l_; (hi_out) = h_; } while (0)

/* A multiply leaves the high half in %y, which only rd can reach. */
#define MUL(insn, a, b, lo_out, hi_out) do {                            \
  unsigned int l_, h_, x_ = (a), y_ = (b);                              \
  __asm__ volatile(insn " %2, %3, %0\n\trd %%y, %1"                     \
                   : "=&r"(l_), "=&r"(h_) : "r"(x_), "r"(y_) : "cc");   \
  (lo_out) = l_; (hi_out) = h_; } while (0)

/* A divide takes the high word of its dividend from %y, so the write
   and the read are separated on purpose. The divisor is forced
   non-zero, since dividing by zero traps rather than answering. */
#define DIV(insn, hi, lo, b, out) do {                                  \
  unsigned int r_, h_ = (hi), l_ = (lo), y_ = ((b) | 1u);               \
  __asm__ volatile("wr %1, %%g0, %%y\n\t"                               \
                   "nop\n\tnop\n\tnop\n\t"                              \
                   insn " %2, %3, %0"                                   \
                   : "=r"(r_) : "r"(h_), "r"(l_), "r"(y_) : "cc");      \
  (out) = r_; } while (0)

/*
 * A branch whose delay instruction is annulled when it is not taken.
 *
 * The add in the slot runs only on the taken path, and the or after
 * it runs only on the untaken one. An implementation with the annul
 * sense backwards gives a different answer for exactly one of the two
 * cases, which is why each of these is generated with both.
 */
#define ANNUL(cond, a, b, out) do {                                     \
  unsigned int r_ = 0, x_ = (a), y_ = (b);                              \
  __asm__ volatile("subcc %1, %2, %%g0\n\t"                             \
                   "b" cond ",a 1f\n\t"                                 \
                   "add %0, 7, %0\n\t"                                  \
                   "or %0, 0x40, %0\n"                                  \
                   "1:\n\t"                                             \
                   "add %0, 1, %0"                                      \
                   : "+r"(r_) : "r"(x_), "r"(y_) : "cc");               \
  (out) = r_; } while (0)

/* The same branch without annulling, where the slot always runs. */
#define DELAY(cond, a, b, out) do {                                     \
  unsigned int r_ = 0, x_ = (a), y_ = (b);                              \
  __asm__ volatile("subcc %1, %2, %%g0\n\t"                             \
                   "b" cond " 1f\n\t"                                   \
                   "add %0, 7, %0\n\t"                                  \
                   "or %0, 0x40, %0\n"                                  \
                   "1:\n\t"                                             \
                   "add %0, 1, %0"                                      \
                   : "+r"(r_) : "r"(x_), "r"(y_) : "cc");               \
  (out) = r_; } while (0)

#define ST(insn, off, a) do {                                           \
  unsigned int x_ = (a);                                                \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " %0, [%1]" :: "r"(x_), "r"(p_) : "memory");    \
} while (0)

#define LD(insn, off, out) do {                                         \
  unsigned int r_;                                                      \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " [%1], %0" : "=r"(r_) : "r"(p_) : "memory");   \
  (out) = r_; } while (0)

/* The tagged arithmetic, which sets overflow when either operand has a
   low bit set. Nothing a C compiler emits, and part of the instruction
   set all the same. */
#define TAGGED(insn, a, b, out, cy) do {                                \
  unsigned int r_, c_, x_ = (a), y_ = (b);                              \
  __asm__ volatile(insn " %2, %3, %0\n\t"                               \
                   "addx %%g0, %%g0, %1"                                \
                   : "=&r"(r_), "=&r"(c_) : "r"(x_), "r"(y_) : "cc");   \
  (out) = r_; (cy) = c_; } while (0)

/* One step of the multiply the first implementations had no instruction
   for. It reads N, V and %y and writes all of them. */
#define MULSCC(a, b, seed, out, yout) do {                              \
  unsigned int r_, y2_, x_ = (a), y_ = (b), s_ = (seed);                \
  __asm__ volatile("wr %4, %%g0, %%y\n\t"                               \
                   "nop\n\tnop\n\tnop\n\t"                              \
                   "mulscc %2, %3, %0\n\t"                              \
                   "mulscc %0, %3, %0\n\t"                              \
                   "rd %%y, %1"                                         \
                   : "=&r"(r_), "=&r"(y2_)                              \
                   : "r"(x_), "r"(y_), "r"(s_) : "cc");                 \
  (out) = r_; (yout) = y2_; } while (0)

/* The two read-modify-write instructions, which are how this
   architecture does a lock. Both touch memory twice in one
   instruction. */
#define ATOMIC(insn, off, a, out) do {                                  \
  unsigned int r_ = (a);                                                \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " [%1], %0" : "+r"(r_) : "r"(p_) : "memory");   \
  (out) = r_; } while (0)

/* Floating point through explicit registers rather than constraints, so
   the instruction reaching the assembler is the one named here. */
#define F1(insn, in, out) do {                                          \
  __asm__ volatile("ld [%1], %%f2\n\t"                                  \
                   insn " %%f2, %%f4\n\t"                               \
                   "st %%f4, [%0]"                                      \
                   :: "r"(&(out)), "r"(&(in))                           \
                   : "f2", "f4", "memory"); } while (0)

#define F2(insn, x, y, out) do {                                        \
  __asm__ volatile("ld [%1], %%f2\n\tld [%2], %%f4\n\t"                 \
                   insn " %%f2, %%f4, %%f6\n\t"                         \
                   "st %%f6, [%0]"                                      \
                   :: "r"(&(out)), "r"(&(x)), "r"(&(y))                 \
                   : "f2", "f4", "f6", "memory"); } while (0)

/* The double-precision forms, which name an even register and move two
   words at a time. */
#define D1(insn, in, out) do {                                          \
  __asm__ volatile("ldd [%1], %%f2\n\t"                                 \
                   insn " %%f2, %%f4\n\t"                               \
                   "std %%f4, [%0]"                                     \
                   :: "r"(&(out)), "r"(&(in))                           \
                   : "f2", "f3", "f4", "f5", "memory"); } while (0)

#define D2(insn, x, y, out) do {                                        \
  __asm__ volatile("ldd [%1], %%f2\n\tldd [%2], %%f4\n\t"               \
                   insn " %%f2, %%f4, %%f6\n\t"                         \
                   "std %%f6, [%0]"                                     \
                   :: "r"(&(out)), "r"(&(x)), "r"(&(y))                 \
                   : "f2", "f3", "f4", "f5", "f6", "f7", "memory"); } while (0)

/* Single to double and double to single, which change the register
   width as well as the value. */
#define FWIDEN(insn, in, out) do {                                      \
  __asm__ volatile("ld [%1], %%f2\n\t"                                  \
                   insn " %%f2, %%f4\n\t"                               \
                   "std %%f4, [%0]"                                     \
                   :: "r"(&(out)), "r"(&(in))                           \
                   : "f2", "f4", "f5", "memory"); } while (0)

#define FNARROW(insn, in, out) do {                                     \
  __asm__ volatile("ldd [%1], %%f2\n\t"                                 \
                   insn " %%f2, %%f4\n\t"                               \
                   "st %%f4, [%0]"                                      \
                   :: "r"(&(out)), "r"(&(in))                           \
                   : "f2", "f3", "f4", "memory"); } while (0)

/* A comparison writes the floating-point condition code, and only a
   floating-point branch can read it. The three nops are the delay the
   architecture requires between the two. */
#define FCMP(insn, br, x, y, out) do {                                  \
  unsigned int r_ = 0;                                                  \
  __asm__ volatile("ld [%1], %%f2\n\tld [%2], %%f4\n\t"                 \
                   insn " %%f2, %%f4\n\t"                               \
                   "nop\n\tnop\n\tnop\n\t"                              \
                   br " 1f\n\t"                                         \
                   "add %0, 3, %0\n\t"                                  \
                   "or %0, 0x80, %0\n"                                  \
                   "1:\n\t"                                             \
                   "add %0, 1, %0"                                      \
                   : "+r"(r_) : "r"(&(x)), "r"(&(y))                    \
                   : "f2", "f4", "cc", "memory");                       \
  (out) = r_; } while (0)

/* Storing the status register, which carries the condition code and the
   accrued exception bits an arithmetic instruction leaves behind. */
#define FSR(out) do {                                                   \
  unsigned int r_;                                                      \
  __asm__ volatile("st %%fsr, [%0]" :: "r"(&r_) : "memory");            \
  (out) = r_; } while (0)

/*
 * Recursion past the eight register windows the hardware has.
 *
 * Nothing in this function is interesting on its own. What it exercises
 * is the window overflow trap on the way down and the underflow fill on
 * the way back up, which no straight-line program reaches and which the
 * reference handles inside the emulator rather than in guest code.
 */
__attribute__((noinline)) static unsigned deep(unsigned n, unsigned acc) {
  if (n == 0) return acc;
  unsigned a = acc ^ (n * 2654435761u);
  unsigned b = deep(n - 1, a + n);
  return b ^ (a >> 3) ^ (n << 8);
}

long kernel(void) {
  unsigned int a, b, c, d;
  unsigned int lo, hi, cy;
  volatile float fs[3];
  volatile double fd[3];
  a = 2027536542u; b = 2922868963u;
  fd[0] = -53.648; fd[1] = -15.081;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(0) = ((volatile unsigned int *)&fd[2])[0]; SLOT(1) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(2) = ((volatile unsigned int *)&fd[2])[0]; SLOT(3) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(4) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(5) = *(volatile unsigned int *)&fs[2];
  fs[0] = -53.0f;
  F1("fitos", fs[0], fs[2]); SLOT(6) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(7) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(8) = ((volatile unsigned int *)&fd[2])[0]; SLOT(9) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbge", fs[0], fs[1], SLOT(10));
  FSR(SLOT(11));
  a = 1961106527u; b = 2147483648u;
  ANNUL("neg", a, b, SLOT(12));
  ANNUL("neg", a, a, SLOT(13));
  DELAY("neg", a, b, SLOT(14));
  a = 143249126u; b = 4294967294u;
  RRCC("xor", a, b, c, cy); SLOT(15) = c; SLOT(16) = cy;
  a = 1509672440u; b = 306263912u;
  ST("st", 56, a);
  ATOMIC("ldstub", 56, b, SLOT(17));
  LD("ld", 56, SLOT(18));
  a = 396166141u; b = 2949910005u;
  RR("add", a, b, SLOT(19));
  a = 4294967295u; b = 4249909698u;
  ST("st", 96, a);
  LD("ldsb", 97, SLOT(20));
  a = 2589456985u; b = 1685853998u;
  fs[0] = 80.631f; fs[1] = -14.981f;
  F2("fmuls", fs[0], fs[1], fs[2]); SLOT(21) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(22) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(23) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(24) = ((volatile unsigned int *)&fd[2])[0]; SLOT(25) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(26) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(27));
  a = 3058136711u; b = 1976581676u;
  ST("st", 56, a);
  LD("ldub", 58, SLOT(28));
  a = 2371602001u; b = 252669128u;
  IMM("add", a, 1068, SLOT(29));
  a = 2769182507u; b = 2u;
  IMM("andn", a, -667, SLOT(30));
  a = 51201396u; b = 2728254709u;
  DIV("sdiv", a, b, 448655089u, SLOT(31));
  a = 3673543925u; b = 854641403u;
  fd[0] = 66.575; fd[1] = 0.0;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(32) = ((volatile unsigned int *)&fd[2])[0]; SLOT(33) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(34) = ((volatile unsigned int *)&fd[2])[0]; SLOT(35) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(36) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(37) = *(volatile unsigned int *)&fs[2];
  fs[0] = 66.0f;
  F1("fitos", fs[0], fs[2]); SLOT(38) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(39) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(40) = ((volatile unsigned int *)&fd[2])[0]; SLOT(41) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbge", fs[0], fs[1], SLOT(42));
  FSR(SLOT(43));
  a = 2u; b = 65536u;
  SH("srl", a, 14, SLOT(44));
  a = 2u; b = 2863311530u;
  ST("st", 56, a);
  LD("ld", 56, SLOT(45));
  a = 3554707363u; b = 3104476389u;
  ADD64(a, b, 4294967294u, 43815871u, lo, hi); SLOT(46) = lo; SLOT(47) = hi;
  SUB64(a, b, 3511642214u, 1354627299u, lo, hi); SLOT(48) = lo; SLOT(49) = hi;
  a = 2442306690u; b = 4244521655u;
  RRCC("xor", a, b, c, cy); SLOT(50) = c; SLOT(51) = cy;
  a = 146499858u; b = 500744466u;
  fd[0] = -98.283; fd[1] = 0.0;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(52) = ((volatile unsigned int *)&fd[2])[0]; SLOT(53) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(54) = ((volatile unsigned int *)&fd[2])[0]; SLOT(55) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(56) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(57) = *(volatile unsigned int *)&fs[2];
  fs[0] = -98.0f;
  F1("fitos", fs[0], fs[2]); SLOT(58) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(59) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(60) = ((volatile unsigned int *)&fd[2])[0]; SLOT(61) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fble", fs[0], fs[1], SLOT(62));
  FSR(SLOT(63));
  a = 2440725525u; b = 65535u;
  ANNUL("vc", a, b, SLOT(64));
  ANNUL("vc", a, a, SLOT(65));
  DELAY("vc", a, b, SLOT(66));
  a = 2863311530u; b = 3086480867u;
  fd[0] = 75.962; fd[1] = -56.729;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(67) = ((volatile unsigned int *)&fd[2])[0]; SLOT(68) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(69) = ((volatile unsigned int *)&fd[2])[0]; SLOT(70) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(71) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(72) = *(volatile unsigned int *)&fs[2];
  fs[0] = 75.0f;
  F1("fitos", fs[0], fs[2]); SLOT(73) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(74) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(75) = ((volatile unsigned int *)&fd[2])[0]; SLOT(76) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbe", fs[0], fs[1], SLOT(77));
  FSR(SLOT(78));
  a = 3847358056u; b = 1337427353u;
  fs[0] = 63.369f; fs[1] = 1.0f;
  F2("fmuls", fs[0], fs[1], fs[2]); SLOT(79) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(80) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(81) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(82) = ((volatile unsigned int *)&fd[2])[0]; SLOT(83) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(84) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(85));
  a = 2981450321u; b = 1431655765u;
  ST("st", 16, a);
  ATOMIC("swap", 16, b, SLOT(86));
  LD("ld", 16, SLOT(87));
  a = 2147483647u; b = 1569487842u;
  DIV("sdiv", a, b, 1431655765u, SLOT(88));
  a = 1369859494u; b = 2475639024u;
  ST("st", 0, a);
  ATOMIC("swap", 0, b, SLOT(89));
  LD("ld", 0, SLOT(90));
  a = 941109735u; b = 255u;
  ST("st", 0, a);
  LD("lduh", 0, SLOT(91));
  a = 32767u; b = 814435065u;
  ST("st", 12, a);
  LD("ldsb", 13, SLOT(92));
  a = 3111259500u; b = 3410801928u;
  ST("st", 116, a);
  LD("ld", 116, SLOT(93));
  a = 1826432275u; b = 208732883u;
  fd[0] = 1.0; fd[1] = -13.484;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(94) = ((volatile unsigned int *)&fd[2])[0]; SLOT(95) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(96) = ((volatile unsigned int *)&fd[2])[0]; SLOT(97) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(98) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(99) = *(volatile unsigned int *)&fs[2];
  fs[0] = 1.0f;
  F1("fitos", fs[0], fs[2]); SLOT(100) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(101) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(102) = ((volatile unsigned int *)&fd[2])[0]; SLOT(103) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbge", fs[0], fs[1], SLOT(104));
  FSR(SLOT(105));
  a = 2124686008u; b = 3118549643u;
  fs[0] = -16.774f; fs[1] = 76.168f;
  F2("fsubs", fs[0], fs[1], fs[2]); SLOT(106) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(107) = *(volatile unsigned int *)&fs[2];
  F1("fabss", fs[0], fs[2]); SLOT(108) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(109) = ((volatile unsigned int *)&fd[2])[0]; SLOT(110) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(111) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(112));
  a = 1785588330u; b = 4253667652u;
  fs[0] = 40.280f; fs[1] = -0.0f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(113) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(114) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(115) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(116) = ((volatile unsigned int *)&fd[2])[0]; SLOT(117) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(118) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(119));
  a = 3090967537u; b = 329605900u;
  TAGGED("taddcc", a, b, SLOT(120), cy); SLOT(121) = cy;
  MULSCC(a, b, 3791867522u, SLOT(122), SLOT(123));
  a = 762622817u; b = 3821712528u;
  fd[0] = -87.362; fd[1] = 1.0;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(124) = ((volatile unsigned int *)&fd[2])[0]; SLOT(125) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(126) = ((volatile unsigned int *)&fd[2])[0]; SLOT(127) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(128) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(129) = *(volatile unsigned int *)&fs[2];
  fs[0] = -87.0f;
  F1("fitos", fs[0], fs[2]); SLOT(130) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(131) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(132) = ((volatile unsigned int *)&fd[2])[0]; SLOT(133) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbl", fs[0], fs[1], SLOT(134));
  FSR(SLOT(135));
  a = 0u; b = 2863311530u;
  RRCC("sub", a, b, c, cy); SLOT(136) = c; SLOT(137) = cy;
  a = 1u; b = 4019293826u;
  IMM("orn", a, 194, SLOT(138));
  a = 2147483648u; b = 718043017u;
  ADD64(a, b, 1u, 256u, lo, hi); SLOT(139) = lo; SLOT(140) = hi;
  SUB64(a, b, 2436025637u, 3539623019u, lo, hi); SLOT(141) = lo; SLOT(142) = hi;
  a = 640621884u; b = 4294967294u;
  RRCC("or", a, b, c, cy); SLOT(143) = c; SLOT(144) = cy;
  a = 3234845161u; b = 255u;
  fd[0] = 84.197; fd[1] = 96.398;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(145) = ((volatile unsigned int *)&fd[2])[0]; SLOT(146) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(147) = ((volatile unsigned int *)&fd[2])[0]; SLOT(148) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(149) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(150) = *(volatile unsigned int *)&fs[2];
  fs[0] = 84.0f;
  F1("fitos", fs[0], fs[2]); SLOT(151) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(152) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(153) = ((volatile unsigned int *)&fd[2])[0]; SLOT(154) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbne", fs[0], fs[1], SLOT(155));
  FSR(SLOT(156));
  SLOT(157) = deep(14, 825325945u);
  SLOT(158) = deep(22, 1073705326u);
  return 0;
}
