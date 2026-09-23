/**
 * The precompiled WebAssembly modules the app ships.
 *
 * These are the same files the conformance suite verifies, not copies of
 * them: what the app runs is exactly what was compared against wasmtime,
 * byte for byte on the output and on the return value.
 *
 * Two differences from every other target's copy of this file.
 *
 * The extension is `.wasm`, because a module is its own container and
 * there is no ELF anywhere in this target's toolchain.
 *
 * And they are smaller than the statically linked targets, though by
 * less than the format's reputation suggests: the fourteen come to
 * 234 KiB here against 347 KiB for RISC-V, 370 for AArch64 and 413 for
 * MIPS, all against musl. Roughly a third off rather than a multiple.
 * The 6502's thirteen are 67 KiB, so this is not the smallest target
 * either -- an eight-bit machine's code simply is smaller.
 *
 * The reading of them is in ../shipped.ts, which every target shares.
 */
import { missingFrom, programsFrom, type ProgramUrls, type ShippedProgram } from '../shipped.ts'

import cubeUrl from './fixtures/corpus-cube.wasm?url'
import fftUrl from './fixtures/corpus-fft.wasm?url'
import fibUrl from './fixtures/corpus-fib.wasm?url'
import fireUrl from './fixtures/corpus-fire.wasm?url'
import helloUrl from './fixtures/corpus-hello.wasm?url'
import lifeUrl from './fixtures/corpus-life.wasm?url'
import mandelbrotUrl from './fixtures/corpus-mandelbrot.wasm?url'
import nbodyUrl from './fixtures/corpus-nbody.wasm?url'
import piUrl from './fixtures/corpus-pi.wasm?url'
import ptrUrl from './fixtures/corpus-ptr.wasm?url'
import queensUrl from './fixtures/corpus-queens.wasm?url'
import structUrl from './fixtures/corpus-struct.wasm?url'
import sumUrl from './fixtures/corpus-sum.wasm?url'
import wolfUrl from './fixtures/corpus-wolf.wasm?url'

export { decodeDataUri, loadShippedElf } from '../shipped.ts'
export type { ShippedProgram } from '../shipped.ts'

/**
 * Written out rather than generated, because a bundler has to see each
 * import statically to include the file at all. `shippedPrograms` checks
 * the list against the corpus, so one going missing is a test failure
 * and not a program that quietly disappears from the menu.
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

/** Every corpus program that has a precompiled module. */
export function shippedPrograms(): ShippedProgram[] {
  return programsFrom(URLS)
}

/** Corpus programs with no module, so the UI can say so rather than omit them. */
export function unshippedProgramIds(): string[] {
  return missingFrom(URLS)
}
