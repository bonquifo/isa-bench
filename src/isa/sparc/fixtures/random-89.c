
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
  a = 2909490402u; b = 641703708u;
  RRCC("xor", a, b, c, cy); SLOT(0) = c; SLOT(1) = cy;
  a = 3u; b = 1970892187u;
  RR("and", a, b, SLOT(2));
  a = 3643842309u; b = 1462615983u;
  ST("st", 52, a);
  ATOMIC("ldstub", 52, b, SLOT(3));
  LD("ld", 52, SLOT(4));
  a = 2551269395u; b = 4294967295u;
  DIV("udiv", a, b, 3443818517u, SLOT(5));
  a = 4097516498u; b = 267123130u;
  IMM("and", a, -2343, SLOT(6));
  a = 2094701644u; b = 4154055681u;
  IMM("and", a, -3213, SLOT(7));
  a = 65535u; b = 3896835464u;
  RR("orn", a, b, SLOT(8));
  a = 1451792465u; b = 3041602168u;
  RRCC("xnor", a, b, c, cy); SLOT(9) = c; SLOT(10) = cy;
  a = 317055566u; b = 1486056074u;
  IMM("xor", a, -2008, SLOT(11));
  a = 2452777179u; b = 1431655765u;
  ST("st", 84, a);
  LD("ldsh", 86, SLOT(12));
  a = 2194799868u; b = 2360954935u;
  ST("st", 12, a);
  LD("ld", 12, SLOT(13));
  a = 4294967294u; b = 3u;
  MUL("umul", a, b, lo, hi); SLOT(14) = lo; SLOT(15) = hi;
  a = 1265472741u; b = 1967173589u;
  ST("st", 60, a);
  LD("ldsh", 62, SLOT(16));
  a = 3257132519u; b = 2619311317u;
  RRCC("andn", a, b, c, cy); SLOT(17) = c; SLOT(18) = cy;
  a = 65536u; b = 65535u;
  MUL("umul", a, b, lo, hi); SLOT(19) = lo; SLOT(20) = hi;
  a = 2147483647u; b = 2120623801u;
  RRCC("add", a, b, c, cy); SLOT(21) = c; SLOT(22) = cy;
  a = 3582917429u; b = 3u;
  ANNUL("vc", a, b, SLOT(23));
  ANNUL("vc", a, a, SLOT(24));
  DELAY("vc", a, b, SLOT(25));
  a = 255u; b = 32767u;
  RR("add", a, b, SLOT(26));
  a = 1530534525u; b = 691465429u;
  TAGGED("tsubcc", a, b, SLOT(27), cy); SLOT(28) = cy;
  MULSCC(a, b, 4236717958u, SLOT(29), SLOT(30));
  a = 32767u; b = 2435584125u;
  ADD64(a, b, 3000161453u, 4230862162u, lo, hi); SLOT(31) = lo; SLOT(32) = hi;
  SUB64(a, b, 3718789648u, 2147483649u, lo, hi); SLOT(33) = lo; SLOT(34) = hi;
  a = 952047017u; b = 1u;
  MUL("umul", a, b, lo, hi); SLOT(35) = lo; SLOT(36) = hi;
  a = 3684913113u; b = 3804182189u;
  ANNUL("pos", a, b, SLOT(37));
  ANNUL("pos", a, a, SLOT(38));
  DELAY("pos", a, b, SLOT(39));
  a = 582020290u; b = 2421931528u;
  ANNUL("geu", a, b, SLOT(40));
  ANNUL("geu", a, a, SLOT(41));
  DELAY("geu", a, b, SLOT(42));
  a = 2353660982u; b = 2912889531u;
  ST("st", 56, a);
  ATOMIC("ldstub", 56, b, SLOT(43));
  LD("ld", 56, SLOT(44));
  a = 2818176244u; b = 425853266u;
  ADD64(a, b, 1002835562u, 2815747896u, lo, hi); SLOT(45) = lo; SLOT(46) = hi;
  SUB64(a, b, 2916374065u, 1378963217u, lo, hi); SLOT(47) = lo; SLOT(48) = hi;
  a = 65535u; b = 65535u;
  TAGGED("taddcc", a, b, SLOT(49), cy); SLOT(50) = cy;
  MULSCC(a, b, 2u, SLOT(51), SLOT(52));
  a = 4272241651u; b = 1431655765u;
  TAGGED("taddcc", a, b, SLOT(53), cy); SLOT(54) = cy;
  MULSCC(a, b, 2218228050u, SLOT(55), SLOT(56));
  a = 0u; b = 3852776107u;
  RRCC("xnor", a, b, c, cy); SLOT(57) = c; SLOT(58) = cy;
  a = 2863311530u; b = 249900021u;
  ANNUL("geu", a, b, SLOT(59));
  ANNUL("geu", a, a, SLOT(60));
  DELAY("geu", a, b, SLOT(61));
  a = 2091766286u; b = 115477924u;
  RR("and", a, b, SLOT(62));
  a = 3854999117u; b = 485127533u;
  ST("st", 40, a);
  LD("lduh", 42, SLOT(63));
  a = 69333902u; b = 953198726u;
  SH("sll", a, 39, SLOT(64));
  a = 3871817977u; b = 1822314594u;
  ST("st", 56, a);
  ATOMIC("swap", 56, b, SLOT(65));
  LD("ld", 56, SLOT(66));
  a = 3548204819u; b = 549045811u;
  RR("sub", a, b, SLOT(67));
  a = 2786488374u; b = 1006310578u;
  ST("st", 80, a);
  LD("lduh", 80, SLOT(68));
  a = 240692917u; b = 2u;
  ADD64(a, b, 4294967295u, 954906291u, lo, hi); SLOT(69) = lo; SLOT(70) = hi;
  SUB64(a, b, 0u, 1983137156u, lo, hi); SLOT(71) = lo; SLOT(72) = hi;
  SLOT(73) = deep(14, 3873384789u);
  SLOT(74) = deep(21, 2305632601u);
  return 0;
}
