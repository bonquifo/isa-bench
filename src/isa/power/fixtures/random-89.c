
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
  a = 15766776370445372642UL; b = 15588844488808701724UL;
  fx = 0.0; fy = 0.0; fz = 1.0;
  F2("fmul", fx, fy, fr); SLOT(0) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(1) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(2) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(3));
  a = 10500386932593972063UL; b = 9438543777692106114UL;
  RLWINM(a, 12, 21, 6, SLOT(4));
  RLWIMI(a, b, 12, 21, 6, SLOT(5));
  RLDICL(a, 44, 53, SLOT(6));
  RLDICR(a, 44, 6, SLOT(7));
  RLDIC(a, 44, 19, SLOT(8));
  RLDIMI(a, b, 44, 19, SLOT(9));
  a = 17470272463967438867UL; b = 18446744073709551615UL;
  RR("srw", a, b, SLOT(10));
  a = 8714073354812362894UL; b = 6466498055045375265UL;
  RR("mulhwu", a, b, SLOT(11));
  a = 14008146355729209962UL; b = 9223372036854775808UL;
  ST("std", 56, a);
  LD("lwa", 56, SLOT(12));
  BREV("stdbrx", "ldbrx", 56, b, SLOT(13));
  BREV("stwbrx", "lwbrx", 56, b, SLOT(14));
  a = 18027352736030940408UL; b = 9223372036854775809UL;
  RR("srd", a, b, SLOT(15));
  a = 9854413260777363537UL; b = 6547179094579817080UL;
  ST("std", 16, a);
  LD("lha", 16, SLOT(16));
  BREV("stdbrx", "ldbrx", 16, b, SLOT(17));
  BREV("stwbrx", "lwbrx", 16, b, SLOT(18));
  a = 14919401664731321970UL; b = 14760544576624501189UL;
  RR("mulhd", a, b, SLOT(19));
  a = 12613949189224766180UL; b = 18446744073709551615UL;
  fx = 247.515000; fy = -446.206000; fz = -365.005000;
  F2("fadd", fx, fy, fr); SLOT(20) = *(volatile unsigned long *)&fr;
  F1("fsqrt", fx, fr); SLOT(21) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(22) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(23));
  a = 2147483647UL; b = 1340057425236342325UL;
  CRLOGIC("creqv", a, b, 17089769005549400021UL, 2147483648UL, SLOT(24));
  ISEL(a, b, 11903011767253622003UL, 5569912922142139879UL, SLOT(25));
  a = 7241862618034439381UL; b = 15048307019476504477UL;
  COUNTED(6, a, SLOT(26));
  a = 4294967295UL; b = 7457619001053915861UL;
  RR("xor", a, b, SLOT(27));
  a = 9988731805213533881UL; b = 9213388076354656968UL;
  RRCC("eqv", a, b, SLOT(28), c); SLOT(29) = c;
  a = 2147483647UL; b = 17913824697020602811UL;
  fx = 0.0; fy = -981.871000; fz = -464.538000;
  F2("fmul", fx, fy, fr); SLOT(30) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(31) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(32) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(33));
  a = 16300169778224986733UL; b = 14233467720714177584UL;
  CRLOGIC("creqv", a, b, 9338755372575808027UL, 10402281906238575789UL, SLOT(34));
  ISEL(a, b, 10861218224111736146UL, 6144550237951769104UL, SLOT(35));
  a = 9223372036854775809UL; b = 5414120059280758185UL;
  fx = 4503599627370497.0; fy = -235.499000; fz = -321.081000;
  F2("fdiv", fx, fy, fr); SLOT(36) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(37) = *(volatile unsigned long *)&fr;
  FMA("fmsub", fx, fy, fz, fr); SLOT(38) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(39));
  a = 2912793382388265453UL; b = 2147483648UL;
  IMM("addi", a, -25321, SLOT(40));
  IMM("addic", a, 6639, SLOT(41));
  IMM("mulli", a, -15662, SLOT(42));
  IMM("subfic", a, -22084, SLOT(43));
  a = 3318347607635941754UL; b = 12297829382473034410UL;
  fx = 404.242000; fy = -307.498000; fz = -886.583000;
  F2("fsub", fx, fy, fr); SLOT(44) = *(volatile unsigned long *)&fr;
  F1("fneg", fx, fr); SLOT(45) = *(volatile unsigned long *)&fr;
  FMA("fmadd", fx, fy, fz, fr); SLOT(46) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(47));
  a = 4294967295UL; b = 2UL;
  RR("divd", a, b, SLOT(48));
  a = 1648822822331825139UL; b = 6148914691236517205UL;
  ST("std", 16, a);
  LD("ld", 16, SLOT(49));
  BREV("stdbrx", "ldbrx", 16, b, SLOT(50));
  BREV("stwbrx", "lwbrx", 16, b, SLOT(51));
  a = 7521878834492261344UL; b = 18446744073709551615UL;
  RLWINM(a, 27, 23, 4, SLOT(52));
  RLWIMI(a, b, 27, 23, 4, SLOT(53));
  RLDICL(a, 59, 23, SLOT(54));
  RLDICR(a, 59, 36, SLOT(55));
  RLDIC(a, 59, 4, SLOT(56));
  RLDIMI(a, b, 59, 4, SLOT(57));
  a = 5366661172639696703UL; b = 1989416634515448015UL;
  CRLOGIC("crnand", a, b, 12659978980718363518UL, 256UL, SLOT(58));
  ISEL(a, b, 2134349230674836422UL, 1390022484863934047UL, SLOT(59));
  a = 6658043889705198401UL; b = 14790297994710097237UL;
  fx = 0.0; fy = 1.0; fz = 494.086000;
  F2("fadd", fx, fy, fr); SLOT(60) = *(volatile unsigned long *)&fr;
  F1("fmr", fx, fr); SLOT(61) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(62) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(63));
  a = 7377048103799376306UL; b = 9005348194678627217UL;
  COUNTED(4, a, SLOT(64));
  a = 15986785744404172563UL; b = 247680576846939699UL;
  IMM("addi", a, 6478, SLOT(65));
  IMM("addic", a, 30409, SLOT(66));
  IMM("mulli", a, 29272, SLOT(67));
  IMM("subfic", a, -23899, SLOT(68));
  a = 10045606883236390058UL; b = 18446744073709551615UL;
  CRLOGIC("crorc", a, b, 161622835428612416UL, 16852713834962896895UL, SLOT(69));
  ISEL(a, b, 18446744073709551615UL, 2876917517000554163UL, SLOT(70));
  a = 0UL; b = 7630009703974847876UL;
  fx = -0.0; fy = -616.913000; fz = -515.117000;
  F2("fmul", fx, fy, fr); SLOT(71) = *(volatile unsigned long *)&fr;
  F1("fabs", fx, fr); SLOT(72) = *(volatile unsigned long *)&fr;
  FMA("fnmsub", fx, fy, fz, fr); SLOT(73) = *(volatile unsigned long *)&fr;
  FCMP(fx, fy, SLOT(74));
  a = 4108905015340073368UL; b = 9917017246285759326UL;
  ADD128(a, b, 10254966818498792286UL, 18073364894873476554UL, lo, hi); SLOT(75) = lo; SLOT(76) = hi;
  SUB128(a, b, 9223372036854775809UL, 14919615921347384344UL, lo, hi); SLOT(77) = lo; SLOT(78) = hi;
  CARRYEXT("subfze", a, b, SLOT(79));
  a = 930240863750283560UL; b = 8496455329240822064UL;
  RR("sld", a, b, SLOT(80));
  a = 9223372036854775809UL; b = 1843482044940390516UL;
  RR("andc", a, b, SLOT(81));
  a = 16977152970545565092UL; b = 6405209539551360884UL;
  ST("std", 56, a);
  LD("lwz", 56, SLOT(82));
  BREV("stdbrx", "ldbrx", 56, b, SLOT(83));
  BREV("stwbrx", "lwbrx", 56, b, SLOT(84));
  a = 10295373087050333795UL; b = 2147483648UL;
  ST("std", 32, a);
  LD("lha", 32, SLOT(85));
  BREV("stdbrx", "ldbrx", 32, b, SLOT(86));
  BREV("stwbrx", "lwbrx", 32, b, SLOT(87));
  a = 13701410209747348141UL; b = 13893873196308593975UL;
  ST("std", 56, a);
  LD("lbz", 56, SLOT(88));
  BREV("stdbrx", "ldbrx", 56, b, SLOT(89));
  BREV("stwbrx", "lwbrx", 56, b, SLOT(90));
  a = 11741558274284385787UL; b = 256UL;
  CRLOGIC("crandc", a, b, 12359595180330829178UL, 6928611961817763763UL, SLOT(91));
  ISEL(a, b, 9223372036854775807UL, 255UL, SLOT(92));
  a = 1389774660187100174UL; b = 255UL;
  COUNTED(2, a, SLOT(93));
  a = 11428711329466850735UL; b = 0UL;
  ADD128(a, b, 2345048430165702227UL, 8233071185662494827UL, lo, hi); SLOT(94) = lo; SLOT(95) = hi;
  SUB128(a, b, 13430095621893665485UL, 2UL, lo, hi); SLOT(96) = lo; SLOT(97) = hi;
  CARRYEXT("subfze", a, b, SLOT(98));
  a = 2147483648UL; b = 100722409050556993UL;
  COUNTED(8, a, SLOT(99));
  a = 13152384685435607158UL; b = 9223372036854775808UL;
  ST("std", 32, a);
  LD("lwa", 32, SLOT(100));
  BREV("stdbrx", "ldbrx", 32, b, SLOT(101));
  BREV("stwbrx", "lwbrx", 32, b, SLOT(102));
  a = 4294967296UL; b = 15572945248284632177UL;
  ST("std", 56, a);
  LD("lha", 56, SLOT(103));
  BREV("stdbrx", "ldbrx", 56, b, SLOT(104));
  BREV("stwbrx", "lwbrx", 56, b, SLOT(105));
  a = 18446744073709551615UL; b = 4294967296UL;
  RRCC("nand", a, b, SLOT(106), c); SLOT(107) = c;
  SLOT(108) = deep(23, 10859446904005393979UL);
  return 0;
}
