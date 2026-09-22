
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
#define BUF ((volatile unsigned char *)(isa_dump.scratch + 512))

/* Register to register, no condition register. */
#define RR(insn, a, b, out) do {                                        \
  unsigned long r_, x_ = (a), y_ = (b);                                 \
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "r"(x_), "r"(y_));   \
  (out) = r_; } while (0)

/* The record form, which writes condition-register field zero. That
   field is only reachable through mfcr, so it is read straight back. */
#define RRCC(insn, a, b, out, cr_out) do {                              \
  unsigned long r_, c_, x_ = (a), y_ = (b);                             \
  __asm__ volatile(insn ". %0, %2, %3\n\tmfcr %1"                       \
                   : "=&r"(r_), "=&r"(c_) : "r"(x_), "r"(y_) : "cr0");  \
  (out) = r_; (cr_out) = c_; } while (0)

#define IMM(insn, a, imm, out) do {                                     \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile(insn " %0, %1, " #imm : "=r"(r_) : "r"(x_));         \
  (out) = r_; } while (0)

/*
 * The rotate-and-mask family, which is how this architecture shifts,
 * extracts and inserts, and which is where the mask boundaries are
 * encoded in two pieces with the high bit somewhere unexpected. Each
 * one is generated across the whole range of shift and mask values,
 * because the encoding only goes wrong above 31.
 */
#define RLWINM(a, sh, mb, me, out) do {                                 \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile("rlwinm %0, %1, " #sh ", " #mb ", " #me              \
                   : "=r"(r_) : "r"(x_));                               \
  (out) = r_; } while (0)

#define RLWIMI(a, b, sh, mb, me, out) do {                              \
  unsigned long r_ = (b), x_ = (a);                                     \
  __asm__ volatile("rlwimi %0, %1, " #sh ", " #mb ", " #me              \
                   : "+r"(r_) : "r"(x_));                               \
  (out) = r_; } while (0)

#define RLDICL(a, sh, mb, out) do {                                     \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile("rldicl %0, %1, " #sh ", " #mb : "=r"(r_) : "r"(x_)); \
  (out) = r_; } while (0)

#define RLDICR(a, sh, me, out) do {                                     \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile("rldicr %0, %1, " #sh ", " #me : "=r"(r_) : "r"(x_)); \
  (out) = r_; } while (0)

#define RLDIC(a, sh, mb, out) do {                                      \
  unsigned long r_, x_ = (a);                                           \
  __asm__ volatile("rldic %0, %1, " #sh ", " #mb : "=r"(r_) : "r"(x_)); \
  (out) = r_; } while (0)

#define RLDIMI(a, b, sh, mb, out) do {                                  \
  unsigned long r_ = (b), x_ = (a);                                     \
  __asm__ volatile("rldimi %0, %1, " #sh ", " #mb : "+r"(r_) : "r"(x_)); \
  (out) = r_; } while (0)

/*
 * A 128-bit add and subtract out of two 64-bit ones.
 *
 * Carry is a register here rather than a flag, written by `addc` and
 * both read and written by `adde`, so this is a chain through one
 * resource. An implementation that set carry on every add would give
 * the right answer for this and the wrong dependences.
 */
#define ADD128(alo, ahi, blo, bhi, lo_out, hi_out) do {                 \
  unsigned long l_, h_, al_ = (alo), ah_ = (ahi), bl_ = (blo), bh_ = (bhi); \
  __asm__ volatile("addc %0, %2, %4\n\tadde %1, %3, %5"                 \
                   : "=&r"(l_), "=&r"(h_)                               \
                   : "r"(al_), "r"(ah_), "r"(bl_), "r"(bh_) : "xer");   \
  (lo_out) = l_; (hi_out) = h_; } while (0)

#define SUB128(alo, ahi, blo, bhi, lo_out, hi_out) do {                 \
  unsigned long l_, h_, al_ = (alo), ah_ = (ahi), bl_ = (blo), bh_ = (bhi); \
  __asm__ volatile("subfc %0, %4, %2\n\tsubfe %1, %5, %3"               \
                   : "=&r"(l_), "=&r"(h_)                               \
                   : "r"(al_), "r"(ah_), "r"(bl_), "r"(bh_) : "xer");   \
  (lo_out) = l_; (hi_out) = h_; } while (0)

/* The carry-extending forms that take their second operand from carry
   alone, which is how a comparison becomes a zero-or-one. */
#define CARRYEXT(insn, a, seed, out) do {                               \
  unsigned long r_, x_ = (a), s_ = (seed);                              \
  __asm__ volatile("addic %%r0, %2, 0\n\taddc %%r0, %%r0, %2\n\t"       \
                   insn " %0, %1"                                       \
                   : "=&r"(r_) : "r"(x_), "r"(s_) : "r0", "xer");       \
  (out) = r_; } while (0)

/*
 * Two comparisons into two different condition-register fields, then a
 * logical operation between single bits of them.
 *
 * This is the shape the eight-field design exists for: neither compare
 * waits for the other. An implementation with one condition register
 * would compute the same answer through a false dependence.
 */
#define CRLOGIC(insn, a, b, c, d, out) do {                             \
  unsigned long r_, w_ = (a), x_ = (b), y_ = (c), z_ = (d);             \
  __asm__ volatile("cmpd 0, %1, %2\n\tcmpd 1, %3, %4\n\t"               \
                   insn " 8, 0, 4\n\tmfcr %0"                           \
                   : "=&r"(r_) : "r"(w_), "r"(x_), "r"(y_), "r"(z_)     \
                   : "cr0", "cr1", "cr2");                              \
  (out) = r_; } while (0)

/* Select without branching, on a bit of a field the compare just set. */
#define ISEL(a, b, c, d, out) do {                                      \
  unsigned long r_, w_ = (a), x_ = (b), y_ = (c), z_ = (d);             \
  __asm__ volatile("cmpld 3, %1, %2\n\tisel %0, %3, %4, 12"             \
                   : "=&r"(r_) : "r"(w_), "r"(x_), "r"(y_), "r"(z_)     \
                   : "cr3");                                            \
  (out) = r_; } while (0)

/* The counter register, which a loop counts down without touching a
   general register or a condition. */
#define COUNTED(n, a, out) do {                                         \
  unsigned long r_ = 0, x_ = (a), c_ = (n);                             \
  __asm__ volatile("mtctr %2\n\t"                                       \
                   "1:\n\tadd %0, %0, %1\n\tbdnz 1b"                    \
                   : "+r"(r_) : "r"(x_), "r"(c_) : "ctr");              \
  (out) = r_; } while (0)

/*
 * The base register of an address is constrained to "b" rather than
 * "r", and that is not a stylistic choice.
 *
 * In the displacement forms, a base of r0 means the literal zero rather
 * than the contents of r0. So if the compiler happens to allocate the
 * pointer into r0, the address becomes the displacement alone and the
 * access goes to the bottom of memory. That is exactly what happened
 * here, and it is the same architectural rule the interpreter
 * implements -- found from the other side.
 */
#define ST(insn, off, a) do {                                           \
  unsigned long x_ = (a);                                               \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " %0, 0(%1)" :: "r"(x_), "b"(p_) : "memory");   \
} while (0)

#define LD(insn, off, out) do {                                         \
  unsigned long r_;                                                     \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " %0, 0(%1)" : "=r"(r_) : "b"(p_) : "memory");  \
  (out) = r_; } while (0)

/* The byte-reversing pair, which matter more here than elsewhere
   because this is a little-endian machine with a big-endian heritage
   and the compiler reaches for them on any network-order field.
   Both are indexed forms: they take two registers rather than a
   displacement, and a zero in the first means no base at all. */
#define BREV(sti, ldi, off, a, out) do {                                \
  unsigned long r_, x_ = (a);                                           \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(sti " %1, 0, %2\n\t" ldi " %0, 0, %2"                \
                   : "=&r"(r_) : "r"(x_), "r"(p_) : "memory");          \
  (out) = r_; } while (0)

/*
 * Double-precision arithmetic, which at -O2 for this target is the
 * vector unit operating on one element. The operands travel through
 * memory rather than through constraints so that the instruction
 * reaching the assembler is the one named here.
 */
#define F2(insn, x, y, out) do {                                        \
  __asm__ volatile("lfd 0, %1\n\tlfd 1, %2\n\t"                         \
                   insn " 2, 0, 1\n\tstfd 2, %0"                        \
                   : "=m"(out) : "m"(x), "m"(y) : "f0", "f1", "f2");    \
} while (0)

#define F1(insn, x, out) do {                                           \
  __asm__ volatile("lfd 0, %1\n\t" insn " 2, 0\n\tstfd 2, %0"           \
                   : "=m"(out) : "m"(x) : "f0", "f2");                  \
} while (0)

/* Fused multiply-add, which rounds once. Computing it as a multiply
   and then an add rounds twice and differs in the last bit. */
#define FMA(insn, x, y, z, out) do {                                    \
  __asm__ volatile("lfd 0, %1\n\tlfd 1, %2\n\tlfd 2, %3\n\t"            \
                   insn " 2, 0, 1, 2\n\tstfd 2, %0"                     \
                   : "=m"(out) : "m"(x), "m"(y), "m"(z)                 \
                   : "f0", "f1", "f2");                                 \
} while (0)

/* A floating-point comparison writes a condition-register field, which
   only mfcr can read back. */
#define FCMP(x, y, out) do {                                            \
  unsigned long r_;                                                     \
  __asm__ volatile("lfd 0, %1\n\tlfd 1, %2\n\tfcmpu 5, 0, 1\n\tmfcr %0" \
                   : "=r"(r_) : "m"(x), "m"(y) : "f0", "f1", "cr5");    \
  (out) = r_; } while (0)

/*
 * Recursion, so the call and return paths run through the link
 * register rather than only falling through.
 */
__attribute__((noinline)) static unsigned long deep(unsigned long n, unsigned long acc) {
  if (n == 0) return acc;
  unsigned long a = acc ^ (n * 2654435761UL);
  return deep(n - 1, a + n) ^ (a >> 3) ^ (n << 8);
}

long kernel(void) {
  unsigned long a, b, lo, hi, c;
  volatile double fx, fy, fz, fr;
  a = 10456440401086343000UL; b = 12297829382473034410UL;
  RR("mulhd", a, b, SLOT(0));
  a = 5971271600019788498UL; b = 4294967295UL;
  fx = -316.966000; fy = 883.427000; fz = 744.409000;
  F2("fadd", fx, fy, fr); SLOT(1) = *(volatile unsigned long *)&fr;
  F1("fsqrt", fx, fr); SLOT(2) = *(volatile unsigned long *)&fr;
  FMA("fmadd", fx, fy, fz, fr); SLOT(3) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(4));
  a = 5634995493139829429UL; b = 6148914691236517205UL;
  ST("std", 16, a);
  LD("lwz", 16, SLOT(5));
  BREV("stdbrx", "ldbrx", 16, b, SLOT(6));
  BREV("stwbrx", "lwbrx", 16, b, SLOT(7));
  a = 13687716459952709704UL; b = 4294967295UL;
  RR("divwu", a, b, SLOT(8));
  a = 18152340023272015320UL; b = 6148914691236517205UL;
  COUNTED(3, a, SLOT(9));
  a = 18446744073709551615UL; b = 12632036066210710012UL;
  IMM("addi", a, 3214, SLOT(10));
  IMM("addic", a, -9054, SLOT(11));
  IMM("mulli", a, 30381, SLOT(12));
  IMM("subfic", a, 3119, SLOT(13));
  a = 0UL; b = 18446744073709551615UL;
  CRLOGIC("crand", a, b, 7498473194938378775UL, 5746739863966505679UL, SLOT(14));
  ISEL(a, b, 15769283472454696547UL, 2UL, SLOT(15));
  a = 3494487608246063683UL; b = 10822172108100859118UL;
  RR("divwu", a, b, SLOT(16));
  a = 13408867893767721106UL; b = 2454211081261577075UL;
  RLWINM(a, 31, 15, 25, SLOT(17));
  RLWIMI(a, b, 31, 15, 25, SLOT(18));
  RLDICL(a, 31, 15, SLOT(19));
  RLDICR(a, 31, 25, SLOT(20));
  RLDIC(a, 31, 15, SLOT(21));
  RLDIMI(a, b, 31, 15, SLOT(22));
  a = 16679523676588829784UL; b = 12159051317361665676UL;
  IMM("addi", a, -11987, SLOT(23));
  IMM("addic", a, 20566, SLOT(24));
  IMM("mulli", a, 27234, SLOT(25));
  IMM("subfic", a, -32281, SLOT(26));
  a = 15525180537683481836UL; b = 1784506924896616052UL;
  ADD128(a, b, 6830472673411370663UL, 9289160903542508620UL, lo, hi); SLOT(27) = lo; SLOT(28) = hi;
  SUB128(a, b, 2147483648UL, 12297829382473034410UL, lo, hi); SLOT(29) = lo; SLOT(30) = hi;
  CARRYEXT("addze", a, b, SLOT(31));
  a = 0UL; b = 2416579150160395081UL;
  ST("std", 32, a);
  LD("lwa", 32, SLOT(32));
  BREV("stdbrx", "ldbrx", 32, b, SLOT(33));
  BREV("stwbrx", "lwbrx", 32, b, SLOT(34));
  a = 7820983198191255385UL; b = 10001639130194756177UL;
  ADD128(a, b, 3653754402271580704UL, 17836762435772285908UL, lo, hi); SLOT(35) = lo; SLOT(36) = hi;
  SUB128(a, b, 12297829382473034410UL, 256UL, lo, hi); SLOT(37) = lo; SLOT(38) = hi;
  CARRYEXT("subfme", a, b, SLOT(39));
  a = 9223372036854775807UL; b = 9223372036854775808UL;
  ADD128(a, b, 12399062148057438421UL, 6267045207904554367UL, lo, hi); SLOT(40) = lo; SLOT(41) = hi;
  SUB128(a, b, 525260561511766360UL, 590446796869496519UL, lo, hi); SLOT(42) = lo; SLOT(43) = hi;
  CARRYEXT("addme", a, b, SLOT(44));
  a = 256UL; b = 14482037889326571717UL;
  RRCC("andc", a, b, SLOT(45), c); SLOT(46) = c;
  a = 16592507534159913411UL; b = 3338960090568524809UL;
  fx = 4503599627370497.0; fy = 729.735000; fz = 0.0;
  F2("fmul", fx, fy, fr); SLOT(47) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(48) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(49) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(50));
  a = 9316189411703931379UL; b = 13102727115226643858UL;
  RR("divwu", a, b, SLOT(51));
  a = 255UL; b = 6832848085510594888UL;
  RRCC("nor", a, b, SLOT(52), c); SLOT(53) = c;
  a = 14217335527024230193UL; b = 4597676677205655079UL;
  ST("std", 48, a);
  LD("ld", 48, SLOT(54));
  BREV("stdbrx", "ldbrx", 48, b, SLOT(55));
  BREV("stwbrx", "lwbrx", 48, b, SLOT(56));
  a = 2UL; b = 18006814582559214477UL;
  RR("orc", a, b, SLOT(57));
  a = 9168636372172533031UL; b = 13079167506627194368UL;
  RRCC("subf", a, b, SLOT(58), c); SLOT(59) = c;
  a = 12297829382473034410UL; b = 16477521905078237228UL;
  IMM("addi", a, 21112, SLOT(60));
  IMM("addic", a, -10089, SLOT(61));
  IMM("mulli", a, -25185, SLOT(62));
  IMM("subfic", a, -31739, SLOT(63));
  a = 12151349451771584404UL; b = 4953668591599352639UL;
  RRCC("andc", a, b, SLOT(64), c); SLOT(65) = c;
  a = 2UL; b = 3848437607214603500UL;
  IMM("addi", a, 32662, SLOT(66));
  IMM("addic", a, 15687, SLOT(67));
  IMM("mulli", a, 22476, SLOT(68));
  IMM("subfic", a, -10171, SLOT(69));
  a = 18446744073709551614UL; b = 3700906291257682401UL;
  fx = -232.465000; fy = 1.0; fz = -661.904000;
  F2("fdiv", fx, fy, fr); SLOT(70) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(71) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(72) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(73));
  a = 0UL; b = 4159356343124985986UL;
  ADD128(a, b, 3745126870437649729UL, 11117210326414301088UL, lo, hi); SLOT(74) = lo; SLOT(75) = hi;
  SUB128(a, b, 5968896402142615340UL, 18446744073709551615UL, lo, hi); SLOT(76) = lo; SLOT(77) = hi;
  CARRYEXT("addze", a, b, SLOT(78));
  a = 7174890056300354375UL; b = 7214469548267670992UL;
  RR("nor", a, b, SLOT(79));
  a = 15360268276688937323UL; b = 6605465064990264587UL;
  ST("std", 40, a);
  LD("lha", 40, SLOT(80));
  BREV("stdbrx", "ldbrx", 40, b, SLOT(81));
  BREV("stwbrx", "lwbrx", 40, b, SLOT(82));
  a = 10595942995722002038UL; b = 6148914691236517205UL;
  RR("mulhdu", a, b, SLOT(83));
  a = 4715807365612237065UL; b = 13713144908030027726UL;
  CRLOGIC("cror", a, b, 9223372036854775808UL, 7472939015116683837UL, SLOT(84));
  ISEL(a, b, 12738163774205827010UL, 2507881811159455588UL, SLOT(85));
  a = 15173422849042343103UL; b = 10993708812775258204UL;
  COUNTED(1, a, SLOT(86));
  a = 12297829382473034410UL; b = 18446744073709551615UL;
  RRCC("nor", a, b, SLOT(87), c); SLOT(88) = c;
  a = 18369758562342801459UL; b = 14644035816326057777UL;
  ST("std", 0, a);
  LD("lwa", 0, SLOT(89));
  BREV("stdbrx", "ldbrx", 0, b, SLOT(90));
  BREV("stwbrx", "lwbrx", 0, b, SLOT(91));
  a = 12372709778941411443UL; b = 6449816585048134590UL;
  ADD128(a, b, 16048335016902361697UL, 13808073064106447829UL, lo, hi); SLOT(92) = lo; SLOT(93) = hi;
  SUB128(a, b, 9223372036854775809UL, 3388033432668919921UL, lo, hi); SLOT(94) = lo; SLOT(95) = hi;
  CARRYEXT("subfme", a, b, SLOT(96));
  a = 255UL; b = 7696368920166288518UL;
  RLWINM(a, 25, 24, 4, SLOT(97));
  RLWIMI(a, b, 25, 24, 4, SLOT(98));
  RLDICL(a, 25, 24, SLOT(99));
  RLDICR(a, 25, 4, SLOT(100));
  RLDIC(a, 25, 24, SLOT(101));
  RLDIMI(a, b, 25, 24, SLOT(102));
  a = 3150057128111637865UL; b = 1370875044591077121UL;
  fx = -0.0; fy = -700.737000; fz = 1.0;
  F2("fdiv", fx, fy, fr); SLOT(103) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(104) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(105) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(106));
  a = 2385562200126302527UL; b = 11171561701178517297UL;
  ST("std", 48, a);
  LD("lbz", 48, SLOT(107));
  BREV("stdbrx", "ldbrx", 48, b, SLOT(108));
  BREV("stwbrx", "lwbrx", 48, b, SLOT(109));
  a = 14110150147089078969UL; b = 12297829382473034410UL;
  RR("slw", a, b, SLOT(110));
  a = 3754912495245957353UL; b = 13092869110076860977UL;
  RR("and", a, b, SLOT(111));
  a = 10858128000020031453UL; b = 4294967296UL;
  ADD128(a, b, 18005777659351097795UL, 5127436857791380689UL, lo, hi); SLOT(112) = lo; SLOT(113) = hi;
  SUB128(a, b, 14306640765312009412UL, 2147483647UL, lo, hi); SLOT(114) = lo; SLOT(115) = hi;
  CARRYEXT("subfme", a, b, SLOT(116));
  SLOT(117) = deep(15, 12713477835462554168UL);
  return 0;
}
