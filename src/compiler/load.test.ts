// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Finding and loading the in-app compiler, with the network stubbed: what
 * is fetched, from where, and what happens when it is not there.
 */
vi.mock('./toolchain.ts', () => ({
  Toolchain: class {
    readonly files: unknown
    constructor(files: unknown) { this.files = files }
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  delete (window as { isaBenchDesktop?: unknown }).isaBenchDesktop
})

describe('where the compiler is', () => {
  it('is the desktop scheme in the desktop app, and beside the page elsewhere', async () => {
    const { toolchainBase } = await import('./load.ts')
    expect(toolchainBase()).toBe(new URL('toolchain/', document.baseURI).href)
    ;(window as { isaBenchDesktop?: unknown }).isaBenchDesktop = {}
    expect(toolchainBase()).toBe('isa-toolchain://bundle/')
  })
})

describe('whether this build has one', () => {
  it('answers from the manifest alone', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const { toolchainAvailable } = await import('./load.ts')
    expect(await toolchainAvailable('base/')).toBe(true)
    expect(fetch).toHaveBeenCalledWith('base/manifest.json')
  })

  it('says no when the manifest is missing or the fetch fails', async () => {
    const { toolchainAvailable } = await import('./load.ts')
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    expect(await toolchainAvailable('base/')).toBe(false)
    vi.stubGlobal('fetch', async () => { throw new TypeError('offline') })
    expect(await toolchainAvailable('base/')).toBe(false)
  })
})

describe('loading it', () => {
  it('fetches both compilers and the sysroot once, and keeps them', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url)
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    })
    vi.stubGlobal('WebAssembly', { ...WebAssembly, compile: async (bytes: Uint8Array) => ({ bytes }) })
    const { loadToolchain } = await import('./load.ts')
    const first = await loadToolchain('base/')
    const second = await loadToolchain('base/')
    expect(second).toBe(first)
    expect(fetched.sort()).toEqual(['base/llvm.wasm', 'base/mos.wasm', 'base/sysroot.tar'])
  })

  it('tries again after a failed load, rather than keeping the failure', async () => {
    let fail = true
    vi.stubGlobal('fetch', async () => (fail
      ? new Response('', { status: 500 })
      : new Response(new Uint8Array([1]), { status: 200 })))
    vi.stubGlobal('WebAssembly', { ...WebAssembly, compile: async () => ({}) })
    const { loadToolchain } = await import('./load.ts')
    await expect(loadToolchain('base/')).rejects.toThrow(/500/)
    fail = false
    await expect(loadToolchain('base/')).resolves.toBeTruthy()
  })
})
