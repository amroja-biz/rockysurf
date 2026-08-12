#!/usr/bin/env node
/**
 * Core dependency lint (rockysurf-gonw.1; the enforcement half of rockysurf-gonw.3).
 *
 * Two rules, both from the plan and ADR-0001:
 *
 *   1. `@rockysurf/core` may depend on `@rockysurf/provider-sdk` and nothing else in this
 *      workspace. Never a concrete provider, never the web package.
 *   2. Provider packages may not depend on `@rockysurf/core`.
 *
 * Why it is worth a CI job rather than a code-review habit:
 *
 *   - The SDK has no out-of-tree consumers yet, so this lint is the ONLY thing keeping the
 *     abstraction honest. If core can reach into `provider-aws`, the interface stops being
 *     tested by anything and quietly rots into a formality.
 *   - It keeps the AWS SDK out of core's dependency tree, which is what makes an `npx` cold
 *     start fast. That regression would be invisible until someone times a fresh install.
 *
 * Checks BOTH declared dependencies and actual import statements: a package.json entry alone
 * misses a deep import, and an import alone misses a dependency added in anticipation.
 *
 * Usage: node scripts/check-core-deps.mjs [--json]
 * Exits 0 when clean, 1 on any violation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(repoRoot, 'packages')

/**
 * THE COMPOSITION ROOT (rockysurf-55fx.12).
 *
 * `rockysurf` is the ONE package allowed to import both core and a concrete provider, because
 * somebody has to build the registry and core is forbidden from doing it. It is deliberately
 * absent from the table below, and this comment is the record of that being a decision rather
 * than an omission: if a second package ever needs both, that is a design change to argue for,
 * not a line to quietly add.
 */
const COMPOSITION_ROOT = 'rockysurf'

/** package name → workspace names it must never reach. */
const FORBIDDEN = {
  '@rockysurf/core': ['@rockysurf/provider-aws', '@rockysurf/provider-hetzner', '@rockysurf/provider-byo', '@rockysurf/web'],
  '@rockysurf/provider-aws': ['@rockysurf/core'],
  '@rockysurf/provider-hetzner': ['@rockysurf/core'],
  '@rockysurf/provider-byo': ['@rockysurf/core'],
  // The SDK depends on nothing at all; its own test suite asserts that too.
  '@rockysurf/provider-sdk': [
    '@rockysurf/core',
    '@rockysurf/provider-aws',
    '@rockysurf/provider-hetzner',
    '@rockysurf/provider-byo',
    '@rockysurf/web',
  ],
}

// `.cjs` belongs here for the same reason the `require()` pattern below does: CommonJS is
// exactly where a `require('@rockysurf/provider-aws')` would hide, and leaving the extension
// out made that the one import style the lint could not see. Covered by the fixture test.
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage'])

/** `import x from 'y'`, `export * from 'y'`, `import('y')`, `require('y')`. */
const SPECIFIER_PATTERNS = [
  /(?:^|\s)(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\s)import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) out.push(full)
  }
  return out
}

/** 1-based line number of the character at `index`. */
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/**
 * Index of where the statement really starts.
 *
 * Every pattern above opens with `(?:^|\s)`, and `^` only matches index 0 without the `m`
 * flag — so for any import below the first line the engine matches the `\n` that ENDS the
 * previous line, and the reported line number comes out one too low. Skipping the matched
 * leading whitespace puts it back on the statement itself, which is the line a developer
 * needs to open. Regression-covered in packages/core/src/dependency-lint.test.ts.
 */
function statementStart(match) {
  return match.index + (match[0].length - match[0].trimStart().length)
}

/** A specifier reaches a package if it equals it or is a deep import into it. */
function reaches(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`)
}

const violations = []

let packageDirs
try {
  packageDirs = readdirSync(packagesDir).filter((d) => !SKIP_DIRS.has(d))
} catch {
  console.error(`no packages/ directory at ${packagesDir}`)
  process.exit(1)
}

for (const dir of packageDirs) {
  const pkgPath = join(packagesDir, dir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    continue // not a package
  }

  const forbidden = FORBIDDEN[pkg.name]
  if (!forbidden) continue

  // 1. declared dependencies of every kind
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const depName of Object.keys(pkg[field] ?? {})) {
      if (forbidden.includes(depName)) {
        violations.push({
          package: pkg.name,
          file: relative(repoRoot, pkgPath),
          line: 0,
          kind: 'dependency',
          detail: `${field} contains ${depName}`,
        })
      }
    }
  }

  // 2. actual imports in source
  for (const file of walk(join(packagesDir, dir, 'src'))) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        const specifier = match[1]
        const hit = forbidden.find((name) => reaches(specifier, name))
        if (hit) {
          violations.push({
            package: pkg.name,
            file: relative(repoRoot, file),
            line: lineOf(text, statementStart(match)),
            kind: 'import',
            detail: `imports ${specifier}`,
          })
        }
      }
    }
  }
}

/**
 * The composition root must actually exist and reach both sides. Without this, deleting it or
 * dropping one of its dependencies would leave the lint passing while `npx rockysurf` came up
 * with no cloud provider at all — the exact silent failure that made this package necessary.
 *
 * Only checked on a REAL workspace. The lint's own tests build miniature repositories in temp
 * directories to prove the boundary rules fail when crossed, and those fixtures model two or
 * three packages rather than the whole distribution. Keying on `pnpm-workspace.yaml` — which
 * the real repo has and a fixture does not — keeps this check meaningful where it matters
 * without making every fixture carry a composition root it is not testing.
 */
const isRealWorkspace = existsSync(join(repoRoot, 'pnpm-workspace.yaml'))
const compositionPkgPath = join(packagesDir, COMPOSITION_ROOT, 'package.json')
if (isRealWorkspace) try {
  const pkg = JSON.parse(readFileSync(compositionPkgPath, 'utf8'))
  const deps = Object.keys(pkg.dependencies ?? {})
  for (const required of ['@rockysurf/core', '@rockysurf/provider-hetzner', '@rockysurf/provider-aws']) {
    if (!deps.includes(required)) {
      violations.push({
        package: pkg.name,
        file: relative(repoRoot, compositionPkgPath),
        line: 0,
        kind: 'dependency',
        detail: `composition root is missing ${required} — providers would not reach the registry`,
      })
    }
  }
} catch {
  violations.push({
    package: COMPOSITION_ROOT,
    file: relative(repoRoot, compositionPkgPath),
    line: 0,
    kind: 'dependency',
    detail: 'the composition root package is missing; core cannot load providers without it',
  })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2))
} else if (violations.length === 0) {
  console.log('core dependency lint: OK')
  console.log('  @rockysurf/core reaches @rockysurf/provider-sdk only; no provider imports core.')
  console.log(`  ${COMPOSITION_ROOT} is the only package that reaches both, and it wires them.`)
} else {
  console.error(`core dependency lint: ${violations.length} violation(s)\n`)
  for (const v of violations) {
    const where = v.line ? `${v.file}:${v.line}` : v.file
    console.error(`  ${where}\n    ${v.package} ${v.detail}`)
  }
  console.error('\nCore must depend on @rockysurf/provider-sdk only. Providers are loaded at')
  console.error('runtime through configuration, never imported by core.')
}

process.exit(violations.length === 0 ? 0 : 1)
