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
 * **Only the canned programs, and only as shipped.** The binaries were
 * compiled ahead of time from exactly the source in the catalogue, because
 * the app cannot compile at runtime. A replay whose source differs from
 * the catalogue's has no binary, and is refused rather than run against
 * one built from something else.
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
import { simulateTrace } from './simulateTrace.ts'
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

/**
 * Whether a comparison input can run on real instruction sets at all: a
 * canned C program whose effective source is the catalogue's own.
 */
export function realExecutionAvailable(
  input: Pick<CompareInput, 'workloadId' | 'effectiveSourceOverride'>,
): boolean {
  const canned = cExampleByWorkloadId(input.workloadId)
  if (!canned) return false
  return input.effectiveSourceOverride === undefined ||
    input.effectiveSourceOverride === canned.source
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
  if (!canned || !realExecutionAvailable(input)) {
    throw new Error(
      'Real-ISA execution is available only for the canned C programs, as shipped: ' +
      'their binaries were compiled ahead of time from exactly that source.',
    )
  }

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
      phase: 'EXECUTE',
      detail: `${label} · real instructions + model`,
    })
    await yieldToUi(signal)

    const bytes = binding ? await binding.binary(canned.id) : null
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
    throw new Error('None of the selected targets has a binary for this program.')
  }

  onProgress({ ratio: 1, phase: 'MATCH', detail: 'every real target checked against the reference' })
  await yieldToUi(signal)

  const isas = ran.map((snapshot) => snapshot.isa)
  const result = makeResult({ ...input, isas }, isas, built, gold, rows, ran, 'real-isa')
  return { ...result, execution: { mode: 'real-isa', targets, unavailable } }
}
