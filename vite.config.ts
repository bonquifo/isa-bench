/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Serves the in-app compiler (toolchain/, see tools/isa/build-toolchain.ts)
 * to the development server at /toolchain/. The packaged app serves it from
 * its resources under its own scheme instead; neither copies it into the
 * bundle, which it would multiply several times over.
 */
function devToolchain(): Plugin {
  const files = new Set(['llvm.wasm', 'mos.wasm', 'sysroot.tar', 'manifest.json'])
  return {
    name: 'isa-dev-toolchain',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/toolchain', (request, response, next) => {
        const name = (request.url ?? '').replace(/^\/+/, '').split('?')[0]!
        const path = join(import.meta.dirname, 'toolchain', name)
        if (!files.has(name) || !existsSync(path)) return next()
        if (name.endsWith('.wasm')) response.setHeader('Content-Type', 'application/wasm')
        createReadStream(path).pipe(response)
      })
    },
  }
}

export default defineConfig({
  // Relative asset URLs so the packaged desktop build loads over file://.
  base: './',
  plugins: [react(), tailwindcss(), devToolchain()],
  // The precompiled binaries the real-ISA lane runs are inlined as data
  // URIs rather than emitted as sibling files. The packaged desktop app
  // loads over file://, where fetching a sibling file is blocked by the
  // browser engine; a data URI is not. Everything else keeps Vite's default
  // threshold, so this does not change how the rest of the bundle is built.
  //
  // `.bin` is the 6502's shipped format: its linker emits a chunked memory
  // image rather than an ELF, and the image is what the simulator ran and
  // so what the corpus tier compared against.
  // The desktop shell loads http://127.0.0.1:5173 in development, so the
  // server listens exactly there. Left to choose, it bound `localhost` --
  // on Windows the IPv6 loopback -- and moved to another port when that was
  // taken, and Electron then loaded a page nothing was serving.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    assetsInlineLimit: (filePath: string) =>
      filePath.endsWith('.elf') || filePath.endsWith('.bin') ? true : undefined,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'desktop/src/**/*.test.ts'],
    // Exhaustive engine verification lives in `npm run test:deep`.
    exclude: ['src/**/*.deep.test.ts'],
    // A timeout is here to catch a hang, not to measure speed. Whole-program
    // tests take a second or two alone and several times that while the
    // in-app compiler's tests have V8 compiling 175 MB of WebAssembly on
    // every core, which vitest's 5 s default turned into failures.
    testTimeout: 30_000,
  },
})
