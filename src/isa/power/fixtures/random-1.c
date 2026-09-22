
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
  a = 436590262223502864UL; b = 2UL;
  ADD128(a, b, 4786037828427324454UL, 14346451351864149715UL, lo, hi); SLOT(0) = lo; SLOT(1) = hi;
  SUB128(a, b, 2UL, 16858598966181711066UL, lo, hi); SLOT(2) = lo; SLOT(3) = hi;
  CARRYEXT("addme", a, b, SLOT(4));
  a = 4360025434335743686UL; b = 10769686792793508396UL;
  COUNTED(7, a, SLOT(5));
  a = 7631886192157334897UL; b = 2UL;
  CRLOGIC("crnor", a, b, 17973080031291010875UL, 2627211111216386087UL, SLOT(6));
  ISEL(a, b, 13572391532647018167UL, 15718708603354432106UL, SLOT(7));
  a = 17325752533164125860UL; b = 936016073404024618UL;
  RR("nand", a, b, SLOT(8));
  a = 10029240737697799947UL; b = 4712321987975823596UL;
  COUNTED(7, a, SLOT(9));
  a = 4294967296UL; b = 1939340760742880153UL;
  ST("std", 40, a);
  LD("lwa", 40, SLOT(10));
  BREV("stdbrx", "ldbrx", 40, b, SLOT(11));
  BREV("stwbrx", "lwbrx", 40, b, SLOT(12));
  a = 5527040503064630278UL; b = 8147961736329035913UL;
  ST("std", 8, a);
  LD("lbz", 8, SLOT(13));
  BREV("stdbrx", "ldbrx", 8, b, SLOT(14));
  BREV("stwbrx", "lwbrx", 8, b, SLOT(15));
  a = 17898753108021377559UL; b = 7536032692250008511UL;
  CRLOGIC("crnand", a, b, 7302661776119573726UL, 14378706902437811975UL, SLOT(16));
  ISEL(a, b, 12297829382473034410UL, 2147483648UL, SLOT(17));
  a = 2147483647UL; b = 13314764746352469595UL;
  ST("std", 8, a);
  LD("lha", 8, SLOT(18));
  BREV("stdbrx", "ldbrx", 8, b, SLOT(19));
  BREV("stwbrx", "lwbrx", 8, b, SLOT(20));
  a = 5112861632716628782UL; b = 124448507301523149UL;
  ADD128(a, b, 9223372036854775808UL, 8829250534668202430UL, lo, hi); SLOT(21) = lo; SLOT(22) = hi;
  SUB128(a, b, 4294967296UL, 8477230463902711167UL, lo, hi); SLOT(23) = lo; SLOT(24) = hi;
  CARRYEXT("addze", a, b, SLOT(25));
  a = 13089897174901276219UL; b = 6659711357722870149UL;
  RRCC("nor", a, b, SLOT(26), c); SLOT(27) = c;
  a = 18084886062537171850UL; b = 17910882229855616426UL;
  RR("orc", a, b, SLOT(28));
  a = 16192227744811358763UL; b = 8754708179003919878UL;
  fx = -562.909000; fy = 1.0; fz = 114.286000;
  F2("fmul", fx, fy, fr); SLOT(29) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(30) = *(volatile unsigned long *)&fr;
  FMA("fnmadd", fx, fy, fz, fr); SLOT(31) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(32));
  a = 16676655971397700671UL; b = 9109663084172299537UL;
  RRCC("orc", a, b, SLOT(33), c); SLOT(34) = c;
  a = 7819726465037910525UL; b = 9223372036854775809UL;
  RR("slw", a, b, SLOT(35));
  a = 3612451246746343126UL; b = 9223372036854775809UL;
  ST("std", 8, a);
  LD("lwz", 8, SLOT(36));
  BREV("stdbrx", "ldbrx", 8, b, SLOT(37));
  BREV("stwbrx", "lwbrx", 8, b, SLOT(38));
  a = 1259627184068845644UL; b = 7931863414989177250UL;
  RR("mulhwu", a, b, SLOT(39));
  a = 2188658658594602437UL; b = 6608699517175212730UL;
  RR("eqv", a, b, SLOT(40));
  a = 11707662244223477037UL; b = 18446744073709551615UL;
  IMM("addi", a, 23738, SLOT(41));
  IMM("addic", a, -19996, SLOT(42));
  IMM("mulli", a, -5921, SLOT(43));
  IMM("subfic", a, -17854, SLOT(44));
  a = 1236067583686555328UL; b = 1192845636933108604UL;
  IMM("addi", a, 12939, SLOT(45));
  IMM("addic", a, -15792, SLOT(46));
  IMM("mulli", a, 26751, SLOT(47));
  IMM("subfic", a, 8255, SLOT(48));
  a = 17212721104597375950UL; b = 3162177753850382450UL;
  fx = -211.909000; fy = 1.0; fz = 215.175000;
  F2("fadd", fx, fy, fr); SLOT(49) = *(volatile unsigned long *)&fr;
  F1("fsqrt", fx, fr); SLOT(50) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(51) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(52));
  a = 2UL; b = 817547173088569690UL;
  fx = -0.0; fy = 511.342000; fz = 0.0;
  F2("fmul", fx, fy, fr); SLOT(53) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(54) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(55) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(56));
  a = 2597180295214198668UL; b = 2141084352458619737UL;
  CRLOGIC("crxor", a, b, 0UL, 14330402370566101906UL, SLOT(57));
  ISEL(a, b, 15334630760579502317UL, 14333564884796066398UL, SLOT(58));
  a = 3994454208354212989UL; b = 3082694625588859818UL;
  IMM("addi", a, -26233, SLOT(59));
  IMM("addic", a, -24242, SLOT(60));
  IMM("mulli", a, -14743, SLOT(61));
  IMM("subfic", a, 18063, SLOT(62));
  a = 9619323446533613238UL; b = 9374339247198938482UL;
  RR("andc", a, b, SLOT(63));
  a = 2818773700378225252UL; b = 7122273625029575311UL;
  COUNTED(8, a, SLOT(64));
  a = 18446744073709551615UL; b = 17015677564469357556UL;
  COUNTED(1, a, SLOT(65));
  a = 7182303624688817574UL; b = 14656877702337373541UL;
  ST("std", 16, a);
  LD("lbz", 16, SLOT(66));
  BREV("stdbrx", "ldbrx", 16, b, SLOT(67));
  BREV("stwbrx", "lwbrx", 16, b, SLOT(68));
  a = 4144362067892921865UL; b = 1UL;
  COUNTED(3, a, SLOT(69));
  a = 12297829382473034410UL; b = 256UL;
  ST("std", 8, a);
  LD("ld", 8, SLOT(70));
  BREV("stdbrx", "ldbrx", 8, b, SLOT(71));
  BREV("stwbrx", "lwbrx", 8, b, SLOT(72));
  a = 11988356662066375274UL; b = 12297829382473034410UL;
  RR("mullw", a, b, SLOT(73));
  a = 15434313810506610674UL; b = 17382558099741617255UL;
  COUNTED(8, a, SLOT(74));
  a = 3556168685326863421UL; b = 6148914691236517205UL;
  IMM("addi", a, 27990, SLOT(75));
  IMM("addic", a, 9710, SLOT(76));
  IMM("mulli", a, -6759, SLOT(77));
  IMM("subfic", a, 8833, SLOT(78));
  a = 5291540586225490843UL; b = 13326474985622829893UL;
  RR("and", a, b, SLOT(79));
  a = 15035122537973323555UL; b = 2147483647UL;
  COUNTED(8, a, SLOT(80));
  a = 18270135253556426356UL; b = 12740184900266300376UL;
  COUNTED(8, a, SLOT(81));
  a = 9193717675384185088UL; b = 2147483648UL;
  RR("nor", a, b, SLOT(82));
  a = 18446744073709551614UL; b = 9223372036854775808UL;
  COUNTED(2, a, SLOT(83));
  a = 3457692214122241262UL; b = 6639215628201317928UL;
  ST("std", 48, a);
  LD("lhz", 48, SLOT(84));
  BREV("stdbrx", "ldbrx", 48, b, SLOT(85));
  BREV("stwbrx", "lwbrx", 48, b, SLOT(86));
  a = 16106236511461723733UL; b = 17261498756278181312UL;
  RR("orc", a, b, SLOT(87));
  SLOT(88) = deep(14, 6148914691236517205UL);
  return 0;
}
