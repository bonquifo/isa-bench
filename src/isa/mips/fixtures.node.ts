/**
 * MIPS32 binding for the shared fixture reader: where the fixtures live
 * and how to name the fields of this architecture's state dump.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIPS_DUMP_BYTES } from './backend.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MIPS_FIXTURE_DIR = join(HERE, 'fixtures')

const SCRATCH_OFFSET = 400

const GPR_NAMES = [
  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
  't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
  't8', 't9', 'k0', 'k1', 'gp', 'sp', 's8', 'ra',
]

/**
 * Mirrors struct IsaDump in tools/isa/mips/harness.h.
 *
 * The general registers are four bytes wide here and the floating-point
 * ones are eight, so a label cannot be derived from the offset alone the
 * way it can on the 64-bit targets.
 */
export function labelMipsDump(bytes: Uint8Array): Map<number, string> {
  const labels = new Map<number, string>()
  for (let i = 0; i < 32; i++) labels.set(i * 4, GPR_NAMES[i]!)
  labels.set(128, 'hi')
  labels.set(132, 'lo')
  labels.set(136, 'fcsr')
  labels.set(140, 'pad')
  for (let i = 0; i < 32; i++) labels.set(144 + i * 8, `f${i}`)
  for (let i = SCRATCH_OFFSET; i < bytes.length; i += 8) {
    labels.set(i, `scratch[${(i - SCRATCH_OFFSET) / 8}]`)
  }
  return labels
}

export { MIPS_DUMP_BYTES }
