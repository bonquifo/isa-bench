import { runOoOComparisonAsync, type OoOCompareInput } from '../engine/index.ts'

type Request = { type: 'run'; input: OoOCompareInput }

self.addEventListener('message', (event: MessageEvent<Request>) => {
  if (event.data.type !== 'run') return
  const controller = new AbortController()
  void runOoOComparisonAsync(
    event.data.input,
    (progress) => self.postMessage({ type: 'progress', progress }),
    { signal: controller.signal },
  ).then(
    (result) => self.postMessage({ type: 'result', result }),
    (error: unknown) => self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    }),
  )
})
