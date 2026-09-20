import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ServerJobEventV1Schema,
  ServerJobRecordV1Schema,
  ServerJobRequestV1Schema,
  taggedJsonParse,
  taggedJsonStringify,
} from '@isa-sim/contracts'
import type { EventKind, JobError, JobEvent, JobRecord, JobRequest, JobState } from './types.js'
import { isTerminal } from './types.js'

const transitions: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['assigned', 'cancelled'],
  assigned: ['queued', 'running', 'cancelled'],
  running: ['cancelling', 'succeeded', 'failed'],
  cancelling: ['cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

type Row = Record<string, unknown>

export class JobDatabase {
  readonly sqlite: DatabaseSync
  readonly events = new EventEmitter()

  constructor(path: string, private readonly maxLogBytes = 256 * 1024) {
    mkdirSync(dirname(path), { recursive: true })
    this.sqlite = new DatabaseSync(path)
    this.sqlite.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
        input_json TEXT NOT NULL, result_json TEXT, error_json TEXT, progress REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        assigned_runner_id TEXT, terminal_result_artifact_id TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, at TEXT NOT NULL, data_json TEXT NOT NULL, byte_size INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_job_id_id ON events(job_id, id);
    `)
    this.ensureColumn('assigned_runner_id', 'TEXT')
    this.ensureColumn('terminal_result_artifact_id', 'TEXT')
    this.recoverInterrupted()
  }

  private ensureColumn(name: string, type: string): void {
    const columns = this.sqlite.prepare('PRAGMA table_info(jobs)').all() as Array<{ name?: unknown }>
    if (!columns.some((column) => column.name === name)) this.sqlite.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`)
  }

  close(): void {
    this.sqlite.close()
  }

  private recoverInterrupted(): void {
    const running = this.sqlite.prepare(
      "SELECT id, version FROM jobs WHERE state IN ('assigned','running','cancelling')",
    ).all() as Row[]
    for (const row of running) {
      this.transition(String(row.id), Number(row.version), 'failed', 'server restarted', {
        code: 'interrupted',
        message: 'Job interrupted by server restart',
        interrupted: true,
      })
    }
  }

  create(id: string, request: JobRequest): JobRecord {
    const parsed = ServerJobRequestV1Schema.parse(request)
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO jobs(id,state,version,input_json,created_at,updated_at)
      VALUES(?, 'queued', 0, ?, ?, ?)
    `).run(id, taggedJsonStringify(parsed), now, now)
    this.appendEvent(id, 'state', { from: null, to: 'queued', reason: 'submitted' })
    return this.get(id)!
  }

  list(limit = 100): JobRecord[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)))
    return (this.sqlite.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(safeLimit) as Row[])
      .map(toJob)
  }

  get(id: string): JobRecord | null {
    const row = this.sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined
    return row ? toJob(row) : null
  }

  transition(
    id: string,
    expectedVersion: number,
    next: JobState,
    reason: string,
    payload?: unknown,
  ): JobRecord {
    const current = this.get(id)
    if (!current) throw new Error('job not found')
    if (Number(current.revision) !== expectedVersion) throw new Error('job version conflict')
    if (!transitions[current.state].includes(next)) {
      throw new Error(`invalid job transition ${current.state} -> ${next}`)
    }
    const now = new Date().toISOString()
    const resultArtifactId = next === 'succeeded' ? String(payload) : null
    const error = next === 'failed' ? payload : null
    const changed = this.sqlite.prepare(`
      UPDATE jobs SET state=?, version=version+1, updated_at=?,
        started_at=CASE WHEN ?='running' THEN ? ELSE started_at END,
        finished_at=CASE WHEN ? IN ('succeeded','failed','cancelled') THEN ? ELSE finished_at END,
        progress=CASE WHEN ?='succeeded' THEN 1 ELSE progress END,
        result_json=NULL,
        error_json=CASE WHEN ?='failed' THEN ? ELSE error_json END,
        assigned_runner_id=CASE
          WHEN ?='assigned' THEN 'local-worker'
          WHEN ?='queued' THEN NULL
          ELSE assigned_runner_id END,
        terminal_result_artifact_id=CASE WHEN ?='succeeded' THEN ? ELSE terminal_result_artifact_id END
      WHERE id=? AND version=? AND state=?
    `).run(
      next, now, next, now, next, now, next,
      next, error === null ? null : taggedJsonStringify(error),
      next, next, next, resultArtifactId,
      id, expectedVersion, current.state,
    )
    if (changed.changes !== 1) throw new Error('job version conflict')
    this.appendEvent(id, 'state', { from: current.state, to: next, reason })
    if (next === 'succeeded') this.appendEvent(id, 'done', { resultArtifactId })
    else if (next === 'failed') this.appendEvent(id, 'error', { error })
    else if (next === 'cancelled') this.appendEvent(id, 'cancelled', { reason })
    return this.get(id)!
  }

  setProgress(id: string, fraction: number, phase: string, detail: string): void {
    const job = this.get(id)
    if (!job || isTerminal(job.state) || job.state === 'cancelling') return
    const monotonic = Math.max(job.progress, Math.min(0.999999, Math.max(0, fraction)))
    this.sqlite.prepare('UPDATE jobs SET progress=?, updated_at=? WHERE id=?')
      .run(monotonic, new Date().toISOString(), id)
    this.appendEvent(id, 'progress', { fraction: monotonic, phase, detail })
  }

  appendEvent(jobId: string, kind: EventKind, data: Record<string, unknown>): JobEvent {
    const at = new Date().toISOString()
    let safeData = data
    if (kind === 'log') {
      const message = String(data.message ?? '')
      safeData = { ...data, message: Buffer.from(message).subarray(0, 65_536).toString('utf8') }
    }
    const job = this.get(jobId)
    if (!job) throw new Error('event job not found')
    const provisional = taggedJsonStringify({ kind, safeData })
    const inserted = this.sqlite.prepare(
      'INSERT INTO events(job_id,kind,at,data_json,byte_size) VALUES(?,?,?,?,?)',
    ).run(jobId, kind, at, provisional, Buffer.byteLength(provisional))
    const event = makeEvent(Number(inserted.lastInsertRowid), job, kind, at, safeData)
    const json = taggedJsonStringify(event)
    this.sqlite.prepare('UPDATE events SET data_json=?, byte_size=? WHERE id=?')
      .run(json, Buffer.byteLength(json), Number(inserted.lastInsertRowid))
    if (kind === 'log') this.trimLogs(jobId)
    this.events.emit(jobId, event)
    return event
  }

  private trimLogs(jobId: string): void {
    const row = this.sqlite.prepare(
      "SELECT COALESCE(SUM(byte_size),0) total FROM events WHERE job_id=? AND kind='log'",
    ).get(jobId) as Row
    let total = Number(row.total)
    if (total <= this.maxLogBytes) return
    const logs = this.sqlite.prepare(
      "SELECT id,byte_size FROM events WHERE job_id=? AND kind='log' ORDER BY id",
    ).all(jobId) as Row[]
    const remove = this.sqlite.prepare('DELETE FROM events WHERE id=?')
    for (const log of logs) {
      if (total <= this.maxLogBytes) break
      remove.run(Number(log.id))
      total -= Number(log.byte_size)
    }
  }

  eventReplay(jobId: string, after = 0): JobEvent[] {
    return (this.sqlite.prepare(
      'SELECT * FROM events WHERE job_id=? AND id>? ORDER BY id',
    ).all(jobId, Math.max(0, Math.trunc(after))) as Row[]).map(toEvent)
  }

  purgeJobs(ids: readonly string[]): void {
    const remove = this.sqlite.prepare('DELETE FROM jobs WHERE id=?')
    for (const id of ids) remove.run(id)
  }

  cleanup(retention: { count: number; bytes: number; ageMs: number }, now = Date.now()): string[] {
    const rows = this.sqlite.prepare(`
      SELECT id, finished_at,
        length(input_json)+COALESCE(length(result_json),0)+COALESCE(length(error_json),0) AS bytes
      FROM jobs WHERE state IN ('succeeded','failed','cancelled')
      ORDER BY finished_at DESC
    `).all() as Row[]
    let bytes = rows.reduce((sum, row) => sum + Number(row.bytes), 0)
    const removed: string[] = []
    rows.forEach((row, index) => {
      const age = now - Date.parse(String(row.finished_at))
      if (age > retention.ageMs || index >= retention.count || bytes > retention.bytes) {
        removed.push(String(row.id))
        bytes -= Number(row.bytes)
      }
    })
    this.purgeJobs(removed)
    return removed
  }
}

function parseNullable<T>(value: unknown): T | null {
  return typeof value === 'string' ? taggedJsonParse(value) as T : null
}

function toJob(row: Row): JobRecord {
  return ServerJobRecordV1Schema.parse({
    schemaVersion: 'server-job-v1',
    id: String(row.id),
    state: String(row.state) as JobState,
    revision: String(row.version),
    request: ServerJobRequestV1Schema.parse(taggedJsonParse(String(row.input_json))),
    error: parseNullable<JobError>(row.error_json),
    progress: Number(row.progress),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    ...(typeof row.assigned_runner_id === 'string' ? { assignedRunnerId: row.assigned_runner_id } : {}),
    ...(typeof row.terminal_result_artifact_id === 'string'
      ? { terminalResultArtifactId: row.terminal_result_artifact_id }
      : {}),
  })
}

function toEvent(row: Row): JobEvent {
  return ServerJobEventV1Schema.parse(taggedJsonParse(String(row.data_json)))
}

function makeEvent(
  id: number,
  job: JobRecord,
  kind: EventKind,
  at: string,
  data: Record<string, unknown>,
): JobEvent {
  const base = {
    schemaVersion: 'server-job-event-v1' as const,
    id: String(id),
    jobId: job.id,
    revision: job.revision,
    at,
  }
  if (kind === 'state') {
    return ServerJobEventV1Schema.parse({
      ...base,
      type: kind,
      from: data.from ?? null,
      to: data.to,
      reason: data.reason,
    })
  }
  if (kind === 'progress') return ServerJobEventV1Schema.parse({ ...base, type: kind, ...data })
  if (kind === 'log') {
    return ServerJobEventV1Schema.parse({
      ...base,
      type: kind,
      level: data.level ?? 'info',
      message: data.message ?? '',
      ...(data.artifact ? { artifact: artifactDescriptor(data.artifact) } : {}),
    })
  }
  if (kind === 'artifact') {
    return ServerJobEventV1Schema.parse({ ...base, type: kind, artifact: artifactDescriptor(data.artifact) })
  }
  if (kind === 'done') return ServerJobEventV1Schema.parse({ ...base, type: kind, resultArtifactId: data.resultArtifactId })
  if (kind === 'error') return ServerJobEventV1Schema.parse({ ...base, type: kind, error: data.error })
  return ServerJobEventV1Schema.parse({ ...base, type: 'cancelled', reason: data.reason })
}

function artifactDescriptor(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const item = value as Record<string, unknown>
  return {
    id: item.id,
    sha256: item.sha256,
    byteSize: String(item.size ?? item.byteSize),
    mimeType: item.mimeType,
    role: 'result',
    ...(item.filename ? { filename: item.filename } : {}),
  }
}
