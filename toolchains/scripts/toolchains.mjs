import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..', '..')
const manifestBytes = await readFile(resolve(root, 'toolchains/manifest.json'))
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const command = process.argv[2] ?? 'doctor'

validateManifest(manifest)

if (command === 'build') await build()
else if (command === 'build-qemu') await buildOne('qemu')
else if (command === 'doctor') await doctor()
else if (command === 'test') await smoke()
else if (command === 'verify') {
  await doctor()
  await smoke()
} else {
  throw new Error(`unknown toolchain command ${command}`)
}

async function build() {
  for (const name of ['codegen', 'qemu', 'sparc', 'wasi', 'mos']) await buildOne(name, false)
  await writeIdentities()
}

async function buildOne(name, writeLock = true) {
  await run('docker', [
    'build', '--pull=false',
    '--file', resolve(root, `toolchains/docker/Dockerfile.${name}`),
    '--tag', manifest.images[name],
    root,
  ])
  if (writeLock) await writeIdentities()
}

async function doctor() {
  await mkdir(resolve(root, '.isa-bench-data/toolchain-smoke'), { recursive: true })
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), images: {}, targets: manifest.targets }
  for (const [name, image] of Object.entries(manifest.images)) {
    const inspect = await capture('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])
    const selfTest = await capture('docker', hardened(image, ['self-test']))
    report.images[name] = { reference: image, digest: inspect.trim(), selfTest: JSON.parse(selfTest) }
  }
  await outputReport('doctor.json', report)
}

async function smoke() {
  const temp = resolve(root, '.isa-bench-data/toolchain-smoke')
  await mkdir(temp, { recursive: true })
  await writeFile(resolve(temp, 'smoke.ll'), [
    'define i32 @smoke() {',
    'entry:',
    '  ret i32 42',
    '}',
    '',
  ].join('\n'))
  const codegenTargets = {
    'x86_64-linux': 'x86_64-unknown-linux-gnu',
    'aarch64-linux': 'aarch64-unknown-linux-gnu',
    'riscv64-linux': 'riscv64-unknown-linux-gnu',
    'mipsel-o32': 'mipsel-unknown-linux-gnu',
    'powerpc64le-elfv2': 'powerpc64le-unknown-linux-gnu',
    'sparc-v8': 'sparc-unknown-linux-gnu',
    'wasm32-wasip1': 'wasm32-wasip1',
  }
  const observations = {}
  for (const [target, triple] of Object.entries(codegenTargets)) {
    const image = target === 'wasm32-wasip1' ? manifest.images.wasi : manifest.images.codegen
    const targetFlags = target === 'sparc-v8'
      ? ['-mcpu=v8']
      : target === 'mipsel-o32'
        ? ['-march=mips32', '-mabi=o32']
        : target === 'riscv64-linux'
          ? ['-march=rv64gc', '-mabi=lp64d']
          : target === 'powerpc64le-elfv2'
            ? ['-mabi=elfv2']
            : []
    const output = `${target}.o`
    const result = await capture('docker', hardened(image, [
      'clang', '-x', 'ir', '-target', triple, ...targetFlags, '-c', '/artifacts/smoke.ll', '-o', `/artifacts/${output}`,
    ], temp))
    const hash = sha(await readFile(resolve(temp, output)))
    const semanticOutput = `${target}.semantic.o`
    await capture('docker', hardened(image, [
      'clang', '-x', 'ir', '-target', triple, ...targetFlags, '-c', '/artifacts/canonical.ll', '-o', `/artifacts/${semanticOutput}`,
    ], temp))
    observations[target] = {
      tier: 'codegen-only',
      objectSha256: hash,
      semanticObjectSha256: sha(await readFile(resolve(temp, semanticOutput))),
      log: result,
    }
  }
  await capture('docker', hardened(manifest.images.codegen, [
    'clang', '-x', 'ir', '-target', 'x86_64-unknown-linux-gnu', '-c',
    '/artifacts/smoke.ll', '-o', '/artifacts/x86_64-linux.second.o',
  ], temp))
  const firstCoreHash = observations['x86_64-linux'].objectSha256
  const secondCoreHash = sha(await readFile(resolve(temp, 'x86_64-linux.second.o')))
  if (firstCoreHash !== secondCoreHash) throw new Error('representative clean object builds are not reproducible')
  observations['x86_64-linux'].reproducibility = {
    builds: 2,
    identical: true,
    sha256: firstCoreHash,
    normalizedExclusions: [],
  }
  await writeFile(resolve(temp, 'x86-exit.ll'), [
    'define void @_start() noreturn {',
    '  call void asm sideeffect "syscall", "{rax},{rdi},~{rcx},~{r11},~{memory}"(i64 60, i64 42)',
    '  unreachable',
    '}',
    '',
  ].join('\n'))
  await capture('docker', hardened(manifest.images.codegen, [
    'clang', '-target', 'x86_64-unknown-linux-gnu', '-fuse-ld=lld', '-nostdlib', '-static',
    '-Wl,-e,_start', '/artifacts/x86-exit.ll', '-o', '/artifacts/x86-exit',
  ], temp))
  const x86Exit = await captureExit('docker', hardened(manifest.images.codegen, ['/artifacts/x86-exit'], temp))
  if (x86Exit !== 42) throw new Error(`x86-64 execution smoke exited ${x86Exit}, expected 42`)
  observations['x86_64-linux'].tier = 'execute'
  observations['x86_64-linux'].reason = 'freestanding static ELF executed in the hardened container'
  await writeFile(
    resolve(temp, 'x86_64-linux.c'),
    await readFile(resolve(root, 'toolchains/runtime/x86_64-linux.c')),
  )
  await capture('docker', hardened(manifest.images.codegen, [
    'clang', '-target', 'x86_64-unknown-linux-gnu', '-fuse-ld=lld', '-nostdlib', '-static',
    '-Wl,-e,_start', '/artifacts/canonical.ll', '/artifacts/x86_64-linux.c',
    '-o', '/artifacts/canonical-x86_64',
  ], temp))
  const semanticFrame = await captureBuffer(
    'docker',
    hardened(manifest.images.codegen, ['/artifacts/canonical-x86_64'], temp),
  )
  if (semanticFrame.byteLength < 24 ||
      semanticFrame.readUInt32LE(0) !== 0x46415349 ||
      semanticFrame.readUInt16LE(4) !== 1 ||
      semanticFrame.readUInt8(6) !== 0 ||
      semanticFrame.readBigUInt64LE(8) !== 0x11223300n) {
    throw new Error('x86-64 canonical semantic result frame did not match the independent reference')
  }
  observations['x86_64-linux'].semanticExecution = {
    frameVersion: 1,
    rawBits: `0x${semanticFrame.readBigUInt64LE(8).toString(16)}`,
    independentlyMatched: true,
  }

  await writeFile(resolve(temp, 'wasi.c'), 'int main(void) { return 0; }\n')
  await capture('docker', hardened(manifest.images.wasi, [
    'clang', '/artifacts/wasi.c', '-o', '/artifacts/wasi.wasm',
  ], temp))
  await capture('docker', hardened(manifest.images.wasi, [
    'wasmtime', 'run', '-C', 'cache=n', '-W', 'fuel=1000000', '-W', 'timeout=5s',
    '-W', 'max-memory-size=67108864', '/artifacts/wasi.wasm',
  ], temp))
  await writeFile(
    resolve(temp, 'host.c'),
    await readFile(resolve(root, 'toolchains/runtime/host.c')),
  )
  await capture('docker', hardened(manifest.images.wasi, [
    'clang', '/artifacts/canonical.ll', '/artifacts/host.c',
    '-o', '/artifacts/canonical-wasi.wasm',
  ], temp))
  const wasiFrame = await captureBuffer('docker', hardened(manifest.images.wasi, [
    'wasmtime', 'run', '-C', 'cache=n', '-W', 'fuel=10000000', '-W', 'timeout=5s',
    '-W', 'max-memory-size=67108864', '/artifacts/canonical-wasi.wasm',
  ], temp))
  if (wasiFrame.byteLength < 24 ||
      wasiFrame.readUInt32LE(0) !== 0x46415349 ||
      wasiFrame.readUInt16LE(4) !== 1 ||
      wasiFrame.readUInt8(6) !== 0 ||
      wasiFrame.readBigUInt64LE(8) !== 0x11223300n) {
    throw new Error('WASI canonical semantic result frame did not match the independent reference')
  }
  observations['wasm32-wasip1'].tier = 'execute'
  observations['wasm32-wasip1'].reason = 'WASI module executed with fuel and no inherited directories, environment, or stdio files'
  observations['wasm32-wasip1'].semanticExecution = {
    frameVersion: 1,
    rawBits: `0x${wasiFrame.readBigUInt64LE(8).toString(16)}`,
    independentlyMatched: true,
  }
  await writeFile(resolve(temp, 'mos.c'), await readFile(resolve(root, 'toolchains/runtime/mos-semantic.c')))
  await capture('docker', hardened(manifest.images.mos, [
    'mos-sim-clang', '/artifacts/mos.c', '-o', '/artifacts/mos-semantic',
  ], temp))
  const mosOutput = await capture('docker', hardened(manifest.images.mos, [
    'mos-sim', '/artifacts/mos-semantic',
  ], temp))
  const expectedMosOutput = 'arithmetic:ok\nmemory:ok\nedge:ok\n'
  if (mosOutput !== expectedMosOutput) throw new Error(`mos-sim semantic output mismatch: ${JSON.stringify(mosOutput)}`)
  observations['mos-sim'] = {
    tier: 'execute',
    reason: 'separate 64 KiB llvm-mos path passed arithmetic, unaligned memory, and div/rem edge probes via MMIO',
    binarySha256: sha(await readFile(resolve(temp, 'mos-semantic'))),
    stdout: mosOutput,
  }
  const imageLockBytes = await readFile(resolve(root, 'toolchains/images.lock.json'))
  await writeFile(resolve(root, 'toolchains/native-capabilities.lock.json'), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    imagesLockSha256: sha(imageLockBytes),
    observations: {
      'x86_64-linux': observations['x86_64-linux'],
      'wasm32-wasip1': observations['wasm32-wasip1'],
      'mos-sim': observations['mos-sim'],
    },
  }, null, 2)}\n`)
  await outputReport('smoke.json', { schemaVersion: 1, observations })
}

function hardened(image, argv, mount = resolve(root, '.isa-bench-data/toolchain-smoke')) {
  return [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '128',
    '--memory', '1g', '--cpus', '2', '--user', '65532:65532',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864',
    '--mount', `type=bind,src=${mount},dst=/artifacts`,
    image, ...argv,
  ]
}

async function writeIdentities() {
  await mkdir(resolve(root, '.isa-bench-data/toolchain-smoke'), { recursive: true })
  const identities = {}
  for (const [name, image] of Object.entries(manifest.images)) {
    const selfTest = JSON.parse(await capture('docker', hardened(image, ['self-test'])))
    identities[name] = {
      reference: image,
      imageId: (await capture('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])).trim(),
      repoDigests: JSON.parse(await capture('docker', ['image', 'inspect', image, '--format', '{{json .RepoDigests}}'])),
      selfTest,
    }
  }
  await outputReport('images.json', identities)
  const lock = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceManifestSha256: sha(manifestBytes),
    images: identities,
  }
  await writeFile(resolve(root, 'toolchains/images.lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
}

async function outputReport(name, value) {
  const path = resolve(root, '.isa-bench-data/toolchains', name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function validateManifest(value) {
  if (value.schemaVersion !== 1) throw new Error('unsupported manifest schema')
  for (const [name, asset] of Object.entries(value.assets)) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`${name} has invalid SHA-256`)
    if (!String(asset.url).startsWith('https://')) throw new Error(`${name} URL is not HTTPS`)
    if (!asset.version || !asset.license) throw new Error(`${name} lacks version or license`)
  }
  for (const image of Object.values(value.images)) {
    if (String(image).endsWith(':latest')) throw new Error('latest is forbidden in production image references')
  }
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function capture(program, args) {
  return execute(program, args, true)
}

function captureExit(program, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, shell: false, stdio: 'pipe' })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise(code))
  })
}

function captureBuffer(program, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, shell: false, stdio: 'pipe' })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolvePromise(Buffer.concat(chunks))
      : reject(new Error(`${program} exited ${code}: ${stderr.slice(-8192)}`)))
  })
}

function run(program, args) {
  return execute(program, args, false)
}

function execute(program, args, collect) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, shell: false, stdio: collect ? 'pipe' : 'inherit' })
    let stdout = ''
    let stderr = ''
    if (collect) {
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolvePromise(stdout)
      : reject(new Error(`${program} exited ${code}: ${stderr.slice(-8192)}`)))
  })
}
