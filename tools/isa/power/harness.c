/* Storage for the POWER differential harness. See harness.h. */
#include "harness.h"

__attribute__((aligned(16))) struct IsaDump isa_dump;
__attribute__((aligned(16))) unsigned char isa_stack[ISA_STACK_BYTES];
