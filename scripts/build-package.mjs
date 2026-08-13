#!/usr/bin/env node
/**
 * Compile a workspace package into a scratch directory, then swap it into `dist/` (rockysurf-hwfw).
 *
 * WHY NOT A BARE `tsc`. tsc overwrites, it never deletes, so a file whose source is gone lives on in
 * `dist/` indefinitely — and it is still there for anything that spawns or imports it. That is how
 * `packages/core/dist/bin.js` outlived the deletion of `src/bin.ts` by two commits and kept seven
 * end-to-end tests green against a binary that no longer existed (rockysurf-zrfb).
 *
 * WHY NOT `rm -rf dist && tsc`. That is the obvious fix, and it buys the stale artifact off with a
 * worse one: `dist/` is then ABSENT for the whole compile, seconds at a time, and in a checkout
 * shared with other builds anything reading the package during that window sees it as broken.
 * rockysurf-3hz9 hit all three variants — a typecheck failing with `Cannot find module
 * @rockysurf/provider-sdk`, a test failing with `Failed to resolve entry for package`, and worst,
 * `pnpm pack` succeeding on an empty `dist/` and emitting a three-file tarball containing no code,
 * because pack does not check that a `files` entry matched anything.
 *
 * SO: compile into `dist.build/`, move `dist/` aside, rename the scratch directory into its place.
 * A reader sees the whole old tree or the whole new one, and the gap between the two renames is two
 * syscalls instead of a compile. A failed compile leaves the previous `dist/` untouched, which also
 * means a broken build can no longer be the thing that produces a code-free tarball.
 *
 * Only `dist/` is ever touched. `packages/core/public` is its sibling, holds the web bundle, and is
 * produced by the release path rather than by any build here — see the Dockerfile.
 *
 * `dist/` MUST END UP A REAL DIRECTORY, which renaming one into place gives for free. Pointing it at
 * a symlink instead would be a tempting way to make the swap a single syscall, and it would break
 * `packages/rockysurf/src/bin.e2e.test.ts`, which copies the built `dist/` into a scratch overlay to
 * prove the binary reports its own version rather than `@rockysurf/core`'s (rockysurf-aor6).
 *
 * Usage: node ../../scripts/build-package.mjs [tsconfig]   — cwd is the package, as pnpm runs it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const packageDir = process.cwd()
const project = process.argv[2] ?? 'tsconfig.build.json'

const dist = join(packageDir, 'dist')
const staging = join(packageDir, 'dist.build')
const previous = join(packageDir, 'dist.prev')

// Fixed names rather than unique ones, so that a build interrupted anywhere below self-heals on the
// next run instead of stranding a directory nobody will ever look at again. Both are gitignored.
const discard = (path) => rmSync(path, { recursive: true, force: true })
discard(staging)
discard(previous)

const tsc = createRequire(join(packageDir, 'package.json')).resolve('typescript/bin/tsc')
try {
  execFileSync(process.execPath, [tsc, '-p', project, '--outDir', staging], { stdio: 'inherit' })
} catch (error) {
  discard(staging)
  process.exit(typeof error?.status === 'number' ? error.status : 1)
}

if (existsSync(dist)) renameSync(dist, previous)
renameSync(staging, dist)
discard(previous)
