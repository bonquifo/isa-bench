/*
 * The freestanding entry point, which is almost nothing.
 *
 * On every other target this file sets up a stack, calls the kernel,
 * writes the architectural state out and exits through a system call.
 * None of that applies here. A module has no stack to set up -- the
 * engine owns the call stack and the operand stack both -- no
 * architectural state worth dumping, and no system calls.
 *
 * So what is left is: export the kernel, and export the memory it wrote
 * into. The caller invokes the one and reads the other.
 */
#include "harness.h"

struct IsaDump isa_dump;

__attribute__((export_name("kernel")))
long isa_entry(void) {
  return kernel();
}

/*
 * Where the dump lives, so a caller can find the scratch area without
 * parsing the module's symbol table. The programs write through
 * `isa_dump.scratch`, and the comparison covers all of memory anyway --
 * this is for diagnostics, so a mismatch can say which slot.
 */
__attribute__((export_name("dump_address")))
unsigned dump_address(void) {
  return (unsigned)(unsigned long)&isa_dump;
}
