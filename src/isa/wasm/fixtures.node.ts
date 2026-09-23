/**
 * Reading this target's committed fixtures.
 *
 * Two sets, with different oracles behind them.
 *
 * The **freestanding** modules -- the shared programs every target
 * compiles -- are here for the decode tier, which compares against
 * LLVM's disassembly. Their behaviour is not recorded, because it does
 * not need to be: the reference engine for those is the one running the
 * tests, so the comparison happens live and cannot go stale.
 *
 * The **corpus** modules are the app's own programs against a real libc,
 * and those do carry a recording: what wasmtime printed and what it
 * exited with. That oracle is not available in the test process -- it is
 * a separate engine in a container -- so its answers are captured once
 * and committed, which is what every other target here does.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readIndex } from '../common/fixtures.node.ts'

export const WASM_FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)), 'fixtures',
)

export function readWasmModule(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(WASM_FIXTURE_DIR, `${name}.wasm`)))
}

export function readWasmStdout(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(WASM_FIXTURE_DIR, `${name}.stdout`)))
}

export interface WasmIndex {
  fixtures: { name: string }[]
  libcFixtures: { name: string; exitCode: number; stderr?: string }[]
  /** Corpus programs the toolchain refused, with the reason it gave. */
  unbuilt: { name: string; error: string }[]
}

export function readWasmIndex(): WasmIndex {
  const index = readIndex(WASM_FIXTURE_DIR) as unknown as WasmIndex
  return { ...index, unbuilt: index.unbuilt ?? [] }
}

/** The freestanding modules, which are what the decode tier reads. */
export function freestandingNames(): string[] {
  return readWasmIndex().fixtures.map((entry) => entry.name)
}
