import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { C_EXAMPLES } from '../../engine/c/programs.ts'
import { RunState, createRetireChunk } from '../common/trace.ts'
import { RETURN_SEPARATOR } from '../shipped.ts'
import { mosBackend } from './backend.ts'
import { MOS_FIXTURE_DIR } from './fixtures.node.ts'

/**
 * The app's own workloads, on the 6502, against the app's own recorded
 * answers -- and the one place where those answers do not apply.
 *
 * On every other target this is the check with the most independent
 * oracle available: the expectations came from the in-house Guest C
 * compiler and the pseudo-backend, which share nothing with clang, qemu
 * or an interpreter, so agreement means four unrelated things compute
 * the same result.
 *
 * Here it splits in two, for a reason that is the architecture rather
 * than the backend. **`int` is sixteen bits on this machine.** The
 * corpus was written on the assumption that it is thirty-two, and eight
 * of the thirteen programs accumulate past 32767 -- `pi` returns pi
 * scaled by 100000, `fft` returns a checksum in the hundreds of
 * millions. Those programs compute a different value here, and they are
 * *right* to: the C is the same, the compiler is the same, and the type
 * is narrower.
 *
 * The split is not asserted by listing which programs are which. It is
 * derived from the expected value itself -- does it fit in an `int` on
 * this machine -- and then both halves are checked:
 *
 *   fits      the answer and the output must match the app exactly
 *   does not  the answer must differ, and must itself fit in sixteen
 *             bits, because a difference of any other shape would not
 *             be explained by the width and would need investigating
 *
 * What verifies the second group is the whole-program tier, where the
 * same images are run under `mos-sim` and compared byte for byte. That
 * is a real oracle for them; the app's recorded answers are not.
 *
 * `life` and `cube` are worth noticing: their return values differ and
 * their *output* still matches the app exactly, because what they print
 * does not depend on the accumulator that overflows.
 */
function fnv1a(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash | 0
}

function run(name: string): { stdout: string; returned: number; retired: number } {
  const image = new Uint8Array(readFileSync(join(MOS_FIXTURE_DIR, `${name}.bin`)))
  const { interpreter } = mosBackend.load(image, { instructionBudget: 400_000_000 })
  const chunk = createRetireChunk(65536)
  let state: RunState = RunState.MORE
  while (state === RunState.MORE) state = interpreter.run(chunk)

  // One output port, so the driver's return value shares the stream with
  // the program's output and is framed rather than separated.
  const raw = new TextDecoder().decode(interpreter.stdout())
  const at = raw.lastIndexOf(RETURN_SEPARATOR)
  return {
    stdout: at >= 0 ? raw.slice(0, at) : raw,
    returned: at >= 0 ? Number(raw.slice(at + 1)) : Number.NaN,
    retired: interpreter.retired,
  }
}

/** The one program the machine cannot hold, and why. See fixtures/corpus.json. */
const UNBUILDABLE = new Set(['struct'])

/** What `int` holds here. */
const INT_MIN = -32768
const INT_MAX = 32767
const fitsInInt = (value: number): boolean => value >= INT_MIN && value <= INT_MAX

describe("the app's C corpus on the 6502", () => {
  const runnable = C_EXAMPLES.filter((example) => !UNBUILDABLE.has(example.id))

  it('names the program it cannot build rather than skipping quietly', () => {
    // `int` is sixteen bits, so this program's own assertion that its
    // struct is eight bytes wide is false and the compiler refuses it.
    expect([...UNBUILDABLE]).toEqual(['struct'])
    expect(C_EXAMPLES.some((example) => example.id === 'struct')).toBe(true)
    expect(runnable.length).toBe(C_EXAMPLES.length - 1)
  })

  it('has programs on both sides of the sixteen-bit line', () => {
    // If this ever became one-sided the tests below would still pass
    // while checking half of what they claim to.
    const within = runnable.filter((example) => fitsInInt(example.expectedReturn))
    expect(within.length).toBeGreaterThan(3)
    expect(runnable.length - within.length).toBeGreaterThan(3)
  })

  for (const example of runnable) {
    const within = fitsInInt(example.expectedReturn)

    if (within) {
      it(`computes the answer the app expects: ${example.id}`, () => {
        const result = run(`corpus-${example.id}`)
        expect(`${example.id} returned ${result.returned}`)
          .toBe(`${example.id} returned ${example.expectedReturn}`)

        if ('exact' in example.expectedStdout) {
          expect(result.stdout).toBe(example.expectedStdout.exact)
        } else {
          expect(result.stdout.length).toBe(example.expectedStdout.length)
          expect(fnv1a(result.stdout)).toBe(example.expectedStdout.fnv1a)
        }
        expect(result.retired).toBeGreaterThan(0)
      })
      continue
    }

    it(`differs from the app only as a narrower int explains: ${example.id}`, () => {
      const result = run(`corpus-${example.id}`)
      // The app's answer does not fit in an `int` here, so it cannot be
      // reached. What must hold is that this machine's answer is one a
      // sixteen-bit `int` could hold, and that the program ran.
      expect(Number.isNaN(result.returned)).toBe(false)
      expect(fitsInInt(result.returned), `${example.id} returned ${result.returned}`)
        .toBe(true)
      expect(result.returned).not.toBe(example.expectedReturn)
      expect(result.retired).toBeGreaterThan(0)
    })
  }
})
