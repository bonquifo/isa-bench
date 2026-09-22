
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
  a = 374225387u; b = 255u;
  IMM("andn", a, -3372, SLOT(0));
  a = 2572753110u; b = 1239737731u;
  MUL("smul", a, b, lo, hi); SLOT(1) = lo; SLOT(2) = hi;
  a = 1302447440u; b = 2147483649u;
  ADD64(a, b, 2147483648u, 2091474276u, lo, hi); SLOT(3) = lo; SLOT(4) = hi;
  SUB64(a, b, 2147483647u, 3968420463u, lo, hi); SLOT(5) = lo; SLOT(6) = hi;
  a = 4294967294u; b = 2862953197u;
  DIV("sdiv", a, b, 4139697877u, SLOT(7));
  a = 2502043221u; b = 3736897752u;
  fd[0] = 1.0; fd[1] = -75.154;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(8) = ((volatile unsigned int *)&fd[2])[0]; SLOT(9) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(10) = ((volatile unsigned int *)&fd[2])[0]; SLOT(11) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(12) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(13) = *(volatile unsigned int *)&fs[2];
  fs[0] = 1.0f;
  F1("fitos", fs[0], fs[2]); SLOT(14) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(15) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(16) = ((volatile unsigned int *)&fd[2])[0]; SLOT(17) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbue", fs[0], fs[1], SLOT(18));
  FSR(SLOT(19));
  a = 3979314528u; b = 3743555095u;
  MUL("umul", a, b, lo, hi); SLOT(20) = lo; SLOT(21) = hi;
  a = 255u; b = 2325184662u;
  fs[0] = 0.0f; fs[1] = 1.0f;
  F2("fdivs", fs[0], fs[1], fs[2]); SLOT(22) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(23) = *(volatile unsigned int *)&fs[2];
  F1("fmovs", fs[0], fs[2]); SLOT(24) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(25) = ((volatile unsigned int *)&fd[2])[0]; SLOT(26) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(27) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(28));
  a = 3366941206u; b = 3493849750u;
  MUL("smul", a, b, lo, hi); SLOT(29) = lo; SLOT(30) = hi;
  a = 2393922475u; b = 1310679885u;
  fs[0] = 0.0f; fs[1] = -0.0f;
  F2("fmuls", fs[0], fs[1], fs[2]); SLOT(31) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(32) = *(volatile unsigned int *)&fs[2];
  F1("fmovs", fs[0], fs[2]); SLOT(33) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(34) = ((volatile unsigned int *)&fd[2])[0]; SLOT(35) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(36) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(37));
  a = 2374160317u; b = 1164589182u;
  RRCC("and", a, b, c, cy); SLOT(38) = c; SLOT(39) = cy;
  a = 4244619289u; b = 2817928602u;
  fs[0] = -41.363f; fs[1] = -10.600f;
  F2("fsubs", fs[0], fs[1], fs[2]); SLOT(40) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(41) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(42) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(43) = ((volatile unsigned int *)&fd[2])[0]; SLOT(44) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(45) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(46));
  a = 2828089802u; b = 1579056337u;
  TAGGED("taddcc", a, b, SLOT(47), cy); SLOT(48) = cy;
  MULSCC(a, b, 1487485885u, SLOT(49), SLOT(50));
  a = 1u; b = 255u;
  RR("add", a, b, SLOT(51));
  a = 680656078u; b = 65535u;
  ST("st", 100, a);
  LD("ldsh", 102, SLOT(52));
  a = 1747145773u; b = 1822978142u;
  DIV("udiv", a, b, 908793364u, SLOT(53));
  a = 3325041103u; b = 619308514u;
  RRCC("add", a, b, c, cy); SLOT(54) = c; SLOT(55) = cy;
  a = 2147483647u; b = 3u;
  SH("sra", a, 2, SLOT(56));
  a = 3u; b = 3001750337u;
  ST("st", 28, a);
  ATOMIC("ldstub", 28, b, SLOT(57));
  LD("ld", 28, SLOT(58));
  a = 1468616341u; b = 3629440606u;
  ADD64(a, b, 2386278963u, 3597842699u, lo, hi); SLOT(59) = lo; SLOT(60) = hi;
  SUB64(a, b, 1436897645u, 2216665782u, lo, hi); SLOT(61) = lo; SLOT(62) = hi;
  a = 4294967294u; b = 4294967294u;
  ANNUL("geu", a, b, SLOT(63));
  ANNUL("geu", a, a, SLOT(64));
  DELAY("geu", a, b, SLOT(65));
  a = 1679685596u; b = 2147483649u;
  TAGGED("tsubcc", a, b, SLOT(66), cy); SLOT(67) = cy;
  MULSCC(a, b, 65536u, SLOT(68), SLOT(69));
  a = 2147483649u; b = 760469171u;
  TAGGED("tsubcc", a, b, SLOT(70), cy); SLOT(71) = cy;
  MULSCC(a, b, 1211263111u, SLOT(72), SLOT(73));
  a = 65535u; b = 2938924146u;
  TAGGED("taddcc", a, b, SLOT(74), cy); SLOT(75) = cy;
  MULSCC(a, b, 4163938355u, SLOT(76), SLOT(77));
  a = 2863311530u; b = 0u;
  MUL("smul", a, b, lo, hi); SLOT(78) = lo; SLOT(79) = hi;
  a = 2431777773u; b = 3303457547u;
  DIV("sdiv", a, b, 2732107600u, SLOT(80));
  a = 3103414652u; b = 644484357u;
  ANNUL("vc", a, b, SLOT(81));
  ANNUL("vc", a, a, SLOT(82));
  DELAY("vc", a, b, SLOT(83));
  a = 3097944273u; b = 3665522124u;
  fd[0] = 0.806; fd[1] = -69.259;
  D2("faddd", fd[0], fd[1], fd[2]); SLOT(84) = ((volatile unsigned int *)&fd[2])[0]; SLOT(85) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(86) = ((volatile unsigned int *)&fd[2])[0]; SLOT(87) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(88) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(89) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(90) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(91) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(92) = ((volatile unsigned int *)&fd[2])[0]; SLOT(93) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbug", fs[0], fs[1], SLOT(94));
  FSR(SLOT(95));
  a = 4175543632u; b = 1024200197u;
  fd[0] = -35.967; fd[1] = 83.883;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(96) = ((volatile unsigned int *)&fd[2])[0]; SLOT(97) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(98) = ((volatile unsigned int *)&fd[2])[0]; SLOT(99) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(100) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(101) = *(volatile unsigned int *)&fs[2];
  fs[0] = -35.0f;
  F1("fitos", fs[0], fs[2]); SLOT(102) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(103) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(104) = ((volatile unsigned int *)&fd[2])[0]; SLOT(105) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fblg", fs[0], fs[1], SLOT(106));
  FSR(SLOT(107));
  a = 1299071109u; b = 2147483649u;
  IMM("andn", a, -3078, SLOT(108));
  a = 789946351u; b = 3411421318u;
  RRCC("xor", a, b, c, cy); SLOT(109) = c; SLOT(110) = cy;
  a = 3921160491u; b = 255u;
  TAGGED("tsubcc", a, b, SLOT(111), cy); SLOT(112) = cy;
  MULSCC(a, b, 3266697382u, SLOT(113), SLOT(114));
  a = 256u; b = 32767u;
  RRCC("andn", a, b, c, cy); SLOT(115) = c; SLOT(116) = cy;
  a = 2353718336u; b = 3918894085u;
  fs[0] = -0.0f; fs[1] = -86.447f;
  F2("fsubs", fs[0], fs[1], fs[2]); SLOT(117) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(118) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(119) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(120) = ((volatile unsigned int *)&fd[2])[0]; SLOT(121) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(122) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(123));
  a = 3895743273u; b = 2147483647u;
  fs[0] = -0.0f; fs[1] = 1.0f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(124) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(125) = *(volatile unsigned int *)&fs[2];
  F1("fabss", fs[0], fs[2]); SLOT(126) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(127) = ((volatile unsigned int *)&fd[2])[0]; SLOT(128) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(129) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(130));
  a = 1174572854u; b = 2125458134u;
  ANNUL("vc", a, b, SLOT(131));
  ANNUL("vc", a, a, SLOT(132));
  DELAY("vc", a, b, SLOT(133));
  a = 282862180u; b = 3400938018u;
  IMM("orn", a, -570, SLOT(134));
  SLOT(135) = deep(20, 256u);
  SLOT(136) = deep(27, 2994337988u);
  return 0;
}
