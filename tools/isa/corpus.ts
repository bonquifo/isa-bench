/**
 * The app's own C programs, prepared for a real toolchain.
 *
 * These are the workloads the app actually compares across targets, written
 * against the in-house Guest C compiler. Running the same sources through
 * clang and a real libc is the strongest available check that the real
 * backend can carry the app's work, because the expected answers already
 * exist and were produced by something else entirely.
 *
 * Three adjustments, none of which change what a program computes:
 *
 *   - standard headers are prepended. Guest C has printf and malloc built
 *     in; a real compiler wants them declared, and an implicit declaration
 *     of malloc would truncate a 64-bit pointer to int.
 *   - main is renamed and a driver added, because the return value matters
 *     and a process exit status is only eight bits wide. The driver prints
 *     it to stderr, leaving the program's own stdout untouched -- or, on a
 *     target whose platform has only one output stream, frames it.
 *   - signed overflow is defined, via -fwrapv. See the note below.
 */
import { C_EXAMPLES } from '../../src/engine/c/programs.ts'
import { RETURN_SEPARATOR } from '../../src/isa/shipped.ts'

const HEADERS = [
  '#include <stdio.h>',
  '#include <stdlib.h>',
  '#include <string.h>',
  '#include <math.h>',
  '',
].join('\n')

const DRIVER = `
/* The corpus returns a full 32-bit value; an exit status carries eight bits,
   so the value goes to stderr where it cannot disturb the program's stdout. */
int guest_main(void);
int main(void) {
  int result = guest_main();
  fprintf(stderr, "%d", result);
  return 0;
}
`

/**
 * The same driver, for a target whose platform has one output stream.
 *
 * The 6502's platform is a single byte-wide port: its libc sends stderr
 * and stdout to the same address, so "somewhere that cannot disturb
 * stdout" does not exist on that machine. Framing replaces separation.
 * The value follows a record separator, which is a byte no corpus
 * program emits, so a reader can split the stream back into the
 * program's output and the driver's.
 *
 * Deliberately not the exit status, which is the obvious alternative: it
 * carries eight bits and several of these programs return more than
 * that. Truncating silently is the failure mode this project exists to
 * avoid.
 */
const SINGLE_STREAM_DRIVER = `
/* One output port, so the return value is framed rather than separated. */
int guest_main(void);
int main(void) {
  int result = guest_main();
  putchar(${RETURN_SEPARATOR.charCodeAt(0)});
  printf("%d", result);
  return 0;
}
`

/**
 * Signed overflow is undefined in C, and the corpus relies on it wrapping:
 * `fire` seeds a linear congruential generator with `int seed = seed *
 * 1664525 + 1013904223`. Guest C wraps, so the recorded expected answer
 * assumes wrapping; clang at -O2 is entitled to assume the overflow cannot
 * happen, and produces a different result. Without this flag `fire` matches
 * qemu and disagrees with the app, which is exactly what it should do -- the
 * program is the thing at fault.
 *
 * The flag is applied rather than the programs edited because the comparison
 * is meant to be about the instruction set, not about a compiler's licence
 * to exploit undefined behaviour, and because editing them would invalidate
 * expected answers that are currently an independent check.
 */
export const CORPUS_FLAGS = [
  '-fwrapv',
  // These binaries ship inside the app, so the symbol and string tables go.
  // They are a third of the bytes and nothing reads them: the loader needs
  // only the program headers and the entry point.
  '-Wl,--strip-all',
]

export interface CorpusProgram {
  name: string
  id: string
  source: string
  expectedReturn: number
  expectedStdout: { exact: string } | { fnv1a: number; length: number }
}

export interface CorpusOptions {
  /**
   * How the driver reports the return value. `stderr` is the default and
   * what every target with a Linux-like platform uses; `framed` is for a
   * target whose platform has a single output stream.
   */
  returnChannel?: 'stderr' | 'framed'
}

export function corpusPrograms(options: CorpusOptions = {}): CorpusProgram[] {
  const driver = options.returnChannel === 'framed' ? SINGLE_STREAM_DRIVER : DRIVER
  return C_EXAMPLES.map((example) => ({
    name: `corpus-${example.id}`,
    id: example.id,
    // Guest C programs define main; the driver needs that name.
    source: HEADERS + example.source.replace(/\bint\s+main\s*\(/, 'int guest_main(') + driver,
    expectedReturn: example.expectedReturn,
    expectedStdout: example.expectedStdout,
  }))
}
