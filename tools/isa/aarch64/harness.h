/*
 * Guest-side differential harness for AArch64. Mirrors the RV64 one; see
 * tools/isa/rv64/harness.h for why the guest dumps its own state rather than
 * relying on the emulator to report it.
 *
 * The layout differs because the architecture does. AArch64 has 31 general
 * registers plus a stack pointer that is not one of them, and its
 * floating-point registers are 128 bits wide rather than 64.
 *
 * The epilogue clobbers x9 before saving it, so the dumped x9 is the address
 * of the dump area. That is deterministic and identical on both sides, which
 * is all the comparison requires.
 */
#ifndef ISA_BENCH_AARCH64_HARNESS_H
#define ISA_BENCH_AARCH64_HARNESS_H

#define ISA_SCRATCH_BYTES 1024
#define ISA_STACK_BYTES 65536

/* Keep in sync with labelAarch64Dump() in src/isa/aarch64/fixtures.node.ts. */
struct IsaDump {
  unsigned long x[31];       /*    0 ..  247 : x0..x30 */
  unsigned long sp;          /*  248 ..  255 : not one of the numbered registers */
  unsigned long v[64];       /*  256 ..  767 : v0..v31, low half then high half */
  unsigned long fpsr;        /*  768 ..  775 : the IEEE exception flags live here */
  unsigned long fpcr;        /*  776 ..  783 */
  unsigned long nzcv;        /*  784 ..  791 : condition flags, in bits 31..28 */
  unsigned long pad;         /*  792 ..  799 */
  unsigned char scratch[ISA_SCRATCH_BYTES]; /* 800 .. 1823 */
};

#define ISA_DUMP_BYTES 1824

extern struct IsaDump isa_dump;

long kernel(void);

#endif
