import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parentPort, workerData } from 'node:worker_threads'
import {
  ToolchainPreparedDescriptorV1Schema,
  ToolchainValidationResultSchema,
  assertResultIdentity,
  buildComparisonGroupKey,
  taggedJsonStringify,
} from '@isa-sim/contracts'
import { DockerExecutor } from './sandbox.js'
import { validateDisassembly, validateElfHeader } from './toolchains.js'

if (!parentPort) throw new Error('toolchain worker requires parentPort')
const controller = new AbortController()
const identity = workerData as { jobId?: string; serverId?: string; repositoryRoot?: string } | undefined
const lockedImages = new Map<string, string>()

function lockedImage(name: 'codegen' | 'qemu' | 'sparc' | 'wasi' | 'mos'): string {
  const cached = lockedImages.get(name)
  if (cached) return cached
  const root = resolve(identity?.repositoryRoot ?? process.cwd())
  const lockPath = resolve(root, 'toolchains/images.lock.json')
  const manifestPath = resolve(root, 'toolchains/manifest.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    sourceManifestSha256?: string
    images?: Record<string, { reference?: string; imageId?: string }>
  }
  if (lock.sourceManifestSha256 !== digest(readFileSync(manifestPath))) {
    throw new Error('toolchain image lock is stale relative to manifest')
  }
  const entry = lock.images?.[name]
  if (!entry?.reference || !entry.imageId?.match(/^sha256:[a-f0-9]{64}$/)) {
    throw new Error(`toolchain image ${name} is not immutably locked`)
  }
  const local = execFileSync('docker', ['image', 'inspect', entry.reference, '--format', '{{.Id}}'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
  if (local !== entry.imageId) throw new Error(`local toolchain image ${name} differs from lock`)
  lockedImages.set(name, entry.imageId)
  return entry.imageId
}
parentPort.on('message', (value: unknown) => {
  if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'abort') {
    controller.abort()
  }
})

const targets = {
  'x86_64-linux': { triple: 'x86_64-unknown-linux-gnu', abi: 'SysV AMD64', endianness: 'little', addressWidth: 64, image: lockedImage('codegen') },
  'aarch64-linux': { triple: 'aarch64-unknown-linux-gnu', abi: 'AAPCS64', endianness: 'little', addressWidth: 64, image: lockedImage('codegen') },
  'riscv64-linux': { triple: 'riscv64-unknown-linux-gnu', abi: 'lp64d', endianness: 'little', addressWidth: 64, image: lockedImage('codegen'), flags: ['-march=rv64gc', '-mabi=lp64d'] },
  'mipsel-o32': { triple: 'mipsel-unknown-linux-gnu', abi: 'o32', endianness: 'little', addressWidth: 32, image: lockedImage('codegen'), flags: ['-march=mips32', '-mabi=o32'] },
  'powerpc64le-elfv2': { triple: 'powerpc64le-unknown-linux-gnu', abi: 'ELFv2', endianness: 'little', addressWidth: 64, image: lockedImage('codegen'), flags: ['-mabi=elfv2'] },
  'sparc-v8': { triple: 'sparc-unknown-linux-gnu', abi: 'SPARC V8', endianness: 'big', addressWidth: 32, image: lockedImage('codegen'), cpu: 'v8' },
  'wasm32-wasip1': { triple: 'wasm32-wasip1', abi: 'WASI Preview 1', endianness: 'little', addressWidth: 32, image: lockedImage('wasi') },
} as const

parentPort.once('message', async (input: unknown) => {
  const root = mkdtempSync(join(tmpdir(), 'isa-toolchain-'))
  try {
    const request = parseRequest(input)
    writeFileSync(join(root, 'canonical.ll'), request.canonicalIr, { encoding: 'utf8', flag: 'wx' })
    const canonicalIdentity = artifact('canonical.ll', 'text/plain', Buffer.from(request.canonicalIr))
    const executor = new DockerExecutor(undefined, identity)
    const results: Record<string, unknown> = {}
    for (let index = 0; index < request.targets.length; index += 1) {
      const id = request.targets[index]!
      const artifactIdentities = [canonicalIdentity]
      progress(index / request.targets.length, 'COMPILE', `compiling ${id}`)
      if (id === 'mos-sim') {
        results[id] = {
          tier: request.memoryBytes > 65536 ? 'unsupported' : 'codegen-only',
          reason: request.memoryBytes > 65536
            ? `guest memory ${request.memoryBytes} bytes exceeds MOS 64 KiB address space`
            : 'mos-sim MMIO arithmetic/memory/edge probes pass, but this generic canonical LLVM workload has no verified llvm-mos lowering',
        }
        continue
      }
      const descriptor = targets[id as keyof typeof targets]
      if (!descriptor) {
        results[id] = { tier: 'unsupported', reason: 'unknown target descriptor' }
        continue
      }
      const objectName = `${id}.o`
      const compileArgv = [
        'clang', '-x', 'ir', '-target', descriptor.triple,
        ...('cpu' in descriptor ? [`-mcpu=${descriptor.cpu}`] : []),
        ...('flags' in descriptor ? descriptor.flags : []),
        '-c', '/artifacts/canonical.ll', '-o', `/artifacts/${objectName}`,
      ]
      const compile = await executor.execute({
        image: descriptor.image,
        argv: compileArgv,
        artifactDir: root,
        limits: { timeoutMs: request.compileTimeoutMs, outputBytes: 1024 * 1024, filesBytes: 64 * 1024 * 1024 },
        signal: controller.signal,
      })
      if (compile.kind !== 'exited' || compile.exitCode !== 0) {
        results[id] = {
          tier: 'unsupported',
          reason: `compiler ${compile.kind}, exit ${compile.exitCode}`,
          command: compileArgv,
          log: bounded(`${compile.stdout}\n${compile.stderr}`),
        }
        continue
      }
      const object = readFileSync(join(root, objectName))
      try {
        validateObject(id, object)
      } catch (error) {
        results[id] = {
          tier: 'unsupported',
          reason: error instanceof Error ? error.message : String(error),
          command: compileArgv,
        }
        continue
      }
      artifactIdentities.push(artifact(objectName, 'application/octet-stream', object))
      progress((index + 0.5) / request.targets.length, 'DISASSEMBLE', `validating ${id}`)
      const disassemblyName = `${id}.disassembly.txt`
      const disassembleArgv = ['llvm-objdump', '--disassemble', '--no-show-raw-insn', `/artifacts/${objectName}`]
      const disassembly = await executor.execute({
        image: descriptor.image,
        argv: disassembleArgv,
        artifactDir: root,
        limits: { timeoutMs: request.compileTimeoutMs, outputBytes: 2 * 1024 * 1024 },
        signal: controller.signal,
      })
      try {
        if (disassembly.kind !== 'exited' || disassembly.exitCode !== 0) throw new Error('disassembler failed')
        validateDisassembly(disassembly.stdout, id)
      } catch {
        results[id] = {
          tier: 'unsupported',
          reason: 'object disassembly failed or contained an unknown decode',
          command: disassembleArgv,
          log: bounded(`${disassembly.stdout}\n${disassembly.stderr}`),
        }
        continue
      }
      writeFileSync(join(root, disassemblyName), disassembly.stdout)
      artifactIdentities.push(artifact(disassemblyName, 'text/plain', Buffer.from(disassembly.stdout)))
      if (request.expectedFrame && id in targets) {
        progress((index + 0.75) / request.targets.length, 'EXECUTE', `executing ${id}`)
        const execution = await executeExact(
          id as ExecutableTarget,
          root,
          descriptor.image,
          request.compileTimeoutMs,
          request.expectedFrame,
          executor,
        )
        if (execution.ok) {
          results[id] = {
            tier: 'execute',
            reason: 'versioned result frame independently matched expected raw bits and stdout bytes',
            commands: [compileArgv, disassembleArgv, ...execution.commands],
            objectBytes: object.byteLength,
            runtimeBytes: execution.runtimeBytes,
            artifactIdentities: [...artifactIdentities, ...execution.artifactIdentities],
          }
          continue
        }
        results[id] = { tier: 'unsupported', reason: execution.reason, commands: execution.commands }
        continue
      }
      results[id] = {
        tier: 'codegen-only',
        reason: id === 'sparc-v8'
          ? 'SPARC V8 object and disassembly passed; no audited V8 executor is installed'
          : 'object and disassembly passed; this exact canonical runtime was not linked/executed',
        commands: [compileArgv, disassembleArgv],
        objectBytes: object.byteLength,
        runtimeBytes: 0,
        artifactIdentities,
      }
    }
    progress(1, 'VALIDATE', 'toolchain validation complete')
    if (controller.signal.aborted) throw new Error('toolchain validation cancelled')
    const envelopes = await Promise.all(Object.entries(results).map(([target, observation]) =>
      validationEnvelope(target, observation as Record<string, unknown>, request, canonicalIdentity)))
    parentPort!.postMessage({
      type: 'result',
      lane: 'toolchain-validation',
      result: {
        lane: 'toolchain-validation',
        claim: 'functional toolchain validation only; no performance claim',
        emitterVersion: request.emitterVersion,
        descriptorSha256: request.descriptorSha256,
        targets: results,
        envelopes,
      },
    })
  } catch (error) {
    if (controller.signal.aborted) {
      parentPort!.postMessage({ type: 'cancelled', reason: 'toolchain containers stopped and removed' })
    } else {
      parentPort!.postMessage({
        type: 'error',
        error: { code: 'toolchain_error', message: error instanceof Error ? error.message : String(error) },
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    parentPort!.close()
  }
})

function parseRequest(input: unknown): {
  canonicalIr: string
  targets: string[]
  memoryBytes: number
  emitterVersion: string
  compileTimeoutMs: number
  descriptorSha256: string
  expectedFrame?: { kind: 'i32' | 'binary64'; rawBits: bigint; stdout: Buffer }
} {
  const descriptor = ToolchainPreparedDescriptorV1Schema.parse(input)
  const actualHash = digest(Buffer.from(taggedJsonStringify(descriptor.payload)))
  if (actualHash !== descriptor.payloadSha256) throw new Error('prepared toolchain descriptor hash mismatch')
  const body = descriptor.payload
  if (new Set(body.targets).size !== body.targets.length) throw new Error('targets must not contain duplicates')
  return {
    canonicalIr: body.canonicalIr,
    targets: body.targets,
    memoryBytes: body.memoryBytes,
    emitterVersion: body.emitterVersion,
    compileTimeoutMs: 60_000,
    descriptorSha256: descriptor.payloadSha256,
    expectedFrame: {
      kind: body.expectedFrame.kind,
      rawBits: BigInt(`0x${body.expectedFrame.rawBits}`),
      stdout: Buffer.from(body.expectedFrame.stdoutBase64, 'base64'),
    },
  }
}

function artifact(filename: string, mimeType: string, bytes: Buffer): string {
  parentPort!.postMessage({ type: 'artifact', filename, mimeType, bytes })
  return digest(bytes)
}

function progress(ratio: number, phase: string, detail: string): void {
  parentPort!.postMessage({ type: 'progress', progress: { ratio, phase, detail } })
}

function bounded(value: string): string {
  return value.slice(0, 64 * 1024)
}

async function validationEnvelope(
  targetId: string,
  observation: Record<string, unknown>,
  request: { canonicalIr: string; emitterVersion: string },
  canonicalIdentity: string,
): Promise<unknown> {
  const descriptor = targetId === 'mos-sim'
    ? { triple: 'mos-unknown-unknown', abi: 'llvm-mos freestanding', endianness: 'little' as const, addressWidth: 16 as const }
    : targets[targetId as keyof typeof targets]
  if (!descriptor) throw new Error(`cannot create validation envelope for ${targetId}`)
  const commands = Array.isArray(observation.commands) ? observation.commands as string[][] : []
  const inputIdentity = digest(request.canonicalIr)
  const commandDigest = digest(JSON.stringify(commands))
  const imageIdentities = imageReferences(targetId).map(loadImageIdentity)
  const imageIdentity = imageIdentities[0]
  const environmentDigest = digest(JSON.stringify({ targetId, imageIdentities }))
  const comparison = {
    experimentKind: 'toolchain-validation' as const,
    modelVersion: request.emitterVersion,
    workloadSemanticHash: inputIdentity,
    artifactPipelineHash: commandDigest,
    roiDefinitionHash: digest('functional-result-frame-v1'),
    profileConfigFingerprint: environmentDigest,
    metricDomain: 'functional-validation-status' as const,
    unit: 'outcome',
  }
  const tier = String(observation.tier ?? 'unsupported')
  const result = ToolchainValidationResultSchema.parse({
    schemaVersion: '1.0.0',
    modelVersion: request.emitterVersion,
    adapterVersion: '1.1.0',
    experimentKind: 'toolchain-validation',
    claimClass: 'functional-toolchain-validation',
    evidenceClass: 'generated-code',
    inputIdentity,
    artifactIdentities: Array.isArray(observation.artifactIdentities)
      ? observation.artifactIdentities
      : [canonicalIdentity],
    comparisonGroupKey: await buildComparisonGroupKey(comparison),
    comparison,
    createdAt: new Date().toISOString(),
    target: {
      triple: descriptor.triple,
      abi: descriptor.abi,
      endianness: descriptor.endianness,
      addressWidth: descriptor.addressWidth,
    },
    build: {
      buildId: `toolchain-${targetId}`,
      sourceRevision: `sha256:${inputIdentity}`,
      sourceDirty: false,
      tools: [{
        name: 'pinned-toolchain',
        version: targetId === 'mos-sim' ? '23.0.1' : '23.1.0',
        invocation: commands.flat(),
      }],
      ...(imageIdentity ? { image: imageIdentity } : {}),
      commandDigest,
      environmentDigest,
    },
    validationStatus: tier === 'execute' ? 'passed' : tier === 'codegen-only' ? 'not-executed' : 'failed',
    diagnostics: [String(observation.reason ?? 'no diagnostic')],
  })
  await assertResultIdentity(result)
  return result
}

function loadImageIdentity(reference: string): { imageReference: string; digest: string } | undefined {
  const candidates = [
    join(process.cwd(), 'toolchains', 'images.lock.json'),
    join(process.cwd(), '..', 'toolchains', 'images.lock.json'),
  ]
  for (const path of candidates) {
    try {
      const lock = JSON.parse(readFileSync(path, 'utf8')) as {
        images?: Record<string, { reference?: string; imageId?: string }>
      }
      const identity = Object.values(lock.images ?? {}).find((candidate) =>
        candidate.reference === reference || candidate.imageId === reference)
      if (identity?.reference && identity.imageId?.match(/^sha256:[a-f0-9]{64}$/)) {
        return { imageReference: identity.reference, digest: identity.imageId }
      }
    } catch {
      // Try the next repository-relative location.
    }
  }
  return undefined
}

function imageReferences(targetId: string): string[] {
  if (targetId === 'wasm32-wasip1') return [lockedImage('wasi')]
  if (targetId === 'mos-sim') return [lockedImage('mos')]
  if (targetId === 'x86_64-linux') return [lockedImage('codegen')]
  if (targetId === 'sparc-v8') {
    return [lockedImage('codegen'), lockedImage('sparc'), lockedImage('qemu')]
  }
  return [lockedImage('codegen'), lockedImage('qemu')]
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function validateObject(target: string, object: Uint8Array): void {
  if (target === 'wasm32-wasip1') {
    if (object.byteLength < 8 || object[0] !== 0 || object[1] !== 0x61 || object[2] !== 0x73 || object[3] !== 0x6d) {
      throw new Error('target object is not a WebAssembly module')
    }
    return
  }
  const expected = {
    'x86_64-linux': { elfClass: 2, endianness: 'little', machine: 62 },
    'aarch64-linux': { elfClass: 2, endianness: 'little', machine: 183 },
    'riscv64-linux': { elfClass: 2, endianness: 'little', machine: 243, flagsMask: 0x6, flagsValue: 0x4 },
    'mipsel-o32': { elfClass: 1, endianness: 'little', machine: 8, flagsMask: 0xf000f000, flagsValue: 0x50001000 },
    'powerpc64le-elfv2': { elfClass: 2, endianness: 'little', machine: 21, flagsMask: 0x3, flagsValue: 0x2 },
    'sparc-v8': { elfClass: 1, endianness: 'big', machine: 2, flagsMask: 0xffffffff, flagsValue: 0 },
  } as const
  const descriptor = expected[target as keyof typeof expected]
  if (!descriptor) throw new Error(`no object validator for ${target}`)
  validateElfHeader(object, descriptor)
}

type ExecutableTarget = keyof typeof targets

async function executeExact(
  target: ExecutableTarget,
  root: string,
  image: string,
  timeoutMs: number,
  expected: { kind: 'i32' | 'binary64'; rawBits: bigint; stdout: Buffer },
  executor: DockerExecutor,
): Promise<
  | { ok: true; commands: string[][]; runtimeBytes: number; artifactIdentities: string[] }
  | { ok: false; commands: string[][]; reason: string }
> {
  const adapter = target === 'x86_64-linux'
    ? 'x86_64-linux.c'
    : target === 'wasm32-wasip1'
      ? 'host.c'
      : 'linux-freestanding.c'
  const adapterBytes = runtimeAdapter(adapter)
  writeFileSync(join(root, adapter), adapterBytes)
  const output = target === 'wasm32-wasip1' ? 'program.wasm' : `program-${target}`
  const cross = {
    'aarch64-linux': { triple: 'aarch64-unknown-linux-gnu', flags: [] as string[], qemu: 'qemu-aarch64' },
    'riscv64-linux': { triple: 'riscv64-unknown-linux-gnu', flags: ['-march=rv64gc', '-mabi=lp64d'], qemu: 'qemu-riscv64' },
    'mipsel-o32': { triple: 'mipsel-unknown-linux-gnu', flags: ['-march=mips32', '-mabi=o32', '-mno-abicalls', '-fno-pic'], qemu: 'qemu-mipsel' },
    'powerpc64le-elfv2': { triple: 'powerpc64le-unknown-linux-gnu', flags: ['-mabi=elfv2'], qemu: 'qemu-ppc64le' },
    'sparc-v8': { triple: 'sparc-unknown-linux-gnu', flags: ['-mcpu=v8'], qemu: 'qemu-sparc' },
  } as const
  const compile = target === 'x86_64-linux'
    ? [
        'clang', '-target', 'x86_64-unknown-linux-gnu', '-fuse-ld=lld', '-nostdlib', '-static',
        '-fno-stack-protector', '-fno-builtin', '-Wl,-e,_start',
        '/artifacts/canonical.ll', `/artifacts/${adapter}`, '-o', `/artifacts/${output}`,
      ]
    : target === 'wasm32-wasip1'
      ? ['clang', '/artifacts/canonical.ll', `/artifacts/${adapter}`, '-o', `/artifacts/${output}`]
      : [
          'clang', '-target', cross[target].triple, ...cross[target].flags, '-fuse-ld=lld',
          '-nostdlib', '-static', '-fno-stack-protector', '-fno-builtin', '-Wl,-e,_start',
          '/artifacts/canonical.ll', `/artifacts/${adapter}`, '-o', `/artifacts/${output}`,
        ]
  const compileCommands: string[][] = []
  if (target === 'sparc-v8') {
    const core = ['clang', '-target', cross[target].triple, ...cross[target].flags,
      '-fno-stack-protector', '-fno-builtin', '-c', '/artifacts/canonical.ll', '-o', '/artifacts/sparc-core.o']
    const runtime = ['clang', '-target', cross[target].triple, ...cross[target].flags,
      '-fno-stack-protector', '-fno-builtin', '-c', `/artifacts/${adapter}`, '-o', '/artifacts/sparc-runtime.o']
    const link = ['sparc64-linux-gnu-ld', '-m', 'elf32_sparc', '-static', '-e', '_start',
      '/artifacts/sparc-core.o', '/artifacts/sparc-runtime.o', '-o', `/artifacts/${output}`]
    for (const [command, commandImage] of [[core, image], [runtime, image], [link, lockedImage('sparc')]] as const) {
      compileCommands.push(command)
      const result = await executor.execute({
        image: commandImage,
        argv: command,
        artifactDir: root,
        limits: { timeoutMs, outputBytes: 1024 * 1024, filesBytes: 64 * 1024 * 1024 },
        signal: controller.signal,
      })
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        return { ok: false, commands: compileCommands, reason: `runtime link failed: ${bounded(result.stderr)}` }
      }
    }
  } else {
    compileCommands.push(compile)
    const compiled = await executor.execute({
      image,
      argv: compile,
      artifactDir: root,
      limits: { timeoutMs, outputBytes: 1024 * 1024, filesBytes: 64 * 1024 * 1024 },
      signal: controller.signal,
    })
    if (compiled.kind !== 'exited' || compiled.exitCode !== 0) {
      return { ok: false, commands: compileCommands, reason: `runtime link failed: ${bounded(compiled.stderr)}` }
    }
  }
  const run = target === 'x86_64-linux'
    ? [`/artifacts/${output}`]
    : target === 'wasm32-wasip1' ? [
        'wasmtime', 'run', '-C', 'cache=n', '-W', 'fuel=10000000', '-W', 'timeout=5s',
        '-W', 'max-memory-size=67108864', `/artifacts/${output}`,
      ]
      : [cross[target].qemu, `/artifacts/${output}`]
  const executed = await executor.execute({
    image: target === 'x86_64-linux' || target === 'wasm32-wasip1' ? image : lockedImage('qemu'),
    argv: run,
    artifactDir: root,
    limits: { timeoutMs: Math.min(timeoutMs, 10_000), outputBytes: 4 * 1024 * 1024 },
    signal: controller.signal,
  })
  if (executed.kind !== 'exited' || executed.exitCode !== 0) {
    return { ok: false, commands: [...compileCommands, run], reason: `execution failed: ${executed.kind}, exit ${executed.exitCode}` }
  }
  const frame = Buffer.from(executed.stdoutBase64, 'base64')
  if (frame.byteLength < 24 || frame.readUInt32LE(0) !== 0x46415349 || frame.readUInt16LE(4) !== 1) {
    return { ok: false, commands: [...compileCommands, run], reason: 'execution did not return a valid v1 result frame' }
  }
  const stdoutLength = frame.readUInt32LE(16)
  const faultLength = frame.readUInt32LE(20)
  if (stdoutLength > 2 * 1024 * 1024 || faultLength > 64 * 1024 ||
      frame.byteLength !== 24 + stdoutLength + faultLength) {
    return { ok: false, commands: [...compileCommands, run], reason: 'execution returned malformed result-frame lengths' }
  }
  const actualStdout = frame.subarray(24, 24 + stdoutLength)
  const kindByte = frame.readUInt8(7)
  const kind = kindByte === 0 ? 'i32' : kindByte === 1 ? 'binary64' : null
  if (frame.readUInt8(6) !== 0 || faultLength !== 0 || kind !== expected.kind ||
      frame.readBigUInt64LE(8) !== expected.rawBits || !actualStdout.equals(expected.stdout)) {
    return { ok: false, commands: [...compileCommands, run], reason: 'result frame differs from independent expected bits/stdout' }
  }
  const artifactIdentities = [
    artifact(`${target}.frame.bin`, 'application/octet-stream', frame),
    artifact(output, 'application/octet-stream', readFileSync(join(root, output))),
  ]
  return {
    ok: true,
    commands: [...compileCommands, run],
    runtimeBytes: adapterBytes.byteLength,
    artifactIdentities,
  }
}

function runtimeAdapter(name: string): Buffer {
  const candidates = [
    join(process.cwd(), 'toolchains', 'runtime', name),
    join(process.cwd(), '..', 'toolchains', 'runtime', name),
  ]
  const path = candidates.find(existsSync)
  if (!path) throw new Error(`runtime adapter ${name} not found`)
  return readFileSync(path)
}
