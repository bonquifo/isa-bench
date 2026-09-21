/**
 * The precompiled RV64 binaries the app ships, and how to get their bytes.
 *
 * The app cannot compile at runtime: the minimal clang image is 912 MB and
 * needs Docker, which a desktop application cannot assume. So the real-ISA
 * path runs binaries built ahead of time — which is also why editing the C
 * and re-running is a pseudo-backend feature and not a real-backend one.
 *
 * These are the same files the differential suite verifies, not copies of
 * them. Shipping the verified bytes rather than a rebuild is the point: what
 * the app runs is exactly what was compared against qemu and against the
 * app's own recorded answers. They are linked with --strip-all, which removes
 * a third of the bytes and nothing the loader reads.
 */
import { C_EXAMPLES, type CExample } from '../../engine/c/programs.ts'

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

/**
 * Written out rather than generated, because a bundler has to see each
 * import statically to include the file at all. `shippedPrograms` checks the
 * list against the corpus, so one going missing is a test failure and not a
 * program that quietly disappears from the menu.
 */
const URLS: Readonly<Record<string, string>> = {
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

export interface ShippedProgram {
  id: string
  example: CExample
  url: string
}

/** Every corpus program that has a precompiled RV64 binary. */
export function shippedPrograms(): ShippedProgram[] {
  return C_EXAMPLES.filter((example) => URLS[example.id] !== undefined)
    .map((example) => ({ id: example.id, example, url: URLS[example.id]! }))
}

/** Corpus programs with no binary, so the UI can say so rather than omit them. */
export function unshippedProgramIds(): string[] {
  return C_EXAMPLES.filter((example) => URLS[example.id] === undefined).map((e) => e.id)
}

/**
 * Reads a shipped binary.
 *
 * Two paths because the app runs in two places. A production build inlines
 * these as `data:` URIs, which is deliberate: the packaged desktop app loads
 * over `file://`, where `fetch` of a sibling file is blocked by the browser
 * engine. The development server serves them over http, where it is not.
 */
export async function loadShippedElf(url: string): Promise<Uint8Array> {
  if (url.startsWith('data:')) return decodeDataUri(url)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`could not read ${url}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export function decodeDataUri(url: string): Uint8Array {
  const comma = url.indexOf(',')
  if (comma < 0) throw new Error('malformed data URI')
  if (!url.slice(0, comma).includes(';base64')) {
    throw new Error('data URI is not base64; the bundler config changed')
  }
  const binary = atob(url.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
