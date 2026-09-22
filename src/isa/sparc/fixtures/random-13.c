
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
  a = 1274341861u; b = 3973584505u;
  fd[0] = 60.935; fd[1] = -0.0;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(0) = ((volatile unsigned int *)&fd[2])[0]; SLOT(1) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(2) = ((volatile unsigned int *)&fd[2])[0]; SLOT(3) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(4) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(5) = *(volatile unsigned int *)&fs[2];
  fs[0] = 60.0f;
  F1("fitos", fs[0], fs[2]); SLOT(6) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(7) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(8) = ((volatile unsigned int *)&fd[2])[0]; SLOT(9) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbg", fs[0], fs[1], SLOT(10));
  FSR(SLOT(11));
  a = 810076656u; b = 1890819626u;
  ST("st", 20, a);
  ATOMIC("swap", 20, b, SLOT(12));
  LD("ld", 20, SLOT(13));
  a = 65535u; b = 134834903u;
  RRCC("sub", a, b, c, cy); SLOT(14) = c; SLOT(15) = cy;
  a = 3u; b = 2326755974u;
  ANNUL("vc", a, b, SLOT(16));
  ANNUL("vc", a, a, SLOT(17));
  DELAY("vc", a, b, SLOT(18));
  a = 2260624617u; b = 3626450364u;
  fs[0] = -96.106f; fs[1] = 72.645f;
  F2("fmuls", fs[0], fs[1], fs[2]); SLOT(19) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(20) = *(volatile unsigned int *)&fs[2];
  F1("fmovs", fs[0], fs[2]); SLOT(21) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(22) = ((volatile unsigned int *)&fd[2])[0]; SLOT(23) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(24) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(25));
  a = 2671089812u; b = 3915863670u;
  ST("st", 8, a);
  ATOMIC("ldstub", 8, b, SLOT(26));
  LD("ld", 8, SLOT(27));
  a = 4091310189u; b = 1u;
  ADD64(a, b, 861027174u, 1042932802u, lo, hi); SLOT(28) = lo; SLOT(29) = hi;
  SUB64(a, b, 691936188u, 1129906232u, lo, hi); SLOT(30) = lo; SLOT(31) = hi;
  a = 1931411273u; b = 680142321u;
  RRCC("sub", a, b, c, cy); SLOT(32) = c; SLOT(33) = cy;
  a = 2512670427u; b = 3816238223u;
  SH("sra", a, 21, SLOT(34));
  a = 1550196848u; b = 255u;
  DIV("sdiv", a, b, 2189200555u, SLOT(35));
  a = 1u; b = 2110104575u;
  IMM("orn", a, -1859, SLOT(36));
  a = 1399169869u; b = 1431655765u;
  fs[0] = -0.0f; fs[1] = -88.264f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(37) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(38) = *(volatile unsigned int *)&fs[2];
  F1("fmovs", fs[0], fs[2]); SLOT(39) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(40) = ((volatile unsigned int *)&fd[2])[0]; SLOT(41) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(42) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(43));
  a = 1764680379u; b = 724620506u;
  ANNUL("lu", a, b, SLOT(44));
  ANNUL("lu", a, a, SLOT(45));
  DELAY("lu", a, b, SLOT(46));
  a = 641863192u; b = 993881741u;
  RR("xor", a, b, SLOT(47));
  a = 1889701309u; b = 2863311530u;
  ST("st", 60, a);
  ATOMIC("swap", 60, b, SLOT(48));
  LD("ld", 60, SLOT(49));
  a = 626639832u; b = 264913132u;
  ANNUL("geu", a, b, SLOT(50));
  ANNUL("geu", a, a, SLOT(51));
  DELAY("geu", a, b, SLOT(52));
  a = 2493365302u; b = 2003966312u;
  fd[0] = -6.967; fd[1] = -58.624;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(53) = ((volatile unsigned int *)&fd[2])[0]; SLOT(54) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(55) = ((volatile unsigned int *)&fd[2])[0]; SLOT(56) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(57) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(58) = *(volatile unsigned int *)&fs[2];
  fs[0] = -6.0f;
  F1("fitos", fs[0], fs[2]); SLOT(59) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(60) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(61) = ((volatile unsigned int *)&fd[2])[0]; SLOT(62) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbne", fs[0], fs[1], SLOT(63));
  FSR(SLOT(64));
  a = 835968399u; b = 3805898819u;
  MUL("smul", a, b, lo, hi); SLOT(65) = lo; SLOT(66) = hi;
  a = 2863311530u; b = 3924497681u;
  fs[0] = -98.757f; fs[1] = 92.375f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(67) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(68) = *(volatile unsigned int *)&fs[2];
  F1("fabss", fs[0], fs[2]); SLOT(69) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(70) = ((volatile unsigned int *)&fd[2])[0]; SLOT(71) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(72) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(73));
  a = 3295699453u; b = 2488181356u;
  TAGGED("tsubcc", a, b, SLOT(74), cy); SLOT(75) = cy;
  MULSCC(a, b, 6293330u, SLOT(76), SLOT(77));
  a = 2109071380u; b = 2006038495u;
  ANNUL("vc", a, b, SLOT(78));
  ANNUL("vc", a, a, SLOT(79));
  DELAY("vc", a, b, SLOT(80));
  a = 3545312474u; b = 3288219349u;
  DIV("sdiv", a, b, 616739970u, SLOT(81));
  a = 3241426667u; b = 2985478905u;
  TAGGED("taddcc", a, b, SLOT(82), cy); SLOT(83) = cy;
  MULSCC(a, b, 670206859u, SLOT(84), SLOT(85));
  a = 12899428u; b = 1877913282u;
  RRCC("sub", a, b, c, cy); SLOT(86) = c; SLOT(87) = cy;
  a = 2458618636u; b = 1137183641u;
  MUL("smul", a, b, lo, hi); SLOT(88) = lo; SLOT(89) = hi;
  a = 4294967295u; b = 1199691683u;
  ANNUL("pos", a, b, SLOT(90));
  ANNUL("pos", a, a, SLOT(91));
  DELAY("pos", a, b, SLOT(92));
  a = 32767u; b = 1995777922u;
  ST("st", 16, a);
  ATOMIC("ldstub", 16, b, SLOT(93));
  LD("ld", 16, SLOT(94));
  a = 1u; b = 0u;
  fd[0] = 34.145; fd[1] = -0.0;
  D2("faddd", fd[0], fd[1], fd[2]); SLOT(95) = ((volatile unsigned int *)&fd[2])[0]; SLOT(96) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(97) = ((volatile unsigned int *)&fd[2])[0]; SLOT(98) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(99) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(100) = *(volatile unsigned int *)&fs[2];
  fs[0] = 34.0f;
  F1("fitos", fs[0], fs[2]); SLOT(101) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(102) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(103) = ((volatile unsigned int *)&fd[2])[0]; SLOT(104) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbl", fs[0], fs[1], SLOT(105));
  FSR(SLOT(106));
  a = 3686456137u; b = 3964867023u;
  ANNUL("le", a, b, SLOT(107));
  ANNUL("le", a, a, SLOT(108));
  DELAY("le", a, b, SLOT(109));
  a = 263225702u; b = 3880670395u;
  ADD64(a, b, 826583607u, 1493498632u, lo, hi); SLOT(110) = lo; SLOT(111) = hi;
  SUB64(a, b, 2370201592u, 2396610106u, lo, hi); SLOT(112) = lo; SLOT(113) = hi;
  a = 704039389u; b = 2636286530u;
  ST("st", 4, a);
  ATOMIC("ldstub", 4, b, SLOT(114));
  LD("ld", 4, SLOT(115));
  a = 255u; b = 3429378761u;
  TAGGED("tsubcc", a, b, SLOT(116), cy); SLOT(117) = cy;
  MULSCC(a, b, 3150178920u, SLOT(118), SLOT(119));
  a = 2350408895u; b = 4092621929u;
  MUL("smul", a, b, lo, hi); SLOT(120) = lo; SLOT(121) = hi;
  a = 2840607279u; b = 1623001599u;
  ADD64(a, b, 2848457679u, 100262653u, lo, hi); SLOT(122) = lo; SLOT(123) = hi;
  SUB64(a, b, 466537239u, 1089671384u, lo, hi); SLOT(124) = lo; SLOT(125) = hi;
  a = 2655345980u; b = 2974353352u;
  SH("sra", a, 26, SLOT(126));
  a = 4216505085u; b = 256u;
  MUL("smul", a, b, lo, hi); SLOT(127) = lo; SLOT(128) = hi;
  SLOT(129) = deep(18, 2959555120u);
  SLOT(130) = deep(21, 2194869454u);
  return 0;
}
