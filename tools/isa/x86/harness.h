/*
 * Guest-side differential harness for x86-64. Mirrors the RV64 one; see
 * tools/isa/rv64/harness.h for why the guest dumps its own state rather
 * than relying on the reference to report it. Here there is a second
 * reason: the reference is the host processor read through ptrace, which
 * reports the general registers and the flags but not the vector ones.
 *
 * The layout differs because the architecture does. There are sixteen
 * general registers rather than thirty-two, the stack pointer is one of
 * them, and the flags are architectural state that nearly every
 * instruction writes.
 *
 * One register does not hold what the kernel left in it. The epilogue needs
 * a pointer to the dump area, so r15 holds that address rather than its own
 * value. It is deterministic and identical on both sides, which is all the
 * comparison requires. The registers the flag read clobbers are stored
 * before it runs, so they are unaffected.
 */
#ifndef ISA_BENCH_X86_HARNESS_H
#define ISA_BENCH_X86_HARNESS_H

#define ISA_SCRATCH_BYTES 8192
#define ISA_STACK_BYTES 65536

/*
 * Only the arithmetic flags are dumped. The rest of RFLAGS is the interrupt
 * flag, the reserved bits and the trap flag that single-stepping itself
 * sets, none of which a userspace program can observe or an interpreter
 * should model.
 */
#define ISA_FLAG_MASK 0x8d5

/* Keep in sync with labelX86Dump() in src/isa/x86/fixtures.node.ts. */
struct IsaDump {
  unsigned long r[16];       /*    0 ..  127 : rax rcx rdx rbx rsp rbp rsi rdi r8..r15 */
  unsigned long rflags;      /*  128 ..  135 : cf pf af zf sf of, and nothing else */
  unsigned long pad;         /*  136 ..  143 */
  unsigned long xmm[32];     /*  144 ..  399 : xmm0..xmm15, low half then high half */
  unsigned char scratch[ISA_SCRATCH_BYTES]; /* 400 .. 8591 */
};

#define ISA_DUMP_BYTES 8592

extern struct IsaDump isa_dump;

long kernel(void);

#endif
