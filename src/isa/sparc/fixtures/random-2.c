
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
  a = 3u; b = 2474471055u;
  fs[0] = 10.190f; fs[1] = -0.517f;
  F2("fdivs", fs[0], fs[1], fs[2]); SLOT(0) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(1) = *(volatile unsigned int *)&fs[2];
  F1("fabss", fs[0], fs[2]); SLOT(2) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(3) = ((volatile unsigned int *)&fd[2])[0]; SLOT(4) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(5) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(6));
  a = 2439241035u; b = 1148322324u;
  RR("and", a, b, SLOT(7));
  a = 2147483648u; b = 815632791u;
  RR("or", a, b, SLOT(8));
  a = 4294967295u; b = 3559704643u;
  fs[0] = -66.113f; fs[1] = 0.0f;
  F2("fmuls", fs[0], fs[1], fs[2]); SLOT(9) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(10) = *(volatile unsigned int *)&fs[2];
  F1("fmovs", fs[0], fs[2]); SLOT(11) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(12) = ((volatile unsigned int *)&fd[2])[0]; SLOT(13) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(14) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(15));
  a = 2034183727u; b = 800700737u;
  ST("st", 48, a);
  ATOMIC("swap", 48, b, SLOT(16));
  LD("ld", 48, SLOT(17));
  a = 425135583u; b = 2513943968u;
  RR("sub", a, b, SLOT(18));
  a = 3431154909u; b = 2345179333u;
  DIV("udiv", a, b, 2354114173u, SLOT(19));
  a = 2734090803u; b = 4294967294u;
  ST("st", 56, a);
  ATOMIC("swap", 56, b, SLOT(20));
  LD("ld", 56, SLOT(21));
  a = 2943776894u; b = 243530388u;
  ADD64(a, b, 2147483649u, 0u, lo, hi); SLOT(22) = lo; SLOT(23) = hi;
  SUB64(a, b, 2788323050u, 2863311530u, lo, hi); SLOT(24) = lo; SLOT(25) = hi;
  a = 3u; b = 65535u;
  ST("st", 8, a);
  ATOMIC("swap", 8, b, SLOT(26));
  LD("ld", 8, SLOT(27));
  a = 1152518033u; b = 1454488903u;
  DIV("udiv", a, b, 1750428602u, SLOT(28));
  a = 256u; b = 2793135166u;
  RRCC("and", a, b, c, cy); SLOT(29) = c; SLOT(30) = cy;
  a = 4145022832u; b = 2147483649u;
  fd[0] = 12.697; fd[1] = 1.0;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(31) = ((volatile unsigned int *)&fd[2])[0]; SLOT(32) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(33) = ((volatile unsigned int *)&fd[2])[0]; SLOT(34) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(35) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(36) = *(volatile unsigned int *)&fs[2];
  fs[0] = 12.0f;
  F1("fitos", fs[0], fs[2]); SLOT(37) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(38) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(39) = ((volatile unsigned int *)&fd[2])[0]; SLOT(40) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbge", fs[0], fs[1], SLOT(41));
  FSR(SLOT(42));
  a = 4078002720u; b = 2777785188u;
  ANNUL("gu", a, b, SLOT(43));
  ANNUL("gu", a, a, SLOT(44));
  DELAY("gu", a, b, SLOT(45));
  a = 255u; b = 3591958418u;
  fd[0] = -0.0; fd[1] = -82.443;
  D2("faddd", fd[0], fd[1], fd[2]); SLOT(46) = ((volatile unsigned int *)&fd[2])[0]; SLOT(47) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(48) = ((volatile unsigned int *)&fd[2])[0]; SLOT(49) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(50) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(51) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(52) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(53) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(54) = ((volatile unsigned int *)&fd[2])[0]; SLOT(55) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbo", fs[0], fs[1], SLOT(56));
  FSR(SLOT(57));
  a = 3026317536u; b = 255u;
  RRCC("add", a, b, c, cy); SLOT(58) = c; SLOT(59) = cy;
  a = 45242494u; b = 1412722535u;
  RRCC("xor", a, b, c, cy); SLOT(60) = c; SLOT(61) = cy;
  a = 1855950341u; b = 2147483647u;
  RRCC("and", a, b, c, cy); SLOT(62) = c; SLOT(63) = cy;
  a = 2162833769u; b = 28075564u;
  fd[0] = -50.494; fd[1] = 38.803;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(64) = ((volatile unsigned int *)&fd[2])[0]; SLOT(65) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(66) = ((volatile unsigned int *)&fd[2])[0]; SLOT(67) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(68) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(69) = *(volatile unsigned int *)&fs[2];
  fs[0] = -50.0f;
  F1("fitos", fs[0], fs[2]); SLOT(70) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(71) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(72) = ((volatile unsigned int *)&fd[2])[0]; SLOT(73) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbu", fs[0], fs[1], SLOT(74));
  FSR(SLOT(75));
  a = 1799644125u; b = 2808651646u;
  ST("st", 104, a);
  LD("ldub", 107, SLOT(76));
  a = 2147483648u; b = 4117416716u;
  MUL("smul", a, b, lo, hi); SLOT(77) = lo; SLOT(78) = hi;
  a = 4011733121u; b = 2916293605u;
  ST("st", 8, a);
  LD("ldsh", 8, SLOT(79));
  a = 3034121034u; b = 65535u;
  ADD64(a, b, 690289340u, 2720280759u, lo, hi); SLOT(80) = lo; SLOT(81) = hi;
  SUB64(a, b, 2871786997u, 1821660952u, lo, hi); SLOT(82) = lo; SLOT(83) = hi;
  a = 256u; b = 242521353u;
  fd[0] = -41.026; fd[1] = -0.0;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(84) = ((volatile unsigned int *)&fd[2])[0]; SLOT(85) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(86) = ((volatile unsigned int *)&fd[2])[0]; SLOT(87) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(88) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(89) = *(volatile unsigned int *)&fs[2];
  fs[0] = -41.0f;
  F1("fitos", fs[0], fs[2]); SLOT(90) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(91) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(92) = ((volatile unsigned int *)&fd[2])[0]; SLOT(93) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbne", fs[0], fs[1], SLOT(94));
  FSR(SLOT(95));
  a = 3899761643u; b = 3318926711u;
  ST("st", 4, a);
  ATOMIC("swap", 4, b, SLOT(96));
  LD("ld", 4, SLOT(97));
  a = 3185446511u; b = 2147483649u;
  DIV("sdiv", a, b, 2595526283u, SLOT(98));
  a = 1337152618u; b = 3619840593u;
  fd[0] = 0.0; fd[1] = 1.0;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(99) = ((volatile unsigned int *)&fd[2])[0]; SLOT(100) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(101) = ((volatile unsigned int *)&fd[2])[0]; SLOT(102) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(103) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(104) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(105) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(106) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(107) = ((volatile unsigned int *)&fd[2])[0]; SLOT(108) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbe", fs[0], fs[1], SLOT(109));
  FSR(SLOT(110));
  a = 231629226u; b = 1300321734u;
  IMM("orn", a, -1515, SLOT(111));
  a = 2437983846u; b = 1u;
  fd[0] = 47.204; fd[1] = 1.0;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(112) = ((volatile unsigned int *)&fd[2])[0]; SLOT(113) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(114) = ((volatile unsigned int *)&fd[2])[0]; SLOT(115) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(116) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(117) = *(volatile unsigned int *)&fs[2];
  fs[0] = 47.0f;
  F1("fitos", fs[0], fs[2]); SLOT(118) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(119) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(120) = ((volatile unsigned int *)&fd[2])[0]; SLOT(121) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbe", fs[0], fs[1], SLOT(122));
  FSR(SLOT(123));
  a = 1645713637u; b = 3099073865u;
  ANNUL("vs", a, b, SLOT(124));
  ANNUL("vs", a, a, SLOT(125));
  DELAY("vs", a, b, SLOT(126));
  a = 2147483649u; b = 2147483649u;
  fs[0] = 15.384f; fs[1] = 0.0f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(127) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(128) = *(volatile unsigned int *)&fs[2];
  F1("fabss", fs[0], fs[2]); SLOT(129) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(130) = ((volatile unsigned int *)&fd[2])[0]; SLOT(131) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(132) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(133));
  a = 1856061891u; b = 3u;
  ADD64(a, b, 916848170u, 3548630821u, lo, hi); SLOT(134) = lo; SLOT(135) = hi;
  SUB64(a, b, 3526240303u, 3284560290u, lo, hi); SLOT(136) = lo; SLOT(137) = hi;
  a = 2019707887u; b = 1506314450u;
  DIV("udiv", a, b, 211554596u, SLOT(138));
  a = 107308087u; b = 1538949545u;
  ADD64(a, b, 256u, 256u, lo, hi); SLOT(139) = lo; SLOT(140) = hi;
  SUB64(a, b, 4163445869u, 2799673713u, lo, hi); SLOT(141) = lo; SLOT(142) = hi;
  a = 3296300085u; b = 2047192520u;
  MUL("umul", a, b, lo, hi); SLOT(143) = lo; SLOT(144) = hi;
  a = 2300454697u; b = 3437610336u;
  ST("st", 4, a);
  ATOMIC("swap", 4, b, SLOT(145));
  LD("ld", 4, SLOT(146));
  SLOT(147) = deep(15, 4171435305u);
  SLOT(148) = deep(20, 1863371063u);
  return 0;
}
