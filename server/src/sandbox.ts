import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface SandboxLimits {
  timeoutMs: number
  memoryBytes: number
  cpus: number
  pids: number
  tmpfsBytes: number
  outputBytes: number
  filesBytes: number
}

export interface SandboxRequest {
  image: string
  argv: string[]
  artifactDir: string
  limits?: Partial<SandboxLimits>
  signal?: AbortSignal
  jobId?: string
  serverId?: string
}

export interface SandboxResult {
  kind: 'exited' | 'timeout' | 'cancelled' | 'output-overflow' | 'spawn-error'
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stdoutBase64: string
  stderr: string
  durationMs: number
  truncated: boolean
  error?: string
}

export type SpawnProcess = typeof spawn
type ExecuteFile = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; windowsHide: true },
) => string
const executeFile: ExecuteFile = (file, args, options) =>
  execFileSync(file, args, options)

const defaults: SandboxLimits = {
  timeoutMs: 60_000,
  memoryBytes: 512 * 1024 * 1024,
  cpus: 1,
  pids: 128,
  tmpfsBytes: 64 * 1024 * 1024,
  outputBytes: 4 * 1024 * 1024,
  filesBytes: 256 * 1024 * 1024,
}

export function dockerArguments(
  name: string,
  request: SandboxRequest,
  limits: SandboxLimits,
): string[] {
  if (!/^sha256:[a-f0-9]{64}$/.test(request.image)) {
    throw new Error(`container image must be an immutable locked image ID: ${request.image}`)
  }
  if (!Array.isArray(request.argv) || request.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('argv must contain NUL-free strings')
  }
  const artifactDir = resolve(request.artifactDir)
  mkdirSync(artifactDir, { recursive: true })
  return [
    'run', '--rm', '--name', name,
    '--label', 'isa-sim.managed=true',
    '--label', `isa-sim.server=${safeLabel(request.serverId ?? 'unknown-server')}`,
    '--label', `isa-sim.job=${safeLabel(request.jobId ?? 'unknown-job')}`,
    '--user', '65532:65532',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', String(limits.pids),
    '--memory', String(limits.memoryBytes),
    '--cpus', String(limits.cpus),
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfsBytes}`,
    '--mount', `type=bind,src=${artifactDir},dst=/artifacts`,
    '--ulimit', `fsize=${limits.filesBytes}:${limits.filesBytes}`,
    request.image,
    ...request.argv,
  ]
}

export async function probeDocker(spawnProcess: SpawnProcess = spawn): Promise<{
  available: boolean
  detail: string
}> {
  return new Promise((resolveProbe) => {
    let output = ''
    let settled = false
    const finish = (available: boolean, detail: string) => {
      if (settled) return
      settled = true
      resolveProbe({ available, detail })
    }
    try {
      const child = spawnProcess('docker', ['version', '--format', '{{.Server.Version}}'], {
        shell: false,
        windowsHide: true,
      })
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.on('error', (error) => finish(false, error.message))
      child.on('close', (code) => finish(code === 0, output.trim() || `docker exited ${code}`))
    } catch (error) {
      finish(false, error instanceof Error ? error.message : String(error))
    }
  })
}

export function reapManagedContainers(exec: ExecuteFile = executeFile): string[] {
  try {
    const output = exec('docker', [
      'ps', '-aq', '--filter', 'label=isa-sim.managed=true',
    ], { encoding: 'utf8', windowsHide: true }).trim()
    const ids = output ? output.split(/\s+/).filter((id) => /^[a-f0-9]{12,64}$/.test(id)) : []
    if (ids.length > 0) {
      exec('docker', ['rm', '-f', ...ids], { encoding: 'utf8', windowsHide: true })
    }
    return ids
  } catch {
    return []
  }
}

export function forceRemoveJobContainers(
  jobId: string,
  serverId?: string,
  exec: ExecuteFile = executeFile,
): boolean {
  const label = safeLabel(jobId)
  try {
    const filters = [
      'ps', '-aq', '--filter', 'label=isa-sim.managed=true',
      '--filter', `label=isa-sim.job=${label}`,
      ...(serverId ? ['--filter', `label=isa-sim.server=${safeLabel(serverId)}`] : []),
    ]
    const list = () => exec('docker', filters, { encoding: 'utf8', windowsHide: true }).trim()
    const ids = list().split(/\s+/).filter((id) => /^[a-f0-9]{12,64}$/.test(id))
    if (ids.length > 0) {
      exec('docker', ['rm', '-f', ...ids], { encoding: 'utf8', windowsHide: true })
    }
    return list() === ''
  } catch {
    return false
  }
}

export class DockerExecutor {
  constructor(
    private readonly spawnProcess: SpawnProcess = spawn,
    private readonly identity: { jobId?: string; serverId?: string } = {},
  ) {}

  async execute(request: SandboxRequest): Promise<SandboxResult> {
    request = { ...this.identity, ...request }
    const limits = validateLimits({ ...defaults, ...request.limits })
    const name = `isa-sim-${crypto.randomUUID()}`
    const args = dockerArguments(name, request, limits)
    const started = performance.now()
    return new Promise((resolveRun) => {
      let child: ChildProcessWithoutNullStreams
      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)
      let terminal: SandboxResult['kind'] | null = null
      let settled = false
      let timer: NodeJS.Timeout | undefined
      let forceTimer: NodeJS.Timeout | undefined
      const killContainer = () => {
        child.kill('SIGKILL')
        try {
          const killer = this.spawnProcess('docker', ['kill', name], { shell: false, windowsHide: true })
          killer.on('error', () => undefined)
        } catch {
          // Child kill still enforces local process termination.
        }
      }
      const stopContainer = () => {
        try {
          const stopper = this.spawnProcess('docker', ['stop', '--time', '2', name], {
            shell: false,
            windowsHide: true,
          })
          stopper.on('error', () => killContainer())
        } catch {
          killContainer()
          return
        }
        forceTimer = setTimeout(killContainer, 2_500)
        forceTimer.unref()
      }
      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        request.signal?.removeEventListener('abort', onAbort)
        resolveRun({
          kind: terminal ?? (error ? 'spawn-error' : 'exited'),
          exitCode: code,
          signal,
          stdout: stdout.toString('utf8'),
          stdoutBase64: stdout.toString('base64'),
          stderr: stderr.toString('utf8'),
          durationMs: Math.max(0, performance.now() - started),
          truncated: terminal === 'output-overflow',
          ...(error ? { error } : {}),
        })
      }
      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        const used = stdout.byteLength + stderr.byteLength
        const remaining = Math.max(0, limits.outputBytes - used)
        const accepted = chunk.subarray(0, remaining)
        if (target === 'stdout') stdout = Buffer.concat([stdout, accepted])
        else stderr = Buffer.concat([stderr, accepted])
        if (accepted.byteLength < chunk.byteLength && terminal === null) {
          terminal = 'output-overflow'
          killContainer()
        }
      }
      const onAbort = () => {
        if (terminal === null) terminal = 'cancelled'
        stopContainer()
      }
      try {
        child = this.spawnProcess('docker', args, { shell: false, windowsHide: true, stdio: 'pipe' })
      } catch (error) {
        finish(null, null, error instanceof Error ? error.message : String(error))
        return
      }
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
      child.on('error', (error) => finish(null, null, error.message))
      child.on('close', (code, signal) => finish(code, signal))
      timer = setTimeout(() => {
        if (terminal === null) terminal = 'timeout'
        killContainer()
      }, limits.timeoutMs)
      timer.unref()
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted) onAbort()
    })
  }
}

function safeLabel(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('invalid container identity label')
  return value
}

function validateLimits(limits: SandboxLimits): SandboxLimits {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid sandbox limit ${key}`)
  }
  return limits
}
