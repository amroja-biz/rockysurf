import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Compile the binary before any test in this package runs (rockysurf-zrfb).
 *
 * `src/bin.e2e.test.ts` spawns `dist/bin.js`, and CI's test job is `pnpm -r test` with no build
 * step ahead of it — so the compile has to happen here, or that suite tests whatever `dist/`
 * happened to already contain, which is the exact bug it was written to close.
 *
 * IT IS A GLOBAL SETUP RATHER THAN A `beforeAll` because vitest runs test files in parallel:
 * a compile inside one test file is a compile happening underneath `compose.test.ts` in another
 * thread, which is how that file failed to resolve `@rockysurf/provider-sdk` the first time this
 * was written that way. Nothing else runs during a global setup.
 *
 * IT RUNS THE PACKAGES' OWN `build` SCRIPTS, which is what makes the binary these tests spawn the
 * binary that ships. It used to invoke `tsc` by hand instead, to dodge `@rockysurf/provider-sdk`'s
 * `pnpm run clean && tsc` — that emptied a `dist/` other processes sharing the checkout were
 * importing, for the second or two the compile took. The dodge had its own cost: compiling with no
 * clean is compiling the way that let a deleted source keep a `dist/bin.js`, which is the bug this
 * file exists for. Since rockysurf-hwfw a build compiles into a scratch directory and renames it
 * into place (scripts/build-package.mjs), so there is no window left to dodge.
 */

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(packageRoot, '..', '..')

export default function build(): void {
  /**
   * This package AND everything it imports, in dependency order: the binary is useless without
   * core and the three provider packages compiled beside it.
   *
   * The braces are load-bearing. `--filter rockysurf...` also matches the workspace ROOT
   * package, which is likewise named `rockysurf` and whose `build` is `pnpm -r build` — the
   * whole workspace, web bundle included.
   */
  const built = spawnSync('pnpm', ['--filter', '{./packages/rockysurf}...', 'run', 'build'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (built.status !== 0) throw new Error(`compiling the binary failed:\n${built.stderr || built.stdout}`)

  const binPath = join(packageRoot, 'dist', 'bin.js')
  if (!existsSync(binPath)) throw new Error(`the compile produced no ${binPath}`)
}
