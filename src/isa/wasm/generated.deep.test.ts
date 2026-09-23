/**
 * The generated tier, at a scale the ordinary suite should not pay for.
 *
 * `npm test` runs ten seeds against four argument sets, which takes
 * milliseconds and catches what is reliably catchable. This runs two
 * hundred, and the reason it can is the thing that makes this target
 * unusual: the reference is `WebAssembly` in this very process, so a
 * module costs a compile and a call rather than a container.
 *
 * This is where a bug that only one shape of program reaches would
 * surface. The four found so far were all in floating point and all
 * about a single bit -- an inverted signed zero, two NaNs that came from
 * the wrong place, and a sign read as an ordering -- and three of them
 * were found by exactly this kind of sweep rather than by the systematic
 * probe, because the probe only knows the edge cases someone thought to
 * list.
 */
import { describe, expect, it } from 'vitest'
import { differences, runInEngine, runInInterpreter } from './differential.node.ts'
import { generateModule } from './generate.node.ts'

/** Two hundred, spaced by a prime so the low bits vary as well. */
const SEEDS = Array.from({ length: 200 }, (_, i) => 0x1000 + i * 7919)

/**
 * Argument sets. The extremes matter more than the middle here: every
 * value reaches the floating-point operations through a conversion, and
 * the interesting behaviour is at the ends of the ranges.
 */
const ARGUMENTS: readonly (readonly bigint[])[] = [
  [0n, 0n, 0n, 0n],
  [1n, 1n, 0x3f80_0000n, 0x3ff0_0000_0000_0000n],
  [0x7fff_ffffn, 0x7fff_ffff_ffff_ffffn, 0x7f7f_ffffn, 0x7fef_ffff_ffff_ffffn],
  [0x8000_0000n, 0x8000_0000_0000_0000n, 0xff80_0000n, 0xfff0_0000_0000_0000n],
  // A NaN of each sign, arriving as an argument rather than a constant.
  [0xffff_ffffn, 0xffff_ffff_ffff_ffffn, 0x7fc0_1234n, 0xfff8_0000_0000_1234n],
  [3n, 0x0123_4567_89ab_cdefn, 0x4049_0fdbn, 0x4009_21fb_5444_2d18n],
]

describe('WebAssembly: two hundred generated modules against the host engine', () => {
  it('agrees on every result and every byte of memory', () => {
    const problems: string[] = []
    let compared = 0

    for (const seed of SEEDS) {
      const generated = generateModule(seed, {
        allowGrow: seed % 3 === 0,
        statements: 40 + (seed % 60),
      })
      try {
        new WebAssembly.Module(new Uint8Array(generated.bytes))
      } catch (error) {
        problems.push(`seed ${seed}: the engine rejected the module: ` +
          (error as Error).message.slice(0, 120))
        continue
      }

      for (const args of ARGUMENTS) {
        const options = { entry: generated.entry, args }
        const found = differences(
          runInEngine(generated.bytes, options),
          runInInterpreter(generated.bytes, options),
        )
        compared += 1
        if (found.length > 0) {
          problems.push(`seed ${seed} args [${args.join(', ')}]: ${found.join('; ')}`)
        }
      }
    }

    // A pass that compared nothing would look like a pass that compared
    // everything.
    expect(compared).toBe(SEEDS.length * ARGUMENTS.length)
    expect(problems.slice(0, 10).join('\n')).toBe('')
  })

  it('reaches every operation across the sweep', () => {
    const reached = new Set<number>()
    for (const seed of SEEDS) {
      for (const op of generateModule(seed, { allowGrow: true }).opcodes) reached.add(op)
    }
    // Two hundred modules is enough that the generator's random choices
    // stop being a source of missing coverage; if this falls, a shape
    // has stopped being generated rather than a seed being unlucky.
    expect(reached.size).toBeGreaterThan(170)
  })
})
