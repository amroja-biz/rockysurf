#!/usr/bin/env node
/**
 * Compile a workspace package into a SELF-CONTAINED `dist/` — declarations from `tsc`, one
 * bundled ESM entry from esbuild — then swap it into place (issue #368).
 *
 * WHY A SECOND BUILD SCRIPT. `scripts/build-package.mjs` compiles a package that resolves its
 * `@rockysurf/*` imports at runtime from the installation's own `node_modules`, which is right
 * for everything shipped inside the `rockysurf` CLI. A PERSONAL provider (ADR-0026) is not
 * shipped inside anything: it is extracted under `<dataDir>/providers` by an operator running
 * `tar -xzf`, and nothing in that step resolves a dependency for them (ADR-0028 as amended by
 * issue #394 — Rocky Surf has no installer at all). A personal provider therefore has to declare
 * NO runtime dependencies and carry what it needs, which for a Rocky Surf provider means the
 * SDK's handful of pure runtime helpers (`ProviderError`, `assertHostnameSafeId`,
 * `normalizeSshCidrs`, `DESCRIBE_ABSENCE_GRACE`).
 *
 * BUNDLING IS WHY THE SDK MAY BE A devDependency HERE, and the SDK is built for it: it has zero
 * runtime dependencies of its own and no export whose meaning depends on object identity
 * (`isProviderError` is structural precisely so a package carrying its own copy still works).
 * Vendoring the helpers by hand was the alternative and is worse — `normalizeSshCidrs` has to
 * agree character for character across every provider, and a copy is a copy that drifts.
 *
 * The staging-then-rename dance is `build-package.mjs`'s, for its reasons: `tsc` overwrites but
 * never deletes, and a `dist/` that is briefly absent makes concurrent readers — including
 * `pnpm pack`, which does not check that a `files` entry matched anything — see the package as
 * broken or empty.
 *
 * Usage: node ../../scripts/build-bundled-package.mjs [tsconfig] [entry]
 *   cwd is the package, as pnpm runs it. Defaults: tsconfig.build.json, src/index.ts.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const packageDir = process.cwd()
const project = process.argv[2] ?? 'tsconfig.build.json'
const entry = process.argv[3] ?? 'src/index.ts'

const dist = join(packageDir, 'dist')
const staging = join(packageDir, 'dist.build')
const previous = join(packageDir, 'dist.prev')

const discard = (path) => rmSync(path, { recursive: true, force: true })
discard(staging)
discard(previous)

const require = createRequire(join(packageDir, 'package.json'))

try {
  // Declarations only. The JavaScript comes from the bundle below, so emitting it twice would
  // leave `dist/index.js` decided by whichever step ran last.
  const tsc = require.resolve('typescript/bin/tsc')
  execFileSync(process.execPath, [tsc, '-p', project, '--outDir', staging], { stdio: 'inherit' })

  // One ESM file with every workspace import inlined. `platform: 'node'` keeps `node:*` builtins
  // external, which is the only externality a provider is allowed to have.
  const esbuild = await import(require.resolve('esbuild'))
  await esbuild.build({
    entryPoints: [join(packageDir, entry)],
    outfile: join(staging, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // No source map, for the reason `tsconfig.publish.json` gives: this tarball ships no `src/`,
    // so a map would name paths that do not exist on the consumer's disk — and
    // `scripts/verify-tarballs.mjs` fails any published tarball containing one.
    sourcemap: false,
    legalComments: 'inline',
    logLevel: 'warning',
  })
} catch (error) {
  discard(staging)
  process.exit(typeof error?.status === 'number' ? error.status : 1)
}

if (existsSync(dist)) renameSync(dist, previous)
renameSync(staging, dist)
discard(previous)
