
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
  a = 2UL; b = 4294967295UL;
  COUNTED(6, a, SLOT(0));
  a = 5322802581104242558UL; b = 4294967296UL;
  COUNTED(5, a, SLOT(1));
  a = 10617190319240872698UL; b = 11211170971364618117UL;
  fx = 607.827000; fy = -0.0; fz = 1.0;
  F2("fdiv", fx, fy, fr); SLOT(2) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(3) = *(volatile unsigned long *)&fr;
  FMA("fmadd", fx, fy, fz, fr); SLOT(4) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(5));
  a = 452716312670819367UL; b = 9415075916488132406UL;
  CRLOGIC("crand", a, b, 4011383213224604515UL, 6316053945354717542UL, SLOT(6));
  ISEL(a, b, 15142451350948831391UL, 1832297569865503819UL, SLOT(7));
  a = 16931431567753264544UL; b = 16376632706123834131UL;
  CRLOGIC("creqv", a, b, 12654608376528465854UL, 9769498648175256218UL, SLOT(8));
  ISEL(a, b, 12297829382473034410UL, 18446744073709551615UL, SLOT(9));
  a = 13063053146491754315UL; b = 12504398265799608224UL;
  RRCC("xor", a, b, SLOT(10), c); SLOT(11) = c;
  a = 11383109721309559405UL; b = 15925450282425024242UL;
  COUNTED(3, a, SLOT(12));
  a = 14543758040967786548UL; b = 2310012708579083352UL;
  RLWINM(a, 21, 30, 6, SLOT(13));
  RLWIMI(a, b, 21, 30, 6, SLOT(14));
  RLDICL(a, 21, 62, SLOT(15));
  RLDICR(a, 21, 6, SLOT(16));
  RLDIC(a, 21, 42, SLOT(17));
  RLDIMI(a, b, 21, 42, SLOT(18));
  a = 8106639476082295150UL; b = 9223372036854775809UL;
  ST("std", 8, a);
  LD("lbz", 8, SLOT(19));
  BREV("stdbrx", "ldbrx", 8, b, SLOT(20));
  BREV("stwbrx", "lwbrx", 8, b, SLOT(21));
  a = 9279343102563385046UL; b = 15749051110719738771UL;
  ST("std", 16, a);
  LD("lwa", 16, SLOT(22));
  BREV("stdbrx", "ldbrx", 16, b, SLOT(23));
  BREV("stwbrx", "lwbrx", 16, b, SLOT(24));
  a = 7138153481668754373UL; b = 1226310006414311510UL;
  RLWINM(a, 13, 12, 6, SLOT(25));
  RLWIMI(a, b, 13, 12, 6, SLOT(26));
  RLDICL(a, 45, 44, SLOT(27));
  RLDICR(a, 45, 38, SLOT(28));
  RLDIC(a, 45, 18, SLOT(29));
  RLDIMI(a, b, 45, 18, SLOT(30));
  a = 12839731939682392964UL; b = 9930358024040785381UL;
  IMM("addi", a, 29841, SLOT(31));
  IMM("addic", a, -9421, SLOT(32));
  IMM("mulli", a, -31255, SLOT(33));
  IMM("subfic", a, -2131, SLOT(34));
  a = 11408127576985921206UL; b = 14519901801644146441UL;
  ADD128(a, b, 1472308846647820448UL, 13642307291252091935UL, lo, hi); SLOT(35) = lo; SLOT(36) = hi;
  SUB128(a, b, 927995940116302819UL, 6284017866323524978UL, lo, hi); SLOT(37) = lo; SLOT(38) = hi;
  CARRYEXT("subfze", a, b, SLOT(39));
  a = 8019885951186233537UL; b = 8647679561354572257UL;
  RLWINM(a, 19, 11, 26, SLOT(40));
  RLWIMI(a, b, 19, 11, 26, SLOT(41));
  RLDICL(a, 51, 43, SLOT(42));
  RLDICR(a, 51, 26, SLOT(43));
  RLDIC(a, 51, 12, SLOT(44));
  RLDIMI(a, b, 51, 12, SLOT(45));
  a = 4951776975448602809UL; b = 18446744073709551614UL;
  IMM("addi", a, 24542, SLOT(46));
  IMM("addic", a, -2680, SLOT(47));
  IMM("mulli", a, 19690, SLOT(48));
  IMM("subfic", a, 5637, SLOT(49));
  a = 6577329978138374532UL; b = 6187518689812488559UL;
  CRLOGIC("crnor", a, b, 7216412215930404024UL, 2399257383871119510UL, SLOT(50));
  ISEL(a, b, 0UL, 2147483648UL, SLOT(51));
  a = 11611512022917131444UL; b = 9337523396128163228UL;
  COUNTED(8, a, SLOT(52));
  a = 8272810503752108321UL; b = 7530337506735867591UL;
  ADD128(a, b, 1691122783640780436UL, 18063112842360980727UL, lo, hi); SLOT(53) = lo; SLOT(54) = hi;
  SUB128(a, b, 6497361259447860340UL, 4373376671811141067UL, lo, hi); SLOT(55) = lo; SLOT(56) = hi;
  CARRYEXT("addze", a, b, SLOT(57));
  a = 4441156457277476524UL; b = 18446744073709551614UL;
  COUNTED(4, a, SLOT(58));
  a = 7638977473203743548UL; b = 5647918370964808955UL;
  RLWINM(a, 0, 2, 0, SLOT(59));
  RLWIMI(a, b, 0, 2, 0, SLOT(60));
  RLDICL(a, 32, 2, SLOT(61));
  RLDICR(a, 32, 0, SLOT(62));
  RLDIC(a, 32, 2, SLOT(63));
  RLDIMI(a, b, 32, 2, SLOT(64));
  a = 17564519762099246748UL; b = 11881029579260210403UL;
  IMM("addi", a, 31249, SLOT(65));
  IMM("addic", a, -8491, SLOT(66));
  IMM("mulli", a, -3625, SLOT(67));
  IMM("subfic", a, -21419, SLOT(68));
  a = 6148914691236517205UL; b = 7194113003300682422UL;
  RR("or", a, b, SLOT(69));
  a = 7025428490459674678UL; b = 5883568815806665000UL;
  ADD128(a, b, 18033194281686465396UL, 9520709824454257852UL, lo, hi); SLOT(70) = lo; SLOT(71) = hi;
  SUB128(a, b, 9858605094323313927UL, 10573876561558506456UL, lo, hi); SLOT(72) = lo; SLOT(73) = hi;
  CARRYEXT("subfze", a, b, SLOT(74));
  a = 6206223128741008700UL; b = 15450531649792761968UL;
  RRCC("and", a, b, SLOT(75), c); SLOT(76) = c;
  a = 7877227780874603254UL; b = 11512725355004046210UL;
  RR("xor", a, b, SLOT(77));
  a = 256UL; b = 1482584450847495240UL;
  ADD128(a, b, 1770036396046781337UL, 4962486618559781631UL, lo, hi); SLOT(78) = lo; SLOT(79) = hi;
  SUB128(a, b, 11950813661082444492UL, 6688560509059238467UL, lo, hi); SLOT(80) = lo; SLOT(81) = hi;
  CARRYEXT("subfze", a, b, SLOT(82));
  a = 5745229354654121537UL; b = 6863823313304850281UL;
  RR("mulhwu", a, b, SLOT(83));
  a = 4294967296UL; b = 7923867970753735610UL;
  COUNTED(8, a, SLOT(84));
  a = 10341362928103405194UL; b = 14968136718682294978UL;
  fx = 1.0; fy = 4503599627370497.0; fz = -170.645000;
  F2("fadd", fx, fy, fr); SLOT(85) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(86) = *(volatile unsigned long *)&fr;
  FMA("fmsub", fx, fy, fz, fr); SLOT(87) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(88));
  a = 255UL; b = 0UL;
  COUNTED(8, a, SLOT(89));
  a = 1UL; b = 13310986103559727238UL;
  IMM("addi", a, -18576, SLOT(90));
  IMM("addic", a, 6216, SLOT(91));
  IMM("mulli", a, -21654, SLOT(92));
  IMM("subfic", a, -23128, SLOT(93));
  a = 9223372036854775809UL; b = 10548520106065021861UL;
  COUNTED(6, a, SLOT(94));
  a = 5298366426478777214UL; b = 10859789170078089737UL;
  ADD128(a, b, 8436929557480812944UL, 5806442507805993241UL, lo, hi); SLOT(95) = lo; SLOT(96) = hi;
  SUB128(a, b, 5110136295050363120UL, 16876507987708345425UL, lo, hi); SLOT(97) = lo; SLOT(98) = hi;
  CARRYEXT("addze", a, b, SLOT(99));
  a = 13392325178739313045UL; b = 9740977157884074546UL;
  IMM("addi", a, -553, SLOT(100));
  IMM("addic", a, -15816, SLOT(101));
  IMM("mulli", a, 5051, SLOT(102));
  IMM("subfic", a, 28382, SLOT(103));
  a = 18446744073709551615UL; b = 15753888510395415873UL;
  RLWINM(a, 4, 29, 6, SLOT(104));
  RLWIMI(a, b, 4, 29, 6, SLOT(105));
  RLDICL(a, 4, 61, SLOT(106));
  RLDICR(a, 4, 38, SLOT(107));
  RLDIC(a, 4, 59, SLOT(108));
  RLDIMI(a, b, 4, 59, SLOT(109));
  a = 13724550500543029048UL; b = 927624242375697977UL;
  ST("std", 16, a);
  LD("lwz", 16, SLOT(110));
  BREV("stdbrx", "ldbrx", 16, b, SLOT(111));
  BREV("stwbrx", "lwbrx", 16, b, SLOT(112));
  a = 14523467101581279432UL; b = 13869793383661572532UL;
  fx = 1.0; fy = 0.0; fz = 4503599627370497.0;
  F2("fsub", fx, fy, fr); SLOT(113) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(114) = *(volatile unsigned long *)&fr;
  FMA("fmadd", fx, fy, fz, fr); SLOT(115) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(116));
  a = 9026381449954611137UL; b = 1UL;
  RLWINM(a, 4, 23, 12, SLOT(117));
  RLWIMI(a, b, 4, 23, 12, SLOT(118));
  RLDICL(a, 36, 23, SLOT(119));
  RLDICR(a, 36, 44, SLOT(120));
  RLDIC(a, 36, 23, SLOT(121));
  RLDIMI(a, b, 36, 23, SLOT(122));
  a = 13111309563144941192UL; b = 381076312149436957UL;
  COUNTED(7, a, SLOT(123));
  a = 7243007091760105871UL; b = 11760388961886686812UL;
  RR("and", a, b, SLOT(124));
  SLOT(125) = deep(14, 13028727390596706270UL);
  return 0;
}
