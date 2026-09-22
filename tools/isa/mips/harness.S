// Entry stub and state-dump epilogue for the MIPS32 differential harness.
//
// Layout constants mirror struct IsaDump in harness.h.
//
// .set noreorder is on throughout, so every delay slot below is filled
// with what this file says rather than with whatever the assembler
// would have chosen. On this architecture that is the difference
// between a harness that documents itself and one that does not.
//
// .set fp=64 because the floating-point registers are 64 bits wide and
// independently addressable here, which is what lets the odd-numbered
// ones be stored at all.

  .text
  .set noreorder
  .set fp=64
  // The assembler reserves the `at` register for the macros it expands,
  // and warns about touching it. This file writes it out deliberately,
  // because the dump has a slot for every register including that one.
  .set noat
  .globl _start
  .ent _start
_start:
  // The stack top will not fit in a 16-bit immediate, so it is built
  // from its halves like any other address on this architecture.
  lui   $sp, %hi(isa_stack + 65536)
  addiu $sp, $sp, %lo(isa_stack + 65536)

  jal   kernel
  nop

  lui   $t8, %hi(isa_dump)
  addiu $t8, $t8, %lo(isa_dump)

  sw    $0, 0($t8)
  sw    $1, 4($t8)
  sw    $2, 8($t8)
  sw    $3, 12($t8)
  sw    $4, 16($t8)
  sw    $5, 20($t8)
  sw    $6, 24($t8)
  sw    $7, 28($t8)
  sw    $8, 32($t8)
  sw    $9, 36($t8)
  sw    $10, 40($t8)
  sw    $11, 44($t8)
  sw    $12, 48($t8)
  sw    $13, 52($t8)
  sw    $14, 56($t8)
  sw    $15, 60($t8)
  sw    $16, 64($t8)
  sw    $17, 68($t8)
  sw    $18, 72($t8)
  sw    $19, 76($t8)
  sw    $20, 80($t8)
  sw    $21, 84($t8)
  sw    $22, 88($t8)
  sw    $23, 92($t8)
  sw    $24, 96($t8)
  sw    $25, 100($t8)
  sw    $26, 104($t8)
  sw    $27, 108($t8)
  sw    $28, 112($t8)
  sw    $29, 116($t8)
  sw    $30, 120($t8)
  sw    $31, 124($t8)

  mfhi  $t9
  sw    $t9, 128($t8)
  mflo  $t9
  sw    $t9, 132($t8)
  cfc1  $t9, $31
  sw    $t9, 136($t8)
  sw    $zero, 140($t8)

  sdc1  $f0, 144($t8)
  sdc1  $f1, 152($t8)
  sdc1  $f2, 160($t8)
  sdc1  $f3, 168($t8)
  sdc1  $f4, 176($t8)
  sdc1  $f5, 184($t8)
  sdc1  $f6, 192($t8)
  sdc1  $f7, 200($t8)
  sdc1  $f8, 208($t8)
  sdc1  $f9, 216($t8)
  sdc1  $f10, 224($t8)
  sdc1  $f11, 232($t8)
  sdc1  $f12, 240($t8)
  sdc1  $f13, 248($t8)
  sdc1  $f14, 256($t8)
  sdc1  $f15, 264($t8)
  sdc1  $f16, 272($t8)
  sdc1  $f17, 280($t8)
  sdc1  $f18, 288($t8)
  sdc1  $f19, 296($t8)
  sdc1  $f20, 304($t8)
  sdc1  $f21, 312($t8)
  sdc1  $f22, 320($t8)
  sdc1  $f23, 328($t8)
  sdc1  $f24, 336($t8)
  sdc1  $f25, 344($t8)
  sdc1  $f26, 352($t8)
  sdc1  $f27, 360($t8)
  sdc1  $f28, 368($t8)
  sdc1  $f29, 376($t8)
  sdc1  $f30, 384($t8)
  sdc1  $f31, 392($t8)

  li    $a0, 1                  // fd 1
  move  $a1, $t8
  li    $a2, 1424               // ISA_DUMP_BYTES
  li    $v0, 4004               // __NR_write
  syscall
  nop

  li    $a0, 0
  li    $v0, 4001               // __NR_exit
  syscall
  nop

  break                         // unreachable; traps loudly if exit returns
  .end _start

  .section .note.GNU-stack,"",@progbits
