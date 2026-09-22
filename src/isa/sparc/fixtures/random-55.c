
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
  a = 3519421212u; b = 2050632977u;
  fs[0] = -68.533f; fs[1] = -0.0f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(0) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(1) = *(volatile unsigned int *)&fs[2];
  F1("fmovs", fs[0], fs[2]); SLOT(2) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(3) = ((volatile unsigned int *)&fd[2])[0]; SLOT(4) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(5) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(6));
  a = 1657813204u; b = 1431655765u;
  ST("st", 4, a);
  ATOMIC("swap", 4, b, SLOT(7));
  LD("ld", 4, SLOT(8));
  a = 3u; b = 454165437u;
  RR("and", a, b, SLOT(9));
  a = 2891219723u; b = 1302205932u;
  fd[0] = 4.476; fd[1] = -5.094;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(10) = ((volatile unsigned int *)&fd[2])[0]; SLOT(11) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(12) = ((volatile unsigned int *)&fd[2])[0]; SLOT(13) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(14) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(15) = *(volatile unsigned int *)&fs[2];
  fs[0] = 4.0f;
  F1("fitos", fs[0], fs[2]); SLOT(16) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(17) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(18) = ((volatile unsigned int *)&fd[2])[0]; SLOT(19) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbu", fs[0], fs[1], SLOT(20));
  FSR(SLOT(21));
  a = 2863311530u; b = 4294967295u;
  RRCC("xor", a, b, c, cy); SLOT(22) = c; SLOT(23) = cy;
  a = 4294967294u; b = 118817475u;
  ST("st", 124, a);
  LD("ldub", 127, SLOT(24));
  a = 201772026u; b = 2045432898u;
  RR("or", a, b, SLOT(25));
  a = 255u; b = 3505628653u;
  SH("sll", a, 27, SLOT(26));
  a = 2700310947u; b = 942932804u;
  ST("st", 24, a);
  LD("lduh", 26, SLOT(27));
  a = 1430628338u; b = 776690373u;
  TAGGED("tsubcc", a, b, SLOT(28), cy); SLOT(29) = cy;
  MULSCC(a, b, 1566651335u, SLOT(30), SLOT(31));
  a = 1332773626u; b = 3832684330u;
  RR("xor", a, b, SLOT(32));
  a = 2985932297u; b = 467492912u;
  ADD64(a, b, 2152666723u, 3535667735u, lo, hi); SLOT(33) = lo; SLOT(34) = hi;
  SUB64(a, b, 3056567995u, 1u, lo, hi); SLOT(35) = lo; SLOT(36) = hi;
  a = 4294967294u; b = 1633788779u;
  RRCC("or", a, b, c, cy); SLOT(37) = c; SLOT(38) = cy;
  a = 1823022577u; b = 1u;
  ST("st", 8, a);
  LD("ldsb", 10, SLOT(39));
  a = 2863311530u; b = 581310886u;
  MUL("smul", a, b, lo, hi); SLOT(40) = lo; SLOT(41) = hi;
  a = 1949293050u; b = 4259622095u;
  SH("sra", a, 25, SLOT(42));
  a = 65536u; b = 618839409u;
  IMM("xnor", a, -157, SLOT(43));
  a = 785149171u; b = 1758434652u;
  ST("st", 64, a);
  LD("ldsh", 66, SLOT(44));
  a = 65535u; b = 1481579648u;
  TAGGED("taddcc", a, b, SLOT(45), cy); SLOT(46) = cy;
  MULSCC(a, b, 2114332473u, SLOT(47), SLOT(48));
  a = 946152723u; b = 3072284377u;
  TAGGED("taddcc", a, b, SLOT(49), cy); SLOT(50) = cy;
  MULSCC(a, b, 2219669854u, SLOT(51), SLOT(52));
  a = 2863311530u; b = 2648575153u;
  ST("st", 36, a);
  ATOMIC("swap", 36, b, SLOT(53));
  LD("ld", 36, SLOT(54));
  a = 1u; b = 393858863u;
  DIV("sdiv", a, b, 4294967294u, SLOT(55));
  a = 3033800907u; b = 3u;
  ST("st", 56, a);
  ATOMIC("ldstub", 56, b, SLOT(56));
  LD("ld", 56, SLOT(57));
  a = 1776651082u; b = 1766015450u;
  RR("xor", a, b, SLOT(58));
  a = 4143611109u; b = 3361086035u;
  DIV("sdiv", a, b, 3878354458u, SLOT(59));
  a = 65536u; b = 3213998821u;
  RRCC("or", a, b, c, cy); SLOT(60) = c; SLOT(61) = cy;
  a = 4037471592u; b = 65536u;
  fs[0] = -0.603f; fs[1] = 15.167f;
  F2("fsubs", fs[0], fs[1], fs[2]); SLOT(62) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(63) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(64) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(65) = ((volatile unsigned int *)&fd[2])[0]; SLOT(66) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(67) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(68));
  a = 32767u; b = 3728170977u;
  fs[0] = -0.0f; fs[1] = -17.804f;
  F2("fdivs", fs[0], fs[1], fs[2]); SLOT(69) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(70) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(71) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(72) = ((volatile unsigned int *)&fd[2])[0]; SLOT(73) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(74) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(75));
  a = 3987023583u; b = 2u;
  IMM("sub", a, -584, SLOT(76));
  a = 1378779441u; b = 1431655765u;
  MUL("umul", a, b, lo, hi); SLOT(77) = lo; SLOT(78) = hi;
  a = 32767u; b = 2453396919u;
  DIV("sdiv", a, b, 1589169499u, SLOT(79));
  a = 1143769377u; b = 3338803969u;
  ADD64(a, b, 3249023562u, 1842441689u, lo, hi); SLOT(80) = lo; SLOT(81) = hi;
  SUB64(a, b, 4009954543u, 1262483801u, lo, hi); SLOT(82) = lo; SLOT(83) = hi;
  a = 4041246131u; b = 1935180898u;
  MUL("smul", a, b, lo, hi); SLOT(84) = lo; SLOT(85) = hi;
  a = 749361076u; b = 2853035982u;
  RRCC("xnor", a, b, c, cy); SLOT(86) = c; SLOT(87) = cy;
  a = 2199850521u; b = 2324091282u;
  ST("st", 28, a);
  ATOMIC("ldstub", 28, b, SLOT(88));
  LD("ld", 28, SLOT(89));
  a = 2863311530u; b = 1431655765u;
  RR("and", a, b, SLOT(90));
  SLOT(91) = deep(23, 65535u);
  SLOT(92) = deep(26, 894621643u);
  return 0;
}
