#!/usr/bin/env node
/**
 * Copy the built SPA into `packages/core/public`, where core serves it from (rockysurf-a29w).
 *
 * WHY THIS EXISTS. Core serves the SPA from its own process (ADR-0001) by resolving
 * `../public` relative to its own module — see `resolvePublicDir()` in `core/src/server.ts`.
 * Nothing produced that directory. `pnpm -r build` built the bundle into `packages/web/dist`
 * and stopped; the Dockerfile did its own `cp` on the way into the image, and the release
 * path was documented as "the release path copies it". So the only way a developer's checkout
 * ever had a `core/public` was somebody copying it by hand — which is exactly what happened,
 * once, on 2026-08-12, and is why the served bundle then sat frozen at whatever the SPA
 * looked like at that minute while the source moved on. A stale hand-copied bundle looks
 * identical to a broken build, and neither the type checker nor the test suite can see it.
 *
 * So the copy belongs in the build, and this is it: `@rockysurf/web`'s build runs it, which
 * makes `pnpm -r build` produce a core that serves the SPA that was just built. The
 * Dockerfile's `cp` stays valid — it is now a no-op repeat rather than the only copy.
 *
 * WHY A SWAP RATHER THAN A COPY IN PLACE. Same reason `build-package.mjs` swaps `dist/`: a
 * reader of `public/` should see the whole old bundle or the whole new one, never a directory
 * half-populated with an index.html pointing at assets that are not there yet. Copy into a
 * scratch sibling, then rename over.
 *
 * Usage: node ../../scripts/sync-web-bundle.mjs   — cwd is packages/web, as pnpm runs it.
 */
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const webDir = process.cwd()
const source = join(webDir, 'dist')
const target = join(webDir, '..', 'core', 'public')
const staging = `${target}.build`
const previous = `${target}.prev`

if (!existsSync(join(source, 'index.html'))) {
  console.error(`sync-web-bundle: no build to copy — ${source}/index.html does not exist`)
  process.exit(1)
}

const discard = (path) => rmSync(path, { recursive: true, force: true })
discard(staging)
discard(previous)

cpSync(source, staging, { recursive: true })
if (existsSync(target)) renameSync(target, previous)
renameSync(staging, target)
discard(previous)
