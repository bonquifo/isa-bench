/**
 * The real targets, with binaries read from the committed fixtures.
 *
 * The claims -- label, library, oracle, how far verified -- come from the
 * app's own list in src/lanes/realTargets.ts, so a test sees exactly what
 * the app would say. Only how the bytes are fetched differs: the app loads
 * the shipped copies through the bundler, and this reads the fixture files
 * they were copied from, which each backend's shipped.test.ts checks are
 * the same bytes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IsaId, type IsaId as IsaIdT } from './types.ts'
import type { RealTargetProvider } from './compareReal.ts'
import { REAL_TARGETS } from '../lanes/realTargets.ts'

const ISA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../isa')

/** Where each target's fixtures live, and what its binaries are called. */
const FILES: Readonly<Record<IsaIdT, { dir: string; extension: string }>> = {
  [IsaId.RISCV]: { dir: 'riscv', extension: 'elf' },
  [IsaId.ARM]: { dir: 'aarch64', extension: 'elf' },
  [IsaId.X86]: { dir: 'x86', extension: 'elf' },
  [IsaId.MIPS]: { dir: 'mips', extension: 'elf' },
  [IsaId.POWER]: { dir: 'power', extension: 'elf' },
  [IsaId.SPARC]: { dir: 'sparc', extension: 'elf' },
  [IsaId.WASM]: { dir: 'wasm', extension: 'wasm' },
  [IsaId.MOS]: { dir: 'mos', extension: 'bin' },
}

export const fixtureRealProvider: RealTargetProvider = (isa) => {
  const target = REAL_TARGETS.find((candidate) => candidate.id === isa)
  const files = FILES[isa]
  if (!target || !files) return undefined
  return {
    isa,
    label: target.label,
    libc: target.libc,
    oracle: target.oracle,
    verified: target.verified,
    intBits: target.intBits,
    returnChannel: target.returnChannel,
    backend: target.backend,
    binary: (programId) => {
      const path = join(ISA_ROOT, files.dir, 'fixtures', `corpus-${programId}.${files.extension}`)
      return Promise.resolve(existsSync(path) ? new Uint8Array(readFileSync(path)) : null)
    },
  }
}
