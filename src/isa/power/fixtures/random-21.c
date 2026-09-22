
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
  a = 1UL; b = 256UL;
  ST("std", 0, a);
  LD("ld", 0, SLOT(0));
  BREV("stdbrx", "ldbrx", 0, b, SLOT(1));
  BREV("stwbrx", "lwbrx", 0, b, SLOT(2));
  a = 9223372036854775809UL; b = 10609554047280831943UL;
  IMM("addi", a, -19496, SLOT(3));
  IMM("addic", a, 17286, SLOT(4));
  IMM("mulli", a, 9812, SLOT(5));
  IMM("subfic", a, -2606, SLOT(6));
  a = 1868181231890434898UL; b = 7496266668327996212UL;
  ST("std", 48, a);
  LD("lha", 48, SLOT(7));
  BREV("stdbrx", "ldbrx", 48, b, SLOT(8));
  BREV("stwbrx", "lwbrx", 48, b, SLOT(9));
  a = 13419092398080564197UL; b = 11430067996423258758UL;
  ST("std", 0, a);
  LD("lwz", 0, SLOT(10));
  BREV("stdbrx", "ldbrx", 0, b, SLOT(11));
  BREV("stwbrx", "lwbrx", 0, b, SLOT(12));
  a = 764935185110690340UL; b = 5807796500906790628UL;
  RRCC("and", a, b, SLOT(13), c); SLOT(14) = c;
  a = 4092876801938423455UL; b = 14475641249836049386UL;
  ST("std", 56, a);
  LD("lhz", 56, SLOT(15));
  BREV("stdbrx", "ldbrx", 56, b, SLOT(16));
  BREV("stwbrx", "lwbrx", 56, b, SLOT(17));
  a = 12297829382473034410UL; b = 14033906599922389861UL;
  RRCC("andc", a, b, SLOT(18), c); SLOT(19) = c;
  a = 17120769176924208143UL; b = 0UL;
  CRLOGIC("crorc", a, b, 9223372036854775809UL, 10623030855520999567UL, SLOT(20));
  ISEL(a, b, 7582238046699996052UL, 16683509509259707545UL, SLOT(21));
  a = 4949883211832602760UL; b = 689249749127849699UL;
  fx = -0.0; fy = 649.616000; fz = 268.863000;
  F2("fadd", fx, fy, fr); SLOT(22) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(23) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(24) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(25));
  a = 2UL; b = 3634177739054380309UL;
  RR("eqv", a, b, SLOT(26));
  a = 1141493573577484993UL; b = 12567168502004117840UL;
  COUNTED(3, a, SLOT(27));
  a = 7693044222076621966UL; b = 9223372036854775809UL;
  ST("std", 0, a);
  LD("lhz", 0, SLOT(28));
  BREV("stdbrx", "ldbrx", 0, b, SLOT(29));
  BREV("stwbrx", "lwbrx", 0, b, SLOT(30));
  a = 17129694626521859946UL; b = 3627997772213294553UL;
  RR("orc", a, b, SLOT(31));
  a = 10776412797974994418UL; b = 13686756228111024416UL;
  RR("mulhwu", a, b, SLOT(32));
  a = 12093549050680773162UL; b = 4787921343957666096UL;
  CRLOGIC("creqv", a, b, 18446744073709551614UL, 10655226939948921568UL, SLOT(33));
  ISEL(a, b, 4294967295UL, 14471475860138833715UL, SLOT(34));
  a = 6172060944440090655UL; b = 15288252162966079812UL;
  ADD128(a, b, 2UL, 7866821956855563282UL, lo, hi); SLOT(35) = lo; SLOT(36) = hi;
  SUB128(a, b, 11206427028787137410UL, 4294967296UL, lo, hi); SLOT(37) = lo; SLOT(38) = hi;
  CARRYEXT("addze", a, b, SLOT(39));
  a = 8914201911452998492UL; b = 10750360727222840567UL;
  COUNTED(4, a, SLOT(40));
  a = 17182256675413518100UL; b = 17353161007527148879UL;
  RR("divwu", a, b, SLOT(41));
  a = 2802729916487039592UL; b = 4061886947544450493UL;
  ST("std", 0, a);
  LD("lhz", 0, SLOT(42));
  BREV("stdbrx", "ldbrx", 0, b, SLOT(43));
  BREV("stwbrx", "lwbrx", 0, b, SLOT(44));
  a = 14730769161483137438UL; b = 2214819704976468704UL;
  RLWINM(a, 17, 13, 8, SLOT(45));
  RLWIMI(a, b, 17, 13, 8, SLOT(46));
  RLDICL(a, 17, 45, SLOT(47));
  RLDICR(a, 17, 40, SLOT(48));
  RLDIC(a, 17, 45, SLOT(49));
  RLDIMI(a, b, 17, 45, SLOT(50));
  a = 1UL; b = 5772804949653488351UL;
  RLWINM(a, 31, 31, 3, SLOT(51));
  RLWIMI(a, b, 31, 31, 3, SLOT(52));
  RLDICL(a, 63, 31, SLOT(53));
  RLDICR(a, 63, 35, SLOT(54));
  RLDIC(a, 63, 0, SLOT(55));
  RLDIMI(a, b, 63, 0, SLOT(56));
  a = 1496153038145041238UL; b = 8608019400465509661UL;
  ST("std", 40, a);
  LD("ld", 40, SLOT(57));
  BREV("stdbrx", "ldbrx", 40, b, SLOT(58));
  BREV("stwbrx", "lwbrx", 40, b, SLOT(59));
  a = 13314421635205156179UL; b = 9997440167710838392UL;
  RLWINM(a, 22, 9, 4, SLOT(60));
  RLWIMI(a, b, 22, 9, 4, SLOT(61));
  RLDICL(a, 22, 9, SLOT(62));
  RLDICR(a, 22, 4, SLOT(63));
  RLDIC(a, 22, 9, SLOT(64));
  RLDIMI(a, b, 22, 9, SLOT(65));
  a = 14525860553548816062UL; b = 2147483648UL;
  ADD128(a, b, 4977765483155813609UL, 255UL, lo, hi); SLOT(66) = lo; SLOT(67) = hi;
  SUB128(a, b, 9223372036854775807UL, 70590529357356481UL, lo, hi); SLOT(68) = lo; SLOT(69) = hi;
  CARRYEXT("subfze", a, b, SLOT(70));
  a = 5705144378149199834UL; b = 12748902632690864212UL;
  RRCC("and", a, b, SLOT(71), c); SLOT(72) = c;
  a = 1291775017411802477UL; b = 2UL;
  IMM("addi", a, -27862, SLOT(73));
  IMM("addic", a, -6898, SLOT(74));
  IMM("mulli", a, -14288, SLOT(75));
  IMM("subfic", a, -31423, SLOT(76));
  a = 2742760771262082049UL; b = 9223372036854775807UL;
  RR("divdu", a, b, SLOT(77));
  a = 18446744073709551614UL; b = 10564594458687825824UL;
  RRCC("andc", a, b, SLOT(78), c); SLOT(79) = c;
  a = 8523319374260232404UL; b = 13255981813084248806UL;
  RLWINM(a, 2, 10, 2, SLOT(80));
  RLWIMI(a, b, 2, 10, 2, SLOT(81));
  RLDICL(a, 34, 42, SLOT(82));
  RLDICR(a, 34, 2, SLOT(83));
  RLDIC(a, 34, 29, SLOT(84));
  RLDIMI(a, b, 34, 29, SLOT(85));
  a = 12589157585898491162UL; b = 17426011019234614871UL;
  ST("std", 8, a);
  LD("lwz", 8, SLOT(86));
  BREV("stdbrx", "ldbrx", 8, b, SLOT(87));
  BREV("stwbrx", "lwbrx", 8, b, SLOT(88));
  a = 7394663188953602779UL; b = 4294967296UL;
  RR("andc", a, b, SLOT(89));
  a = 10672234645496394225UL; b = 12297829382473034410UL;
  RR("mulhwu", a, b, SLOT(90));
  a = 18426234839618352527UL; b = 352569953562781256UL;
  CRLOGIC("cror", a, b, 4116992049001054726UL, 9438252684290606087UL, SLOT(91));
  ISEL(a, b, 8152808671840902222UL, 7856783885913988841UL, SLOT(92));
  a = 4313575728818482880UL; b = 14318515043463225685UL;
  RR("and", a, b, SLOT(93));
  a = 4294967295UL; b = 1UL;
  RRCC("andc", a, b, SLOT(94), c); SLOT(95) = c;
  a = 17866379174656806409UL; b = 1UL;
  IMM("addi", a, 22140, SLOT(96));
  IMM("addic", a, 11759, SLOT(97));
  IMM("mulli", a, 23514, SLOT(98));
  IMM("subfic", a, -30551, SLOT(99));
  a = 18446744073709551614UL; b = 255UL;
  ST("std", 8, a);
  LD("lbz", 8, SLOT(100));
  BREV("stdbrx", "ldbrx", 8, b, SLOT(101));
  BREV("stwbrx", "lwbrx", 8, b, SLOT(102));
  a = 9666735238912635915UL; b = 5746163283876612772UL;
  ADD128(a, b, 15438529553758216674UL, 5873938233996431575UL, lo, hi); SLOT(103) = lo; SLOT(104) = hi;
  SUB128(a, b, 2268890297404543485UL, 2147483647UL, lo, hi); SLOT(105) = lo; SLOT(106) = hi;
  CARRYEXT("addze", a, b, SLOT(107));
  a = 8354731979176336748UL; b = 3253053313741464320UL;
  RRCC("nor", a, b, SLOT(108), c); SLOT(109) = c;
  a = 16559314783364890283UL; b = 11263358443295524282UL;
  fx = 238.842000; fy = 0.0; fz = 864.317000;
  F2("fsub", fx, fy, fr); SLOT(110) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(111) = *(volatile unsigned long *)&fr;
  FMA("fmsub", fx, fy, fz, fr); SLOT(112) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(113));
  SLOT(114) = deep(13, 9223372036854775808UL);
  return 0;
}
