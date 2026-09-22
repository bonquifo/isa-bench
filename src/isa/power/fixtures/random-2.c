
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
  a = 2147483647UL; b = 1031317372180197007UL;
  fx = 210.190000; fy = -300.517000; fz = 4503599627370497.0;
  F2("fadd", fx, fy, fr); SLOT(0) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(1) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(2) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(3));
  a = 6429726090921640468UL; b = 10955846449471433386UL;
  COUNTED(6, a, SLOT(4));
  a = 17313195728576549271UL; b = 5233294933500568851UL;
  COUNTED(3, a, SLOT(5));
  a = 2740696236606408771UL; b = 2073479819331376932UL;
  RLWINM(a, 17, 0, 18, SLOT(6));
  RLWIMI(a, b, 17, 0, 18, SLOT(7));
  RLDICL(a, 49, 0, SLOT(8));
  RLDICR(a, 49, 18, SLOT(9));
  RLDIC(a, 49, 0, SLOT(10));
  RLDIMI(a, b, 49, 0, SLOT(11));
  a = 2452961128536822871UL; b = 405758645265002038UL;
  RLWINM(a, 23, 17, 7, SLOT(12));
  RLWIMI(a, b, 23, 17, 7, SLOT(13));
  RLDICL(a, 23, 49, SLOT(14));
  RLDICR(a, 23, 7, SLOT(15));
  RLDIC(a, 23, 40, SLOT(16));
  RLDIMI(a, b, 23, 40, SLOT(17));
  a = 14587921275295305183UL; b = 1893788075597217184UL;
  RR("subf", a, b, SLOT(18));
  a = 11658181613044581597UL; b = 3958513570559858885UL;
  RR("mulhwu", a, b, SLOT(19));
  a = 6934112791953844549UL; b = 14145350833510288732UL;
  RLWINM(a, 19, 27, 11, SLOT(20));
  RLWIMI(a, b, 19, 27, 11, SLOT(21));
  RLDICL(a, 19, 59, SLOT(22));
  RLDICR(a, 19, 11, SLOT(23));
  RLDIC(a, 19, 44, SLOT(24));
  RLDIMI(a, b, 19, 44, SLOT(25));
  a = 16915635115197364350UL; b = 908302595989437076UL;
  IMM("addi", a, -12847, SLOT(26));
  IMM("addic", a, 1984, SLOT(27));
  IMM("mulli", a, -20812, SLOT(28));
  IMM("subfic", a, 9111, SLOT(29));
  a = 13730451080149626602UL; b = 12297829382473034410UL;
  RR("andc", a, b, SLOT(30));
  a = 4294967295UL; b = 256UL;
  ST("std", 24, a);
  LD("lbz", 24, SLOT(31));
  BREV("stdbrx", "ldbrx", 24, b, SLOT(32));
  BREV("stwbrx", "lwbrx", 24, b, SLOT(33));
  a = 2431362377626795335UL; b = 14828320243033947451UL;
  RRCC("nor", a, b, SLOT(34), c); SLOT(35) = c;
  a = 256UL; b = 11958385378126978110UL;
  RLWINM(a, 10, 3, 16, SLOT(36));
  RLWIMI(a, b, 10, 3, 16, SLOT(37));
  RLDICL(a, 10, 35, SLOT(38));
  RLDICR(a, 10, 48, SLOT(39));
  RLDIC(a, 10, 35, SLOT(40));
  RLDIMI(a, b, 10, 35, SLOT(41));
  a = 9223372036854775809UL; b = 13615080395358271444UL;
  ST("std", 8, a);
  LD("lha", 8, SLOT(42));
  BREV("stdbrx", "ldbrx", 8, b, SLOT(43));
  BREV("stwbrx", "lwbrx", 8, b, SLOT(44));
  a = 11168194311896184221UL; b = 9639729597990920736UL;
  CRLOGIC("crnor", a, b, 12419367177883491932UL, 255UL, SLOT(45));
  ISEL(a, b, 34638790280146834UL, 9771303642819356401UL, SLOT(46));
  a = 15804255716715482443UL; b = 12231564558928139700UL;
  RRCC("nand", a, b, SLOT(47), c); SLOT(48) = c;
  a = 6148914691236517205UL; b = 15402368164198397812UL;
  RR("srd", a, b, SLOT(49));
  a = 8614754354717814631UL; b = 1783756171973700532UL;
  RLWINM(a, 5, 0, 4, SLOT(50));
  RLWIMI(a, b, 5, 0, 4, SLOT(51));
  RLDICL(a, 5, 32, SLOT(52));
  RLDICR(a, 5, 4, SLOT(53));
  RLDIC(a, 5, 32, SLOT(54));
  RLDIMI(a, b, 5, 32, SLOT(55));
  a = 9365601526265649906UL; b = 3381453494042638697UL;
  RLWINM(a, 12, 19, 12, SLOT(56));
  RLWIMI(a, b, 12, 19, 12, SLOT(57));
  RLDICL(a, 44, 19, SLOT(58));
  RLDICR(a, 44, 12, SLOT(59));
  RLDIC(a, 44, 19, SLOT(60));
  RLDIMI(a, b, 44, 19, SLOT(61));
  a = 4577226496371796463UL; b = 7559790927919738803UL;
  ADD128(a, b, 11513046756564425862UL, 16962431256644314077UL, lo, hi); SLOT(62) = lo; SLOT(63) = hi;
  SUB128(a, b, 12473007788318564222UL, 255UL, lo, hi); SLOT(64) = lo; SLOT(65) = hi;
  CARRYEXT("addme", a, b, SLOT(66));
  a = 13246418195135291668UL; b = 1609858111848776891UL;
  COUNTED(7, a, SLOT(67));
  a = 18446744073709551614UL; b = 8091097670029380974UL;
  CRLOGIC("crorc", a, b, 3549172972231311264UL, 1UL, SLOT(68));
  ISEL(a, b, 6763831261445825100UL, 6148914691236517205UL, SLOT(69));
  a = 10797276237821967036UL; b = 486001210397307063UL;
  RR("sraw", a, b, SLOT(70));
  a = 9223372036854775807UL; b = 12094536763181178646UL;
  IMM("addi", a, 25007, SLOT(71));
  IMM("addic", a, 5147, SLOT(72));
  IMM("mulli", a, -22667, SLOT(73));
  IMM("subfic", a, -23890, SLOT(74));
  a = 10349395318818072450UL; b = 10360371063061399129UL;
  RLWINM(a, 22, 23, 3, SLOT(75));
  RLWIMI(a, b, 22, 23, 3, SLOT(76));
  RLDICL(a, 54, 55, SLOT(77));
  RLDICR(a, 54, 35, SLOT(78));
  RLDIC(a, 54, 9, SLOT(79));
  RLDIMI(a, b, 54, 9, SLOT(80));
  a = 14306639552711919341UL; b = 17881444127822712431UL;
  RR("xor", a, b, SLOT(81));
  a = 9223372036854775807UL; b = 5823456879756744331UL;
  IMM("addi", a, 15509, SLOT(82));
  IMM("addic", a, -18414, SLOT(83));
  IMM("mulli", a, 23169, SLOT(84));
  IMM("subfic", a, 24498, SLOT(85));
  a = 18446744073709551615UL; b = 13146556191058082028UL;
  RRCC("xor", a, b, SLOT(86), c); SLOT(87) = c;
  a = 4984239823809238470UL; b = 10602442427469978254UL;
  RLWINM(a, 1, 6, 4, SLOT(88));
  RLWIMI(a, b, 1, 6, 4, SLOT(89));
  RLDICL(a, 1, 38, SLOT(90));
  RLDICR(a, 1, 4, SLOT(91));
  RLDIC(a, 1, 38, SLOT(92));
  RLDIMI(a, b, 1, 38, SLOT(93));
  a = 7832952075626350217UL; b = 9223372036854775807UL;
  RR("srd", a, b, SLOT(94));
  a = 12297829382473034410UL; b = 2227500467029815195UL;
  RRCC("and", a, b, SLOT(95), c); SLOT(96) = c;
  a = 1568895664069408092UL; b = 12527443284676963776UL;
  RR("divw", a, b, SLOT(97));
  a = 6148914691236517205UL; b = 0UL;
  COUNTED(4, a, SLOT(98));
  a = 7392983857844097196UL; b = 16420849419383957942UL;
  RR("divd", a, b, SLOT(99));
  a = 15575281777608758682UL; b = 14672992592103589695UL;
  COUNTED(3, a, SLOT(100));
  a = 3025011059157671935UL; b = 2597117051591212312UL;
  RLWINM(a, 11, 4, 2, SLOT(101));
  RLWIMI(a, b, 11, 4, 2, SLOT(102));
  RLDICL(a, 43, 36, SLOT(103));
  RLDICR(a, 43, 34, SLOT(104));
  RLDIC(a, 43, 20, SLOT(105));
  RLDIMI(a, b, 43, 20, SLOT(106));
  a = 11996452103096956371UL; b = 3873964376078479882UL;
  ADD128(a, b, 12840045910427118068UL, 17702412753263450235UL, lo, hi); SLOT(107) = lo; SLOT(108) = hi;
  SUB128(a, b, 8071731195187913975UL, 8374532778736019618UL, lo, hi); SLOT(109) = lo; SLOT(110) = hi;
  CARRYEXT("addme", a, b, SLOT(111));
  a = 16118074741293952456UL; b = 8267117362972227691UL;
  ST("std", 40, a);
  LD("lwa", 40, SLOT(112));
  BREV("stdbrx", "ldbrx", 40, b, SLOT(113));
  BREV("stwbrx", "lwbrx", 40, b, SLOT(114));
  a = 0UL; b = 5514149782910394477UL;
  IMM("addi", a, 24047, SLOT(115));
  IMM("addic", a, 21332, SLOT(116));
  IMM("mulli", a, -26383, SLOT(117));
  IMM("subfic", a, 16606, SLOT(118));
  a = 11340747270914877786UL; b = 357210948866675611UL;
  RR("and", a, b, SLOT(119));
  SLOT(120) = deep(13, 1UL);
  return 0;
}
