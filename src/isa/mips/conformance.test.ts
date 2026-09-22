import { describeIsaConformance } from '../conformance.node.ts'
import { mipsBackend } from './backend.ts'
import { mipsDecodeCheck } from './decodeCheck.node.ts'
import { MIPS_FIXTURE_DIR, labelMipsDump } from './fixtures.node.ts'

// Lockstep and final-state comparison, inherited from the shared suite.
//
// The lockstep tier matters more here than on any other target, because
// the delay slot is an ordering property: an interpreter that ran the
// slot at the wrong moment still reaches the right answer for most
// programs, and only a comparison that checks the state before every
// instruction sees the difference.
describeIsaConformance({
  backend: mipsBackend,
  fixtureDir: MIPS_FIXTURE_DIR,
  labelDump: labelMipsDump,
  decodeCheck: mipsDecodeCheck,
})
