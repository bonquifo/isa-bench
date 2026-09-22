import { describeIsaConformance } from '../conformance.node.ts'
import { sparcBackend } from './backend.ts'
import { sparcDecodeCheck } from './decodeCheck.node.ts'
import { SPARC_FIXTURE_DIR, labelSparcDump } from './fixtures.node.ts'

// Lockstep and final-state comparison, inherited from the shared suite.
// The lockstep tier covers more than the other targets' here, because
// this architecture has more state that a wrong implementation could
// still produce the right answer with: `npc` as well as `pc`, since the
// delay slot is architectural; the window invalid mask, since the spill
// and fill happen inside an instruction rather than in guest code; and
// `y`, which a multiply writes and a divide reads several instructions
// later.
describeIsaConformance({
  backend: sparcBackend,
  fixtureDir: SPARC_FIXTURE_DIR,
  labelDump: labelSparcDump,
  decodeCheck: sparcDecodeCheck,
})
