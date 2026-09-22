/**
 * Seeded generator for randomised MIPS32 differential programs.
 *
 * Same shape as the other generators. What is worth generating here is
 * narrower than on x86 and wider than on RISC-V: the integer instruction
 * set is small, but two things in it are easy to implement almost
 * correctly. The shifts and the unaligned accesses both depend on the low
 * bits of a value in ways a plausible implementation gets right for the
 * common case and wrong at the edges, and the HI/LO pair is written by
 * one instruction and read by another several later, so interleaving them
 * finds orderings a fixed program does not.
 *
 * And the delay slot, which no other target here has. Every generated
 * branch has something observable in its slot, so an implementation that
 * ran the slot at the wrong time gives a different answer rather than the
 * same one slightly later.
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
  0n, 1n, 0xffffffffn, 2n, 0x7fffffffn, 0x80000000n, 0x80000001n,
  0xfffffffen, 0x55555555n, 0xaaaaaaaan, 0xffn, 0x100n, 0xffffn, 0x10000n,
  3n, 0x7fffn,
]

const RR = ['addu', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu']
/**
 * The immediate forms, and the range each one's immediate has.
 *
 * The arithmetic ones sign-extend a 16-bit field and the logical ones
 * zero-extend it, so the same bit pattern is a different number depending
 * on the instruction and half of them will not assemble with the other
 * half's range.
 */
const RI: readonly (readonly [string, boolean])[] = [
  ['addiu', true], ['andi', false], ['ori', false],
  ['xori', false], ['slti', true], ['sltiu', true],
]
const SHIFT = ['sll', 'srl', 'sra']
const SHIFTV = ['sllv', 'srlv', 'srav']
const MULDIV = ['mult', 'multu']
const BITS = ['clz', 'clo', 'seb', 'seh', 'wsbh']
const COND = ['movz', 'movn']
const LOADS: readonly (readonly [string, number])[] = [
  ['lb', 1], ['lbu', 1], ['lh', 2], ['lhu', 2], ['lw', 4],
]

const RESULT_BASE = 16
const RESULT_SLOTS = 112

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
    if (roll === 1n) return next() & 0xffffffffn
    return next() % 256n
  }

  const ints: bigint[] = []
  for (let i = 0; i < 20; i++) ints.push(value())

  const body: string[] = []
  let used = 0
  const slot = (): string => `SLOT(${RESULT_BASE + used++})`
  const iv = (): string => `v[${Number(next() % BigInt(ints.length))}]`

  while (used < RESULT_SLOTS - 5) {
    const kind = Number(next() % 9n)
    if (kind <= 2) {
      body.push(`  RR("${pick(RR)}", ${iv()}, ${iv()}, ${slot()});`)
    } else if (kind === 3) {
      const [name, signed] = pick(RI)
      const imm = signed
        ? Number(next() % 65536n) - 32768
        : Number(next() % 65536n)
      body.push(`  RI("${name}", ${iv()}, ${imm}, ${slot()});`)
    } else if (kind === 4) {
      // A shift amount of zero is the encoding of nop, and one of 31 is
      // the far edge: both belong in the sample.
      body.push(`  SH("${pick(SHIFT)}", ${iv()}, ${Number(next() % 32n)}, ${slot()});`)
      body.push(`  SHV("${pick(SHIFTV)}", ${iv()}, ${iv()}, ${slot()});`)
      body.push(`  SH("rotr", ${iv()}, ${Number(next() % 32n)}, ${slot()});`)
    } else if (kind === 5) {
      body.push(`  MD("${pick(MULDIV)}", ${iv()}, ${iv()}, ${slot()}, ${slot()});`)
      body.push(`  DIVIDE(${iv()}, ${iv()}, ${slot()}, ${slot()});`)
    } else if (kind === 6) {
      body.push(`  UN("${pick(BITS)}", ${iv()}, ${slot()});`)
      body.push(`  MOVC("${pick(COND)}", ${iv()}, ${iv()}, ${slot()});`)
      body.push(
        `  BITFIELD(${Number(next() % 24n)}, ${1 + Number(next() % 8n)}, ` +
        `${iv()}, ${iv()}, ${slot()});`,
      )
    } else if (kind === 7) {
      const load = pick(LOADS)
      body.push(`  ST(${Number(next() % 200n)}, ${iv()});`)
      body.push(`  LD("${load[0]}", ${Number(next() % 200n) & ~(load[1] - 1)}, ${slot()});`)
      body.push(`  UNALIGNED(${Number(next() % 200n)}, ${slot()});`)
    } else {
      body.push(`  DELAY("${next() % 2n === 0n ? 'beqz' : 'bnez'}", ${iv()}, ${slot()});`)
    }
  }

  const source = `${PRELUDE}
volatile unsigned int v[${ints.length}] = {
${ints.map((n) => `  0x${n.toString(16)}u,`).join('\n')}
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
 * GENERATED by tools/isa/mips/random.ts — do not edit.
 *
 * A randomised differential program. Every operation is inline assembly so
 * that nothing here depends on behaviour C leaves undefined.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])
#define BUF ((volatile unsigned char *)isa_dump.scratch)

#define RR(insn, a, b, out) do {                                        \\
  unsigned int r_, x_ = (a), y_ = (b);                                  \\
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "r"(x_), "r"(y_));   \\
  (out) = r_; } while (0)

#define RI(insn, a, imm, out) do {                                      \\
  unsigned int r_, x_ = (a);                                            \\
  __asm__ volatile(insn " %0, %1, " #imm : "=r"(r_) : "r"(x_));         \\
  (out) = r_; } while (0)

#define SH(insn, a, amount, out) do {                                   \\
  unsigned int r_, x_ = (a);                                            \\
  __asm__ volatile(insn " %0, %1, " #amount : "=r"(r_) : "r"(x_));      \\
  (out) = r_; } while (0)

#define SHV(insn, a, b, out) do {                                       \\
  unsigned int r_, x_ = (a), y_ = (b);                                  \\
  __asm__ volatile(insn " %0, %1, %2" : "=r"(r_) : "r"(x_), "r"(y_));   \\
  (out) = r_; } while (0)

#define UN(insn, a, out) do {                                           \\
  unsigned int r_, x_ = (a);                                            \\
  __asm__ volatile(insn " %0, %1" : "=r"(r_) : "r"(x_));                \\
  (out) = r_; } while (0)

/* A conditional move leaves the destination alone when the condition
   fails, so it starts at a value nothing else would produce. */
#define MOVC(insn, a, b, out) do {                                      \\
  unsigned int r_ = 0xfeedfaceu, x_ = (a), y_ = (b);                    \\
  __asm__ volatile(insn " %0, %1, %2" : "+r"(r_) : "r"(x_), "r"(y_));   \\
  (out) = r_; } while (0)

#define BITFIELD(pos, width, a, b, out) do {                            \\
  unsigned int e_, i_ = (b), x_ = (a);                                  \\
  __asm__ volatile("ext %0, %2, " #pos ", " #width "\\n\\t"               \\
                   "ins %1, %2, " #pos ", " #width                      \\
                   : "=&r"(e_), "+r"(i_) : "r"(x_));                    \\
  (out) = e_ ^ i_; } while (0)

#define MD(insn, a, b, lo_out, hi_out) do {                             \\
  unsigned int l_, h_, x_ = (a), y_ = (b);                              \\
  __asm__ volatile(insn " %2, %3\\n\\tmflo %0\\n\\tmfhi %1"                \\
                   : "=r"(l_), "=r"(h_) : "r"(x_), "r"(y_) : "hi", "lo"); \\
  (lo_out) = l_; (hi_out) = h_; } while (0)

/* The divisor is forced non-zero: a divide by zero on this architecture
   is unpredictable rather than a fault, so it cannot be a test of
   anything. */
#define DIVIDE(a, b, q_out, r_out) do {                                 \\
  unsigned int q_, m_, x_ = (a), y_ = ((b) | 1u);                       \\
  __asm__ volatile("divu $zero, %2, %3\\n\\tmflo %0\\n\\tmfhi %1"          \\
                   : "=r"(q_), "=r"(m_) : "r"(x_), "r"(y_) : "hi", "lo"); \\
  (q_out) = q_; (r_out) = m_; } while (0)

#define ST(off, a) do {                                                 \\
  unsigned int x_ = (a);                                                \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile("swl %0, 3(%1)\\n\\tswr %0, 0(%1)"                     \\
                   :: "r"(x_), "r"(p_) : "memory");                     \\
} while (0)

#define LD(insn, off, out) do {                                         \\
  unsigned int r_;                                                      \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile(insn " %0, 0(%1)" : "=r"(r_) : "r"(p_) : "memory");  \\
  (out) = r_; } while (0)

/* The pair a compiler emits for a word it cannot prove aligned. */
#define UNALIGNED(off, out) do {                                        \\
  unsigned int r_ = 0xa5a5a5a5u;                                        \\
  volatile unsigned char *p_ = BUF + (off);                             \\
  __asm__ volatile("lwl %0, 3(%1)\\n\\tlwr %0, 0(%1)"                     \\
                   : "+r"(r_) : "r"(p_) : "memory");                    \\
  (out) = r_; } while (0)

/*
 * A branch with something observable in its delay slot.
 *
 * The addiu runs whether or not the branch is taken, and the branch tests
 * the value from before it ran. An implementation that moved the slot to
 * after the branch, or that let the branch see the slot's result, gives a
 * different answer for one of the two cases.
 */
#define DELAY(insn, a, out) do {                                        \\
  unsigned int r_ = 0, x_ = (a);                                        \\
  __asm__ volatile(".set noreorder\\n\\t"                                 \\
                   insn " %1, 1f\\n\\t"                                   \\
                   "addiu %1, %1, 1\\n\\t"                                \\
                   "ori %0, %0, 0x20\\n"                                 \\
                   "1:\\n\\t"                                             \\
                   "addu %0, %0, %1\\n\\t"                                \\
                   ".set reorder"                                       \\
                   : "+r"(r_), "+r"(x_));                               \\
  (out) = r_; } while (0)
`
