import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { ArtifactMetadata } from './types.js'

export interface ArtifactRetention {
  count: number
  bytes: number
  ageMs: number
}

export class ArtifactStore {
  readonly root: string

  constructor(root: string, readonly maxBytes: number, readonly retention: ArtifactRetention) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true })
  }

  put(
    body: Uint8Array | string,
    options: { mimeType?: string; filename?: string } = {},
  ): ArtifactMetadata {
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)
    if (bytes.byteLength > this.maxBytes) throw new Error('artifact exceeds size limit')
    const id = createHash('sha256').update(bytes).digest('hex')
    const path = this.path(id)
    mkdirSync(dirname(path), { recursive: true })
    if (!this.exists(id)) {
      const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
      writeFileSync(temp, bytes, { flag: 'wx' })
      try {
        renameSync(temp, path)
      } catch (error) {
        rmSync(temp, { force: true })
        if (!this.exists(id)) throw error
      }
    }
    const metadata: ArtifactMetadata = {
      id,
      sha256: id,
      size: bytes.byteLength,
      mimeType: options.mimeType ?? 'application/octet-stream',
      ...(options.filename ? { filename: sanitizeFilename(options.filename) } : {}),
      createdAt: new Date().toISOString(),
    }
    const metadataPath = `${path}.json`
    if (!this.safeExisting(metadataPath)) {
      const temp = `${metadataPath}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(metadata), { flag: 'wx' })
      try {
        renameSync(temp, metadataPath)
      } catch {
        rmSync(temp, { force: true })
      }
    }
    return this.metadata(id)
  }

  metadata(id: string): ArtifactMetadata {
    const path = this.path(id)
    this.assertSafeFile(path)
    const metadataPath = `${path}.json`
    this.assertSafeFile(metadataPath)
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as ArtifactMetadata
    const size = statSync(path).size
    if (parsed.id !== id || parsed.sha256 !== id || parsed.size !== size) {
      throw new Error('artifact metadata mismatch')
    }
    return parsed
  }

  read(id: string, verify = true): Buffer {
    const path = this.path(id)
    this.assertSafeFile(path)
    const bytes = readFileSync(path)
    if (bytes.byteLength > this.maxBytes) throw new Error('artifact exceeds size limit')
    if (verify && createHash('sha256').update(bytes).digest('hex') !== id) {
      throw new Error('artifact hash mismatch')
    }
    return bytes
  }

  exists(id: string): boolean {
    try {
      this.assertSafeFile(this.path(id))
      return true
    } catch {
      return false
    }
  }

  cleanup(now = Date.now()): string[] {
    const entries: ArtifactMetadata[] = []
    for (const prefix of safeDirectories(this.root)) {
      for (const file of safeFiles(prefix)) {
        if (!file.endsWith('.json')) continue
        try {
          const value = JSON.parse(readFileSync(file, 'utf8')) as ArtifactMetadata
          if (value.id === value.sha256) entries.push(value)
        } catch {
          // Ignore malformed metadata; reads still fail closed.
        }
      }
    }
    entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    let bytes = entries.reduce((sum, item) => sum + item.size, 0)
    const removed: string[] = []
    entries.forEach((item, index) => {
      const expired = now - Date.parse(item.createdAt) > this.retention.ageMs
      if (expired || index >= this.retention.count || bytes > this.retention.bytes) {
        const path = this.path(item.id)
        rmSync(path, { force: true })
        rmSync(`${path}.json`, { force: true })
        bytes -= item.size
        removed.push(item.id)
      }
    })
    return removed
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid artifact id')
    const path = resolve(this.root, id.slice(0, 2), id)
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error('artifact path escapes store')
    return path
  }

  private safeExisting(path: string): boolean {
    try {
      this.assertSafeFile(path)
      return true
    } catch {
      return false
    }
  }

  private assertSafeFile(path: string): void {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('artifact is not a regular file')
    const real = realpathSync(path)
    if (!real.startsWith(`${this.root}${sep}`)) throw new Error('artifact escapes store')
    const descriptor = openSync(real, 'r')
    closeSync(descriptor)
  }
}

function sanitizeFilename(value: string): string {
  const name = value.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? ''
  if (!name || name === '.' || name === '..' || name.includes('\0')) {
    throw new Error('invalid artifact filename')
  }
  return name.slice(0, 255)
}

function safeDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{2}$/.test(entry.name))
    .map((entry) => join(root, entry.name))
}

function safeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => join(root, entry.name))
}
