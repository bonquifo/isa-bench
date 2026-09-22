/**
 * The precompiled MOS 6502 images the app ships.
 *
 * Two things differ from every other target's copy of this file.
 *
 * The extension is `.bin`, not `.elf`. The `sim` linker script emits a
 * chunked memory image -- load address, length, bytes, repeated -- and
 * that is what the simulator runs, so it is what was compared against.
 * The ELF exists too and carries the symbols the disassembly needs, but
 * shipping it would mean shipping a file nothing verified end to end.
 *
 * The list is one program short. `struct` does not build here, and the
 * reason is the architecture rather than the backend: `int` is sixteen
 * bits on this machine, so the program's own assertion that its struct
 * is eight bytes wide is correctly refused by the compiler. That is
 * recorded in fixtures/corpus.json and asserted in shipped.test.ts, so
 * the gap is a stated fact rather than a program that quietly vanishes
 * from the menu.
 */
import { missingFrom, programsFrom, type ProgramUrls, type ShippedProgram } from '../shipped.ts'

import cubeUrl from './fixtures/corpus-cube.bin?url'
import fftUrl from './fixtures/corpus-fft.bin?url'
import fibUrl from './fixtures/corpus-fib.bin?url'
import fireUrl from './fixtures/corpus-fire.bin?url'
import helloUrl from './fixtures/corpus-hello.bin?url'
import lifeUrl from './fixtures/corpus-life.bin?url'
import mandelbrotUrl from './fixtures/corpus-mandelbrot.bin?url'
import nbodyUrl from './fixtures/corpus-nbody.bin?url'
import piUrl from './fixtures/corpus-pi.bin?url'
import ptrUrl from './fixtures/corpus-ptr.bin?url'
import queensUrl from './fixtures/corpus-queens.bin?url'
import sumUrl from './fixtures/corpus-sum.bin?url'
import wolfUrl from './fixtures/corpus-wolf.bin?url'

export { decodeDataUri, loadShippedElf } from '../shipped.ts'
export type { ShippedProgram } from '../shipped.ts'

/**
 * Written out rather than generated, because a bundler has to see each
 * import statically to include the file at all. `unshippedProgramIds`
 * checks the list against the corpus, so one going missing for a reason
 * nobody recorded is a test failure.
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
  sum: sumUrl,
  wolf: wolfUrl,
}

/** Every corpus program that has a precompiled 6502 image. */
export function shippedPrograms(): ShippedProgram[] {
  return programsFrom(URLS)
}

/** Corpus programs with no image, so the UI can say so rather than omit them. */
export function unshippedProgramIds(): string[] {
  return missingFrom(URLS)
}
