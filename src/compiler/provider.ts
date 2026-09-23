/**
 * The real targets, for a program the user wrote.
 *
 * A canned program's binaries were compiled ahead of time and ship with
 * the app. A user's program has none, so this provider compiles it --
 * with the in-app toolchain, the same compiler and libraries the shipped
 * binaries came from -- when the comparison asks a target for its binary.
 * Everything else about a target, what it is called and how far it is
 * verified, is the shipped provider's, so the report says the same about a
 * target whichever kind of program it ran.
 */
import { TargetBuildFailure, type RealTargetProvider } from '../engine/compareReal.ts'
import type { IsaId } from '../engine/types.ts'
import type { CompileResult } from './toolchain.ts'
import type { ReturnChannel } from './wrap.ts'

export type CompileFn = (isa: IsaId, source: string, channel: ReturnChannel) => Promise<CompileResult>

export function compilingProvider(
  base: RealTargetProvider,
  source: string,
  compile: CompileFn,
): RealTargetProvider {
  return (isa) => {
    const binding = base(isa)
    if (!binding) return undefined
    return {
      ...binding,
      async binary() {
        const result = await compile(isa, source, binding.returnChannel)
        if (!result.ok) throw new TargetBuildFailure(isa, result.stage, result.message)
        return result.binary
      },
    }
  }
}
