/**
 * Runs the WebAssembly build of LLVM -- clang, lld, llvm-ar -- against an
 * in-memory filesystem.
 *
 * The toolchain is one WASI program, the multi-call `llvm` binary, which
 * picks what to be from `argv[0]`. WASI has no processes, so the clang
 * driver cannot start a linker the way it does natively: compiling and
 * linking are two separate runs, each given exactly the arguments the
 * native driver would have passed (see toolchain.ts).
 *
 * The filesystem is the shim's own in-memory one. Inputs are placed in it
 * before a run and outputs read from it afterwards; nothing touches the
 * user's disk.
 */
import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
  WASI,
  WASIProcExit,
  type Inode,
} from '@bjorn3/browser_wasi_shim'

export interface WasiRun {
  code: number
  stdout: string
  stderr: string
}

/** A directory tree keyed by path segment. */
export type Tree = Map<string, Inode>

/** Places `bytes` at `path` (absolute, `/`-separated) in `root`. */
export function putFile(root: Directory, path: string, bytes: Uint8Array): void {
  const parts = path.split('/').filter(Boolean)
  let dir = root
  for (const part of parts.slice(0, -1)) {
    let next = dir.contents.get(part)
    if (!next) {
      next = new Directory(new Map())
      dir.contents.set(part, next)
    }
    if (!(next instanceof Directory)) throw new Error(`${path}: ${part} is a file`)
    dir = next
  }
  dir.contents.set(parts[parts.length - 1]!, new File(bytes))
}

/** Reads the file at `path` from `root`, or null when there is none. */
export function getFile(root: Directory, path: string): Uint8Array | null {
  const parts = path.split('/').filter(Boolean)
  let node: Inode | undefined = root
  for (const part of parts) {
    if (!(node instanceof Directory)) return null
    node = node.contents.get(part)
  }
  return node instanceof File ? node.data : null
}

/**
 * Runs one command of the toolchain to completion.
 *
 * `root` is mounted at `/` and shared: what one run writes, the next one
 * reads, which is how an object file gets from the compiler to the linker.
 */
export async function runWasi(
  module: WebAssembly.Module,
  argv: readonly string[],
  root: Directory,
): Promise<WasiRun> {
  const out: string[] = []
  const err: string[] = []
  const wasi = new WASI([...argv], ['PWD=/'], [
    new OpenFile(new File(new Uint8Array())),
    ConsoleStdout.lineBuffered((line) => out.push(line)),
    ConsoleStdout.lineBuffered((line) => err.push(line)),
    new PreopenDirectory('/', root.contents),
  ], { debug: false }) // the shim logs every call unless told not to
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  })
  let code: number
  try {
    code = wasi.start(instance as unknown as Parameters<WASI['start']>[0])
  } catch (error) {
    if (!(error instanceof WASIProcExit)) {
      // A trap inside the compiler. What it printed before it died is the
      // only account of why, so it goes with the error.
      const printed = [...out, ...err].join('\n')
      throw new Error(`${argv[0]} stopped: ${(error as Error).message}${printed ? `\n${printed}` : ''}`)
    }
    code = error.code
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') }
}
