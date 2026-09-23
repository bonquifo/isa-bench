/**
 * Compiles off the main thread.
 *
 * clang in WebAssembly takes seconds per target, which on the page's own
 * thread would freeze the app for the length of a comparison. The toolchain
 * is loaded here once, the first time it is needed, and every compile after
 * reuses it.
 */
import type { IsaId } from '../engine/types.ts'
import { loadToolchain } from './load.ts'
import type { CompileResult } from './toolchain.ts'
import type { ReturnChannel } from './wrap.ts'

export interface CompileRequest {
  id: number
  base: string
  isa: IsaId
  source: string
  channel: ReturnChannel
}

export type CompileReply =
  | { id: number; result: CompileResult }
  | { id: number; error: string }

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const { id, base, isa, source, channel } = event.data
  try {
    const toolchain = await loadToolchain(base)
    const result = await toolchain.compile(isa, source, channel)
    const transfer = result.ok ? [result.binary.buffer as ArrayBuffer] : []
    self.postMessage({ id, result } satisfies CompileReply, { transfer })
  } catch (error) {
    self.postMessage({ id, error: (error as Error).message } satisfies CompileReply)
  }
}
