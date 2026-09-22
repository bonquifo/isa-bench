
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
  a = 15714189388483533596UL; b = 9661873218981080337UL;
  ADD128(a, b, 9241530873807468533UL, 2141418054477509169UL, lo, hi); SLOT(0) = lo; SLOT(1) = hi;
  SUB128(a, b, 9223372036854775807UL, 11571288598897506516UL, lo, hi); SLOT(2) = lo; SLOT(3) = hi;
  CARRYEXT("addze", a, b, SLOT(4));
  a = 6148914691236517205UL; b = 2116993572548858119UL;
  fx = 0.0; fy = 1.0; fz = -0.0;
  F2("fsub", fx, fy, fr); SLOT(5) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(6) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(7) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(8));
  a = 15911043226130657463UL; b = 18446744073709551614UL;
  COUNTED(5, a, SLOT(9));
  a = 3075789516847507838UL; b = 8113521819626758363UL;
  RRCC("xor", a, b, SLOT(10), c); SLOT(11) = c;
  a = 12297829382473034410UL; b = 18446744073709551615UL;
  IMM("addi", a, -7852, SLOT(12));
  IMM("addic", a, 5671, SLOT(13));
  IMM("mulli", a, 8863, SLOT(14));
  IMM("subfic", a, -29475, SLOT(15));
  a = 15220801251274643162UL; b = 13610640768053388886UL;
  IMM("addi", a, 27635, SLOT(16));
  IMM("addic", a, -27010, SLOT(17));
  IMM("mulli", a, 17268, SLOT(18));
  IMM("subfic", a, 5055, SLOT(19));
  a = 16014719766959802155UL; b = 255UL;
  RR("srw", a, b, SLOT(20));
  a = 256UL; b = 17755274768618322339UL;
  RLWINM(a, 4, 24, 27, SLOT(21));
  RLWIMI(a, b, 4, 24, 27, SLOT(22));
  RLDICL(a, 4, 24, SLOT(23));
  RLDICR(a, 4, 27, SLOT(24));
  RLDIC(a, 4, 24, SLOT(25));
  RLDIMI(a, b, 4, 24, SLOT(26));
  a = 255UL; b = 12739125781666834418UL;
  IMM("addi", a, -28040, SLOT(27));
  IMM("addic", a, 6709, SLOT(28));
  IMM("mulli", a, 6108, SLOT(29));
  IMM("subfic", a, 16139, SLOT(30));
  a = 14218555559411091597UL; b = 5412476191340604153UL;
  ADD128(a, b, 6008031085972954892UL, 5035514532348933641UL, lo, hi); SLOT(31) = lo; SLOT(32) = hi;
  SUB128(a, b, 18101690447475597360UL, 6052724827873398338UL, lo, hi); SLOT(33) = lo; SLOT(34) = hi;
  CARRYEXT("subfme", a, b, SLOT(35));
  a = 3310735609051349527UL; b = 14765465725475718843UL;
  RR("divwu", a, b, SLOT(36));
  a = 10075092985612615103UL; b = 1964927798239873923UL;
  RLWINM(a, 5, 17, 16, SLOT(37));
  RLWIMI(a, b, 5, 17, 16, SLOT(38));
  RLDICL(a, 5, 49, SLOT(39));
  RLDICR(a, 5, 48, SLOT(40));
  RLDIC(a, 5, 49, SLOT(41));
  RLDIMI(a, b, 5, 49, SLOT(42));
  a = 18059124288152721899UL; b = 2131594924895802223UL;
  RR("xor", a, b, SLOT(43));
  a = 11563977774406147795UL; b = 17317921781620063310UL;
  RR("mulhwu", a, b, SLOT(44));
  a = 12428601830838414543UL; b = 10593898808868991673UL;
  CRLOGIC("crnor", a, b, 13338928251497636482UL, 17350128721654705719UL, SLOT(45));
  ISEL(a, b, 15864177510454252476UL, 18033245780244720883UL, SLOT(46));
  a = 9955722696258983260UL; b = 0UL;
  ADD128(a, b, 5315743108444660336UL, 256UL, lo, hi); SLOT(47) = lo; SLOT(48) = hi;
  SUB128(a, b, 12297829382473034410UL, 4294967296UL, lo, hi); SLOT(49) = lo; SLOT(50) = hi;
  CARRYEXT("addme", a, b, SLOT(51));
  a = 14823537722771449107UL; b = 1003235832919709401UL;
  ST("std", 16, a);
  LD("lbz", 16, SLOT(52));
  BREV("stdbrx", "ldbrx", 16, b, SLOT(53));
  BREV("stwbrx", "lwbrx", 16, b, SLOT(54));
  a = 17181949163087925448UL; b = 17223762008864567979UL;
  IMM("addi", a, 26004, SLOT(55));
  IMM("addic", a, -22895, SLOT(56));
  IMM("mulli", a, -26164, SLOT(57));
  IMM("subfic", a, -15720, SLOT(58));
  a = 4689751551854270153UL; b = 5804849859652489912UL;
  fx = -339.783000; fy = 4503599627370497.0; fz = 21.182000;
  F2("fdiv", fx, fy, fr); SLOT(59) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(60) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(61) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(62));
  a = 4234091006271198639UL; b = 7967029864133280291UL;
  RR("slw", a, b, SLOT(63));
  a = 5634507258987944531UL; b = 18020394678732980750UL;
  RR("andc", a, b, SLOT(64));
  a = 4294967296UL; b = 7017626834281020133UL;
  RR("subf", a, b, SLOT(65));
  a = 6566333155067227496UL; b = 4294967296UL;
  IMM("addi", a, 11046, SLOT(66));
  IMM("addic", a, 24170, SLOT(67));
  IMM("mulli", a, -27438, SLOT(68));
  IMM("subfic", a, 18838, SLOT(69));
  a = 9075801676455271012UL; b = 7214604584356406521UL;
  RR("orc", a, b, SLOT(70));
  a = 14978695343266815969UL; b = 8278039017973283585UL;
  CRLOGIC("crnor", a, b, 15074910085863698147UL, 10871811706042307755UL, SLOT(71));
  ISEL(a, b, 9390309144795509576UL, 17229633885942762351UL, SLOT(72));
  a = 6714997004516133460UL; b = 298068949309751601UL;
  COUNTED(1, a, SLOT(73));
  a = 10777489178160945883UL; b = 2147483648UL;
  RLWINM(a, 23, 16, 10, SLOT(74));
  RLWIMI(a, b, 23, 16, 10, SLOT(75));
  RLDICL(a, 55, 16, SLOT(76));
  RLDICR(a, 55, 10, SLOT(77));
  RLDIC(a, 55, 8, SLOT(78));
  RLDIMI(a, b, 55, 8, SLOT(79));
  a = 5161972983920119131UL; b = 12247077865340569889UL;
  CRLOGIC("cror", a, b, 15345462339167951141UL, 8178162413357220393UL, SLOT(80));
  ISEL(a, b, 17468276650628286567UL, 2765894049273819583UL, SLOT(81));
  a = 15667382403561275106UL; b = 15180700142548983661UL;
  ADD128(a, b, 4294967295UL, 3653117071818643380UL, lo, hi); SLOT(82) = lo; SLOT(83) = hi;
  SUB128(a, b, 15732848941954097102UL, 8002210555833959439UL, lo, hi); SLOT(84) = lo; SLOT(85) = hi;
  CARRYEXT("addme", a, b, SLOT(86));
  a = 2531510414038567749UL; b = 3099303626592830186UL;
  RRCC("andc", a, b, SLOT(87), c); SLOT(88) = c;
  a = 12297829382473034410UL; b = 6148914691236517205UL;
  RRCC("xor", a, b, SLOT(89), c); SLOT(90) = c;
  a = 16738400992670461236UL; b = 9223372036854775809UL;
  RRCC("orc", a, b, SLOT(91), c); SLOT(92) = c;
  a = 2UL; b = 4294967296UL;
  fx = -101.153000; fy = 4503599627370497.0; fz = 65.894000;
  F2("fadd", fx, fy, fr); SLOT(93) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(94) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(95) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(96));
  a = 14971084673762192683UL; b = 15919015686030185091UL;
  RR("add", a, b, SLOT(97));
  a = 7500729988793820427UL; b = 12297829382473034410UL;
  RR("mulhwu", a, b, SLOT(98));
  a = 12297829382473034410UL; b = 7601723880129928323UL;
  CRLOGIC("crandc", a, b, 12370104673111656164UL, 4731357384214467622UL, SLOT(99));
  ISEL(a, b, 4293230861673667829UL, 9223372036854775808UL, SLOT(100));
  a = 2951482241087369691UL; b = 4294967295UL;
  COUNTED(3, a, SLOT(101));
  a = 8792464513001805990UL; b = 8660628372795080805UL;
  COUNTED(4, a, SLOT(102));
  a = 5583637794088929386UL; b = 8490519036732815433UL;
  IMM("addi", a, 1195, SLOT(103));
  IMM("addic", a, -28453, SLOT(104));
  IMM("mulli", a, -31060, SLOT(105));
  IMM("subfic", a, 2345, SLOT(106));
  a = 2147483647UL; b = 18446744073709551615UL;
  IMM("addi", a, -30854, SLOT(107));
  IMM("addic", a, 22068, SLOT(108));
  IMM("mulli", a, -10898, SLOT(109));
  IMM("subfic", a, 3213, SLOT(110));
  SLOT(111) = deep(19, 13044692278049882457UL);
  return 0;
}
