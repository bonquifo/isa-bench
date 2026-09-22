
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
  a = 341778923u; b = 3656736142u;
  SH("srl", a, 20, SLOT(0));
  a = 1843935464u; b = 256u;
  RR("orn", a, b, SLOT(1));
  a = 572186750u; b = 1140423975u;
  ST("st", 44, a);
  ATOMIC("ldstub", 44, b, SLOT(2));
  LD("ld", 44, SLOT(3));
  a = 3177092916u; b = 2147483649u;
  TAGGED("taddcc", a, b, SLOT(4), cy); SLOT(5) = cy;
  MULSCC(a, b, 3467283399u, SLOT(6), SLOT(7));
  a = 1458628429u; b = 1249269597u;
  ANNUL("neg", a, b, SLOT(8));
  ANNUL("neg", a, a, SLOT(9));
  DELAY("neg", a, b, SLOT(10));
  a = 3161616785u; b = 2u;
  MUL("smul", a, b, lo, hi); SLOT(11) = lo; SLOT(12) = hi;
  a = 3135004531u; b = 2951101936u;
  ADD64(a, b, 4053200474u, 1431655765u, lo, hi); SLOT(13) = lo; SLOT(14) = hi;
  SUB64(a, b, 2147483649u, 2147483647u, lo, hi); SLOT(15) = lo; SLOT(16) = hi;
  a = 2u; b = 0u;
  fd[0] = 0.0; fd[1] = -0.0;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(17) = ((volatile unsigned int *)&fd[2])[0]; SLOT(18) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(19) = ((volatile unsigned int *)&fd[2])[0]; SLOT(20) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(21) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(22) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(23) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(24) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(25) = ((volatile unsigned int *)&fd[2])[0]; SLOT(26) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbo", fs[0], fs[1], SLOT(27));
  FSR(SLOT(28));
  a = 2635168300u; b = 0u;
  fd[0] = -0.0; fd[1] = -0.0;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(29) = ((volatile unsigned int *)&fd[2])[0]; SLOT(30) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(31) = ((volatile unsigned int *)&fd[2])[0]; SLOT(32) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(33) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(34) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(35) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(36) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(37) = ((volatile unsigned int *)&fd[2])[0]; SLOT(38) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbo", fs[0], fs[1], SLOT(39));
  FSR(SLOT(40));
  a = 32767u; b = 2520277751u;
  ADD64(a, b, 3779320666u, 1569250086u, lo, hi); SLOT(41) = lo; SLOT(42) = hi;
  SUB64(a, b, 1563837583u, 2728639319u, lo, hi); SLOT(43) = lo; SLOT(44) = hi;
  a = 1734477891u; b = 1u;
  ANNUL("leu", a, b, SLOT(45));
  ANNUL("leu", a, a, SLOT(46));
  DELAY("leu", a, b, SLOT(47));
  a = 4173192678u; b = 2173605261u;
  DIV("udiv", a, b, 971262304u, SLOT(48));
  a = 3981055869u; b = 1478711885u;
  ADD64(a, b, 2660976834u, 3124387452u, lo, hi); SLOT(49) = lo; SLOT(50) = hi;
  SUB64(a, b, 4294967294u, 1507660496u, lo, hi); SLOT(51) = lo; SLOT(52) = hi;
  a = 65536u; b = 2557962006u;
  RRCC("andn", a, b, c, cy); SLOT(53) = c; SLOT(54) = cy;
  a = 3771479408u; b = 256u;
  IMM("add", a, -57, SLOT(55));
  a = 2670094676u; b = 960304036u;
  IMM("add", a, -516, SLOT(56));
  a = 1043495139u; b = 1580805079u;
  ANNUL("le", a, b, SLOT(57));
  ANNUL("le", a, a, SLOT(58));
  DELAY("le", a, b, SLOT(59));
  a = 3489827082u; b = 2727092237u;
  TAGGED("tsubcc", a, b, SLOT(60), cy); SLOT(61) = cy;
  MULSCC(a, b, 2863311530u, SLOT(62), SLOT(63));
  a = 3042984475u; b = 2072695072u;
  SH("sra", a, 39, SLOT(64));
  a = 65536u; b = 2147483648u;
  ANNUL("geu", a, b, SLOT(65));
  ANNUL("geu", a, a, SLOT(66));
  DELAY("geu", a, b, SLOT(67));
  a = 2719266253u; b = 2491921156u;
  RR("or", a, b, SLOT(68));
  a = 2274197964u; b = 2477158904u;
  RR("xor", a, b, SLOT(69));
  a = 0u; b = 2850708129u;
  ANNUL("e", a, b, SLOT(70));
  ANNUL("e", a, a, SLOT(71));
  DELAY("e", a, b, SLOT(72));
  a = 688902711u; b = 988180418u;
  ST("st", 20, a);
  ATOMIC("ldstub", 20, b, SLOT(73));
  LD("ld", 20, SLOT(74));
  a = 3173949911u; b = 3415888260u;
  fs[0] = 32.204f; fs[1] = 0.0f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(75) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(76) = *(volatile unsigned int *)&fs[2];
  F1("fmovs", fs[0], fs[2]); SLOT(77) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(78) = ((volatile unsigned int *)&fd[2])[0]; SLOT(79) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(80) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(81));
  a = 2759065744u; b = 2377790539u;
  MUL("umul", a, b, lo, hi); SLOT(82) = lo; SLOT(83) = hi;
  a = 2u; b = 1u;
  RR("or", a, b, SLOT(84));
  a = 3680998293u; b = 65536u;
  ST("st", 36, a);
  ATOMIC("swap", 36, b, SLOT(85));
  LD("ld", 36, SLOT(86));
  a = 3914530226u; b = 1u;
  DIV("sdiv", a, b, 1774451312u, SLOT(87));
  a = 3978679362u; b = 1u;
  RR("xnor", a, b, SLOT(88));
  a = 3748295852u; b = 2147483649u;
  ANNUL("ge", a, b, SLOT(89));
  ANNUL("ge", a, a, SLOT(90));
  DELAY("ge", a, b, SLOT(91));
  a = 65536u; b = 3688430194u;
  fd[0] = 1.0; fd[1] = -94.489;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(92) = ((volatile unsigned int *)&fd[2])[0]; SLOT(93) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(94) = ((volatile unsigned int *)&fd[2])[0]; SLOT(95) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(96) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(97) = *(volatile unsigned int *)&fs[2];
  fs[0] = 1.0f;
  F1("fitos", fs[0], fs[2]); SLOT(98) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(99) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(100) = ((volatile unsigned int *)&fd[2])[0]; SLOT(101) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fblg", fs[0], fs[1], SLOT(102));
  FSR(SLOT(103));
  a = 80044711u; b = 1957755464u;
  IMM("add", a, 2328, SLOT(104));
  a = 1431655765u; b = 2028603289u;
  RRCC("xnor", a, b, c, cy); SLOT(105) = c; SLOT(106) = cy;
  a = 1536616628u; b = 3971990175u;
  ADD64(a, b, 2061845046u, 3578791071u, lo, hi); SLOT(107) = lo; SLOT(108) = hi;
  SUB64(a, b, 664736155u, 2511530768u, lo, hi); SLOT(109) = lo; SLOT(110) = hi;
  a = 3u; b = 2145102966u;
  ST("st", 20, a);
  ATOMIC("ldstub", 20, b, SLOT(111));
  LD("ld", 20, SLOT(112));
  SLOT(113) = deep(16, 313300624u);
  SLOT(114) = deep(22, 2924175431u);
  return 0;
}
