// Entry stub and state-dump epilogue for the AArch64 differential harness.
//
// Layout constants mirror struct IsaDump in harness.h. Registers are stored
// in pairs where the architecture offers it, which is both what a compiler
// would emit and a third of the instructions.
//
// x9 holds the dump address and is therefore stored with that value rather
// than the one kernel left in it; x11 is reused only after every numbered
// register has already been written out.

  .text
  .globl _start
  .type _start, %function
_start:
  adrp  x9, isa_stack
  add   x9, x9, :lo12:isa_stack
  mov   x10, #65536             // ISA_STACK_BYTES
  add   x9, x9, x10
  mov   sp, x9

  bl    kernel

  adrp  x9, isa_dump
  add   x9, x9, :lo12:isa_dump

  stp   x0,  x1,  [x9, #0]
  stp   x2,  x3,  [x9, #16]
  stp   x4,  x5,  [x9, #32]
  stp   x6,  x7,  [x9, #48]
  stp   x8,  x9,  [x9, #64]
  stp   x10, x11, [x9, #80]
  stp   x12, x13, [x9, #96]
  stp   x14, x15, [x9, #112]
  stp   x16, x17, [x9, #128]
  stp   x18, x19, [x9, #144]
  stp   x20, x21, [x9, #160]
  stp   x22, x23, [x9, #176]
  stp   x24, x25, [x9, #192]
  stp   x26, x27, [x9, #208]
  stp   x28, x29, [x9, #224]
  str   x30,      [x9, #240]

  mov   x11, sp
  str   x11,      [x9, #248]

  str   q0,  [x9, #256]
  str   q1,  [x9, #272]
  str   q2,  [x9, #288]
  str   q3,  [x9, #304]
  str   q4,  [x9, #320]
  str   q5,  [x9, #336]
  str   q6,  [x9, #352]
  str   q7,  [x9, #368]
  str   q8,  [x9, #384]
  str   q9,  [x9, #400]
  str   q10, [x9, #416]
  str   q11, [x9, #432]
  str   q12, [x9, #448]
  str   q13, [x9, #464]
  str   q14, [x9, #480]
  str   q15, [x9, #496]
  str   q16, [x9, #512]
  str   q17, [x9, #528]
  str   q18, [x9, #544]
  str   q19, [x9, #560]
  str   q20, [x9, #576]
  str   q21, [x9, #592]
  str   q22, [x9, #608]
  str   q23, [x9, #624]
  str   q24, [x9, #640]
  str   q25, [x9, #656]
  str   q26, [x9, #672]
  str   q27, [x9, #688]
  str   q28, [x9, #704]
  str   q29, [x9, #720]
  str   q30, [x9, #736]
  str   q31, [x9, #752]

  mrs   x11, fpsr
  str   x11, [x9, #768]
  mrs   x11, fpcr
  str   x11, [x9, #776]
  mrs   x11, nzcv
  str   x11, [x9, #784]
  str   xzr, [x9, #792]

  mov   x0, #1                  // fd 1
  mov   x1, x9
  mov   x2, #1824               // ISA_DUMP_BYTES
  mov   x8, #64                 // __NR_write
  svc   #0

  mov   x8, #93                 // __NR_exit
  mov   x0, #0
  svc   #0

  brk   #0                      // unreachable; traps loudly if exit returns
  .size _start, .-_start
