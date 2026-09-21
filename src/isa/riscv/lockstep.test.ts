import { describe, expect, it } from 'vitest'
import { hex64 } from '../common/bits64.ts'
import { RunState, createRetireChunk } from '../common/trace.ts'
import { RV64_NAMING } from './image.ts'
import { fixtureNames, initialState, readElf, readIndex, readLockstep } from './fixtures.node.ts'
import { loadRv64 } from './load.ts'

/**
 * The strongest oracle available: qemu-riscv64 run with `-one-insn-per-tb -d
 * cpu` dumps the program counter and all thirty-two integer registers before
 * every instruction it executes. Comparing against that finds the *first*
 * instruction at which the interpreter diverges, which is the difference
 * between a bug you can fix in minutes and one you bisect for a day.
 *
 * It covers integer state only. qemu does not emit the floating-point
 * registers for RISC-V, so those are checked against the guest's own state
 * dump instead, in state.test.ts.
 */
describe('lockstep against qemu-riscv64', () => {
  const index = readIndex()

  for (const name of fixtureNames()) {
    it(`matches the reference at every step: ${name}`, () => {
      const start = initialState(name)
      const { interpreter, image } = loadRv64(readElf(name), {
        initialSp: BigInt.asIntN(64, start.x[2]!),
      })
      expect(interpreter.programCounter).toBe(start.pc)
      for (let r = 1; r < 32; r++) interpreter.setGpr(r, BigInt.asIntN(64, start.x[r]!))

      const chunk = createRetireChunk(1)
      let steps = 0
      let state: RunState = RunState.MORE

      for (const expected of readLockstep(name)) {
        const pc = interpreter.programCounter
        if (pc !== expected.pc) {
          expect.fail(
            `step ${steps}: pc is 0x${pc.toString(16)}, reference says ` +
            `0x${expected.pc.toString(16)}`,
          )
        }
        for (let r = 0; r < 32; r++) {
          const mine = BigInt.asUintN(64, interpreter.gpr(r))
          if (mine !== expected.x[r]) {
            expect.fail(
              `step ${steps} at 0x${pc.toString(16)} (${image.at(pc).mnemonic}): ` +
              `${RV64_NAMING.name(r)} is ${hex64(mine)}, reference says ` +
              `${hex64(expected.x[r]!)}`,
            )
          }
        }
        state = interpreter.run(chunk)
        steps += 1
      }

      const declared = index.fixtures.find((f) => f.name === name)
      expect(steps).toBe(declared?.steps)
      expect(state).toBe(RunState.EXITED)
      expect(interpreter.exitCode).toBe(0)
    })
  }
})
