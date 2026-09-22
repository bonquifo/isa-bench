import { describe, expect, it } from 'vitest'
import { hex64, u64 } from '../common/bits64.ts'
import { RunState, createRetireChunk } from '../common/trace.ts'
import { initialState, readElf } from '../common/fixtures.node.ts'
import { describeIsaConformance } from '../conformance.node.ts'
import { rv64Backend } from './backend.ts'
import { rv64DecodeCheck } from './decodeCheck.node.ts'
import { RV64_FIXTURE_DIR, decodeDump, labelRv64Dump, readDump } from './fixtures.node.ts'
import { fixtureNames } from '../common/fixtures.node.ts'

// Lockstep and final-state comparison, inherited rather than written here:
// every backend gets the same checks, so none of them can quietly verify
// slightly less than the others.
describeIsaConformance({
  backend: rv64Backend,
  fixtureDir: RV64_FIXTURE_DIR,
  labelDump: labelRv64Dump,
  decodeCheck: rv64DecodeCheck,
})

describe('RV64GC beyond the shared suite', () => {
  it('keeps its register file consistent with what it stored', () => {
    // The guest epilogue writes the registers to memory and the syscall layer
    // reads them back out, so this catches a register file that disagrees
    // with the stores it just performed. Integer registers are excluded: the
    // write and exit calls clobber a0..a2 and a7 after the dump is taken.
    for (const name of fixtureNames(RV64_FIXTURE_DIR)) {
      const start = initialState(RV64_FIXTURE_DIR, name, rv64Backend.gprCount)
      const { interpreter } = rv64Backend.load(readElf(RV64_FIXTURE_DIR, name), {
        initialRegisters: start.x.map((v) => BigInt.asIntN(64, v)),
      })
      const chunk = createRetireChunk(4096)
      let state: RunState = RunState.MORE
      while (state === RunState.MORE) state = interpreter.run(chunk)

      const dumped = decodeDump(interpreter.stdout())
      const live = interpreter.finalState()
      for (let r = 0; r < 32; r++) {
        if (u64(live.fpr[r]!) !== dumped.f[r]) {
          expect.fail(`${name} f${r}: live ${hex64(live.fpr[r]!)}, stored ${hex64(dumped.f[r]!)}`)
        }
      }
      expect(`${name}: ${live.status.fcsr}`).toBe(`${name}: ${dumped.fcsr}`)
    }
  })

  it('exercises the floating-point state it claims to model', () => {
    // A guard against the suite passing because every dump is zero.
    const reference = readDump('fp_bin')
    expect(reference.f.some((v) => v !== 0n)).toBe(true)
    expect(reference.fcsr).not.toBe(0n)
    expect(readDump('mem').scratch.some((b) => b !== 0)).toBe(true)
  })
})
