import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { DockerExecutor } from './sandbox.js'
import {
  assemblerRegion,
  createExternalEnvelope,
  loadExternalCapabilities,
  parseChampSimJson,
  parseExternalRequest,
  parseGem5Stats,
  parseLlvmMcaJson,
  parseRoiMarkers,
  roiCoverageDiagnostic,
  selectEligibleNativeArtifact,
  staticModelRelevance,
  targetDescriptor,
  validateGem5Config,
  validateMicrotrace,
  type MicrotraceManifest,
} from './external.js'

if (!parentPort) throw new Error('external worker requires parentPort')
const controller = new AbortController()
parentPort.on('message', (value: unknown) => {
  if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'abort') {
    controller.abort()
  }
})

const data = workerData as {
  dataDir?: string
  repositoryRoot?: string
  jobId?: string
  serverId?: string
} | undefined
const dataDir = resolve(data?.dataDir ?? '.isa-bench-data')
const repositoryRoot = resolve(data?.repositoryRoot ?? process.cwd())

parentPort.once('message', async (value: unknown) => {
  const root = mkdtempSync(join(tmpdir(), 'isa-external-'))
  try {
    const request = parseExternalRequest(value)
    const capability = loadExternalCapabilities(repositoryRoot, undefined, dataDir).find((candidate) =>
      candidate.engine === request.lane && candidate.target === request.input.target)
    if (capability?.tier !== 'execute') throw new Error(capability?.reason ?? 'external capability is not executable')
    progress(0.05, 'VALIDATE', `validating ${request.lane} artifact provenance`)
    const executor = new DockerExecutor(undefined, { jobId: data?.jobId, serverId: data?.serverId })
    const image = imageIdentity(request.lane)
    const descriptor = targetDescriptor(request.input.target)
    let invocation: string[]
    let raw: Buffer
    let diagnostics: string[] = []
    let parsed: { metrics: Array<{ name: string; domain: string; unit: string; value: string | number }>; normalized: Record<string, never> | Record<string, unknown> }
    let semanticHash: string
    let pipelineHash: string
    let roiHash: string
    let profileHash: string
    let simulatorConfigHash: string

    if (request.lane === 'champsim') {
      const manifestId = manifestArtifactId(value)
      const trace = readStoredArtifact(request.input.artifactId)
      const manifestBytes = readStoredArtifact(manifestId)
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as MicrotraceManifest
      validateMicrotrace(trace, manifest)
      writeFileSync(join(root, 'trace.microtrace-v1'), trace, { flag: 'wx' })
      invocation = [
        'run', '--trace', '/artifacts/trace.microtrace-v1',
        '--warmup-instructions', manifest.warmupInstructions,
        '--simulation-instructions', manifest.simulationInstructions,
        '--json',
      ]
      progress(0.35, 'SIMULATE', 'running committed-path ChampSim trace')
      const run = await executor.execute({
        image: image.digest,
        argv: invocation,
        artifactDir: root,
        signal: abortSignal(),
        limits: limits(request.timeoutMs, 4 * 1024 * 1024),
      })
      assertRun(run, 'ChampSim')
      raw = Buffer.from(run.stdout)
      parsed = parseChampSimJson(run.stdout)
      semanticHash = request.input.artifactId
      pipelineHash = digest(JSON.stringify({ adapter: 'microtrace-v1-to-champsim-2026-04', mapping: manifest.registerMapping }))
      roiHash = manifest.roiDefinitionHash
      profileHash = digest(JSON.stringify({
        warmup: manifest.warmupInstructions,
        simulation: manifest.simulationInstructions,
        image: image.digest,
      }))
      simulatorConfigHash = profileHash
    } else {
      const native = selectEligibleNativeArtifact(dataDir, request.input.artifactId, request.input.target)
      semanticHash = semanticIdentity(native.record)
      if (typeof native.record.roiHash !== 'string') throw new Error('native artifact lacks exact ROI hash')
      roiHash = native.record.roiHash
      if (request.lane === 'gem5') {
        cpSync(native.binary, join(root, 'benchmark.bin'), { errorOnExist: true })
        const config = resolve(repositoryRoot, 'external/config/gem5-se.py')
        if (!existsSync(config)) throw new Error('ISA-aware gem5 configuration is missing')
        cpSync(config, join(root, 'gem5-se.py'), { errorOnExist: true })
        const isaByTarget: Record<string, string> = {
          'x86_64-linux': 'x86_64',
          'aarch64-linux': 'aarch64',
          'riscv64-linux': 'riscv64',
        }
        const isa = isaByTarget[request.input.target]
        if (!isa) throw new Error(`gem5 target ${request.input.target} has no validated ISA-aware configuration`)
        progress(0.2, 'LOCATE', 'reading ROI marker addresses from the eligible binary')
        const listing = await executor.execute({
          image: imageIdentity('llvm-mca').digest,
          argv: ['llvm-nm', '/artifacts/benchmark.bin'],
          artifactDir: root,
          signal: abortSignal(),
          limits: limits(request.timeoutMs, 4 * 1024 * 1024),
        })
        assertRun(listing, 'llvm-nm')
        const markers = parseRoiMarkers(listing.stdout)
        invocation = [
          'gem5.opt', '--outdir=/artifacts/gem5-out', '/artifacts/gem5-se.py',
          `--isa=${isa}`, '--binary=/artifacts/benchmark.bin',
          `--roi-begin=${markers.begin}`, `--roi-end=${markers.end}`,
        ]
        mkdirSync(join(root, 'gem5-out'))
        progress(0.35, 'SIMULATE', `running gem5 O3 SE for ${request.input.target}`)
        const run = await executor.execute({
          image: image.digest,
          argv: invocation,
          artifactDir: root,
          signal: abortSignal(),
          limits: limits(request.timeoutMs, 8 * 1024 * 1024),
        })
        assertRun(run, 'gem5')
        const statsPath = join(root, 'gem5-out', 'stats.txt')
        if (!existsSync(statsPath)) throw new Error('gem5 did not emit stats.txt')
        const stats = readFileSync(statsPath)
        const configText = readFileSync(join(root, 'gem5-out', 'config.json'), 'utf8')
        validateGem5Config(configText, isa)
        raw = Buffer.from(JSON.stringify({
          stdout: run.stdout,
          stderr: run.stderr,
          stats: stats.toString('utf8'),
          config: JSON.parse(configText) as unknown,
        }))
        parsed = parseGem5Stats(stats.toString('utf8'))
        const coverage = roiCoverageDiagnostic(
          String(parsed.metrics.find((metric) => metric.name === 'committed_instructions')?.value ?? ''),
          native.record.n,
        )
        if (coverage) diagnostics = [coverage]
        // ROI-scoped statistics are a different measurement from the earlier
        // whole-process adapter, so the pipeline identity changes with them.
        pipelineHash = digest(JSON.stringify({
          adapter: 'gem5-o3-se-roi-v2',
          binary: String(native.record.binarySha256),
          roiBegin: markers.begin,
          roiEnd: markers.end,
        }))
        simulatorConfigHash = digest(configText)
        profileHash = digest(JSON.stringify({
          cpu: `${isa}-O3`,
          clock: '2GHz',
          memory: { type: 'SimpleMemory', latency: '30ns', size: '512MiB' },
          caches: { l1i: '32KiB/2-way', l1d: '32KiB/2-way', l2: '256KiB/8-way' },
          emittedConfigSha256: simulatorConfigHash,
          adapterConfigSha256: digest(readFileSync(config)),
          image: image.digest,
        }))
      } else {
        cpSync(native.object, join(root, 'core.o'), { errorOnExist: true })
        const disassemble = [
          'llvm-objdump', '--disassemble-symbols=isa_bench_core', '--no-show-raw-insn',
          '--no-leading-addr', '/artifacts/core.o',
        ]
        progress(0.25, 'EXTRACT', 'extracting assembler-compatible native ROI')
        const objectDump = await executor.execute({
          image: image.digest,
          argv: disassemble,
          artifactDir: root,
          signal: abortSignal(),
          limits: limits(request.timeoutMs, 4 * 1024 * 1024),
        })
        assertRun(objectDump, 'llvm-objdump')
        const assembly = assemblerRegion(objectDump.stdout)
        writeFileSync(join(root, 'roi.s'), assembly, { flag: 'wx' })
        const cpu = request.input.cpu ?? descriptor.mcaCpu
        const features = request.input.features ?? descriptor.mcaFeatures
        invocation = [
          'llvm-mca', '--json', `--mtriple=${descriptor.triple}`, `--mcpu=${cpu}`,
          `--mattr=${features}`, `--iterations=${request.input.iterations}`,
          '/artifacts/roi.s',
        ]
        progress(0.55, 'ANALYZE', `running llvm-mca for ${request.input.target}`)
        const run = await executor.execute({
          image: image.digest,
          argv: invocation,
          artifactDir: root,
          signal: abortSignal(),
          limits: limits(request.timeoutMs, 8 * 1024 * 1024),
        })
        assertRun(run, 'llvm-mca')
        raw = Buffer.from(JSON.stringify({
          llvmMca: JSON.parse(run.stdout) as unknown,
          stderr: run.stderr,
          region: assembly,
          objectSha256: String(native.record.coreObjectSha256),
        }))
        parsed = parseLlvmMcaJson(run.stdout)
        // llvm-mca assumes every load hits and every branch is straight-line,
        // so its estimate says little about memory- or branch-bound kernels.
        // The result stays available but carries its relevance explicitly.
        const relevance = staticModelRelevance(String(native.record.family))
        parsed = { ...parsed, normalized: { ...parsed.normalized, staticModelRelevance: relevance as never } }
        diagnostics = [`llvm-mca static-model relevance for ${String(native.record.workload)} (${String(native.record.family)}): ${relevance.level}; ${relevance.note}`]
        pipelineHash = digest(JSON.stringify({ adapter: 'native-object-roi-to-llvm-mca-v1', object: String(native.record.coreObjectSha256) }))
        profileHash = digest(JSON.stringify({
          triple: descriptor.triple,
          cpu,
          features,
          iterations: request.input.iterations,
          image: image.digest,
        }))
        simulatorConfigHash = profileHash
      }
    }

    progress(0.85, 'NORMALIZE', 'validating isolated external result envelope')
    const rawId = artifact(`${request.lane}-raw.json`, 'application/json', raw)
    const envelope = await createExternalEnvelope({
      engine: request.lane,
      engineVersion: request.lane === 'gem5' ? '25.1.0.0' : request.lane === 'llvm-mca' ? '23.1.0' : '2026-04',
      invocation,
      target: request.input.target,
      artifactId: request.input.artifactId,
      workloadSemanticHash: semanticHash,
      pipelineHash,
      roiHash,
      profileHash,
      rawArtifact: { id: rawId, byteSize: raw.byteLength, mimeType: 'application/json', filename: `${request.lane}-raw.json` },
      metrics: parsed.metrics,
      normalized: parsed.normalized as never,
      configuration: {
        target: request.input.target,
        artifactId: request.input.artifactId,
        timeoutMs: request.timeoutMs ?? null,
        invocationSha256: digest(JSON.stringify(invocation)),
        simulatorConfigSha256: simulatorConfigHash,
      },
      image,
      diagnostics,
    })
    progress(1, 'COMPLETE', `${request.lane} external experiment complete`)
    if (controller.signal.aborted) throw new Error('external experiment cancelled')
    parentPort!.postMessage({ type: 'result', lane: request.lane, result: envelope })
  } catch (error) {
    if (controller.signal.aborted) {
      parentPort!.postMessage({ type: 'cancelled', reason: 'external containers stopped and removed' })
    } else {
      parentPort!.postMessage({
        type: 'error',
        error: { code: 'external_error', message: error instanceof Error ? error.message : String(error) },
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    parentPort!.close()
  }
})

function abortSignal(): AbortSignal {
  return controller.signal
}

function limits(timeoutMs: number | undefined, outputBytes: number): {
  timeoutMs: number
  outputBytes: number
  filesBytes: number
  memoryBytes: number
  cpus: number
} {
  return {
    timeoutMs: Math.min(timeoutMs ?? 5 * 60_000, 30 * 60_000),
    outputBytes,
    filesBytes: 512 * 1024 * 1024,
    memoryBytes: 4 * 1024 * 1024 * 1024,
    cpus: 2,
  }
}

function imageIdentity(engine: 'gem5' | 'llvm-mca' | 'champsim'): { reference: string; digest: string } {
  const lockPath = [resolve(repositoryRoot, 'external/images.lock.json'), resolve(repositoryRoot, '../external/images.lock.json')]
    .find(existsSync)
  if (!lockPath) throw new Error('external image lock is missing')
  const lockBytes = readFileSync(lockPath)
  const lock = JSON.parse(lockBytes.toString('utf8')) as {
    images?: Record<string, { reference?: string; imageId?: string }>
  }
  const capabilityPath = resolve(lockPath, '../capabilities.lock.json')
  if (!existsSync(capabilityPath)) throw new Error('external capability lock is missing')
  const capability = JSON.parse(readFileSync(capabilityPath, 'utf8')) as { imagesLockSha256?: string }
  if (capability.imagesLockSha256 !== digest(lockBytes)) throw new Error('external capability lock is stale')
  const entry = lock.images?.[engine]
  if (!entry?.reference || !entry.imageId?.match(/^sha256:[a-f0-9]{64}$/)) {
    throw new Error(`locked ${engine} image identity is missing`)
  }
  const local = execFileSync('docker', ['image', 'inspect', entry.reference, '--format', '{{.Id}}'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
  if (local !== entry.imageId) throw new Error(`local ${engine} image differs from lock`)
  return { reference: entry.reference, digest: entry.imageId }
}

function readStoredArtifact(id: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid artifact ID')
  const path = resolve(dataDir, 'artifacts', id.slice(0, 2), id)
  const bytes = readFileSync(path)
  if (digest(bytes) !== id) throw new Error('stored artifact hash mismatch')
  return bytes
}

function manifestArtifactId(value: unknown): string {
  const id = (value as { input?: { manifestArtifactId?: unknown } }).input?.manifestArtifactId
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
    throw new Error('ChampSim requires a validated manifestArtifactId')
  }
  return id
}

function semanticIdentity(record: Record<string, unknown>): string {
  return digest(JSON.stringify({
    corpusVersion: record.corpusVersion,
    workloadVersion: record.workloadVersion,
    workload: record.workload,
    n: record.n,
    seed: record.seed,
    sourceSha256: record.sourceSha256,
  }))
}

function assertRun(result: {
  kind: string
  exitCode: number | null
  stderr: string
  truncated: boolean
}, tool: string): void {
  if (result.kind !== 'exited' || result.exitCode !== 0 || result.truncated) {
    throw new Error(`${tool} failed (${result.kind}, exit ${result.exitCode}): ${result.stderr.slice(-8192)}`)
  }
}

function artifact(filename: string, mimeType: string, bytes: Buffer): string {
  const id = digest(bytes)
  parentPort!.postMessage({ type: 'artifact', filename, mimeType, bytes })
  return id
}

function progress(ratio: number, phase: string, detail: string): void {
  parentPort!.postMessage({ type: 'progress', progress: { ratio, phase, detail } })
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
