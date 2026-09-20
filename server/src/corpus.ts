import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

interface CorpusRecord {
  workload: string
  target: string
  eligible: boolean
  reason?: string
  artifactDirectory?: string
  [key: string]: unknown
}

interface CorpusIndex {
  schemaVersion: number
  corpusVersion: string
  generatedAt?: string
  counts?: unknown
  records: CorpusRecord[]
}

export class NativeCorpusStore {
  readonly root: string

  constructor(dataDirectory: string) {
    this.root = resolve(dataDirectory, 'native-corpus')
  }

  capability(): {
    available: boolean
    corpusVersion?: string
    eligible: number
    ineligible: number
    reason?: string
  } {
    const index = this.index()
    if (!index) {
      return { available: false, eligible: 0, ineligible: 0, reason: 'native corpus has not been built' }
    }
    const eligible = index.records.filter((record) => record.eligible).length
    return {
      available: eligible > 0,
      corpusVersion: index.corpusVersion,
      eligible,
      ineligible: index.records.length - eligible,
      ...(eligible === 0 ? { reason: 'native corpus has no eligible artifacts' } : {}),
    }
  }

  list(eligibleOnly = false): CorpusIndex | null {
    const index = this.index()
    if (!index || !eligibleOnly) return index
    return { ...index, records: index.records.filter((record) => record.eligible) }
  }

  selectEligible(workload: string, target: string): CorpusRecord | null {
    return this.index()?.records.find((record) =>
      record.eligible && record.workload === workload && record.target === target
    ) ?? null
  }

  artifact(id: string): { record: CorpusRecord; files: Array<{ name: string; bytes: number; sha256: string }> } | null {
    if (!/^[a-f0-9]{64}$/.test(id)) return null
    const directory = this.artifactDirectory(id)
    const recordPath = join(directory, 'record.json')
    if (!existsSync(recordPath)) return null
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as CorpusRecord
    if (!record.eligible) return null
    const files = readdirSync(directory)
      .filter((name) => name !== 'record.json' && /^[A-Za-z0-9_.-]+$/.test(name))
      .map((name) => {
        const path = join(directory, name)
        const bytes = statSync(path).size
        const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
        return { name, bytes, sha256 }
      })
    return { record, files }
  }

  readArtifact(id: string, file: string): { bytes: Buffer; filename: string } | null {
    const metadata = this.artifact(id)
    if (!metadata || basename(file) !== file || !metadata.files.some((entry) => entry.name === file)) return null
    return { bytes: readFileSync(join(this.artifactDirectory(id), file)), filename: file }
  }

  private index(): CorpusIndex | null {
    const path = join(this.root, 'artifact-index.json')
    if (!existsSync(path)) return null
    const value = JSON.parse(readFileSync(path, 'utf8')) as CorpusIndex
    if (value.schemaVersion !== 1 || !Array.isArray(value.records)) return null
    return value
  }

  private artifactDirectory(id: string): string {
    const path = resolve(this.root, 'artifacts', id)
    const parent = `${resolve(this.root, 'artifacts')}${sep}`
    if (!path.startsWith(parent)) throw new Error('artifact path escaped corpus root')
    return path
  }
}
