import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactStore } from '../../server/src/artifacts.ts'
import { JobDatabase } from '../../server/src/database.ts'
import { JobRunner } from '../../server/src/runner.ts'
import { loadConfig } from '../../server/src/config.ts'
import { prepareToolchainInput } from '../../server/src/app.ts'
import { taggedJsonParse } from '@isa-sim/contracts'

const root = mkdtempSync(join(tmpdir(), 'isa-backend-toolchain-'))
const database = new JobDatabase(join(root, 'jobs.sqlite'), 1024 * 1024)
const artifacts = new ArtifactStore(join(root, 'artifacts'), 64 * 1024 * 1024, {
  count: 100,
  bytes: 512 * 1024 * 1024,
  ageMs: 60_000,
})
const config = loadConfig({
  dataDir: root,
  concurrency: 1,
  jobTimeoutMs: 120_000,
  artifactMaxBytes: 64 * 1024 * 1024,
})
const runner = new JobRunner(database, artifacts, config)

try {
  const targets = [
    'x86_64-linux', 'aarch64-linux', 'riscv64-linux', 'mipsel-o32',
    'powerpc64le-elfv2', 'sparc-v8', 'wasm32-wasip1', 'mos-sim',
  ]
  const prepared = await prepareToolchainInput({
    workloadId: 'custom',
    n: 1,
    seed: 0,
    isas: ['x86'],
    hardwareMode: 'same',
    profileId: 'same-mid',
    customSource: 'imm r0, 287453952\nhalt r0\n',
  }, targets)
  const job = database.create('toolchain-backend-smoke', {
    schemaVersion: 'server-job-request-v1',
    lane: 'toolchain-validation',
    input: prepared,
  })
  runner.enqueue(job.id)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const current = database.get(job.id)
    if (current?.state === 'succeeded') {
      const result = taggedJsonParse(
        artifacts.read(current.terminalResultArtifactId!).toString('utf8'),
      ) as { targets?: Record<string, { tier?: string }> }
      const executable = [
        'x86_64-linux', 'aarch64-linux', 'riscv64-linux', 'mipsel-o32',
        'powerpc64le-elfv2', 'sparc-v8', 'wasm32-wasip1',
      ]
      if (executable.some((target) => result.targets?.[target]?.tier !== 'execute') ||
          result.targets?.['mos-sim']?.tier !== 'unsupported') {
        throw new Error(`unexpected backend tiers: ${JSON.stringify(result.targets)}`)
      }
      process.stdout.write(`${JSON.stringify(result)}\n`)
      break
    }
    if (current?.state === 'failed' || current?.state === 'cancelled') {
      throw new Error(`backend smoke ${current.state}: ${JSON.stringify(current.error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (database.get(job.id)?.state !== 'succeeded') throw new Error('backend toolchain smoke timed out')
} finally {
  await runner.close()
  database.close()
  rmSync(root, { recursive: true, force: true })
}
