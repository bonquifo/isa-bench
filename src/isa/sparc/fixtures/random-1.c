
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
  a = 3292134928u; b = 2u;
  ANNUL("neg", a, b, SLOT(0));
  ANNUL("neg", a, a, SLOT(1));
  DELAY("neg", a, b, SLOT(2));
  a = 2408098043u; b = 3321312764u;
  ST("st", 20, a);
  LD("ldub", 21, SLOT(3));
  a = 960499398u; b = 3937159724u;
  RRCC("orn", a, b, c, cy); SLOT(4) = c; SLOT(5) = cy;
  a = 1774132593u; b = 2u;
  TAGGED("taddcc", a, b, SLOT(6), cy); SLOT(7) = cy;
  MULSCC(a, b, 549744443u, SLOT(8), SLOT(9));
  a = 167972903u; b = 2012343991u;
  SH("sra", a, 3, SLOT(10));
  a = 2863311530u; b = 4282276312u;
  SH("srl", a, 27, SLOT(11));
  a = 2425340140u; b = 3175950846u;
  fd[0] = -33.729; fd[1] = 17.901;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(12) = ((volatile unsigned int *)&fd[2])[0]; SLOT(13) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(14) = ((volatile unsigned int *)&fd[2])[0]; SLOT(15) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(16) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(17) = *(volatile unsigned int *)&fs[2];
  fs[0] = -33.0f;
  F1("fitos", fs[0], fs[2]); SLOT(18) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(19) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(20) = ((volatile unsigned int *)&fd[2])[0]; SLOT(21) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbug", fs[0], fs[1], SLOT(22));
  FSR(SLOT(23));
  a = 2304639113u; b = 855673289u;
  IMM("and", a, -1061, SLOT(24));
  a = 1430969279u; b = 3934663867u;
  TAGGED("taddcc", a, b, SLOT(25), cy); SLOT(26) = cy;
  MULSCC(a, b, 21190407u, SLOT(27), SLOT(28));
  a = 2863311530u; b = 32767u;
  IMM("orn", a, -1059, SLOT(29));
  a = 748841569u; b = 1431655765u;
  RR("orn", a, b, SLOT(30));
  a = 243855053u; b = 2147483647u;
  fs[0] = 2.430f; fs[1] = -68.569f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(31) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(32) = *(volatile unsigned int *)&fs[2];
  F1("fabss", fs[0], fs[2]); SLOT(33) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(34) = ((volatile unsigned int *)&fd[2])[0]; SLOT(35) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(36) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(37));
  a = 2570879091u; b = 1896082319u;
  RRCC("andn", a, b, c, cy); SLOT(38) = c; SLOT(39) = cy;
  a = 3962615458u; b = 2748772890u;
  SH("sll", a, 3, SLOT(40));
  a = 1371295238u; b = 255u;
  ADD64(a, b, 1976061978u, 3843139438u, lo, hi); SLOT(41) = lo; SLOT(42) = hi;
  SUB64(a, b, 2147483649u, 1368118074u, lo, hi); SLOT(43) = lo; SLOT(44) = hi;
  a = 3499002943u; b = 1536445713u;
  ANNUL("geu", a, b, SLOT(45));
  ANNUL("geu", a, a, SLOT(46));
  DELAY("geu", a, b, SLOT(47));
  a = 223232509u; b = 2147483649u;
  fd[0] = -95.901; fd[1] = 83.992;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(48) = ((volatile unsigned int *)&fd[2])[0]; SLOT(49) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(50) = ((volatile unsigned int *)&fd[2])[0]; SLOT(51) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(52) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(53) = *(volatile unsigned int *)&fs[2];
  fs[0] = -95.0f;
  F1("fitos", fs[0], fs[2]); SLOT(54) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(55) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(56) = ((volatile unsigned int *)&fd[2])[0]; SLOT(57) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbe", fs[0], fs[1], SLOT(58));
  FSR(SLOT(59));
  a = 3088454703u; b = 4294967295u;
  IMM("and", a, 3764, SLOT(60));
  a = 3074140011u; b = 2045609949u;
  RR("xor", a, b, SLOT(61));
  a = 2177074379u; b = 815844324u;
  IMM("xnor", a, 2352, SLOT(62));
  a = 3481793824u; b = 2391796397u;
  ANNUL("lu", a, b, SLOT(63));
  ANNUL("lu", a, a, SLOT(64));
  DELAY("lu", a, b, SLOT(65));
  a = 2u; b = 3842360140u;
  RR("xor", a, b, SLOT(66));
  a = 3513080782u; b = 3336898674u;
  ST("st", 80, a);
  LD("ldsh", 80, SLOT(67));
  a = 1431655765u; b = 2485756084u;
  MUL("smul", a, b, lo, hi); SLOT(68) = lo; SLOT(69) = hi;
  a = 2097275064u; b = 1724939619u;
  RR("orn", a, b, SLOT(70));
  a = 4186612865u; b = 3586420906u;
  ANNUL("e", a, b, SLOT(71));
  ANNUL("e", a, a, SLOT(72));
  DELAY("e", a, b, SLOT(73));
  a = 4028273879u; b = 3521310604u;
  ST("st", 24, a);
  ATOMIC("swap", 24, b, SLOT(74));
  LD("ld", 24, SLOT(75));
  a = 2110720352u; b = 32767u;
  ST("st", 32, a);
  LD("lduh", 32, SLOT(76));
  a = 218732629u; b = 2394583302u;
  ADD64(a, b, 67522098u, 4083948217u, lo, hi); SLOT(77) = lo; SLOT(78) = hi;
  SUB64(a, b, 3u, 3186583339u, lo, hi); SLOT(79) = lo; SLOT(80) = hi;
  a = 3569785012u; b = 3145374041u;
  RR("sub", a, b, SLOT(81));
  a = 516825900u; b = 3775258672u;
  ANNUL("g", a, b, SLOT(82));
  ANNUL("g", a, a, SLOT(83));
  DELAY("g", a, b, SLOT(84));
  a = 0u; b = 1u;
  RRCC("andn", a, b, c, cy); SLOT(85) = c; SLOT(86) = cy;
  a = 446886327u; b = 2u;
  fd[0] = -0.0; fd[1] = 34.865;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(87) = ((volatile unsigned int *)&fd[2])[0]; SLOT(88) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(89) = ((volatile unsigned int *)&fd[2])[0]; SLOT(90) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(91) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(92) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(93) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(94) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(95) = ((volatile unsigned int *)&fd[2])[0]; SLOT(96) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbe", fs[0], fs[1], SLOT(97));
  FSR(SLOT(98));
  a = 2546027784u; b = 449667049u;
  fs[0] = 67.407f; fs[1] = 84.841f;
  F2("fsubs", fs[0], fs[1], fs[2]); SLOT(99) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(100) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(101) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(102) = ((volatile unsigned int *)&fd[2])[0]; SLOT(103) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(104) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(105));
  a = 3676764146u; b = 3064999015u;
  RRCC("xnor", a, b, c, cy); SLOT(106) = c; SLOT(107) = cy;
  a = 4064709693u; b = 1431655765u;
  SH("sra", a, 18, SLOT(108));
  SLOT(109) = deep(20, 256u);
  SLOT(110) = deep(23, 2318236485u);
  return 0;
}
