/**
 * What this backend is verified against.
 *
 * Four tiers, and the shape of them is unusual enough to be worth
 * setting out, because two of the mechanisms every other target here
 * relies on do not exist for this one.
 *
 * **There is no lockstep tier.** Lockstep compares register state before
 * every instruction against a reference that will single-step and report
 * it. No WebAssembly engine will: V8 and wasmtime both compile modules
 * to machine code, and neither exposes an operand stack that, at that
 * point, has largely stopped existing. This is the same absence the 6502
 * has, and it is answered the same way -- with a tier that is *stronger*
 * per instruction rather than a weaker version of the one that is
 * missing.
 *
 * **There is no guest state dump.** Every other target compiles a
 * harness that writes its registers to memory so the final state can be
 * compared byte for byte. Here the engine hands over the module's entire
 * linear memory, so the comparison covers all of it -- which is more
 * than any harness would have thought to write down.
 *
 * What there is instead:
 *
 *   decode       against LLVM's disassembler, on compiled modules
 *   per opcode   every operation against every edge value, in the engine
 *   generated    whole random modules, results and all of memory
 *   traps        that the same programs stop, for the same reason
 *   programs     the app's corpus against a different engine entirely
 *
 * The middle three run against `WebAssembly` in this very process, which
 * is the one genuine advantage this target has over the others: its
 * oracle needs no container, no network and no recording, so the
 * comparison happens live on modules generated at the moment the test
 * runs. Nothing can go stale between capturing and checking, because
 * nothing is captured.
 *
 * The last one is recorded, because its oracle is wasmtime -- a
 * different engine, from a different vendor, with a different compiler.
 * Agreeing with both says more than agreeing with either.
 */
import { describe, expect, it } from 'vitest'
import { describeDecodeTier } from '../conformance.node.ts'
import { IMPLEMENTED_OPCODES, nameOf } from './decode.ts'
import { wasmDecodeCheck } from './decodeCheck.node.ts'
import { differences, runInEngine, runInInterpreter, trapCategory } from './differential.node.ts'
import {
  WASM_FIXTURE_DIR,
  freestandingNames,
  readWasmIndex,
  readWasmModule,
  readWasmStdout,
} from './fixtures.node.ts'
import {
  generateModule,
  generateOpcodeProbe,
  generateTrapCases,
  Type,
} from './generate.node.ts'
import { WasmImage } from './image.ts'
import { parseModule } from './module.ts'

const NAMES = freestandingNames()

describeDecodeTier('WebAssembly', WASM_FIXTURE_DIR, NAMES, wasmDecodeCheck)

/**
 * Seeds, written down so a failure is reproducible by name.
 *
 * Randomised without being irreproducible: the generator is a xorshift
 * with no other source of entropy, so a seed names one module exactly
 * and forever.
 */
const SEEDS = [
  0x1000, 0x2f0f, 0x4e1e, 0x6d2d, 0x8c3c, 0xab4b,
  0xca5a, 0xe969, 0x10878, 0x12787,
]

/** Argument sets: zero, both extremes, and an ordinary value. */
const ARGUMENTS: readonly (readonly bigint[])[] = [
  [0n, 0n, 0n, 0n],
  [0x7fff_ffffn, 0x7fff_ffff_ffff_ffffn, 0x7f7f_ffffn, 0x7fef_ffff_ffff_ffffn],
  [0x8000_0000n, 0x8000_0000_0000_0000n, 0xff80_0000n, 0xfff0_0000_0000_0000n],
  [3n, 0x0123_4567_89ab_cdefn, 0x4049_0fdbn, 0x4009_21fb_5444_2d18n],
]

describe('WebAssembly: every operation against the host engine', () => {
  /**
   * One module applying every implemented operation to every pair of
   * edge values, with each result at its own address.
   *
   * Built once: it is a hundred and thirty kilobytes of code and some
   * thousands of results, and the point of putting them all in one
   * module is that a single differing byte names the operation and both
   * its operands rather than starting a bisection.
   */
  const probe = generateOpcodeProbe()

  it('produces a module the engine accepts', () => {
    // A generator that emitted something invalid would fail every
    // comparison below for a reason that has nothing to do with the
    // interpreter, so this separates the two.
    expect(() => new WebAssembly.Module(new Uint8Array(probe.bytes))).not.toThrow()
    expect(probe.layout.length).toBeGreaterThan(5000)
  })

  it('agrees on every result', () => {
    const reference = runInEngine(probe.bytes, { entry: 'probe' })
    const actual = runInInterpreter(probe.bytes, { entry: 'probe' })
    expect(reference.trap).toBe('')

    // Reported per operation rather than per byte: the question a
    // failure has to answer is "which opcode", and a list of addresses
    // does not answer it.
    const wrong = new Map<number, { count: number; example: string }>()
    for (const entry of probe.layout) {
      let differs = false
      for (let i = 0; i < entry.width; i++) {
        if (reference.memory[entry.address + i] !== actual.memory[entry.address + i]) {
          differs = true
          break
        }
      }
      if (!differs) continue
      const seen = wrong.get(entry.op) ?? { count: 0, example: '' }
      seen.count += 1
      if (!seen.example) {
        const read = (memory: Uint8Array): string => {
          let value = 0n
          for (let i = entry.width - 1; i >= 0; i--) {
            value = (value << 8n) | BigInt(memory[entry.address + i] ?? 0)
          }
          return `0x${value.toString(16).padStart(entry.width * 2, '0')}`
        }
        seen.example = `(${entry.operands.map((o) => `0x${o.toString(16)}`).join(', ')}) ` +
          `reference ${read(reference.memory)}, ours ${read(actual.memory)}`
      }
      wrong.set(entry.op, seen)
    }

    const report = [...wrong]
      .sort((a, b) => a[0] - b[0])
      .map(([op, seen]) => `${nameOf(op)}: ${seen.count} wrong, e.g. ${seen.example}`)
    expect(report.join('\n')).toBe('')
  })

  it('covers every opcode this backend claims, between the two sources', () => {
    // The generated modules reach the operations a compiler never emits;
    // the compiled ones reach the handful that only a compiler arranges,
    // `local.tee` among them. Neither set alone is enough, and asserting
    // the union is what stops an opcode being implemented and never run.
    const reached = new Set<number>(probe.opcodes)
    for (const seed of SEEDS) {
      for (const op of generateModule(seed, { allowGrow: true }).opcodes) reached.add(op)
    }
    // The trap cases too: `unreachable` exists to stop a program, so the
    // only place it can be covered is among the programs meant to stop.
    for (const testCase of generateTrapCases()) {
      const module = parseModule(testCase.bytes)
      const image = new WasmImage(module, BigInt(module.bodies[0]!.start))
      for (const si of image.instructionsOf(module.bodies[0]!)) reached.add(si.inst.op)
    }
    for (const name of NAMES) {
      const module = parseModule(readWasmModule(name))
      const image = new WasmImage(module, BigInt(module.bodies[0]!.start))
      for (const body of module.bodies) {
        for (const si of image.instructionsOf(body)) reached.add(si.inst.op)
      }
    }

    const missing = IMPLEMENTED_OPCODES.filter((op) => !reached.has(op)).map(nameOf)
    // `table.get` and `table.set` are decoded so that a disassembly is
    // right about them, and have no semantics: nothing a C toolchain
    // emits uses the reference types, so implementing them would mean
    // shipping something no test here could execute. They are refused at
    // run time, which faults.test.ts checks.
    expect(missing).toEqual(['table.get', 'table.set'])
  })
})

describe('WebAssembly: whole generated modules against the host engine', () => {
  for (const seed of SEEDS) {
    it(`matches on results and all of memory: seed ${seed}`, () => {
      const generated = generateModule(seed, { allowGrow: seed % 3 === 0 })
      expect(() => new WebAssembly.Module(new Uint8Array(generated.bytes))).not.toThrow()

      for (const args of ARGUMENTS) {
        const options = { entry: generated.entry, args }
        const reference = runInEngine(generated.bytes, options)
        const actual = runInInterpreter(generated.bytes, options)
        const problems = differences(reference, actual)
        expect(`seed ${seed} args [${args.join(', ')}]: ${problems.join('; ')}`)
          .toBe(`seed ${seed} args [${args.join(', ')}]: `)
      }
    })
  }

  it('generates modules that actually compute something', () => {
    // A generator that emitted an empty body would make every comparison
    // above pass. The results must differ between argument sets.
    const generated = generateModule(SEEDS[0]!)
    const outcomes = ARGUMENTS.map((args) =>
      runInInterpreter(generated.bytes, { entry: generated.entry, args }).results[0])
    expect(new Set(outcomes).size).toBeGreaterThan(1)
    expect(generated.params).toEqual([Type.I32, Type.I64, Type.F32, Type.F64])
  })
})

describe('WebAssembly: the programs that are meant to stop', () => {
  for (const testCase of generateTrapCases()) {
    it(`stops for the same reason as the engine: ${testCase.name}`, () => {
      const reference = runInEngine(testCase.bytes, { entry: 'probe' })
      const actual = runInInterpreter(testCase.bytes, { entry: 'probe' })

      // The engine is checked against the expectation too. If V8 stopped
      // trapping on one of these, the case would silently become a test
      // that both sides run to completion.
      expect(`${testCase.name}: ${reference.trap} (${reference.detail})`)
        .toBe(`${testCase.name}: ${testCase.expect} (${reference.detail})`)
      expect(`${testCase.name}: ${actual.trap} (${actual.detail})`)
        .toBe(`${testCase.name}: ${testCase.expect} (${actual.detail})`)
    })
  }

  it('puts both engines\' wording in the same category', () => {
    expect(trapCategory('memory access out of bounds')).toBe('out-of-bounds')
    expect(trapCategory('wasm: trap at offset 0x1: out of bounds memory access: 4 byte(s)'))
      .toBe('out-of-bounds')
    expect(trapCategory('float unrepresentable in integer range')).toBe('bad-conversion')
    expect(trapCategory('wasm: trap at offset 0x1: invalid conversion to integer'))
      .toBe('bad-conversion')
    // And a category it should not invent one for.
    expect(trapCategory('something nobody has seen before')).toBe('other')
  })
})

describe('WebAssembly: the app\'s own programs, against wasmtime', () => {
  const index = readWasmIndex()

  it('has a recording to compare against', () => {
    expect(index.libcFixtures.length).toBeGreaterThan(0)
    // Every corpus program built. The 6502 cannot say this -- one of them
    // does not fit a 16-bit `int` -- so the empty list is worth asserting
    // rather than assuming.
    expect(index.unbuilt).toEqual([])
  })

  for (const fixture of index.libcFixtures) {
    it(`prints what wasmtime printed: ${fixture.name}`, () => {
      const result = runInInterpreter(readWasmModule(fixture.name), {
        instructionBudget: 2_000_000_000,
      })
      expect(`${fixture.name}: ${result.trap}${result.detail}`).toBe(`${fixture.name}: `)

      const expected = readWasmStdout(fixture.name)
      const printed = Buffer.from(result.stdout)
      if (!printed.equals(Buffer.from(expected))) {
        let at = 0
        while (at < printed.length && printed[at] === expected[at]) at += 1
        expect(`byte ${at}: ${JSON.stringify(printed.subarray(at, at + 32).toString())}`)
          .toBe(`byte ${at}: ${JSON.stringify(
            Buffer.from(expected).subarray(at, at + 32).toString())}`)
      }
      expect(printed.length).toBe(expected.length)

      // The return value goes to stderr, because a process exit status
      // carries eight bits and several of these return more.
      expect(Buffer.from(result.stderr).toString()).toBe(fixture.stderr ?? '')
      expect(result.exitCode).toBe(fixture.exitCode)
    })
  }

  it('runs each program far enough to be doing the work', () => {
    // A program that exited after twenty instructions and printed
    // nothing would pass the comparison above if the recording were also
    // empty. This is the counterfactual.
    const result = runInInterpreter(readWasmModule('corpus-queens'), {
      instructionBudget: 2_000_000_000,
    })
    expect(result.retired).toBeGreaterThan(100_000)
    expect(result.stdout.length).toBeGreaterThan(0)
  })
})
