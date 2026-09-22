/*
 * Guest-side differential harness for POWER. Mirrors the others; see
 * tools/isa/rv64/harness.h for why the guest dumps its own state rather
 * than relying on the emulator to report it.
 *
 * Here the reason is sharper than usual. qemu reports the general
 * registers, the link and count registers, the condition register and
 * the exception register -- but not the 32 floating-point registers,
 * and on this target those are where all the floating-point arithmetic
 * ends up, because the compiler uses the VSX forms whose low halves
 * they are.
 *
 * Two registers do not hold what the kernel left in them: r3 holds the
 * address of the dump area, and the link register holds the return
 * address of the call into the kernel rather than whatever the kernel
 * last set. Both are deterministic and identical on the two sides, and
 * the lockstep tier covers them before this code runs.
 *
 * The floating-point status register is deliberately absent. The
 * backend does not model it -- it rounds to nearest and reports no
 * exceptions -- and reading it there is refused rather than answered,
 * so dumping it here would be comparing a field one side does not
 * have. Nothing the compiler emits reads it: across every fixture, the
 * only `mffs` was the one this file used to contain.
 */
#ifndef ISA_BENCH_POWER_HARNESS_H
#define ISA_BENCH_POWER_HARNESS_H

#define ISA_SCRATCH_BYTES 1024
#define ISA_STACK_BYTES 65536

/* Keep in sync with labelPowerDump() in src/isa/power/fixtures.node.ts. */
struct IsaDump {
  unsigned long r[32];   /*    0 ..  255 : r0..r31 */
  unsigned long lr;      /*  256 ..  263 */
  unsigned long ctr;     /*  264 ..  271 */
  unsigned long cr;      /*  272 ..  279 : eight four-bit fields, packed */
  unsigned long xer;     /*  280 ..  287 : carry lives here */
  unsigned long f[32];   /*  288 ..  543 : f0..f31, the VSX low halves */
  unsigned char scratch[ISA_SCRATCH_BYTES]; /* 544 .. 1567 */
};

#define ISA_DUMP_BYTES 1568

extern struct IsaDump isa_dump;

long kernel(void);

#endif
