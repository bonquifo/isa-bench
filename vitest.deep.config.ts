import { defineConfig } from 'vitest/config'

// Exhaustive engine verification: every canned C fixture across every backend.
// It takes minutes, so it is opt-in via `npm run test:deep` and excluded from
// the normal suite rather than run on every change.
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
