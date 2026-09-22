/**
 * AArch64 binding for the shared fixture reader: where the fixtures live and
 * how to name the fields of this architecture's state dump.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AARCH64_DUMP_BYTES } from './backend.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const AARCH64_FIXTURE_DIR = join(HERE, 'fixtures')

const SCRATCH_OFFSET = 800

/** Mirrors struct IsaDump in tools/isa/aarch64/harness.h. */
export function labelAarch64Dump(bytes: Uint8Array): Map<number, string> {
  const labels = new Map<number, string>()
  for (let i = 0; i < 31; i++) labels.set(i * 8, `x${i}`)
  labels.set(248, 'sp')
  for (let i = 0; i < 32; i++) {
    labels.set(256 + i * 16, `v${i}.low`)
    labels.set(256 + i * 16 + 8, `v${i}.high`)
  }
  labels.set(768, 'fpsr')
  labels.set(776, 'fpcr')
  labels.set(784, 'nzcv')
  labels.set(792, 'pad')
  for (let i = SCRATCH_OFFSET; i < bytes.length; i += 8) {
    labels.set(i, `scratch[${(i - SCRATCH_OFFSET) / 8}]`)
  }
  return labels
}

export { AARCH64_DUMP_BYTES }
