/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs so the packaged desktop build loads over file://.
  base: './',
  plugins: [react(), tailwindcss()],
  // The precompiled RV64 binaries the real-ISA lane runs are inlined as
  // data URIs rather than emitted as sibling files. The packaged desktop app
  // loads over file://, where fetching a sibling file is blocked by the
  // browser engine; a data URI is not. Everything else keeps Vite's default
  // threshold, so this does not change how the rest of the bundle is built.
  build: {
    assetsInlineLimit: (filePath: string) => (filePath.endsWith('.elf') ? true : undefined),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'desktop/src/**/*.test.ts'],
    // Exhaustive engine verification lives in `npm run test:deep`.
    exclude: ['src/**/*.deep.test.ts'],
  },
})
