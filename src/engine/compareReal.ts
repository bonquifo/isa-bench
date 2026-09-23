/**
 * The comparison, on real instruction sets.
 *
 * The other path (`runComparisonAsync` in compare.ts) lowers the program's
 * IR through the engine's pseudo-backends: an instruction stream shaped like
 * each architecture's, but invented. This one runs, for each target, the
 * binary clang compiled from the same C -- executed by an interpreter that
 * is verified against a real reference -- and times the instructions that
 * actually retired. The timing model is the same one; what it is timing is
 * no longer a caricature.
 *
 * Three rules, each there to stop the result claiming more than it has.
 *
 * **A binary is always built from the source being compared.** A canned
 * program's binaries were compiled ahead of time from exactly the source in
 * the catalogue; a replay whose source differs from it is refused rather
 * than run against one built from something else. The user's own C has no
 * binary until the provider compiles one, with the same compilers, which a
 * target that cannot compile it records as the reason it is missing.
 *
 * **Every row answers to the same reference.** The IR interpreter still
 * runs, and each target's return value and output must equal it. A
 * mismatch rejects the run, exactly as it does on the other path. The one
 * exception is stated rather than excused: the 6502's `int` is sixteen
 * bits, so where the reference answer does not fit in one, that target
 * computes a different value and is right to -- and must still return
 * something a sixteen-bit `int` can hold.
 *
 * **A table is all real or all lowered, never both.** A row from each
 * path side by side would invite reading them as the same kind of number.
 *
 * The binaries arrive through a provider rather than being imported here,
 * because all eight targets' binaries together are tens of megabytes and
 * the engine is in the app's first chunk. The app loads them lazily; tests
 * read them from the fixture directories.
 */
import { valuesEqual } from './bits.ts'
import { cExampleByWorkloadId } from './c/compile_c.ts'
import {
  buildInput,
  makeResult,
  referenceForBuilt,
  resolvedHardwareFor,
  selectedIsas,
  type CompareInput,
  type CompareResult,
  type ComparisonAsyncOptions,
  type JackProgress,
  type RealTargetRecord,
  type ResolvedHardwareSnapshot,
} from './compare.ts'
import { TRACE_TIMING_MODEL_VERSION, simulateTrace } from './simulateTrace.ts'
import { ISA_META, type IsaId, type Metrics } from './types.ts'
import type { IsaBackend } from '../isa/backend.ts'
import { RETURN_SEPARATOR } from '../isa/shipped.ts'

/** One target, as the real path needs to see it. */
export interface RealTargetBinding {
  isa: IsaId
  /** What the architecture is called, e.g. "RV64GC". */
  label: string
  libc: string
  oracle: string
  verified: string
  intBits: 16 | 32
  /** Where the corpus driver reports the return value. See realTargets.ts. */
  returnChannel: 'stderr' | 'framed'
  backend: IsaBackend
  /** The binary for a canned program, or null when this target has none. */
  binary(programId: string): Promise<Uint8Array | null>
}

export type RealTargetProvider = (isa: IsaId) => RealTargetBinding | undefined

/** The program id a user's own C program is compiled and run under. */
export const CUSTOM_PROGRAM_ID = 'custom'

/**
 * A target could not build the user's program. Thrown by a compiling
 * provider's `binary`; the comparison records it as that target's reason
 * for sitting out, and carries on with the others.
 */
export class TargetBuildFailure extends Error {
  readonly isa: IsaId
  readonly stage: 'compile' | 'link'

  constructor(isa: IsaId, stage: 'compile' | 'link', message: string) {
    super(message)
    this.name = 'TargetBuildFailure'
    this.isa = isa
    this.stage = stage
  }
}

/**
 * Whether a comparison input can run on real instruction sets at all: a
 * canned C program whose effective source is the catalogue's own, or a
 * user's own C program, which the app compiles itself.
 */
export function realExecutionAvailable(
  input: Pick<CompareInput, 'workloadId' | 'effectiveSourceOverride'>,
): boolean {
  if (input.workloadId === 'custom-c') return true
  const canned = cExampleByWorkloadId(input.workloadId)
  if (!canned) return false
  return input.effectiveSourceOverride === undefined ||
    input.effectiveSourceOverride === canned.source
}

/**
 * Why a user's C program cannot run on real instruction sets, or null.
 *
 * Guest C has three built-ins no C library has -- the worker id, the worker
 * count and a barrier -- because the lowering models a multicore machine.
 * A real target runs one thread, so a program that uses them has no real
 * counterpart. And the driver reports the answer as an `int`, so a program
 * whose `main` returns a double would be misreported.
 */
export function realExecutionRefusal(source: string): string | null {
  const builtin = /\b(__tid|__nthreads|__barrier)\s*\(/.exec(source)
  if (builtin) {
    return `This program calls ${builtin[1]}(), a Guest C built-in for the modelled ` +
      'multicore. Real targets run one thread, so it runs on the model lowering only.'
  }
  if (/\bdouble\s+main\s*\(/.test(source)) {
    return 'This program\'s main returns a double. Real targets report an int, so it runs ' +
      'on the model lowering only.'
  }
  return null
}

/** A generous ceiling: the heaviest corpus program retires under 3M. */
const INSTRUCTION_BUDGET = 200_000_000

function fitsInInt(value: number, bits: 16 | 32): boolean {
  const limit = 2 ** (bits - 1)
  return Number.isInteger(value) && value >= -limit && value < limit
}

interface Observed {
  stdout: string
  returned: number
}

/** The program's own output and the driver's report of its return value. */
function observe(
  binding: RealTargetBinding,
  interpreter: { stdout(): Uint8Array; stderr(): Uint8Array },
): Observed {
  const decoder = new TextDecoder()
  const raw = decoder.decode(interpreter.stdout())
  if (binding.returnChannel === 'framed') {
    // One output stream on this platform, so the driver frames the value.
    const split = raw.lastIndexOf(RETURN_SEPARATOR)
    return {
      stdout: split >= 0 ? raw.slice(0, split) : raw,
      returned: Number(split >= 0 ? raw.slice(split + 1) : ''),
    }
  }
  return { stdout: raw, returned: Number(decoder.decode(interpreter.stderr())) }
}

/** The first line of a diagnostic that says what went wrong. */
function firstLine(message: string): string {
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => /error/i.test(line)) ?? lines[0] ?? 'no diagnostic'
}

async function yieldToUi(signal?: AbortSignal): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

export async function runRealComparisonAsync(
  input: CompareInput,
  provider: RealTargetProvider,
  onProgress: (p: JackProgress) => void,
  options: ComparisonAsyncOptions = {},
): Promise<CompareResult> {
  const signal = options.signal
  const canned = cExampleByWorkloadId(input.workloadId)
  const custom = input.workloadId === 'custom-c'
  if (!realExecutionAvailable(input) || (!canned && !custom)) {
    throw new Error(
      'Real-ISA execution is available for the canned C programs, as shipped, and for ' +
      'your own C program, which the app compiles itself.',
    )
  }
  if (custom) {
    const refusal = realExecutionRefusal(input.customSource ?? '')
    if (refusal) throw new Error(refusal)
  }
  const programId = canned ? canned.id : CUSTOM_PROGRAM_ID

  onProgress({ ratio: 0.08, phase: 'REFERENCE', detail: 'reference interpreter' })
  await yieldToUi(signal)
  const built = buildInput(input)
  const gold = referenceForBuilt(built)
  if (!valuesEqual(gold.value, built.expected, built.fp)) {
    throw new Error(
      `Internal gold mismatch for ${built.name}: IR=${gold.value} expected=${built.expected}`,
    )
  }

  const selected = selectedIsas(input)
  const hardware = resolvedHardwareFor(selected, input)
  const rows: Metrics[] = []
  const ran: ResolvedHardwareSnapshot[] = []
  const targets: RealTargetRecord[] = []
  const unavailable: { isa: IsaId; reason: string }[] = []

  for (let i = 0; i < selected.length; i++) {
    const isa = selected[i]!
    const binding = provider(isa)
    const label = binding?.label ?? ISA_META[isa].short
    onProgress({
      ratio: 0.12 + (0.8 * i) / Math.max(1, selected.length),
      phase: custom ? 'COMPILE' : 'EXECUTE',
      detail: custom ? `${label} · clang, then real instructions + model` : `${label} · real instructions + model`,
    })
    await yieldToUi(signal)

    let bytes: Uint8Array | null = null
    try {
      bytes = binding ? await binding.binary(programId) : null
    } catch (error) {
      if (!(error instanceof TargetBuildFailure)) throw error
      unavailable.push({
        isa,
        reason: `${label} could not ${error.stage} this program: ${firstLine(error.message)}`,
      })
      continue
    }
    if (!binding || !bytes) {
      unavailable.push({
        isa,
        reason: binding
          ? `${binding.label} has no binary for this program`
          : `${ISA_META[isa].short} has no real backend`,
      })
      continue
    }

    const { interpreter } = binding.backend.load(bytes, { instructionBudget: INSTRUCTION_BUDGET })
    const metrics = simulateTrace(interpreter, hardware[i]!.profile, isa)
    const seen = observe(binding, interpreter)

    let verdict: RealTargetRecord['verdict']
    if (!fitsInInt(gold.value, binding.intBits)) {
      // The reference answer needs a wider `int` than this target has. It
      // cannot be reproduced, and what is checked instead is that what
      // came back is a value an `int` of this width can hold.
      if (!fitsInInt(seen.returned, binding.intBits)) {
        throw new Error(
          `${binding.label} returned ${seen.returned}, which its ${binding.intBits}-bit int cannot hold`,
        )
      }
      verdict = 'unreachable'
    } else {
      if (!valuesEqual(seen.returned, gold.value, built.fp)) {
        throw new Error(
          `${binding.label} produced ${seen.returned}, but the IR reference result is ${gold.value}`,
        )
      }
      if (seen.stdout !== (built.stdout ?? '')) {
        throw new Error(
          `${binding.label} stdout ${JSON.stringify(seen.stdout)} does not match ` +
          `the reference ${JSON.stringify(built.stdout ?? '')}`,
        )
      }
      verdict = 'match'
    }

    rows.push({
      ...metrics,
      result: seen.returned,
      matchedGold: verdict === 'match',
      stdout: seen.stdout,
    })
    ran.push(hardware[i]!)
    targets.push({
      isa,
      label: binding.label,
      libc: binding.libc,
      oracle: binding.oracle,
      verified: binding.verified,
      verdict,
    })
  }

  if (rows.length === 0) {
    const reasons = unavailable.map((item) => item.reason).join('\n')
    throw new Error(`None of the selected targets could run this program.\n${reasons}`)
  }

  onProgress({ ratio: 1, phase: 'MATCH', detail: 'every real target checked against the reference' })
  await yieldToUi(signal)

  const isas = ran.map((snapshot) => snapshot.isa)
  const result = makeResult({ ...input, isas }, isas, built, gold, rows, ran, 'real-isa')
  return {
    ...result,
    execution: {
      mode: 'real-isa',
      targets,
      unavailable,
      timingModelVersion: TRACE_TIMING_MODEL_VERSION,
    },
  }
}
