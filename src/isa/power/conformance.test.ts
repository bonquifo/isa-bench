import { describeIsaConformance } from '../conformance.node.ts'
import { powerBackend } from './backend.ts'
import { powerDecodeCheck } from './decodeCheck.node.ts'
import { POWER_FIXTURE_DIR, labelPowerDump } from './fixtures.node.ts'

// Lockstep, final state, whole programs and the app's corpus, all
// inherited from the shared suite.
//
// The final-state tier carries more weight on this target than on the
// others, because qemu's register dump has no floating-point registers
// at all -- and at -O2 this compiler puts every `double` result in one,
// through the vector unit. The lockstep tier therefore sees a
// floating-point program's control flow and not its answers; the
// guest's own dump is what covers them.
describeIsaConformance({
  backend: powerBackend,
  fixtureDir: POWER_FIXTURE_DIR,
  labelDump: labelPowerDump,
  decodeCheck: powerDecodeCheck,
})
