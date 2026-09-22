/**
 * POWER binding for the shared fixture reader: where the fixtures live
 * and how to name the fields of this architecture's state dump.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { POWER_DUMP_BYTES } from './backend.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const POWER_FIXTURE_DIR = join(HERE, 'fixtures')

const SCRATCH_OFFSET = 544

/**
 * Mirrors struct IsaDump in tools/isa/power/harness.h.
 *
 * The floating-point registers are labelled `f0..f31` because that is
 * what the guest stored, but they are the low halves of the first 32
 * vector-scalar registers rather than a file of their own.
 */
export function labelPowerDump(bytes: Uint8Array): Map<number, string> {
  const labels = new Map<number, string>()
  for (let i = 0; i < 32; i++) labels.set(i * 8, `r${i}`)
  labels.set(256, 'lr')
  labels.set(264, 'ctr')
  labels.set(272, 'cr')
  labels.set(280, 'xer')
  for (let i = 0; i < 32; i++) labels.set(288 + i * 8, `f${i}`)
  for (let i = SCRATCH_OFFSET; i < bytes.length; i += 8) {
    labels.set(i, `scratch[${(i - SCRATCH_OFFSET) / 8}]`)
  }
  return labels
}

export { POWER_DUMP_BYTES }
