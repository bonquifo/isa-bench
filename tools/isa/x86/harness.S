// Entry stub and state-dump epilogue for the x86-64 differential harness.
//
// Layout constants mirror struct IsaDump in harness.h.
//
// The order the registers are stored in is the architecture's own numbering
// -- rax rcx rdx rbx rsp rbp rsi rdi, then r8 upwards -- rather than
// alphabetical or the order they are named in. That is the numbering the
// ModRM byte uses and the numbering the tracer reports, and keeping all
// three the same is what lets a divergence name a register rather than a
// slot.
//
// r15 is stored holding the dump address and rax holding the flags, because
// the epilogue needs one of each and there is nowhere else to put them.
// Both are deterministic and identical on both sides.

  .text
  .globl _start
  .type _start, @function
_start:
  leaq  isa_stack(%rip), %rsp
  addq  $65536, %rsp            // ISA_STACK_BYTES

  callq kernel

  leaq  isa_dump(%rip), %r15

  movq  %rax,  0(%r15)
  movq  %rcx,  8(%r15)
  movq  %rdx, 16(%r15)
  movq  %rbx, 24(%r15)
  movq  %rsp, 32(%r15)
  movq  %rbp, 40(%r15)
  movq  %rsi, 48(%r15)
  movq  %rdi, 56(%r15)
  movq  %r8,  64(%r15)
  movq  %r9,  72(%r15)
  movq  %r10, 80(%r15)
  movq  %r11, 88(%r15)
  movq  %r12, 96(%r15)
  movq  %r13, 104(%r15)
  movq  %r14, 112(%r15)
  movq  %r15, 120(%r15)

  // The flags the program was left holding cannot simply be read.
  //
  // Whatever kernel did last may have left some of them undefined -- a
  // shift by more than one leaves the overflow flag that way, any logical
  // operation leaves the adjust flag -- and an undefined flag read into a
  // register becomes an ordinary value that every interpreter would then
  // have to reproduce. So the flags are established here, by a comparison
  // of two registers the program itself produced: data-dependent, so the
  // dump still says something, and fully defined, so it says something
  // every implementation must agree on.
  cmpq  %rcx, %rax
  //
  // pushfq would read them in one instruction and is the wrong tool: the
  // value it pushes also holds the interrupt flag, the reserved bits and
  // the trap flag that single-stepping sets, so the register it lands in
  // would differ between a traced reference and any interpreter. seto and
  // lahf between them read exactly the six.
  seto   %al                    // al = of
  lahf                          // ah = sf zf 0 af 0 pf 1 cf
  movzbl %ah, %ecx
  andl   $0xd5, %ecx
  andl   $1, %eax
  shll   $11, %eax
  orl    %eax, %ecx
  movq   %rcx, 128(%r15)
  movq   $0, 136(%r15)

  movups %xmm0,  144(%r15)
  movups %xmm1,  160(%r15)
  movups %xmm2,  176(%r15)
  movups %xmm3,  192(%r15)
  movups %xmm4,  208(%r15)
  movups %xmm5,  224(%r15)
  movups %xmm6,  240(%r15)
  movups %xmm7,  256(%r15)
  movups %xmm8,  272(%r15)
  movups %xmm9,  288(%r15)
  movups %xmm10, 304(%r15)
  movups %xmm11, 320(%r15)
  movups %xmm12, 336(%r15)
  movups %xmm13, 352(%r15)
  movups %xmm14, 368(%r15)
  movups %xmm15, 384(%r15)

  // `syscall` copies the whole flag word into r11, so the flags have to be
  // defined before one runs for the same reason they had to be before they
  // were read: an undefined bit that lands in a general register is an
  // ordinary value that nothing can exclude from a comparison.
  movq  $1, %rax                // __NR_write
  movq  $1, %rdi                // fd 1
  movq  %r15, %rsi
  movq  $8592, %rdx             // ISA_DUMP_BYTES
  cmpq  %rsp, %rsp
  syscall

  movq  $60, %rax               // __NR_exit
  movq  $0, %rdi
  cmpq  %rsp, %rsp
  syscall

  ud2                           // unreachable; traps loudly if exit returns
  .size _start, .-_start

  .section .note.GNU-stack,"",@progbits
