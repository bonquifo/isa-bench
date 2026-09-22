
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
  a = 4546756464157276651UL; b = 255UL;
  RR("subf", a, b, SLOT(0));
  a = 2147483648UL; b = 16652813526144921490UL;
  RLWINM(a, 4, 30, 23, SLOT(1));
  RLWIMI(a, b, 4, 30, 23, SLOT(2));
  RLDICL(a, 4, 30, SLOT(3));
  RLDICR(a, 4, 55, SLOT(4));
  RLDIC(a, 4, 30, SLOT(5));
  RLDIMI(a, b, 4, 30, SLOT(6));
  a = 6148914691236517205UL; b = 7793794445012781391UL;
  ADD128(a, b, 545748536824397673UL, 0UL, lo, hi); SLOT(7) = lo; SLOT(8) = hi;
  SUB128(a, b, 255UL, 3480064204648012388UL, lo, hi); SLOT(9) = lo; SLOT(10) = hi;
  CARRYEXT("subfme", a, b, SLOT(11));
  a = 15887375942514193133UL; b = 2975210496932324678UL;
  ADD128(a, b, 4441260108292453367UL, 1199115600139644239UL, lo, hi); SLOT(12) = lo; SLOT(13) = hi;
  SUB128(a, b, 18446744073709551615UL, 16709122582080186115UL, lo, hi); SLOT(14) = lo; SLOT(15) = hi;
  CARRYEXT("subfze", a, b, SLOT(16));
  a = 14887080653201160266UL; b = 2147483647UL;
  COUNTED(4, a, SLOT(17));
  a = 16417087851246336285UL; b = 1180555280920351004UL;
  COUNTED(3, a, SLOT(18));
  a = 1058627201198009961UL; b = 255UL;
  CRLOGIC("crnor", a, b, 14865829499356803606UL, 2198338976266316438UL, SLOT(19));
  ISEL(a, b, 1067403841247238152UL, 5783152524197387179UL, SLOT(20));
  a = 7536318058346799949UL; b = 2287023518943750432UL;
  IMM("addi", a, -22190, SLOT(21));
  IMM("addic", a, 85, SLOT(22));
  IMM("mulli", a, 23567, SLOT(23));
  IMM("subfic", a, 1213, SLOT(24));
  a = 4342926512604461182UL; b = 8322857878585308858UL;
  IMM("addi", a, -11670, SLOT(25));
  IMM("addic", a, -5112, SLOT(26));
  IMM("mulli", a, 9169, SLOT(27));
  IMM("subfic", a, -5298, SLOT(28));
  a = 2129216907884341363UL; b = 8516526382416819637UL;
  RR("orc", a, b, SLOT(29));
  a = 10205723247219209212UL; b = 13197227626215848394UL;
  RLWINM(a, 17, 5, 20, SLOT(30));
  RLWIMI(a, b, 17, 5, 20, SLOT(31));
  RLDICL(a, 17, 5, SLOT(32));
  RLDICR(a, 17, 52, SLOT(33));
  RLDIC(a, 17, 5, SLOT(34));
  RLDIMI(a, b, 17, 5, SLOT(35));
  a = 574754599507409853UL; b = 1UL;
  RR("divd", a, b, SLOT(36));
  a = 12297829382473034410UL; b = 1727626701141209120UL;
  RR("divdu", a, b, SLOT(37));
  a = 13661031666016992255UL; b = 198695483896714285UL;
  IMM("addi", a, 12101, SLOT(38));
  IMM("addic", a, -19992, SLOT(39));
  IMM("mulli", a, 29339, SLOT(40));
  IMM("subfic", a, -24014, SLOT(41));
  a = 255UL; b = 13490373646789995706UL;
  fx = -0.0; fy = 947.184000; fz = 1.0;
  F2("fmul", fx, fy, fr); SLOT(42) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(43) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(44) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(45));
  a = 5508885970525942392UL; b = 15376529652218216283UL;
  IMM("addi", a, -14210, SLOT(46));
  IMM("addic", a, -19361, SLOT(47));
  IMM("mulli", a, -15934, SLOT(48));
  IMM("subfic", a, -11625, SLOT(49));
  a = 2030679413535378181UL; b = 18445749945682606941UL;
  RLWINM(a, 19, 31, 11, SLOT(50));
  RLWIMI(a, b, 19, 31, 11, SLOT(51));
  RLDICL(a, 51, 63, SLOT(52));
  RLDICR(a, 51, 11, SLOT(53));
  RLDIC(a, 51, 12, SLOT(54));
  RLDIMI(a, b, 51, 12, SLOT(55));
  a = 12661509198579061101UL; b = 8816945666172363446UL;
  RR("mullw", a, b, SLOT(56));
  a = 4794046493375115061UL; b = 7856112568139691959UL;
  RR("andc", a, b, SLOT(57));
  a = 5970402974628863780UL; b = 13519609198662852912UL;
  IMM("addi", a, -16195, SLOT(58));
  IMM("addic", a, -29584, SLOT(59));
  IMM("mulli", a, -880, SLOT(60));
  IMM("subfic", a, 14989, SLOT(61));
  a = 5806379885949883569UL; b = 4571485598194493575UL;
  ADD128(a, b, 255UL, 14666460827312113816UL, lo, hi); SLOT(62) = lo; SLOT(63) = hi;
  SUB128(a, b, 2147483647UL, 17053517315804725912UL, lo, hi); SLOT(64) = lo; SLOT(65) = hi;
  CARRYEXT("addme", a, b, SLOT(66));
  a = 0UL; b = 4231067275554143114UL;
  CRLOGIC("creqv", a, b, 8647320886000927499UL, 9223372036854775807UL, SLOT(67));
  ISEL(a, b, 10625872023590053712UL, 8171522815317137788UL, SLOT(68));
  a = 9775434308954754309UL; b = 9223372036854775808UL;
  RRCC("orc", a, b, SLOT(69), c); SLOT(70) = c;
  a = 8852541725210275276UL; b = 1434294030828356975UL;
  COUNTED(7, a, SLOT(71));
  a = 14328815243152869259UL; b = 6732161855845038948UL;
  RR("nand", a, b, SLOT(72));
  a = 18446744073709551615UL; b = 3983174190378639749UL;
  fx = 816.827000; fy = 4503599627370497.0; fz = 0.0;
  F2("fmul", fx, fy, fr); SLOT(73) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(74) = *(volatile unsigned long *)&fr;
  FMA("fmsub", fx, fy, fz, fr); SLOT(75) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(76));
  a = 7512975560520661020UL; b = 4370784171834531739UL;
  ST("std", 56, a);
  LD("lwa", 56, SLOT(77));
  BREV("stdbrx", "ldbrx", 56, b, SLOT(78));
  BREV("stwbrx", "lwbrx", 56, b, SLOT(79));
  a = 8719351260880516833UL; b = 13072658530077871128UL;
  RR("divd", a, b, SLOT(80));
  a = 255UL; b = 13781657802161482959UL;
  fx = 1.0; fy = 1.0; fz = -0.0;
  F2("fadd", fx, fy, fr); SLOT(81) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(82) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(83) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(84));
  a = 12246167975261383015UL; b = 9223372036854775808UL;
  IMM("addi", a, -29124, SLOT(85));
  IMM("addic", a, -7818, SLOT(86));
  IMM("mulli", a, 2514, SLOT(87));
  IMM("subfic", a, -17491, SLOT(88));
  a = 3701287341313543617UL; b = 13809213936735606354UL;
  CRLOGIC("crand", a, b, 4294967296UL, 3662314718574855266UL, SLOT(89));
  ISEL(a, b, 18446744073709551614UL, 15327523775516413750UL, SLOT(90));
  a = 326466904450394838UL; b = 9223372036854775808UL;
  IMM("addi", a, 13311, SLOT(91));
  IMM("addic", a, 2524, SLOT(92));
  IMM("mulli", a, -18055, SLOT(93));
  IMM("subfic", a, -8748, SLOT(94));
  a = 11307993949147093248UL; b = 0UL;
  CRLOGIC("crorc", a, b, 4356275706581874884UL, 1338666534075687414UL, SLOT(95));
  ISEL(a, b, 5015502477974326559UL, 3591312621131649399UL, SLOT(96));
  a = 9223372036854775807UL; b = 9478991291718837499UL;
  COUNTED(3, a, SLOT(97));
  a = 17825147090697946452UL; b = 255UL;
  ADD128(a, b, 14157951780545098925UL, 14285836937081557562UL, lo, hi); SLOT(98) = lo; SLOT(99) = hi;
  SUB128(a, b, 17532033894625270342UL, 15086802009454413235UL, lo, hi); SLOT(100) = lo; SLOT(101) = hi;
  CARRYEXT("subfze", a, b, SLOT(102));
  a = 17015128541380307110UL; b = 17686653830292182948UL;
  RRCC("or", a, b, SLOT(103), c); SLOT(104) = c;
  a = 3094983276045217148UL; b = 5032125356242649791UL;
  fx = 820.675000; fy = 0.0; fz = -228.737000;
  F2("fadd", fx, fy, fr); SLOT(105) = *(volatile unsigned long *)&fr;
  F1("fsqrt", fx, fr); SLOT(106) = *(volatile unsigned long *)&fr;
  FMA("fmadd", fx, fy, fz, fr); SLOT(107) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(108));
  a = 9223372036854775808UL; b = 2147483647UL;
  ST("std", 8, a);
  LD("lbz", 8, SLOT(109));
  BREV("stdbrx", "ldbrx", 8, b, SLOT(110));
  BREV("stwbrx", "lwbrx", 8, b, SLOT(111));
  a = 14477565358893022554UL; b = 11266860733397894329UL;
  RR("divd", a, b, SLOT(112));
  a = 9223372036854775808UL; b = 4193517641488866758UL;
  fx = -86.261000; fy = 425.767000; fz = 4503599627370497.0;
  F2("fsub", fx, fy, fr); SLOT(113) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(114) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(115) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(116));
  SLOT(117) = deep(12, 13840070226209846125UL);
  return 0;
}
