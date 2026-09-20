import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { dockerArguments, DockerExecutor, forceRemoveJobContainers, type SpawnProcess } from './sandbox.js'

const request = {
  image: `sha256:${'0'.repeat(64)}`,
  argv: ['hello', 'argument with spaces', '$(not-a-shell)'],
  artifactDir: process.cwd(),
}
const limits = {
  timeoutMs: 10,
  memoryBytes: 1024,
  cpus: 1,
  pids: 2,
  tmpfsBytes: 1024,
  outputBytes: 4,
  filesBytes: 1024,
}

describe('Docker sandbox', () => {
  it('constructs shell-free hardened argv', () => {
    const args = dockerArguments('random-name', { ...request, jobId: 'job-1', serverId: 'server-1' }, limits)
    expect(args).toContain('none')
    expect(args).toContain('ALL')
    expect(args).toContain('no-new-privileges:true')
    expect(args).toContain('65532:65532')
    expect(args.slice(-3)).toEqual(request.argv)
    expect(args).toContain('isa-sim.job=job-1')
    expect(args).toContain('isa-sim.server=server-1')
    expect(() => dockerArguments('x', { ...request, image: 'evil:latest' }, limits)).toThrow('immutable locked')
  })

  it('enumerates, force-removes, and confirms labeled job containers', () => {
    const id = 'a'.repeat(64)
    const exec = vi.fn()
      .mockReturnValueOnce(id)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
    expect(forceRemoveJobContainers('job-1', 'server-1', exec)).toBe(true)
    expect(exec).toHaveBeenNthCalledWith(1, 'docker', expect.arrayContaining([
      'label=isa-sim.managed=true',
      'label=isa-sim.job=job-1',
      'label=isa-sim.server=server-1',
    ]), expect.any(Object))
    expect(exec).toHaveBeenNthCalledWith(2, 'docker', ['rm', '-f', id], expect.any(Object))
  })

  it.runIf(process.env.ISA_SIM_ACTUAL_DOCKER_TESTS === '1')(
    'reaps an actual harmless labeled orphan when Docker is available', () => {
    try {
      execFileSync('docker', ['version'], { stdio: 'ignore', windowsHide: true })
    } catch {
      return
    }
    const root = existsSync(resolve(process.cwd(), 'toolchains/images.lock.json'))
      ? process.cwd()
      : resolve(process.cwd(), '..')
    const lock = JSON.parse(readFileSync(resolve(root, 'toolchains/images.lock.json'), 'utf8')) as {
      images: { codegen: { imageId: string } }
    }
    const jobId = `orphan-${process.pid}`
    const serverId = `test-${process.pid}`
    execFileSync('docker', [
      'run', '-d',
      '--label', 'isa-sim.managed=true',
      '--label', `isa-sim.job=${jobId}`,
      '--label', `isa-sim.server=${serverId}`,
      '--entrypoint', '/bin/sh',
      lock.images.codegen.imageId,
      '-c', 'sleep 30',
    ], { stdio: 'ignore', windowsHide: true })
    try {
      expect(forceRemoveJobContainers(jobId, serverId)).toBe(true)
    } finally {
      forceRemoveJobContainers(jobId, serverId)
    }
    }, 30_000)

  it('hard-stops output overflow with bounded output', async () => {
    const child = new EventEmitter() as ReturnType<SpawnProcess>
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(() => true),
    })
    const spawn = vi.fn(() => child) as unknown as SpawnProcess
    const promise = new DockerExecutor(spawn).execute({ ...request, limits })
    child.stdout.write('overflow')
    child.emit('close', null, 'SIGKILL')
    const result = await promise
    expect(result.kind).toBe('output-overflow')
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(4)
    expect(spawn).toHaveBeenCalledWith('docker', expect.any(Array), expect.objectContaining({ shell: false }))
  })

  it('stops the named container before forced worker termination on cancellation', async () => {
    const child = new EventEmitter() as ReturnType<SpawnProcess>
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(() => true),
    })
    const stopper = new EventEmitter() as ReturnType<SpawnProcess>
    const spawn = vi.fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(stopper) as unknown as SpawnProcess
    const controller = new AbortController()
    const promise = new DockerExecutor(spawn).execute({ ...request, signal: controller.signal, limits })
    controller.abort()
    child.emit('close', 137, 'SIGKILL')
    const result = await promise
    expect(result.kind).toBe('cancelled')
    expect(spawn).toHaveBeenNthCalledWith(2, 'docker',
      expect.arrayContaining(['stop', '--time', '2']),
      expect.objectContaining({ shell: false }))
  })

  it('kills the named container when its timeout expires', async () => {
    const child = new EventEmitter() as ReturnType<SpawnProcess>
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(() => true),
    })
    const killer = new EventEmitter() as ReturnType<SpawnProcess>
    const spawn = vi.fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(killer) as unknown as SpawnProcess
    const promise = new DockerExecutor(spawn).execute({ ...request, limits: { ...limits, timeoutMs: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    child.emit('close', 137, 'SIGKILL')
    const result = await promise
    expect(result.kind).toBe('timeout')
    expect(spawn).toHaveBeenNthCalledWith(2, 'docker', expect.arrayContaining(['kill']),
      expect.objectContaining({ shell: false }))
  })
})
