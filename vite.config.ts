/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs so the packaged desktop build loads over file://.
  base: './',
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'desktop/src/**/*.test.ts'],
    // Exhaustive engine verification lives in `npm run test:deep`.
    exclude: ['src/**/*.deep.test.ts'],
  },
})
