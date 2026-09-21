/**
 * Reader for committed differential fixtures, shared by every backend.
 *
 * Fixtures are generated against a real oracle by tools/isa and then checked
 * in, so the differential suite runs on any machine and in CI without Docker.
 * Regenerating them needs the oracle; trusting them does not.
 *
 * Everything here is ISA-independent. What is *not* independent, and so lives
 * with each backend, is the layout of the guest's architectural state dump:
 * RV64 has 32 integer and 32 floating-point registers and an fcsr, AArch64
 * has 31 plus a separate stack pointer and 128-bit vector registers. The
 * dump is therefore compared as bytes here, which is both the strongest check
 * and the only one that generalises.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FixtureEntry {
  name: string
  steps: number
  /** Present on generated programs; absent on hand-written ones. */
  seed?: number
}

export interface FixtureIndex {
  generator: string
  codegen: string
  oracle: string
  target: string
  march: string
  flags: string
  randomGenerator: string
  /** Seeds of the randomised programs, so a failure is reproducible by name. */
  randomSeeds: number[]
  fixtures: FixtureEntry[]
}

export function readIndex(dir: string): FixtureIndex {
  return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as FixtureIndex
}

export function fixtureNames(dir: string): string[] {
  return readIndex(dir).fixtures.map((f) => f.name)
}

export function readElf(dir: string, name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dir, `${name}.elf`)))
}

export function readObjdump(dir: string, name: string): string {
  return readFileSync(join(dir, `${name}.objdump.txt`), 'utf8')
}

/** The guest's own architectural state dump, as raw bytes. */
export function readDumpBytes(dir: string, name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dir, `${name}.final.bin`)))
}

export interface LockstepStep {
  pc: bigint
  /**
   * General-purpose registers in the backend's own numbering.
   *
   * The array is reused between iterations, so a consumer must finish with
   * one step before asking for the next. Materialising thirty-two bigints per
   * step over a seventeen-thousand-step trace is avoidable work.
   */
  x: bigint[]
}

/** Expands the delta-encoded lockstep file back into full per-step state. */
export function* readLockstep(dir: string, name: string, gprCount: number): Generator<LockstepStep> {
  const text = readFileSync(join(dir, `${name}.lockstep.txt`), 'utf8')
  const state: bigint[] = Array.from({ length: gprCount }, () => 0n)
  // Tolerate CRLF as well as LF. .gitattributes pins these files to LF, but a
  // fixture regenerated on a host that ignores it must still parse rather than
  // fold a stray carriage return into the last register on every line.
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith('#')) continue
    const parts = line.split(' ')
    const pc = BigInt(`0x${parts[0]!}`)
    for (let i = 1; i < parts.length; i++) {
      const field = parts[i]!
      const equals = field.indexOf('=')
      state[Number(field.slice(1, equals))] = BigInt(`0x${field.slice(equals + 1)}`)
    }
    yield { pc, x: state }
  }
}

/** The architectural state the reference started from, for seeding a run. */
export function initialState(dir: string, name: string, gprCount: number): LockstepStep {
  for (const step of readLockstep(dir, name, gprCount)) return { pc: step.pc, x: [...step.x] }
  throw new Error(`${name}: lockstep fixture is empty`)
}
