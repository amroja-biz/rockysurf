import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Compiles the binary these tests spawn, before any of them run. See the file for why it
    // is a global setup and not a `beforeAll` (rockysurf-zrfb).
    globalSetup: ['./vitest.global-setup.ts'],
    // The end-to-end suite boots real servers, on real ports, twice over.
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
})
