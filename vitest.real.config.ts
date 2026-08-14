import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/real-drive9.e2e.spec.ts'],
    testTimeout: 60_000,
  },
})
