/**
 * Finds and loads the in-app compiler.
 *
 * The desktop app serves it under the isa-toolchain: scheme from its
 * resources; the development server serves it at /toolchain/. Either way
 * it is fetched once, on the first custom-C comparison that asks for real
 * instruction sets, and kept: compiling the WebAssembly module takes a few
 * seconds and does not need doing twice.
 *
 * An app built without the toolchain says so, rather than failing a run:
 * `toolchainAvailable` answers before anything is fetched past the
 * manifest.
 */
import { Toolchain } from './toolchain.ts'

/** Where the bundle is, for this build of the app. */
export function toolchainBase(): string {
  const desktop = typeof window !== 'undefined' ? window.isaBenchDesktop : undefined
  return desktop ? 'isa-toolchain://bundle/' : new URL('toolchain/', document.baseURI).href
}

let loading: Promise<Toolchain> | null = null

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Whether this build of the app has a compiler to load. */
export async function toolchainAvailable(base = toolchainBase()): Promise<boolean> {
  try {
    const response = await fetch(`${base}manifest.json`)
    return response.ok
  } catch {
    return false
  }
}

/** The toolchain, loaded on first use and kept. */
export function loadToolchain(base = toolchainBase()): Promise<Toolchain> {
  loading ??= (async () => {
    const [llvm, mos, sysroot] = await Promise.all([
      fetchBytes(`${base}llvm.wasm`).then((bytes) => WebAssembly.compile(bytes)),
      fetchBytes(`${base}mos.wasm`).then((bytes) => WebAssembly.compile(bytes)),
      fetchBytes(`${base}sysroot.tar`),
    ])
    return new Toolchain({ llvm, mos, sysroot })
  })()
  loading.catch(() => { loading = null })
  return loading
}
