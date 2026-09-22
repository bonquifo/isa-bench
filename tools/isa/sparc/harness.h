/*
 * Guest-side differential harness for SPARC V8. Mirrors the others; see
 * tools/isa/rv64/harness.h for why the guest dumps its own state rather
 * than relying on the emulator to report it.
 *
 * Two things are particular to this architecture.
 *
 * The 24 window registers are dumped as the *current window* sees them,
 * which is what qemu reports and therefore what a comparison can be
 * made against. The physical file behind them is larger and is not
 * directly observable from user code at all.
 *
 * The condition codes are in the processor status register, and reading
 * that register is privileged -- `rd %psr` traps. So the harness
 * recovers them the only way a user-mode program can: `addx` of two
 * zeroes yields the carry, and the other three are recovered by
 * branching on them. Those instructions do not themselves write the
 * condition codes, so the value recovered is the one the kernel left.
 */
#ifndef ISA_BENCH_SPARC_HARNESS_H
#define ISA_BENCH_SPARC_HARNESS_H

#define ISA_SCRATCH_BYTES 1024
#define ISA_STACK_BYTES 65536

/* Keep in sync with labelSparcDump() in src/isa/sparc/fixtures.node.ts. */
struct IsaDump {
  unsigned int g[8];    /*    0 ..   31 : %g0..%g7 */
  unsigned int o[8];    /*   32 ..   63 : %o0..%o7 */
  unsigned int l[8];    /*   64 ..   95 : %l0..%l7 */
  unsigned int i[8];    /*   96 ..  127 : %i0..%i7 */
  unsigned int y;       /*  128 ..  131 : the multiply/divide extension */
  unsigned int icc;     /*  132 ..  135 : N Z V C, recovered by branching */
  unsigned int fsr;     /*  136 ..  139 */
  unsigned int pad;     /*  140 ..  143 */
  unsigned int f[32];   /*  144 ..  271 : f0..f31, 32 bits each */
  unsigned char scratch[ISA_SCRATCH_BYTES]; /* 272 .. 1295 */
};

#define ISA_DUMP_BYTES 1296

extern struct IsaDump isa_dump;

long kernel(void);

#endif
