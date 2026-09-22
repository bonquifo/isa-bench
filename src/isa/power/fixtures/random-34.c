
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
  a = 15227507683010486763UL; b = 7558296542217854350UL;
  COUNTED(7, a, SLOT(0));
  a = 255UL; b = 9223372036854775807UL;
  RRCC("andc", a, b, SLOT(1), c); SLOT(2) = c;
  a = 16766461274273489047UL; b = 4877666837695934138UL;
  IMM("addi", a, 16286, SLOT(3));
  IMM("addic", a, 4382, SLOT(4));
  IMM("mulli", a, 9490, SLOT(5));
  IMM("subfic", a, 13103, SLOT(6));
  a = 6148914691236517205UL; b = 1944943079698853152UL;
  ADD128(a, b, 11250790882584726471UL, 5814862408542381901UL, lo, hi); SLOT(7) = lo; SLOT(8) = hi;
  SUB128(a, b, 15093491273920042845UL, 4534361386572145012UL, lo, hi); SLOT(9) = lo; SLOT(10) = hi;
  CARRYEXT("subfme", a, b, SLOT(11));
  a = 4462704613621288364UL; b = 17236618894878874951UL;
  RR("divw", a, b, SLOT(12));
  a = 17133415013951094256UL; b = 11351959450234144222UL;
  RR("nor", a, b, SLOT(13));
  a = 6148914691236517205UL; b = 13953368607472398840UL;
  COUNTED(1, a, SLOT(14));
  a = 13183417917216882380UL; b = 12297829382473034410UL;
  RR("mulhwu", a, b, SLOT(15));
  a = 3100652219235221145UL; b = 0UL;
  COUNTED(6, a, SLOT(16));
  a = 10628028161360014297UL; b = 6897833708965727239UL;
  RR("slw", a, b, SLOT(17));
  a = 4734890905748296219UL; b = 7504343506765470554UL;
  CRLOGIC("crandc", a, b, 2889742405919458447UL, 722918895012526935UL, SLOT(18));
  ISEL(a, b, 8367122999066888259UL, 1UL, SLOT(19));
  a = 16099316792266622565UL; b = 8365794864473693670UL;
  RRCC("eqv", a, b, SLOT(20), c); SLOT(21) = c;
  a = 2778811833115540171UL; b = 1245632094103947616UL;
  IMM("addi", a, -13168, SLOT(22));
  IMM("addic", a, -11752, SLOT(23));
  IMM("mulli", a, -10356, SLOT(24));
  IMM("subfic", a, 25480, SLOT(25));
  a = 4239118202528549058UL; b = 16453970987696414332UL;
  ADD128(a, b, 5743734704693180869UL, 0UL, lo, hi); SLOT(26) = lo; SLOT(27) = hi;
  SUB128(a, b, 7577866318086173989UL, 16396723701513181703UL, lo, hi); SLOT(28) = lo; SLOT(29) = hi;
  CARRYEXT("addme", a, b, SLOT(30));
  a = 7555957305574700400UL; b = 256UL;
  CRLOGIC("crand", a, b, 2625618428084123583UL, 256UL, SLOT(31));
  ISEL(a, b, 6148914691236517205UL, 256UL, SLOT(32));
  a = 18046422869016213731UL; b = 10295083128883588055UL;
  RLWINM(a, 17, 13, 10, SLOT(33));
  RLWIMI(a, b, 17, 13, 10, SLOT(34));
  RLDICL(a, 49, 13, SLOT(35));
  RLDICR(a, 49, 10, SLOT(36));
  RLDIC(a, 49, 13, SLOT(37));
  RLDIMI(a, b, 49, 13, SLOT(38));
  a = 17927221817245442061UL; b = 13421368411488256617UL;
  COUNTED(2, a, SLOT(39));
  a = 11108880038804603419UL; b = 5555975816506691872UL;
  CRLOGIC("cror", a, b, 16687718769344011112UL, 13695527898926502008UL, SLOT(40));
  ISEL(a, b, 14928059784671103792UL, 16511388309081477266UL, SLOT(41));
  a = 1017927810761891053UL; b = 1UL;
  CRLOGIC("creqv", a, b, 18446744073709551615UL, 12297829382473034410UL, SLOT(42));
  ISEL(a, b, 4294967295UL, 4294967296UL, SLOT(43));
  a = 150352466649385462UL; b = 18176852655175504623UL;
  ST("std", 0, a);
  LD("lha", 0, SLOT(44));
  BREV("stdbrx", "ldbrx", 0, b, SLOT(45));
  BREV("stwbrx", "lwbrx", 0, b, SLOT(46));
  a = 1820485137530402773UL; b = 3624022965594978419UL;
  CRLOGIC("cror", a, b, 256UL, 8979805228176632204UL, SLOT(47));
  ISEL(a, b, 14371171871648754960UL, 0UL, SLOT(48));
  a = 776321199846457488UL; b = 15473156771878155339UL;
  IMM("addi", a, 5648, SLOT(49));
  IMM("addic", a, -15753, SLOT(50));
  IMM("mulli", a, 9156, SLOT(51));
  IMM("subfic", a, -22777, SLOT(52));
  a = 4471258937960872863UL; b = 553511027161194295UL;
  ST("std", 0, a);
  LD("lhz", 0, SLOT(53));
  BREV("stdbrx", "ldbrx", 0, b, SLOT(54));
  BREV("stwbrx", "lwbrx", 0, b, SLOT(55));
  a = 18446744073709551614UL; b = 14718016467239095974UL;
  RR("mulhd", a, b, SLOT(56));
  a = 0UL; b = 3205866829637745264UL;
  RLWINM(a, 2, 28, 1, SLOT(57));
  RLWIMI(a, b, 2, 28, 1, SLOT(58));
  RLDICL(a, 2, 60, SLOT(59));
  RLDICR(a, 2, 33, SLOT(60));
  RLDIC(a, 2, 60, SLOT(61));
  RLDIMI(a, b, 2, 60, SLOT(62));
  a = 18112908521436316223UL; b = 1411930185450288300UL;
  fx = -680.369000; fy = 1.0; fz = -0.0;
  F2("fmul", fx, fy, fr); SLOT(63) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(64) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(65) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(66));
  a = 8037016464542560469UL; b = 15032092595779187107UL;
  RR("subf", a, b, SLOT(67));
  a = 16241693961214059175UL; b = 1893349717793897032UL;
  ADD128(a, b, 9223372036854775809UL, 6148914691236517205UL, lo, hi); SLOT(68) = lo; SLOT(69) = hi;
  SUB128(a, b, 3853973194380281753UL, 836335642575934527UL, lo, hi); SLOT(70) = lo; SLOT(71) = hi;
  CARRYEXT("addme", a, b, SLOT(72));
  a = 255UL; b = 10608505242059979739UL;
  ADD128(a, b, 3038019838885132009UL, 18043069362775230837UL, lo, hi); SLOT(73) = lo; SLOT(74) = hi;
  SUB128(a, b, 16696519510798571034UL, 0UL, lo, hi); SLOT(75) = lo; SLOT(76) = hi;
  CARRYEXT("subfze", a, b, SLOT(77));
  a = 12065866306996120694UL; b = 9223372036854775807UL;
  COUNTED(5, a, SLOT(78));
  a = 8886514754255623824UL; b = 5920928616370590341UL;
  CRLOGIC("cror", a, b, 10526639988631805255UL, 2UL, SLOT(79));
  ISEL(a, b, 8259518820834708636UL, 16557441266690525708UL, SLOT(80));
  a = 17332709640258035015UL; b = 408816125702955456UL;
  COUNTED(5, a, SLOT(81));
  a = 12282247204328663390UL; b = 10030720213219053815UL;
  ADD128(a, b, 3777630433916404751UL, 684181642705714758UL, lo, hi); SLOT(82) = lo; SLOT(83) = hi;
  SUB128(a, b, 12857422450178294932UL, 2270783664801010245UL, lo, hi); SLOT(84) = lo; SLOT(85) = hi;
  CARRYEXT("subfze", a, b, SLOT(86));
  a = 18446744073709551614UL; b = 11207972507263434152UL;
  RR("eqv", a, b, SLOT(87));
  a = 2147483647UL; b = 4294967296UL;
  COUNTED(6, a, SLOT(88));
  a = 9218663363638743432UL; b = 14437367884567761654UL;
  RRCC("andc", a, b, SLOT(89), c); SLOT(90) = c;
  a = 4294967296UL; b = 255UL;
  CRLOGIC("crand", a, b, 17588162113860319060UL, 2UL, SLOT(91));
  ISEL(a, b, 6404217389910754516UL, 256UL, SLOT(92));
  a = 14211320807169718468UL; b = 17917908960533574479UL;
  COUNTED(1, a, SLOT(93));
  a = 10011308558199912214UL; b = 17383833013113040189UL;
  ADD128(a, b, 10034522948882585314UL, 10486613097213684001UL, lo, hi); SLOT(94) = lo; SLOT(95) = hi;
  SUB128(a, b, 6472721064408196445UL, 9223372036854775808UL, lo, hi); SLOT(96) = lo; SLOT(97) = hi;
  CARRYEXT("addme", a, b, SLOT(98));
  a = 18446744073709551615UL; b = 9259757265180274504UL;
  RR("divw", a, b, SLOT(99));
  SLOT(100) = deep(19, 14403078599400373991UL);
  return 0;
}
