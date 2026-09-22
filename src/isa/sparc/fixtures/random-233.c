
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
  a = 2u; b = 65535u;
  fs[0] = 10.078f; fs[1] = 37.101f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(0) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(1) = *(volatile unsigned int *)&fs[2];
  F1("fmovs", fs[0], fs[2]); SLOT(2) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(3) = ((volatile unsigned int *)&fd[2])[0]; SLOT(4) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(5) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(6));
  a = 1048933117u; b = 1883451486u;
  MUL("umul", a, b, lo, hi); SLOT(7) = lo; SLOT(8) = hi;
  a = 4294967294u; b = 2u;
  ST("st", 68, a);
  LD("ld", 68, SLOT(9));
  a = 2946254646u; b = 3078451304u;
  DIV("udiv", a, b, 1930594662u, SLOT(10));
  a = 2314231967u; b = 2393183307u;
  fs[0] = 0.0f; fs[1] = -34.131f;
  F2("fsubs", fs[0], fs[1], fs[2]); SLOT(11) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(12) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(13) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(14) = ((volatile unsigned int *)&fd[2])[0]; SLOT(15) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(16) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(17));
  a = 408960493u; b = 1143886464u;
  TAGGED("taddcc", a, b, SLOT(18), cy); SLOT(19) = cy;
  MULSCC(a, b, 481915641u, SLOT(20), SLOT(21));
  a = 1657470554u; b = 256u;
  ADD64(a, b, 838056557u, 3155590898u, lo, hi); SLOT(22) = lo; SLOT(23) = hi;
  SUB64(a, b, 1830853074u, 3541938228u, lo, hi); SLOT(24) = lo; SLOT(25) = hi;
  a = 3380511832u; b = 2046607381u;
  ADD64(a, b, 2317784291u, 4050278480u, lo, hi); SLOT(26) = lo; SLOT(27) = hi;
  SUB64(a, b, 505077389u, 3056390489u, lo, hi); SLOT(28) = lo; SLOT(29) = hi;
  a = 1094909654u; b = 200004499u;
  RR("add", a, b, SLOT(30));
  a = 1398901335u; b = 2591421229u;
  SH("sra", a, 37, SLOT(31));
  a = 2147483649u; b = 3691092868u;
  MUL("umul", a, b, lo, hi); SLOT(32) = lo; SLOT(33) = hi;
  a = 3852048024u; b = 3304462907u;
  DIV("udiv", a, b, 2207114491u, SLOT(34));
  a = 5708944u; b = 1813758112u;
  ST("st", 28, a);
  LD("ldsh", 30, SLOT(35));
  a = 2355887474u; b = 1879369729u;
  ST("st", 24, a);
  ATOMIC("swap", 24, b, SLOT(36));
  LD("ld", 24, SLOT(37));
  a = 2859341363u; b = 2186261274u;
  ST("st", 56, a);
  LD("ldub", 59, SLOT(38));
  a = 1269878065u; b = 4294967294u;
  fs[0] = 1.0f; fs[1] = -93.063f;
  F2("fdivs", fs[0], fs[1], fs[2]); SLOT(39) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(40) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(41) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(42) = ((volatile unsigned int *)&fd[2])[0]; SLOT(43) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(44) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(45));
  a = 458374328u; b = 4200530070u;
  ST("st", 16, a);
  ATOMIC("ldstub", 16, b, SLOT(46));
  LD("ld", 16, SLOT(47));
  a = 3973233650u; b = 2147483648u;
  MUL("smul", a, b, lo, hi); SLOT(48) = lo; SLOT(49) = hi;
  a = 2367043777u; b = 3222788065u;
  RRCC("xor", a, b, c, cy); SLOT(50) = c; SLOT(51) = cy;
  a = 913997460u; b = 2058945783u;
  ADD64(a, b, 2147483648u, 2330762004u, lo, hi); SLOT(52) = lo; SLOT(53) = hi;
  SUB64(a, b, 2213858988u, 4294967294u, lo, hi); SLOT(54) = lo; SLOT(55) = hi;
  a = 941409699u; b = 4052036412u;
  TAGGED("tsubcc", a, b, SLOT(56), cy); SLOT(57) = cy;
  MULSCC(a, b, 2707180512u, SLOT(58), SLOT(59));
  a = 2778914048u; b = 2923501212u;
  ST("st", 96, a);
  LD("ldsh", 98, SLOT(60));
  a = 2876515449u; b = 1423758472u;
  SH("sra", a, 22, SLOT(61));
  a = 2534616361u; b = 1623324726u;
  DIV("sdiv", a, b, 2147483649u, SLOT(62));
  a = 3u; b = 2147483648u;
  RRCC("sub", a, b, c, cy); SLOT(63) = c; SLOT(64) = cy;
  a = 2147483649u; b = 3110851900u;
  ANNUL("vs", a, b, SLOT(65));
  ANNUL("vs", a, a, SLOT(66));
  DELAY("vs", a, b, SLOT(67));
  a = 1838626280u; b = 1843301110u;
  DIV("sdiv", a, b, 3634498348u, SLOT(68));
  a = 256u; b = 4131935304u;
  ST("st", 0, a);
  ATOMIC("swap", 0, b, SLOT(69));
  LD("ld", 0, SLOT(70));
  a = 2246220543u; b = 3853804236u;
  ADD64(a, b, 2019150074u, 2504932929u, lo, hi); SLOT(71) = lo; SLOT(72) = hi;
  SUB64(a, b, 4136931177u, 1793422969u, lo, hi); SLOT(73) = lo; SLOT(74) = hi;
  a = 1058445252u; b = 2375869934u;
  fd[0] = 0.0; fd[1] = 75.430;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(75) = ((volatile unsigned int *)&fd[2])[0]; SLOT(76) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(77) = ((volatile unsigned int *)&fd[2])[0]; SLOT(78) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(79) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(80) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(81) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(82) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(83) = ((volatile unsigned int *)&fd[2])[0]; SLOT(84) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbug", fs[0], fs[1], SLOT(85));
  FSR(SLOT(86));
  a = 2064871096u; b = 2129890990u;
  RR("or", a, b, SLOT(87));
  a = 32767u; b = 542337856u;
  fd[0] = 17.968; fd[1] = -25.736;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(88) = ((volatile unsigned int *)&fd[2])[0]; SLOT(89) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(90) = ((volatile unsigned int *)&fd[2])[0]; SLOT(91) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(92) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(93) = *(volatile unsigned int *)&fs[2];
  fs[0] = 17.0f;
  F1("fitos", fs[0], fs[2]); SLOT(94) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(95) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(96) = ((volatile unsigned int *)&fd[2])[0]; SLOT(97) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbl", fs[0], fs[1], SLOT(98));
  FSR(SLOT(99));
  a = 1105164495u; b = 465962755u;
  TAGGED("taddcc", a, b, SLOT(100), cy); SLOT(101) = cy;
  MULSCC(a, b, 3866319102u, SLOT(102), SLOT(103));
  a = 1587227842u; b = 1432003893u;
  ADD64(a, b, 1780711945u, 4214272793u, lo, hi); SLOT(104) = lo; SLOT(105) = hi;
  SUB64(a, b, 3u, 2806774347u, lo, hi); SLOT(106) = lo; SLOT(107) = hi;
  a = 2147483648u; b = 3035132484u;
  DIV("udiv", a, b, 2095045170u, SLOT(108));
  a = 1471179110u; b = 2739436199u;
  RR("add", a, b, SLOT(109));
  SLOT(110) = deep(22, 3980000577u);
  SLOT(111) = deep(27, 65536u);
  return 0;
}
