import { describeIsaConformance } from '../conformance.node.ts'
import { aarch64Backend } from './backend.ts'
import { AARCH64_FIXTURE_DIR, labelAarch64Dump } from './fixtures.node.ts'

// Lockstep and final-state comparison, inherited from the shared suite. On
// this target the lockstep tier also covers the condition flags, because
// qemu reports PSTATE and RISC-V's fcsr has no equivalent in its trace.
describeIsaConformance({
  backend: aarch64Backend,
  fixtureDir: AARCH64_FIXTURE_DIR,
  labelDump: labelAarch64Dump,
})
