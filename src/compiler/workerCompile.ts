/**
 * The page's side of the compile worker: one worker, reused for every
 * compile, answering requests in the order it is sent them.
 */
import type { CompileReply, CompileRequest } from './compile.worker.ts'
import { toolchainBase } from './load.ts'
import type { CompileFn } from './provider.ts'

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (reply: CompileReply) => void }>()

function compileWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./compile.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<CompileReply>) => {
    waiting.get(event.data.id)?.resolve(event.data)
    waiting.delete(event.data.id)
  }
  return worker
}

export const workerCompile: CompileFn = (isa, source, channel) => {
  const id = nextId++
  const request: CompileRequest = { id, base: toolchainBase(), isa, source, channel }
  return new Promise((resolve, reject) => {
    waiting.set(id, {
      resolve: (reply) => ('error' in reply ? reject(new Error(reply.error)) : resolve(reply.result)),
    })
    compileWorker().postMessage(request)
  })
}
