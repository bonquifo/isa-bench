/**
 * Seeded generator for randomised SPARC V8 differential programs.
 *
 * Same shape as the other generators. What is worth generating here is
 * decided by which parts of this architecture a plausible
 * implementation gets almost right.
 *
 * **The carry flag is a borrow.** After `subcc`, C is set when the
 * subtraction needed to borrow, which is the opposite of what an
 * implementation carried over from x86 or ARM would produce. A wrong
 * sense is invisible in ordinary code and wrong in every multi-word
 * subtraction, so the generator builds 64-bit adds and subtracts out of
 * `addcc`/`addx` and `subcc`/`subx` pairs and reads the answer back.
 *
 * **The annul bit means two different things.** On a conditional branch
 * it annuls the delay instruction when the branch is *not* taken; on an
 * unconditional one it annuls always. Every generated annulling branch
 * therefore appears in both a taken and an untaken case, with something
 * observable in the slot.
 *
 * **`%y` is written by one instruction and read by another.** A
 * multiply leaves the high half there and a divide takes its high
 * dividend word from it, several instructions later, so interleaving
 * them finds orderings a fixed program does not.
 *
 * **Register windows run out.** Nested calls are generated to a depth
 * past the eight windows the hardware has, so the spill and fill paths
 * are reached rather than assumed.
 */

/** xorshift64*, so a seed reproduces a program exactly on any machine. */
function rng(seed: number): () => bigint {
  let state = BigInt.asUintN(64, BigInt(seed) * 0x9e3779b97f4a7c15n + 1n) || 1n
  return () => {
    state ^= state >> 12n
    state = BigInt.asUintN(64, state ^ (state << 25n))
    state ^= state >> 27n
    return BigInt.asUintN(64, state * 0x2545f4914f6cdd1dn)
  }
}

const BOUNDARY = [
  0n, 1n, 0xffffffffn, 2n, 0x7fffffffn, 0x80000000n, 0x80000001n,
  0xfffffffen, 0x55555555n, 0xaaaaaaaan, 0xffn, 0x100n, 0xffffn, 0x10000n,
  3n, 0x7fffn,
]

/** Register-to-register forms, in both the plain and flag-setting kinds. */
const RR = ['add', 'sub', 'and', 'or', 'xor', 'andn', 'orn', 'xnor']
/** The shifts, whose amount is taken modulo 32. */
const SHIFTS = ['sll', 'srl', 'sra']
/** Every integer branch condition, so each one's flag reading is covered. */
const CONDITIONS = [
  'e', 'ne', 'l', 'le', 'g', 'ge', 'lu', 'leu', 'gu', 'geu',
  'neg', 'pos', 'vs', 'vc',
]
/** Every floating-point branch condition, including the unordered ones. */
const FP_BRANCHES = [
  'fbe', 'fbne', 'fbl', 'fble', 'fbg', 'fbge', 'fbu', 'fbo',
  'fbue', 'fbul', 'fbug', 'fblg',
]

/**
 * A floating-point operand.
 *
 * Mostly ordinary values, with zero, a negative and something large
 * mixed in so the comparison reaches the unordered and the inexact
 * cases rather than only the easy ones.
 */
function fpValue(next: () => bigint): string {
  const choice = Number(next() % 8n)
  if (choice === 0) return '0.0'
  if (choice === 1) return '-0.0'
  if (choice === 2) return '1.0'
  const magnitude = Number(next() % 100000n) / 1000
  const sign = next() % 2n === 0n ? '' : '-'
  // Always with a decimal point: `12f` is not a float literal in C, and
  // `0f` is not even a valid integer one.
  return `${sign}${magnitude.toFixed(3)}`
}

const PRELUDE = String.raw`
#include "harness.h"

#define SLOT(i) (((unsigned int *)isa_dump.scratch)[i])
#define BUF ((volatile unsigned char *)(isa_dump.scratch + 512))

/* Plain register-to-register, no flags. */
#define RR(insn, a, b, out) do {                                        \
  unsigned int r_, x_ = (a), y_ = (b);                                  \
  __asm__ volatile(insn " %1, %2, %0" : "=r"(r_) : "r"(x_), "r"(y_));   \
  (out) = r_; } while (0)

/* The flag-setting form, with the carry read straight back out. addx
   of two zeroes is zero plus zero plus carry, which is the only way a
   user-mode program can see that bit. */
#define RRCC(insn, a, b, out, cy) do {                                  \
  unsigned int r_, c_, x_ = (a), y_ = (b);                              \
  __asm__ volatile(insn "cc %2, %3, %0\n\t"                             \
                   "addx %%g0, %%g0, %1"                                \
                   : "=&r"(r_), "=&r"(c_) : "r"(x_), "r"(y_) : "cc");   \
  (out) = r_; (cy) = c_; } while (0)

#define IMM(insn, a, imm, out) do {                                     \
  unsigned int r_, x_ = (a);                                            \
  __asm__ volatile(insn " %1, " #imm ", %0" : "=r"(r_) : "r"(x_));      \
  (out) = r_; } while (0)

#define SH(insn, a, b, out) do {                                        \
  unsigned int r_, x_ = (a), y_ = (b);                                  \
  __asm__ volatile(insn " %1, %2, %0" : "=r"(r_) : "r"(x_), "r"(y_));   \
  (out) = r_; } while (0)

/* A 64-bit add out of two 32-bit ones, which is what the carry flag is
   for and where a wrong sense of it shows up immediately. */
#define ADD64(alo, ahi, blo, bhi, lo_out, hi_out) do {                  \
  unsigned int l_, h_, al_ = (alo), ah_ = (ahi), bl_ = (blo), bh_ = (bhi); \
  __asm__ volatile("addcc %2, %4, %0\n\t"                               \
                   "addx %3, %5, %1"                                    \
                   : "=&r"(l_), "=&r"(h_)                               \
                   : "r"(al_), "r"(ah_), "r"(bl_), "r"(bh_) : "cc");    \
  (lo_out) = l_; (hi_out) = h_; } while (0)

/* And the subtraction, where C is a borrow rather than a carry. */
#define SUB64(alo, ahi, blo, bhi, lo_out, hi_out) do {                  \
  unsigned int l_, h_, al_ = (alo), ah_ = (ahi), bl_ = (blo), bh_ = (bhi); \
  __asm__ volatile("subcc %2, %4, %0\n\t"                               \
                   "subx %3, %5, %1"                                    \
                   : "=&r"(l_), "=&r"(h_)                               \
                   : "r"(al_), "r"(ah_), "r"(bl_), "r"(bh_) : "cc");    \
  (lo_out) = l_; (hi_out) = h_; } while (0)

/* A multiply leaves the high half in %y, which only rd can reach. */
#define MUL(insn, a, b, lo_out, hi_out) do {                            \
  unsigned int l_, h_, x_ = (a), y_ = (b);                              \
  __asm__ volatile(insn " %2, %3, %0\n\trd %%y, %1"                     \
                   : "=&r"(l_), "=&r"(h_) : "r"(x_), "r"(y_) : "cc");   \
  (lo_out) = l_; (hi_out) = h_; } while (0)

/* A divide takes the high word of its dividend from %y, so the write
   and the read are separated on purpose. The divisor is forced
   non-zero, since dividing by zero traps rather than answering. */
#define DIV(insn, hi, lo, b, out) do {                                  \
  unsigned int r_, h_ = (hi), l_ = (lo), y_ = ((b) | 1u);               \
  __asm__ volatile("wr %1, %%g0, %%y\n\t"                               \
                   "nop\n\tnop\n\tnop\n\t"                              \
                   insn " %2, %3, %0"                                   \
                   : "=r"(r_) : "r"(h_), "r"(l_), "r"(y_) : "cc");      \
  (out) = r_; } while (0)

/*
 * A branch whose delay instruction is annulled when it is not taken.
 *
 * The add in the slot runs only on the taken path, and the or after
 * it runs only on the untaken one. An implementation with the annul
 * sense backwards gives a different answer for exactly one of the two
 * cases, which is why each of these is generated with both.
 */
#define ANNUL(cond, a, b, out) do {                                     \
  unsigned int r_ = 0, x_ = (a), y_ = (b);                              \
  __asm__ volatile("subcc %1, %2, %%g0\n\t"                             \
                   "b" cond ",a 1f\n\t"                                 \
                   "add %0, 7, %0\n\t"                                  \
                   "or %0, 0x40, %0\n"                                  \
                   "1:\n\t"                                             \
                   "add %0, 1, %0"                                      \
                   : "+r"(r_) : "r"(x_), "r"(y_) : "cc");               \
  (out) = r_; } while (0)

/* The same branch without annulling, where the slot always runs. */
#define DELAY(cond, a, b, out) do {                                     \
  unsigned int r_ = 0, x_ = (a), y_ = (b);                              \
  __asm__ volatile("subcc %1, %2, %%g0\n\t"                             \
                   "b" cond " 1f\n\t"                                   \
                   "add %0, 7, %0\n\t"                                  \
                   "or %0, 0x40, %0\n"                                  \
                   "1:\n\t"                                             \
                   "add %0, 1, %0"                                      \
                   : "+r"(r_) : "r"(x_), "r"(y_) : "cc");               \
  (out) = r_; } while (0)

#define ST(insn, off, a) do {                                           \
  unsigned int x_ = (a);                                                \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " %0, [%1]" :: "r"(x_), "r"(p_) : "memory");    \
} while (0)

#define LD(insn, off, out) do {                                         \
  unsigned int r_;                                                      \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " [%1], %0" : "=r"(r_) : "r"(p_) : "memory");   \
  (out) = r_; } while (0)

/* The tagged arithmetic, which sets overflow when either operand has a
   low bit set. Nothing a C compiler emits, and part of the instruction
   set all the same. */
#define TAGGED(insn, a, b, out, cy) do {                                \
  unsigned int r_, c_, x_ = (a), y_ = (b);                              \
  __asm__ volatile(insn " %2, %3, %0\n\t"                               \
                   "addx %%g0, %%g0, %1"                                \
                   : "=&r"(r_), "=&r"(c_) : "r"(x_), "r"(y_) : "cc");   \
  (out) = r_; (cy) = c_; } while (0)

/* One step of the multiply the first implementations had no instruction
   for. It reads N, V and %y and writes all of them. */
#define MULSCC(a, b, seed, out, yout) do {                              \
  unsigned int r_, y2_, x_ = (a), y_ = (b), s_ = (seed);                \
  __asm__ volatile("wr %4, %%g0, %%y\n\t"                               \
                   "nop\n\tnop\n\tnop\n\t"                              \
                   "mulscc %2, %3, %0\n\t"                              \
                   "mulscc %0, %3, %0\n\t"                              \
                   "rd %%y, %1"                                         \
                   : "=&r"(r_), "=&r"(y2_)                              \
                   : "r"(x_), "r"(y_), "r"(s_) : "cc");                 \
  (out) = r_; (yout) = y2_; } while (0)

/* The two read-modify-write instructions, which are how this
   architecture does a lock. Both touch memory twice in one
   instruction. */
#define ATOMIC(insn, off, a, out) do {                                  \
  unsigned int r_ = (a);                                                \
  volatile unsigned char *p_ = BUF + (off);                             \
  __asm__ volatile(insn " [%1], %0" : "+r"(r_) : "r"(p_) : "memory");   \
  (out) = r_; } while (0)

/* Floating point through explicit registers rather than constraints, so
   the instruction reaching the assembler is the one named here. */
#define F1(insn, in, out) do {                                          \
  __asm__ volatile("ld [%1], %%f2\n\t"                                  \
                   insn " %%f2, %%f4\n\t"                               \
                   "st %%f4, [%0]"                                      \
                   :: "r"(&(out)), "r"(&(in))                           \
                   : "f2", "f4", "memory"); } while (0)

#define F2(insn, x, y, out) do {                                        \
  __asm__ volatile("ld [%1], %%f2\n\tld [%2], %%f4\n\t"                 \
                   insn " %%f2, %%f4, %%f6\n\t"                         \
                   "st %%f6, [%0]"                                      \
                   :: "r"(&(out)), "r"(&(x)), "r"(&(y))                 \
                   : "f2", "f4", "f6", "memory"); } while (0)

/* The double-precision forms, which name an even register and move two
   words at a time. */
#define D1(insn, in, out) do {                                          \
  __asm__ volatile("ldd [%1], %%f2\n\t"                                 \
                   insn " %%f2, %%f4\n\t"                               \
                   "std %%f4, [%0]"                                     \
                   :: "r"(&(out)), "r"(&(in))                           \
                   : "f2", "f3", "f4", "f5", "memory"); } while (0)

#define D2(insn, x, y, out) do {                                        \
  __asm__ volatile("ldd [%1], %%f2\n\tldd [%2], %%f4\n\t"               \
                   insn " %%f2, %%f4, %%f6\n\t"                         \
                   "std %%f6, [%0]"                                     \
                   :: "r"(&(out)), "r"(&(x)), "r"(&(y))                 \
                   : "f2", "f3", "f4", "f5", "f6", "f7", "memory"); } while (0)

/* Single to double and double to single, which change the register
   width as well as the value. */
#define FWIDEN(insn, in, out) do {                                      \
  __asm__ volatile("ld [%1], %%f2\n\t"                                  \
                   insn " %%f2, %%f4\n\t"                               \
                   "std %%f4, [%0]"                                     \
                   :: "r"(&(out)), "r"(&(in))                           \
                   : "f2", "f4", "f5", "memory"); } while (0)

#define FNARROW(insn, in, out) do {                                     \
  __asm__ volatile("ldd [%1], %%f2\n\t"                                 \
                   insn " %%f2, %%f4\n\t"                               \
                   "st %%f4, [%0]"                                      \
                   :: "r"(&(out)), "r"(&(in))                           \
                   : "f2", "f3", "f4", "memory"); } while (0)

/* A comparison writes the floating-point condition code, and only a
   floating-point branch can read it. The three nops are the delay the
   architecture requires between the two. */
#define FCMP(insn, br, x, y, out) do {                                  \
  unsigned int r_ = 0;                                                  \
  __asm__ volatile("ld [%1], %%f2\n\tld [%2], %%f4\n\t"                 \
                   insn " %%f2, %%f4\n\t"                               \
                   "nop\n\tnop\n\tnop\n\t"                              \
                   br " 1f\n\t"                                         \
                   "add %0, 3, %0\n\t"                                  \
                   "or %0, 0x80, %0\n"                                  \
                   "1:\n\t"                                             \
                   "add %0, 1, %0"                                      \
                   : "+r"(r_) : "r"(&(x)), "r"(&(y))                    \
                   : "f2", "f4", "cc", "memory");                       \
  (out) = r_; } while (0)

/* Storing the status register, which carries the condition code and the
   accrued exception bits an arithmetic instruction leaves behind. */
#define FSR(out) do {                                                   \
  unsigned int r_;                                                      \
  __asm__ volatile("st %%fsr, [%0]" :: "r"(&r_) : "memory");            \
  (out) = r_; } while (0)

/*
 * Recursion past the eight register windows the hardware has.
 *
 * Nothing in this function is interesting on its own. What it exercises
 * is the window overflow trap on the way down and the underflow fill on
 * the way back up, which no straight-line program reaches and which the
 * reference handles inside the emulator rather than in guest code.
 */
__attribute__((noinline)) static unsigned deep(unsigned n, unsigned acc) {
  if (n == 0) return acc;
  unsigned a = acc ^ (n * 2654435761u);
  unsigned b = deep(n - 1, a + n);
  return b ^ (a >> 3) ^ (n << 8);
}
`

export function generateRandomProgram(seed: number): { source: string } {
  const next = rng(seed)
  const pick = <T,>(list: readonly T[]): T => list[Number(next() % BigInt(list.length))]!
  const word = (): bigint =>
    next() % 4n === 0n ? pick(BOUNDARY) : BigInt.asUintN(32, next())

  const body: string[] = []
  let slot = 0
  const emit = (line: string): void => { body.push(`  ${line}`) }
  const out = (): string => `SLOT(${slot++})`

  emit('unsigned int a, b, c, d;')
  emit('unsigned int lo, hi, cy;')
  // Separate storage for the floating-point cases, aligned because a
  // double load on this architecture requires it.
  emit('volatile float fs[3];')
  emit('volatile double fd[3];')

  for (let i = 0; i < 36; i++) {
    const x = word()
    const y = word()
    emit(`a = ${x}u; b = ${y}u;`)
    const kind = Number(next() % 13n)
    switch (kind) {
      case 0:
        emit(`RR("${pick(RR)}", a, b, ${out()});`)
        break
      case 1:
        emit(`RRCC("${pick(RR)}", a, b, c, cy); ${out()} = c; ${out()} = cy;`)
        break
      case 2:
        // simm13 is thirteen bits signed, so the interesting values are
        // at its ends rather than anywhere in a 32-bit range.
        emit(`IMM("${pick(RR)}", a, ${Number(next() % 8191n) - 4096}, ${out()});`)
        break
      case 3:
        emit(`SH("${pick(SHIFTS)}", a, ${Number(next() % 40n)}, ${out()});`)
        break
      case 4:
        emit(`ADD64(a, b, ${word()}u, ${word()}u, lo, hi); ${out()} = lo; ${out()} = hi;`)
        emit(`SUB64(a, b, ${word()}u, ${word()}u, lo, hi); ${out()} = lo; ${out()} = hi;`)
        break
      case 5:
        emit(`MUL("${next() % 2n === 0n ? 'smul' : 'umul'}", a, b, lo, hi);` +
          ` ${out()} = lo; ${out()} = hi;`)
        break
      case 6:
        emit(`DIV("${next() % 2n === 0n ? 'sdiv' : 'udiv'}", a, b, ${word()}u, ${out()});`)
        break
      case 7: {
        // Both senses of the same annulling branch, so the bit is
        // exercised taken and untaken rather than only one way.
        const cond = pick(CONDITIONS)
        emit(`ANNUL("${cond}", a, b, ${out()});`)
        emit(`ANNUL("${cond}", a, a, ${out()});`)
        emit(`DELAY("${cond}", a, b, ${out()});`)
        break
      }
      case 8: {
        // Every access has to be naturally aligned. This architecture
        // traps on anything else and offers no unaligned pair to fall
        // back on, so an unaligned offset here would be generating a
        // bus error rather than a test.
        const base = Number(next() % 128n) & ~3
        emit(`ST("st", ${base}, a);`)
        const load = pick([
          { insn: 'ld', align: 4 },
          { insn: 'ldub', align: 1 },
          { insn: 'lduh', align: 2 },
          { insn: 'ldsb', align: 1 },
          { insn: 'ldsh', align: 2 },
        ])
        const offset = base + (Number(next() % 4n) & ~(load.align - 1))
        emit(`LD("${load.insn}", ${offset}, ${out()});`)
        break
      }
      case 9: {
        // The parts of the integer set a C compiler never reaches.
        emit(`TAGGED("${next() % 2n === 0n ? 'taddcc' : 'tsubcc'}", a, b, ${out()}, cy);` +
          ` ${out()} = cy;`)
        emit(`MULSCC(a, b, ${word()}u, ${out()}, ${out()});`)
        break
      }
      case 10: {
        // The two read-modify-write instructions.
        const offset = Number(next() % 64n) & ~3
        emit(`ST("st", ${offset}, a);`)
        emit(`ATOMIC("${next() % 2n === 0n ? 'ldstub' : 'swap'}", ${offset}, b, ${out()});`)
        emit(`LD("ld", ${offset}, ${out()});`)
        break
      }
      case 11: {
        // Single precision, including the conversions that change the
        // register width as well as the value.
        const u = fpValue(next)
        const v = fpValue(next)
        emit(`fs[0] = ${u}f; fs[1] = ${v}f;`)
        emit(`F2("${pick(['fadds', 'fsubs', 'fmuls', 'fdivs'])}", fs[0], fs[1], fs[2]);` +
          ` ${out()} = *(volatile unsigned int *)&fs[2];`)
        emit(`F1("fsqrts", fs[0], fs[2]); ${out()} = *(volatile unsigned int *)&fs[2];`)
        emit(`F1("${pick(['fmovs', 'fnegs', 'fabss'])}", fs[0], fs[2]);` +
          ` ${out()} = *(volatile unsigned int *)&fs[2];`)
        emit(`FWIDEN("fstod", fs[0], fd[2]);` +
          ` ${out()} = ((volatile unsigned int *)&fd[2])[0];` +
          ` ${out()} = ((volatile unsigned int *)&fd[2])[1];`)
        emit(`F1("fstoi", fs[0], fs[2]); ${out()} = *(volatile unsigned int *)&fs[2];`)
        emit(`FSR(${out()});`)
        break
      }
      default: {
        // Double precision, and the comparison whose answer only a
        // floating-point branch can read.
        const u = fpValue(next)
        const v = fpValue(next)
        emit(`fd[0] = ${u}; fd[1] = ${v};`)
        emit(`D2("${pick(['faddd', 'fsubd', 'fmuld', 'fdivd'])}", fd[0], fd[1], fd[2]);` +
          ` ${out()} = ((volatile unsigned int *)&fd[2])[0];` +
          ` ${out()} = ((volatile unsigned int *)&fd[2])[1];`)
        emit(`D1("fsqrtd", fd[0], fd[2]);` +
          ` ${out()} = ((volatile unsigned int *)&fd[2])[0];` +
          ` ${out()} = ((volatile unsigned int *)&fd[2])[1];`)
        emit(`FNARROW("fdtos", fd[0], fs[2]); ${out()} = *(volatile unsigned int *)&fs[2];`)
        emit(`FNARROW("fdtoi", fd[0], fs[2]); ${out()} = *(volatile unsigned int *)&fs[2];`)
        emit(`fs[0] = ${Math.trunc(Number(u)).toFixed(1)}f;`)
        emit(`F1("fitos", fs[0], fs[2]); ${out()} = *(volatile unsigned int *)&fs[2];`)
        emit(`FWIDEN("fitod", fs[0], fd[2]);` +
          ` ${out()} = ((volatile unsigned int *)&fd[2])[0];`)
        emit(`F2("fsmuld", fs[0], fs[1], fd[2]);` +
          ` ${out()} = ((volatile unsigned int *)&fd[2])[0];` +
          ` ${out()} = ((volatile unsigned int *)&fd[2])[1];`)
        emit(`FCMP("fcmps", "${pick(FP_BRANCHES)}", fs[0], fs[1], ${out()});`)
        emit(`FSR(${out()});`)
        break
      }
    }
  }

  emit(`${out()} = deep(${12 + Number(next() % 12n)}, ${word()}u);`)
  emit(`${out()} = deep(${20 + Number(next() % 8n)}, ${word()}u);`)
  emit('return 0;')

  return {
    source: `${PRELUDE}\nlong kernel(void) {\n${body.join('\n')}\n}\n`,
  }
}
