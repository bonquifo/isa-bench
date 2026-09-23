/*
 * The part of the SPARC libc that is not picolibc: five system calls.
 *
 * musl has no SPARC port, glibc now requires V9 even for 32-bit code, and
 * Buildroot can no longer build uClibc-ng for this target (a GCC change
 * broke it and the GCC versions that worked have been removed). picolibc
 * supports SPARC and builds with the same clang as every other target
 * here, but it is a library for machines without an operating system: it
 * leaves input, output and exit to the platform.
 *
 * This file is that platform, and it is deliberately the smallest thing
 * that could be. picolibc's console, built with `posix-console`, reads and
 * writes through the POSIX calls below; its heap is a static region
 * defined in crt1.S; everything else -- printf, malloc, the string and
 * math functions -- is picolibc's own. What a comparison against another
 * target measures inside the library is therefore picolibc's code rather
 * than musl's, which is a real difference and is stated wherever this
 * target's results are.
 *
 * A system call on SPARC Linux is software trap 0x10, with the number in
 * %g1 and the arguments in %o0 to %o5. The kernel reports an error by
 * setting the carry flag and returning a *positive* errno in %o0, which is
 * the convention this file converts from.
 */
#include <errno.h>
#include <stdlib.h>
#include <unistd.h>

/* From unistd_32.h in linux-libc-dev-sparc64-cross, not from memory. */
#define SYS_exit_group 188
#define SYS_read 3
#define SYS_write 4
#define SYS_close 6
#define SYS_lseek 19

static long syscall3(long number, long a, long b, long c) {
  register long g1 __asm__("g1") = number;
  register long o0 __asm__("o0") = a;
  register long o1 __asm__("o1") = b;
  register long o2 __asm__("o2") = c;
  __asm__ volatile("ta 0x10\n\t"
                   /* Carry clear means success, and %o0 is the result. */
                   "bcc 1f\n\t"
                   " nop\n\t"
                   /* Carry set means %o0 is a positive errno. */
                   "sub %%g0, %%o0, %%o0\n"
                   "1:"
                   : "+r"(o0)
                   : "r"(g1), "r"(o1), "r"(o2)
                   : "memory", "cc");
  return o0;
}

static long checked(long result) {
  if (result < 0) {
    errno = (int)-result;
    return -1;
  }
  return result;
}

ssize_t write(int fd, const void *buffer, size_t length) {
  return checked(syscall3(SYS_write, fd, (long)buffer, (long)length));
}

ssize_t read(int fd, void *buffer, size_t length) {
  return checked(syscall3(SYS_read, fd, (long)buffer, (long)length));
}

off_t lseek(int fd, off_t offset, int whence) {
  return checked(syscall3(SYS_lseek, fd, (long)offset, whence));
}

int close(int fd) {
  return (int)checked(syscall3(SYS_close, fd, 0, 0));
}

void _exit(int code) {
  syscall3(SYS_exit_group, code, 0, 0);
  /* The kernel does not return from this; a machine that did would stop
     here rather than run on into whatever follows. */
  for (;;) __asm__ volatile("unimp 0");
}

extern int main(int, char **);
extern void __libc_init_array(void);
extern void __libc_fini_array(void);

/*
 * The C half of the entry point: argc and argv from the stack the kernel
 * built, constructors, main, and exit. The destructors are registered with
 * atexit because that is where picolibc's console flushes its buffered
 * output -- without it, a program that printed without a newline at the
 * end would lose that last line.
 */
void __isa_start(long *stack) {
  int argc = (int)stack[0];
  char **argv = (char **)(stack + 1);
  atexit(__libc_fini_array);
  __libc_init_array();
  exit(main(argc, argv));
}
