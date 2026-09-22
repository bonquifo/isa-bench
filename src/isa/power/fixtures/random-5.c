
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
  a = 10550849754657046686UL; b = 5570163026343456995UL;
  COUNTED(4, a, SLOT(0));
  a = 18446744073709551614UL; b = 17142555751434915081UL;
  RRCC("subf", a, b, SLOT(1), c); SLOT(2) = c;
  a = 1555575131109056995UL; b = 2017195803301179864UL;
  ST("std", 0, a);
  LD("lha", 0, SLOT(3));
  BREV("stdbrx", "ldbrx", 0, b, SLOT(4));
  BREV("stwbrx", "lwbrx", 0, b, SLOT(5));
  a = 5203585713719332582UL; b = 18446744073709551614UL;
  COUNTED(5, a, SLOT(6));
  a = 12766595726851163640UL; b = 14575846528674510696UL;
  RR("nand", a, b, SLOT(7));
  a = 2982122356242246805UL; b = 12161907451561171295UL;
  RRCC("orc", a, b, SLOT(8), c); SLOT(9) = c;
  a = 9223372036854775807UL; b = 7135269142160010445UL;
  RR("nor", a, b, SLOT(10));
  a = 1078213160257782353UL; b = 5502239404912066910UL;
  ST("std", 56, a);
  LD("lha", 56, SLOT(11));
  BREV("stdbrx", "ldbrx", 56, b, SLOT(12));
  BREV("stwbrx", "lwbrx", 56, b, SLOT(13));
  a = 4123417397416960093UL; b = 16098466331370273086UL;
  fx = -0.0; fy = -576.742000; fz = -460.295000;
  F2("fadd", fx, fy, fr); SLOT(14) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(15) = *(volatile unsigned long *)&fr;
  FMA("fmsub", fx, fy, fz, fr); SLOT(16) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(17));
  a = 255UL; b = 17706386040322508369UL;
  RLWINM(a, 8, 24, 24, SLOT(18));
  RLWIMI(a, b, 8, 24, 24, SLOT(19));
  RLDICL(a, 8, 24, SLOT(20));
  RLDICR(a, 8, 56, SLOT(21));
  RLDIC(a, 8, 24, SLOT(22));
  RLDIMI(a, b, 8, 24, SLOT(23));
  a = 1625863021708458045UL; b = 9288922708882017920UL;
  RLWINM(a, 13, 5, 7, SLOT(24));
  RLWIMI(a, b, 13, 5, 7, SLOT(25));
  RLDICL(a, 45, 37, SLOT(26));
  RLDICR(a, 45, 7, SLOT(27));
  RLDIC(a, 45, 18, SLOT(28));
  RLDIMI(a, b, 45, 18, SLOT(29));
  a = 1158552378581796212UL; b = 14164020181715508469UL;
  RR("andc", a, b, SLOT(30));
  a = 12196235819911868145UL; b = 10284949610907948277UL;
  fx = -0.0; fy = 4503599627370497.0; fz = 566.575000;
  F2("fadd", fx, fy, fr); SLOT(31) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(32) = *(volatile unsigned long *)&fr;
  FMA("fmsub", fx, fy, fz, fr); SLOT(33) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(34));
  a = 2UL; b = 4294967296UL;
  COUNTED(8, a, SLOT(35));
  a = 5566336418201290304UL; b = 18132755178183840912UL;
  CRLOGIC("creqv", a, b, 17156657250699762160UL, 17898366859761892250UL, SLOT(36));
  ISEL(a, b, 17075468089343706994UL, 18050463215826105016UL, SLOT(37));
  a = 18446744073709551614UL; b = 6450544964531950527UL;
  RR("sld", a, b, SLOT(38));
  a = 12072792538851996678UL; b = 13895508526724685442UL;
  RRCC("subf", a, b, SLOT(39), c); SLOT(40) = c;
  a = 255UL; b = 15424652777218885898UL;
  ADD128(a, b, 12720038803547904876UL, 457523914385407591UL, lo, hi); SLOT(41) = lo; SLOT(42) = hi;
  SUB128(a, b, 4294967296UL, 6277822028759211107UL, lo, hi); SLOT(43) = lo; SLOT(44) = hi;
  CARRYEXT("addme", a, b, SLOT(45));
  a = 4294967295UL; b = 15912349552151818233UL;
  RR("mulhw", a, b, SLOT(46));
  a = 995081554427423085UL; b = 283554090371775962UL;
  fx = -156.729000; fy = 4503599627370497.0; fz = 787.958000;
  F2("fsub", fx, fy, fr); SLOT(47) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(48) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(49) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(50));
  a = 658732062960063369UL; b = 4935461104316016570UL;
  RR("nand", a, b, SLOT(51));
  a = 1925477083508986449UL; b = 6148914691236517205UL;
  RR("xor", a, b, SLOT(52));
  a = 11073774066101979316UL; b = 2147483647UL;
  COUNTED(4, a, SLOT(53));
  a = 5651116459097692064UL; b = 9223372036854775808UL;
  fx = -222.832000; fy = 0.0; fz = -174.282000;
  F2("fadd", fx, fy, fr); SLOT(54) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(55) = *(volatile unsigned long *)&fr;
  FMA("fmadd", fx, fy, fz, fr); SLOT(56) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(57));
  a = 4825992268886679492UL; b = 5964906597111332456UL;
  RRCC("nor", a, b, SLOT(58), c); SLOT(59) = c;
  a = 6526514621480494727UL; b = 5996552184221231513UL;
  RLWINM(a, 5, 12, 13, SLOT(60));
  RLWIMI(a, b, 5, 12, 13, SLOT(61));
  RLDICL(a, 5, 44, SLOT(62));
  RLDICR(a, 5, 45, SLOT(63));
  RLDIC(a, 5, 44, SLOT(64));
  RLDIMI(a, b, 5, 44, SLOT(65));
  a = 2147483648UL; b = 18446744073709551615UL;
  COUNTED(2, a, SLOT(66));
  a = 5898828305930041565UL; b = 16557866427990126212UL;
  ADD128(a, b, 4294967295UL, 6119800372057191551UL, lo, hi); SLOT(67) = lo; SLOT(68) = hi;
  SUB128(a, b, 17011076889219845717UL, 2147483647UL, lo, hi); SLOT(69) = lo; SLOT(70) = hi;
  CARRYEXT("subfme", a, b, SLOT(71));
  a = 17082833398875988069UL; b = 5620161141899098571UL;
  IMM("addi", a, -28040, SLOT(72));
  IMM("addic", a, -2980, SLOT(73));
  IMM("mulli", a, -218, SLOT(74));
  IMM("subfic", a, 3972, SLOT(75));
  a = 6533734432643082858UL; b = 6973365818650906948UL;
  IMM("addi", a, 27758, SLOT(76));
  IMM("addic", a, 28192, SLOT(77));
  IMM("mulli", a, 23680, SLOT(78));
  IMM("subfic", a, -3909, SLOT(79));
  a = 9223372036854775807UL; b = 16021831684944849905UL;
  RR("and", a, b, SLOT(80));
  a = 4717375932673188466UL; b = 866743924751027842UL;
  ADD128(a, b, 5476378127104160373UL, 9223372036854775809UL, lo, hi); SLOT(81) = lo; SLOT(82) = hi;
  SUB128(a, b, 1872224938729287362UL, 2881358435860599594UL, lo, hi); SLOT(83) = lo; SLOT(84) = hi;
  CARRYEXT("subfze", a, b, SLOT(85));
  a = 5090488597960977568UL; b = 9223372036854775807UL;
  RRCC("or", a, b, SLOT(86), c); SLOT(87) = c;
  a = 12740021762278957520UL; b = 11256767802252219678UL;
  fx = 1.0; fy = 387.282000; fz = -724.229000;
  F2("fadd", fx, fy, fr); SLOT(88) = *(volatile unsigned long *)&fr;
  F1("fsqrt", fx, fr); SLOT(89) = *(volatile unsigned long *)&fr;
  FMA("fmsub", fx, fy, fz, fr); SLOT(90) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(91));
  a = 256UL; b = 12610759032784997669UL;
  CRLOGIC("crnand", a, b, 10190323098862951740UL, 18446744073709551614UL, SLOT(92));
  ISEL(a, b, 256UL, 14049457388504732137UL, SLOT(93));
  a = 255UL; b = 18446744073709551614UL;
  ST("std", 32, a);
  LD("lwz", 32, SLOT(94));
  BREV("stdbrx", "ldbrx", 32, b, SLOT(95));
  BREV("stwbrx", "lwbrx", 32, b, SLOT(96));
  a = 2733831765663987896UL; b = 10896247480184858053UL;
  fx = 136.825000; fy = -0.0; fz = 0.0;
  F2("fadd", fx, fy, fr); SLOT(97) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(98) = *(volatile unsigned long *)&fr;
  FMA("fmadd", fx, fy, fz, fr); SLOT(99) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(100));
  a = 4294967295UL; b = 13594362939234653791UL;
  CRLOGIC("crnand", a, b, 2136471855571261065UL, 13995581184720088979UL, SLOT(101));
  ISEL(a, b, 16384341272234075365UL, 3430370291634500227UL, SLOT(102));
  a = 607044093017630877UL; b = 2637692277878202098UL;
  ADD128(a, b, 6119852503493867390UL, 712526768377285173UL, lo, hi); SLOT(103) = lo; SLOT(104) = hi;
  SUB128(a, b, 7845233137599131133UL, 12770616718750231403UL, lo, hi); SLOT(105) = lo; SLOT(106) = hi;
  CARRYEXT("subfze", a, b, SLOT(107));
  a = 213524576914532381UL; b = 17914100847353707478UL;
  CRLOGIC("crxor", a, b, 14034960231747052084UL, 889006586987150736UL, SLOT(108));
  ISEL(a, b, 0UL, 5453307610467413324UL, SLOT(109));
  SLOT(110) = deep(13, 14696656766653540626UL);
  return 0;
}
