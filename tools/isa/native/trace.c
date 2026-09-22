/*
 * Single-step reference tracer for x86-64.
 *
 * Every other target in this project is compared against qemu. x86-64 is the
 * one where something better is available: the machine running the tests is
 * an x86-64 machine, so the reference can be the processor itself rather
 * than a model of it. That closes the one gap a qemu-only comparison leaves
 * open -- an emulator is another implementation of the same specification,
 * and could in principle be wrong in the same way an interpreter is.
 *
 * The child is single-stepped with PTRACE_SINGLESTEP and its registers read
 * with PTRACE_GETREGS before each instruction, which gives the same
 * before-every-instruction comparison qemu's `-d cpu` gives elsewhere.
 *
 * Three details matter for reproducibility:
 *
 *   Address-space randomisation is turned off in the child, so the stack
 *   pointer a capture records is the one the next capture will see.
 *
 *   Only the arithmetic flags are reported. The rest of RFLAGS is the
 *   interrupt flag, the reserved bits and the trap flag single-stepping
 *   itself sets, none of which a userspace program can observe or an
 *   interpreter should model.
 *
 *   The child's stdout is left alone. The guest writes its architectural
 *   state there, and the trace goes to a named file instead, so the two
 *   never interleave.
 *
 * Usage: trace <log-path> <program> [args...]
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/personality.h>
#include <sys/ptrace.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <unistd.h>

/* CF, PF, AF, ZF, SF, OF: the flags an instruction computes and a program
   can branch on. DF is not here because nothing in this corpus sets it. */
#define FLAG_MASK 0x08d5ULL

/* Enough for any fixture; a program that runs away should fail, not hang. */
#define STEP_LIMIT 40000000L

/*
 * Reported in the architecture's own register numbering, which is the
 * numbering the ModRM byte uses, so a divergence names the register the
 * encoding names. That is not the order the kernel's struct uses.
 */
static unsigned long long gpr(const struct user_regs_struct *r, int i) {
  switch (i) {
    case 0: return r->rax;
    case 1: return r->rcx;
    case 2: return r->rdx;
    case 3: return r->rbx;
    case 4: return r->rsp;
    case 5: return r->rbp;
    case 6: return r->rsi;
    case 7: return r->rdi;
    case 8: return r->r8;
    case 9: return r->r9;
    case 10: return r->r10;
    case 11: return r->r11;
    case 12: return r->r12;
    case 13: return r->r13;
    case 14: return r->r14;
    default: return r->r15;
  }
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: trace <log-path> <program> [args...]\n");
    return 2;
  }
  FILE *log = fopen(argv[1], "w");
  if (!log) {
    perror("open log");
    return 2;
  }

  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return 2;
  }
  if (pid == 0) {
    if (personality(ADDR_NO_RANDOMIZE) < 0) {
      /* Docker's default seccomp profile rejects this call, and a capture
         made with the stack still randomised would differ from the next one
         for no architectural reason. Naming the flag beats a bare EPERM. */
      fprintf(stderr,
              "personality(ADDR_NO_RANDOMIZE): %s; "
              "the tracer needs --security-opt seccomp=unconfined\n",
              strerror(errno));
      _exit(126);
    }
    if (ptrace(PTRACE_TRACEME, 0, 0, 0) < 0) {
      perror("traceme");
      _exit(126);
    }
    execv(argv[2], &argv[2]);
    perror("exec");
    _exit(127);
  }

  int status = 0;
  if (waitpid(pid, &status, 0) < 0) {
    perror("waitpid");
    return 2;
  }
  if (!WIFSTOPPED(status)) {
    fprintf(stderr, "child did not stop at its entry point\n");
    return 2;
  }

  long steps = 0;
  struct user_regs_struct r;
  char line[32 + 17 * 22];
  int afterSyscall = 0;
  while (steps < STEP_LIMIT) {
    if (ptrace(PTRACE_GETREGS, pid, 0, &r) < 0) {
      perror("getregs");
      return 2;
    }
    /*
     * The one place the tracing mechanism leaks into what it observes.
     *
     * `syscall` copies the whole of RFLAGS into r11, and while the child is
     * being single-stepped RFLAGS has the trap flag set -- so r11 ends up
     * holding a bit that is there because of the tracer and would not be
     * there in an ordinary run. Worse, it stays there: every later step
     * reports it until something else writes r11.
     *
     * So it is cleared in the child rather than in the report, which puts
     * the register back to what an untraced run would have had and keeps
     * it that way. Only the one instruction that can set it is treated
     * this way, recognised by reading back the bytes at the address just
     * executed, so a value a program computed for itself is never touched.
     */
    if (afterSyscall && (r.r11 & 0x100ULL) != 0) {
      r.r11 &= ~0x100ULL;
      if (ptrace(PTRACE_SETREGS, pid, 0, &r) < 0) {
        perror("setregs");
        return 2;
      }
    }
    afterSyscall = 0;
    {
      errno = 0;
      long word = ptrace(PTRACE_PEEKTEXT, pid, (void *)(uintptr_t)r.rip, 0);
      if (!(word == -1 && errno != 0)) {
        afterSyscall = ((unsigned long)word & 0xffff) == 0x050f;
      }
    }
    int at = snprintf(line, sizeof line, "PC=%llx", (unsigned long long)r.rip);
    for (int i = 0; i < 16; i++) {
      at += snprintf(line + at, sizeof line - (size_t)at, " R%02d=%llx", i, gpr(&r, i));
    }
    snprintf(line + at, sizeof line - (size_t)at, " FL=%llx\n",
             (unsigned long long)r.eflags & FLAG_MASK);
    fputs(line, log);

    if (ptrace(PTRACE_SINGLESTEP, pid, 0, 0) < 0) {
      perror("singlestep");
      return 2;
    }
    if (waitpid(pid, &status, 0) < 0) {
      perror("waitpid");
      return 2;
    }
    steps++;
    if (WIFEXITED(status)) {
      if (fclose(log) != 0) {
        perror("close log");
        return 2;
      }
      fprintf(stderr, "traced %ld instructions, exit %d\n", steps, WEXITSTATUS(status));
      return 0;
    }
    if (WIFSIGNALED(status)) {
      fprintf(stderr, "child killed by signal %d after %ld\n", WTERMSIG(status), steps);
      return 3;
    }
    /* A stop for anything but the single-step trap is a real signal the
       program took. Reporting it beats delivering it and tracing on. */
    int sig = WSTOPSIG(status);
    if (sig != SIGTRAP) {
      fprintf(stderr, "child stopped on signal %d after %ld\n", sig, steps);
      return 3;
    }
  }
  ptrace(PTRACE_KILL, pid, 0, 0);
  fprintf(stderr, "step limit reached\n");
  return 3;
}
