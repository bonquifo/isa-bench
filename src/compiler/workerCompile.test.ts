// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { CompileReply, CompileRequest } from './compile.worker.ts'

/**
 * The page's side of the compile worker, against a stand-in worker: one
 * worker for every compile, and each reply delivered to the request that
 * asked for it.
 */
const workers: FakeWorker[] = []

class FakeWorker {
  onmessage: ((event: MessageEvent<CompileReply>) => void) | null = null
  readonly sent: CompileRequest[] = []
  constructor() { workers.push(this) }
  postMessage(request: CompileRequest) { this.sent.push(request) }
  reply(data: CompileReply) { this.onmessage?.({ data } as MessageEvent<CompileReply>) }
}

vi.stubGlobal('Worker', FakeWorker)
vi.mock('./load.ts', () => ({ toolchainBase: () => 'base/' }))

describe('compiling through the worker', () => {
  it('uses one worker and answers each request with its own reply', async () => {
    const { workerCompile } = await import('./workerCompile.ts')
    const riscv = workerCompile('riscv' as never, 'int main(void){return 1;}', 'stderr')
    const mos = workerCompile('mos' as never, 'int main(void){return 2;}', 'framed')
    expect(workers).toHaveLength(1)
    const [first, second] = workers[0]!.sent
    expect(first).toMatchObject({ base: 'base/', isa: 'riscv', channel: 'stderr' })
    expect(second).toMatchObject({ isa: 'mos', channel: 'framed' })

    // Out of order, as a worker is free to answer.
    workers[0]!.reply({ id: second!.id, result: { ok: false, stage: 'link', message: 'too big' } })
    workers[0]!.reply({ id: first!.id, result: { ok: true, binary: new Uint8Array([7]), warnings: '' } })
    await expect(mos).resolves.toEqual({ ok: false, stage: 'link', message: 'too big' })
    await expect(riscv).resolves.toMatchObject({ ok: true, binary: new Uint8Array([7]) })
  })

  it('turns a worker that could not load the compiler into an error', async () => {
    const { workerCompile } = await import('./workerCompile.ts')
    const pending = workerCompile('x86' as never, '', 'stderr')
    const request = workers[0]!.sent.at(-1)!
    workers[0]!.reply({ id: request.id, error: 'llvm.wasm: 404' })
    await expect(pending).rejects.toThrow('llvm.wasm: 404')
  })
})
