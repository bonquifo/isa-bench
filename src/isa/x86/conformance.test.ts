import { describeIsaConformance } from '../conformance.node.ts'
import { x86Backend } from './backend.ts'
import { X86_FIXTURE_DIR, labelX86Dump } from './fixtures.node.ts'

// Lockstep and final-state comparison, inherited from the shared suite.
//
// Two things are unlike the other targets. The reference is the host
// processor single-stepped through ptrace rather than an emulator, which is
// available here and nowhere else. And the lockstep tier compares the
// arithmetic flags before every instruction, minus the bits the
// architecture leaves undefined after the instruction that wrote them --
// which the interpreter declares rather than the test assuming.
describeIsaConformance({
  backend: x86Backend,
  fixtureDir: X86_FIXTURE_DIR,
  labelDump: labelX86Dump,
})
