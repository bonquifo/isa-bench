
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
  a = 9970174924808273667UL; b = 9223372036854775808UL;
  RRCC("add", a, b, SLOT(0), c); SLOT(1) = c;
  a = 255UL; b = 5120416025522775282UL;
  RR("mulhw", a, b, SLOT(2));
  a = 9223372036854775807UL; b = 11110760201335124289UL;
  RRCC("orc", a, b, SLOT(3), c); SLOT(4) = c;
  a = 18056931686905461345UL; b = 14068245644208165060UL;
  ADD128(a, b, 17767616827992010816UL, 1334791215845808894UL, lo, hi); SLOT(5) = lo; SLOT(6) = hi;
  SUB128(a, b, 0UL, 13378563860770209541UL, lo, hi); SLOT(7) = lo; SLOT(8) = hi;
  CARRYEXT("addze", a, b, SLOT(9));
  a = 10174274966372505883UL; b = 9223372036854775808UL;
  RRCC("andc", a, b, SLOT(10), c); SLOT(11) = c;
  a = 4552707814957280032UL; b = 9765274742838457485UL;
  ST("std", 24, a);
  LD("lha", 24, SLOT(12));
  BREV("stdbrx", "ldbrx", 24, b, SLOT(13));
  BREV("stwbrx", "lwbrx", 24, b, SLOT(14));
  a = 18446744073709551615UL; b = 1527408984370350920UL;
  RR("add", a, b, SLOT(15));
  a = 9263420371590274840UL; b = 8966969780597138986UL;
  CRLOGIC("crnand", a, b, 1105076459808133859UL, 951467845140602902UL, SLOT(16));
  ISEL(a, b, 7966261156005487767UL, 6726893343163006015UL, SLOT(17));
  a = 7123977414460442656UL; b = 9223372036854775807UL;
  COUNTED(5, a, SLOT(18));
  a = 12297829382473034410UL; b = 15150252823125446073UL;
  RR("sraw", a, b, SLOT(19));
  a = 18446744073709551614UL; b = 12515346785772609004UL;
  fx = 4503599627370497.0; fy = -956.938000; fz = 1.0;
  F2("fsub", fx, fy, fr); SLOT(20) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(21) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(22) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(23));
  a = 1732816196352933386UL; b = 7218675648391700078UL;
  RRCC("orc", a, b, SLOT(24), c); SLOT(25) = c;
  a = 2367256605096371545UL; b = 9326368006414461781UL;
  COUNTED(8, a, SLOT(26));
  a = 11438804167927888520UL; b = 12459746825236169600UL;
  RR("mulld", a, b, SLOT(27));
  a = 9223372036854775807UL; b = 513577996816666430UL;
  ST("std", 16, a);
  LD("lhz", 16, SLOT(28));
  BREV("stdbrx", "ldbrx", 16, b, SLOT(29));
  BREV("stwbrx", "lwbrx", 16, b, SLOT(30));
  a = 7334866711056440505UL; b = 12282483196626770492UL;
  RR("eqv", a, b, SLOT(31));
  a = 2788069728887569843UL; b = 4868671650208131186UL;
  RR("divwu", a, b, SLOT(32));
  a = 9223372036854775809UL; b = 11228799684761741346UL;
  fx = 771.395000; fy = 4503599627370497.0; fz = 0.0;
  F2("fadd", fx, fy, fr); SLOT(33) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(34) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(35) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(36));
  a = 8939057902767575353UL; b = 2102096469800629679UL;
  ADD128(a, b, 2542388125558839866UL, 7214457899630071747UL, lo, hi); SLOT(37) = lo; SLOT(38) = hi;
  SUB128(a, b, 17042813555273222505UL, 2147483648UL, lo, hi); SLOT(39) = lo; SLOT(40) = hi;
  CARRYEXT("subfze", a, b, SLOT(41));
  a = 255UL; b = 13077416524656932057UL;
  RRCC("nor", a, b, SLOT(42), c); SLOT(43) = c;
  a = 18320489091804172334UL; b = 16436578882540412439UL;
  RR("xor", a, b, SLOT(44));
  a = 8297315715821127121UL; b = 0UL;
  RRCC("and", a, b, SLOT(45), c); SLOT(46) = c;
  a = 7429095465951805786UL; b = 18446744073709551614UL;
  RRCC("orc", a, b, SLOT(47), c); SLOT(48) = c;
  a = 2772823131375633591UL; b = 4294967296UL;
  RRCC("and", a, b, SLOT(49), c); SLOT(50) = c;
  a = 9050616987585904144UL; b = 2851485123746558728UL;
  IMM("addi", a, 17644, SLOT(51));
  IMM("addic", a, 15872, SLOT(52));
  IMM("mulli", a, -11173, SLOT(53));
  IMM("subfic", a, 3581, SLOT(54));
  a = 9444814366395945923UL; b = 5794275184840191853UL;
  ADD128(a, b, 5065387276460146087UL, 17219242508755534785UL, lo, hi); SLOT(55) = lo; SLOT(56) = hi;
  SUB128(a, b, 1UL, 13837085182082550360UL, lo, hi); SLOT(57) = lo; SLOT(58) = hi;
  CARRYEXT("subfme", a, b, SLOT(59));
  a = 51829130405673540UL; b = 16800208476837939838UL;
  fx = -0.0; fy = 4.506000; fz = 1.0;
  F2("fsub", fx, fy, fr); SLOT(60) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(61) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(62) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(63));
  a = 256UL; b = 11618249746873999639UL;
  RLWINM(a, 16, 4, 6, SLOT(64));
  RLWIMI(a, b, 16, 4, 6, SLOT(65));
  RLDICL(a, 48, 4, SLOT(66));
  RLDICR(a, 48, 38, SLOT(67));
  RLDIC(a, 48, 4, SLOT(68));
  RLDIMI(a, b, 48, 4, SLOT(69));
  a = 2741783437575288795UL; b = 8899450836566496895UL;
  RR("mulhd", a, b, SLOT(70));
  a = 9522420234203788267UL; b = 3668280872002119433UL;
  RLWINM(a, 18, 1, 21, SLOT(71));
  RLWIMI(a, b, 18, 1, 21, SLOT(72));
  RLDICL(a, 50, 1, SLOT(73));
  RLDICR(a, 50, 21, SLOT(74));
  RLDIC(a, 50, 1, SLOT(75));
  RLDIMI(a, b, 50, 1, SLOT(76));
  a = 17610134018066645468UL; b = 9338874214036639060UL;
  COUNTED(1, a, SLOT(77));
  a = 0UL; b = 16516524155213748313UL;
  ADD128(a, b, 10058487903532087832UL, 9410078262557507129UL, lo, hi); SLOT(78) = lo; SLOT(79) = hi;
  SUB128(a, b, 1UL, 2UL, lo, hi); SLOT(80) = lo; SLOT(81) = hi;
  CARRYEXT("subfze", a, b, SLOT(82));
  a = 13959120729949369938UL; b = 14186060732431275510UL;
  RLWINM(a, 0, 21, 19, SLOT(83));
  RLWIMI(a, b, 0, 21, 19, SLOT(84));
  RLDICL(a, 0, 53, SLOT(85));
  RLDICR(a, 0, 51, SLOT(86));
  RLDIC(a, 0, 53, SLOT(87));
  RLDIMI(a, b, 0, 53, SLOT(88));
  a = 9722170948937324336UL; b = 1414803816257425965UL;
  ADD128(a, b, 18446744073709551614UL, 18378692435508531112UL, lo, hi); SLOT(89) = lo; SLOT(90) = hi;
  SUB128(a, b, 0UL, 5666217050674084442UL, lo, hi); SLOT(91) = lo; SLOT(92) = hi;
  CARRYEXT("addze", a, b, SLOT(93));
  a = 3606563098332732063UL; b = 12151530632049627922UL;
  RLWINM(a, 19, 17, 9, SLOT(94));
  RLWIMI(a, b, 19, 17, 9, SLOT(95));
  RLDICL(a, 19, 17, SLOT(96));
  RLDICR(a, 19, 41, SLOT(97));
  RLDIC(a, 19, 17, SLOT(98));
  RLDIMI(a, b, 19, 17, SLOT(99));
  a = 18446744073709551615UL; b = 16685614225178435909UL;
  RR("mulld", a, b, SLOT(100));
  a = 114119888443014794UL; b = 255UL;
  IMM("addi", a, -15565, SLOT(101));
  IMM("addic", a, -3892, SLOT(102));
  IMM("mulli", a, 23815, SLOT(103));
  IMM("subfic", a, 10393, SLOT(104));
  a = 17354679997527331628UL; b = 4452146083132936771UL;
  ADD128(a, b, 9223372036854775809UL, 17513856960232610675UL, lo, hi); SLOT(105) = lo; SLOT(106) = hi;
  SUB128(a, b, 13958552868219243576UL, 15261857109949051089UL, lo, hi); SLOT(107) = lo; SLOT(108) = hi;
  CARRYEXT("addze", a, b, SLOT(109));
  a = 14867102840611562868UL; b = 0UL;
  RRCC("add", a, b, SLOT(110), c); SLOT(111) = c;
  a = 11737567099046120306UL; b = 7090888612378051880UL;
  fx = -0.0; fy = 612.900000; fz = -876.215000;
  F2("fdiv", fx, fy, fr); SLOT(112) = *(volatile unsigned long *)&fr;
  F1("fsqrt", fx, fr); SLOT(113) = *(volatile unsigned long *)&fr;
  FMA("fmsub", fx, fy, fz, fr); SLOT(114) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(115));
  SLOT(116) = deep(12, 17560025977060629033UL);
  return 0;
}
