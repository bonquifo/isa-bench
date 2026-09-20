import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import type { ServerConfig } from './types.js'

const loopbackNames = new Set(['localhost', 'ip6-localhost'])

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (loopbackNames.has(normalized) || normalized === '::1') return true
  if (isIP(normalized) === 4) {
    const first = Number(normalized.split('.')[0])
    return first === 127
  }
  return false
}

export function validateBindHost(host: string, allowRemote = false): string {
  const normalized = host.trim()
  if (!normalized) throw new Error('bind address must not be empty')
  if (!allowRemote && !isLoopbackHost(normalized)) {
    throw new Error(`refusing non-loopback bind address "${host}"; use explicit --allow-remote`)
  }
  return normalized
}

export function isAllowedLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`invalid positive integer: ${value}`)
  return parsed
}

const listenPort = (value: string | number | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value)
  if (parsed === 0) return 0
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`invalid listen port: ${value}`)
  return parsed
}

export function resolveRepositoryRoot(explicit?: string): string {
  if (explicit) return resolve(explicit)
  for (const candidate of [resolve(process.cwd()), resolve(process.cwd(), '..')]) {
    if (existsSync(resolve(candidate, 'package.json')) && existsSync(resolve(candidate, 'src/engine/index.ts'))) {
      return candidate
    }
  }
  return resolve(process.cwd())
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const allowRemote = overrides.allowRemote ?? false
  const host = validateBindHost(overrides.host ?? process.env.ISA_SIM_HOST ?? '127.0.0.1', allowRemote)
  const tlsCertPath = overrides.tlsCertPath ?? process.env.ISA_SIM_TLS_CERT
  const tlsKeyPath = overrides.tlsKeyPath ?? process.env.ISA_SIM_TLS_KEY
  const tlsClientCaPath = overrides.tlsClientCaPath ?? process.env.ISA_SIM_TLS_CLIENT_CA
  const adminClientCertFingerprints = overrides.adminClientCertFingerprints ??
    (process.env.ISA_SIM_ADMIN_CERT_FINGERPRINTS ?? '').split(',').map((value) => value.replaceAll(':', '').trim().toLowerCase()).filter(Boolean)
  if (!isLoopbackHost(host) && (!tlsCertPath || !tlsKeyPath || !tlsClientCaPath || adminClientCertFingerprints.length === 0)) {
    throw new Error('remote access requires explicit TLS certificate, key, mTLS client CA, and admin certificate fingerprints')
  }
  return {
    host,
    allowRemote,
    port: listenPort(overrides.port ?? process.env.ISA_SIM_PORT, 4317),
    dataDir: resolve(overrides.dataDir ?? process.env.ISA_SIM_DATA_DIR ?? '.isa-bench-data'),
    repositoryRoot: resolveRepositoryRoot(overrides.repositoryRoot ?? process.env.ISA_SIM_REPOSITORY_ROOT),
    ...(overrides.staticDir || process.env.ISA_SIM_STATIC_DIR
      ? { staticDir: resolve(overrides.staticDir ?? process.env.ISA_SIM_STATIC_DIR!) }
      : {}),
    allowedOrigins: overrides.allowedOrigins ?? [],
    ...(tlsCertPath ? { tlsCertPath: resolve(tlsCertPath) } : {}),
    ...(tlsKeyPath ? { tlsKeyPath: resolve(tlsKeyPath) } : {}),
    ...(tlsClientCaPath ? { tlsClientCaPath: resolve(tlsClientCaPath) } : {}),
    adminClientCertFingerprints,
    sessionTtlMs: overrides.sessionTtlMs ?? 10 * 60_000,
    concurrency: overrides.concurrency ?? positiveInt(process.env.ISA_SIM_CONCURRENCY, 2),
    jobTimeoutMs: overrides.jobTimeoutMs ?? positiveInt(process.env.ISA_SIM_JOB_TIMEOUT_MS, 5 * 60_000),
    maxLogBytes: overrides.maxLogBytes ?? 256 * 1024,
    artifactMaxBytes: overrides.artifactMaxBytes ?? 64 * 1024 * 1024,
    retention: overrides.retention ?? {
      count: 500,
      bytes: 2 * 1024 * 1024 * 1024,
      ageMs: 30 * 24 * 60 * 60_000,
    },
  }
}
