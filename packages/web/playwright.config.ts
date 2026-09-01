import { defineConfig, devices } from '@playwright/test'

/**
 * THE BROWSER LAYER (issue #310).
 *
 * Two UI regressions shipped in one day with unit tests, component tests and real-HTTP API
 * verification all green. The gap was structural rather than a missing case: nothing in the
 * gate ever loaded the built SPA into a browser engine and clicked what an operator clicks.
 * `pnpm run test:ui` is that layer, and `e2e/control-plane.ts` explains what it boots.
 *
 * IT IS NOT PART OF `pnpm run check`, deliberately. The serial gate has to stay fast enough
 * that a contributor runs it before every push, and this needs a browser binary installed
 * (`npx playwright install chromium`) that `pnpm install` does not fetch. A gate that fails on
 * a clean checkout for a reason the error does not explain gets worked around, not fixed. It is
 * a separate script and a separate CI job — `UI (browser)` — which is always-run on pull
 * requests so it can become a required check once it has baked (see
 * `docs/memories/2026-08-31-branch-protection-and-pr-workflow.md` for why a required check must
 * never be path-filtered).
 *
 * `.e2e.ts`, NOT `.spec.ts`. Vitest's default `include` picks up any `.spec.ts` anywhere, so a
 * Playwright file under that name would be collected by `pnpm -r test` as well — where it
 * would fail on the first `@playwright/test` import, in the job that gates merges, for a
 * reason with nothing to do with the change.
 */

/**
 * NO `webServer` BLOCK, and that is the point rather than an omission.
 *
 * Playwright's `webServer` starts ONE server for the whole run, from a fixed URL somebody has
 * to write down. These tests write to a configuration file and read it back, so they need an
 * installation each worker owns outright, on a port nobody chose in advance — which is a worker
 * fixture (`e2e/fixtures.ts`), not a config field.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',

  /* Failure evidence, all of it gitignored and all of it uploaded by CI. A browser test that
     fails on a runner and nowhere else is close to undebuggable without the trace. */
  outputDir: './test-results',
  reporter: process.env['CI']
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    /* `baseURL` is supplied per worker by the `controlPlane` fixture — there is no fixed URL
       to put here, and a placeholder would only be a thing to get out of date. */
  },

  /* FILES in parallel, tests within a file in order, in one worker — so one file is one
     installation with a predictable history. These tests write to a configuration file and
     read it back; `fullyParallel` would scatter a file's tests across workers and make "what
     is in the file now" depend on the scheduler. */
  fullyParallel: false,
  /* A `.only` left in a file passes locally and silently narrows the suite in CI, which is the
     failure mode this layer exists to end rather than to acquire. */
  forbidOnly: Boolean(process.env['CI']),
  /* One retry on CI, none locally. Each worker boots a real process and binds a real socket, so
     the residual flake this cannot design away is infrastructural; a local run should show it. */
  retries: process.env['CI'] ? 1 : 0,
  /* Each worker boots its OWN Rocky Surf — a process, a SQLite database and a config file — so
     workers are not free the way they are for a suite hitting one shared server. Two on CI. */
  workers: process.env['CI'] ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
