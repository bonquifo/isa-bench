/**
 * SPARC V8 binding for the shared fixture reader: where the fixtures
 * live and how to name the fields of this architecture's state dump.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPARC_DUMP_BYTES } from './backend.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SPARC_FIXTURE_DIR = join(HERE, 'fixtures')

const SCRATCH_OFFSET = 272

/**
 * Mirrors struct IsaDump in tools/isa/sparc/harness.h.
 *
 * Both the integer and the floating-point registers are four bytes wide
 * here, which is unusual among these targets and is why the
 * floating-point ones are strided by four rather than by eight.
 */
export function labelSparcDump(bytes: Uint8Array): Map<number, string> {
  const labels = new Map<number, string>()
  for (let i = 0; i < 8; i++) labels.set(i * 4, `g${i}`)
  for (let i = 0; i < 8; i++) labels.set(32 + i * 4, `o${i}`)
  for (let i = 0; i < 8; i++) labels.set(64 + i * 4, `l${i}`)
  for (let i = 0; i < 8; i++) labels.set(96 + i * 4, `i${i}`)
  labels.set(128, 'y')
  labels.set(132, 'icc')
  labels.set(136, 'fsr')
  labels.set(140, 'pad')
  for (let i = 0; i < 32; i++) labels.set(144 + i * 4, `f${i}`)
  for (let i = SCRATCH_OFFSET; i < bytes.length; i += 4) {
    labels.set(i, `scratch[${(i - SCRATCH_OFFSET) / 4}]`)
  }
  return labels
}

export { SPARC_DUMP_BYTES }
