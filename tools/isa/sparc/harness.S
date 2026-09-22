! Entry stub and state-dump epilogue for the SPARC V8 differential harness.
!
! Offsets and sizes mirror struct IsaDump in harness.h, and are written
! out as numbers rather than as its macros: this file is assembled
! without including that header, so a name from it would reach the
! assembler as an undefined symbol and quietly become part of a
! relocation rather than a constant.
!
! Two registers do not hold what the kernel left in them: %g1 holds the
! address of the dump area and %g2 is scratch on the way there. Both are
! deterministic and identical on the two sides of the comparison, and
! the lockstep tier covers them before this code runs.
!
! The condition codes need recovering rather than reading, because the
! register holding them is privileged. `addx %g0, %g0, r` is zero plus
! zero plus carry, so it yields C directly; N, Z and V are recovered by
! branching on each. None of those instructions writes the condition
! codes, so what is recovered is what the kernel left.

  .text
  .globl _start
  .type _start, #function
_start:
  ! A SPARC frame needs 96 bytes below %sp for the register save area
  ! the window overflow handler writes into, and %sp must stay aligned
  ! to eight.
  sethi %hi(isa_stack + 65536 - 96), %sp    ! ISA_STACK_BYTES
  or    %sp, %lo(isa_stack + 65536 - 96), %sp

  call  kernel
   nop

  sethi %hi(isa_dump), %g1
  or    %g1, %lo(isa_dump), %g1

  ! The globals. %g1 and %g2 are written too, so the dump has a slot for
  ! every register even where this code is what put the value there.
  st    %g0, [%g1 + 0]
  st    %g1, [%g1 + 4]
  st    %g2, [%g1 + 8]
  st    %g3, [%g1 + 12]
  st    %g4, [%g1 + 16]
  st    %g5, [%g1 + 20]
  st    %g6, [%g1 + 24]
  st    %g7, [%g1 + 28]

  st    %o0, [%g1 + 32]
  st    %o1, [%g1 + 36]
  st    %o2, [%g1 + 40]
  st    %o3, [%g1 + 44]
  st    %o4, [%g1 + 48]
  st    %o5, [%g1 + 52]
  st    %o6, [%g1 + 56]
  st    %o7, [%g1 + 60]

  st    %l0, [%g1 + 64]
  st    %l1, [%g1 + 68]
  st    %l2, [%g1 + 72]
  st    %l3, [%g1 + 76]
  st    %l4, [%g1 + 80]
  st    %l5, [%g1 + 84]
  st    %l6, [%g1 + 88]
  st    %l7, [%g1 + 92]

  st    %i0, [%g1 + 96]
  st    %i1, [%g1 + 100]
  st    %i2, [%g1 + 104]
  st    %i3, [%g1 + 108]
  st    %i4, [%g1 + 112]
  st    %i5, [%g1 + 116]
  st    %i6, [%g1 + 120]
  st    %i7, [%g1 + 124]

  rd    %y, %g2
  st    %g2, [%g1 + 128]

  ! The condition codes, one bit at a time. Bit 3 is N, 2 is Z, 1 is V
  ! and 0 is C, which is the order the interpreter packs them in.
  addx  %g0, %g0, %g2           ! C
  bneg  1f
   nop
  ba    2f
   nop
1:
  or    %g2, 8, %g2             ! N
2:
  bz    3f
   nop
  ba    4f
   nop
3:
  or    %g2, 4, %g2             ! Z
4:
  bvs   5f
   nop
  ba    6f
   nop
5:
  or    %g2, 2, %g2             ! V
6:
  st    %g2, [%g1 + 132]

  st    %fsr, [%g1 + 136]
  st    %g0, [%g1 + 140]

  st    %f0, [%g1 + 144]
  st    %f1, [%g1 + 148]
  st    %f2, [%g1 + 152]
  st    %f3, [%g1 + 156]
  st    %f4, [%g1 + 160]
  st    %f5, [%g1 + 164]
  st    %f6, [%g1 + 168]
  st    %f7, [%g1 + 172]
  st    %f8, [%g1 + 176]
  st    %f9, [%g1 + 180]
  st    %f10, [%g1 + 184]
  st    %f11, [%g1 + 188]
  st    %f12, [%g1 + 192]
  st    %f13, [%g1 + 196]
  st    %f14, [%g1 + 200]
  st    %f15, [%g1 + 204]
  st    %f16, [%g1 + 208]
  st    %f17, [%g1 + 212]
  st    %f18, [%g1 + 216]
  st    %f19, [%g1 + 220]
  st    %f20, [%g1 + 224]
  st    %f21, [%g1 + 228]
  st    %f22, [%g1 + 232]
  st    %f23, [%g1 + 236]
  st    %f24, [%g1 + 240]
  st    %f25, [%g1 + 244]
  st    %f26, [%g1 + 248]
  st    %f27, [%g1 + 252]
  st    %f28, [%g1 + 256]
  st    %f29, [%g1 + 260]
  st    %f30, [%g1 + 264]
  st    %f31, [%g1 + 268]

  ! write(1, &isa_dump, ISA_DUMP_BYTES)
  mov   4, %g1                  ! __NR_write
  mov   1, %o0
  sethi %hi(isa_dump), %o1
  or    %o1, %lo(isa_dump), %o1
  ! 1296 fits in the 13-bit signed immediate, so no %hi/%lo pair.
  mov   1296, %o2               ! ISA_DUMP_BYTES
  ta    0x10

  ! _exit(0)
  mov   1, %g1                  ! __NR_exit
  mov   0, %o0
  ta    0x10

  unimp                         ! unreachable; traps loudly if exit returns
  .size _start, . - _start

  .section .note.GNU-stack,"",@progbits
