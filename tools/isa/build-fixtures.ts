/**
 * Captures differential fixtures for one target from its reference oracle.
 *
 *   npx vite-node tools/isa/build-fixtures.ts rv64
 *
 * Requires Docker and the images named in the target descriptor. The output
 * is committed, so this runs when a backend, a harness or a seed changes —
 * not as part of the test suite, which reads what is already captured.
 */
import { buildFixtures, type FixtureTarget } from './fixture-builder.ts'
import { rv64Target } from './targets/rv64.ts'

const TARGETS: Record<string, FixtureTarget> = {
  rv64: rv64Target,
}

const requested = process.argv[2]
if (!requested) {
  console.error(`usage: build-fixtures.ts <target>\ntargets: ${Object.keys(TARGETS).join(', ')}`)
  process.exit(1)
}
const target = TARGETS[requested]
if (!target) {
  console.error(`unknown target ${requested}; known: ${Object.keys(TARGETS).join(', ')}`)
  process.exit(1)
}
buildFixtures(target)
