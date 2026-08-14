import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
    },
    exclude: ['tests/real-drive9.e2e.spec.ts'],
    testTimeout: 15_000,
  },
})
