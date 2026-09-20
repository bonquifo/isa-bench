import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.deep.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    sequence: {
      concurrent: false,
    },
  },
})
