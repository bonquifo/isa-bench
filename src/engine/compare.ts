import { valuesEqual } from './bits.ts'
import { compile } from './compile.ts'
import { cpuById, DEFAULT_CPU_ID } from './cpus.ts'
import { simulate } from './cpu.ts'
import {
  DEFAULT_PROFILE_ID,
  overlayCustom,
  profileById,
  validateHardwareProfile,
} from './hardware.ts'
import {
  MEASUREMENT_CONTRACT,
  fingerprint,
  type MeasurementContract,
} from './measurement.ts'
import { cExampleByWorkloadId, compileC, isCWorkload } from './c/compile_c.ts'
import { applyData, interpretIr, parseIr, type IrProgram } from './ir.ts'
import { interpretIrWorkers, isParallelIr } from './ir-reference.ts'
import {
  ALL_ISAS,
  ISA_META,
  MEM_SIZE,
  type HardwareProfile,
  type IsaId,
  type Metrics,
} from './types.ts'
import {
  workloadById,
  type BuiltWorkload,
  type NRole,
  type ParallelSemantics,
  type ReferenceOracle,
} from './workloads.ts'

export type HardwareMode = 'same' | 'cpus'

export interface CompareInput {
  workloadId: string
  n: number
  seed: number
  isas: IsaId[]
  hardwareMode: HardwareMode
  profileId: string
  customHw?: Partial<HardwareProfile>
  customSource?: string
  /** Saved fixed-C source used only for exact replay of a canned program. */
  effectiveSourceOverride?: string
  /** Complete saved profiles take precedence over mutable profile/preset catalogs. */
  resolvedProfileByIsa?: Partial<Record<IsaId, HardwareProfile>>
  /** Illustrative preset id per ISA. Used in `cpus` mode. */
  cpuByIsa?: Partial<Record<IsaId, string>>
}

export type WorkloadKind = 'builtin-ir' | 'fixed-c' | 'custom-ir' | 'custom-c'

export interface WorkloadMetadata {
  kind: WorkloadKind
  requestedN: number
  effectiveN: number | null
  nRole: NRole
  requestedSeed: number
  effectiveSeed: number | null
  seedUsed: boolean
  requestedWorkerCap: number | null
  maxUsefulWorkers: number
  parallelSemantics: ParallelSemantics
  referenceOracle: ReferenceOracle
  hasIndependentExpectedCheck: boolean
}

export interface RerunInputSnapshot {
  workloadId: string
  n: number
  seed: number
  isas: IsaId[]
  selectedIsas: IsaId[]
  customSource?: string
  effectiveSource?: string
  effectiveSourceOverride?: string
  hardwareMode: HardwareMode
  profileId: string
  customHw?: Partial<HardwareProfile>
  cpuByIsa?: Partial<Record<IsaId, string>>
  resolvedCpuByIsa?: Partial<Record<IsaId, string>>
  resolvedProfileByIsa: Partial<Record<IsaId, HardwareProfile>>
}

export interface ResolvedHardwareSnapshot {
  isa: IsaId
  profile: HardwareProfile
}

export interface CompareResult {
  gold: number
  fp: boolean
  workloadId: string
  workloadName: string
  notes: string
  hardwareMode: HardwareMode
  n: number
  seed: number
  rows: Metrics[]
  goldSteps: number
  stdout: string
  source?: string
  contract: MeasurementContract
  workload: WorkloadMetadata
  rerunInput: RerunInputSnapshot
  inputFingerprint: string
  resolvedHardware: ResolvedHardwareSnapshot[]
}

export interface JackProgress {
  ratio: number
  phase: string
  detail: string
}

export function cloneMem(src: ArrayBuffer): ArrayBuffer {
  return src.slice(0)
}

export function hardwareFor(isa: IsaId, input: CompareInput): HardwareProfile {
  const override = input.resolvedProfileByIsa?.[isa]
  if (override) {
    return cloneHardwareProfile(validateHardwareProfile(cloneHardwareProfile(override)))
  }
  if (input.hardwareMode === 'cpus') {
    const id = input.cpuByIsa?.[isa] ?? DEFAULT_CPU_ID[isa]
    const cpu = cpuById(id)
    if (cpu.isa !== isa) {
      throw new Error(
        `${cpu.name} is an illustrative ${ISA_META[cpu.isa].short} preset and cannot be used for ${ISA_META[isa].short}`,
      )
    }
    return cpu.profile
  }
  const base = profileById(input.profileId || DEFAULT_PROFILE_ID)
  if (input.customHw) return overlayCustom(base, input.customHw)
  return base
}

export interface BuiltInput {
  ir: IrProgram
  memory: ArrayBuffer
  expected: number
  fp: boolean
  name: string
  notes: string
  maxWorkers: number
  stdout: string
  source?: string
  workload: WorkloadMetadata
}

function customParameterMetadata(
  input: CompareInput,
  kind: Exclude<WorkloadKind, 'builtin-ir'>,
  parallel: boolean,
): WorkloadMetadata {
  const usesWorkerCap = kind !== 'fixed-c' && parallel
  return {
    kind,
    requestedN: input.n,
    effectiveN: usesWorkerCap ? Math.max(1, Math.trunc(input.n)) : null,
    nRole: usesWorkerCap ? 'worker-cap' : 'unused',
    requestedSeed: input.seed,
    effectiveSeed: null,
    seedUsed: false,
    requestedWorkerCap: usesWorkerCap ? input.n : null,
    maxUsefulWorkers: usesWorkerCap ? Math.max(1, Math.trunc(input.n)) : 1,
    parallelSemantics: parallel ? 'source-defined' : 'serial',
    referenceOracle: 'ir-interpreter',
    hasIndependentExpectedCheck: false,
  }
}

export function buildInput(input: CompareInput): BuiltInput {
  if (input.workloadId === 'custom') {
    const source = input.customSource ?? ''
    const ir = parseIr(source)
    const memory = new ArrayBuffer(MEM_SIZE)
    applyData(memory, ir.data)
    const parallel = isParallelIr(ir)
    const workload = customParameterMetadata(input, 'custom-ir', parallel)
    const gold = parallel
      ? interpretIrWorkers(ir, cloneMem(memory), workload.maxUsefulWorkers)
      : interpretIr(ir, cloneMem(memory))
    return {
      ir,
      memory,
      expected: gold.value,
      fp: !Number.isInteger(gold.value) || Object.is(gold.value, -0),
      name: 'Custom IR',
      notes: 'User-supplied IR, compiled independently for each ISA.',
      maxWorkers: workload.maxUsefulWorkers,
      stdout: gold.stdout,
      source,
      workload,
    }
  }
  if (input.workloadId === 'custom-c' || isCWorkload(input.workloadId)) {
    const canned = cExampleByWorkloadId(input.workloadId)
    const fixedId = isCWorkload(input.workloadId)
    const archivedFixed = fixedId && !canned && input.effectiveSourceOverride !== undefined
    if (fixedId && !canned && !archivedFixed) {
      throw new Error(`Unknown C program "${input.workloadId}"`)
    }
    const source = fixedId
      ? (input.effectiveSourceOverride ?? canned!.source)
      : (input.customSource ?? '')
    const compiled = compileC(source)
    const memory = new ArrayBuffer(MEM_SIZE)
    applyData(memory, compiled.ir.data)
    const parallel = !fixedId && isParallelIr(compiled.ir)
    const workload = customParameterMetadata(
      input,
      fixedId ? 'fixed-c' : 'custom-c',
      parallel,
    )
    const gold = parallel
      ? interpretIrWorkers(compiled.ir, cloneMem(memory), workload.maxUsefulWorkers)
      : interpretIr(compiled.ir, cloneMem(memory))
    return {
      ir: compiled.ir,
      memory,
      expected: gold.value,
      fp: !Number.isInteger(gold.value) || Object.is(gold.value, -0),
      name: canned?.menuName ??
        (archivedFixed ? `Archived C fixture (${input.workloadId})` : 'Custom C'),
      notes: canned?.blurb ??
        (archivedFixed
          ? 'Archived fixed-C source replayed from its saved effective-source snapshot; the original catalog fixture is unavailable.'
          : compiled.notes),
      maxWorkers: workload.maxUsefulWorkers,
      stdout: gold.stdout,
      source,
      workload,
    }
  }
  const def = workloadById(input.workloadId)
  const n = Math.min(def.maxN, Math.max(def.minN, Math.trunc(input.n)))
  const effectiveSeed = input.seed | 0
  const built: BuiltWorkload = def.build(n, effectiveSeed)
  return {
    ir: built.ir,
    memory: built.memory,
    expected: built.expected,
    fp: built.fp,
    name: def.name,
    notes: built.notes,
    maxWorkers: built.maxWorkers,
    stdout: '',
    workload: {
      kind: 'builtin-ir',
      requestedN: input.n,
      effectiveN: n,
      nRole: def.nRole,
      requestedSeed: input.seed,
      effectiveSeed,
      seedUsed: def.usesSeed,
      requestedWorkerCap: null,
      maxUsefulWorkers: built.maxWorkers,
      parallelSemantics: def.parallelSemantics,
      referenceOracle: def.referenceOracle,
      hasIndependentExpectedCheck: def.hasIndependentExpectedCheck,
    },
  }
}

function referenceForBuilt(built: BuiltInput): ReturnType<typeof interpretIr> {
  const custom = built.workload.kind === 'custom-ir' || built.workload.kind === 'custom-c'
  return custom && built.workload.parallelSemantics === 'source-defined'
    ? interpretIrWorkers(built.ir, cloneMem(built.memory), built.maxWorkers)
    : interpretIr(built.ir, cloneMem(built.memory))
}

export function selectedIsas(input: CompareInput): IsaId[] {
  return (input.isas.length ? input.isas : ALL_ISAS).filter((id, i, a) => a.indexOf(id) === i)
}

function cloneHardwareProfile(profile: HardwareProfile): HardwareProfile {
  return {
    ...profile,
    l1i: { ...profile.l1i },
    l1d: { ...profile.l1d },
    l2: { ...profile.l2 },
    l3: { ...profile.l3 },
  }
}

function resolvedHardwareFor(isas: IsaId[], input: CompareInput): ResolvedHardwareSnapshot[] {
  return isas.map((isa) => ({ isa, profile: cloneHardwareProfile(hardwareFor(isa, input)) }))
}

function rerunSnapshot(
  input: CompareInput,
  isas: IsaId[],
  built: BuiltInput,
  resolvedHardware: ResolvedHardwareSnapshot[],
): RerunInputSnapshot {
  const customKind = built.workload.kind === 'custom-ir' || built.workload.kind === 'custom-c'
  return {
    workloadId: input.workloadId,
    n: input.n,
    seed: input.seed,
    isas: [...isas],
    selectedIsas: [...isas],
    ...(customKind && built.source !== undefined ? { customSource: built.source } : {}),
    ...(built.source !== undefined ? { effectiveSource: built.source } : {}),
    ...(built.workload.kind === 'fixed-c' && built.source !== undefined
      ? { effectiveSourceOverride: built.source }
      : {}),
    hardwareMode: input.hardwareMode,
    profileId: input.profileId,
    ...(input.hardwareMode === 'same' && input.customHw
      ? {
          customHw: {
            ...input.customHw,
            ...(input.customHw.l1i ? { l1i: { ...input.customHw.l1i } } : {}),
            ...(input.customHw.l1d ? { l1d: { ...input.customHw.l1d } } : {}),
            ...(input.customHw.l2 ? { l2: { ...input.customHw.l2 } } : {}),
            ...(input.customHw.l3 ? { l3: { ...input.customHw.l3 } } : {}),
          },
        }
      : {}),
    ...(input.hardwareMode === 'cpus' && input.cpuByIsa ? { cpuByIsa: { ...input.cpuByIsa } } : {}),
    ...(input.hardwareMode === 'cpus'
      ? {
          resolvedCpuByIsa: Object.fromEntries(
            isas.map((isa) => [isa, input.cpuByIsa?.[isa] ?? DEFAULT_CPU_ID[isa]]),
          ) as Partial<Record<IsaId, string>>,
        }
      : {}),
    resolvedProfileByIsa: Object.fromEntries(
      resolvedHardware.map(({ isa, profile }) => [isa, cloneHardwareProfile(profile)]),
    ) as Partial<Record<IsaId, HardwareProfile>>,
  }
}

export function computeInputFingerprint(
  contract: MeasurementContract,
  rerunInput: RerunInputSnapshot,
  workload: WorkloadMetadata,
  resolvedHardware: ResolvedHardwareSnapshot[],
): string {
  return fingerprint({
    contract,
    rerunInput,
    workload,
    resolvedHardware,
  })
}

function makeResult(
  input: CompareInput,
  isas: IsaId[],
  built: BuiltInput,
  gold: ReturnType<typeof interpretIr>,
  rows: Metrics[],
  resolvedHardware: ResolvedHardwareSnapshot[],
): CompareResult {
  const rerunInput = rerunSnapshot(input, isas, built, resolvedHardware)
  const hardwareSnapshots = resolvedHardware.map(({ isa, profile }) => ({
    isa,
    profile: cloneHardwareProfile(profile),
  }))
  return {
    gold: gold.value,
    fp: built.fp,
    workloadId: input.workloadId,
    workloadName: built.name,
    notes: built.notes,
    hardwareMode: input.hardwareMode,
    n: built.workload.kind === 'builtin-ir' ? built.workload.effectiveN! : input.n,
    seed: input.seed,
    rows,
    goldSteps: gold.steps,
    stdout: gold.stdout,
    source: built.source,
    contract: { ...MEASUREMENT_CONTRACT },
    workload: { ...built.workload },
    rerunInput,
    inputFingerprint: computeInputFingerprint(
      MEASUREMENT_CONTRACT,
      rerunInput,
      built.workload,
      hardwareSnapshots,
    ),
    resolvedHardware: hardwareSnapshots,
  }
}

function runOne(
  isa: IsaId,
  built: BuiltInput,
  gold: number,
  hw: HardwareProfile,
): Metrics {
  const program = compile(built.ir, isa)
  const metrics = simulate(program, hw, cloneMem(built.memory), { maxWorkers: built.maxWorkers })
  const stdoutOk = (metrics.stdout ?? '') === (built.stdout ?? '')
  metrics.matchedGold = valuesEqual(metrics.result, gold, built.fp) && stdoutOk
  if (!metrics.matchedGold) {
    if (!stdoutOk) {
      throw new Error(
        `${isa} stdout ${JSON.stringify(metrics.stdout)} does not match gold ${JSON.stringify(built.stdout)}`,
      )
    }
    throw new Error(
      `${isa} produced ${metrics.result}, but the IR reference result is ${gold}`,
    )
  }
  return metrics
}

export function runComparison(input: CompareInput): CompareResult {
  const isas = selectedIsas(input)
  const built = buildInput(input)
  const resolvedHardware = resolvedHardwareFor(isas, input)
  const gold = referenceForBuilt(built)
  if (!valuesEqual(gold.value, built.expected, built.fp)) {
    throw new Error(
      `Internal gold mismatch for ${built.name}: IR=${gold.value} expected=${built.expected}`,
    )
  }
  const rows = isas.map((isa, index) =>
    runOne(isa, built, gold.value, resolvedHardware[index].profile),
  )
  return makeResult(input, isas, built, gold, rows, resolvedHardware)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface ComparisonAsyncOptions {
  signal?: AbortSignal
  /** Keep the cyberpunk pacing in browser-only mode; server workers disable it. */
  cosmeticDelays?: boolean
}

export async function runComparisonAsync(
  input: CompareInput,
  onProgress: (p: JackProgress) => void,
  options: ComparisonAsyncOptions = {},
): Promise<CompareResult> {
  const signal = options.signal
  const pause = (ms: number) => options.cosmeticDelays === false ? Promise.resolve() : wait(ms, signal)
  const checkpoint = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
  const isas = selectedIsas(input)
  checkpoint()
  const resolvedHardware = resolvedHardwareFor(isas, input)
  const beat = 95

  onProgress({ ratio: 0.04, phase: 'LINK', detail: 'opening neural bus' })
  await pause(beat)

  onProgress({ ratio: 0.1, phase: 'IR', detail: 'materializing workload' })
  await pause(40)
  checkpoint()
  const built = buildInput(input)

  onProgress({ ratio: 0.18, phase: 'REFERENCE', detail: 'reference interpreter' })
  await pause(40)
  checkpoint()
  const gold = referenceForBuilt(built)
  if (!valuesEqual(gold.value, built.expected, built.fp)) {
    throw new Error(
      `Internal gold mismatch for ${built.name}: IR=${gold.value} expected=${built.expected}`,
    )
  }

  const rows: Metrics[] = []
  for (let i = 0; i < isas.length; i++) {
    checkpoint()
    const isa = isas[i]
    const start = 0.22 + (0.7 * i) / Math.max(1, isas.length)
    onProgress({
      ratio: start,
      phase: 'UPLINK',
      detail: `${ISA_META[isa].short} · lower + model`,
    })
    await pause(beat)
    checkpoint()
    rows.push(runOne(isa, built, gold.value, resolvedHardware[i].profile))
    onProgress({
      ratio: 0.22 + (0.7 * (i + 1)) / Math.max(1, isas.length),
      phase: 'UPLINK',
      detail: `${ISA_META[isa].short} · reference match`,
    })
    await pause(55)
  }

  onProgress({ ratio: 1, phase: 'MATCH', detail: 'all targets agree with reference' })
  await pause(140)

  return makeResult(input, isas, built, gold, rows, resolvedHardware)
}
