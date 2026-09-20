import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { DockerExecutor, type SandboxResult } from './sandbox.js'

export type CapabilityTier = 'execute' | 'codegen-only' | 'unsupported'

export interface TargetCapability {
  target: string
  tier: CapabilityTier
  reason: string
  image: string
}

interface ManifestTarget {
  tier: CapabilityTier
  executor: string | null
}

interface ToolchainManifest {
  images: Record<string, string>
  targets: Record<string, ManifestTarget>
}

export interface ToolchainProbe {
  available: boolean
  reason: string
  targets: TargetCapability[]
  images: Record<string, { reference: string; imageId: string; selfTest: SandboxResult }>
}

export async function probeToolchains(
  executor = new DockerExecutor(),
  suppliedManifest?: ToolchainManifest,
  options: {
    root?: string
    inspectImage?: (reference: string) => string
  } = {},
): Promise<ToolchainProbe> {
  let manifest: ToolchainManifest
  let immutableImages: Record<string, { reference: string; imageId: string }>
  let root: string
  try {
    root = options.root ? resolve(options.root) : repositoryRoot()
    const manifestPath = resolve(root, 'toolchains/manifest.json')
    const manifestBytes = readFileSync(manifestPath)
    manifest = suppliedManifest ?? JSON.parse(manifestBytes.toString('utf8')) as ToolchainManifest
    const lock = JSON.parse(readFileSync(resolve(root, 'toolchains/images.lock.json'), 'utf8')) as {
      sourceManifestSha256?: unknown
      images?: Record<string, { reference?: unknown; imageId?: unknown }>
    }
    if (lock.sourceManifestSha256 !== digest(manifestBytes)) {
      throw new Error('toolchain image lock is stale relative to manifest.json')
    }
    immutableImages = {}
    const inspect = options.inspectImage ?? ((reference: string) =>
      execFileSync('docker', ['image', 'inspect', reference, '--format', '{{.Id}}'], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim())
    for (const [name, reference] of Object.entries(manifest.images)) {
      const locked = lock.images?.[name]
      if (locked?.reference !== reference || typeof locked.imageId !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/.test(locked.imageId)) {
        throw new Error(`toolchain image ${name} tag/ID lock is missing or mismatched`)
      }
      if (inspect(reference) !== locked.imageId) {
        throw new Error(`toolchain image ${name} local ID differs from lock`)
      }
      immutableImages[name] = { reference, imageId: locked.imageId }
    }
  } catch (error) {
    return unavailableProbe(
      error instanceof Error ? error.message : String(error),
      suppliedManifest,
    )
  }
  const observedCapabilities = loadObservedCapabilities(root)
  const imageResults: ToolchainProbe['images'] = {}
  await Promise.all(Object.entries(immutableImages).map(async ([name, image]) => {
    let selfTest: SandboxResult
    try {
      selfTest = await executor.execute({
        image: image.imageId,
        argv: ['self-test'],
        artifactDir: resolve(root, '.isa-bench-data', 'probe'),
        jobId: 'capability-probe',
        serverId: `server-${process.pid}`,
        limits: { timeoutMs: 30_000, outputBytes: 64 * 1024 },
      })
    } catch (error) {
      selfTest = {
        kind: 'spawn-error',
        exitCode: null,
        signal: null,
        stdout: '',
        stdoutBase64: '',
        stderr: '',
        durationMs: 0,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    imageResults[name] = {
      ...image,
      selfTest,
    }
  }))
  const targets = Object.entries(manifest.targets).map(([target, descriptor]): TargetCapability => {
    const imageNames = target === 'wasm32-wasip1'
      ? ['wasi']
      : target === 'mos-sim'
        ? ['mos']
        : target === 'x86_64-linux'
          ? ['codegen']
          : target === 'sparc-v8'
            ? ['codegen', 'qemu', 'sparc']
            : ['codegen', 'qemu']
    const images = imageNames.map((name) => immutableImages[name]?.imageId).filter((value): value is string => Boolean(value))
    const image = images.join(', ')
    if (images.length !== imageNames.length) {
      return { target, tier: 'unsupported', reason: `manifest image set ${imageNames.join(', ')} is incomplete`, image }
    }
    for (const imageName of imageNames) {
      const result = imageResults[imageName]?.selfTest
      if (!result || result.kind !== 'exited' || result.exitCode !== 0) {
        return { target, tier: 'unsupported', reason: `${imageName} image self-test failed: ${probeReason(result)}`, image }
      }
    }
    if (descriptor.tier === 'codegen-only') {
      const reason = target === 'sparc-v8'
        ? 'LLVM 23.1 emits SPARC V8 objects; no audited SPARC V8 userspace executor is installed'
        : target === 'mos-sim'
          ? 'mos-sim MMIO probes execute; arbitrary canonical LLVM workloads remain codegen-only pending verified llvm-mos lowering'
          : `LLVM emits the target object; the pinned ${descriptor.executor} adapter lacks an audited target sysroot/runtime`
      return { target, tier: 'codegen-only', reason, image }
    }
    const observation = observedCapabilities[target]
    if (observation?.tier !== 'execute') {
      return {
        target,
        tier: 'codegen-only',
        reason: observation?.reason ?? 'no checked-in successful execution probe exists for this exact target adapter',
        image,
      }
    }
    return {
      target,
      tier: 'execute',
      reason: `checked-in exact execution probe passed under ${descriptor.executor}`,
      image,
    }
  })
  const supported = targets.some((target) => target.tier !== 'unsupported')
  return {
    available: supported,
    reason: supported ? 'at least one pinned toolchain image passed self-test' : 'no pinned toolchain image passed self-test',
    targets,
    images: imageResults,
  }
}

function loadObservedCapabilities(root: string): Record<string, { tier?: CapabilityTier; reason?: string }> {
  const directories = [resolve(root, 'toolchains')]
  const observations: Record<string, { tier?: CapabilityTier; reason?: string }> = {}
  let found = false
  const candidates = directories.flatMap((directory) => [
    resolve(directory, 'capabilities.lock.json'),
    resolve(directory, 'native-capabilities.lock.json'),
  ])
  for (const path of candidates) {
    try {
      const lock = JSON.parse(readFileSync(path, 'utf8')) as {
        schemaVersion?: unknown
        imagesLockSha256?: unknown
        observations?: Record<string, { tier?: CapabilityTier; reason?: string }>
      }
      const imageLock = readFileSync(resolve(dirname(path), 'images.lock.json'))
      const actualLockHash = createHash('sha256').update(imageLock).digest('hex')
      if (lock.schemaVersion === 1 && lock.imagesLockSha256 === actualLockHash && lock.observations) {
        Object.assign(observations, lock.observations)
        found = true
      }
    } catch {
      // Try the next repository-relative location.
    }
  }
  return found ? observations : {}
}

export function validateElfHeader(
  bytes: Uint8Array,
  expected: {
    elfClass: 1 | 2
    endianness: 'little' | 'big'
    machine: number
    flagsMask?: number
    flagsValue?: number
  },
): void {
  if (bytes.byteLength < (expected.elfClass === 1 ? 52 : 64) ||
      bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error('object is not ELF')
  }
  if (bytes[4] !== expected.elfClass) throw new Error('ELF class does not match target')
  const data = bytes[5] === 1 ? 'little' : bytes[5] === 2 ? 'big' : null
  if (data !== expected.endianness) throw new Error('ELF endianness does not match target')
  const machine = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(18, data === 'little')
  if (machine !== expected.machine) throw new Error(`ELF machine ${machine} does not match target ${expected.machine}`)
  if (expected.flagsMask !== undefined) {
    const flagsOffset = expected.elfClass === 1 ? 36 : 48
    const flags = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(flagsOffset, data === 'little')
    if ((flags & expected.flagsMask) !== (expected.flagsValue ?? 0)) {
      throw new Error(`ELF flags 0x${flags.toString(16)} do not match target ABI`)
    }
  }
  // EM_SPARC32PLUS (18) must never satisfy the SPARC V8 EM_SPARC (2) claim.
  if (expected.machine === 2 && machine === 18) throw new Error('SPARC32PLUS object cannot be claimed as SPARC V8')
}

export function validateDisassembly(text: string, target: string): void {
  if (/\b(unknown|<unknown>)\b/i.test(text)) throw new Error('disassembly contains an unknown decode')
  if (target === 'sparc-v8' &&
      /\b(v9|cas|casx|ldx|stx|ldxa|stxa|wrpr|rdpr|membar|flushw|movcc|fmov[a-z]*|done|retry|sir|popc)\b/i.test(text)) {
    throw new Error('disassembly contains an instruction newer than SPARC V8')
  }
}

function repositoryRoot(): string {
  for (const candidate of [resolve(process.cwd()), resolve(process.cwd(), '..')]) {
    if (existsSync(resolve(candidate, 'toolchains/manifest.json'))) return candidate
  }
  throw new Error('toolchain manifest not found')
}

function probeReason(result: SandboxResult | undefined): string {
  if (!result) return 'not run'
  return result.error ?? (result.stderr.trim() || `${result.kind}, exit ${result.exitCode}`)
}

function unavailableProbe(reason: string, manifest?: ToolchainManifest): ToolchainProbe {
  return {
    available: false,
    reason: `toolchain capability unavailable: ${reason}`,
    targets: Object.keys(manifest?.targets ?? {}).map((target) => ({
      target,
      tier: 'unsupported',
      reason,
      image: '',
    })),
    images: {},
  }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
