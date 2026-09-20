import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import {
  ExternalSimulatorResultSchema,
  buildComparisonGroupKey,
  canonicalJson,
  type JsonValue,
} from '@isa-sim/contracts'

export const EXTERNAL_ADAPTER_VERSION = '1.1.0'
export const MICROTRACE_VERSION = 'microtrace-v1'
export const MICROTRACE_RECORD_BYTES = 64
export const MICROTRACE_MAX_BYTES = 256 * 1024 * 1024
export const MICROTRACE_LAYOUT = Object.freeze({
  ip: [0, 8],
  isBranch: [8, 1],
  branchTaken: [9, 1],
  destinationRegisters: [10, 2],
  sourceRegisters: [12, 4],
  destinationMemory: [16, 2, 8],
  sourceMemory: [32, 4, 8],
} as const)

export type ExternalEngine = 'gem5' | 'llvm-mca' | 'champsim'
export type ExternalTarget = 'x86_64-linux' | 'aarch64-linux' | 'riscv64-linux' |
  'mipsel-o32' | 'powerpc64le-elfv2' | 'sparc-v8' | 'wasm32-wasip1' | 'mos-sim'

export interface ExternalCapability {
  engine: ExternalEngine
  target: ExternalTarget
  tier: 'execute' | 'codegen-only' | 'unsupported'
  reason: string
  image: string
  observed: boolean
}

export interface ExternalRequest {
  lane: ExternalEngine
  input: {
    target: ExternalTarget
    artifactId: string
    manifestArtifactId?: string
    iterations?: number
    cpu?: string
    features?: string
  }
  timeoutMs?: number
}

export interface MicrotraceManifest {
  schema: typeof MICROTRACE_VERSION
  traceSha256: string
  byteSize: number
  recordBytes: typeof MICROTRACE_RECORD_BYTES
  instructionCount: string
  producer: { name: string; version: string; executableSha256: string }
  isa: 'x86_64'
  registerMapping: 'champsim-input-instr-2026-04'
  endianness: 'little'
  addressWidth: 64
  roiDefinitionHash: string
  warmupInstructions: string
  simulationInstructions: string
  committedPath: true
  truncated: false
}

const MICROTRACE_MANIFEST_FIELDS = new Set([
  'schema', 'traceSha256', 'byteSize', 'recordBytes', 'instructionCount', 'producer',
  'isa', 'registerMapping', 'endianness', 'addressWidth', 'roiDefinitionHash',
  'warmupInstructions', 'simulationInstructions', 'committedPath', 'truncated',
])
const MICROTRACE_PRODUCER_FIELDS = new Set(['name', 'version', 'executableSha256'])

const TARGETS: Record<ExternalTarget, {
  triple: string
  abi: string
  endianness: 'little' | 'big'
  addressWidth: 16 | 32 | 64
  mcaCpu: string
  mcaFeatures: string
}> = {
  'x86_64-linux': { triple: 'x86_64-unknown-linux-gnu', abi: 'SysV AMD64', endianness: 'little', addressWidth: 64, mcaCpu: 'x86-64', mcaFeatures: '' },
  'aarch64-linux': { triple: 'aarch64-unknown-linux-gnu', abi: 'AAPCS64', endianness: 'little', addressWidth: 64, mcaCpu: 'generic', mcaFeatures: '' },
  'riscv64-linux': { triple: 'riscv64-unknown-linux-gnu', abi: 'lp64d', endianness: 'little', addressWidth: 64, mcaCpu: 'generic-rv64', mcaFeatures: '+m,+a,+f,+d,+c' },
  'mipsel-o32': { triple: 'mipsel-unknown-linux-gnu', abi: 'o32', endianness: 'little', addressWidth: 32, mcaCpu: 'mips32', mcaFeatures: '' },
  'powerpc64le-elfv2': { triple: 'powerpc64le-unknown-linux-gnu', abi: 'ELFv2', endianness: 'little', addressWidth: 64, mcaCpu: 'ppc64le', mcaFeatures: '' },
  'sparc-v8': { triple: 'sparc-unknown-linux-gnu', abi: 'SPARC V8', endianness: 'big', addressWidth: 32, mcaCpu: 'v8', mcaFeatures: '' },
  'wasm32-wasip1': { triple: 'wasm32-wasip1', abi: 'WASI Preview 1', endianness: 'little', addressWidth: 32, mcaCpu: 'generic', mcaFeatures: '' },
  'mos-sim': { triple: 'mos-unknown-unknown', abi: 'llvm-mos freestanding', endianness: 'little', addressWidth: 16, mcaCpu: 'generic', mcaFeatures: '' },
}

export function parseExternalRequest(value: unknown): ExternalRequest {
  if (!record(value) || typeof value.lane !== 'string' || !['gem5', 'llvm-mca', 'champsim'].includes(value.lane) ||
      !record(value.input)) throw new Error('external request requires a valid lane and input object')
  if (Object.keys(value).some((key) => !['lane', 'input', 'timeoutMs'].includes(key))) {
    throw new Error('unknown external request property')
  }
  const input = value.input
  if (typeof input.target !== 'string' || !(input.target in TARGETS)) throw new Error('unknown external target')
  if (!sha(input.artifactId)) throw new Error('artifactId must be a lowercase SHA-256; host paths are forbidden')
  const allowed = new Set(['target', 'artifactId', 'manifestArtifactId', 'iterations', 'cpu', 'features'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('unknown external input property')
  const iterations = input.iterations === undefined ? 100 : input.iterations
  if (typeof iterations !== 'number' || !Number.isSafeInteger(iterations) ||
      iterations < 1 || iterations > 1_000_000) {
    throw new Error('iterations must be an integer in 1..1000000')
  }
  for (const key of ['cpu', 'features'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 256 ||
        !/^[A-Za-z0-9_+.,=-]*$/.test(input[key]))) throw new Error(`${key} is invalid`)
  }
  if (input.manifestArtifactId !== undefined && !sha(input.manifestArtifactId)) {
    throw new Error('manifestArtifactId must be a lowercase SHA-256')
  }
  if (value.lane === 'champsim' && input.target !== 'x86_64-linux') {
    throw new Error('ChampSim microtrace-v1 mapping is only valid for x86_64-linux')
  }
  const lane = value.lane as ExternalEngine
  const target = input.target as ExternalTarget
  if (lane === 'gem5' && (input.manifestArtifactId !== undefined || input.cpu !== undefined ||
      input.features !== undefined || input.iterations !== undefined)) {
    throw new Error('gem5 accepts only a native artifact and target')
  }
  if (lane === 'llvm-mca' && input.manifestArtifactId !== undefined) {
    throw new Error('llvm-mca does not accept a trace manifest')
  }
  if (lane === 'llvm-mca' &&
      ((input.cpu !== undefined && input.cpu !== TARGETS[target].mcaCpu) ||
       (input.features !== undefined && input.features !== TARGETS[target].mcaFeatures))) {
    throw new Error('llvm-mca CPU/features must match the observed locked profile')
  }
  if (lane === 'champsim' && (input.manifestArtifactId === undefined || input.iterations !== undefined ||
      input.cpu !== undefined || input.features !== undefined)) {
    throw new Error('ChampSim requires exactly trace and manifest artifacts')
  }
  const timeoutMs = value.timeoutMs === undefined ? undefined : value.timeoutMs
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 || timeoutMs > 30 * 60_000)) {
    throw new Error('timeoutMs must be an integer in 100..1800000')
  }
  return {
    lane,
    input: {
      target,
      artifactId: input.artifactId,
      ...(typeof input.manifestArtifactId === 'string' ? { manifestArtifactId: input.manifestArtifactId } : {}),
      iterations,
      ...(typeof input.cpu === 'string' ? { cpu: input.cpu } : {}),
      ...(typeof input.features === 'string' ? { features: input.features } : {}),
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

export function loadExternalCapabilities(
  root = process.cwd(),
  inspectImage: (reference: string) => string = (reference) =>
    execFileSync('docker', ['image', 'inspect', reference, '--format', '{{.Id}}'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
  dataDir?: string,
): ExternalCapability[] {
  const lockPath = [resolve(root, 'external/capabilities.lock.json'), resolve(root, '../external/capabilities.lock.json')]
    .find(existsSync)
  if (!lockPath) throw new Error('external capability lock is missing; run verify:external')
  const externalRoot = resolve(lockPath, '..')
  const imagesPath = resolve(externalRoot, 'images.lock.json')
  if (!existsSync(imagesPath)) throw new Error('external image lock is missing')
  const imageBytes = readFileSync(imagesPath)
  const images = JSON.parse(imageBytes.toString('utf8')) as {
    images?: Record<string, { reference?: string; imageId?: string }>
  }
  const observed = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    imagesLockSha256?: string
    semantics?: Record<string, string>
    observations?: Record<string, { tier?: string; reason?: string }>
  }
  if (observed.imagesLockSha256 !== digest(imageBytes)) {
    throw new Error('external capability lock is stale or mismatched to images.lock.json')
  }
  const repositoryRoot = resolve(externalRoot, '..')
  // Runtime data such as the native corpus index lives under the data
  // directory, which the packaged desktop app keeps outside the repository
  // root. Lock keys stay repository-relative; only their resolution moves.
  const dataRoot = dataDir ? resolve(dataDir) : resolve(repositoryRoot, '.isa-bench-data')
  if (!observed.semantics || Object.keys(observed.semantics).length === 0) {
    throw new Error('external capability lock lacks executable semantic hashes')
  }
  for (const [path, expected] of Object.entries(observed.semantics)) {
    const dataRelative = path.startsWith('.isa-bench-data/') ? path.slice('.isa-bench-data/'.length) : undefined
    const base = dataRelative === undefined ? repositoryRoot : dataRoot
    const absolute = resolve(base, dataRelative ?? path)
    if (!absolute.startsWith(`${base}${sep}`) || !existsSync(absolute) ||
        !sha(expected) || digest(readFileSync(absolute)) !== expected) {
      throw new Error(`external capability lock semantic hash differs for ${path}`)
    }
  }
  for (const engine of ['gem5', 'llvm-mca', 'champsim']) {
    const locked = images.images?.[engine]
    if (!locked?.reference || !/^sha256:[a-f0-9]{64}$/.test(String(locked.imageId))) {
      throw new Error(`external image lock lacks ${engine}`)
    }
    const local = inspectImage(locked.reference)
    if (local !== locked.imageId) throw new Error(`${engine} local image identity differs from lock`)
  }
  const image = {
    gem5: String(images.images?.gem5?.imageId),
    'llvm-mca': String(images.images?.['llvm-mca']?.imageId),
    champsim: String(images.images?.champsim?.imageId),
  } as const
  const capabilities: ExternalCapability[] = []
  for (const engine of ['gem5', 'llvm-mca', 'champsim'] as const) {
    for (const target of Object.keys(TARGETS) as ExternalTarget[]) {
      const explicitUnsupported = target === 'wasm32-wasip1' || target === 'mos-sim' ||
        engine === 'champsim'
      const key = `${engine}:${target}`
      const result = observed.observations?.[key]
      const passing = result?.tier === 'execute'
      capabilities.push({
        engine,
        target,
        tier: explicitUnsupported || !passing ? 'unsupported' : 'execute',
        reason: explicitUnsupported
          ? engine === 'champsim'
            ? 'import-only: no locked first-party dynamic trace producer is allowlisted'
            : 'external adapter explicitly does not support WASM or MOS'
          : passing
            ? String(result.reason ?? 'exact checked-in execution probe passed')
            : String(result?.reason ?? 'no exact checked-in adapter execution probe passed'),
        image: image[engine],
        observed: passing,
      })
    }
  }
  return capabilities
}

export function selectEligibleNativeArtifact(dataDir: string, artifactId: string, target: ExternalTarget): {
  directory: string
  record: Record<string, unknown>
  binary: string
  object: string
  disassembly: string
} {
  if (!sha(artifactId)) throw new Error('invalid native artifact ID')
  const corpusRoot = resolve(dataDir, 'native-corpus')
  const index = JSON.parse(readFileSync(resolve(corpusRoot, 'artifact-index.json'), 'utf8')) as {
    records?: Array<Record<string, unknown>>
  }
  const selected = index.records?.find((candidate) =>
    candidate.eligible === true && candidate.target === target &&
    basename(String(candidate.artifactDirectory ?? '')) === artifactId)
  if (!selected) throw new Error('artifact is not an eligible native corpus artifact for the requested target')
  const directory = resolve(corpusRoot, 'artifacts', artifactId)
  if (!directory.startsWith(`${resolve(corpusRoot, 'artifacts')}${sep}`)) throw new Error('artifact escaped corpus root')
  const binary = resolve(directory, 'benchmark.bin')
  const object = resolve(directory, 'core.o')
  const disassembly = resolve(directory, 'disassembly.txt')
  verifyFile(binary, String(selected.binarySha256))
  verifyFile(object, String(selected.coreObjectSha256))
  verifyFile(disassembly, String(selected.disassemblySha256))
  if (!record(selected.roiDescriptor) ||
      selected.roiDescriptor.schemaVersion !== 1 ||
      selected.roiDescriptor.symbol !== 'isa_bench_core' ||
      selected.roiDescriptor.markerBegin !== 'isa_bench_roi_begin' ||
      selected.roiDescriptor.markerEnd !== 'isa_bench_roi_end' ||
      selected.roiDescriptor.staticAnalysisScope !== 'core-symbol-only' ||
      selected.roiDescriptor.executionScope !== 'whole-process-static-binary' ||
      selected.roiDescriptor.coreObjectSha256 !== selected.coreObjectSha256 ||
      !sha(selected.roiHash) ||
      digest(Buffer.from(canonicalJson(selected.roiDescriptor as JsonValue))) !== selected.roiHash) {
    throw new Error('native artifact ROI descriptor/hash is missing or mismatched')
  }
  return { directory, record: selected, binary, object, disassembly }
}

export function validateMicrotrace(bytes: Uint8Array, manifest: MicrotraceManifest): void {
  if (!record(manifest) || Object.keys(manifest).some((key) => !MICROTRACE_MANIFEST_FIELDS.has(key)) ||
      !record(manifest.producer) || Object.keys(manifest.producer).some((key) => !MICROTRACE_PRODUCER_FIELDS.has(key))) {
    throw new Error('microtrace manifest contains unknown schema fields')
  }
  if (manifest.schema !== MICROTRACE_VERSION || manifest.recordBytes !== MICROTRACE_RECORD_BYTES ||
      manifest.isa !== 'x86_64' || manifest.registerMapping !== 'champsim-input-instr-2026-04' ||
      manifest.endianness !== 'little' || manifest.addressWidth !== 64 ||
      manifest.committedPath !== true || manifest.truncated !== false) {
    throw new Error('microtrace provenance or mapping is not eligible for ChampSim')
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MICROTRACE_MAX_BYTES ||
      !Number.isSafeInteger(manifest.byteSize) || manifest.byteSize < 1 || bytes.byteLength !== manifest.byteSize ||
      bytes.byteLength % MICROTRACE_RECORD_BYTES !== 0) throw new Error('microtrace is truncated, oversized, or misaligned')
  if (digest(bytes) !== manifest.traceSha256) throw new Error('microtrace hash mismatch')
  const count = BigInt(bytes.byteLength / MICROTRACE_RECORD_BYTES)
  const instructionCount = boundedDecimal(manifest.instructionCount, 'instructionCount')
  const warmup = boundedDecimal(manifest.warmupInstructions, 'warmupInstructions')
  const simulation = boundedDecimal(manifest.simulationInstructions, 'simulationInstructions')
  if (simulation === 0n || instructionCount !== count || warmup + simulation > count) {
    throw new Error('microtrace instruction/warmup/simulation count mismatch')
  }
  if (!sha(manifest.roiDefinitionHash) || !sha(manifest.producer.executableSha256)) {
    throw new Error('microtrace provenance hashes are invalid')
  }
  if (typeof manifest.producer.name !== 'string' || manifest.producer.name.length < 1 ||
      manifest.producer.name.length > 128 || typeof manifest.producer.version !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(manifest.producer.version)) {
    throw new Error('microtrace producer identity is invalid')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset < bytes.byteLength; offset += MICROTRACE_RECORD_BYTES) {
    view.getBigUint64(offset + MICROTRACE_LAYOUT.ip[0], true)
    const branch = view.getUint8(offset + MICROTRACE_LAYOUT.isBranch[0])
    const taken = view.getUint8(offset + MICROTRACE_LAYOUT.branchTaken[0])
    if (branch > 1 || taken > 1 || (taken === 1 && branch === 0)) throw new Error('microtrace branch flags are invalid')
    for (let index = MICROTRACE_LAYOUT.destinationRegisters[0];
      index < MICROTRACE_LAYOUT.sourceRegisters[0] + MICROTRACE_LAYOUT.sourceRegisters[1]; index += 1) {
      if (view.getUint8(offset + index) > 67) throw new Error('microtrace register mapping overflow')
    }
    for (const [start, count, width] of [MICROTRACE_LAYOUT.destinationMemory, MICROTRACE_LAYOUT.sourceMemory]) {
      for (let index = 0; index < count; index += 1) view.getBigUint64(offset + start + index * width, true)
    }
  }
}

export function parseGem5Stats(text: string): { metrics: MetricInput[]; normalized: Record<string, JsonValue> } {
  // gem5 appends one block per dump. The ROI dump at isa_bench_roi_end comes
  // first; the automatic dump at process exit that follows covers only
  // result-frame emission and is deliberately ignored.
  const roiBlock = text.split(/^-{10} End Simulation Statistics\s+-{10}$/m)[0] ?? ''
  const stats = new Map<string, string>()
  for (const line of roiBlock.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9_.:]+)\s+([-+0-9.eE]+)(?:\s|$)/)
    if (match) stats.set(match[1]!, match[2]!)
  }
  const ticks = integerStat(stats, ['simTicks'])
  const cycles = integerStat(stats, ['system.cpu.numCycles', 'system.cpu0.numCycles'])
  const instructions = integerStat(stats, ['simInsts', 'system.cpu.commitStats0.numInsts', 'system.cpu.committedInsts'])
  const ops = integerStat(stats, ['simOps', 'system.cpu.commitStats0.numOps', 'system.cpu.committedOps'])
  const ipc = finiteStat(stats, ['system.cpu.ipc', 'system.cpu.commitStats0.ipc'])
  const metrics: MetricInput[] = [
    metric('simulated_ticks', 'external-simulator-ticks', 'sim-tick', ticks),
    metric('simulated_cycles', 'external-simulator-cycles', 'sim-cycle', cycles),
    metric('committed_instructions', 'external-simulator-count', 'count', instructions),
    metric('committed_ops', 'external-simulator-count', 'count', ops),
    metric('ipc', 'external-simulator-ratio', 'ratio', ipc),
  ]
  optionalCounter(stats, metrics, 'branch_misses', ['system.cpu.branchPred.condIncorrect', 'system.cpu.branchPred.BTBMisses'])
  optionalCounter(stats, metrics, 'l1d_misses', ['system.cpu.dcache.overallMisses::total'])
  optionalCounter(stats, metrics, 'l2_misses', ['system.l2.overallMisses::total'])
  optionalCounter(stats, metrics, 'dram_accesses', ['system.mem_ctrl.dram.numReads', 'system.mem_ctrl.dram.numWrites'])
  const speed = optionalFinite(stats, ['hostInstRate', 'hostOpRate'])
  if (speed !== undefined) metrics.push(metric('host_simulation_speed', 'external-simulator-rate', 'sim-instructions/s', speed))
  return {
    metrics,
    normalized: {
      label: 'execution-driven O3 syscall-emulation',
      roi: 'isa_bench_roi_begin to isa_bench_roi_end: statistics reset at the first commit of the begin marker and dumped at the first commit of the end marker',
      hostDiagnosticsSeparate: true,
    },
  }
}

export function parseLlvmMcaJson(text: string): { metrics: MetricInput[]; normalized: Record<string, JsonValue> } {
  const root = JSON.parse(text) as unknown
  if (!record(root) || !Array.isArray(root.CodeRegions) || root.CodeRegions.length !== 1) {
    throw new Error('llvm-mca JSON must contain exactly one parsed code region')
  }
  const diagnostic = JSON.stringify({ errors: root.Errors, warnings: root.Warnings })
  if (/unsupported|skipp?ed|invalid instruction|no scheduling model/i.test(diagnostic) ||
      (Array.isArray(root.Errors) && root.Errors.length > 0)) throw new Error('llvm-mca reported an unsupported or skipped instruction')
  const region = root.CodeRegions[0]
  if (!record(region) || !record(region.SummaryView)) throw new Error('llvm-mca region lacks SummaryView')
  const summary = region.SummaryView
  const iterations = decimal(summary.Iterations, 'Iterations')
  const instructions = decimal(summary.Instructions, 'Instructions')
  const cycles = decimal(summary.TotalCycles, 'TotalCycles')
  const uops = decimal(summary.TotaluOps, 'TotaluOps')
  const throughput = finite(summary.BlockRThroughput, 'BlockRThroughput')
  const width = finite(summary.DispatchWidth, 'DispatchWidth')
  if (!record(region.ResourcePressureView) || !Array.isArray(region.ResourcePressureView.ResourcePressureInfo)) {
    throw new Error('llvm-mca scheduling model lacks resource pressure')
  }
  const pressure = sumPressure(region.ResourcePressureView.ResourcePressureInfo)
  return {
    metrics: [
      metric('iterations', 'static-throughput-count', 'count', iterations),
      metric('instructions', 'static-throughput-count', 'count', instructions),
      metric('total_cycles', 'static-throughput-cycles', 'static-cycle', cycles),
      metric('total_uops', 'static-throughput-count', 'count', uops),
      metric('block_reciprocal_throughput', 'static-throughput-cycles-per-instruction', 'cycles/instruction', throughput),
      metric('dispatch_width', 'static-throughput-width', 'instructions/cycle', width),
      metric('resource_pressure', 'static-throughput-pressure', 'resource-cycles/iteration', pressure),
    ],
    normalized: { label: 'static scheduling-model estimate', completeInstructionParse: true },
  }
}

/**
 * Extracts the `isa_bench_core` region of an llvm-objdump listing as llvm-mca
 * input. Shared by the capability probe and the job worker so the tier a lock
 * advertises is decided by the same parse the production path runs.
 */
export function assemblerRegion(disassembly: string): string {
  // `<unknown>` is bracket-delimited, so no word boundary applies around it; a
  // `\b` there never matches after whitespace and silently disabled this check.
  if (/<unknown>|\bunknown opcode\b/i.test(disassembly)) throw new Error('native object disassembly contains an unknown instruction')
  const body = disassembly.match(/<isa_bench_core>:\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/)?.[1] ?? ''
  if (body.split(/\r?\n/).some((line) => line.trim() === '...')) {
    throw new Error('native ROI disassembly was skipped or elided')
  }
  const instructions = body.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s+([A-Za-z.][^\r\n]*)$/)
    return match ? [match[1]!.replace(/\s+#\s+0x[0-9a-f]+\s+<[^>]+>\s*$/i, '')
      .replace(/\s+<[^>]+>/g, '').trim()] : []
  })
  if (instructions.length === 0) throw new Error('native object yielded no assembler-compatible isa_bench_core instructions')
  return ['.text', '# LLVM-MCA-BEGIN native-roi', ...instructions, '# LLVM-MCA-END', ''].join('\n')
}

/**
 * Reads the ROI marker addresses from an `llvm-nm` listing of an eligible
 * corpus binary. gem5 scopes its statistics to the window between the first
 * commit of each marker, so both must be present, distinct text symbols.
 */
export function parseRoiMarkers(listing: string): { begin: string; end: string } {
  const find = (symbol: string): string => {
    const match = listing.match(new RegExp(`^([0-9a-f]+)\\s+T\\s+${symbol}$`, 'mi'))
    if (!match) throw new Error(`native binary lacks the ${symbol} text symbol`)
    return `0x${BigInt(`0x${match[1]!}`).toString(16)}`
  }
  const begin = find('isa_bench_roi_begin')
  const end = find('isa_bench_roi_end')
  if (begin === end) throw new Error('native binary ROI markers share one address')
  return { begin, end }
}

/**
 * A per-element kernel must commit at least one instruction per element, so
 * an ROI that commits fewer instructions than the workload's `n` did not run
 * the loop the workload describes: the compiler reduced it to a closed form.
 * The result is still reported; this caveat travels with it.
 */
export function roiCoverageDiagnostic(committedInstructions: string, n: unknown): string | undefined {
  const committed = Number(committedInstructions)
  if (!Number.isSafeInteger(n) || !Number.isFinite(committed) || committed >= (n as number)) return undefined
  return `ROI committed ${committed} instructions for n=${n}: the compiled kernel does not iterate per element (likely reduced to a closed form), so this result describes the reduced code rather than the described workload`
}

/**
 * Checks the `config.json` gem5 emits alongside `stats.txt`. gem5 records the
 * C++ SimObject type, not the Python wrapper class: X86O3CPU, ArmO3CPU, and
 * RiscvO3CPU all emit BaseO3CPU, so the O3 model and the ISA are separate
 * assertions rather than one conflated token.
 */
export function validateGem5Config(text: string, isa: string): void {
  const parsed = JSON.parse(text) as unknown
  const flattened = JSON.stringify(parsed)
  const isaToken = isa === 'x86_64' ? 'X86ISA' : isa === 'aarch64' ? 'ArmISA' : 'RiscvISA'
  for (const token of ['"type":"BaseO3CPU"', `"type":"${isaToken}"`, 'SimpleMemory']) {
    if (!flattened.includes(token)) throw new Error(`gem5 emitted config lacks ${token}`)
  }
  if (/DDR3/i.test(flattened)) throw new Error('gem5 emitted config unexpectedly claims DDR3 memory')
}

/**
 * How much a static llvm-mca scheduling estimate can say about a corpus
 * workload family. llvm-mca models port pressure and dependency latency for a
 * straight-line block; it assumes every load hits and never models branch
 * outcomes, so kernels dominated by memory latency or data-dependent control
 * flow get a number that is precise about the wrong thing. Families outside
 * this table are reported as unknown rather than silently assumed relevant.
 */
export function staticModelRelevance(family: string): { level: 'high' | 'low' | 'unknown'; note: string } {
  const streaming = new Set(['integer-reduction', 'integer-mac', 'integer-stream', 'integer-filter', 'binary64-reduction', 'integer-mix'])
  const memoryOrControlBound = new Set(['dependent-memory', 'word-copy', 'integer-matrix', 'prime-sieve', 'search', 'comparison-sort'])
  if (streaming.has(family)) {
    return { level: 'high', note: 'streaming arithmetic over sequential data is what a static scheduling model describes' }
  }
  if (memoryOrControlBound.has(family)) {
    return { level: 'low', note: 'behaviour is dominated by memory latency or data-dependent branches, which llvm-mca does not model' }
  }
  return { level: 'unknown', note: 'this workload family has no recorded static-model relevance' }
}

export function parseChampSimJson(text: string): { metrics: MetricInput[]; normalized: Record<string, JsonValue> } {
  const root = JSON.parse(text) as unknown
  if (!record(root)) throw new Error('ChampSim output must be a JSON object')
  const required = ['instructions', 'cycles', 'ipc', 'warmupInstructions', 'simulationInstructions'] as const
  for (const key of required) if (!(key in root)) throw new Error(`ChampSim output missing ${key}`)
  const metrics: MetricInput[] = [
    metric('committed_path_trace_instructions', 'external-simulator-count', 'count', decimal(root.instructions, 'instructions')),
    metric('simulated_cycles', 'external-simulator-cycles', 'sim-cycle', decimal(root.cycles, 'cycles')),
    metric('ipc', 'external-simulator-ratio', 'ratio', finite(root.ipc, 'ipc')),
    metric('warmup_instructions', 'external-simulator-count', 'count', decimal(root.warmupInstructions, 'warmupInstructions')),
    metric('simulation_instructions', 'external-simulator-count', 'count', decimal(root.simulationInstructions, 'simulationInstructions')),
  ]
  for (const key of ['branches', 'branchMispredictions', 'l1dMisses', 'l2Misses', 'llcMisses', 'dramAccesses']) {
    if (root[key] !== undefined) metrics.push(metric(key, 'external-simulator-count', 'count', decimal(root[key], key)))
  }
  return { metrics, normalized: { label: 'committed-path trace-driven simulation', wrongPathSemanticExecution: false } }
}

type MetricInput = {
  name: string
  domain: string
  unit: string
  value: string | number
}

export async function createExternalEnvelope(input: {
  engine: ExternalEngine
  engineVersion: string
  invocation: string[]
  target: ExternalTarget
  artifactId: string
  workloadSemanticHash: string
  pipelineHash: string
  roiHash: string
  profileHash: string
  rawArtifact: { id: string; byteSize: number; mimeType: string; filename: string }
  metrics: MetricInput[]
  normalized: Record<string, JsonValue>
  configuration: Record<string, unknown>
  image?: { reference: string; digest: string }
  diagnostics?: string[]
}): Promise<unknown> {
  const descriptor = TARGETS[input.target]
  const target = {
    triple: descriptor.triple,
    abi: descriptor.abi,
    endianness: descriptor.endianness,
    addressWidth: descriptor.addressWidth,
  }
  const primary = input.metrics.find((candidate) =>
    candidate.domain === (input.engine === 'llvm-mca' ? 'static-throughput-cycles-per-instruction' : 'external-simulator-cycles'))
  if (!primary) throw new Error('external result lacks its required primary comparison metric')
  const comparison = {
    experimentKind: input.engine,
    modelVersion: `${input.engine}-${input.engineVersion}+adapter-${EXTERNAL_ADAPTER_VERSION}`,
    workloadSemanticHash: input.workloadSemanticHash,
    artifactPipelineHash: input.pipelineHash,
    roiDefinitionHash: input.roiHash,
    profileConfigFingerprint: input.profileHash,
    metricDomain: primary.domain,
    unit: primary.unit,
  }
  return ExternalSimulatorResultSchema.parse({
    schemaVersion: '1.0.0',
    modelVersion: comparison.modelVersion,
    adapterVersion: EXTERNAL_ADAPTER_VERSION,
    experimentKind: input.engine,
    claimClass: input.engine === 'llvm-mca' ? 'static-throughput-estimate' : 'external-simulation',
    evidenceClass: 'external-simulator-output',
    inputIdentity: input.artifactId,
    artifactIdentities: [input.artifactId, input.rawArtifact.id],
    comparisonGroupKey: await buildComparisonGroupKey(comparison as never),
    comparison,
    createdAt: new Date().toISOString(),
    simulator: { name: input.engine, version: input.engineVersion, invocation: input.invocation },
    metrics: input.metrics,
    rawOutputArtifact: {
      id: input.rawArtifact.id,
      sha256: input.rawArtifact.id,
      byteSize: String(input.rawArtifact.byteSize),
      mimeType: input.rawArtifact.mimeType,
      role: 'result',
      filename: input.rawArtifact.filename,
    },
    target,
    ...(input.image ? {
      build: {
        buildId: `${input.engine}-${input.engineVersion}`,
        sourceRevision: input.engineVersion,
        sourceDirty: false,
        tools: [{ name: input.engine, version: input.engineVersion, invocation: input.invocation }],
        image: { imageReference: input.image.reference, digest: input.image.digest },
        commandDigest: digest(JSON.stringify(input.invocation)),
        environmentDigest: digest(JSON.stringify(input.image)),
      },
    } : {}),
    configuration: input.configuration,
    normalized: input.normalized,
    diagnostics: [
      'host wall time and container runtime diagnostics are intentionally excluded from normalized metrics',
      ...(input.diagnostics ?? []),
    ],
  })
}

export function targetDescriptor(target: ExternalTarget): typeof TARGETS[ExternalTarget] {
  return TARGETS[target]
}

function verifyFile(path: string, expected: string): void {
  const bytes = readFileSync(path)
  if (!sha(expected) || digest(bytes) !== expected) throw new Error(`native corpus artifact hash mismatch: ${basename(path)}`)
}

function integerStat(stats: Map<string, string>, keys: string[]): string {
  const value = first(stats, keys)
  if (!/^(?:0|[1-9][0-9]*)(?:\.0+)?$/.test(value)) throw new Error(`required gem5 integer stat ${keys[0]} is malformed`)
  return value.split('.')[0]!
}

function finiteStat(stats: Map<string, string>, keys: string[]): number {
  return finite(first(stats, keys), keys[0]!)
}

function first(stats: Map<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = stats.get(key)
    if (value !== undefined) return value
  }
  throw new Error(`required gem5 stat missing: ${keys.join(' or ')}`)
}

function optionalCounter(stats: Map<string, string>, metrics: MetricInput[], name: string, keys: string[]): void {
  for (const key of keys) {
    const value = stats.get(key)
    if (value !== undefined && /^(?:0|[1-9][0-9]*)(?:\.0+)?$/.test(value)) {
      metrics.push(metric(name, 'external-simulator-count', 'count', value.split('.')[0]!))
      return
    }
  }
}

function optionalFinite(stats: Map<string, string>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = stats.get(key)
    if (value !== undefined) return finite(value, key)
  }
  return undefined
}

function sumPressure(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0) throw new Error('llvm-mca resource pressure is empty')
  let total = 0
  let usages = 0
  const walk = (candidate: unknown): void => {
    if (Array.isArray(candidate)) candidate.forEach(walk)
    else if (record(candidate)) {
      if ('ResourceUsage' in candidate) {
        total += finite(candidate.ResourceUsage, 'ResourceUsage')
        usages += 1
      }
      Object.entries(candidate).forEach(([key, child]) => {
        if (key !== 'ResourceUsage' && key !== 'ResourceIndex') walk(child)
      })
    }
  }
  walk(value)
  if (usages === 0 || !(total > 0)) throw new Error('llvm-mca resource pressure is invalid')
  return total
}

function boundedDecimal(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new Error(`${name} must be a bounded canonical decimal`)
  }
  return BigInt(value)
}

function decimal(value: unknown, name: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) return value
  throw new Error(`${name} must be an unsigned integer`)
}

function finite(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a nonnegative finite number`)
  return number
}

function metric(name: string, domain: string, unit: string, value: string | number): MetricInput {
  return { name, domain, unit, value }
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
