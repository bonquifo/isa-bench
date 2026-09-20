import { beforeEach, describe, expect, it } from 'vitest'
import { runComparison } from '../engine/compare.ts'
import { IsaId } from '../engine/types.ts'
import {
  LEGACY_SAVE_KEY_V1,
  SAVE_KEY_V2,
  deleteSave,
  loadSaves,
  loadSavesState,
  restoreInput,
  saveRun,
} from './saves.ts'
import { buildLegacyReportView, type LegacyCompareResult } from './reportLegacy.ts'

function stubStorage(failWrites = false) {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new DOMException('quota full', 'QuotaExceededError')
      data.set(key, value)
    },
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
}

const sample = runComparison({
  workloadId: 'int_sum',
  n: 8,
  seed: 7,
  isas: [IsaId.RISCV],
  hardwareMode: 'same',
  profileId: 'equal-inorder',
  customHw: { cores: 2, threads: 2, clockMhz: 1750 },
  cpuByIsa: { riscv: 'riscv-generic' },
})

const sparseLegacyResult: LegacyCompareResult = {
  gold: 55,
  fp: false,
  workloadId: 'custom-c',
  workloadName: 'Old Fibonacci',
  notes: 'created before measurement contracts',
  hardwareMode: 'typical',
  n: 1,
  seed: 1,
  stdout: '55\n',
  rows: [{
    isa: 'riscv',
    hardwareName: 'Old associated preset',
    result: 55,
    cycles: 123,
    instructions: 80,
    cpi: 1.5375,
    disasm: ['old modeled line'],
  }],
}

describe('versioned saved runs', () => {
  beforeEach(() => stubStorage())

  it('roundtrips a complete rerunnable v2 result and input', () => {
    const entry = saveRun('complete', sample)
    const loaded = loadSaves()[0]
    expect(entry.schemaVersion).toBe(2)
    expect(loaded.rerunnable).toBe(true)
    if (!loaded.rerunnable) throw new Error('Expected a rerunnable v2 save')
    expect(loaded.result.rerunInput).toEqual(sample.rerunInput)
    expect(loaded.result.resolvedHardware).toEqual(sample.resolvedHardware)
    expect(loaded.result.rerunInput.customHw).toEqual(sample.rerunInput.customHw)
    expect(restoreInput(loaded)?.resolvedProfileByIsa).toEqual(
      sample.rerunInput.resolvedProfileByIsa,
    )
    expect(restoreInput(loaded)).toEqual({
      ...sample.rerunInput,
      selectedIsas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      n: 8,
      seed: 7,
    })
    expect(deleteSave(entry.id)).toEqual([])
  })

  it('roundtrips tagged IEEE result values without altering model metrics', () => {
    const cases = [
      ['nan', Number.NaN],
      ['positive infinity', Infinity],
      ['negative infinity', -Infinity],
      ['negative zero', -0],
    ] as const
    for (const [name, value] of cases) {
      const special = structuredClone(sample)
      special.fp = true
      special.gold = value
      special.rows[0].result = value
      saveRun(name, special)
    }
    const loaded = loadSaves()
    for (const [name, value] of cases) {
      const saved = loaded.find((entry) => entry.name === name)
      expect(saved?.rerunnable).toBe(true)
      if (!saved?.rerunnable) throw new Error(`Missing ${name}`)
      if (Number.isNaN(value)) expect(Number.isNaN(saved.result.gold)).toBe(true)
      else expect(Object.is(saved.result.gold, value)).toBe(true)
      expect(Object.is(saved.result.rows[0].result, value) || (
        Number.isNaN(value) && Number.isNaN(saved.result.rows[0].result)
      )).toBe(true)
      expect(Number.isFinite(saved.result.rows[0].cycles)).toBe(true)
    }
    expect(localStorage.getItem(SAVE_KEY_V2)).toContain('$isaBench.ieee754')
  })

  it('filters one corrupt entry without erasing valid entries', () => {
    saveRun('valid', sample)
    const store = JSON.parse(localStorage.getItem(SAVE_KEY_V2)!)
    store.entries.push({ schemaVersion: 2, id: 9, result: null })
    localStorage.setItem(SAVE_KEY_V2, JSON.stringify(store))
    const loaded = loadSavesState()
    expect(loaded.saves.map((save) => save.name)).toEqual(['valid'])
    expect(loaded.issues).toContain('Rejected invalid saved-run entry 2.')
  })

  it('rejects malformed v2 result invariants individually', () => {
    saveRun('valid', sample)
    const store = JSON.parse(localStorage.getItem(SAVE_KEY_V2)!)
    const source = store.entries[0]
    const invalid = [
      structuredClone(source),
      structuredClone(source),
      structuredClone(source),
      structuredClone(source),
      structuredClone(source),
      structuredClone(source),
      structuredClone(source),
      structuredClone(source),
      structuredClone(source),
    ]
    invalid[0].id = 'empty-rows'
    invalid[0].result.rows = []
    invalid[1].id = 'bad-isa'
    invalid[1].result.rows[0].isa = 'bogus'
    invalid[2].id = 'bad-metric'
    invalid[2].result.rows[0].cycles = null
    invalid[3].id = 'bad-workload'
    invalid[3].result.workload.kind = 'mystery'
    invalid[4].id = 'bad-profile'
    delete invalid[4].result.resolvedHardware[0].profile.l1d
    invalid[5].id = 'bad-fingerprint'
    invalid[5].result.inputFingerprint = 'fnv1a32:00000000'
    invalid[6].id = 'duplicate-selected'
    invalid[6].result.rerunInput.selectedIsas = ['riscv', 'riscv']
    invalid[7].id = 'profile-isa-mismatch'
    invalid[7].result.resolvedHardware[0].isa = 'arm'
    invalid[8].id = 'bad-contract-enum'
    invalid[8].result.contract.claimScope = 'hardware-measurement'
    store.entries.push(...invalid)
    localStorage.setItem(SAVE_KEY_V2, JSON.stringify(store))
    const loaded = loadSavesState()
    expect(loaded.saves.map((save) => save.name)).toEqual(['valid'])
    expect(loaded.issues.filter((issue) => issue.startsWith('Rejected invalid')).length).toBe(9)
  })

  it('rejects any replay-consumed n, seed, source, or profile mutation', () => {
    saveRun('base replay', sample)
    const fixed = runComparison({
      workloadId: 'c-sum',
      n: 1,
      seed: 2,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    saveRun('fixed replay', fixed)
    const store = JSON.parse(localStorage.getItem(SAVE_KEY_V2)!)
    const base = store.entries.find((entry: { name: string }) => entry.name === 'base replay')
    const fixedEntry = store.entries.find((entry: { name: string }) => entry.name === 'fixed replay')
    const changedN = structuredClone(base)
    changedN.id = 'changed-n'
    changedN.result.rerunInput.n += 1
    const changedSeed = structuredClone(base)
    changedSeed.id = 'changed-seed'
    changedSeed.result.rerunInput.seed += 1
    const changedProfile = structuredClone(base)
    changedProfile.id = 'changed-profile'
    changedProfile.result.rerunInput.resolvedProfileByIsa.riscv.clockMhz += 1
    changedProfile.result.resolvedHardware[0].profile.clockMhz += 1
    const changedSource = structuredClone(fixedEntry)
    changedSource.id = 'changed-source'
    changedSource.result.source += '\n'
    changedSource.result.rerunInput.effectiveSource += '\n'
    changedSource.result.rerunInput.effectiveSourceOverride += '\n'
    store.entries.push(changedN, changedSeed, changedProfile, changedSource)
    localStorage.setItem(SAVE_KEY_V2, JSON.stringify(store))
    const loaded = loadSavesState()
    expect(loaded.saves.map((save) => save.name).sort()).toEqual(['base replay', 'fixed replay'])
    expect(loaded.issues.filter((issue) => issue.startsWith('Rejected invalid'))).toHaveLength(4)
  })

  it('migrates a genuinely sparse v1 result as a viewable non-rerunnable archive', () => {
    localStorage.setItem(LEGACY_SAVE_KEY_V1, JSON.stringify([{
      id: 'old',
      name: 'old report',
      savedAt: 1,
      result: sparseLegacyResult,
    }]))
    const loaded = loadSavesState()
    const legacy = loaded.saves[0]
    expect(legacy).toMatchObject({ schemaVersion: 1, rerunnable: false })
    if (legacy.rerunnable) throw new Error('Expected a legacy archive')
    expect(legacy.result).not.toHaveProperty('contract')
    expect(legacy.result).not.toHaveProperty('workload')
    expect(legacy.result.rows[0]).not.toHaveProperty('completedOperations')
    expect(restoreInput(legacy)).toBeNull()
    const view = buildLegacyReportView(legacy.result)
    expect(view.reference).not.toMatch(/undefined|NaN/)
    expect(view.rows[0].fields.join(' ')).toContain('ARCHIVED OLD-MODEL')
    expect(JSON.stringify(view)).not.toMatch(/undefined|NaN/)
    expect(localStorage.getItem(SAVE_KEY_V2)).not.toBeNull()
  })

  it('propagates quota failures', () => {
    stubStorage(true)
    expect(() => saveRun('fails', sample)).toThrow(/quota full/i)
  })

  it('recovers valid v1 archives when v2 JSON is malformed and persists the merge', () => {
    localStorage.setItem(SAVE_KEY_V2, '{broken')
    localStorage.setItem(LEGACY_SAVE_KEY_V1, JSON.stringify([{
      id: 'recovered',
      name: 'recovered old report',
      savedAt: 2,
      result: sparseLegacyResult,
    }]))
    const loaded = loadSavesState()
    expect(loaded.saves).toHaveLength(1)
    expect(loaded.saves[0]).toMatchObject({ id: 'recovered', rerunnable: false })
    expect(loaded.issues).toContain('Saved-run store contains invalid JSON.')
    expect(JSON.parse(localStorage.getItem(SAVE_KEY_V2)!).entries).toHaveLength(1)
  })

  it('deduplicates legacy IDs already present in valid v2 storage', () => {
    const current = saveRun('current', sample)
    localStorage.setItem(LEGACY_SAVE_KEY_V1, JSON.stringify([{
      id: current.id,
      name: 'duplicate old report',
      savedAt: 1,
      result: sparseLegacyResult,
    }]))
    const loaded = loadSavesState()
    expect(loaded.saves).toHaveLength(1)
    expect(loaded.saves[0].name).toBe('current')
  })
})
