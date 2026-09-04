#!/usr/bin/env node
/**
 * `packages/core/packs` must match `packs/` at the repository root (rockysurf-io02).
 *
 * WHY THE COPY IS COMMITTED RATHER THAN GENERATED-AND-IGNORED. The bundle started out
 * gitignored, produced by `sync-packs-bundle.mjs` during core's build, and that arrangement has
 * one failure mode which it hit immediately: the files exist in the tree of whoever ran a build
 * and nowhere else. A local `pnpm run check` is green because the developer's tree has them; a
 * fresh clone does not, and neither does any consumer that reads them before the build step that
 * writes them. Generated state that lives only in a working tree is invisible to exactly the
 * person who could fix it.
 *
 * The second failure mode is worse because it is silent. Tests that need the bundle had to guard
 * with `skipIf(!exists)` — and a guard like that turns "the packs are missing" into "those tests
 * did not run", which reads as a pass. `CONTRIBUTING.md` is blunt about this: a test that cannot
 * fail is worse than no test.
 *
 * So the copy is a committed artifact and this lint keeps it honest, the same shape as
 * `check-iam-policy.mjs` (published policy vs. what the provider calls) and
 * `check-package-count.mjs` (three docs vs. what `pnpm publish -r` actually ships).
 * Two files that must agree, and a check that fails when they do not, is a pattern this
 * repository already trusts.
 *
 * WHAT DRIFT MEANS AND HOW TO FIX IT: you edited `packs/` and did not rebuild. Run
 * `pnpm --filter @rockysurf/core build` (its build runs the sync) and commit the result. The
 * source of truth is unchanged and unchanged-able: `packs/` at the root is where a pack is
 * authored, and ADR-0004 still says so.
 *
 * Exits 0 when they agree, 1 when they do not.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const source = join(repoRoot, 'packs')
const bundle = join(repoRoot, 'packages/core/packs')

const packFiles = (dir) => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
      .sort()
  } catch {
    return null
  }
}

const sourceFiles = packFiles(source)
const bundleFiles = packFiles(bundle)

if (sourceFiles === null) {
  console.error(`packs bundle: ${source} does not exist — this check assumes the repository layout`)
  process.exit(1)
}
if (bundleFiles === null) {
  console.error(
    `packs bundle: ${bundle} does not exist.\n` +
      '  It is a committed copy of packs/, not a build artifact you can skip.\n' +
      '  Run: pnpm --filter @rockysurf/core build   (its build writes it), then commit the result.',
  )
  process.exit(1)
}

const problems = []

const missing = sourceFiles.filter((f) => !bundleFiles.includes(f))
if (missing.length > 0) problems.push(`missing from the bundle: ${missing.join(', ')}`)

// Extra files matter as much as missing ones: a pack deleted from `packs/` but left in the
// bundle keeps shipping to every installation, which is the same class of bug as a pack that
// never shipped at all.
const extra = bundleFiles.filter((f) => !sourceFiles.includes(f))
if (extra.length > 0) problems.push(`in the bundle but not in packs/: ${extra.join(', ')}`)

// Compared as BYTES, because the digest an operator's control plane verifies is over bytes and
// a difference this check waved through would surface as a mismatch there instead.
for (const name of sourceFiles.filter((f) => bundleFiles.includes(f))) {
  const a = readFileSync(join(source, name))
  const b = readFileSync(join(bundle, name))
  if (!a.equals(b)) problems.push(`differs from packs/${name}`)
}

if (problems.length > 0) {
  console.error('packs bundle is out of date:')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('')
  console.error('  Fix: pnpm --filter @rockysurf/core build   (its build runs the sync), then commit.')
  process.exit(1)
}

console.error(`packs bundle: packages/core/packs matches packs/ (${sourceFiles.length} file(s))`)
