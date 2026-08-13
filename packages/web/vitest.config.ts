import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Fixed rather than ephemeral because jsdom's document origin has to be known before the
 * suite starts, and the SPA resolves its API URLs against that origin.
 */
export const STUB_PORT = 34567

/**
 * THE TEST-RUNNER DECISION, recorded because it was an open question.
 *
 * The choice was between forking this package onto vitest 4 (the current major) or staying on
 * the workspace's vitest 3 with a config of its own. Stayed on 3, deliberately.
 *
 * The only thing web actually needs that the other packages do not is a DOM: core's tests run
 * in `node`, component tests need `jsdom`. That is an environment setting — a config knob —
 * not a runner version. Forking the major would buy nothing for it while costing a second set
 * of runner semantics to keep in mind, two upgrade paths, and two vitest majors resolving in
 * one pnpm store. When the workspace moves to vitest 4 it should move all at once.
 *
 * This file exists rather than a `test` block in `vite.config.ts` because vitest 3 types that
 * block through `vitest/config`, and importing it into the build config makes the production
 * build typecheck depend on the test runner — the exact tangle that broke this package's
 * typecheck earlier in the milestone.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test-setup.ts'],
    environmentOptions: {
      // The document's origin IS the stub server's, so the SPA's same-origin `/api/v1`
      // default resolves to it. That means the tests exercise the production configuration
      // — no base URL override — rather than the dev-only escape hatch.
      jsdom: { url: `http://127.0.0.1:${STUB_PORT}` },
    },
    // A component test that hangs is almost always a stream or a timer nobody closed, and a
    // short timeout surfaces that as a failure instead of a stalled suite.
    testTimeout: 10_000,
    /**
     * One file at a time.
     *
     * Suites that exercise real HTTP bind STUB_PORT, because jsdom's document origin is fixed
     * at that port and the SPA resolves its API URLs against it — which is the whole point,
     * since it means the same-origin production path is what gets tested. Two such files in
     * parallel fight over the socket, and the loser hangs until the timeout rather than
     * failing with anything that names the cause.
     */
    fileParallelism: false,
  },
})
