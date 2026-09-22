
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
  a = 1u; b = 256u;
  TAGGED("tsubcc", a, b, SLOT(0), cy); SLOT(1) = cy;
  MULSCC(a, b, 653398416u, SLOT(2), SLOT(3));
  a = 1210982682u; b = 671243081u;
  ANNUL("neg", a, b, SLOT(4));
  ANNUL("neg", a, a, SLOT(5));
  DELAY("neg", a, b, SLOT(6));
  a = 775340831u; b = 2934016850u;
  RRCC("xor", a, b, c, cy); SLOT(7) = c; SLOT(8) = cy;
  a = 796868535u; b = 1u;
  IMM("orn", a, -1776, SLOT(9));
  a = 3556363268u; b = 2859426506u;
  DIV("udiv", a, b, 4294967294u, SLOT(10));
  a = 2737585099u; b = 1020428393u;
  fd[0] = -57.850; fd[1] = -87.641;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(11) = ((volatile unsigned int *)&fd[2])[0]; SLOT(12) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(13) = ((volatile unsigned int *)&fd[2])[0]; SLOT(14) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(15) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(16) = *(volatile unsigned int *)&fs[2];
  fs[0] = -57.0f;
  F1("fitos", fs[0], fs[2]); SLOT(17) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(18) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(19) = ((volatile unsigned int *)&fd[2])[0]; SLOT(20) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbge", fs[0], fs[1], SLOT(21));
  FSR(SLOT(22));
  a = 32767u; b = 2796408692u;
  ST("st", 92, a);
  LD("lduh", 92, SLOT(23));
  a = 3251659690u; b = 1237080902u;
  TAGGED("taddcc", a, b, SLOT(24), cy); SLOT(25) = cy;
  MULSCC(a, b, 2600831805u, SLOT(26), SLOT(27));
  a = 4294967294u; b = 3114842052u;
  RRCC("xnor", a, b, c, cy); SLOT(28) = c; SLOT(29) = cy;
  a = 2147483647u; b = 32767u;
  IMM("xor", a, -2843, SLOT(30));
  a = 715506772u; b = 2596930722u;
  fd[0] = 0.0; fd[1] = -61.051;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(31) = ((volatile unsigned int *)&fd[2])[0]; SLOT(32) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(33) = ((volatile unsigned int *)&fd[2])[0]; SLOT(34) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(35) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(36) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(37) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(38) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(39) = ((volatile unsigned int *)&fd[2])[0]; SLOT(40) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbue", fs[0], fs[1], SLOT(41));
  FSR(SLOT(42));
  a = 4294967295u; b = 3795817614u;
  ST("st", 84, a);
  LD("lduh", 84, SLOT(43));
  a = 1345610242u; b = 3201119113u;
  ST("st", 88, a);
  LD("ldsh", 90, SLOT(44));
  a = 1419573674u; b = 255u;
  SH("sll", a, 34, SLOT(45));
  a = 2073954359u; b = 1u;
  TAGGED("taddcc", a, b, SLOT(46), cy); SLOT(47) = cy;
  MULSCC(a, b, 1164844283u, SLOT(48), SLOT(49));
  a = 2147483647u; b = 2863311530u;
  ST("st", 20, a);
  ATOMIC("swap", 20, b, SLOT(50));
  LD("ld", 20, SLOT(51));
  a = 1915799876u; b = 817322564u;
  ST("st", 48, a);
  LD("lduh", 48, SLOT(52));
  a = 2459549040u; b = 4080373728u;
  RR("xor", a, b, SLOT(53));
  a = 2708303095u; b = 4119839627u;
  fd[0] = -70.138; fd[1] = 50.229;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(54) = ((volatile unsigned int *)&fd[2])[0]; SLOT(55) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(56) = ((volatile unsigned int *)&fd[2])[0]; SLOT(57) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(58) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(59) = *(volatile unsigned int *)&fs[2];
  fs[0] = -70.0f;
  F1("fitos", fs[0], fs[2]); SLOT(60) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(61) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(62) = ((volatile unsigned int *)&fd[2])[0]; SLOT(63) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbe", fs[0], fs[1], SLOT(64));
  FSR(SLOT(65));
  a = 1915667901u; b = 1756549127u;
  SH("sra", a, 38, SLOT(66));
  a = 2091412192u; b = 3016881553u;
  RRCC("add", a, b, c, cy); SLOT(67) = c; SLOT(68) = cy;
  a = 1u; b = 498500319u;
  MUL("umul", a, b, lo, hi); SLOT(69) = lo; SLOT(70) = hi;
  a = 4031667491u; b = 3762402134u;
  MUL("umul", a, b, lo, hi); SLOT(71) = lo; SLOT(72) = hi;
  a = 820626090u; b = 1286910489u;
  fd[0] = -38.392; fd[1] = 84.969;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(73) = ((volatile unsigned int *)&fd[2])[0]; SLOT(74) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(75) = ((volatile unsigned int *)&fd[2])[0]; SLOT(76) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(77) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(78) = *(volatile unsigned int *)&fs[2];
  fs[0] = -38.0f;
  F1("fitos", fs[0], fs[2]); SLOT(79) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(80) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(81) = ((volatile unsigned int *)&fd[2])[0]; SLOT(82) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbu", fs[0], fs[1], SLOT(83));
  FSR(SLOT(84));
  a = 32767u; b = 2u;
  RRCC("add", a, b, c, cy); SLOT(85) = c; SLOT(86) = cy;
  a = 1820562964u; b = 3u;
  MUL("smul", a, b, lo, hi); SLOT(87) = lo; SLOT(88) = hi;
  a = 3018219482u; b = 3650408532u;
  TAGGED("taddcc", a, b, SLOT(89), cy); SLOT(90) = cy;
  MULSCC(a, b, 3264083309u, SLOT(91), SLOT(92));
  a = 2u; b = 2518427370u;
  SH("sll", a, 35, SLOT(93));
  a = 3270765569u; b = 2147483647u;
  ST("st", 32, a);
  ATOMIC("ldstub", 32, b, SLOT(94));
  LD("ld", 32, SLOT(95));
  a = 4294967294u; b = 3257264032u;
  RRCC("and", a, b, c, cy); SLOT(96) = c; SLOT(97) = cy;
  a = 4194066644u; b = 3454851814u;
  DIV("sdiv", a, b, 1082206658u, SLOT(98));
  a = 3370437914u; b = 3984957015u;
  SH("sra", a, 15, SLOT(99));
  a = 3812399835u; b = 65536u;
  DIV("sdiv", a, b, 3161321969u, SLOT(100));
  a = 2863311530u; b = 1119116369u;
  ST("st", 32, a);
  ATOMIC("swap", 32, b, SLOT(101));
  LD("ld", 32, SLOT(102));
  a = 949347912u; b = 864678921u;
  SH("srl", a, 7, SLOT(103));
  a = 3691150982u; b = 1489931491u;
  ST("st", 24, a);
  ATOMIC("ldstub", 24, b, SLOT(104));
  LD("ld", 24, SLOT(105));
  SLOT(106) = deep(19, 1134774504u);
  SLOT(107) = deep(22, 65535u);
  return 0;
}
