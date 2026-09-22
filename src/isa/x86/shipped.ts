/**
 * The precompiled x86-64 binaries the app ships.
 *
 * These are the same files the differential suite verifies, not copies of
 * them. Shipping the verified bytes rather than a rebuild is the point: what
 * the app runs is exactly what was compared against qemu and against the
 * app's own recorded answers. They are linked with --strip-all, which removes
 * a third of the bytes and nothing the loader reads.
 *
 * The reading of them is in ../shipped.ts, which every target shares.
 */
import { missingFrom, programsFrom, type ProgramUrls, type ShippedProgram } from '../shipped.ts'

import cubeUrl from './fixtures/corpus-cube.elf?url'
import fftUrl from './fixtures/corpus-fft.elf?url'
import fibUrl from './fixtures/corpus-fib.elf?url'
import fireUrl from './fixtures/corpus-fire.elf?url'
import helloUrl from './fixtures/corpus-hello.elf?url'
import lifeUrl from './fixtures/corpus-life.elf?url'
import mandelbrotUrl from './fixtures/corpus-mandelbrot.elf?url'
import nbodyUrl from './fixtures/corpus-nbody.elf?url'
import piUrl from './fixtures/corpus-pi.elf?url'
import ptrUrl from './fixtures/corpus-ptr.elf?url'
import queensUrl from './fixtures/corpus-queens.elf?url'
import structUrl from './fixtures/corpus-struct.elf?url'
import sumUrl from './fixtures/corpus-sum.elf?url'
import wolfUrl from './fixtures/corpus-wolf.elf?url'

export { decodeDataUri, loadShippedElf } from '../shipped.ts'
export type { ShippedProgram } from '../shipped.ts'

/**
 * Written out rather than generated, because a bundler has to see each
 * import statically to include the file at all. `shippedPrograms` checks the
 * list against the corpus, so one going missing is a test failure and not a
 * program that quietly disappears from the menu.
 */
const URLS: ProgramUrls = {
  cube: cubeUrl,
  fft: fftUrl,
  fib: fibUrl,
  fire: fireUrl,
  hello: helloUrl,
  life: lifeUrl,
  mandelbrot: mandelbrotUrl,
  nbody: nbodyUrl,
  pi: piUrl,
  ptr: ptrUrl,
  queens: queensUrl,
  struct: structUrl,
  sum: sumUrl,
  wolf: wolfUrl,
}

/** Every corpus program that has a precompiled x86-64 binary. */
export function shippedPrograms(): ShippedProgram[] {
  return programsFrom(URLS)
}

/** Corpus programs with no binary, so the UI can say so rather than omit them. */
export function unshippedProgramIds(): string[] {
  return missingFrom(URLS)
}
