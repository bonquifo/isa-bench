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
 * Four tiers live here. Three are entirely ISA-independent. The fourth,
 * the decoder check, needs a little from each backend -- what it calls an
 * operation, and which of the disassembler's pseudo-instruction names may
 * stand for which real one -- but the machinery around that is shared, and
 * having it shared is what lets a decoder be checked against LLVM's own
 * tables before any semantics exist to check it through.
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
  readObjdump,
  readStdout,
} from './common/fixtures.node.ts'
import { parseObjdump } from './common/objdump.node.ts'
import { RunState, createRetireChunk } from './common/trace.ts'
import type { IsaBackend } from './backend.ts'

/**
 * What a backend supplies for its decoder to be checked against the
 * disassembler that produced the fixtures.
 *
 * The question this tier asks is narrow and worth stating: do the decoder
 * and LLVM agree about which instruction a sequence of bytes *is*, and how
 * long it is. Nothing about what it does. That is weaker than what the
 * lockstep tier answers, and worth asking separately because it can be
 * answered before a line of semantics exists -- which is the difference
 * between finding a wrong encoding table immediately and finding it
 * through a wrong answer much later.
 */
export interface DecodeCheck {
  /**
   * Decodes the bytes at an address the way the program image would,
   * reporting the operation and how many bytes it consumed.
   */
  decode(bytes: Uint8Array, address: bigint): { op: number; length: number }
  /** What this backend calls an operation, in the disassembler's spelling. */
  name(op: number): string
  /**
   * What each of the disassembler's pseudo-instruction names is allowed
   * to decode to.
   *
   * Membership rather than equality, because which real instruction an
   * alias stands for usually depends on its operands: `mv` is an add on
   * one target and an or on another, and `li` is whichever of two or
   * three instructions could produce the constant.
   */
  aliases?: Readonly<Record<string, readonly number[]>>
  /**
   * Mnemonics the decoder must *refuse*. A disassembler prints something
   * for words that are not instructions, and agreeing with it there would
   * be the wrong kind of agreement.
   */
  refused?: readonly string[]
  /** Mnemonics to pass over: directives rather than instructions. */
  ignored?: readonly string[]
}

export interface ConformanceOptions {
  backend: IsaBackend
  fixtureDir: string
  /**
   * Optional names for the 64-bit fields of the architectural state dump, so
   * a mismatch reads as `f12` rather than as byte offset 352.
   */
  labelDump?: (bytes: Uint8Array) => Map<number, string>
  /**
   * Optional decoder check against the disassembly captured beside each
   * fixture. Every target captures that disassembly already; one that does
   * not supply this simply does not use it.
   */
  decodeCheck?: DecodeCheck
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
/** Bits set, for bounding what a backend excludes from comparison. */
function popcount(value: bigint): number {
  let n = 0
  for (let v = value; v !== 0n; v >>= 1n) if ((v & 1n) === 1n) n += 1
  return n
}

export function describeIsaConformance(options: ConformanceOptions): void {
  const { backend, fixtureDir } = options
  const index = readIndex(fixtureDir)
  const names = fixtureNames(fixtureDir)

  const check = options.decodeCheck
  if (check) {
    describe(`${backend.name}: decoder against the disassembler`, () => {
      const ignored = new Set(check.ignored ?? [])
      const refused = new Set(check.refused ?? [])

      it('has disassembly to check against', () => {
        expect(names.length).toBeGreaterThan(0)
        expect(parseObjdump(readObjdump(fixtureDir, names[0]!)).length).toBeGreaterThan(0)
      })

      for (const name of names) {
        it(`agrees on every instruction in ${name}`, () => {
          const lines = parseObjdump(readObjdump(fixtureDir, name))
          expect(lines.length).toBeGreaterThan(0)
          const problems: string[] = []
          let checked = 0
          for (const line of lines) {
            if (ignored.has(line.mnemonic)) continue
            const where = `0x${line.address.toString(16)} ${line.text}`
            if (refused.has(line.mnemonic)) {
              try {
                check.decode(line.bytes, line.address)
                problems.push(`${where}: decoded, but should have been refused`)
              } catch {
                checked += 1
              }
              continue
            }
            let decoded: { op: number; length: number }
            try {
              decoded = check.decode(line.bytes, line.address)
            } catch (error) {
              problems.push(`${where}: ${(error as Error).message}`)
              continue
            }
            checked += 1
            if (decoded.length !== line.bytes.length) {
              problems.push(`${where}: length ${decoded.length} != ${line.bytes.length}`)
            }
            const accepted = check.aliases?.[line.mnemonic] ?? []
            const actual = check.name(decoded.op)
            if (actual !== line.mnemonic && !accepted.includes(decoded.op)) {
              problems.push(`${where}: decoded as ${actual}`)
            }
          }
          expect(problems.slice(0, 20).join('\n')).toBe('')
          // A pass that checked nothing would look like a pass that
          // checked everything.
          expect(checked).toBeGreaterThan(0)
        })
      }
    })
  }

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
        // Which bits a backend declined to claim, anywhere in the run.
        // Collected rather than merely allowed, so a backend cannot widen
        // what it excuses itself from without it showing.
        let excluded = 0n
        let excludedRegisters = 0
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
            // Bits the architecture leaves undefined after the instruction
            // that last wrote them are not compared, because the reference
            // is an implementation and an implementation puts something
            // there regardless. Every other bit is compared exactly.
            const unspecified = interpreter.undefinedBits?.(r) ?? 0n
            if (unspecified !== 0n) {
              excluded |= unspecified
              excludedRegisters |= 1 << r
            }
            if (((mine ^ expected.x[r]!) & ~unspecified) !== 0n) {
              const note = unspecified === 0n
                ? ''
                : ` (ignoring ${hex64(unspecified)}, undefined here)`
              expect.fail(
                `step ${steps} at 0x${pc.toString(16)} (${image.at(pc).mnemonic}): ` +
                `${backend.naming.name(r)} is ${hex64(mine)}, reference says ` +
                `${hex64(expected.x[r]!)}${note}${history()}`,
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
        // Whatever a backend declines to claim has to stay small and stay
        // where it said it would be. Six bits of one status register is
        // the architecture's list of undefined flags; anything wider, or
        // anywhere else, means the comparison is checking less than it
        // looks like it is.
        expect(popcount(excluded)).toBeLessThanOrEqual(6)
        expect(popcount(BigInt(excludedRegisters))).toBeLessThanOrEqual(1)
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
