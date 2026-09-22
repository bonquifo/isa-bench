/**
 * Reading this target's committed fixtures.
 *
 * Shared by the two tiers that need them: the per-opcode vector tier and
 * the decimal-mode check that records where the whole-program oracle
 * cannot be trusted.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MOS_FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)), 'fixtures',
)

export interface VectorState {
  pc: number
  s: number
  a: number
  x: number
  y: number
  p: number
  ram: [number, number][]
}

export interface Vector {
  initial: VectorState
  final: VectorState
}

export interface VectorIndex {
  sha256: string
  totalCases: number
  source: string
  sampling: { uniformPerOpcode: number; perCondition: number; seed: number }
  opcodes: { opcode: string; cases: number; conditions: Record<string, number> }[]
}

export function readVectorBytes(): Uint8Array {
  return new Uint8Array(readFileSync(resolve(MOS_FIXTURE_DIR, 'vectors.bin')))
}

export function readVectorIndex(): VectorIndex {
  return JSON.parse(
    readFileSync(resolve(MOS_FIXTURE_DIR, 'vectors.json'), 'utf8'),
  ) as VectorIndex
}

/** Unpacks vectors.bin; the format is documented in its index. */
export function parseVectors(raw: Uint8Array): Map<number, Vector[]> {
  let at = 0
  const u8 = (): number => raw[at++]!
  const u16 = (): number => {
    const value = raw[at]! | (raw[at + 1]! << 8)
    at += 2
    return value
  }

  const magic = String.fromCharCode(u8(), u8(), u8(), u8())
  if (magic !== 'M65V') throw new Error(`vectors.bin: bad magic ${magic}`)
  const version = u16()
  if (version !== 1) throw new Error(`vectors.bin: version ${version}`)
  const opcodeCount = u16()

  const readState = (): VectorState => {
    const pc = u16()
    const s = u8()
    const a = u8()
    const x = u8()
    const y = u8()
    const p = u8()
    const length = u8()
    const ram: [number, number][] = []
    for (let i = 0; i < length; i++) ram.push([u16(), u8()])
    return { pc, s, a, x, y, p, ram }
  }

  const byOpcode = new Map<number, Vector[]>()
  for (let i = 0; i < opcodeCount; i++) {
    const opcode = u8()
    const cases = u16()
    const list: Vector[] = []
    for (let c = 0; c < cases; c++) list.push({ initial: readState(), final: readState() })
    byOpcode.set(opcode, list)
  }
  if (at !== raw.length) {
    throw new Error(`vectors.bin: ${raw.length - at} trailing byte(s)`)
  }
  return byOpcode
}

/** The byte a case's initial memory holds; everything else is zero. */
export function vectorByte(state: VectorState, address: number): number {
  for (const [at, value] of state.ram) {
    if (at === (address & 0xffff)) return value
  }
  return 0
}
