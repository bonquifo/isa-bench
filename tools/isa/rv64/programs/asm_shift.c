/*
 * Shift-amount masking, pinned down with inline asm.
 *
 * C cannot express this: shifting by more than the operand width is undefined
 * behaviour, so a C-level test would be testing the compiler's licence to do
 * anything rather than the hardware's behaviour. RV64 masks the amount to the
 * low 6 bits for the 64-bit forms and to the low 5 for the W forms, and the
 * W forms then sign-extend their 32-bit result back across the register.
 */
#include "harness.h"

#define SLOT(i) (((unsigned long *)isa_dump.scratch)[i])

volatile unsigned long value = 0x8123456789abcdefUL;
volatile unsigned long amounts[8] = { 0, 1, 31, 32, 33, 63, 64, 127 };

long kernel(void) {
  unsigned long a = value;
  int k = 0;
  for (int i = 0; i < 8; i++) {
    unsigned long s = amounts[i];
    unsigned long r;
    __asm__("sll  %0, %1, %2" : "=r"(r) : "r"(a), "r"(s));
    SLOT(k++) = r;
    __asm__("srl  %0, %1, %2" : "=r"(r) : "r"(a), "r"(s));
    SLOT(k++) = r;
    __asm__("sra  %0, %1, %2" : "=r"(r) : "r"(a), "r"(s));
    SLOT(k++) = r;
    __asm__("sllw %0, %1, %2" : "=r"(r) : "r"(a), "r"(s));
    SLOT(k++) = r;
    __asm__("srlw %0, %1, %2" : "=r"(r) : "r"(a), "r"(s));
    SLOT(k++) = r;
    __asm__("sraw %0, %1, %2" : "=r"(r) : "r"(a), "r"(s));
    SLOT(k++) = r;
  }

  /* Immediate forms have their own encodings and their own shamt fields. */
  unsigned long r;
  __asm__("slli  %0, %1, 0"  : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__("slli  %0, %1, 63" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__("srli  %0, %1, 63" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__("srai  %0, %1, 63" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__("srai  %0, %1, 1"  : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__("slliw %0, %1, 31" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__("srliw %0, %1, 31" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__("sraiw %0, %1, 31" : "=r"(r) : "r"(a)); SLOT(k++) = r;
  __asm__("sraiw %0, %1, 0"  : "=r"(r) : "r"(a)); SLOT(k++) = r;

  return (long)k;
}
