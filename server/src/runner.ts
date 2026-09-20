import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  ExternalSimulatorResultSchema,
  ResultEnvelopeSchema,
  ToolchainValidationResultSchema,
  ToolchainPreparedDescriptorV1Schema,
  ToolchainWorkerResultV1Schema,
  TaggedJsonValueSchema,
  WorkerToServerMessageV1Schema,
  assertResultIdentity,
  encodeTaggedJson,
  taggedJsonStringify,
} from '@isa-sim/contracts'
import type { ArtifactStore } from './artifacts.js'
import type { JobDatabase } from './database.js'
import type { JobRecord, ServerConfig } from './types.js'
import { forceRemoveJobContainers } from './sandbox.js'

export interface LaneCapability {
  id: string
  available: boolean
  reason: string
}

export const laneRegistry: readonly LaneCapability[] = [
  { id: 'analytical-inorder', available: true, reason: 'built-in deterministic in-order model' },
  { id: 'toolchain-validation', available: false, reason: 'toolchain images are not installed' },
  { id: 'analytical-ooo', available: true, reason: 'built-in deterministic decoded-op OoO model' },
  { id: 'gem5', available: false, reason: 'no exact checked-in gem5 target probe passed' },
  { id: 'llvm-mca', available: false, reason: 'no exact checked-in llvm-mca target probe passed' },
  { id: 'champsim', available: false, reason: 'no exact checked-in ChampSim target probe passed' },
  { id: 'empirical-measurement', available: false, reason: 'empirical runners are not implemented' },
  { id: 'calibrated-prediction', available: false, reason: 'calibration pipeline is not implemented' },
] as const

export function resolvedLaneRegistry(toolchains: { available: boolean; reason: string }): readonly LaneCapability[] {
  return laneRegistry.map((lane) => lane.id === 'toolchain-validation'
    ? { ...lane, available: toolchains.available, reason: toolchains.reason }
    : lane)
}

interface ActiveRun {
  worker: Worker
  cancelled: boolean
  timer: NodeJS.Timeout
  forceTimer?: NodeJS.Timeout
  terminalAfterAbort?: 'cancelled' | 'failed'
  abortError?: { code: string; message: string }
  processing: Promise<void>
  requiresContainerCleanup: boolean
  cleanupConfirmed: boolean
  pendingArtifacts: Array<{ bytes: Uint8Array; mimeType: string; filename: string }>
  pendingArtifactBytes: number
}

export class JobRunner {
  private readonly queue: string[] = []
  private readonly active = new Map<string, ActiveRun>()
  private pumping = false
  private readonly serverId = `server-${process.pid}-${randomUUID()}`

  constructor(
    private readonly db: JobDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly config: ServerConfig,
    private readonly removeJobContainers: (id: string, serverId?: string) => boolean = forceRemoveJobContainers,
  ) {}

  enqueue(id: string): void {
    if (!this.queue.includes(id) && !this.active.has(id)) this.queue.push(id)
    void this.pump()
  }

  resumeQueued(): void {
    for (const job of this.db.list(1000).reverse()) {
      if (job.state === 'queued') this.enqueue(job.id)
    }
  }

  cancel(id: string): JobRecord | null {
    let job = this.db.get(id)
    if (!job) return null
    if (job.state === 'queued') {
      this.removeQueued(id)
      const cancelled = this.db.transition(id, Number(job.revision), 'cancelled', 'cancel requested')
      this.db.cleanup(this.config.retention)
      return cancelled
    }
    if (job.state === 'running') {
      const run = this.active.get(id)
      if (run) {
        run.cancelled = true
        run.terminalAfterAbort = 'cancelled'
        clearTimeout(run.timer)
        job = this.db.transition(id, Number(job.revision), 'cancelling', 'cancel requested')
        run.worker.postMessage({ type: 'abort', reason: 'cancel requested' })
        run.forceTimer = setTimeout(() => {
          run.cleanupConfirmed = !run.requiresContainerCleanup || this.removeJobContainers(id, this.serverId)
          void run.worker.terminate()
        }, 5_000)
        run.forceTimer.unref()
      }
      return job
    }
    return job
  }

  async close(): Promise<void> {
    const workers = [...this.active.entries()].map(async ([id, run]) => {
      clearTimeout(run.timer)
      if (run.forceTimer) clearTimeout(run.forceTimer)
      run.worker.postMessage({ type: 'abort', reason: 'server closing' })
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_500))
      if (this.active.has(id) && run.requiresContainerCleanup) {
        run.cleanupConfirmed = this.removeJobContainers(id, this.serverId)
      }
      await run.worker.terminate()
    })
    await Promise.allSettled(workers)
  }

  private removeQueued(id: string): void {
    const index = this.queue.indexOf(id)
    if (index >= 0) this.queue.splice(index, 1)
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.active.size < this.config.concurrency && this.queue.length > 0) {
        const id = this.queue.shift()!
        const job = this.db.get(id)
        if (job?.state !== 'queued') continue
        this.start(job)
      }
    } finally {
      this.pumping = false
    }
  }

  private start(queued: JobRecord): void {
    const assigned = this.db.transition(queued.id, Number(queued.revision), 'assigned', 'local worker assigned')
    const running = this.db.transition(assigned.id, Number(assigned.revision), 'running', 'worker started')
    const sourceWorker = resolveWorker(
      isToolchainJob(running.request)
        ? 'toolchain-worker'
        : isExternalJob(running.request)
          ? 'external-worker'
          : 'model-worker',
      this.config.repositoryRoot,
    )
    const worker = new Worker(pathToFileURL(sourceWorker), {
      execArgv: sourceWorker.endsWith('.ts') ? ['--import', 'tsx'] : [],
      workerData: {
        dataDir: this.config.dataDir,
        repositoryRoot: this.config.repositoryRoot,
        jobId: running.id,
        serverId: this.serverId,
      },
    })
    const timeoutMs = getTimeout(running.request, this.config.jobTimeoutMs)
    const timer = setTimeout(() => {
      const active = this.active.get(running.id)
      if (!active) return
      active.cancelled = true
      active.terminalAfterAbort = 'failed'
      active.abortError = { code: 'timeout', message: `Job exceeded ${timeoutMs} ms timeout` }
      const current = this.db.get(running.id)
      if (current?.state === 'running') {
        this.db.transition(running.id, Number(current.revision), 'cancelling', 'job timeout; stopping worker')
      }
      worker.postMessage({ type: 'abort', reason: 'job timeout' })
      active.forceTimer = setTimeout(() => {
        active.cleanupConfirmed = !active.requiresContainerCleanup || this.removeJobContainers(running.id, this.serverId)
        void worker.terminate()
      }, 5_000)
      active.forceTimer.unref()
    }, timeoutMs)
    timer.unref()
    const active: ActiveRun = {
      worker,
      cancelled: false,
      timer,
      processing: Promise.resolve(),
      requiresContainerCleanup: isExternalJob(running.request) || isToolchainJob(running.request),
      cleanupConfirmed: false,
      pendingArtifacts: [],
      pendingArtifactBytes: 0,
    }
    this.active.set(running.id, active)

    worker.on('message', (rawMessage: unknown) => {
      active.processing = active.processing.then(() => this.handleWorkerMessage(running, active, rawMessage))
    })
    worker.on('error', (error: unknown) => {
      active.processing = active.processing.then(() => this.failAfterCleanup(running.id, active, {
          code: 'worker_error',
          message: error instanceof Error ? error.message : String(error),
        }))
    })
    worker.on('exit', (code) => {
      void (async () => {
        await active.processing
        clearTimeout(timer)
        if (active.forceTimer) clearTimeout(active.forceTimer)
        const current = this.db.get(running.id)
        if (current?.state === 'running') {
          await this.failAfterCleanup(running.id, active, {
            code: 'worker_exit',
            message: `worker exited before a result (code ${code})`,
          })
        } else if (current?.state === 'cancelling') {
          const confirmed = await this.confirmCleanup(running.id, active)
          const latest = this.db.get(running.id)
          if (confirmed && latest?.state === 'cancelling') {
            if (active.terminalAfterAbort === 'failed') {
              this.db.transition(running.id, Number(latest.revision), 'failed', 'forced cleanup completed',
                active.abortError ?? { code: 'aborted', message: 'forced cleanup completed' })
            } else {
              this.db.transition(running.id, Number(latest.revision), 'cancelled', 'forced cleanup completed')
            }
          }
        }
        this.active.delete(running.id)
        void this.pump()
      })()
    })
    const compareInput = extractCompareInput(running.request)
    worker.postMessage(isOoOJob(running.request)
      ? { lane: 'analytical-ooo', input: compareInput }
      : isExternalJob(running.request)
        ? {
            lane: running.request.lane,
            input: running.request.input,
            ...(running.request.timeoutMs === undefined ? {} : { timeoutMs: running.request.timeoutMs }),
          }
        : isToolchainJob(running.request)
          ? running.request.input
        : compareInput)
  }

  private async handleWorkerMessage(running: JobRecord, active: ActiveRun, rawMessage: unknown): Promise<void> {
    let message
    try {
      message = WorkerToServerMessageV1Schema.parse(rawMessage)
    } catch (error) {
      await this.failAfterCleanup(running.id, active, {
        code: 'invalid_worker_message',
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const current = this.db.get(running.id)
    if (!current) return
    if (message.type === 'cancelled') {
      if (current.state !== 'cancelling') return
    } else if (current.state !== 'running') {
      return
    }
    if (message.type === 'progress') {
      this.db.setProgress(
        running.id,
        message.progress.ratio,
        message.progress.phase,
        message.progress.detail,
      )
    } else if (message.type === 'artifact') {
        active.pendingArtifactBytes += message.bytes.byteLength
        if (active.pendingArtifactBytes > this.config.artifactMaxBytes) {
          await this.failAfterCleanup(running.id, active, {
            code: 'artifact_limit',
            message: 'worker artifacts exceed the per-job artifact limit',
          })
          return
        }
        active.pendingArtifacts.push({
          bytes: message.bytes.slice(),
          mimeType: message.mimeType,
          filename: message.filename,
        })
      } else if (message.type === 'result') {
        if (message.lane !== running.request.lane) {
          await this.failAfterCleanup(running.id, active, {
            code: 'invalid_worker_result',
            message: `worker result lane ${message.lane} does not match ${running.request.lane}`,
          })
          return
        }
        try {
          await validateWorkerResult(running.request.lane, message.result, running.request)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.failAfterCleanup(running.id, active, {
            code: 'invalid_worker_result',
            message: message.slice(0, 8192),
          })
          return
        }
        const latest = this.db.get(running.id)
        if (latest?.state !== 'running') return
        for (const pending of active.pendingArtifacts) {
          const stored = this.artifacts.put(pending.bytes, {
            mimeType: pending.mimeType,
            filename: pending.filename,
          })
          this.db.appendEvent(running.id, 'artifact', { artifact: stored })
        }
        active.pendingArtifacts = []
        active.pendingArtifactBytes = 0
        const artifact = this.artifacts.put(taggedJsonStringify(message.result), {
          mimeType: 'application/json',
          filename: `${running.id}.json`,
        })
        this.artifacts.cleanup()
        const beforeSuccess = this.db.get(running.id)
        if (beforeSuccess?.state === 'running') {
          this.db.transition(running.id, Number(beforeSuccess.revision), 'succeeded', 'model completed', artifact.id)
          this.db.cleanup(this.config.retention)
        }
      } else if (message.type === 'cancelled') {
        const latest = this.db.get(running.id)
        if (latest?.state !== 'cancelling') return
        if (!await this.confirmCleanup(running.id, active)) return
        const confirmed = this.db.get(running.id)
        if (confirmed?.state !== 'cancelling') return
        if (active.terminalAfterAbort === 'failed') {
          this.db.transition(running.id, Number(confirmed.revision), 'failed', message.reason,
            active.abortError ?? { code: 'aborted', message: message.reason })
        } else {
          this.db.transition(running.id, Number(confirmed.revision), 'cancelled', message.reason)
        }
        this.db.cleanup(this.config.retention)
      } else {
        await this.failAfterCleanup(running.id, active, message.error)
      }
  }

  private async failAfterCleanup(
    id: string,
    active: ActiveRun,
    error: { code: string; message: string },
  ): Promise<void> {
    let current = this.db.get(id)
    if (current?.state === 'running') {
      current = this.db.transition(id, Number(current.revision), 'cancelling', 'worker failure; cleaning containers')
    }
    if (current?.state !== 'cancelling' || !await this.confirmCleanup(id, active)) return
    const latest = this.db.get(id)
    if (latest?.state !== 'cancelling') return
    const bounded = { ...error, message: error.message.slice(0, 8192) }
    this.db.transition(id, Number(latest.revision), 'failed', bounded.message, bounded)
    this.db.cleanup(this.config.retention)
  }

  private async confirmCleanup(id: string, active: ActiveRun): Promise<boolean> {
    if (!active.requiresContainerCleanup) {
      active.cleanupConfirmed = true
      return true
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.removeJobContainers(id, this.serverId)) {
        active.cleanupConfirmed = true
        return true
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    return false
  }
}

function extractCompareInput(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'input' in value) {
    return (value as { input: unknown }).input
  }
  return value
}

function getTimeout(value: unknown, fallback: number): number {
  if (typeof value !== 'object' || value === null || !('timeoutMs' in value)) return fallback
  const timeout = Number((value as { timeoutMs: unknown }).timeoutMs)
  return Number.isSafeInteger(timeout) && timeout >= 100 && timeout <= fallback ? timeout : fallback
}

function resolveWorker(
  name: 'model-worker' | 'toolchain-worker' | 'external-worker',
  repositoryRoot = process.cwd(),
): string {
  const candidates = [
    resolve(repositoryRoot, `server/src/${name}.ts`),
    resolve(process.cwd(), `server/src/${name}.ts`),
    resolve(process.cwd(), `src/${name}.ts`),
    resolve(import.meta.dirname, `${name}.js`),
    resolve(import.meta.dirname, `${name}.ts`),
  ]
  const found = candidates.find(existsSync)
  if (!found) throw new Error('model worker entrypoint not found')
  return found
}

function isExternalJob(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    ['gem5', 'llvm-mca', 'champsim'].includes(String((value as { lane?: unknown }).lane))
}

function isToolchainJob(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    (value as { lane?: unknown }).lane === 'toolchain-validation'
}

function isOoOJob(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    (value as { lane?: unknown }).lane === 'analytical-ooo'
}

export async function validateWorkerResult(
  lane: string,
  value: unknown,
  request: JobRecord['request'],
): Promise<void> {
  TaggedJsonValueSchema.parse(encodeTaggedJson(value))
  if (['gem5', 'llvm-mca', 'champsim'].includes(lane)) {
    const result = ExternalSimulatorResultSchema.parse(value)
    if (result.experimentKind !== lane) throw new Error('external result engine does not match job lane')
    await assertResultIdentity(result)
    return
  }
  if (!value || typeof value !== 'object') throw new Error('worker result must be an object')
  if (lane === 'toolchain-validation') {
    const descriptor = ToolchainPreparedDescriptorV1Schema.parse(request.input)
    const descriptorHash = createHash('sha256')
      .update(taggedJsonStringify(descriptor.payload))
      .digest('hex')
    if (descriptorHash !== descriptor.payloadSha256) throw new Error('prepared toolchain descriptor hash mismatch')
    const result = ToolchainWorkerResultV1Schema.parse(value)
    if (result.descriptorSha256 !== descriptor.payloadSha256 ||
        result.emitterVersion !== descriptor.payload.emitterVersion) {
      throw new Error('toolchain result does not match prepared descriptor identity')
    }
    const observedTargets = Object.keys(result.targets).sort()
    const expectedTargets = [...descriptor.payload.targets].sort()
    if (taggedJsonStringify(observedTargets) !== taggedJsonStringify(expectedTargets)) {
      throw new Error('toolchain target observations do not exactly match prepared targets')
    }
    if (result.envelopes.length !== expectedTargets.length) {
      throw new Error('toolchain result must contain one envelope per target')
    }
    const groups = new Set<string>()
    const remainingTargets = new Set(expectedTargets)
    const canonicalInputIdentity = createHash('sha256').update(descriptor.payload.canonicalIr).digest('hex')
    for (const envelope of result.envelopes) {
      const parsed = ToolchainValidationResultSchema.parse(envelope)
      const targetId = expectedTargets.find((candidate) =>
        TOOLCHAIN_TARGETS[candidate]?.triple === parsed.target.triple)
      if (!targetId || !remainingTargets.delete(targetId)) {
        throw new Error('toolchain envelope target is unexpected or duplicated')
      }
      const target = TOOLCHAIN_TARGETS[targetId]!
      if (parsed.target.abi !== target.abi || parsed.target.endianness !== target.endianness ||
          parsed.target.addressWidth !== target.addressWidth ||
          parsed.inputIdentity !== canonicalInputIdentity) {
        throw new Error('toolchain envelope target/input identity mismatch')
      }
      const expectedStatus = result.targets[targetId]!.tier === 'execute'
        ? 'passed'
        : result.targets[targetId]!.tier === 'codegen-only'
          ? 'not-executed'
          : 'failed'
      if (parsed.validationStatus !== expectedStatus) {
        throw new Error('toolchain envelope status differs from target observation')
      }
      if (parsed.comparison.modelVersion !== descriptor.payload.emitterVersion) {
        throw new Error('toolchain envelope emitter version mismatch')
      }
      if (!groups.add(parsed.comparisonGroupKey)) throw new Error('toolchain envelopes are not unique')
      await assertResultIdentity(parsed)
    }
    if (groups.size !== expectedTargets.length || remainingTargets.size !== 0) {
      throw new Error('toolchain target envelopes are incomplete')
    }
    return
  }
  if (lane === 'analytical-inorder') {
    const result = value as Record<string, unknown>
    validateRows(result.rows, 'isa')
    const input = extractCompareInput(request)
    const { runComparison } = await import(pathToFileURL(resolveEngineEntry()).href) as {
      runComparison: (input: unknown) => Record<string, unknown>
    }
    const expected = runComparison(input)
    if (taggedJsonStringify(result) !== taggedJsonStringify(expected)) {
      throw new Error('analytical in-order result does not match the current contract/reference result')
    }
    return
  }
  if (lane === 'analytical-ooo') {
    const result = value as Record<string, unknown>
    validateRows(result.rows, 'isa')
    const envelopes = result.envelopes
    if (!Array.isArray(envelopes) || envelopes.length === 0) throw new Error('OoO result lacks analytical envelopes')
    const groups = new Set<string>()
    for (const envelope of envelopes) {
      const parsed = ResultEnvelopeSchema.parse(envelope)
      if (!groups.add(parsed.comparisonGroupKey)) throw new Error('OoO envelopes are not unique')
      await assertResultIdentity(parsed)
    }
    const input = extractCompareInput(request)
    const { runOoOComparison } = await import(pathToFileURL(resolveEngineEntry()).href) as {
      runOoOComparison: (input: unknown) => Record<string, unknown>
    }
    const expected = runOoOComparison(input)
    if (taggedJsonStringify(result.rows) !== taggedJsonStringify(expected.rows) ||
        result.modelVersion !== expected.modelVersion ||
        result.referenceModelVersion !== expected.referenceModelVersion ||
        result.gold !== expected.gold ||
        result.stdout !== expected.stdout) {
      throw new Error('analytical OoO result does not match the current model/reference result')
    }
    return
  }
  throw new Error(`unsupported worker result lane ${lane}`)
}

function validateRows(value: unknown, identityField: string): void {
  if (!Array.isArray(value) || value.length === 0) throw new Error('analytical result rows must be nonempty')
  const identities = new Set<string>()
  for (const row of value) {
    if (!row || typeof row !== 'object') throw new Error('analytical result row must be an object')
    const identity = (row as Record<string, unknown>)[identityField]
    if (typeof identity !== 'string' || identity.length === 0 || !identities.add(identity)) {
      throw new Error('analytical result rows must have unique target identities')
    }
    if ('matchedGold' in row && (row as { matchedGold?: unknown }).matchedGold !== true) {
      throw new Error('analytical result row does not match the reference result')
    }
  }
}

function resolveEngineEntry(): string {
  const candidates = [
    resolve(process.cwd(), 'src/engine/index.ts'),
    resolve(process.cwd(), '../src/engine/index.ts'),
    resolve(import.meta.dirname, '../../src/engine/index.ts'),
  ]
  const found = candidates.find(existsSync)
  if (!found) throw new Error('analytical engine entrypoint not found')
  return found
}

const TOOLCHAIN_TARGETS: Record<string, {
  triple: string
  abi: string
  endianness: 'little' | 'big'
  addressWidth: 16 | 32 | 64 | 128
}> = {
  'x86_64-linux': { triple: 'x86_64-unknown-linux-gnu', abi: 'SysV AMD64', endianness: 'little', addressWidth: 64 },
  'aarch64-linux': { triple: 'aarch64-unknown-linux-gnu', abi: 'AAPCS64', endianness: 'little', addressWidth: 64 },
  'riscv64-linux': { triple: 'riscv64-unknown-linux-gnu', abi: 'lp64d', endianness: 'little', addressWidth: 64 },
  'mipsel-o32': { triple: 'mipsel-unknown-linux-gnu', abi: 'o32', endianness: 'little', addressWidth: 32 },
  'powerpc64le-elfv2': { triple: 'powerpc64le-unknown-linux-gnu', abi: 'ELFv2', endianness: 'little', addressWidth: 64 },
  'sparc-v8': { triple: 'sparc-unknown-linux-gnu', abi: 'SPARC V8', endianness: 'big', addressWidth: 32 },
  'wasm32-wasip1': { triple: 'wasm32-wasip1', abi: 'WASI Preview 1', endianness: 'little', addressWidth: 32 },
  'mos-sim': { triple: 'mos-unknown-unknown', abi: 'llvm-mos freestanding', endianness: 'little', addressWidth: 16 },
}
