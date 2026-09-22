/**
 * Seeded generator for randomised x86-64 differential programs.
 *
 * Same shape as the other generators, and everything is inline assembly for
 * the same reason: generating C expressions would mean generating behaviour
 * C leaves undefined, and a program whose meaning the language does not
 * define cannot be a differential test of anything.
 *
 * What is worth generating here is different from the other targets. Most
 * of this architecture's surface is not *which* operation but which of its
 * forms: the same add exists at four widths, with the memory operand on
 * either side, with an immediate that may be sign-extended from a byte, and
 * with a destination that is read as well as written. So the generator
 * varies widths, operand direction and operand values together.
 *
 * The flags are deliberately *not* recorded into the dump, although they
 * are most of what these instructions produce. The lockstep tier already
 * compares the flag register before every instruction, excluding the bits
 * the architecture leaves undefined after whatever wrote them -- which is a
 * stricter check than a snapshot, and the only one that can be made
 * correctly. Reading the flags into a register instead, with seto or lahf,
 * would copy those same undefined bits into an ordinary value, where
 * nothing can exclude them and every interpreter would be held to
 * reproducing whatever this particular processor happened to leave behind.
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

const BOUNDARY_INTS = [
  0n, 1n, 0xffffffffffffffffn, 2n, 0x7fffffffffffffffn, 0x8000000000000000n,
  0x7fffffffn, 0x80000000n, 0xffffffffn, 0x100000000n, 3n, 0xfffffffffffffffen,
  0x5555555555555555n, 0xaaaaaaaaaaaaaaaan, 0x8000000000000001n, 0x0000000100000000n,
  0x7fn, 0x80n, 0xffn, 0x7fffn, 0x8000n, 0xffffn,
]

const ALU = ['add', 'sub', 'and', 'or', 'xor', 'adc', 'sbb']
const ALU_FLAGS_ONLY = ['cmp', 'test']
const UNARY = ['neg', 'not', 'inc', 'dec']
const SHIFTS = ['shl', 'shr', 'sar', 'rol', 'ror']
const DOUBLE_SHIFTS = ['shld', 'shrd']
const BIT_OPS = ['bt', 'bts', 'btr', 'btc']
const SCANS = ['bsf', 'bsr', 'tzcnt', 'popcnt']
/** Every condition code, by the suffix that names it. */
const CONDITIONS = [
  'o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a',
  's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g',
]
/** The four operand widths, and the register letter each one uses. */
const WIDTHS: readonly (readonly [string, string])[] = [
  ['q', ''],
  ['l', 'k'],
  ['w', 'w'],
  ['b', 'b'],
]

const RESULT_BASE = 32
const RESULT_SLOTS = 240

export function generateRandomProgram(seed: number): {
  seed: number
  source: string
  operations: number
} {
  const next = rng(seed)
  const pick = <T,>(list: readonly T[]): T => list[Number(next() % BigInt(list.length))]!
  const value = (): bigint => {
    const roll = next() % 3n
    if (roll === 0n) return BOUNDARY_INTS[Number(next() % BigInt(BOUNDARY_INTS.length))]!
    if (roll === 1n) return next()
    // Small values, which is where the carry and the overflow flag differ
    // from each other most often.
    return next() % 256n
  }

  const ints: bigint[] = []
  for (let i = 0; i < 24; i++) ints.push(value())

  const body: string[] = []
  let used = 0
  const slot = (): string => `SLOT(${RESULT_BASE + used++})`
  const iv = (): string => `v[${Number(next() % BigInt(ints.length))}]`
  const width = (): readonly [string, string] => pick(WIDTHS)

  while (used < RESULT_SLOTS - 6) {
    const kind = Number(next() % 10n)
    if (kind <= 2) {
      const [suffix, letter] = width()
      body.push(`  RR("${pick(ALU)}${suffix}", "%${letter}", ${iv()}, ${iv()}, ${slot()});`)
    } else if (kind === 3) {
      const [suffix, letter] = width()
      body.push(
        `  RI("${pick(ALU)}${suffix}", "%${letter}", ${iv()}, ` +
        `${Number(next() % 256n)}, ${slot()});`,
      )
    } else if (kind === 4) {
      const [suffix, letter] = width()
      body.push(
        `  FLAGS("${pick(ALU_FLAGS_ONLY)}${suffix}", "%${letter}", ` +
        `${iv()}, ${iv()}, ${slot()});`,
      )
      body.push(`  SETCC("${pick(CONDITIONS)}", ${iv()}, ${iv()}, ${slot()});`)
      body.push(`  CMOV("${pick(CONDITIONS)}", ${iv()}, ${iv()}, ${slot()});`)
    } else if (kind === 5) {
      const [suffix, letter] = width()
      body.push(`  UN("${pick(UNARY)}${suffix}", "%${letter}", ${iv()}, ${slot()});`)
    } else if (kind === 6) {
      const [suffix, letter] = width()
      // A count of one is the only case where a shift defines the overflow
      // flag, so it needs to come up often rather than by chance.
      const count = next() % 3n === 0n ? 1 : Number(next() % 72n)
      body.push(
        `  SHIFT("${pick(SHIFTS)}${suffix}", "%${letter}", ${iv()}, ${count}, ${slot()});`,
      )
    } else if (kind === 7) {
      body.push(
        `  DSHIFT("${pick(DOUBLE_SHIFTS)}q", ${iv()}, ${iv()}, ` +
        `${Number(next() % 72n)}, ${slot()});`,
      )
      body.push(`  BIT("${pick(BIT_OPS)}q", ${iv()}, ${Number(next() % 80n)}, ${slot()});`)
    } else if (kind === 8) {
      body.push(`  SCAN("${pick(SCANS)}q", ${iv()}, ${slot()});`)
      body.push(`  MULDIV(${iv()}, ${iv()}, ${slot()}, ${slot()});`)
    } else {
      body.push(`  ST(${Number(next() % 200n)}, ${iv()});`)
      // The destination width is fixed by the instruction rather than
      // chosen: a sign-extending load to 64 bits has no 32-bit form.
      body.push(`  LD("movzbl", "%k", ${Number(next() % 200n)}, ${slot()});`)
      body.push(`  LD("movslq", "%", ${Number(next() % 190n)}, ${slot()});`)
      body.push(`  LD("movzwl", "%k", ${Number(next() % 190n)}, ${slot()});`)
      body.push(`  LD("movsbq", "%", ${Number(next() % 200n)}, ${slot()});`)
      body.push(`  MEMOP("addq", ${Number(next() % 190n)}, ${iv()}, ${slot()});`)
    }
  }

  const source = `${PRELUDE}
volatile unsigned long v[${ints.length}] = {
${ints.map((n) => `  0x${n.toString(16)}UL,`).join('\n')}
};

long kernel(void) {
  for (int i = 0; i < 256; i++) BUF[i] = (unsigned char)(0x80 | (i * 7));
${body.join('\n')}
  return (long)SLOT(${RESULT_BASE});
}
`
  return { seed, source, operations: used }
}

const PRELUDE = `/*
 * GENERATED by tools/isa/x86/random.ts — do not edit.
 *
 * A randomised differential program. Every operation is inline assembly so
 * that nothing here depends on behaviour C leaves undefined.
 *
 * What each operation computed is recorded; what it left in the flags is
 * not. The flags are compared before every instruction by the lockstep
 * tier, which can exclude the bits the architecture leaves undefined.
 * Reading them into a register here could not.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
#define BUF ((volatile unsigned char *)isa_dump.scratch)

#define RR(insn, reg, a, b, out) do {                                   \\
  unsigned long r_ = (a), y_ = (b);                                     \\
  __asm__ volatile(insn " " reg "2, " reg "0"                           \\
                   : "+r"(r_) : "r"(y_) : "cc");                        \\
  (out) = r_; } while (0)

#define RI(insn, reg, a, imm, out) do {                                 \\
  unsigned long r_ = (a);                                               \\
  __asm__ volatile(insn " $" #imm ", " reg "0" : "+r"(r_) :: "cc");     \\
  (out) = r_; } while (0)

/* cmp and test compute nothing but flags, so what is recorded is one the
   operation defines, read with the instruction that exists to read it. */
#define FLAGS(insn, reg, a, b, out) do {                                \\
  unsigned long r_ = 0, x_ = (a), y_ = (b);                             \\
  __asm__ volatile(insn " " reg "2, " reg "1\\n\\tsetz %b0"                \\
                   : "+r"(r_) : "r"(x_), "r"(y_) : "cc");               \\
  (out) = r_; } while (0)

#define SETCC(cc, a, b, out) do {                                       \\
  unsigned long r_ = 0, x_ = (a), y_ = (b);                             \\
  __asm__ volatile("cmpq %2, %1\\n\\tset" cc " %b0"                       \\
                   : "+r"(r_) : "r"(x_), "r"(y_) : "cc");               \\
  (out) = r_; } while (0)

#define CMOV(cc, a, b, out) do {                                        \\
  unsigned long r_ = (a), y_ = (b);                                     \\
  __asm__ volatile("cmpq %1, %0\\n\\tcmov" cc "q %1, %0"                  \\
                   : "+r"(r_) : "r"(y_) : "cc");                        \\
  (out) = r_; } while (0)

#define UN(insn, reg, a, out) do {                                      \\
  unsigned long r_ = (a);                                               \\
  __asm__ volatile(insn " " reg "0" : "+r"(r_) :: "cc");                \\
  (out) = r_; } while (0)

#define SHIFT(insn, reg, a, count, out) do {                            \\
  unsigned long r_ = (a);                                               \\
  __asm__ volatile(insn " $" #count ", " reg "0" : "+r"(r_) :: "cc");   \\
  (out) = r_; } while (0)

#define DSHIFT(insn, a, b, count, out) do {                             \\
  unsigned long r_ = (a), y_ = (b);                                     \\
  __asm__ volatile(insn " $" #count ", %1, %0"                          \\
                   : "+r"(r_) : "r"(y_) : "cc");                        \\
  (out) = r_; } while (0)

/* bts, btr and btc change the value as well as the carry flag; bt only
   reads it, and is here for the addressing rather than the result. */
#define BIT(insn, a, index, out) do {                                   \\
  unsigned long r_ = (a);                                               \\
  __asm__ volatile(insn " $" #index ", %0" : "+r"(r_) :: "cc");         \\
  (out) = r_; } while (0)

/* bsf and bsr leave the destination alone when the source is zero, so the
   destination starts at a value that could not otherwise appear. */
#define SCAN(insn, a, out) do {                                         \\
  unsigned long r_ = 0xfeedfacefeedfaceUL, x_ = (a);                    \\
  __asm__ volatile(insn " %1, %0" : "+r"(r_) : "r"(x_) : "cc");         \\
  (out) = r_; } while (0)

/*
 * The widening multiply and a divide.
 *
 * The divisor is forced odd so it cannot be zero, and the high half of the
 * dividend is zero so the quotient cannot overflow -- both of which fault
 * rather than producing a value. The high half is passed as an input bound
 * to rdx rather than zeroed inside the assembly, because otherwise the
 * compiler is free to put the divisor in rdx and the zeroing destroys it.
 */
#define MULDIV(a, b, low, high) do {                                    \\
  unsigned long l_ = (a), h_ = (b), q_, r_, zero_ = 0;                  \\
  __asm__ volatile("mulq %3" : "=a"(l_), "=d"(h_) : "a"(l_), "r"(h_) : "cc"); \\
  (low) = l_; (high) = h_;                                              \\
  unsigned long d_ = ((b) | 1UL);                                       \\
  __asm__ volatile("divq %4"                                            \\
                   : "=a"(q_), "=d"(r_)                                 \\
                   : "a"((a)), "d"(zero_), "r"(d_) : "cc");             \\
  (low) ^= q_; (high) ^= r_; } while (0)

#define ST(off, a) do {                                                 \\
  unsigned long x_ = (a);                                               \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile("movq %0, (%1)" :: "r"(x_), "r"(p_) : "memory");     \\
} while (0)

#define LD(insn, reg, off, out) do {                                    \\
  unsigned long r_ = 0;                                                 \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile(insn " (%1), " reg "0"                               \\
                   : "=r"(r_) : "r"(p_) : "memory");                    \\
  (out) = r_; } while (0)

/* A read-modify-write straight to memory, which no other target here has:
   the destination is the memory operand and it is both read and written. */
#define MEMOP(insn, off, a, out) do {                                   \\
  unsigned long x_ = (a), r_;                                           \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile(insn " %2, (%1)\\n\\tmovq (%1), %0"                    \\
                   : "=r"(r_) : "r"(p_), "r"(x_) : "cc", "memory");     \\
  (out) = r_; } while (0)
`
