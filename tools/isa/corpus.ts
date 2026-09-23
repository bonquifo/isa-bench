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
 *   - signed overflow is defined, via -fwrapv.
 *
 * The wrapping itself lives in src/compiler/wrap.ts, because the app wraps a
 * user's program the same way before compiling it.
 */
import { C_EXAMPLES } from '../../src/engine/c/programs.ts'
import { REAL_TARGET_FLAGS, wrapForRealTarget, type ReturnChannel } from '../../src/compiler/wrap.ts'

/** The flags every real target compiles the corpus with; see wrap.ts. */
export const CORPUS_FLAGS = REAL_TARGET_FLAGS

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
  returnChannel?: ReturnChannel
}

export function corpusPrograms(options: CorpusOptions = {}): CorpusProgram[] {
  return C_EXAMPLES.map((example) => ({
    name: `corpus-${example.id}`,
    id: example.id,
    source: wrapForRealTarget(example.source, options.returnChannel),
    expectedReturn: example.expectedReturn,
    expectedStdout: example.expectedStdout,
  }))
}
