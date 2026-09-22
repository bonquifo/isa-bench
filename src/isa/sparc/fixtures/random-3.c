
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
  a = 3922421592u; b = 2863311530u;
  SH("srl", a, 17, SLOT(0));
  a = 277795538u; b = 65535u;
  fd[0] = -0.0; fd[1] = 10.791;
  D2("fdivd", fd[0], fd[1], fd[2]); SLOT(1) = ((volatile unsigned int *)&fd[2])[0]; SLOT(2) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(3) = ((volatile unsigned int *)&fd[2])[0]; SLOT(4) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(5) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(6) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(7) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(8) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(9) = ((volatile unsigned int *)&fd[2])[0]; SLOT(10) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbl", fs[0], fs[1], SLOT(11));
  FSR(SLOT(12));
  a = 2460258201u; b = 0u;
  ADD64(a, b, 2u, 4065538928u, lo, hi); SLOT(13) = lo; SLOT(14) = hi;
  SUB64(a, b, 4294967294u, 1995698787u, lo, hi); SLOT(15) = lo; SLOT(16) = hi;
  a = 2243928136u; b = 65535u;
  MUL("umul", a, b, lo, hi); SLOT(17) = lo; SLOT(18) = hi;
  a = 2147483648u; b = 2147483647u;
  ADD64(a, b, 3387365122u, 4294967295u, lo, hi); SLOT(19) = lo; SLOT(20) = hi;
  SUB64(a, b, 4100555260u, 625904966u, lo, hi); SLOT(21) = lo; SLOT(22) = hi;
  a = 2147483648u; b = 1431655765u;
  IMM("xor", a, -3563, SLOT(23));
  a = 3812098264u; b = 1712794135u;
  RR("xnor", a, b, SLOT(24));
  a = 3659120227u; b = 2u;
  fd[0] = 92.231; fd[1] = 1.0;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(25) = ((volatile unsigned int *)&fd[2])[0]; SLOT(26) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(27) = ((volatile unsigned int *)&fd[2])[0]; SLOT(28) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(29) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(30) = *(volatile unsigned int *)&fs[2];
  fs[0] = 92.0f;
  F1("fitos", fs[0], fs[2]); SLOT(31) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(32) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(33) = ((volatile unsigned int *)&fd[2])[0]; SLOT(34) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbe", fs[0], fs[1], SLOT(35));
  FSR(SLOT(36));
  a = 1613385874u; b = 3060560755u;
  ST("st", 92, a);
  LD("ldsh", 92, SLOT(37));
  a = 1976265816u; b = 1897293452u;
  IMM("sub", a, 387, SLOT(38));
  a = 3769766731u; b = 1852740844u;
  ST("st", 116, a);
  LD("ldsh", 118, SLOT(39));
  a = 3045364970u; b = 65535u;
  ST("st", 12, a);
  LD("ldsh", 12, SLOT(40));
  a = 0u; b = 4176280393u;
  fs[0] = -88.900f; fs[1] = -0.0f;
  F2("fdivs", fs[0], fs[1], fs[2]); SLOT(41) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(42) = *(volatile unsigned int *)&fs[2];
  F1("fabss", fs[0], fs[2]); SLOT(43) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(44) = ((volatile unsigned int *)&fd[2])[0]; SLOT(45) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(46) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(47));
  a = 733114657u; b = 2147483648u;
  DIV("sdiv", a, b, 2284514796u, SLOT(48));
  a = 3948084963u; b = 2147483647u;
  IMM("andn", a, 3116, SLOT(49));
  a = 2733938901u; b = 2423721343u;
  RR("add", a, b, SLOT(50));
  a = 3257691847u; b = 691449936u;
  RR("orn", a, b, SLOT(51));
  a = 1239936203u; b = 2147483649u;
  SH("sra", a, 9, SLOT(52));
  a = 231609185u; b = 3122633927u;
  TAGGED("taddcc", a, b, SLOT(53), cy); SLOT(54) = cy;
  MULSCC(a, b, 1633132502u, SLOT(55), SLOT(56));
  a = 845294886u; b = 726896391u;
  IMM("orn", a, 3999, SLOT(57));
  a = 2147483647u; b = 632356525u;
  RR("sub", a, b, SLOT(58));
  a = 255u; b = 1108118081u;
  ST("st", 32, a);
  ATOMIC("ldstub", 32, b, SLOT(59));
  LD("ld", 32, SLOT(60));
  a = 0u; b = 3099343969u;
  RR("orn", a, b, SLOT(61));
  a = 3759069875u; b = 653043053u;
  DIV("udiv", a, b, 2592373136u, SLOT(62));
  a = 2744660369u; b = 4294967294u;
  ADD64(a, b, 2593280170u, 65536u, lo, hi); SLOT(63) = lo; SLOT(64) = hi;
  SUB64(a, b, 2863311530u, 113622421u, lo, hi); SLOT(65) = lo; SLOT(66) = hi;
  a = 1431655765u; b = 451811175u;
  DIV("udiv", a, b, 2690292902u, SLOT(67));
  a = 2886381160u; b = 4294967294u;
  fs[0] = -0.0f; fs[1] = -4.336f;
  F2("fdivs", fs[0], fs[1], fs[2]); SLOT(68) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(69) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(70) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(71) = ((volatile unsigned int *)&fd[2])[0]; SLOT(72) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(73) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(74));
  a = 211626192u; b = 819977555u;
  ST("st", 40, a);
  ATOMIC("ldstub", 40, b, SLOT(75));
  LD("ld", 40, SLOT(76));
  a = 4294967294u; b = 2415840570u;
  ST("st", 64, a);
  LD("ldsh", 64, SLOT(77));
  a = 919689004u; b = 4294967295u;
  SH("srl", a, 15, SLOT(78));
  a = 2338196944u; b = 2147483647u;
  SH("sra", a, 37, SLOT(79));
  a = 2776560951u; b = 1431655765u;
  DIV("sdiv", a, b, 1431655765u, SLOT(80));
  a = 4042759634u; b = 2629325475u;
  IMM("or", a, 3842, SLOT(81));
  a = 2067501393u; b = 2147483648u;
  DIV("udiv", a, b, 2219415490u, SLOT(82));
  a = 1288869732u; b = 1610015935u;
  DIV("sdiv", a, b, 1431655765u, SLOT(83));
  a = 2863311530u; b = 4294967295u;
  ADD64(a, b, 1u, 2976748905u, lo, hi); SLOT(84) = lo; SLOT(85) = hi;
  SUB64(a, b, 745997061u, 3956353980u, lo, hi); SLOT(86) = lo; SLOT(87) = hi;
  SLOT(88) = deep(17, 2883959289u);
  SLOT(89) = deep(26, 2863311530u);
  return 0;
}
