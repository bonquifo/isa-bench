/**
 * Loading a WebAssembly module.
 *
 * Shorter than the other loaders here because most of what they do has
 * no counterpart: there are no segments to map, no addresses to
 * relocate, no stack to build and no auxiliary vector to fabricate. A
 * module says what memory it wants and what bytes go in it, and the
 * parser has already read both.
 *
 * What is left is choosing where to start, and that is less obvious than
 * it sounds. A module may name a `start` function, or export `_start`,
 * or export `main`, or -- for the modules this backend is mostly
 * verified against -- name no entry point at all, because the
 * differential tier calls exported functions directly and never runs one
 * from the beginning. So the entry is resolved in that order and the
 * last case is allowed rather than refused, with `invoke` as the way in.
 */
import { IsaError } from '../common/errors.ts'
import { WasmInterpreter, type WasmOptions } from './exec.ts'
import { WasmImage } from './image.ts'
import { ISA_NAME } from './decode.ts'
import { bodyOf, parseModule, type WasmModule } from './module.ts'

export interface WasmLoadOptions extends WasmOptions {
  /** Start at this exported function rather than the module's own entry. */
  entry?: string
}

export interface LoadedWasm {
  image: WasmImage
  interpreter: WasmInterpreter
  module: WasmModule
  /** Which function index the image's entry points at. */
  entryFunction: number
}

/** Exported function indices by name, which is how a caller names one. */
export function exportedFunctions(module: WasmModule): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of module.exports) {
    if (entry.kind === 0) out.set(entry.name, entry.index)
  }
  return out
}

function resolveEntry(module: WasmModule, named?: string): number {
  const exports = exportedFunctions(module)
  if (named !== undefined) {
    const found = exports.get(named)
    if (found === undefined) {
      throw new IsaError(
        `${ISA_NAME}: module exports no function named ${named} ` +
        `(it has ${[...exports.keys()].join(', ') || 'none'})`,
      )
    }
    return found
  }
  if (module.startFunction >= 0) return module.startFunction
  for (const candidate of ['_start', 'main', '__main_argc_argv']) {
    const found = exports.get(candidate)
    if (found !== undefined) return found
  }
  const first = module.bodies[0]
  if (!first) throw new IsaError(`${ISA_NAME}: module defines no functions`)
  return first.index
}

export function loadWasm(bytes: Uint8Array, options: WasmLoadOptions = {}): LoadedWasm {
  const module = parseModule(bytes)
  const entryFunction = resolveEntry(module, options.entry)
  const body = bodyOf(module, entryFunction)
  if (!body) {
    throw new IsaError(
      `${ISA_NAME}: entry function ${entryFunction} is imported, not defined here`,
    )
  }
  const image = new WasmImage(module, BigInt(body.start))
  const interpreter = new WasmInterpreter(image, options)
  return { image, interpreter, module, entryFunction }
}
