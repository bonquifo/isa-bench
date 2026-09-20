import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertComparable, ExternalSimulatorResultSchema } from '@isa-sim/contracts'
import {
  assemblerRegion,
  createExternalEnvelope,
  loadExternalCapabilities,
  MICROTRACE_MAX_BYTES,
  MICROTRACE_RECORD_BYTES,
  parseChampSimJson,
  parseExternalRequest,
  parseGem5Stats,
  parseLlvmMcaJson,
  parseRoiMarkers,
  roiCoverageDiagnostic,
  selectEligibleNativeArtifact,
  staticModelRelevance,
  validateGem5Config,
  validateMicrotrace,
  type MicrotraceManifest,
} from './external.js'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const H = hash('fixture')

/**
 * The capability matrix is decided by the checked-in locks, not by whichever
 * container engine happens to be running, so the image probe is stubbed from
 * the same lock. Real local image identity is covered by `external:verify`.
 */
function lockedImageInspector(): (reference: string) => string {
  const lock = JSON.parse(readFileSync(
    [join(process.cwd(), 'external', 'images.lock.json'), join(process.cwd(), '..', 'external', 'images.lock.json')]
      .find(existsSync)!,
    'utf8',
  )) as { images: Record<string, { reference: string; imageId: string }> }
  const byReference = new Map(Object.values(lock.images).map((image) => [image.reference, image.imageId]))
  return (reference) => byReference.get(reference) ?? ''
}

describe('external adapter capability and request isolation', () => {
  it('keeps engines/targets isolated and gives every unavailable target a reason', () => {
    const matrix = loadExternalCapabilities(undefined, lockedImageInspector())
    expect(matrix).toHaveLength(24)
    expect(matrix.every((entry) => entry.reason.length > 0)).toBe(true)
    expect(matrix.filter((entry) => entry.target === 'wasm32-wasip1' || entry.target === 'mos-sim')
      .every((entry) => entry.tier === 'unsupported')).toBe(true)
    expect(matrix.filter((entry) => entry.engine === 'champsim')
      .every((entry) => entry.tier === 'unsupported')).toBe(true)
  })

  it('accepts artifact IDs and rejects host paths, commands, and unknown fields', () => {
    expect(parseExternalRequest({
      lane: 'llvm-mca',
      input: { target: 'x86_64-linux', artifactId: H, iterations: 100 },
    }).input.artifactId).toBe(H)
    expect(() => parseExternalRequest({
      lane: 'gem5',
      input: { target: 'x86_64-linux', artifactId: 'C:\\secret\\binary.exe' },
    })).toThrow('artifactId')
    expect(() => parseExternalRequest({
      lane: 'gem5',
      input: { target: 'x86_64-linux', artifactId: H, command: 'sh' },
    })).toThrow('unknown')
  })

  it('refuses missing, stale, and locally mismatched capability locks', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-lock-test-'))
    try {
      expect(() => loadExternalCapabilities(root, () => '')).toThrow('missing')
      mkdirSync(join(root, 'external'))
      const imageId = `sha256:${H}`
      const images = {
        images: Object.fromEntries(['gem5', 'llvm-mca', 'champsim'].map((engine) =>
          [engine, { reference: `test/${engine}:locked`, imageId }])),
      }
      writeFileSync(join(root, 'external', 'images.lock.json'), JSON.stringify(images))
      writeFileSync(join(root, 'external', 'capabilities.lock.json'), JSON.stringify({
        imagesLockSha256: H,
        observations: {},
      }))
      expect(() => loadExternalCapabilities(root, () => imageId)).toThrow('stale')
      const bytes = Buffer.from(JSON.stringify(images))
      writeFileSync(join(root, 'probe.txt'), 'semantic')
      writeFileSync(join(root, 'external', 'capabilities.lock.json'), JSON.stringify({
        imagesLockSha256: hash(bytes),
        semantics: { 'probe.txt': hash('semantic') },
        observations: {},
      }))
      expect(() => loadExternalCapabilities(root, () => `sha256:${hash('wrong')}`)).toThrow('differs')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the corpus index semantic hash against the data directory, not the repository root', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-lock-root-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'external-lock-data-'))
    try {
      mkdirSync(join(root, 'external'))
      const imageId = `sha256:${H}`
      const images = {
        images: Object.fromEntries(['gem5', 'llvm-mca', 'champsim'].map((engine) =>
          [engine, { reference: `test/${engine}:locked`, imageId }])),
      }
      const bytes = Buffer.from(JSON.stringify(images))
      writeFileSync(join(root, 'external', 'images.lock.json'), bytes)
      mkdirSync(join(dataDir, 'native-corpus'), { recursive: true })
      writeFileSync(join(dataDir, 'native-corpus', 'artifact-index.json'), 'index')
      writeFileSync(join(root, 'external', 'capabilities.lock.json'), JSON.stringify({
        imagesLockSha256: hash(bytes),
        semantics: { '.isa-bench-data/native-corpus/artifact-index.json': hash('index') },
        observations: {},
      }))
      // The packaged desktop app keeps runtime data outside the repository root.
      expect(() => loadExternalCapabilities(root, () => imageId)).toThrow('differs')
      expect(() => loadExternalCapabilities(root, () => imageId, dataDir)).not.toThrow()
      writeFileSync(join(dataDir, 'native-corpus', 'artifact-index.json'), 'rebuilt')
      expect(() => loadExternalCapabilities(root, () => imageId, dataDir)).toThrow('differs')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('classifies static-model relevance by corpus family and never assumes relevance for unknown families', () => {
    expect(staticModelRelevance('integer-stream').level).toBe('high')
    expect(staticModelRelevance('dependent-memory').level).toBe('low')
    expect(staticModelRelevance('comparison-sort').level).toBe('low')
    expect(staticModelRelevance('quantum-annealing').level).toBe('unknown')
  })

  it('rejects native artifact target and content-hash mismatches', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-artifact-test-'))
    const id = hash('artifact')
    try {
      const directory = join(root, 'native-corpus', 'artifacts', id)
      mkdirSync(directory, { recursive: true })
      const binary = Buffer.from('binary')
      const object = Buffer.from('object')
      const disassembly = Buffer.from('disassembly')
      writeFileSync(join(directory, 'benchmark.bin'), binary)
      writeFileSync(join(directory, 'core.o'), object)
      writeFileSync(join(directory, 'disassembly.txt'), disassembly)
      writeFileSync(join(root, 'native-corpus', 'artifact-index.json'), JSON.stringify({
        records: [{
          eligible: true,
          target: 'x86_64-linux',
          artifactDirectory: `ignored/${id}`,
          binarySha256: hash(binary),
          coreObjectSha256: hash(object),
          disassemblySha256: hash(disassembly),
        }],
      }))
      expect(() => selectEligibleNativeArtifact(root, id, 'aarch64-linux')).toThrow('eligible')
      writeFileSync(join(directory, 'core.o'), 'tampered')
      expect(() => selectEligibleNativeArtifact(root, id, 'x86_64-linux')).toThrow('hash mismatch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('external output parsers', () => {
  it('normalizes required gem5 O3/SE metrics without treating missing values as zero', () => {
    const parsed = parseGem5Stats([
      'simTicks 12000',
      'simInsts 1000',
      'simOps 1100',
      'system.cpu.numCycles 400',
      'system.cpu.ipc 2.5',
      'system.cpu.branchPred.condIncorrect 3',
      'system.cpu.dcache.overallMisses::total 7',
      'hostInstRate 9999',
    ].join('\n'))
    expect(parsed.metrics.find((metric) => metric.name === 'simulated_cycles')?.value).toBe('400')
    expect(parsed.metrics.find((metric) => metric.name === 'ipc')?.value).toBe(2.5)
    expect(parsed.metrics.find((metric) => metric.name === 'host_simulation_speed')?.domain)
      .toBe('external-simulator-rate')
    expect(() => parseGem5Stats('simTicks 1\nsimInsts 1\nsimOps 1\n')).toThrow('missing')
    expect(() => parseGem5Stats('simTicks nan\nsimInsts 1\nsimOps 1\nsystem.cpu.numCycles 1\nsystem.cpu.ipc 1'))
      .toThrow('simTicks')
  })

  it('reads only the ROI statistics block that gem5 dumps at isa_bench_roi_end', () => {
    const block = (instructions: number) => [
      '---------- Begin Simulation Statistics ----------',
      'simTicks 9000', `simInsts ${instructions}`, `simOps ${instructions + 1}`,
      'system.cpu.numCycles 18', 'system.cpu.ipc 0.9',
      '---------- End Simulation Statistics   ----------', '',
    ].join('\n')
    const parsed = parseGem5Stats(block(16) + block(446))
    expect(parsed.metrics.find((metric) => metric.name === 'committed_instructions')?.value).toBe('16')
    expect(String(parsed.normalized.roi)).toContain('isa_bench_roi_begin')
    expect(parseRoiMarkers('00000000002011f0 T isa_bench_roi_begin\n00000000002011f1 T isa_bench_roi_end\n'))
      .toEqual({ begin: '0x2011f0', end: '0x2011f1' })
    expect(() => parseRoiMarkers('00000000002011f0 T isa_bench_roi_begin\n')).toThrow('isa_bench_roi_end')
    expect(() => parseRoiMarkers('1 T isa_bench_roi_begin\n1 T isa_bench_roi_end\n')).toThrow('share')
  })

  it('flags an ROI that commits fewer instructions than the workload has elements', () => {
    expect(roiCoverageDiagnostic('16', 512)).toContain('closed form')
    expect(roiCoverageDiagnostic('2048', 512)).toBeUndefined()
    expect(roiCoverageDiagnostic('16', undefined)).toBeUndefined()
  })

  it('requires a fully parsed llvm-mca region, scheduling model, and JSON fields', () => {
    const golden = JSON.stringify({
      CodeRegions: [{
        SummaryView: {
          Iterations: 100,
          Instructions: 400,
          TotalCycles: 106,
          TotaluOps: 400,
          BlockRThroughput: 1,
          DispatchWidth: 6,
        },
        ResourcePressureView: {
          ResourcePressureInfo: [{ ResourceIndex: 999, ResourceUsage: 1.5 }],
        },
      }],
      Errors: [],
      Warnings: [],
    })
    const parsed = parseLlvmMcaJson(golden)
    expect(parsed.metrics.find((metric) => metric.name === 'block_reciprocal_throughput')?.value).toBe(1)
    expect(parsed.metrics.find((metric) => metric.name === 'resource_pressure')?.value).toBe(1.5)
    expect(() => parseLlvmMcaJson('{}')).toThrow('one parsed code region')
    expect(() => parseLlvmMcaJson(golden.replace('"TotalCycles":106,', ''))).toThrow('TotalCycles')
    expect(() => parseLlvmMcaJson(golden.replace('"Warnings":[]', '"Warnings":["unsupported instruction skipped"]')))
      .toThrow('unsupported')
  })

  it('validates the emitted gem5 config by C++ SimObject type and binds it to the requested ISA', () => {
    // Distinct SimObject types observed in config.json from real gem5 25.1.0.0
    // O3/SE runs (image sha256:de43ace0…) of the int_sum corpus binary per ISA.
    // gem5 records the C++ type, so every ISA's O3 wrapper emits BaseO3CPU and
    // the ISA appears only through its own ISA/decoder/MMU objects.
    const observed: Record<string, string[]> = {
      x86_64: ['BaseO3CPU', 'Cache', 'CoherentXBar', 'SimpleMemory', 'SrcClockDomain', 'System', 'TournamentBP',
        'X86Decoder', 'X86EmuLinux', 'X86ISA', 'X86LocalApic', 'X86MMU', 'X86PagetableWalker', 'X86TLB'],
      aarch64: ['ArmDecoder', 'ArmEmuLinux', 'ArmISA', 'ArmInterrupts', 'ArmMMU', 'ArmRelease', 'ArmTLB', 'ArmTableWalker',
        'BaseO3CPU', 'Cache', 'CoherentXBar', 'SimpleMemory', 'SrcClockDomain', 'System', 'TournamentBP'],
      riscv64: ['BaseO3CPU', 'Cache', 'CoherentXBar', 'PMAChecker', 'PMP', 'RiscvDecoder', 'RiscvEmuLinux', 'RiscvISA',
        'RiscvInterrupts', 'RiscvMMU', 'RiscvPagetableWalker', 'RiscvTLB', 'SimpleMemory', 'SrcClockDomain', 'System'],
    }
    const config = (types: string[]) => JSON.stringify({ system: types.map((type) => ({ type })) })
    for (const [isa, types] of Object.entries(observed)) {
      expect(() => validateGem5Config(config(types), isa)).not.toThrow()
      for (const other of Object.keys(observed).filter((candidate) => candidate !== isa)) {
        expect(() => validateGem5Config(config(types), other)).toThrow('lacks')
      }
    }
    const x86 = observed.x86_64!
    expect(() => validateGem5Config(config(x86.filter((type) => type !== 'BaseO3CPU')), 'x86_64')).toThrow('BaseO3CPU')
    expect(() => validateGem5Config(config(x86.filter((type) => type !== 'SimpleMemory')), 'x86_64')).toThrow('SimpleMemory')
    expect(() => validateGem5Config(config([...x86, 'DDR3_1600_8x8']), 'x86_64')).toThrow('DDR3')
    // The Python wrapper name is never emitted; requiring it was the regression
    // that failed every gem5 job while the capability lock still said execute.
    expect(() => validateGem5Config(config(['X86O3CPU', 'X86ISA', 'SimpleMemory']), 'x86_64')).toThrow('BaseO3CPU')
  })

  it('extracts the isa_bench_core ROI exactly as the worker feeds it to llvm-mca', () => {
    const listing = [
      'core.o:\tfile format elf64-x86-64',
      '',
      'Disassembly of section .text:',
      '',
      '<isa_bench_core>:',
      '\tpushq\t%rbp',
      '\tleaq\t16(%rip), %rax  # 0x1234 <isa_bench_roi_begin>',
      '\tcallq\t0x0 <helper>',
      '\tpopq\t%rbp',
      '\tretq',
      '',
      '<other>:',
      '\tnop',
      '',
    ].join('\n')
    expect(assemblerRegion(listing)).toBe([
      '.text', '# LLVM-MCA-BEGIN native-roi',
      'pushq\t%rbp', 'leaq\t16(%rip), %rax', 'callq\t0x0', 'popq\t%rbp', 'retq',
      '# LLVM-MCA-END', '',
    ].join('\n'))
    expect(() => assemblerRegion(listing.replace('\tretq', '\t...'))).toThrow('elided')
    expect(() => assemblerRegion(listing.replace('\tretq', '\t<unknown>'))).toThrow('unknown instruction')
    expect(() => assemblerRegion('<other>:\n\tnop\n')).toThrow('no assembler-compatible')
  })

  it('requires ChampSim counts/cycles and labels committed-path trace semantics', () => {
    const parsed = parseChampSimJson(JSON.stringify({
      instructions: 32,
      cycles: 20,
      ipc: 1.6,
      warmupInstructions: 8,
      simulationInstructions: 32,
      branchMispredictions: 2,
    }))
    expect(parsed.normalized.wrongPathSemanticExecution).toBe(false)
    expect(() => parseChampSimJson('{"instructions":32}')).toThrow('cycles')
    expect(() => parseChampSimJson('{"instructions":32,"cycles":"overflow","ipc":1,"warmupInstructions":0,"simulationInstructions":32}'))
      .toThrow('cycles')
  })
})

describe('microtrace-v1 provenance', () => {
  function fixture(count = 2): { bytes: Buffer; manifest: MicrotraceManifest } {
    const bytes = Buffer.alloc(count * MICROTRACE_RECORD_BYTES)
    for (let index = 0; index < count; index += 1) {
      bytes.writeBigUInt64LE(BigInt(0x400000 + index * 4), index * MICROTRACE_RECORD_BYTES)
      bytes.writeUInt8(1, index * MICROTRACE_RECORD_BYTES + 12)
    }
    return {
      bytes,
      manifest: {
        schema: 'microtrace-v1',
        traceSha256: hash(bytes),
        byteSize: bytes.byteLength,
        recordBytes: 64,
        instructionCount: String(count),
        producer: { name: 'fixture', version: '1.0.0', executableSha256: H },
        isa: 'x86_64',
        registerMapping: 'champsim-input-instr-2026-04',
        endianness: 'little',
        addressWidth: 64,
        roiDefinitionHash: H,
        warmupInstructions: '0',
        simulationInstructions: String(count),
        committedPath: true,
        truncated: false,
      },
    }
  }

  it('accepts exact bounded records and rejects truncation/count/hash/overflow attacks', () => {
    const { bytes, manifest } = fixture()
    expect(() => validateMicrotrace(bytes, manifest)).not.toThrow()
    expect(() => validateMicrotrace(bytes.subarray(0, bytes.length - 1), manifest)).toThrow('truncated')
    expect(() => validateMicrotrace({ byteLength: MICROTRACE_MAX_BYTES + 1 } as Uint8Array, manifest)).toThrow('oversized')
    expect(() => validateMicrotrace(bytes, { ...manifest, instructionCount: '999' })).toThrow('count')
    expect(() => validateMicrotrace(bytes, { ...manifest, traceSha256: H })).toThrow('hash')
    const overflow = Buffer.from(bytes)
    overflow[10] = 255
    expect(() => validateMicrotrace(overflow, { ...manifest, traceSha256: hash(overflow) })).toThrow('register')
    expect(() => validateMicrotrace(bytes, { ...manifest, committedPath: false as true })).toThrow('provenance')
    expect(() => validateMicrotrace(bytes, { ...manifest, unknown: true } as MicrotraceManifest)).toThrow('unknown')
    expect(() => validateMicrotrace(bytes, { ...manifest, instructionCount: '9'.repeat(100) })).toThrow('bounded')
    const invalidBranch = Buffer.from(bytes)
    invalidBranch[9] = 1
    expect(() => validateMicrotrace(invalidBranch, {
      ...manifest,
      traceSha256: hash(invalidBranch),
    })).toThrow('branch')
  })

  it('does not accept archive/path indirection as trace bytes', () => {
    const archive = Buffer.from('PK\u0003\u0004../../host/path')
    const { manifest } = fixture()
    expect(() => validateMicrotrace(archive, {
      ...manifest,
      traceSha256: hash(archive),
      byteSize: archive.byteLength,
      instructionCount: '1',
    })).toThrow('misaligned')
  })
})

describe('external result envelopes and comparison isolation', () => {
  async function envelope(engine: 'gem5' | 'llvm-mca', roi = H) {
    return createExternalEnvelope({
      engine,
      engineVersion: engine === 'gem5' ? '25.1.0.0' : '23.1.0',
      invocation: [engine],
      target: 'x86_64-linux',
      artifactId: H,
      workloadSemanticHash: H,
      pipelineHash: hash(`${engine}-pipeline`),
      roiHash: roi,
      profileHash: hash(`${engine}-profile`),
      rawArtifact: { id: hash(`${engine}-raw`), byteSize: 1, mimeType: 'application/json', filename: 'raw.json' },
      metrics: engine === 'gem5'
        ? [{ name: 'simulated_cycles', domain: 'external-simulator-cycles', unit: 'sim-cycle', value: '10' }]
        : [{ name: 'block_reciprocal_throughput', domain: 'static-throughput-cycles-per-instruction', unit: 'cycles/instruction', value: 1 }],
      normalized: { deterministic: true },
      configuration: {},
    })
  }

  it('produces valid envelopes and prevents cross-kind/ROI comparison', async () => {
    const gem5 = ExternalSimulatorResultSchema.parse(await envelope('gem5'))
    const mca = ExternalSimulatorResultSchema.parse(await envelope('llvm-mca'))
    expect(() => assertComparable([gem5, mca])).toThrow('experimentKind')
    const anotherRoi = ExternalSimulatorResultSchema.parse(await envelope('gem5', hash('other-roi')))
    expect(() => assertComparable([gem5, anotherRoi])).toThrow('roiDefinitionHash')
  })

  it('is byte-identical after excluding documented host diagnostics', async () => {
    const left = await envelope('gem5') as Record<string, unknown>
    const right = await envelope('gem5') as Record<string, unknown>
    const normalize = (value: Record<string, unknown>) => JSON.stringify({ ...value, createdAt: '<excluded>' })
    expect(normalize(left)).toBe(normalize(right))
  })
})
