// Entry stub and state-dump epilogue for the RV64 differential harness.
//
// Layout constants mirror struct IsaDump in harness.h. The stores are written
// out one per register rather than generated with .irp so that what the
// assembler sees is exactly what is reviewed here.

  .text
  .globl _start
  .type _start, @function
_start:
  lla   sp, isa_stack
  li    t0, 65536               // ISA_STACK_BYTES
  add   sp, sp, t0

  call  kernel

  lla   gp, isa_dump            // clobbers x3; see the note in harness.h

  sd    x0,   0(gp)
  sd    x1,   8(gp)
  sd    x2,  16(gp)
  sd    x3,  24(gp)
  sd    x4,  32(gp)
  sd    x5,  40(gp)
  sd    x6,  48(gp)
  sd    x7,  56(gp)
  sd    x8,  64(gp)
  sd    x9,  72(gp)
  sd    x10, 80(gp)
  sd    x11, 88(gp)
  sd    x12, 96(gp)
  sd    x13, 104(gp)
  sd    x14, 112(gp)
  sd    x15, 120(gp)
  sd    x16, 128(gp)
  sd    x17, 136(gp)
  sd    x18, 144(gp)
  sd    x19, 152(gp)
  sd    x20, 160(gp)
  sd    x21, 168(gp)
  sd    x22, 176(gp)
  sd    x23, 184(gp)
  sd    x24, 192(gp)
  sd    x25, 200(gp)
  sd    x26, 208(gp)
  sd    x27, 216(gp)
  sd    x28, 224(gp)
  sd    x29, 232(gp)
  sd    x30, 240(gp)
  sd    x31, 248(gp)

  fsd   f0,  256(gp)
  fsd   f1,  264(gp)
  fsd   f2,  272(gp)
  fsd   f3,  280(gp)
  fsd   f4,  288(gp)
  fsd   f5,  296(gp)
  fsd   f6,  304(gp)
  fsd   f7,  312(gp)
  fsd   f8,  320(gp)
  fsd   f9,  328(gp)
  fsd   f10, 336(gp)
  fsd   f11, 344(gp)
  fsd   f12, 352(gp)
  fsd   f13, 360(gp)
  fsd   f14, 368(gp)
  fsd   f15, 376(gp)
  fsd   f16, 384(gp)
  fsd   f17, 392(gp)
  fsd   f18, 400(gp)
  fsd   f19, 408(gp)
  fsd   f20, 416(gp)
  fsd   f21, 424(gp)
  fsd   f22, 432(gp)
  fsd   f23, 440(gp)
  fsd   f24, 448(gp)
  fsd   f25, 456(gp)
  fsd   f26, 464(gp)
  fsd   f27, 472(gp)
  fsd   f28, 480(gp)
  fsd   f29, 488(gp)
  fsd   f30, 496(gp)
  fsd   f31, 504(gp)

  csrr  t0, fcsr
  sd    t0, 512(gp)
  sd    x0, 520(gp)

  li    a7, 64                  // __NR_write
  li    a0, 1
  mv    a1, gp
  li    a2, 1552                // ISA_DUMP_BYTES
  ecall

  li    a7, 93                  // __NR_exit
  li    a0, 0
  ecall

  unimp                         // unreachable; traps loudly if exit ever returns
  .size _start, .-_start
