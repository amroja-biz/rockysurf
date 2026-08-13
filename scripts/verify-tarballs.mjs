#!/usr/bin/env node
/**
 * Release tarball verification (rockysurf-3hz9).
 *
 * `scripts/check-npx-closure.mjs` guards what a published install DOWNLOADS. This one guards
 * what it UNPACKS: it packs every publishable workspace package exactly as `pnpm publish -r`
 * would, asserts what each tarball must and must not contain, and then installs the packed CLI
 * into an empty directory from those tarballs alone and runs its binary.
 *
 * THE FAILURE THIS EXISTS FOR. `pnpm pack` does not check that a `files` entry matched anything.
 * With `dist/` absent — a build that failed, was interrupted, or was cleaned by something else —
 * pack SUCCEEDS and emits a three-file tarball of `package.json`, `LICENSE` and `README.md`. It
 * installs, it resolves, and it contains no code. That happened during the verification for
 * rockysurf-3hz9 when a concurrent `pnpm -r build` emptied a sibling's `dist/` mid-run, and
 * nothing anywhere reported an error.
 *
 * THE OTHER ONE. `npx rockysurf` was unpublishable for a week because four of its five workspace
 * dependencies were `private: true`: the tarball's manifest named versions that did not exist on
 * the registry. Inspecting manifests would not have caught it — the manifest looked right. The
 * install step below is the check that does, and it uses npm `overrides` to satisfy every
 * `@rockysurf/*` specifier from a local tarball, so it proves the closure without a registry and
 * without publishing anything.
 *
 * Usage: node scripts/verify-tarballs.mjs [--no-install] [--keep] [--json]
 * Exits 0 when clean, 1 on any violation, 2 when the check could not be run at all.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(repoRoot, 'packages')
const PNPM = process.env['ROCKYSURF_PNPM'] ?? 'pnpm'

/** Nothing matching these may appear in a tarball. Sources and build config are not products. */
const FORBIDDEN_ENTRIES = [
  { pattern: /^package\/src\//, label: 'source file' },
  { pattern: /\.(test|spec)\./, label: 'test file' },
  { pattern: /^package\/tsconfig/, label: 'tsconfig' },
  { pattern: /(^|\/)node_modules\//, label: 'node_modules' },
]

/** Every publishable package: a workspace member that is not `private`. */
function publishablePackages() {
  const found = []
  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, 'package.json')
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    if (manifest.private) continue
    found.push({ dir: join(packagesDir, dir), manifest })
  }
  return found
}

/**
 * Pack one package, returning the tarball path.
 *
 * pnpm prints the file list and then the tarball path on the last line, which is more reliable
 * than reconstructing the name: the scope separator in `@rockysurf/provider-aws` becomes a dash,
 * and that mapping is pnpm's business, not ours.
 */
function pack(dir, destination) {
  const stdout = execFileSync(PNPM, ['pack', '--pack-destination', destination], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const lines = stdout.trim().split('\n')
  const last = lines[lines.length - 1]?.trim()
  if (!last?.endsWith('.tgz')) throw new Error(`could not read the tarball path out of \`pnpm pack\` in ${dir}`)
  return last
}

const listEntries = (tarball) =>
  execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)

const readManifest = (tarball) =>
  JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }),
  )

/**
 * Every rule, against one already-packed tarball.
 *
 * Pure in its inputs so a test can hand it a bad tarball's contents without having to produce
 * one.
 */
export function checkTarball(name, entries, manifest) {
  const violations = []
  const fail = (detail) => violations.push({ package: name, detail })

  if (!entries.includes('package/LICENSE')) {
    fail('no LICENSE in the tarball — pnpm copies the root one in, so this means it was packed by npm')
  }
  if (!entries.includes('package/README.md')) fail('no README.md — a public package with no front page')

  const dist = entries.filter((e) => e.startsWith('package/dist/'))
  if (dist.length === 0) {
    fail('no dist/ — `files` listed it and pack matched nothing, so this tarball contains no code')
  }

  for (const entry of entries) {
    for (const { pattern, label } of FORBIDDEN_ENTRIES) {
      if (pattern.test(entry)) fail(`ships a ${label}: ${entry}`)
    }
  }

  if (manifest.private) fail('`private: true` survived into the tarball')
  if (!manifest.license) fail('no `license` field')

  const specifiers = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }
  for (const [dep, range] of Object.entries(specifiers)) {
    if (String(range).startsWith('workspace:')) {
      fail(`\`workspace:\` specifier survived the publish rewrite: ${dep}@${range}`)
    }
  }

  if (manifest.name.startsWith('@') && manifest.publishConfig?.access !== 'public') {
    fail('scoped package without `publishConfig.access: "public"` — npm would publish it restricted')
  }

  return violations
}

/**
 * Install the packed CLI into an empty directory and run its binary.
 *
 * `overrides` points every `@rockysurf/*` specifier at a local tarball, which is what makes this
 * a closure check rather than a registry check: if a dependency were missing from the set, npm
 * would go looking for it on the registry and fail.
 */
function installSmoke(packed, workDir) {
  const cli = packed.find((p) => p.manifest.name === 'rockysurf')
  if (!cli) return [{ package: 'rockysurf', detail: 'the CLI package was not among the publishable packages' }]

  const overrides = Object.fromEntries(
    packed.filter((p) => p.manifest.name.startsWith('@rockysurf/')).map((p) => [p.manifest.name, `file:${p.tarball}`]),
  )
  writeFileSync(
    join(workDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'rockysurf-pack-smoke',
        private: true,
        version: '0.0.0',
        dependencies: { rockysurf: `file:${cli.tarball}` },
        overrides,
      },
      null,
      2,
    )}\n`,
  )

  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: workDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return [{ package: 'rockysurf', detail: `the packed CLI does not install from its own tarballs: ${detail}` }]
  }

  let reported
  try {
    reported = execFileSync(join(workDir, 'node_modules', '.bin', 'rockysurf'), ['--version'], {
      cwd: workDir,
      encoding: 'utf8',
    }).trim()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return [{ package: 'rockysurf', detail: `the installed binary does not run: ${detail}` }]
  }

  if (reported !== cli.manifest.version) {
    return [
      {
        package: 'rockysurf',
        detail: `the installed binary reports ${reported}, but the package is ${cli.manifest.version}`,
      },
    ]
  }
  return []
}

function main() {
  const argv = process.argv.slice(2)
  const withInstall = !argv.includes('--no-install')
  const keep = argv.includes('--keep')

  const workDir = mkdtempSync(join(tmpdir(), 'rockysurf-verify-'))
  const tarballDir = join(workDir, 'tarballs')
  const installDir = join(workDir, 'install')
  execFileSync('mkdir', ['-p', tarballDir, installDir])

  const violations = []
  const packed = []

  try {
    for (const { dir, manifest } of publishablePackages()) {
      const tarball = pack(dir, tarballDir)
      packed.push({ manifest, tarball })
      violations.push(...checkTarball(manifest.name, listEntries(tarball), readManifest(tarball)))
    }
  } catch (err) {
    console.error(`tarball verification: ${err instanceof Error ? err.message : String(err)}`)
    console.error('This check packs the workspace, so it needs `pnpm install` and `pnpm -r build` to have run.')
    process.exit(2)
  }

  if (withInstall && violations.length === 0) violations.push(...installSmoke(packed, installDir))

  const result = {
    ok: violations.length === 0,
    violations,
    packages: packed.map((p) => ({ name: p.manifest.name, version: p.manifest.version })),
    installChecked: withInstall,
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.ok) {
    console.log(`tarball verification: OK — ${packed.length} publishable packages`)
    for (const p of result.packages) console.log(`  ${p.name}@${p.version}`)
    console.log(
      withInstall
        ? '  the packed CLI installs from these tarballs alone and its binary runs.'
        : '  install smoke SKIPPED (--no-install), so nothing here proves the closure is installable.',
    )
  } else {
    console.error(`tarball verification: ${violations.length} violation(s)\n`)
    for (const v of violations) console.error(`  ${v.package}: ${v.detail}`)
    console.error('\nA tarball is the only honest evidence about a release. See docs/RELEASING.md.')
  }

  if (keep || !result.ok) console.error(`\nartifacts left in ${workDir}`)
  else rmSync(workDir, { recursive: true, force: true })

  process.exit(result.ok ? 0 : 1)
}

// Importable for tests; runs only when executed directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
