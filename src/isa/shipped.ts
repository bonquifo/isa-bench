/**
 * Reading the precompiled binaries the app ships, independently of which
 * instruction set they are for.
 *
 * The app cannot compile at runtime: the minimal clang image is 912 MB and
 * needs Docker, which a desktop application cannot assume. So the real-ISA
 * path runs binaries built ahead of time — which is also why editing the C
 * and re-running is a pseudo-backend feature and not a real-backend one.
 *
 * Each target keeps its own list of imports next to its fixtures, because a
 * bundler has to see every import statically to include the file at all.
 * What is shared is everything after that: matching the list against the
 * corpus, and turning a URL back into bytes.
 */
import { C_EXAMPLES, type CExample } from '../engine/c/programs.ts'

/**
 * The byte that separates a program's output from its return value, on a
 * target whose platform has only one output stream.
 *
 * Most targets put the corpus driver's return value on stderr, where it
 * cannot disturb stdout. The 6502's platform is a single byte-wide port
 * -- its libc sends both streams to the same address -- so there the two
 * are framed instead, and this is the frame. Defined here rather than in
 * the fixture tooling because both sides need it: the tooling emits it
 * and the app reads it back.
 */
export const RETURN_SEPARATOR = '\x1e'

/** A corpus program paired with the binary built from it. */
export interface ShippedProgram {
  id: string
  example: CExample
  url: string
}

export type ProgramUrls = Readonly<Record<string, string>>

/** Every corpus program this target has a precompiled binary for. */
export function programsFrom(urls: ProgramUrls): ShippedProgram[] {
  return C_EXAMPLES.filter((example) => urls[example.id] !== undefined)
    .map((example) => ({ id: example.id, example, url: urls[example.id]! }))
}

/** Corpus programs with no binary, so the UI can say so rather than omit them. */
export function missingFrom(urls: ProgramUrls): string[] {
  return C_EXAMPLES.filter((example) => urls[example.id] === undefined).map((e) => e.id)
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
