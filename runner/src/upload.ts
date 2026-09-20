import { openSync, readSync, statSync, closeSync } from 'node:fs'
import { sha256 } from './identity.js'

export interface UploadTransport {
  head(hash: string, totalSize: number): Promise<{ complete: boolean; offset: number }>
  create(hash: string, size: number): Promise<void>
  patch(hash: string, offset: number, bytes: Uint8Array, chunkSha256: string, totalSize: number): Promise<{ offset: number }>
  complete(hash: string, size: number): Promise<void>
}

export async function uploadResumable(path: string, transport: UploadTransport, chunkBytes = 1024 * 1024, maxBytes = 64 * 1024 * 1024): Promise<string> {
  const before = statSync(path)
  const size = before.size
  if (!before.isFile() || size <= 0 || size > maxBytes || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 4 * 1024 * 1024) {
    throw new Error('upload file/chunk size out of bounds')
  }
  const descriptor = openSync(path, 'r')
  try {
    const all = Buffer.allocUnsafe(size)
    readFully(descriptor, all, 0)
    const hash = sha256(all)
    const afterHash = statSync(path)
    if (before.dev !== afterHash.dev || before.ino !== afterHash.ino || before.size !== afterHash.size || before.mtimeMs !== afterHash.mtimeMs) throw new Error('artifact changed while hashing')
    let state = await transport.head(hash, size)
    if (state.complete) return hash
    if (state.offset === 0) await transport.create(hash, size)
    if (state.offset < 0 || state.offset > size) throw new Error('invalid remote upload offset')
    while (state.offset < size) {
      const length = Math.min(chunkBytes, size - state.offset)
      const bytes = Buffer.allocUnsafe(length)
      readFully(descriptor, bytes, state.offset)
      const next = await transport.patch(hash, state.offset, bytes, sha256(bytes), size)
      if (next.offset !== state.offset + length) throw new Error('upload offset mismatch')
      state = { complete: false, offset: next.offset }
    }
    await transport.complete(hash, size)
    const after = statSync(path)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('artifact changed during upload')
    return hash
  } finally {
    closeSync(descriptor)
  }
}

function readFully(descriptor: number, bytes: Buffer, position: number): void {
  let consumed = 0
  while (consumed < bytes.byteLength) {
    const count = readSync(descriptor, bytes, consumed, bytes.byteLength - consumed, position + consumed)
    if (count === 0) throw new Error('artifact changed during upload')
    consumed += count
  }
}
