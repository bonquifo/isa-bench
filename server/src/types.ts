import type {
  ServerJobEventV1,
  ServerJobRecordV1,
  ServerJobRequestV1,
} from '@isa-sim/contracts'

export type JobState = ServerJobRecordV1['state']
export type TerminalState = Extract<JobState, 'succeeded' | 'failed' | 'cancelled'>

export interface AnalyticalJobInput {
  lane?: 'analytical-inorder' | 'analytical-ooo'
  input: unknown
  timeoutMs?: number
}

export type JobRecord = ServerJobRecordV1
export type JobRequest = ServerJobRequestV1

export interface JobError {
  code: string
  message: string
  interrupted?: boolean
}

export type EventKind = ServerJobEventV1['type']
export type JobEvent = ServerJobEventV1

export interface ArtifactMetadata {
  id: string
  sha256: string
  size: number
  mimeType: string
  filename?: string
  createdAt: string
}

export interface ServerConfig {
  host: string
  allowRemote: boolean
  port: number
  dataDir: string
  repositoryRoot: string
  staticDir?: string
  allowedOrigins: string[]
  tlsCertPath?: string
  tlsKeyPath?: string
  tlsClientCaPath?: string
  adminClientCertFingerprints: string[]
  sessionTtlMs: number
  concurrency: number
  jobTimeoutMs: number
  maxLogBytes: number
  artifactMaxBytes: number
  retention: { count: number; bytes: number; ageMs: number }
}

export const terminalStates = new Set<JobState>(['succeeded', 'failed', 'cancelled'])

export const isTerminal = (state: JobState): state is TerminalState => terminalStates.has(state)
