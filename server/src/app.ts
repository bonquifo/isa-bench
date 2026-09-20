import cors from '@fastify/cors'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  PublicServerJobCreateV1Schema,
  ServerJobEventV1Schema,
  ServerJobRecordV1Schema,
  ServerJobRequestV1Schema,
  ToolchainPreparedDescriptorV1Schema,
  ToolchainPreparedPayloadV1Schema,
  decodeTaggedJson,
  encodeTaggedJson,
  taggedJsonStringify,
} from '@isa-sim/contracts'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { ArtifactStore } from './artifacts.js'
import { registerCalibrationRoutes } from './calibration-routes.js'
import { CalibrationStore } from './calibration-store.js'
import { isAllowedLoopbackOrigin, isLoopbackHost, loadConfig } from './config.js'
import { NativeCorpusStore } from './corpus.js'
import { JobDatabase } from './database.js'
import { EmpiricalStore } from './empirical.js'
import { empiricalProtocolPath, registerEmpiricalRoutes, verifyEmpiricalEnvelope } from './empirical-routes.js'
import {
  loadExternalCapabilities,
  parseExternalRequest,
} from './external.js'
import { laneRegistry, resolvedLaneRegistry, JobRunner } from './runner.js'
import { probeDocker, reapManagedContainers } from './sandbox.js'
import { probeToolchains } from './toolchains.js'
import type { JobEvent, ServerConfig } from './types.js'
import { isTerminal } from './types.js'
import { certificateRole } from './tls-role.js'

export interface Backend {
  app: FastifyInstance
  db: JobDatabase
  artifacts: ArtifactStore
  corpus: NativeCorpusStore
  runner: JobRunner
  empirical: EmpiricalStore
  calibration: CalibrationStore
  config: ServerConfig
}

interface Session {
  hash: Buffer
  expiresAt: number
}

export async function createBackend(overrides: Partial<ServerConfig> = {}): Promise<Backend> {
  const config = loadConfig(overrides)
  mkdirSync(config.dataDir, { recursive: true })
  reapManagedContainers()
  const db = new JobDatabase(join(config.dataDir, 'jobs.sqlite'), config.maxLogBytes)
  const artifacts = new ArtifactStore(
    join(config.dataDir, 'artifacts'),
    config.artifactMaxBytes,
    config.retention,
  )
  const corpus = new NativeCorpusStore(config.dataDir)
  artifacts.cleanup()
  db.cleanup(config.retention)
  const runner = new JobRunner(db, artifacts, config)
  const empirical = new EmpiricalStore(db.sqlite)
  const calibration = new CalibrationStore(db.sqlite, config.dataDir, empirical, corpus, process.env.ISA_SIM_CALIBRATION_TEST_ONLY !== '1')
  const tls = config.tlsCertPath && config.tlsKeyPath && config.tlsClientCaPath
    ? {
        https: {
          cert: readFileSync(config.tlsCertPath),
          key: readFileSync(config.tlsKeyPath),
          ca: readFileSync(config.tlsClientCaPath),
          requestCert: true,
          rejectUnauthorized: true,
        },
      }
    : {}
  const app = Fastify({ logger: false, bodyLimit: Math.min(config.artifactMaxBytes, 2 * 1024 * 1024), ...tls })
  const sessions: Session[] = []
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error)
    if (/query|route parameters|canonical unsigned decimal|id is invalid|artifact id is invalid/i.test(message)) {
      void reply.code(400).send({ error: 'invalid_route_input', detail: message })
      return
    }
    // Malformed bodies, unsupported media types and oversized payloads are the
    // caller's fault; reporting them as internal_error hides the real cause.
    const status = (error as { statusCode?: unknown }).statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      void reply.code(status).send({ error: 'invalid_request', detail: message })
      return
    }
    void reply.code(500).send({ error: 'internal_error' })
  })

  await app.register(cors, {
    origin(origin, callback) {
      const allowed = origin === undefined ||
        isAllowedLoopbackOrigin(origin) ||
        config.allowedOrigins.includes(origin)
      callback(null, allowed)
    },
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-session-token', 'x-artifact-filename', 'x-runner-operation', 'last-event-id', 'if-match', 'upload-offset'],
  })

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (origin && !isAllowedLoopbackOrigin(origin) && !config.allowedOrigins.includes(origin)) {
      await reply.code(403).send({ error: 'origin_not_allowed' })
      return
    }
    const adminRead = request.method === 'GET' &&
      (request.url.startsWith('/api/empirical/') || request.url.startsWith('/api/calibration/'))
    if ((['POST', 'PATCH'].includes(request.method) || adminRead) && request.url !== '/api/session' &&
        !empiricalProtocolPath(request.url)) {
      const token = request.headers['x-session-token']
      pruneSessions(sessions)
      if (typeof token !== 'string' || !validSession(sessions, token)) {
        await reply.code(401).send({ error: 'session_required' })
      }
    }
  })

  app.addContentTypeParser('application/offset+octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
  await registerEmpiricalRoutes(app, empirical, config.dataDir, config.artifactMaxBytes, !isLoopbackHost(config.host), config.adminClientCertFingerprints)
  await registerCalibrationRoutes(app, calibration, config.artifactMaxBytes)

  app.get('/api/health', async () => ({
    ok: true,
    service: 'isa-sim-local-backend',
    version: '0.1.0',
    node: process.version,
  }))

  app.get('/api/capabilities', async () => {
    const docker = await probeDocker()
    const toolchains = docker.available
      ? await probeToolchains(undefined, undefined, { root: config.repositoryRoot })
      : { available: false, reason: `Docker unavailable: ${docker.detail}`, targets: [], images: {} }
    let externalCapabilities: ReturnType<typeof loadExternalCapabilities> = []
    let externalUnavailableReason: string | undefined
    try {
      externalCapabilities = loadExternalCapabilities(config.repositoryRoot, undefined, config.dataDir)
    } catch (error) {
      externalUnavailableReason = error instanceof Error ? error.message : String(error)
    }
    return {
      lanes: resolvedLaneRegistry(toolchains).map((lane) => {
        if (lane.id === 'champsim') {
          return { ...lane, available: false, reason: 'import-only: no approved producer-bound trace corpus is installed' }
        }
        if (lane.id === 'empirical-measurement') {
          const empirical = empiricalLaneCapability(db.sqlite,corpus)
          return {
            ...lane,
            available: empirical.available,
            reason: empirical.reason,
          }
        }
        if (lane.id === 'calibrated-prediction') {
          const approved = db.sqlite.prepare("SELECT COUNT(*) count FROM calibration_fits WHERE state='approved'").get() as { count: number }
          return { ...lane, available: Number(approved.count) > 0, reason: Number(approved.count) > 0 ? 'approved calibration is available' : 'no approved calibration is available' }
        }
        if (['gem5', 'llvm-mca'].includes(lane.id) && externalUnavailableReason) {
          return { ...lane, available: false, reason: `external capability unavailable: ${externalUnavailableReason}` }
        }
        const external = externalCapabilities.filter((candidate) => candidate.engine === lane.id)
        return external.length === 0
          ? lane
          : {
              ...lane,
              available: external.some((candidate) => candidate.tier === 'execute'),
              reason: external.some((candidate) => candidate.tier === 'execute')
                ? 'at least one exact target adapter probe passed'
                : 'no exact target adapter probe passed',
            }
      }),
      sandbox: { docker },
      toolchains,
      external: externalCapabilities,
      ...(externalUnavailableReason ? { externalUnavailableReason } : {}),
      nativeCorpus: corpus.capability(),
      traceCorpus: {
        mode: 'import-only',
        available: false,
        approvedPairs: 0,
        reason: 'no approved locked microtrace producer exists',
      },
    }
  })

  app.get('/api/trace-corpus', async () => ({
    schemaVersion: 'trace-corpus-v1',
    mode: 'import-only',
    producerLockAvailable: false,
    records: [],
    reason: 'no approved locked microtrace producer exists; native corpus records are not trace records',
  }))

  app.get('/api/corpus', async (request, reply) => {
    const query = strictQuery(request.query, ['eligible'])
    if (query.eligible !== undefined && query.eligible !== 'true' && query.eligible !== 'false') {
      return reply.code(400).send({ error: 'eligible_must_be_boolean' })
    }
    const index = corpus.list(query.eligible === 'true')
    return index ?? reply.code(404).send({ error: 'native_corpus_not_found' })
  })

  app.get('/api/corpus/select', async (request, reply) => {
    const query = strictQuery(request.query, ['workload', 'target'])
    if (!query.workload || !query.target) {
      return reply.code(400).send({ error: 'workload_and_target_required' })
    }
    const record = corpus.selectEligible(query.workload, query.target)
    return record ?? reply.code(404).send({ error: 'eligible_corpus_artifact_not_found' })
  })

  app.get('/api/corpus/artifacts/:id', async (request, reply) => {
    const id = strictHashId(request.params)
    return corpus.artifact(id) ?? reply.code(404).send({ error: 'corpus_artifact_not_found' })
  })

  app.get('/api/corpus/artifacts/:id/download', async (request, reply) => {
    const id = strictHashId(request.params)
    const { file } = strictQuery(request.query, ['file'])
    if (!file) return reply.code(400).send({ error: 'file_required' })
    const artifact = corpus.readArtifact(id, file)
    if (!artifact) return reply.code(404).send({ error: 'corpus_artifact_not_found' })
    reply.header('content-type', 'application/octet-stream')
    reply.header('content-length', String(artifact.bytes.byteLength))
    reply.header('content-disposition', `attachment; filename="${artifact.filename}"`)
    return reply.send(artifact.bytes)
  })

  app.post('/api/toolchain/prepare', async (request, reply) => {
    try {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object')
      const value = body as Record<string, unknown>
      if (Object.keys(value).some((key) => !['input', 'targets'].includes(key))) {
        throw new Error('only high-level input and targets are accepted; host paths and commands are forbidden')
      }
      if (!Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 8 ||
          value.targets.some((target) => typeof target !== 'string') ||
          new Set(value.targets).size !== value.targets.length) {
        throw new Error('targets must contain 1..8 target IDs')
      }
      const capability = resolvedLaneRegistry(await probeToolchains())
        .find((lane) => lane.id === 'toolchain-validation')
      if (!capability?.available) {
        return reply.code(422).send({ error: 'capability_unavailable', detail: capability?.reason })
      }
      const prepared = await prepareToolchainInput(decodeTaggedJson(value.input), value.targets as string[])
      const job = db.create(randomUUID(), ServerJobRequestV1Schema.parse({
        schemaVersion: 'server-job-request-v1',
        lane: 'toolchain-validation',
        input: prepared,
      }))
      runner.enqueue(job.id)
      return reply.code(202).header('location', `/api/jobs/${job.id}`).send(apiJob(job))
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_toolchain_prepare_request',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/session', async (request, reply) => {
    const socket = request.socket as typeof request.socket & { getPeerCertificate?: () => { fingerprint256?: string } }
    const fingerprint = socket.getPeerCertificate?.().fingerprint256?.replaceAll(':', '').toLowerCase()
    if (fingerprint) {
      const mappedRunner = db.sqlite.prepare('SELECT id FROM empirical_runners WHERE cert_fingerprint=?').get(fingerprint)
      if (mappedRunner) return reply.code(403).send({ error: 'runner_certificate_cannot_admin' })
    }
    if (!isLoopbackHost(request.ip)) {
      if (certificateRole(fingerprint, config.adminClientCertFingerprints) !== 'admin') {
        return reply.code(403).send({ error: 'admin_mtls_required' })
      }
    }
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + config.sessionTtlMs
    sessions.push({ hash: digestToken(token), expiresAt })
    pruneSessions(sessions)
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  })

  app.post('/api/artifacts', async (request, reply) => {
    if (!(request.body instanceof Uint8Array) || request.body.byteLength === 0) {
      return reply.code(400).send({ error: 'nonempty_binary_artifact_required' })
    }
    const filename = request.headers['x-artifact-filename']
    if (filename !== undefined && typeof filename !== 'string') {
      return reply.code(400).send({ error: 'artifact_filename_must_be_singular' })
    }
    try {
      return reply.code(201).send(artifacts.put(request.body, {
        mimeType: 'application/octet-stream',
        ...(filename ? { filename } : {}),
      }))
    } catch (error) {
      return reply.code(400).send({ error: 'invalid_artifact', detail: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post('/api/trace-corpus', async (request, reply) => {
    void request
    return reply.code(422).send({
      error: 'approved_trace_producer_required',
      detail: 'trace import is disabled until a locked producer identity and approval policy are configured',
    })
  })

  app.post('/api/jobs', async (request, reply) => {
    const body = parseJobBody(request.body)
    if (!body.ok) return reply.code(400).send({ error: 'invalid_request', detail: body.error })
    let capability = laneRegistry.find((lane) => lane.id === body.value.lane)
    if (['gem5', 'llvm-mca', 'champsim'].includes(body.value.lane)) {
      if (body.value.lane === 'champsim') {
        return reply.code(422).send({
          error: 'capability_unavailable',
          lane: 'champsim',
          detail: 'no approved producer-bound trace corpus pair exists',
        })
      }
      let external: ReturnType<typeof parseExternalRequest>
      try {
        external = parseExternalRequest(body.value)
      } catch (error) {
        return reply.code(400).send({
          error: 'invalid_request',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
      // A missing image lock or an unreachable container engine means the lane is
      // unavailable, not that the request was malformed or the server broke.
      let matrix: ReturnType<typeof loadExternalCapabilities>
      try {
        matrix = loadExternalCapabilities(config.repositoryRoot, undefined, config.dataDir)
      } catch (error) {
        return reply.code(422).send({
          error: 'capability_unavailable',
          lane: external.lane,
          detail: `external capability unavailable: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      const target = matrix.find((candidate) =>
        candidate.engine === external.lane && candidate.target === external.input.target)
      capability = target?.tier === 'execute'
        ? { id: external.lane, available: true, reason: target.reason }
        : { id: external.lane, available: false, reason: target?.reason ?? 'external target was not probed' }
    }
    if (!capability?.available) {
      return reply.code(422).send({
        error: 'capability_unavailable',
        lane: body.value.lane,
        detail: capability?.reason ?? 'unknown lane',
      })
    }
    const job = db.create(randomUUID(), ServerJobRequestV1Schema.parse({
      schemaVersion: 'server-job-request-v1',
      ...body.value,
    }))
    runner.enqueue(job.id)
    return reply.code(202).header('location', `/api/jobs/${job.id}`).send(apiJob(job))
  })

  app.get('/api/jobs', async (request) => {
    const query = strictQuery(request.query, ['limit'])
    const limit = query.limit === undefined ? 100 : strictUnsigned(query.limit, 'limit', 1, 1000)
    return { jobs: db.list(limit).map(apiJob) }
  })

  app.get('/api/jobs/:id', async (request, reply) => {
    const id = strictId(request.params)
    const job = db.get(id)
    return job ? apiJob(job) : reply.code(404).send({ error: 'job_not_found' })
  })

  app.post('/api/jobs/:id/cancel', async (request, reply) => {
    const id = strictId(request.params)
    const existing = db.get(id)
    if (!existing) return reply.code(404).send({ error: 'job_not_found' })
    const expected = parseIfMatch(request)
    if (expected !== null && expected !== Number(existing.revision)) {
      return reply.code(409).send({ error: 'revision_conflict', currentRevision: existing.revision })
    }
    const cancelled = runner.cancel(id)
    return cancelled ? apiJob(cancelled) : reply.code(404).send({ error: 'job_not_found' })
  })

  app.get('/api/jobs/:id/events', async (request, reply) => {
    const id = strictId(request.params)
    const job = db.get(id)
    if (!job) return reply.code(404).send({ error: 'job_not_found' })
    const query = strictQuery(request.query, ['after'])
    const headerId = request.headers['last-event-id']
    const afterValue = query.after ?? (typeof headerId === 'string' ? headerId : '0')
    const after = strictUnsigned(afterValue, 'after', 0, Number.MAX_SAFE_INTEGER)
    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8')
    reply.raw.setHeader('cache-control', 'no-cache, no-transform')
    reply.raw.setHeader('connection', 'keep-alive')
    let lastSent = after
    let replaying = true
    const buffered: JobEvent[] = []
    let heartbeat: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat)
      db.events.off(id, listener)
    }
    const finish = () => {
      cleanup()
      if (!reply.raw.writableEnded) reply.raw.end()
    }
    const listener = (event: JobEvent) => {
      if (replaying) {
        buffered.push(event)
        return
      }
      if (Number(event.id) <= lastSent) return
      writeSse(reply.raw, event)
      lastSent = Number(event.id)
      if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') finish()
    }
    db.events.on(id, listener)
    for (const event of db.eventReplay(id, lastSent)) {
      writeSse(reply.raw, event)
      lastSent = Number(event.id)
    }
    replaying = false
    for (const event of buffered) listener(event)
    const refreshed = db.get(id)
    if (refreshed && isTerminal(refreshed.state)) {
      finish()
      return
    }
    heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000)
    heartbeat.unref()
    request.raw.once('close', cleanup)
  })

  app.get('/api/artifacts/:id', async (request, reply) => {
    const id = strictHashId(request.params)
    try {
      return artifacts.metadata(id)
    } catch {
      return reply.code(404).send({ error: 'artifact_not_found' })
    }
  })

  app.get('/api/artifacts/:id/download', async (request, reply) => {
    const id = strictHashId(request.params)
    try {
      const metadata = artifacts.metadata(id)
      const bytes = artifacts.read(id)
      reply.header('content-type', metadata.mimeType)
      reply.header('content-length', String(bytes.byteLength))
      reply.header('etag', `"sha256-${id}"`)
      reply.header(
        'content-disposition',
        `attachment; filename="${(metadata.filename ?? id).replaceAll('"', '')}"`,
      )
      return reply.send(bytes)
    } catch {
      return reply.code(404).send({ error: 'artifact_not_found' })
    }
  })

  app.addHook('onClose', async () => {
    await runner.close()
    db.close()
  })

  runner.resumeQueued()
  if (config.staticDir) registerDesktopUi(app, config.staticDir)
  return { app, db, artifacts, corpus, runner, empirical, calibration, config }
}

function registerDesktopUi(app: FastifyInstance, staticDir: string): void {
  const root = resolve(staticDir)
  if (!existsSync(join(root, 'index.html'))) throw new Error('desktop UI staticDir must contain index.html')
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.map': 'application/json',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }
  app.get('/', async (_request, reply) => reply.type(types['.html']!).send(readFileSync(join(root, 'index.html'))))
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'not_found' })
    }
    const relative = normalize(decodeURIComponent(request.url.split('?')[0] ?? '/')).replace(/^[/\\]+/, '')
    const absolute = resolve(root, relative)
    if (!absolute.startsWith(`${root}${sep}`) && absolute !== root) {
      return reply.code(404).send({ error: 'not_found' })
    }
    if (existsSync(absolute)) {
      return reply.type(types[extname(absolute)] ?? 'application/octet-stream').send(readFileSync(absolute))
    }
    return reply.type(types['.html']!).send(readFileSync(join(root, 'index.html')))
  })
}

export function empiricalLaneCapability(sqlite:{prepare(sql:string):{all(...values:unknown[]):unknown[]}},corpus:NativeCorpusStore):{available:boolean;reason:string}{
  const eligible=corpus.list(true)?.records??[]
  if(eligible.length===0)return{available:false,reason:'eligible native corpus is unavailable'}
  const now=new Date().toISOString()
  const rows=sqlite.prepare(`SELECT r.id,r.key_id,r.public_key,m.envelope_json FROM empirical_runners r JOIN empirical_manifests m ON m.runner_id=r.id
    WHERE r.state='approved' AND r.credential_expires_at>? AND m.expires_at>? AND m.sequence=(SELECT MAX(m2.sequence) FROM empirical_manifests m2 WHERE m2.runner_id=r.id AND m2.expires_at>?)`).all(now,now,now) as Array<{id:string;key_id:string;public_key:string;envelope_json:string}>
  if(rows.length===0)return{available:false,reason:'no approved runner has a current signed capability manifest'}
  for(const row of rows){try{const envelope=JSON.parse(row.envelope_json) as {algorithm?:unknown;signature?:unknown;payload?:{manifest?:Record<string,unknown>}},manifest=envelope.payload?.manifest;verifyEmpiricalEnvelope(envelope,row.public_key,row.key_id);if(!manifest||manifest.runnerId!==row.id||Date.parse(String(manifest.expiresAt))<=Date.now())continue
    const host=manifest.host as Record<string,{status?:string;value?:unknown}>,cpu=manifest.cpu as Record<string,{status?:string;value?:unknown}>,clock=manifest.clock as {status?:string}
    if(clock?.status!=='supported'||cpu?.topology?.status!=='supported'||host?.os?.status!=='supported'||host?.arch?.status!=='supported'||host?.abi?.status!=='supported')continue
    const os=String((host.os.value as {platform?:unknown})?.platform),arch=canonicalEmpiricalIsa(String(host.arch.value)),abi=String(host.abi.value)
    if(eligible.some(record=>corpusTargetCompatible(String(record.target),String(record.triple??''),arch,os,abi)))return{available:true,reason:'approved runner, current compatible manifest, and eligible corpus are available'}
  }catch{/* malformed persisted capability is unavailable */}}
  return{available:false,reason:'current runner manifests do not match eligible corpus ISA/OS/ABI or baseline clock/topology'}
}
function canonicalEmpiricalIsa(value:string):string{return value==='x64'||value==='x86_64'?'x86_64':value==='arm64'||value==='aarch64'?'aarch64':value}
function corpusTargetCompatible(target:string,triple:string,arch:string,os:string,abi:string):boolean{
  const targetOs=target.endsWith('-linux')?'linux':target.includes('windows')?'win32':'',targetArch=canonicalEmpiricalIsa(target.split('-')[0]??''),normalizedOs=os==='windows'?'win32':os
  const abiCompatible=abi==='gnu'?triple.includes('gnu')||targetOs==='linux':abi==='msvc'?triple.includes('msvc')||target.includes('windows'):triple.includes(abi)
  return targetArch===arch&&targetOs===normalizedOs&&abiCompatible
}

function parseJobBody(value: unknown):
  | { ok: true; value: { lane: 'analytical-inorder' | 'analytical-ooo' | 'gem5' | 'llvm-mca' | 'champsim'; input: unknown; timeoutMs?: number } }
  | { ok: false; error: string } {
  try {
    const body = PublicServerJobCreateV1Schema.parse(value)
    if (['gem5', 'llvm-mca', 'champsim'].includes(body.lane)) {
      parseExternalRequest(body)
    }
    return { ok: true, value: { ...body, input: decodeTaggedJson(body.input) } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function writeSse(stream: NodeJS.WritableStream, event: JobEvent): void {
  const parsed = ServerJobEventV1Schema.parse(event)
  stream.write(`id: ${parsed.id}\nevent: ${parsed.type}\ndata: ${taggedJsonStringify(parsed)}\n\n`)
}

function apiJob(value: unknown): unknown {
  return encodeTaggedJson(ServerJobRecordV1Schema.parse(value))
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

function validSession(sessions: Session[], token: string): boolean {
  const candidate = digestToken(token)
  return sessions.some((session) =>
    session.expiresAt > Date.now() &&
    candidate.byteLength === session.hash.byteLength &&
    timingSafeEqual(candidate, session.hash),
  )
}

function pruneSessions(sessions: Session[]): void {
  const now = Date.now()
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    if (sessions[index]!.expiresAt <= now) sessions.splice(index, 1)
  }
  if (sessions.length > 128) sessions.splice(0, sessions.length - 128)
}

function parseIfMatch(request: FastifyRequest): number | null {
  const value = request.headers['if-match']
  if (typeof value !== 'string') return null
  const normalized = value.replace(/^W\//, '').replaceAll('"', '')
  return /^(?:0|[1-9][0-9]{0,15})$/.test(normalized) ? Number.parseInt(normalized, 10) : -1
}

function strictQuery(value: unknown, allowed: readonly string[]): Record<string, string | undefined> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('query must be an object')
  const query = value as Record<string, unknown>
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw new Error('unknown query parameter')
  for (const item of Object.values(query)) {
    if (item !== undefined && typeof item !== 'string') throw new Error('query values must be singular strings')
  }
  return query as Record<string, string | undefined>
}

function strictUnsigned(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value)) throw new Error(`${name} must be a canonical unsigned decimal`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} is out of range`)
  return parsed
}

function strictId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) {
    throw new Error('route parameters are invalid')
  }
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('id is invalid')
  return id
}

function strictHashId(value: unknown): string {
  const id = strictId(value)
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('artifact id is invalid')
  return id
}

export async function prepareToolchainInput(input: unknown, targets: string[]): Promise<Record<string, unknown>> {
  // Dynamic imports keep the strict server project independent from the browser build graph.
  const comparePath = new URL('../../src/engine/compare.ts', import.meta.url).href
  const irPath = new URL('../../src/engine/ir.ts', import.meta.url).href
  const emitterPath = new URL('../../src/toolchains/llvmEmitter.ts', import.meta.url).href
  const compare = await import(comparePath) as {
    buildInput(value: unknown): {
      ir: unknown
      memory: ArrayBuffer
      fp: boolean
    }
    cloneMem(value: ArrayBuffer): ArrayBuffer
  }
  const interpreter = await import(irPath) as {
    interpretIr(program: unknown, memory: ArrayBuffer): { value: number; stdout: string }
  }
  const emitter = await import(emitterPath) as {
    LLVM_EMITTER_VERSION: string
    emitCanonicalLlvmIr(program: unknown): string
  }
  const built = compare.buildInput(input)
  const reference = interpreter.interpretIr(built.ir, compare.cloneMem(built.memory))
  const rawBits = referenceBits(reference.value, built.fp)
  const payload = ToolchainPreparedPayloadV1Schema.parse({
    canonicalIr: emitter.emitCanonicalLlvmIr(built.ir),
    targets,
    memoryBytes: built.memory.byteLength,
    emitterVersion: emitter.LLVM_EMITTER_VERSION,
    expectedFrame: {
      kind: built.fp ? 'binary64' : 'i32',
      rawBits: rawBits.toString(16).padStart(16, '0'),
      stdoutBase64: Buffer.from(reference.stdout, 'latin1').toString('base64'),
    },
  })
  return ToolchainPreparedDescriptorV1Schema.parse({
    schemaVersion: 'toolchain-prepared-v1',
    payload,
    payloadSha256: createHash('sha256').update(taggedJsonStringify(payload)).digest('hex'),
  })
}

function referenceBits(value: number, fp: boolean): bigint {
  if (!fp) return BigInt(value >>> 0)
  const bytes = new ArrayBuffer(8)
  const view = new DataView(bytes)
  view.setFloat64(0, value, true)
  return view.getBigUint64(0, true)
}
