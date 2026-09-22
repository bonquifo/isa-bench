/*
 * Guest-side differential harness for MIPS32. Mirrors the RV64 one; see
 * tools/isa/rv64/harness.h for why the guest dumps its own state rather
 * than relying on the emulator to report it. Here the reason is the usual
 * one: qemu's register dump has the general registers and the HI/LO pair
 * but not the coprocessor's.
 *
 * The layout differs because the architecture does. There are 32 general
 * registers and a separate HI and LO pair that only the multiply and
 * divide instructions touch, and the floating-point registers belong to a
 * coprocessor with a status word of its own.
 *
 * Two registers do not hold what the kernel left in them: the epilogue
 * needs a pointer to the dump area and one scratch register, so t8 holds
 * the dump address and t9 is used on the way there. Both are
 * deterministic and identical on the two sides.
 */
#ifndef ISA_BENCH_MIPS_HARNESS_H
#define ISA_BENCH_MIPS_HARNESS_H

#define ISA_SCRATCH_BYTES 1024
#define ISA_STACK_BYTES 65536

/* Keep in sync with labelMipsDump() in src/isa/mips/fixtures.node.ts. */
struct IsaDump {
  unsigned int r[32];        /*    0 ..  127 : r0..r31 */
  unsigned int hi;           /*  128 ..  131 */
  unsigned int lo;           /*  132 ..  135 */
  unsigned int fcsr;         /*  136 ..  139 : the coprocessor status word */
  unsigned int pad;          /*  140 ..  143 */
  unsigned long long f[32];  /*  144 ..  399 : f0..f31, each 64 bits wide */
  unsigned char scratch[ISA_SCRATCH_BYTES]; /* 400 .. 1423 */
};

#define ISA_DUMP_BYTES 1424

extern struct IsaDump isa_dump;

long kernel(void);

#endif
