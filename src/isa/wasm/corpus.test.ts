/**
 * The app's own workloads, on the real backend, against the app's own
 * recorded answers.
 *
 * This is the check with the most independent oracle available, and it is
 * a different question from the one conformance.test.ts asks. That tier
 * compares this interpreter against wasmtime -- a second implementation
 * of the same architecture, running the same module. These expectations
 * were produced by something else entirely: the in-house Guest C compiler
 * and the pseudo-backend, years of design apart from clang, and they are
 * already what the shipping app validates against.
 *
 * Agreement here means a real toolchain, a real libc, a real instruction
 * set and the existing engine all compute the same thing.
 *
 * One program needed a compiler flag to get here, and the reason is
 * recorded in tools/isa/corpus.ts: `fire` relies on signed integer
 * overflow wrapping, which C leaves undefined. Without -fwrapv it would
 * agree with wasmtime and disagree with the app, which is the correct
 * outcome -- the program is at fault, not either engine.
 */
import { describe, expect, it } from 'vitest'
import { C_EXAMPLES } from '../../engine/c/programs.ts'
import { RunState, createRetireChunk } from '../common/trace.ts'
import { wasmBackend } from './backend.ts'
import { readWasmIndex, readWasmModule } from './fixtures.node.ts'

function fnv1a(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash | 0
}

function run(name: string): { stdout: string; returned: number; retired: number } {
  // Through the backend rather than the loader, because this is the path
  // the app itself takes: shipped bytes in, one `load`, and run until it
  // stops.
  const { interpreter } = wasmBackend.load(readWasmModule(name), {
    instructionBudget: 2_000_000_000,
  })
  const chunk = createRetireChunk(65536)
  let state: RunState = RunState.MORE
  while (state === RunState.MORE) state = interpreter.run(chunk)
  const decoder = new TextDecoder()
  return {
    stdout: decoder.decode(interpreter.stdout()),
    // The driver writes the full 32-bit return value here, because a
    // process exit status carries only eight bits and several of these
    // programs return more.
    returned: Number(decoder.decode(interpreter.stderr())),
    retired: interpreter.retired,
  }
}

describe("the app's C corpus on the WebAssembly backend", () => {
  const captured = new Set(readWasmIndex().libcFixtures.map((f) => f.name))

  it('has a module for every program the app ships', () => {
    for (const example of C_EXAMPLES) {
      expect(`${example.id}: ${captured.has(`corpus-${example.id}`)}`)
        .toBe(`${example.id}: true`)
    }
    expect(C_EXAMPLES.length).toBeGreaterThanOrEqual(14)
  })

  for (const example of C_EXAMPLES) {
    it(`computes the answer the app expects: ${example.id}`, () => {
      const result = run(`corpus-${example.id}`)
      expect(`${example.id} returned ${result.returned}`)
        .toBe(`${example.id} returned ${example.expectedReturn}`)

      if ('exact' in example.expectedStdout) {
        expect(result.stdout).toBe(example.expectedStdout.exact)
      } else {
        expect(result.stdout.length).toBe(example.expectedStdout.length)
        expect(fnv1a(result.stdout)).toBe(example.expectedStdout.fnv1a)
      }
      expect(result.retired).toBeGreaterThan(0)
    })
  }
})
