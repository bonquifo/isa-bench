/*
 * Entry stub and state-dump epilogue for the POWER differential harness.
 *
 * Offsets and sizes mirror struct IsaDump in harness.h, written out as
 * numbers because this file is assembled without including that header.
 *
 * Two things here are the ELFv2 ABI rather than choices.
 *
 * The first two instructions compute the table-of-contents pointer from
 * r12, which the kernel sets to the entry address. There is no
 * descriptor table on this ABI; every global entry point works this
 * out for itself, and compiled code reaches every global through r2.
 *
 * And the stack pointer must point at a back-chain word, with zero
 * terminating the chain, before anything is called.
 */

  .text
  .globl _start
  .type _start, @function
_start:
  /* The table of contents, from this function's own address. */
  addis 2, 12, .TOC.-_start@ha
  addi  2, 2, .TOC.-_start@l

  /* A stack, with room below it for the frame a callee will build. */
  lis   1, isa_stack@ha
  addi  1, 1, isa_stack@l
  addis 1, 1, 1                 /* + 65536, which is ISA_STACK_BYTES */
  addi  1, 1, -512
  li    0, 0
  std   0, 0(1)                 /* the back chain terminates here */

  bl    kernel
  nop

  lis   3, isa_dump@ha
  addi  3, 3, isa_dump@l

  std   0, 0(3)
  std   1, 8(3)
  std   2, 16(3)
  /* r3 is the dump pointer by now, so what is stored for it is that
     address. Deterministic, and the same on both sides. */
  std   3, 24(3)
  std   4, 32(3)
  std   5, 40(3)
  std   6, 48(3)
  std   7, 56(3)
  std   8, 64(3)
  std   9, 72(3)
  std   10, 80(3)
  std   11, 88(3)
  std   12, 96(3)
  std   13, 104(3)
  std   14, 112(3)
  std   15, 120(3)
  std   16, 128(3)
  std   17, 136(3)
  std   18, 144(3)
  std   19, 152(3)
  std   20, 160(3)
  std   21, 168(3)
  std   22, 176(3)
  std   23, 184(3)
  std   24, 192(3)
  std   25, 200(3)
  std   26, 208(3)
  std   27, 216(3)
  std   28, 224(3)
  std   29, 232(3)
  std   30, 240(3)
  std   31, 248(3)

  mflr  4
  std   4, 256(3)
  mfctr 4
  std   4, 264(3)
  mfcr  4
  std   4, 272(3)
  mfxer 4
  std   4, 280(3)

  stfd  0, 288(3)
  stfd  1, 296(3)
  stfd  2, 304(3)
  stfd  3, 312(3)
  stfd  4, 320(3)
  stfd  5, 328(3)
  stfd  6, 336(3)
  stfd  7, 344(3)
  stfd  8, 352(3)
  stfd  9, 360(3)
  stfd  10, 368(3)
  stfd  11, 376(3)
  stfd  12, 384(3)
  stfd  13, 392(3)
  stfd  14, 400(3)
  stfd  15, 408(3)
  stfd  16, 416(3)
  stfd  17, 424(3)
  stfd  18, 432(3)
  stfd  19, 440(3)
  stfd  20, 448(3)
  stfd  21, 456(3)
  stfd  22, 464(3)
  stfd  23, 472(3)
  stfd  24, 480(3)
  stfd  25, 488(3)
  stfd  26, 496(3)
  stfd  27, 504(3)
  stfd  28, 512(3)
  stfd  29, 520(3)
  stfd  30, 528(3)
  stfd  31, 536(3)

  /* write(1, &isa_dump, ISA_DUMP_BYTES) */
  li    0, 4                    /* __NR_write */
  mr    4, 3
  li    3, 1
  li    5, 1568                 /* ISA_DUMP_BYTES */
  sc

  /* _exit(0) */
  li    0, 1                    /* __NR_exit */
  li    3, 0
  sc

  trap                          /* unreachable; stops loudly if exit returns */
  .size _start, . - _start

  .section .note.GNU-stack,"",@progbits
