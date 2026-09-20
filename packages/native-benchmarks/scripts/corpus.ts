import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cp, mkdir, mkdtemp, readFile, rename, rm, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import {
  expectedRaw, loadManifest, parseV1Frame, sourceSha256, validateEligibility,
  type CorpusWorkload, type EligibilityRecord,
} from '../src/index.ts'

interface Target {
  image: string
  triple: string
  flags: string[]
  linker: string
  runtime: string
  executorImage: string
  executor: string[]
  tier: 'execute'
  linkImage?: string
  smallN?: boolean
}

interface TargetsFile {
  schemaVersion: 1
  imagesLock: string
  targets: Record<string, Target>
}

interface ImagesLock {
  schemaVersion: 1
  images: Record<string, { reference: string; imageId: string; selfTest: unknown }>
}

interface BuildEvidence extends EligibilityRecord {
  corpusVersion: string
  workloadVersion: number
  n: number
  seed: number
  family: string
  sourceDateEpoch: number
  sourceSha256: string
  image: { build: string; execute: string; link?: string }
  compiler: string
  triple: string
  flags: string[]
  linker: string
  runtime: string
  commands: string[][]
  hashes: Record<string, string>
  timings: { diagnosticOnly: true; totalWallClockMs: number }
  artifactDirectory?: string
}

const packageRoot = resolve(import.meta.dirname, '..')
const root = resolve(packageRoot, '..', '..')
const dataRoot = resolve(root, '.isa-bench-data', 'native-corpus')
const manifest = loadManifest(resolve(packageRoot, 'manifest.json'))
const targetsFile = JSON.parse(await readFile(resolve(packageRoot, 'targets.json'), 'utf8')) as TargetsFile
const imagesLock = JSON.parse(
  await readFile(resolve(packageRoot, targetsFile.imagesLock), 'utf8'),
) as ImagesLock
const command = process.argv[2] ?? 'list'
const values = process.argv.slice(3)

if (command === 'doctor') print(await doctor())
else if (command === 'list') print(await list())
else if (command === 'build') print(await buildMatrix(values))
else if (command === 'verify') print(await buildMatrix(values))
else throw new Error(`unknown corpus command: ${command}`)

async function doctor(): Promise<unknown> {
  const checks: Record<string, unknown> = {}
  const sourcePath = resolve(packageRoot, manifest.source.path)
  const actualSource = sourceSha256(sourcePath)
  if (actualSource !== manifest.source.sha256) throw new Error('native core source SHA does not match manifest')
  for (const [name, image] of Object.entries(imagesLock.images)) {
    const installed = (await captureText('docker', ['image', 'inspect', image.reference, '--format', '{{.Id}}'])).trim()
    if (installed !== image.imageId) throw new Error(`${name} image identity differs from pinned lock`)
    checks[name] = { reference: image.reference, imageId: installed, pinned: true }
  }
  return {
    schemaVersion: 1,
    corpusVersion: manifest.corpusVersion,
    source: { path: manifest.source.path, sha256: actualSource, matched: true },
    imagesLockSha256: sha(await readFile(resolve(packageRoot, targetsFile.imagesLock))),
    images: checks,
    targetCount: Object.keys(targetsFile.targets).length,
    workloadCount: manifest.workloads.length,
  }
}

async function list(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(dataRoot, 'artifact-index.json'), 'utf8')) as unknown
  } catch {
    return {
      schemaVersion: 1,
      corpusVersion: manifest.corpusVersion,
      records: [],
      message: 'no observed corpus index; run corpus build',
    }
  }
}

async function buildMatrix(args: string[]): Promise<unknown> {
  await doctor()
  const full = args.includes('--full')
  const requestedTarget = option(args, '--target')
  const requestedWorkload = option(args, '--workload')
  const targetNames = requestedTarget
    ? [requestedTarget]
    : full
      ? Object.keys(targetsFile.targets)
      : ['x86_64-linux', 'wasm32-wasip1', 'mos-sim']
  const workloads = requestedWorkload
    ? manifest.workloads.filter((item) => item.id === requestedWorkload)
    : manifest.workloads
  if (workloads.length === 0) throw new Error(`unknown workload ${requestedWorkload}`)
  for (const target of targetNames) if (!targetsFile.targets[target]) throw new Error(`unknown target ${target}`)

  const started = performance.now()
  const records: BuildEvidence[] = []
  for (const targetName of targetNames) {
    const target = targetsFile.targets[targetName]!
    for (const workload of workloads) {
      process.stderr.write(`native-corpus ${targetName}/${workload.id}\n`)
      const unsupported = unsupportedReason(targetName, workload)
      if (unsupported) {
        const record: BuildEvidence = {
          corpusVersion: manifest.corpusVersion,
          workloadVersion: workload.version,
          workload: workload.id,
          target: targetName,
          n: workload.n.default,
          seed: workload.seed.default,
          family: workload.family,
          eligible: false,
          reason: unsupported,
          sourceDateEpoch: manifest.sourceDateEpoch,
          sourceSha256: manifest.source.sha256,
          image: {
            build: image(target.image).imageId,
            execute: image(target.executorImage).imageId,
          },
          compiler: 'not built',
          triple: target.triple,
          flags: target.flags,
          linker: target.linker,
          runtime: target.runtime,
          commands: [],
          hashes: {},
          timings: { diagnosticOnly: true, totalWallClockMs: 0 },
        }
        validateEligibility(record)
        records.push(record)
        continue
      }
      records.push(await buildOne(targetName, target, workload))
    }
  }
  const eligible = records.filter((record) => record.eligible).length
  const report = {
    schemaVersion: 1,
    corpusVersion: manifest.corpusVersion,
    generatedAt: new Date().toISOString(),
    timingClaim: 'none; all wall-clock durations are pipeline diagnostics only',
    mode: full ? 'full' : 'smoke',
    targetTiers: Object.fromEntries(targetNames.map((name) => [name, targetsFile.targets[name]!.tier])),
    counts: { eligible, ineligible: records.length - eligible, total: records.length },
    totalWallClockMs: performance.now() - started,
    records,
  }
  await atomicJson(resolve(dataRoot, 'artifact-index.json'), report)
  await atomicJson(resolve(dataRoot, 'eligibility-manifest.json'), {
    schemaVersion: 1,
    corpusVersion: manifest.corpusVersion,
    records: records.map(({ workload, target, eligible, reason, artifactDirectory }) => ({
      workload, target, eligible, ...(reason ? { reason } : {}),
      ...(artifactDirectory ? { artifactDirectory } : {}),
    })),
  })
  return report
}

async function buildOne(targetName: string, target: Target, workload: CorpusWorkload): Promise<BuildEvidence> {
  const started = performance.now()
  const n = target.smallN
    ? Math.min(workload.n.default, 'maxN' in workload.targets.mos ? workload.targets.mos.maxN : workload.n.default)
    : workload.n.default
  const seed = workload.seed.default
  const first = await cleanBuild(targetName, target, workload, n, seed)
  const second = await cleanBuild(targetName, target, workload, n, seed)
  try {
    for (const name of ['core', 'adapter', 'runtime', 'binary', 'metadata', 'disassembly', 'symbols'] as const) {
      if (first.hashes[name] !== second.hashes[name]) throw new Error(`clean ${name} artifact hashes differ`)
    }
    const frameBytes = await executeArtifact(targetName, target, second.directory, second.binaryName)
    const frame = parseV1Frame(frameBytes)
    const expected = expectedRaw(workload.id, n, seed)
    if (frame.rawBits !== expected || frame.kind !== (workload.id === 'fp_sum' ? 'binary64' : 'i32')) {
      throw new Error(`result rejected: got ${frame.kind}/0x${frame.rawBits.toString(16)}, expected 0x${expected.toString(16)}`)
    }
    const disassembly = await readFile(resolve(second.directory, 'disassembly.txt'))
    const text = disassembly.toString('utf8')
    if (!text.includes('isa_bench_roi_begin') || !text.includes('isa_bench_roi_end') ||
        !text.includes('isa_bench_core') || !text.includes('isa_bench_inner_iteration')) {
      throw new Error('complete disassembly lacks required ROI/core/harness markers')
    }
    const metadata = await readFile(resolve(second.directory, 'metadata.txt'))
    const binary = await readFile(resolve(second.directory, second.binaryName))
    const coreBytes = parseCoreBytes(await readFile(resolve(second.directory, 'symbols.txt'), 'utf8'))
    const roiDescriptor = {
      schemaVersion: 1 as const,
      symbol: 'isa_bench_core' as const,
      markerBegin: 'isa_bench_roi_begin' as const,
      markerEnd: 'isa_bench_roi_end' as const,
      staticAnalysisScope: 'core-symbol-only' as const,
      executionScope: 'whole-process-static-binary' as const,
      coreObjectSha256: second.hashes.core,
    }
    const roiHash = sha(Buffer.from(canonicalJson(roiDescriptor)))
    const artifactKey = sha(Buffer.from(
      `${manifest.source.sha256}\0${workload.id}\0${targetName}\0${second.hashes.core}\0${second.hashes.binary}`,
    ))
    const artifactDirectory = resolve(dataRoot, 'artifacts', artifactKey)
    await mkdir(artifactDirectory, { recursive: true })
    for (const name of ['core.o', 'adapter.o', 'runtime.o', second.binaryName, 'metadata.txt', 'disassembly.txt', 'symbols.txt']) {
      await copyImmutable(resolve(second.directory, name), resolve(artifactDirectory, name))
    }
    const compiler = await compilerVersion(target)
    const record: BuildEvidence = {
      corpusVersion: manifest.corpusVersion,
      workloadVersion: workload.version,
      workload: workload.id,
      target: targetName,
      n,
      seed,
      family: workload.family,
      eligible: true,
      sourceDateEpoch: manifest.sourceDateEpoch,
      sourceSha256: manifest.source.sha256,
      image: {
        build: image(target.image).imageId,
        execute: image(target.executorImage).imageId,
        ...(target.linkImage ? { link: image(target.linkImage).imageId } : {}),
      },
      compiler,
      triple: target.triple,
      flags: target.flags,
      linker: target.linker,
      runtime: target.runtime,
      commands: [
        ...second.commands,
        [image(target.executorImage).imageId, ...target.executor.map((part) =>
          part === '{binary}' ? second.binaryName : part
        )],
      ],
      hashes: {
        coreObject: second.hashes.core,
        adapterObject: second.hashes.adapter,
        runtimeObject: second.hashes.runtime,
        binary: second.hashes.binary,
        metadata: sha(metadata),
        disassembly: sha(disassembly),
        frame: sha(frameBytes),
      },
      coreObjectSha256: second.hashes.core,
      binarySha256: second.hashes.binary,
      metadataSha256: sha(metadata),
      disassemblySha256: sha(disassembly),
      roiHash,
      roiDescriptor,
      coreBytes,
      totalBytes: binary.byteLength,
      semanticExecution: {
        frameVersion: 1,
        rawBits: `0x${frame.rawBits.toString(16).padStart(16, '0')}`,
        matchedOracle: true,
      },
      reproducibility: {
        cleanBuilds: 2,
        objectIdentical: true,
        binaryIdentical: true,
        retainedArtifactsIdentical: true,
        normalizedExclusions: [],
      },
      timings: { diagnosticOnly: true, totalWallClockMs: performance.now() - started },
      artifactDirectory: artifactDirectory.slice(root.length + 1).replaceAll('\\', '/'),
    }
    validateEligibility(record)
    await atomicJson(resolve(artifactDirectory, 'record.json'), record)
    return record
  } catch (error) {
    if (process.env.ISA_NATIVE_KEEP_FAILED === '1') {
      const debug = resolve(dataRoot, 'failed-build')
      await rm(debug, { recursive: true, force: true })
      await cp(second.directory, debug, { recursive: true })
    }
    throw error
  } finally {
    await Promise.all([
      rm(first.directory, { recursive: true, force: true }),
      rm(second.directory, { recursive: true, force: true }),
    ])
  }
}

async function cleanBuild(
  targetName: string,
  target: Target,
  workload: CorpusWorkload,
  n: number,
  seed: number,
): Promise<{
  directory: string
  binaryName: string
  commands: string[][]
  hashes: {
    core: string
    adapter: string
    runtime: string
    binary: string
    metadata: string
    disassembly: string
    symbols: string
  }
}> {
  const directory = await mkdtemp(join(tmpdir(), 'isa-native-corpus-'))
  const binaryName = targetName === 'wasm32-wasip1' ? 'benchmark.wasm' : 'benchmark.bin'
  await cp(resolve(packageRoot, 'native', 'core.c'), resolve(directory, 'core.c'))
  await cp(resolve(packageRoot, 'native', 'adapter.c'), resolve(directory, 'adapter.c'))
  await cp(resolve(packageRoot, target.runtime), resolve(directory, 'runtime.c'))
  const defines = [`-DBENCH_WORKLOAD=${workload.selector}`, `-DBENCH_N=${n}`, `-DBENCH_SEED=${seed}`]
  const common = [
    '-O2', '-ffreestanding', '-fno-builtin', '-fno-strict-aliasing', '-fno-fast-math',
    '-ffp-contract=off', '-fno-vectorize', '-fno-slp-vectorize', '-fno-common',
    '-fno-stack-protector', '-fno-lto', '-ffunction-sections', '-fdata-sections', '-g0', ...defines,
  ]
  const commands: string[][] = []
  if (targetName === 'mos-sim') {
    for (const [source, output] of [['core.c', 'core.o'], ['adapter.c', 'adapter.o'], ['runtime.c', 'runtime.o']] as const) {
      await docker(target.image, ['mos-sim-clang', ...common, '-c', `/artifacts/${source}`, '-o', `/artifacts/${output}`], directory, commands)
    }
    await docker(target.image, [
      'mos-sim-clang', '/artifacts/core.o', '/artifacts/adapter.o', '/artifacts/runtime.o',
      '-Wl,--gc-sections', '-o', `/artifacts/${binaryName}`,
    ], directory, commands)
  } else {
    const compiler = ['clang', '-target', target.triple, ...target.flags]
    for (const [source, output] of [['core.c', 'core.o'], ['adapter.c', 'adapter.o'], ['runtime.c', 'runtime.o']] as const) {
      const runtimeFlags = source === 'runtime.c'
        ? targetName === 'wasm32-wasip1'
          ? []
          : ['-O0', '-ffreestanding', '-fno-builtin', '-fno-stack-protector', '-g0']
        : common
      await docker(target.image, [...compiler, ...runtimeFlags, '-c', `/artifacts/${source}`, '-o', `/artifacts/${output}`], directory, commands)
    }
    if (targetName === 'sparc-v8') {
      await docker(target.linkImage!, [
        'sparc64-linux-gnu-ld', '-m', 'elf32_sparc', '-static', '-e', '_start', '--gc-sections',
        '/artifacts/core.o', '/artifacts/adapter.o', '/artifacts/runtime.o', '-o', `/artifacts/${binaryName}`,
      ], directory, commands)
    } else if (targetName === 'wasm32-wasip1') {
      await docker(target.image, [
        'clang', '/artifacts/core.o', '/artifacts/adapter.o', '/artifacts/runtime.o',
        '-Wl,--gc-sections', '-o', `/artifacts/${binaryName}`,
      ], directory, commands)
    } else {
      await docker(target.image, [
        ...compiler, '-fuse-ld=lld', '-nostdlib', '-static', '-Wl,-e,_start', '-Wl,--gc-sections',
        '/artifacts/core.o', '/artifacts/adapter.o', '/artifacts/runtime.o', '-o', `/artifacts/${binaryName}`,
      ], directory, commands)
    }
  }
  if (targetName === 'mos-sim') {
    const metadata: Buffer[] = []
    const disassembly: Buffer[] = []
    for (const object of ['core.o', 'adapter.o', 'runtime.o']) {
      metadata.push(await dockerCapture(target.image, ['llvm-readobj', '--all', `/artifacts/${object}`], directory, commands))
      disassembly.push(await dockerCapture(target.image, [
        'llvm-objdump', '--disassemble', '--section-headers', '--syms', `/artifacts/${object}`,
      ], directory, commands))
    }
    await writeFile(resolve(directory, 'metadata.txt'), Buffer.concat(metadata))
    await writeFile(resolve(directory, 'disassembly.txt'), Buffer.concat(disassembly))
    await docker(target.image, ['llvm-nm', '--print-size', '--size-sort', '/artifacts/core.o'], directory, commands, 'symbols.txt')
  } else {
    const inspectionImage = targetName === 'wasm32-wasip1' ? 'codegen' : target.image
    const prefix = ''
    if (targetName === 'wasm32-wasip1') {
      await docker(inspectionImage, [
        'llvm-readobj', '--file-headers', '--sections', '--symbols', `/artifacts/${binaryName}`,
      ], directory, commands, 'metadata.txt')
    } else {
      await docker(inspectionImage, ['llvm-readobj', '--all', `/artifacts/${binaryName}`], directory, commands, 'metadata.txt')
    }
    await docker(inspectionImage, [
      `${prefix}llvm-objdump`, '--disassemble', '--section-headers', '--syms', `/artifacts/${binaryName}`,
    ], directory, commands, 'disassembly.txt')
    await docker(inspectionImage, [
      `${prefix}llvm-nm`, '--print-size', '--size-sort', '/artifacts/core.o',
    ], directory, commands, 'symbols.txt')
  }
  return {
    directory,
    binaryName,
    commands,
    hashes: {
      core: sha(await readFile(resolve(directory, 'core.o'))),
      adapter: sha(await readFile(resolve(directory, 'adapter.o'))),
      runtime: sha(await readFile(resolve(directory, 'runtime.o'))),
      binary: sha(await readFile(resolve(directory, binaryName))),
      metadata: sha(await readFile(resolve(directory, 'metadata.txt'))),
      disassembly: sha(await readFile(resolve(directory, 'disassembly.txt'))),
      symbols: sha(await readFile(resolve(directory, 'symbols.txt'))),
    },
  }
}

async function executeArtifact(targetName: string, target: Target, directory: string, binaryName: string): Promise<Buffer> {
  const command = target.executor.map((part) => part === '{binary}' ? `/artifacts/${binaryName}` : part)
  return dockerBytes(target.executorImage, command, directory, targetName)
}

async function docker(
  imageName: string,
  argv: string[],
  directory: string,
  commands: string[][],
  output?: string,
): Promise<void> {
  commands.push([image(imageName).imageId, ...argv])
  const bytes = await dockerBytes(imageName, argv, directory)
  if (output) await writeFile(resolve(directory, output), bytes)
}

async function dockerCapture(
  imageName: string,
  argv: string[],
  directory: string,
  commands: string[][],
): Promise<Buffer> {
  commands.push([image(imageName).imageId, ...argv])
  return dockerBytes(imageName, argv, directory)
}

async function dockerBytes(imageName: string, argv: string[], directory: string, label = 'build'): Promise<Buffer> {
  const args = [
    'run', '--rm', '--name', `isa-native-${label.replaceAll(/[^A-Za-z0-9_.-]/g, '-')}-${randomUUID()}`,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '128',
    '--memory', '1g', '--cpus', '2', '--user', '65532:65532',
    '--env', `SOURCE_DATE_EPOCH=${manifest.sourceDateEpoch}`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864',
    '--mount', `type=bind,src=${directory},dst=/artifacts`,
    image(imageName).imageId, ...argv,
  ]
  try {
    return await capture('docker', args, 60_000)
  } catch (error) {
    throw new Error(`${imageName} command failed (${argv.join(' ')}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

function unsupportedReason(targetName: string, workload: CorpusWorkload): string | undefined {
  if (targetName !== 'mos-sim') return undefined
  const mos = workload.targets.mos
  return 'supported' in mos && mos.supported === false ? mos.reason : undefined
}

function image(name: string): ImagesLock['images'][string] {
  const value = imagesLock.images[name]
  if (!value) throw new Error(`image ${name} is absent from pinned lock`)
  return value
}

async function compilerVersion(target: Target): Promise<string> {
  const compiler = target.smallN ? 'mos-sim-clang' : 'clang'
  const directory = await mkdtemp(join(tmpdir(), 'isa-version-'))
  try {
    return (await dockerBytes(target.image, [compiler, '--version'], directory))
      .toString('utf8').split(/\r?\n/, 1)[0] ?? 'unknown'
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function parseCoreBytes(symbols: string): number {
  const line = symbols.split(/\r?\n/).find((candidate) => candidate.trim().endsWith(' isa_bench_core'))
  const fields = line?.trim().split(/\s+/)
  const size = fields?.[1]
  if (!size || !/^[a-fA-F0-9]+$/.test(size)) throw new Error('core symbol size is unavailable')
  const value = Number.parseInt(size, 16)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('core symbol size is invalid')
  return value
}

async function copyImmutable(source: string, destination: string): Promise<void> {
  try {
    const [existing, incoming] = await Promise.all([readFile(destination), readFile(source)])
    if (!existing.equals(incoming)) throw new Error(`immutable artifact collision: ${destination}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await cp(source, destination, { errorOnExist: true })
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await rename(temp, path)
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function captureText(program: string, args: string[]): Promise<string> {
  return capture(program, args).then((bytes) => bytes.toString('utf8'))
}

function capture(program: string, args: string[], timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, shell: false, windowsHide: true, stdio: 'pipe' })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(Buffer.concat(stdout))
      else reject(new Error(`${program} exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-8192)}`))
    })
  })
}

