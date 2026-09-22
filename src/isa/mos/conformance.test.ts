/**
 * MOS 6502 conformance: the decode tier, and whole programs against the
 * simulator.
 *
 * This target inherits the decode tier and nothing else, which is a
 * deliberate and visible gap rather than an oversight. `mos-sim` has no
 * tracing interface, so there is no way to step it alongside this
 * interpreter and compare registers before every instruction, and there
 * is no guest state dump because there is no reference to compare one
 * against. What replaces lockstep is in vectors.test.ts: per-opcode cases
 * recorded from hardware, which for one instruction at a time say more
 * than lockstep does.
 *
 * So the claim this target makes is:
 *
 *   decode         every instruction in 16 programs agrees with LLVM
 *   per-opcode     every documented opcode, from arbitrary machine state
 *   whole program  stdout and exit status match the simulator exactly
 *
 * and *not* that its intermediate state was ever compared against a
 * reference. The middle tier is what makes that acceptable: a wrong
 * instruction would have to be wrong in a way 23,502 hardware-recorded
 * cases did not notice and that still produced the right output.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeDecodeTier } from '../conformance.node.ts'
import { createRetireChunk, RunState } from '../common/trace.ts'
import { MosBus } from './bus.ts'
import { mosDecodeCheck } from './decodeCheck.node.ts'
import { MosInterpreter } from './exec.ts'
import { parseVectors, readVectorBytes, vectorByte } from './fixtures.node.ts'
import { MosImage } from './image.ts'
import { loadMos } from './load.ts'

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

interface CorpusIndex {
  flags: string
  ran: { name: string; exit: number; imageBytes: number; stdoutBytes: number }[]
  skipped: { name: string; built: boolean; reason?: string }[]
}

const INDEX = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, 'corpus.json'), 'utf8'),
) as CorpusIndex

const NAMES = INDEX.ran.map((entry) => entry.name)

describeDecodeTier('MOS 6502', FIXTURE_DIR, NAMES, mosDecodeCheck)

/** Runs a fixture to completion, returning what the guest produced. */
function execute(name: string): {
  stdout: Uint8Array
  stderr: Uint8Array
  exit: number
  retired: number
} {
  const image = new Uint8Array(readFileSync(resolve(FIXTURE_DIR, `${name}.bin`)))
  const { interpreter } = loadMos(image, { instructionBudget: 400_000_000 })
  const chunk = createRetireChunk(4096)
  let state: RunState = RunState.MORE
  while (state === RunState.MORE) state = interpreter.run(chunk)
  return {
    stdout: interpreter.stdout(),
    stderr: interpreter.stderr(),
    exit: interpreter.exitCode,
    retired: interpreter.retired,
  }
}

const TEXT = new TextDecoder()

describe('MOS 6502: whole programs against mos-sim', () => {
  it('has programs to run', () => {
    expect(NAMES.length).toBeGreaterThan(10)
  })

  for (const entry of INDEX.ran) {
    it(`matches the simulator: ${entry.name}`, () => {
      const result = execute(entry.name)
      const expected = new Uint8Array(
        readFileSync(resolve(FIXTURE_DIR, `${entry.name}.stdout`)),
      )
      // Compared as text so a difference reads as a difference rather
      // than as two arrays of byte values.
      expect(TEXT.decode(result.stdout)).toBe(TEXT.decode(expected))
      expect(result.exit).toBe(entry.exit)
      expect(result.retired).toBeGreaterThan(0)
    })
  }

  it('reaches the end of every program rather than running out of budget', () => {
    // A program that exceeded its budget would throw, so this is about the
    // opposite failure: one that stops early and still matches, because
    // its output happened to be complete before it went wrong.
    for (const entry of INDEX.ran) {
      const result = execute(entry.name)
      expect(result.exit, entry.name).toBe(entry.exit)
      expect(result.stdout.length, entry.name).toBe(entry.stdoutBytes)
    }
  })
})

describe('MOS 6502: what this target cannot run', () => {
  it('records why, rather than leaving the program out', () => {
    // A corpus program missing from the fixtures should be a fact with a
    // reason attached. The one that is missing is missing because of the
    // architecture: this machine has a 16-bit `int`, so a program that
    // asserts its struct is eight bytes is correct to refuse to build.
    for (const entry of INDEX.skipped) {
      expect(entry.reason, entry.name).toBeTruthy()
    }
    const struct = INDEX.skipped.find((entry) => entry.name === 'corpus-struct')
    expect(struct?.built).toBe(false)
    expect(struct?.reason).toMatch(/sizeof\(struct Point\) == 8/)
  })
})

describe('MOS 6502: where the whole-program oracle cannot be followed', () => {
  /**
   * `mos-sim` gets decimal mode wrong, and this is the test that says so.
   *
   * It exists because the failure it guards against is a plausible one.
   * Someone -- including a later version of me -- sees the decimal probe
   * disagreeing with the simulator, concludes the interpreter is broken,
   * and "fixes" it to match. The result would pass the whole-program
   * tier and break 23,502 hardware-recorded cases, and the direction of
   * that trade is the whole argument of this project.
   *
   * Two specific things the simulator does differently, both measured
   * against the committed vectors rather than asserted from reading:
   *
   *   - N and V are taken from the plain binary sum. On an NMOS 6502
   *     they come from the partly corrected value, which differs
   *     whenever the low-nibble correction carries into the high one.
   *   - operands with a nibble above nine produce the wrong accumulator,
   *     because the correction is applied as though the input were valid
   *     BCD.
   *
   * The assertions below are on *hardware*: they establish that this
   * backend's decimal mode is not the simplified one, and by how much.
   */
  const ADC_IMMEDIATE = 0x69
  const decimal = (parseVectors(readVectorBytes()).get(ADC_IMMEDIATE) ?? [])
    .filter((entry) => (entry.initial.p & 0x08) !== 0)

  it('has decimal cases recorded from hardware to reason about', () => {
    expect(decimal.length).toBeGreaterThan(40)
  })

  it('does not take the decimal flags from the binary sum', () => {
    // How often the simplification the simulator uses would be wrong.
    // Asserting that this is non-zero is asserting that the two rules are
    // distinguishable at all; asserting the backend matches hardware on
    // every one of them is the next test.
    let distinguishable = 0
    for (const { initial, final } of decimal) {
      const m = vectorByte(initial, (initial.pc + 1) & 0xffff)
      const carry = initial.p & 0x01
      const binary = (initial.a + m + carry) & 0xff
      const binaryN = binary & 0x80
      const binaryV = (initial.a ^ binary) & (m ^ binary) & 0x80
      if ((final.p & 0x80) !== binaryN || ((final.p & 0x40) !== 0) !== (binaryV !== 0)) {
        distinguishable += 1
      }
    }
    expect(distinguishable).toBeGreaterThan(0)
  })

  it('matches hardware on every decimal case, valid digits or not', () => {
    const bus = new MosBus()
    let invalidDigits = 0
    const wrong: string[] = []

    for (const { initial, final } of decimal) {
      const m = vectorByte(initial, (initial.pc + 1) & 0xffff)
      if ((initial.a & 0x0f) > 9 || (initial.a >> 4) > 9 ||
          (m & 0x0f) > 9 || (m >> 4) > 9) invalidDigits += 1

      bus.ram.fill(0)
      for (const [address, value] of initial.ram) bus.ram[address] = value
      const cpu = new MosInterpreter(
        new MosImage(bus, BigInt(initial.pc), 0), bus, { entry: initial.pc },
      )
      cpu.a = initial.a
      cpu.x = initial.x
      cpu.y = initial.y
      cpu.s = initial.s
      cpu.p = initial.p
      cpu.step()

      if (cpu.a !== final.a || cpu.p !== final.p) {
        wrong.push(
          `${initial.a.toString(16)}+${m.toString(16)}+${initial.p & 1}: ` +
          `a=${cpu.a.toString(16)} p=${cpu.p.toString(16)} ` +
          `want a=${final.a.toString(16)} p=${final.p.toString(16)}`,
        )
      }
    }

    expect(wrong.slice(0, 8).join('\n')).toBe('')
    // The inputs the simulator gets wrong are the ones with a nibble
    // above nine, so this asserts they are actually present here.
    expect(invalidDigits).toBeGreaterThan(0)
  })
})
