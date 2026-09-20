import { parentPort } from 'node:worker_threads'

if (!parentPort) throw new Error('model worker requires parentPort')
let aborted = false
parentPort.on('message', (value: unknown) => {
  if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'abort') aborted = true
})

parentPort.once('message', async (input: unknown) => {
  try {
    if (aborted) throw new Error('model run cancelled')
    // Kept dynamic so the strict server project does not recompile the browser project.
    // The worker's tsx loader resolves the repository TypeScript source in both dev and CLI use.
    const enginePath = '../../src/engine/index.ts'
    const engine = await import(enginePath) as {
      runComparisonAsync(
        value: unknown,
        progress: (value: { ratio: number; phase: string; detail: string }) => void,
        options: { cosmeticDelays: boolean },
      ): Promise<unknown>
      runOoOComparisonAsync(
        value: unknown,
        progress: (value: { ratio: number; phase: string; detail: string }) => void,
        options: { cosmeticDelays: boolean },
      ): Promise<unknown>
    }
    const ooo = typeof input === 'object' && input !== null &&
      (input as { lane?: unknown }).lane === 'analytical-ooo'
    const value = ooo ? (input as { input: unknown }).input : input
    const run = ooo ? engine.runOoOComparisonAsync : engine.runComparisonAsync
    const result = await run(
      value,
      (progress) => parentPort!.postMessage({ type: 'progress', progress }),
      { cosmeticDelays: false },
    )
    if (aborted) throw new Error('model run cancelled')
    parentPort!.postMessage({
      type: 'result',
      lane: ooo ? 'analytical-ooo' : 'analytical-inorder',
      result,
    })
  } catch (error) {
    if (aborted) parentPort!.postMessage({ type: 'cancelled', reason: 'model worker stopped' })
    else parentPort!.postMessage({
      type: 'error',
      error: { code: 'model_error', message: error instanceof Error ? error.message : String(error) },
    })
  }
  parentPort!.close()
})
