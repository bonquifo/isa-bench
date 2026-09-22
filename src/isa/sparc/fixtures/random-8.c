
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
  a = 364134147u; b = 2147483648u;
  fs[0] = 0.0f; fs[1] = 0.0f;
  F2("fmuls", fs[0], fs[1], fs[2]); SLOT(0) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(1) = *(volatile unsigned int *)&fs[2];
  F1("fabss", fs[0], fs[2]); SLOT(2) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(3) = ((volatile unsigned int *)&fd[2])[0]; SLOT(4) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(5) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(6));
  a = 429426524u; b = 3434404697u;
  RRCC("xor", a, b, c, cy); SLOT(7) = c; SLOT(8) = cy;
  a = 690008385u; b = 1935108195u;
  ST("st", 96, a);
  LD("lduh", 96, SLOT(9));
  a = 2147483649u; b = 4294967294u;
  ADD64(a, b, 0u, 3725999877u, lo, hi); SLOT(10) = lo; SLOT(11) = hi;
  SUB64(a, b, 2147483648u, 550457252u, lo, hi); SLOT(12) = lo; SLOT(13) = hi;
  a = 384673957u; b = 3683316523u;
  IMM("xnor", a, 2117, SLOT(14));
  a = 139506719u; b = 2049385348u;
  RR("orn", a, b, SLOT(15));
  a = 2147483649u; b = 621380657u;
  IMM("andn", a, 446, SLOT(16));
  a = 3321521619u; b = 1820496611u;
  ANNUL("e", a, b, SLOT(17));
  ANNUL("e", a, a, SLOT(18));
  DELAY("e", a, b, SLOT(19));
  a = 2008229015u; b = 3777739839u;
  MUL("smul", a, b, lo, hi); SLOT(20) = lo; SLOT(21) = hi;
  a = 2147483647u; b = 4154073132u;
  MUL("umul", a, b, lo, hi); SLOT(22) = lo; SLOT(23) = hi;
  a = 1405111737u; b = 65536u;
  fd[0] = 0.0; fd[1] = 61.534;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(24) = ((volatile unsigned int *)&fd[2])[0]; SLOT(25) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(26) = ((volatile unsigned int *)&fd[2])[0]; SLOT(27) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(28) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(29) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(30) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(31) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(32) = ((volatile unsigned int *)&fd[2])[0]; SLOT(33) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbne", fs[0], fs[1], SLOT(34));
  FSR(SLOT(35));
  a = 386727242u; b = 2355020532u;
  ANNUL("ge", a, b, SLOT(36));
  ANNUL("ge", a, a, SLOT(37));
  DELAY("ge", a, b, SLOT(38));
  a = 3789402278u; b = 1705568645u;
  RRCC("sub", a, b, c, cy); SLOT(39) = c; SLOT(40) = cy;
  a = 3056973871u; b = 3855637801u;
  fd[0] = -3.831; fd[1] = 0.0;
  D2("fsubd", fd[0], fd[1], fd[2]); SLOT(41) = ((volatile unsigned int *)&fd[2])[0]; SLOT(42) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(43) = ((volatile unsigned int *)&fd[2])[0]; SLOT(44) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(45) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(46) = *(volatile unsigned int *)&fs[2];
  fs[0] = -3.0f;
  F1("fitos", fs[0], fs[2]); SLOT(47) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(48) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(49) = ((volatile unsigned int *)&fd[2])[0]; SLOT(50) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbue", fs[0], fs[1], SLOT(51));
  FSR(SLOT(52));
  a = 2510349046u; b = 1431655765u;
  ST("st", 92, a);
  LD("ld", 92, SLOT(53));
  a = 2026196705u; b = 1935367353u;
  ST("st", 60, a);
  ATOMIC("ldstub", 60, b, SLOT(54));
  LD("ld", 60, SLOT(55));
  a = 950743367u; b = 1476967651u;
  MUL("smul", a, b, lo, hi); SLOT(56) = lo; SLOT(57) = hi;
  a = 4196134004u; b = 2147483649u;
  MUL("smul", a, b, lo, hi); SLOT(58) = lo; SLOT(59) = hi;
  a = 97160850u; b = 3124053058u;
  TAGGED("taddcc", a, b, SLOT(60), cy); SLOT(61) = cy;
  MULSCC(a, b, 65536u, SLOT(62), SLOT(63));
  a = 1888364389u; b = 4286876753u;
  RR("orn", a, b, SLOT(64));
  a = 2971343418u; b = 1651904451u;
  RR("sub", a, b, SLOT(65));
  a = 32767u; b = 1867743260u;
  ANNUL("l", a, b, SLOT(66));
  ANNUL("l", a, a, SLOT(67));
  DELAY("l", a, b, SLOT(68));
  a = 198599971u; b = 3u;
  TAGGED("taddcc", a, b, SLOT(69), cy); SLOT(70) = cy;
  MULSCC(a, b, 1201360164u, SLOT(71), SLOT(72));
  a = 4294967295u; b = 3792590360u;
  fd[0] = -0.0; fd[1] = 0.0;
  D2("fmuld", fd[0], fd[1], fd[2]); SLOT(73) = ((volatile unsigned int *)&fd[2])[0]; SLOT(74) = ((volatile unsigned int *)&fd[2])[1];
  D1("fsqrtd", fd[0], fd[2]); SLOT(75) = ((volatile unsigned int *)&fd[2])[0]; SLOT(76) = ((volatile unsigned int *)&fd[2])[1];
  FNARROW("fdtos", fd[0], fs[2]); SLOT(77) = *(volatile unsigned int *)&fs[2];
  FNARROW("fdtoi", fd[0], fs[2]); SLOT(78) = *(volatile unsigned int *)&fs[2];
  fs[0] = 0.0f;
  F1("fitos", fs[0], fs[2]); SLOT(79) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fitod", fs[0], fd[2]); SLOT(80) = ((volatile unsigned int *)&fd[2])[0];
  F2("fsmuld", fs[0], fs[1], fd[2]); SLOT(81) = ((volatile unsigned int *)&fd[2])[0]; SLOT(82) = ((volatile unsigned int *)&fd[2])[1];
  FCMP("fcmps", "fbug", fs[0], fs[1], SLOT(83));
  FSR(SLOT(84));
  a = 4294967294u; b = 2532510495u;
  ST("st", 52, a);
  ATOMIC("ldstub", 52, b, SLOT(85));
  LD("ld", 52, SLOT(86));
  a = 1963967931u; b = 2147483649u;
  fs[0] = -58.728f; fs[1] = 17.385f;
  F2("fdivs", fs[0], fs[1], fs[2]); SLOT(87) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(88) = *(volatile unsigned int *)&fs[2];
  F1("fnegs", fs[0], fs[2]); SLOT(89) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(90) = ((volatile unsigned int *)&fd[2])[0]; SLOT(91) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(92) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(93));
  a = 3589569237u; b = 3462976838u;
  SH("srl", a, 14, SLOT(94));
  a = 3740611512u; b = 4065619821u;
  fs[0] = 14.255f; fs[1] = 39.838f;
  F2("fdivs", fs[0], fs[1], fs[2]); SLOT(95) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(96) = *(volatile unsigned int *)&fs[2];
  F1("fmovs", fs[0], fs[2]); SLOT(97) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(98) = ((volatile unsigned int *)&fd[2])[0]; SLOT(99) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(100) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(101));
  a = 2566903022u; b = 2147483648u;
  fs[0] = -80.488f; fs[1] = -99.639f;
  F2("fadds", fs[0], fs[1], fs[2]); SLOT(102) = *(volatile unsigned int *)&fs[2];
  F1("fsqrts", fs[0], fs[2]); SLOT(103) = *(volatile unsigned int *)&fs[2];
  F1("fabss", fs[0], fs[2]); SLOT(104) = *(volatile unsigned int *)&fs[2];
  FWIDEN("fstod", fs[0], fd[2]); SLOT(105) = ((volatile unsigned int *)&fd[2])[0]; SLOT(106) = ((volatile unsigned int *)&fd[2])[1];
  F1("fstoi", fs[0], fs[2]); SLOT(107) = *(volatile unsigned int *)&fs[2];
  FSR(SLOT(108));
  a = 3758249185u; b = 3154029627u;
  RR("xor", a, b, SLOT(109));
  a = 1u; b = 1169519595u;
  TAGGED("tsubcc", a, b, SLOT(110), cy); SLOT(111) = cy;
  MULSCC(a, b, 4012091570u, SLOT(112), SLOT(113));
  a = 273340053u; b = 1105363420u;
  RRCC("xor", a, b, c, cy); SLOT(114) = c; SLOT(115) = cy;
  a = 0u; b = 0u;
  ADD64(a, b, 3146642552u, 3281517080u, lo, hi); SLOT(116) = lo; SLOT(117) = hi;
  SUB64(a, b, 3026026041u, 1u, lo, hi); SLOT(118) = lo; SLOT(119) = hi;
  a = 2u; b = 1644419534u;
  IMM("orn", a, 2706, SLOT(120));
  a = 3600510912u; b = 452004851u;
  SH("sra", a, 33, SLOT(121));
  a = 348246784u; b = 4294967294u;
  ADD64(a, b, 0u, 65536u, lo, hi); SLOT(122) = lo; SLOT(123) = hi;
  SUB64(a, b, 964760420u, 2418514591u, lo, hi); SLOT(124) = lo; SLOT(125) = hi;
  SLOT(126) = deep(17, 2540501185u);
  SLOT(127) = deep(23, 544869737u);
  return 0;
}
