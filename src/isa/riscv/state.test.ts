import { describe, expect, it } from 'vitest'
import { hex64 } from '../common/bits64.ts'
import { RunState, createRetireChunk } from '../common/trace.ts'
import { decodeDump, fixtureNames, initialState, readDump, readElf } from './fixtures.node.ts'
import { loadRv64 } from './load.ts'

/**
 * Final architectural state, compared against the guest's own dump.
 *
 * This is the half of the comparison qemu's trace cannot provide: it does not
 * emit floating-point registers for RISC-V, and it says nothing about memory.
 * Each program therefore writes its whole state — thirty-two integer
 * registers, thirty-two floating-point registers as raw bit patterns, fcsr,
 * and a kilobyte memory window — to file descriptor 1. Running the same ELF
 * under the interpreter must produce byte-identical output.
 *
 * Because the guest does the dumping, this generalises unchanged to the
 * oracles that have no register-inspection facility at all: the native x86-64
 * binary, Wasmtime and mos-sim.
 */
function runToCompletion(name: string) {
  const start = initialState(name)
  const loaded = loadRv64(readElf(name), { initialSp: BigInt.asIntN(64, start.x[2]!) })
  for (let r = 1; r < 32; r++) loaded.interpreter.setGpr(r, BigInt.asIntN(64, start.x[r]!))
  const chunk = createRetireChunk(4096)
  let state: RunState = RunState.MORE
  while (state === RunState.MORE) state = loaded.interpreter.run(chunk)
  return loaded
}

describe('final architectural state against the guest dump', () => {
  for (const name of fixtureNames()) {
    it(`reproduces every byte of the reference dump: ${name}`, () => {
      const { interpreter } = runToCompletion(name)
      expect(interpreter.exitCode).toBe(0)

      const reference = readDump(name)
      const produced = decodeDump(interpreter.stdout())

      // Compare field by field so a failure names what diverged rather than
      // printing a kilobyte of hex.
      for (let r = 0; r < 32; r++) {
        if (produced.x[r] !== reference.x[r]) {
          expect.fail(
            `x${r}: produced ${hex64(produced.x[r]!)}, reference ${hex64(reference.x[r]!)}`,
          )
        }
      }
      for (let r = 0; r < 32; r++) {
        if (produced.f[r] !== reference.f[r]) {
          expect.fail(
            `f${r}: produced ${hex64(produced.f[r]!)}, reference ${hex64(reference.f[r]!)}`,
          )
        }
      }
      expect(hex64(produced.fcsr)).toBe(hex64(reference.fcsr))

      for (let i = 0; i < reference.scratch.length; i += 8) {
        const mine = new DataView(produced.scratch.buffer, produced.scratch.byteOffset)
          .getBigUint64(i, true)
        const theirs = new DataView(reference.scratch.buffer, reference.scratch.byteOffset)
          .getBigUint64(i, true)
        if (mine !== theirs) {
          expect.fail(`scratch[${i / 8}]: produced ${hex64(mine)}, reference ${hex64(theirs)}`)
        }
      }
    })

    it(`keeps its register file consistent with what it stored: ${name}`, () => {
      // The epilogue writes the registers to memory and the syscall layer
      // reads them back out, so this catches a register file that disagrees
      // with the stores it just performed. Integer registers are excluded:
      // the write and exit calls clobber a0..a2 and a7 after the dump.
      const { interpreter } = runToCompletion(name)
      const dumped = decodeDump(interpreter.stdout())
      const state = interpreter.finalState()
      for (let r = 0; r < 32; r++) {
        expect(hex64(state.fpr[r]!)).toBe(hex64(dumped.f[r]!))
      }
      expect(state.status.fcsr).toBe(dumped.fcsr)
    })
  }

  it('checks something: the reference dumps are not all zero', () => {
    const reference = readDump('fp_bin')
    expect(reference.f.some((v) => v !== 0n)).toBe(true)
    expect(reference.scratch.some((v) => v !== 0)).toBe(true)
  })
})
