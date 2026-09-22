/**
 * The differential suite every real-ISA backend must pass.
 *
 * An interface is not frozen by being written down; it is frozen by having
 * something that can tell you whether an implementation satisfies it. A new
 * backend registers here and inherits the whole comparison — lockstep against
 * the reference's per-instruction register dump, and final architectural
 * state byte for byte against the guest's own — rather than growing its own
 * version that checks slightly different things.
 *
 * Two tiers live here because they are genuinely ISA-independent. Decoding is
 * not: what counts as the right canonical operation for a given encoding is a
 * per-architecture question, so each backend keeps its own decode test.
 */
import { describe, expect, it } from 'vitest'
import { hex64 } from './common/bits64.ts'
import {
  fixtureNames,
  initialState,
  readDumpBytes,
  readElf,
  readIndex,
  readLockstep,
  readStdout,
} from './common/fixtures.node.ts'
import { RunState, createRetireChunk } from './common/trace.ts'
import type { IsaBackend } from './backend.ts'

export interface ConformanceOptions {
  backend: IsaBackend
  fixtureDir: string
  /**
   * Optional names for the 64-bit fields of the architectural state dump, so
   * a mismatch reads as `f12` rather than as byte offset 352.
   */
  labelDump?: (bytes: Uint8Array) => Map<number, string>
}

function seed(options: ConformanceOptions, name: string) {
  const { backend, fixtureDir } = options
  const start = initialState(fixtureDir, name, backend.gprCount)
  const initialRegisters = start.x.map((value) => BigInt.asIntN(64, value))
  return {
    start,
    loaded: backend.load(readElf(fixtureDir, name), { initialRegisters }),
  }
}

/** Registers the shared suite for one backend. Call from a *.test.ts file. */
export function describeIsaConformance(options: ConformanceOptions): void {
  const { backend, fixtureDir } = options
  const index = readIndex(fixtureDir)
  const names = fixtureNames(fixtureDir)

  describe(`${backend.name}: lockstep against the reference`, () => {
    it('has fixtures to compare against', () => {
      expect(names.length).toBeGreaterThan(0)
    })

    for (const name of names) {
      it(`matches the reference at every step: ${name}`, () => {
        const { start, loaded } = seed(options, name)
        const { interpreter, image } = loaded
        expect(interpreter.image.entry).toBe(start.pc)

        const chunk = createRetireChunk(1)
        let steps = 0
        let state: RunState = RunState.MORE
        // A divergence is almost never caused by the instruction it is
        // noticed at: a register is wrong because something earlier wrote it
        // wrongly. Keeping the recent history turns "these two numbers
        // differ" into a short list containing the culprit.
        const recent: string[] = []
        const remember = (pc: bigint): void => {
          recent.push(`    0x${pc.toString(16)}  ${image.at(pc).mnemonic}`)
          if (recent.length > 12) recent.shift()
        }
        const history = (): string =>
          ['', '  last executed:', ...recent].join('\n')

        for (const expected of readLockstep(fixtureDir, name, backend.gprCount)) {
          const pc = expected.pc
          const actualPc = interpreter.programCounter
          if (actualPc !== pc) {
            expect.fail(
              `step ${steps}: pc is 0x${actualPc.toString(16)}, reference says ` +
              `0x${pc.toString(16)}${history()}`,
            )
          }
          for (let r = 0; r < backend.gprCount; r++) {
            const mine = BigInt.asUintN(64, interpreter.gpr(r))
            if (mine !== expected.x[r]) {
              expect.fail(
                `step ${steps} at 0x${pc.toString(16)} (${image.at(pc).mnemonic}): ` +
                `${backend.naming.name(r)} is ${hex64(mine)}, reference says ` +
                `${hex64(expected.x[r]!)}${history()}`,
              )
            }
          }
          remember(pc)
          state = interpreter.run(chunk)
          steps += 1
        }

        expect(steps).toBe(index.fixtures.find((f) => f.name === name)?.steps)
        expect(state).toBe(RunState.EXITED)
        expect(interpreter.exitCode).toBe(0)
      })
    }
  })

  describe(`${backend.name}: final architectural state`, () => {
    for (const name of names) {
      it(`reproduces every byte of the reference dump: ${name}`, () => {
        const { loaded } = seed(options, name)
        const { interpreter } = loaded
        const chunk = createRetireChunk(4096)
        let state: RunState = RunState.MORE
        while (state === RunState.MORE) state = interpreter.run(chunk)
        expect(interpreter.exitCode).toBe(0)

        const reference = readDumpBytes(fixtureDir, name)
        const produced = interpreter.stdout()
        expect(`${name}: ${produced.length} bytes`)
          .toBe(`${name}: ${backend.dumpBytes} bytes`)
        expect(reference.length).toBe(backend.dumpBytes)

        const labels = options.labelDump?.(reference)
        const mine = new DataView(produced.buffer, produced.byteOffset)
        const theirs = new DataView(reference.buffer, reference.byteOffset)
        for (let at = 0; at + 8 <= reference.length; at += 8) {
          const a = mine.getBigUint64(at, backend.littleEndian)
          const b = theirs.getBigUint64(at, backend.littleEndian)
          if (a !== b) {
            const where = labels?.get(at) ?? `offset ${at}`
            expect.fail(`${where}: produced ${hex64(a)}, reference ${hex64(b)}`)
          }
        }
      })
    }

    it('is comparing something: the dumps are not all zero', () => {
      const anyDump = readDumpBytes(fixtureDir, names[0]!)
      expect(anyDump.some((byte) => byte !== 0)).toBe(true)
    })
  })

  const libc = index.libcFixtures ?? []
  if (libc.length > 0) {
    describe(`${backend.name}: whole programs against a real libc`, () => {
      for (const fixture of libc) {
        it(`prints what the reference printed: ${fixture.name}`, () => {
          // No seeded registers: this is a real program start, so the loader
          // builds the argc/argv/envp/auxv block a libc reads at startup.
          const { interpreter } = backend.load(readElf(fixtureDir, fixture.name), {
            instructionBudget: 50_000_000,
          })
          const chunk = createRetireChunk(8192)
          let state: RunState = RunState.MORE
          while (state === RunState.MORE) state = interpreter.run(chunk)

          const decoder = new TextDecoder()
          expect(decoder.decode(interpreter.stdout()))
            .toBe(decoder.decode(readStdout(fixtureDir, fixture.name)))
          expect(interpreter.exitCode).toBe(fixture.exitCode)
          if (fixture.stderr !== undefined) {
            expect(decoder.decode(interpreter.stderr())).toBe(fixture.stderr)
          }
        })
      }
    })
  }
}
