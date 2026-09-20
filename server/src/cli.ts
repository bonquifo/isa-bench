#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createBackend } from './app.js'
import { validateBindHost } from './config.js'
import { probeDocker } from './sandbox.js'

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message)
  }
}

const args = process.argv.slice(2)
const command = args.shift() ?? 'help'

try {
  switch (command) {
    case 'serve':
      await serve(args)
      break
    case 'doctor':
      await doctor()
      break
    case 'health':
      print(await api('/api/health'))
      break
    case 'submit':
      await submit(args)
      break
    case 'watch':
      await watch(requiredArg(args, 0, 'job id'))
      break
    case 'cancel':
      print(await mutate(`/api/jobs/${requiredArg(args, 0, 'job id')}/cancel`))
      break
    case 'run':
      await run(args)
      break
    case 'artifact':
      await artifact(args)
      break
    case 'corpus':
      await corpus(args)
      break
    case 'help':
      usage()
      break
    default:
      throw new CliError(`unknown command: ${command}`, 2)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  print({ error: message }, process.stderr)
  process.exitCode = error instanceof CliError ? error.exitCode : 1
}

async function serve(values: string[]): Promise<void> {
  const host = option(values, '--host') ?? process.env.ISA_SIM_HOST ?? '127.0.0.1'
  const allowRemote = values.includes('--allow-remote')
  validateBindHost(host, allowRemote)
  const portValue = option(values, '--port')
  const backend = await createBackend({
    host,
    allowRemote,
    ...(portValue ? { port: Number(portValue) } : {}),
    ...(option(values, '--data-dir') ? { dataDir: resolve(option(values, '--data-dir')!) } : {}),
  })
  await backend.app.listen({ host: backend.config.host, port: backend.config.port })
  print({ listening: `${backend.config.tlsCertPath ? 'https' : 'http'}://${backend.config.host}:${backend.config.port}` })
  const shutdown = async () => {
    await backend.app.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

async function doctor(): Promise<void> {
  const docker = await probeDocker()
  print({
    node: { available: true, version: process.version, sqlite: true },
    docker,
    wsl: { available: process.platform === 'win32', trustedDevelopmentOnly: true },
  })
  if (!docker.available) process.exitCode = 3
}

async function submit(values: string[]): Promise<void> {
  const path = requiredArg(values, 0, 'JSON input file')
  const input = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
  print(await mutate('/api/jobs', { lane: jobLane(values), input }))
}

async function run(values: string[]): Promise<void> {
  const path = requiredArg(values, 0, 'JSON input file')
  const input = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
  const job = await mutate('/api/jobs', { lane: jobLane(values), input }) as { id?: unknown }
  if (typeof job.id !== 'string') throw new CliError('server returned an invalid job', 4)
  const terminal = await watch(job.id, false)
  if (terminal.state !== 'succeeded') throw new CliError(`job ${terminal.state}`, 5)
  print(terminal.result)
}

async function watch(id: string, output = true): Promise<{ state: string; result?: unknown }> {
  let last = 0
  for (;;) {
    const response = await fetch(`${baseUrl()}/api/jobs/${encodeURIComponent(id)}/events?after=${last}`, {
      headers: { accept: 'text/event-stream' },
    })
    if (!response.ok) throw new CliError(`HTTP ${response.status}: ${await response.text()}`, 4)
    const text = await response.text()
    for (const block of text.split('\n\n')) {
      const data = block.split('\n').find((line) => line.startsWith('data: '))
      if (!data) continue
      const event = JSON.parse(data.slice(6)) as { id: number }
      last = Math.max(last, event.id)
      if (output) print(event)
    }
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`) as {
      state: string
      result?: unknown
    }
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
  }
}

async function artifact(values: string[]): Promise<void> {
  if (values.shift() !== 'download') throw new CliError('usage: artifact download <id> <path>', 2)
  const id = requiredArg(values, 0, 'artifact id')
  const destination = resolve(requiredArg(values, 1, 'destination'))
  const response = await fetch(`${baseUrl()}/api/artifacts/${encodeURIComponent(id)}/download`)
  if (!response.ok) throw new CliError(`HTTP ${response.status}: ${await response.text()}`, 4)
  const temp = `${destination}.${process.pid}.tmp`
  await writeFile(temp, Buffer.from(await response.arrayBuffer()), { flag: 'wx' })
  await rename(temp, destination)
  print({ artifactId: id, path: destination })
}

async function corpus(values: string[]): Promise<void> {
  const action = values.shift() ?? 'list'
  if (!['doctor', 'build', 'verify', 'list'].includes(action)) {
    throw new CliError('usage: corpus <doctor|build|verify|list> [--full] [--target ID] [--workload ID]', 2)
  }
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const code = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(executable, [
      'run', 'corpus', '-w', '@isa-sim/native-benchmarks', '--', action, ...values,
    ], { cwd: resolve(import.meta.dirname, '..', '..'), shell: false, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (status) => resolvePromise(status ?? 1))
  })
  if (code !== 0) throw new CliError(`corpus ${action} exited ${code}`, code)
}

async function api(path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl()}${path}`)
  if (!response.ok) throw new CliError(`HTTP ${response.status}: ${await response.text()}`, 4)
  return response.json()
}

async function mutate(path: string, body?: unknown): Promise<unknown> {
  const sessionResponse = await fetch(`${baseUrl()}/api/session`, { method: 'POST' })
  if (!sessionResponse.ok) throw new CliError(`session HTTP ${sessionResponse.status}`, 4)
  const session = await sessionResponse.json() as { token?: unknown }
  if (typeof session.token !== 'string') throw new CliError('invalid session response', 4)
  const response = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'x-session-token': session.token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new CliError(`HTTP ${response.status}: ${await response.text()}`, 4)
  return response.json()
}

function baseUrl(): string {
  return (process.env.ISA_SIM_URL ?? 'http://127.0.0.1:4317').replace(/\/+$/, '')
}

function jobLane(values: string[]): 'analytical-inorder' | 'analytical-ooo' | 'toolchain-validation' | 'gem5' | 'llvm-mca' | 'champsim' {
  const lane = option(values, '--lane') ?? 'analytical-inorder'
  if (!['analytical-inorder', 'analytical-ooo', 'toolchain-validation', 'gem5', 'llvm-mca', 'champsim'].includes(lane)) {
    throw new CliError('--lane must be analytical-inorder, analytical-ooo, toolchain-validation, gem5, llvm-mca, or champsim', 2)
  }
  return lane as ReturnType<typeof jobLane>
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    )
  }
  return value
}

function print(value: unknown, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`${JSON.stringify(stable(value))}\n`)
}

function requiredArg(values: string[], index: number, name: string): string {
  const value = values[index]
  if (!value) throw new CliError(`missing ${name}`, 2)
  return value
}

function option(values: string[], name: string): string | undefined {
  const index = values.indexOf(name)
  return index >= 0 ? values[index + 1] : undefined
}

function usage(): void {
  process.stdout.write(
    'isa-sim <doctor|health|serve|submit FILE [--lane LANE]|watch ID|cancel ID|run FILE [--lane LANE]|artifact download ID PATH|corpus ACTION>\n',
  )
}

