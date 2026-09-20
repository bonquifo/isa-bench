import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..', '..')
const manifestBytes = await readFile(resolve(root, 'external/manifest.json'))
const manifest = JSON.parse(manifestBytes)
let runtimeImageIds = {}
// The server's own gem5/llvm-mca validation, loaded from the built module so
// the probe and the job worker cannot drift apart.
let shared
const command = process.argv[2] ?? 'doctor'

validateManifest()
if (command === 'build') await build()
else if (command === 'doctor') await doctor()
else if (command === 'test') await smoke()
else if (command === 'verify') {
  await doctor()
  await smoke()
} else throw new Error(`unknown external command ${command}`)

async function build() {
  const started = performance.now()
  await dockerBuild('gem5', 'external/docker/Dockerfile.gem5')
  await dockerBuild('champsim', 'external/docker/Dockerfile.champsim')
  const first = await identities()
  await dockerBuild('gem5', 'external/docker/Dockerfile.gem5')
  await dockerBuild('champsim', 'external/docker/Dockerfile.champsim')
  const second = await identities()
  for (const name of ['gem5', 'champsim']) {
    if (first[name].imageId !== second[name].imageId) {
      throw new Error(`${name} image was not identical across two deterministic configuration builds`)
    }
  }
  const lock = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceManifestSha256: sha(manifestBytes),
    deterministicConfigBuilds: 2,
    normalizedExclusions: ['BuildKit wall-clock progress diagnostics'],
    buildWallClockMs: Math.round((performance.now() - started) * 1000) / 1000,
    images: second,
  }
  await writeJson('external/images.lock.json', lock)
  process.stdout.write(`${JSON.stringify(lock, null, 2)}\n`)
}

async function doctor() {
  const lock = JSON.parse(await readFile(resolve(root, 'external/images.lock.json'), 'utf8'))
  runtimeImageIds = Object.fromEntries(Object.entries(lock.images ?? {}).map(([name, value]) => [name, value.imageId]))
  if (lock.sourceManifestSha256 !== sha(manifestBytes)) {
    throw new Error('external images lock is stale relative to manifest.json')
  }
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    runtime: manifest.runtime,
    images: {},
  }
  for (const [name, reference] of Object.entries(manifest.images)) {
    const id = (await capture('docker', ['image', 'inspect', reference, '--format', '{{.Id}}'])).trim()
    const expected = lock.images?.[name]?.imageId
    if (id !== expected) throw new Error(`${name} local image ${id} differs from lock ${expected}`)
    const selfTest = JSON.parse(await capture('docker', hardened(expected, ['self-test'])))
    report.images[name] = { reference, imageId: id, selfTest }
  }
  await output('doctor.json', report)
}

async function smoke() {
  const smokeRoot = resolve(root, '.isa-bench-data/external-smoke')
  await rm(smokeRoot, { recursive: true, force: true })
  await mkdir(smokeRoot, { recursive: true })
  const corpus = JSON.parse(await readFile(resolve(root, '.isa-bench-data/native-corpus/artifact-index.json'), 'utf8'))
  const observations = {}
  const imageLockJson = JSON.parse(await readFile(resolve(root, 'external/images.lock.json'), 'utf8'))
  runtimeImageIds = Object.fromEntries(Object.entries(imageLockJson.images ?? {}).map(([name, value]) => [name, value.imageId]))
  shared = await loadShared()
  const targets = ['x86_64-linux', 'aarch64-linux', 'riscv64-linux', 'mipsel-o32', 'powerpc64le-elfv2', 'sparc-v8']

  for (const target of targets) {
    const record = corpus.records.find((candidate) => candidate.eligible && candidate.target === target)
    if (!record) {
      observations[`gem5:${target}`] = unsupported('no eligible native corpus artifact exists')
      observations[`llvm-mca:${target}`] = unsupported('no eligible native corpus artifact exists')
      continue
    }
    const artifactDirectory = resolve(root, record.artifactDirectory)
    observations[`gem5:${target}`] = await gem5Probe(target, artifactDirectory, smokeRoot)
    observations[`llvm-mca:${target}`] = await mcaProbe(target, artifactDirectory, smokeRoot)
  }
  for (const target of ['wasm32-wasip1', 'mos-sim']) {
    observations[`gem5:${target}`] = unsupported('WASM and MOS are explicitly unsupported by the gem5 adapter')
    observations[`llvm-mca:${target}`] = unsupported('WASM and MOS are explicitly unsupported by the llvm-mca adapter')
  }
  observations['champsim:x86_64-linux'] = unsupported(
    'import-only: no locked first-party dynamic x86 trace producer is allowlisted; fabricated direct input_instr records are not execution evidence',
  )
  for (const target of targets.slice(1).concat(['wasm32-wasip1', 'mos-sim'])) {
    observations[`champsim:${target}`] = unsupported('no exact validated microtrace-v1 producer/register mapping exists for this ISA')
  }

  const imageLock = await readFile(resolve(root, 'external/images.lock.json'))
  const lock = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    imagesLockSha256: sha(imageLock),
    semantics: await semanticHashes(),
    observations,
  }
  await writeJson('external/capabilities.lock.json', lock)
  await output('smoke.json', lock)
}

async function gem5Probe(target, source, smokeRoot) {
  // Only targets the job worker can actually run are probed, with the worker's
  // own invocation and validation, so a lock never advertises a tier the
  // production path would refuse. Non-ISA-aware targets are unsupported for the
  // same reason the worker rejects them, instead of being smoke-tested through
  // gem5's deprecated se.py which the worker never uses.
  const requiredIsa = {
    'x86_64-linux': 'x86_64',
    'aarch64-linux': 'aarch64',
    'riscv64-linux': 'riscv64',
  }[target]
  if (!requiredIsa) return unsupported(`gem5 target ${target} has no validated ISA-aware configuration`)
  const directory = resolve(smokeRoot, `gem5-${target}`)
  await mkdir(resolve(directory, 'out'), { recursive: true })
  await copyFile(resolve(source, 'benchmark.bin'), resolve(directory, 'benchmark.bin'))
  await copyFile(resolve(root, 'external/config/gem5-se.py'), resolve(directory, 'gem5-se.py'))
  const listing = await execute('docker', hardened(runtimeImageIds['llvm-mca'], ['llvm-nm', '/artifacts/benchmark.bin'], directory), true)
  if (listing.code !== 0) return unsupported(`llvm-nm failed: ${bounded(listing.stderr)}`)
  let markers
  try {
    markers = shared.parseRoiMarkers(listing.stdout)
  } catch (error) {
    return unsupported(error instanceof Error ? error.message : String(error))
  }
  const argv = [
    'gem5.opt', '--outdir=/artifacts/out', '/artifacts/gem5-se.py',
    `--isa=${requiredIsa}`, '--binary=/artifacts/benchmark.bin',
    `--roi-begin=${markers.begin}`, `--roi-end=${markers.end}`,
  ]
  const result = await execute('docker', hardened(runtimeImageIds.gem5, argv, directory), true, 15 * 60_000)
  if (result.code !== 0) return unsupported(`O3+SE binary smoke failed: ${bounded(result.stderr || result.stdout)}`)
  try {
    const stats = await readFile(resolve(directory, 'out/stats.txt'), 'utf8')
    const configText = await readFile(resolve(directory, 'out/config.json'), 'utf8')
    shared.validateGem5Config(configText, requiredIsa)
    const parsed = shared.parseGem5Stats(stats)
    const value = (name) => {
      const metric = parsed.metrics.find((item) => item.name === name)
      if (!metric) throw new Error(`missing ${name}`)
      return metric.value
    }
    return {
      tier: 'execute',
      reason: `exact execution-driven ${requiredIsa} O3 syscall-emulation smoke passed with eligible static native corpus binary, validated emitted config, and required stats`,
      command: argv,
      isa: requiredIsa,
      roi: markers,
      metrics: {
        simTicks: value('simulated_ticks'),
        simInsts: value('committed_instructions'),
        simOps: value('committed_ops'),
        cycles: value('simulated_cycles'),
        ipc: value('ipc'),
      },
      binarySha256: sha(await readFile(resolve(directory, 'benchmark.bin'))),
      statsSha256: sha(Buffer.from(stats)),
      configSha256: sha(Buffer.from(configText)),
    }
  } catch (error) {
    return unsupported(`gem5 emitted output failed the worker's validation: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function mcaProbe(target, source, smokeRoot) {
  const descriptor = {
    'x86_64-linux': ['x86_64-unknown-linux-gnu', 'x86-64', ''],
    'aarch64-linux': ['aarch64-unknown-linux-gnu', 'generic', ''],
    'riscv64-linux': ['riscv64-unknown-linux-gnu', 'generic-rv64', '+m,+a,+f,+d,+c'],
    'mipsel-o32': ['mipsel-unknown-linux-gnu', 'mips32', ''],
    'powerpc64le-elfv2': ['powerpc64le-unknown-linux-gnu', 'ppc64le', ''],
    'sparc-v8': ['sparc-unknown-linux-gnu', 'v8', ''],
  }[target]
  const directory = resolve(smokeRoot, `mca-${target}`)
  await mkdir(directory, { recursive: true })
  await copyFile(resolve(source, 'core.o'), resolve(directory, 'core.o'))
  const dump = await execute('docker', hardened(runtimeImageIds['llvm-mca'], [
    'llvm-objdump', '--disassemble-symbols=isa_bench_core', '--no-show-raw-insn',
    '--no-leading-addr', '/artifacts/core.o',
  ], directory), true)
  if (dump.code !== 0) return unsupported('native object did not fully disassemble')
  // The ROI extraction and the JSON acceptance rules are the worker's own, so an
  // `execute` tier here means the production path parses this exact region.
  let assembly
  try {
    assembly = shared.assemblerRegion(dump.stdout)
  } catch (error) {
    return unsupported(error instanceof Error ? error.message : String(error))
  }
  await writeFile(resolve(directory, 'roi.s'), assembly)
  const argv = [
    'llvm-mca', '--json', `--mtriple=${descriptor[0]}`, `--mcpu=${descriptor[1]}`,
    `--mattr=${descriptor[2]}`, '--iterations=100', '/artifacts/roi.s',
  ]
  const result = await execute('docker', hardened(runtimeImageIds['llvm-mca'], argv, directory), true)
  if (result.code !== 0) return unsupported(`llvm-mca failed: ${bounded(result.stderr)}`)
  try {
    const parsed = shared.parseLlvmMcaJson(result.stdout)
    const value = (name) => {
      const metric = parsed.metrics.find((item) => item.name === name)
      if (!metric) throw new Error(`missing ${name}`)
      return metric.value
    }
    return {
      tier: 'execute',
      reason: 'assembler-compatible native ROI fully parsed with a valid LLVM 23.1 scheduling model and required JSON fields',
      command: argv,
      objectSha256: sha(await readFile(resolve(directory, 'core.o'))),
      regionSha256: sha(Buffer.from(assembly)),
      rawSha256: sha(Buffer.from(result.stdout)),
      target: { triple: descriptor[0], cpu: descriptor[1], features: descriptor[2] },
      metrics: {
        iterations: value('iterations'),
        instructions: value('instructions'),
        totalCycles: value('total_cycles'),
        totalUOps: value('total_uops'),
        blockReciprocalThroughput: value('block_reciprocal_throughput'),
        resourcePressure: value('resource_pressure'),
      },
    }
  } catch (error) {
    return unsupported(`llvm-mca output failed the worker's validation: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function loadShared() {
  const built = resolve(root, 'server/dist/external.js')
  let module
  try {
    module = await import(pathToFileURL(built).href)
  } catch (error) {
    throw new Error(`capability probe needs the built server module at ${built} (run \`npm run build -w @isa-sim/server\`): ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const name of ['assemblerRegion', 'parseGem5Stats', 'parseLlvmMcaJson', 'parseRoiMarkers', 'validateGem5Config']) {
    if (typeof module[name] !== 'function') throw new Error(`built server module does not export ${name}`)
  }
  return module
}

async function semanticHashes() {
  const paths = [
    'external/manifest.json',
    'external/scripts/external.mjs',
    'external/config/gem5-se.py',
    'server/src/external.ts',
    'server/src/external-worker.ts',
    'server/src/sandbox.ts',
    'server/src/runner.ts',
    'packages/contracts/src/index.ts',
    'packages/native-benchmarks/manifest.json',
    '.isa-bench-data/native-corpus/artifact-index.json',
  ]
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    sha(await readFile(resolve(root, path))),
  ])))
}

async function dockerBuild(name, dockerfile) {
  await run('docker', [
    'build', '--pull=false', '--provenance=false',
    '--build-arg', `SOURCE_DATE_EPOCH=${manifest.sourceDateEpoch}`,
    '--file', resolve(root, dockerfile),
    '--tag', manifest.images[name], root,
  ])
}

async function identities() {
  const result = {}
  for (const [name, reference] of Object.entries(manifest.images)) {
    const imageId = (await capture('docker', ['image', 'inspect', reference, '--format', '{{.Id}}'])).trim()
    const repoDigests = JSON.parse(await capture('docker', ['image', 'inspect', reference, '--format', '{{json .RepoDigests}}']))
    const selfTest = JSON.parse(await capture('docker', hardened(reference, ['self-test'])))
    result[name] = { reference, imageId, repoDigests, selfTest }
  }
  return result
}

function hardened(image, argv, mount = resolve(root, '.isa-bench-data/external-smoke')) {
  return [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '256',
    '--memory', '4g', '--cpus', '2', '--user', '65532:65532',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=134217728',
    '--mount', `type=bind,src=${mount},dst=/artifacts`,
    image, ...argv,
  ]
}

function unsupported(reason) {
  return { tier: 'unsupported', reason }
}

function validateManifest() {
  if (manifest.schemaVersion !== 1 || !String(manifest.baseImage.reference).includes('@sha256:')) {
    throw new Error('external manifest requires an immutable base')
  }
  for (const source of Object.values(manifest.sources)) {
    if (source.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('invalid source checksum')
  }
}

async function output(name, value) {
  await writeJson(`.isa-bench-data/external/${name}`, value)
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function writeJson(path, value) {
  const destination = resolve(root, path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`)
}

function bounded(value) {
  return String(value).slice(-8192)
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex')
}

function capture(program, args) {
  return execute(program, args, true).then((result) => {
    if (result.code !== 0) throw new Error(`${program} exited ${result.code}: ${bounded(result.stderr)}`)
    return result.stdout
  })
}

function run(program, args) {
  return execute(program, args, false, 2 * 60 * 60_000).then((result) => {
    if (result.code !== 0) throw new Error(`${program} exited ${result.code}`)
  })
}

function execute(program, args, collect, timeoutMs = 5 * 60_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, shell: false, stdio: collect ? 'pipe' : 'inherit' })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    if (collect) {
      child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    }
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}
