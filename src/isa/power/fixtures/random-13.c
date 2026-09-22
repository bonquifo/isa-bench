
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
  a = 1809158471094168037UL; b = 15649368411066603129UL;
  fx = -0.0; fy = -664.058000; fz = -464.132000;
  F2("fadd", fx, fy, fr); SLOT(0) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(1) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(2) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(3));
  a = 14669459556340127702UL; b = 1679657193028328964UL;
  COUNTED(4, a, SLOT(4));
  a = 7093707630636985866UL; b = 10032595948991864284UL;
  fx = 4503599627370497.0; fy = -26.339000; fz = -0.0;
  F2("fsub", fx, fy, fr); SLOT(5) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(6) = *(volatile unsigned long *)&fr;
  FMA("fmadd", fx, fy, fz, fr); SLOT(7) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(8));
  a = 9550217482531407355UL; b = 12541923705163184287UL;
  ST("std", 32, a);
  LD("lha", 32, SLOT(9));
  BREV("stdbrx", "ldbrx", 32, b, SLOT(10));
  BREV("stwbrx", "lwbrx", 32, b, SLOT(11));
  a = 354254882648587692UL; b = 17703951159237384340UL;
  RRCC("add", a, b, SLOT(12), c); SLOT(13) = c;
  a = 6148914691236517205UL; b = 16399554096069856294UL;
  RRCC("add", a, b, SLOT(14), c); SLOT(15) = c;
  a = 1791186553042100127UL; b = 2652884360525658982UL;
  ST("std", 0, a);
  LD("lbz", 0, SLOT(16));
  BREV("stdbrx", "ldbrx", 0, b, SLOT(17));
  BREV("stwbrx", "lwbrx", 0, b, SLOT(18));
  a = 2147483648UL; b = 256UL;
  RLWINM(a, 22, 17, 9, SLOT(19));
  RLWIMI(a, b, 22, 17, 9, SLOT(20));
  RLDICL(a, 54, 49, SLOT(21));
  RLDICR(a, 54, 9, SLOT(22));
  RLDIC(a, 54, 9, SLOT(23));
  RLDIMI(a, b, 54, 9, SLOT(24));
  a = 8343965155542827993UL; b = 7332867342567946783UL;
  CRLOGIC("crnor", a, b, 8228254028254857581UL, 6593646086565798000UL, SLOT(25));
  ISEL(a, b, 255UL, 9223372036854775807UL, SLOT(26));
  a = 17912169970674732203UL; b = 1UL;
  COUNTED(8, a, SLOT(27));
  a = 5471270155590360382UL; b = 6097545484485219487UL;
  CRLOGIC("crnor", a, b, 4294967295UL, 11166407285051172430UL, SLOT(28));
  ISEL(a, b, 9223372036854775808UL, 4294967296UL, SLOT(29));
  a = 126031436199158459UL; b = 12775219092683543770UL;
  RR("xor", a, b, SLOT(30));
  a = 13398717179973733912UL; b = 14165859370876628621UL;
  RLWINM(a, 20, 18, 29, SLOT(31));
  RLWIMI(a, b, 20, 18, 29, SLOT(32));
  RLDICL(a, 20, 50, SLOT(33));
  RLDICR(a, 20, 61, SLOT(34));
  RLDIC(a, 20, 43, SLOT(35));
  RLDIMI(a, b, 20, 43, SLOT(36));
  a = 12297829382473034410UL; b = 9115450910558364990UL;
  IMM("addi", a, -12359, SLOT(37));
  IMM("addic", a, -7352, SLOT(38));
  IMM("mulli", a, 13129, SLOT(39));
  IMM("subfic", a, -26358, SLOT(40));
  a = 16206370865103338691UL; b = 6480571280916331574UL;
  RLWINM(a, 8, 16, 21, SLOT(41));
  RLWIMI(a, b, 8, 16, 21, SLOT(42));
  RLDICL(a, 40, 48, SLOT(43));
  RLDICR(a, 40, 21, SLOT(44));
  RLDIC(a, 40, 23, SLOT(45));
  RLDIMI(a, b, 40, 23, SLOT(46));
  a = 17492016585618776741UL; b = 7222608689211458624UL;
  ST("std", 16, a);
  LD("lwz", 16, SLOT(47));
  BREV("stdbrx", "ldbrx", 16, b, SLOT(48));
  BREV("stwbrx", "lwbrx", 16, b, SLOT(49));
  a = 6894465706932559247UL; b = 7815165574129477699UL;
  ST("std", 32, a);
  LD("lha", 32, SLOT(50));
  BREV("stdbrx", "ldbrx", 32, b, SLOT(51));
  BREV("stwbrx", "lwbrx", 32, b, SLOT(52));
  a = 2379070234020309291UL; b = 135411459038899288UL;
  RR("divw", a, b, SLOT(53));
  a = 18446744073709551614UL; b = 12541057057991175976UL;
  RRCC("or", a, b, SLOT(54), c); SLOT(55) = c;
  a = 16210107552854291431UL; b = 2147483647UL;
  CRLOGIC("crxor", a, b, 1014743405558086711UL, 9223372036854775808UL, SLOT(56));
  ISEL(a, b, 10828158348153367839UL, 878010249617078855UL, SLOT(57));
  a = 8835725711174926878UL; b = 11687188840123329019UL;
  ADD128(a, b, 14774838063230268546UL, 9756480341701574379UL, lo, hi); SLOT(58) = lo; SLOT(59) = hi;
  SUB128(a, b, 5951191144559987449UL, 13555630061388412428UL, lo, hi); SLOT(60) = lo; SLOT(61) = hi;
  CARRYEXT("subfze", a, b, SLOT(62));
  a = 6578242685603121298UL; b = 9223372036854775808UL;
  COUNTED(3, a, SLOT(63));
  a = 12272628655470353229UL; b = 18446744073709551615UL;
  IMM("addi", a, -30285, SLOT(64));
  IMM("addic", a, 20191, SLOT(65));
  IMM("mulli", a, 9259, SLOT(66));
  IMM("subfic", a, 23150, SLOT(67));
  a = 1683984312057321379UL; b = 7144386874204177231UL;
  RR("subf", a, b, SLOT(68));
  a = 9423708408960591746UL; b = 3211821533122091539UL;
  ADD128(a, b, 1UL, 0UL, lo, hi); SLOT(69) = lo; SLOT(70) = hi;
  SUB128(a, b, 9223372036854775809UL, 11412988349967960300UL, lo, hi); SLOT(71) = lo; SLOT(72) = hi;
  CARRYEXT("addme", a, b, SLOT(73));
  a = 9223372036854775809UL; b = 6479901688118041417UL;
  IMM("addi", a, 26235, SLOT(74));
  IMM("addic", a, 6989, SLOT(75));
  IMM("mulli", a, -29860, SLOT(76));
  IMM("subfic", a, -2511, SLOT(77));
  a = 60659567516409950UL; b = 3430746574537448677UL;
  CRLOGIC("crorc", a, b, 7094033046625909512UL, 17460279840120137720UL, SLOT(78));
  ISEL(a, b, 16850446101031509562UL, 10152301591700883933UL, SLOT(79));
  a = 3519581330677598786UL; b = 4418207453000990788UL;
  ADD128(a, b, 255UL, 6108991834051586761UL, lo, hi); SLOT(80) = lo; SLOT(81) = hi;
  SUB128(a, b, 4294967296UL, 9476737065648646760UL, lo, hi); SLOT(82) = lo; SLOT(83) = hi;
  CARRYEXT("subfze", a, b, SLOT(84));
  a = 17087391603235928289UL; b = 7132612304654500110UL;
  fx = 4503599627370497.0; fy = -917.059000; fz = -712.673000;
  F2("fdiv", fx, fy, fr); SLOT(85) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(86) = *(volatile unsigned long *)&fr;
  FMA("fmsub", fx, fy, fz, fr); SLOT(87) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(88));
  a = 10527846868638975189UL; b = 9223372036854775809UL;
  COUNTED(3, a, SLOT(89));
  a = 12297829382473034410UL; b = 255UL;
  RRCC("orc", a, b, SLOT(90), c); SLOT(91) = c;
  a = 256UL; b = 4244686430797661568UL;
  COUNTED(3, a, SLOT(92));
  a = 12297829382473034410UL; b = 3935121460528614606UL;
  COUNTED(8, a, SLOT(93));
  a = 9223372036854775808UL; b = 15310149423277658320UL;
  RRCC("andc", a, b, SLOT(94), c); SLOT(95) = c;
  a = 9223372036854775808UL; b = 2756890363240172724UL;
  RR("srad", a, b, SLOT(96));
  a = 9223372036854775807UL; b = 13472315202463286506UL;
  CRLOGIC("crnor", a, b, 7215312964075799645UL, 17711349161957381146UL, SLOT(97));
  ISEL(a, b, 9120930451944019601UL, 13661628846378084970UL, SLOT(98));
  a = 12334473721721266523UL; b = 1601441068347437698UL;
  ADD128(a, b, 8887248536918263960UL, 10383340956648175372UL, lo, hi); SLOT(99) = lo; SLOT(100) = hi;
  SUB128(a, b, 14551316600694855580UL, 255UL, lo, hi); SLOT(101) = lo; SLOT(102) = hi;
  CARRYEXT("addme", a, b, SLOT(103));
  a = 10645669378772531226UL; b = 9223372036854775808UL;
  RLWINM(a, 20, 1, 26, SLOT(104));
  RLWIMI(a, b, 20, 1, 26, SLOT(105));
  RLDICL(a, 52, 1, SLOT(106));
  RLDICR(a, 52, 58, SLOT(107));
  RLDIC(a, 52, 1, SLOT(108));
  RLDIMI(a, b, 52, 1, SLOT(109));
  a = 1520384798168083195UL; b = 11986358157201317913UL;
  RR("divw", a, b, SLOT(110));
  a = 9223372036854775809UL; b = 18446744073709551615UL;
  fx = -0.0; fy = 56.384000; fz = -686.859000;
  F2("fsub", fx, fy, fr); SLOT(111) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(112) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(113) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(114));
  SLOT(115) = deep(20, 16258425204952867789UL);
  return 0;
}
