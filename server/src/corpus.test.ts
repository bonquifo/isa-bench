import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeCorpusStore } from './corpus.js'

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe('native corpus read-only store', () => {
  it('reports absence and selects only eligible records', () => {
    const root = mkdtempSync(join(tmpdir(), 'isa-corpus-store-'))
    roots.push(root)
    const store = new NativeCorpusStore(root)
    expect(store.capability()).toMatchObject({ available: false, eligible: 0 })
    const corpus = join(root, 'native-corpus')
    mkdirSync(corpus, { recursive: true })
    writeFileSync(join(corpus, 'artifact-index.json'), JSON.stringify({
      schemaVersion: 1,
      corpusVersion: '1.0.0',
      records: [
        { workload: 'int_sum', target: 'x86_64-linux', eligible: true },
        { workload: 'fp_sum', target: 'mos-sim', eligible: false, reason: 'unsupported' },
      ],
    }))
    expect(store.capability()).toMatchObject({ available: true, eligible: 1, ineligible: 1 })
    expect(store.selectEligible('int_sum', 'x86_64-linux')).not.toBeNull()
    expect(store.selectEligible('fp_sum', 'mos-sim')).toBeNull()
    expect(store.list(true)?.records).toHaveLength(1)
  })

  it('serves only indexed immutable artifact files', () => {
    const root = mkdtempSync(join(tmpdir(), 'isa-corpus-artifact-'))
    roots.push(root)
    const id = 'a'.repeat(64)
    const directory = join(root, 'native-corpus', 'artifacts', id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'record.json'), JSON.stringify({
      workload: 'int_sum', target: 'x86_64-linux', eligible: true,
    }))
    writeFileSync(join(directory, 'core.o'), 'core')
    const store = new NativeCorpusStore(root)
    const metadata = store.artifact(id)
    expect(metadata?.files).toEqual([{
      name: 'core.o',
      bytes: 4,
      sha256: createHash('sha256').update('core').digest('hex'),
    }])
    expect(store.readArtifact(id, 'core.o')?.bytes.toString()).toBe('core')
    expect(store.readArtifact(id, '../core.o')).toBeNull()
    expect(store.artifact('../bad')).toBeNull()
  })
})
