import type { CompareInput, CompareResult, JackProgress } from '../engine/index.ts'
import { ServerJobEventV1Schema, ServerJobRecordV1Schema, decodeTaggedJson, encodeTaggedJson } from '@isa-sim/contracts'

export type BackendMode = 'auto' | 'browser' | 'backend'

export interface BackendJob {
  id: string
  state: 'queued' | 'assigned' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
  version: number
  progress: number
  result: unknown | null
  error: { code: string; message: string } | null
  terminalResultArtifactId?: string
}

export interface LaneCapability {
  id: string
  available: boolean
  reason: string
}

export interface BackendCapabilities {
  lanes: LaneCapability[]
  sandbox: { docker?: { available?: boolean; detail?: string; version?: string } }
  toolchains: {
    available: boolean
    reason: string
    targets?: Array<Record<string, unknown>>
    images?: Record<string, unknown>
  }
  external: Array<{
    engine: 'gem5' | 'llvm-mca' | 'champsim'
    target: string
    tier: 'execute' | 'codegen-only' | 'unsupported'
    reason: string
    image: string
    observed: boolean
  }>
  nativeCorpus: {
    available: boolean
    corpusVersion?: string
    eligible: number
    ineligible: number
    reason?: string
  }
}

export interface CorpusIndex {
  schemaVersion: number
  corpusVersion: string
  generatedAt?: string
  records: Array<Record<string, unknown> & {
    workload: string
    target: string
    eligible: boolean
    artifactDirectory?: string
  }>
}

export interface ArtifactMetadata {
  id: string
  sha256: string
  size: number
  mimeType: string
  filename?: string
  createdAt: string
}

export interface BackendEvent {
  id: number
  jobId: string
  kind: 'state' | 'progress' | 'log' | 'artifact' | 'result' | 'error' | 'cancelled'
  at: string
  data: Record<string, unknown>
}

export class BackendClient {
  private token: string | null = null
  readonly baseUrl: string

  constructor(baseUrl = defaultBackendUrl()) {
    this.baseUrl = baseUrl
  }

  async healthy(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.fetch('/api/health', { signal }, 800)
      return response.ok && (await response.json() as { ok?: unknown }).ok === true
    } catch {
      return false
    }
  }

  async capabilities(signal?: AbortSignal): Promise<BackendCapabilities> {
    return parseResponse<BackendCapabilities>(
      await this.fetch('/api/capabilities', { signal }, 2_500),
    )
  }

  async submit(input: CompareInput, signal?: AbortSignal): Promise<BackendJob> {
    return this.submitJob('analytical-inorder', input, signal)
  }

  async submitJob(
    lane: 'analytical-inorder' | 'analytical-ooo' | 'toolchain-validation' | 'gem5' | 'llvm-mca' | 'champsim',
    input: unknown,
    signal?: AbortSignal,
  ): Promise<BackendJob> {
    const response = await this.authorized('/api/jobs', (token) => ({
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ lane, input: encodeTaggedJson(input) }),
    }), signal)
    return parseJob(await parseResponse<unknown>(response))
  }

  async prepareToolchain(input: CompareInput, targets: string[], signal?: AbortSignal): Promise<BackendJob> {
    return this.authorized('/api/toolchain/prepare', (token) => ({
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ input: encodeTaggedJson(input), targets }),
    }), signal).then(parseResponse<unknown>).then(parseJob)
  }

  async corpus(eligibleOnly = true, signal?: AbortSignal): Promise<CorpusIndex> {
    return parseResponse<CorpusIndex>(
      await this.fetch(`/api/corpus?eligible=${eligibleOnly ? 'true' : 'false'}`, { signal }),
    )
  }

  async empiricalRunners(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    return (await this.adminGet<{ runners: Record<string, unknown>[] }>('/api/empirical/runners', signal)).runners
  }

  async empiricalRuns(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    return (await this.adminGet<{ runs: Record<string, unknown>[] }>('/api/empirical/runs', signal)).runs
  }

  async empiricalOverview(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.adminGet('/api/empirical/overview', signal)
  }

  async calibrationStatus(signal?: AbortSignal): Promise<{
    counts: Record<string, number>
    production: boolean
    approved?: Array<Record<string, unknown>>
  }> {
    return this.adminGet('/api/calibration/status', signal)
  }

  async calibrationImports(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    return (await this.adminGet<{ imports: Record<string, unknown>[] }>('/api/calibration/imports', signal)).imports
  }

  async calibrationCatalog(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.adminGet('/api/calibration/catalog', signal)
  }

  async calibratedPrediction(input: {
    workloadId: string
    target: string
    modelVersion: string
    profileId: string
    simulatorVersion: string
    toolchainHash: string
    corpusId: string
    roiDefinitionHash: string
    workloadSemanticHash: string
    parameters: Record<string, number>
  }, signal?: AbortSignal): Promise<unknown> {
    return this.adminRequest('/api/calibration/predict', input, { signal })
  }

  async adminRequest<T>(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; method?: 'POST' | 'PATCH'; version?: number } = {},
  ): Promise<T> {
    return parseResponse<T>(await this.authorized(path, (token) => ({
      method: options.method ?? 'POST',
      signal: options.signal,
      headers: {
        'content-type': 'application/json',
        'x-session-token': token,
        ...(options.version === undefined ? {} : { 'if-match': String(options.version) }),
      },
      body: JSON.stringify(body),
    }), options.signal))
  }

  async adminRead<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.adminGet(path, signal)
  }

  artifactUrl(id: string): string {
    return `${this.baseUrl}/api/artifacts/${encodeURIComponent(id)}/download`
  }

  async artifactJson(id: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetch(`/api/artifacts/${encodeURIComponent(id)}/download`, { signal })
    if (!response.ok) throw new Error(`Artifact HTTP ${response.status}`)
    return decodeTaggedJson(await response.json())
  }

  corpusArtifactUrl(id: string, file: string): string {
    return `${this.baseUrl}/api/corpus/artifacts/${encodeURIComponent(id)}/download?file=${encodeURIComponent(file)}`
  }

  async getJob(id: string, signal?: AbortSignal): Promise<BackendJob> {
    const job = parseJob(await parseResponse<unknown>(
      await this.fetch(`/api/jobs/${encodeURIComponent(id)}`, { signal }),
    ))
    if (job.state === 'succeeded' && job.terminalResultArtifactId) {
      job.result = await this.artifactJson(job.terminalResultArtifactId, signal)
    }
    return job
  }

  async cancel(id: string, signal?: AbortSignal): Promise<BackendJob> {
    return parseResponse<unknown>(
      await this.authorized(`/api/jobs/${encodeURIComponent(id)}/cancel`, (token) => ({
        method: 'POST',
        signal,
        headers: { 'x-session-token': token },
      }), signal),
    ).then(parseJob)
  }

  async stream(
    id: string,
    onEvent: (event: BackendEvent) => void,
    signal?: AbortSignal,
    after = 0,
  ): Promise<void> {
    const response = await this.fetch(
      `/api/jobs/${encodeURIComponent(id)}/events?after=${after}`,
      { signal, headers: { accept: 'text/event-stream' } },
    )
    if (!response.ok || !response.body) throw new Error(`Backend event stream HTTP ${response.status}`)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let pending = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      pending += chunk.value.replaceAll('\r\n', '\n')
      let boundary = pending.indexOf('\n\n')
      while (boundary >= 0) {
        const block = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const line = block.split('\n').find((item) => item.startsWith('data: '))
        if (line) onEvent(parseEvent(JSON.parse(line.slice(6)) as unknown))
        boundary = pending.indexOf('\n\n')
      }
    }
  }

  async result<T = CompareResult>(id: string, signal?: AbortSignal): Promise<T> {
    const job = await this.getJob(id, signal)
    if (job.state !== 'succeeded' || !job.result) {
      throw new Error(job.error?.message ?? `Backend job ${job.state}`)
    }
    return job.result as T
  }

  private async adminGet<T>(path: string, signal?: AbortSignal): Promise<T> {
    return parseResponse<T>(await this.authorized(path, (token) => ({
      signal,
      headers: { 'x-session-token': token },
    }), signal))
  }

  /**
   * Session tokens expire server-side, so a cached token can become invalid
   * while the window stays open. Any 401 retries exactly once with a freshly
   * minted token before the caller sees an error.
   */
  private async authorized(
    path: string,
    init: (token: string) => RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetch(path, init(await this.session(signal)))
    if (response.status !== 401) return response
    this.token = null
    return this.fetch(path, init(await this.session(signal)))
  }

  private async session(signal?: AbortSignal): Promise<string> {
    if (this.token) return this.token
    const response = await this.fetch('/api/session', { method: 'POST', signal })
    const value = await parseResponse<{ token: string }>(response)
    this.token = value.token
    return value.token
  }

  private fetch(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
    if (!timeoutMs) return globalThis.fetch(`${this.baseUrl}${path}`, init)
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return globalThis.fetch(`${this.baseUrl}${path}`, { ...init, signal })
  }
}

function defaultBackendUrl(): string {
  const origin = globalThis.window?.isaBenchDesktop?.origin
  if (typeof origin === 'string' && origin) return origin.replace(/\/$/, '')
  return envValue('VITE_ISA_BACKEND_URL') ?? ''
}

function envValue(name: string): string | undefined {
  const meta = import.meta as ImportMeta & { env?: Record<string, unknown> }
  const value = meta.env?.[name]
  return typeof value === 'string' ? value : undefined
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Backend HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  return response.json() as Promise<T>
}

function parseJob(value: unknown): BackendJob {
  const parsed = ServerJobRecordV1Schema.parse(value)
  return {
    id: parsed.id,
    state: parsed.state,
    version: Number(parsed.revision),
    progress: parsed.progress,
    result: null,
    error: parsed.error,
    ...(parsed.terminalResultArtifactId ? { terminalResultArtifactId: parsed.terminalResultArtifactId } : {}),
  }
}

function parseEvent(value: unknown): BackendEvent {
  const event = ServerJobEventV1Schema.parse(value)
  const data: Record<string, unknown> = event.type === 'progress'
    ? { fraction: event.fraction, phase: event.phase, detail: event.detail }
    : event.type === 'state' ? { from: event.from, to: event.to, reason: event.reason }
      : event.type === 'log' ? { level: event.level, message: event.message, ...(event.artifact ? { artifact: event.artifact } : {}) }
        : event.type === 'artifact' ? { artifact: event.artifact }
          : event.type === 'done' ? { resultArtifactId: event.resultArtifactId }
            : event.type === 'error' ? { error: event.error, message: event.error.message }
              : { reason: event.reason }
  return {
    id: Number(event.id),
    jobId: event.jobId,
    kind: event.type === 'done' ? 'result' : event.type,
    at: event.at,
    data,
  }
}

export function eventProgress(event: BackendEvent): JackProgress | null {
  if (event.kind !== 'progress') return null
  const fraction = event.data.fraction
  const phase = event.data.phase
  const detail = event.data.detail
  if (typeof fraction !== 'number' || typeof phase !== 'string' || typeof detail !== 'string') return null
  return { ratio: fraction, phase, detail }
}
