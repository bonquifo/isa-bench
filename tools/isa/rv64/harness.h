/*
 * Guest-side differential harness for RV64.
 *
 * Each test program supplies `kernel()`. The harness runs it and then writes
 * the whole architectural state to fd 1 in one `write`, so the same ELF can be
 * executed by qemu-riscv64 and by the interpreter and the two dumps compared
 * byte for byte.
 *
 * Dumping through the guest rather than through the simulator's own reporting
 * is deliberate: qemu-user's `-d cpu` does not emit the floating-point
 * registers for RISC-V (checked, not assumed), and this mechanism carries over
 * unchanged to the oracles that have no register-dump facility at all — the
 * native x86-64 binary, Wasmtime and mos-sim.
 *
 * The epilogue clobbers gp before saving it, so the dumped x3 is the address
 * of the dump area rather than the guest's original gp. That is deterministic
 * and identical on both sides, which is all the comparison requires.
 */
#ifndef ISA_BENCH_RV64_HARNESS_H
#define ISA_BENCH_RV64_HARNESS_H

#define ISA_SCRATCH_BYTES 1024
#define ISA_STACK_BYTES 65536

/* Keep in sync with readDump() in src/isa/riscv/fixtures.ts. */
struct IsaDump {
  unsigned long x[32];      /*    0 .. 255 */
  unsigned long f[32];      /*  256 .. 511 : raw bit patterns, not values */
  unsigned long fcsr;       /*  512 .. 519 */
  unsigned long pad;        /*  520 .. 527 */
  unsigned char scratch[ISA_SCRATCH_BYTES]; /* 528 .. 1551 : the memory window */
};

#define ISA_DUMP_BYTES 1552

extern struct IsaDump isa_dump;

/* Supplied by each program. The return value is only incidental: what the
   comparison actually checks is the whole dump. */
long kernel(void);

#endif
