/**
 * The MOS 6502 conformance tier: every documented opcode, against vectors
 * recorded from hardware.
 *
 * This is the tier that replaces lockstep on this target, and for one
 * instruction at a time it is stronger than lockstep. A lockstep run only
 * ever reaches the machine states a compiler's output happens to produce;
 * a compiler emits `sed` never, `adc` with the overflow flag already set
 * rarely, and `jmp` through a pointer at $xxFF never at all. These cases
 * reach arbitrary states on purpose -- the whole status register is
 * random in every one of them -- so they cover combinations no program
 * in the corpus would produce.
 *
 * What it does not cover is instructions in sequence, which is what the
 * whole-program tier is for. Neither tier is sufficient alone and the
 * pair is stated as the claim this target makes.
 *
 * The sample, the seed and the source commit are recorded in
 * fixtures/vectors.json; tools/isa/mos/build-vectors.ts regenerates it.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MosBus } from './bus.ts'
import { DOCUMENTED_OPCODES, MOS_NAME, decode } from './decode.ts'
import { MosInterpreter } from './exec.ts'
import {
  parseVectors,
  readVectorBytes,
  readVectorIndex,
} from './fixtures.node.ts'
import { MosImage } from './image.ts'

const RAW = readVectorBytes()
const INDEX = readVectorIndex()
const VECTORS = parseVectors(RAW)

/** What the machine looks like, for a failure message. */
function describeState(state: {
  pc: number; s: number; a: number; x: number; y: number; p: number
}): string {
  const hex = (v: number, n = 2): string => v.toString(16).padStart(n, '0')
  const flags = 'nv-bdizc'
  let spelled = ''
  for (let bit = 7; bit >= 0; bit--) {
    spelled += (state.p >> bit) & 1 ? flags[7 - bit]!.toUpperCase() : flags[7 - bit]!
  }
  return `pc=${hex(state.pc, 4)} a=${hex(state.a)} x=${hex(state.x)} ` +
    `y=${hex(state.y)} s=${hex(state.s)} p=${hex(state.p)} [${spelled}]`
}

describe('mos 6502: per-opcode vectors from hardware', () => {
  it('is the fixture the index describes', () => {
    expect(createHash('sha256').update(RAW).digest('hex')).toBe(INDEX.sha256)
    expect(INDEX.totalCases).toBe(
      [...VECTORS.values()].reduce((sum, list) => sum + list.length, 0),
    )
    expect(VECTORS.size).toBe(DOCUMENTED_OPCODES.length)
  })

  it('covers every documented opcode and nothing else', () => {
    expect([...VECTORS.keys()].sort((a, b) => a - b)).toEqual([...DOCUMENTED_OPCODES])
  })

  // One test per opcode rather than one for all of them, so a failure
  // names the instruction rather than a case number in twenty thousand.
  for (const opcode of DOCUMENTED_OPCODES) {
    const cases = VECTORS.get(opcode)!
    const name = MOS_NAME[decode(() => opcode, 0n).op]
    const label = `${opcode.toString(16).padStart(2, '0')} ${name}`

    it(`${label}: ${cases.length} cases`, () => {
      const bus = new MosBus()
      const problems: string[] = []

      for (let index = 0; index < cases.length; index++) {
        const { initial, final } = cases[index]!
        bus.ram.fill(0)
        for (const [address, value] of initial.ram) bus.ram[address] = value

        // A fresh image per case: the same address holds a different
        // instruction in the next one, and a decode cache that survived
        // would be answering about the previous case.
        const image = new MosImage(bus, BigInt(initial.pc), 0)
        const cpu = new MosInterpreter(image, bus, { entry: initial.pc })
        cpu.a = initial.a
        cpu.x = initial.x
        cpu.y = initial.y
        cpu.s = initial.s
        cpu.p = initial.p

        try {
          cpu.step()
        } catch (error) {
          problems.push(`#${index}: threw — ${(error as Error).message}`)
          continue
        }

        const mine = { pc: cpu.pc, a: cpu.a, x: cpu.x, y: cpu.y, s: cpu.s, p: cpu.p }
        const differs: string[] = []
        for (const key of ['pc', 'a', 'x', 'y', 's', 'p'] as const) {
          if (mine[key] !== final[key]) {
            differs.push(`${key}=${mine[key].toString(16)} want ${final[key].toString(16)}`)
          }
        }
        for (const [address, value] of final.ram) {
          if (bus.ram[address] !== value) {
            differs.push(
              `[${address.toString(16).padStart(4, '0')}]=` +
              `${bus.ram[address]!.toString(16)} want ${value.toString(16)}`,
            )
          }
        }
        if (differs.length > 0) {
          problems.push(
            `#${index}: ${differs.join(', ')}\n` +
            `      before ${describeState(initial)}\n` +
            `      after  ${describeState(mine)}\n` +
            `      want   ${describeState(final)}`,
          )
        }
      }

      if (problems.length > 0) {
        expect.fail(
          `${label}: ${problems.length} of ${cases.length} cases wrong\n` +
          problems.slice(0, 8).join('\n'),
        )
      }
    })
  }
})

describe('mos 6502: the encodings the architecture does not define', () => {
  const undocumented = Array.from({ length: 256 }, (_, i) => i)
    .filter((opcode) => !DOCUMENTED_OPCODES.includes(opcode))

  it('is the 105 the opcode map leaves out', () => {
    expect(undocumented.length).toBe(105)
    expect(DOCUMENTED_OPCODES.length).toBe(151)
  })

  it('refuses every one of them rather than guessing', () => {
    // Real silicon does something for each of these, and the something is
    // reproducible enough that programs were written against it. None of
    // it has been verified here, so decoding one would be a claim this
    // project has not earned.
    for (const opcode of undocumented) {
      expect(() => decode(() => opcode, 0n), `opcode ${opcode.toString(16)}`).toThrow(
        /undocumented opcode/,
      )
    }
  })
})

describe('mos 6502: what the vector tier covers', () => {
  it('reaches the structural edges on the opcodes that have them', () => {
    // A sample that happened to miss these would still pass every case in
    // it, which is exactly the failure this checks for. Each condition is
    // asserted against the opcodes that can produce it.
    const conditionsFor = (hex: string): Record<string, number> =>
      INDEX.opcodes.find((entry) => entry.opcode === hex)?.conditions ?? {}

    // (zp),Y on `lda`: the pointer wrapping in page zero, and the sum
    // crossing a page.
    expect(conditionsFor('b1')['zp-pointer-wrap']).toBeGreaterThan(0)
    expect(conditionsFor('b1')['page-cross']).toBeGreaterThan(0)
    // (zp,X) on `lda`: the index wrapping before the indirection.
    expect(conditionsFor('a1')['zp-index-wrap']).toBeGreaterThan(0)
    // The indirect jump's page-carry defect.
    expect(conditionsFor('6c')['jmp-pointer-bug']).toBeGreaterThan(0)
    // Decimal mode on both of the instructions it changes.
    expect(conditionsFor('69')['decimal']).toBeGreaterThan(0)
    expect(conditionsFor('e9')['decimal']).toBeGreaterThan(0)
    // The stack pointer at both ends, on the instructions that move it.
    expect(conditionsFor('48')['stack-empty']).toBeGreaterThan(0)
    expect(conditionsFor('68')['stack-full']).toBeGreaterThan(0)
    // A branch whose target is on another page.
    expect(conditionsFor('d0')['branch-page-cross']).toBeGreaterThan(0)
  })
})
