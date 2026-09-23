/**
 * What a report calls each target.
 *
 * On the lowering, a target is a pseudo-backend and its name says so --
 * "RISC-V-style pseudo-backend". On a real run it is not one, and calling
 * it that would understate what ran; calling a lowered run by a real
 * architecture's name would overstate it. So the name comes from the
 * result: the real label when the row executed real instructions, the
 * lowering's name otherwise.
 */
import type { CompareResult } from '../engine/compare.ts'
import { ISA_META, type IsaId } from '../engine/types.ts'

type Named = Pick<CompareResult, 'execution'>

function realTarget(result: Named, isa: IsaId) {
  return result.execution?.targets.find((target) => target.isa === isa)
}

export function targetShort(result: Named, isa: IsaId): string {
  return realTarget(result, isa)?.label ?? ISA_META[isa].short
}

export function targetFull(result: Named, isa: IsaId): string {
  const real = realTarget(result, isa)
  return real ? `${real.label} · real instructions` : ISA_META[isa].full
}

export function isRealResult(result: Named): boolean {
  return result.execution?.mode === 'real-isa'
}
