import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * The port jsdom's document origin carries. Fixed because an environment's URL has to be known
 * before the suite starts.
 *
 * NOTHING LISTENS HERE any more (rockysurf-t215). Stub servers take an ephemeral port from the
 * OS and register it with the relative-URL shims; this only gives the document a plausible
 * same-origin base, and is what those shims fall back to when no stub server is running.
 */
export const DOCUMENT_ORIGIN_PORT = 34567

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
      // A loopback origin, so the SPA's same-origin `/api/v1` default is a legal relative URL
      // and the tests exercise the production configuration rather than a base-URL override.
      // Which port actually serves is decided per test file — see src/test-server.ts.
      jsdom: { url: `http://127.0.0.1:${DOCUMENT_ORIGIN_PORT}` },
    },
    // A component test that hangs is almost always a stream or a timer nobody closed, and a
    // short timeout surfaces that as a failure instead of a stalled suite.
    testTimeout: 10_000,
    /**
     * One file at a time.
     *
     * THE ORIGINAL REASON IS GONE AND THIS IS DELIBERATELY STILL HERE (rockysurf-t215).
     * Suites that exercise real HTTP used to bind one hardcoded port, so two files in parallel
     * fought over the socket. They now take an ephemeral one from the OS (`test-server.ts`),
     * which is what made the suite stop failing under a loaded machine — and serialising the
     * files never prevented that anyway, because a socket is not released the instant
     * `server.close()` returns.
     *
     * So this setting no longer protects anything known. It is left on because turning it off
     * is a change with its own risk — every other piece of module-level state these files share
     * would suddenly be concurrent — and that deserves its own measurement rather than riding
     * along with a flake fix.
     */
    fileParallelism: false,
  },
})
