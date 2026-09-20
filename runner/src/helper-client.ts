import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sha256 } from './identity.js'
import type { HelperClient } from './measurement.js'

export class MeasurementHelperClient implements HelperClient {
  constructor(private readonly executable: string, expectedSha256: string, private readonly timeoutMs = 60_000, private readonly trustedCorpusRoot?: string, private readonly restoreRoot?: string) {
    if (sha256(readFileSync(executable)) !== expectedSha256) throw new Error('measurement helper hash mismatch')
  }
  request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32',
        env: {
          PATH: process.env.PATH ?? '',
          ...(this.trustedCorpusRoot ? { ISA_SIM_TRUSTED_CORPUS_ROOT: this.trustedCorpusRoot } : {}),
          ...(this.restoreRoot ? { ISA_SIM_RESTORE_ROOT: this.restoreRoot } : {}),
        },
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
        else child.kill('SIGKILL')
      }, this.timeoutMs)
      timer.unref()
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > 1024 * 1024) child.kill()
        else stdout.push(chunk)
      })
      let stderrBytes = 0
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stderrBytes <= 64 * 1024) stderr.push(chunk)
        else child.kill('SIGKILL')
      })
      child.once('error', reject)
      child.once('close', () => {
        settled = true
        clearTimeout(timer)
        try {
          const response = JSON.parse(Buffer.concat(stdout).toString('utf8')) as { ok: boolean; value?: unknown; error?: string }
          if (Object.keys(response).sort().join(',') !== (response.ok ? 'ok,value' : 'error,ok')) throw new Error('invalid helper response envelope')
          if (!response.ok) throw new Error(response.error ?? (Buffer.concat(stderr).toString('utf8') || 'helper failed'))
          if (typeof response.value !== 'object' || response.value === null || Array.isArray(response.value)) throw new Error('invalid helper response')
          resolve(response.value as Record<string, unknown>)
        } catch (error) { reject(error) }
      })
      child.stdin.end(JSON.stringify(request))
    })
  }
}
