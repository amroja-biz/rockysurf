#!/usr/bin/env node
/**
 * Package-count drift lint (rockysurf-aec9).
 *
 * The number of packages published to npm is stated as prose in three places — README.md,
 * docs/self-hosting.md and docs/RELEASING.md — plus a table in docs/RELEASING.md that lists
 * them by name. None of that is derived; all four are typed by hand, and they have drifted
 * before: README said "eight", self-hosting said "six", RELEASING published nine and listed
 * them in a table (found in rockysurf-emfu, fixed in PR #6).
 *
 * The truth is `packages/*\/package.json` without `"private": true` — that set is what
 * `pnpm publish -r` actually ships, independent of anything anyone wrote down about it. This
 * lint computes that truth, checks the RELEASING table against it, then checks every "<number>
 * packages" statement in all three docs against it.
 *
 * Usage: node scripts/check-package-count.mjs [--json]
 * Exits 0 when everything agrees, 1 on any divergence.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(repoRoot, 'packages')

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
}

const DOCS = ['README.md', 'docs/self-hosting.md', 'docs/RELEASING.md']
const RELEASING_TABLE_HEADING = 'What is published, and what is not'

/** Every `packages/*\/package.json` whose name is not `"private": true`, sorted. */
function publishablePackages() {
  let dirs
  try {
    dirs = readdirSync(packagesDir)
  } catch {
    throw new Error(`no packages/ directory at ${packagesDir}`)
  }
  const names = []
  for (const dir of dirs) {
    const pkgPath = join(packagesDir, dir, 'package.json')
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    } catch {
      continue // not a package directory
    }
    if (pkg.private === true) continue
    if (typeof pkg.name !== 'string') continue
    names.push(pkg.name)
  }
  if (names.length === 0) throw new Error(`no publishable package.json files found under ${packagesDir}`)
  return names.sort()
}

/**
 * The rows of the "What is published, and what is not" table in docs/RELEASING.md — the FIRST
 * table after that heading (there is a second one, for the packages that stay private, which
 * this deliberately stops before). Returns `{ name }` per row, name with backticks stripped.
 *
 * A line scanner rather than a markdown parser, matching the style of the other doc-vs-reality
 * lints in this directory (e.g. check-packs-bundle.mjs): this repo's tables are simple enough
 * that a real parser would be more code to trust, not less.
 */
function releasingTableRows(source) {
  const headingIdx = source.indexOf(RELEASING_TABLE_HEADING)
  if (headingIdx === -1) {
    throw new Error(`docs/RELEASING.md: no "${RELEASING_TABLE_HEADING}" heading found`)
  }
  const lines = source.slice(headingIdx).split('\n')

  let inTable = false
  const rows = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inTable) {
      if (trimmed.startsWith('| package |')) inTable = true
      continue
    }
    if (!trimmed.startsWith('|')) break // table ended
    if (/^\|\s*-+\s*\|/.test(trimmed)) continue // header separator row
    const cells = trimmed.split('|').map((c) => c.trim())
    const name = (cells[1] ?? '').replace(/`/g, '').trim()
    if (name) rows.push({ name })
  }
  if (rows.length === 0) {
    throw new Error('docs/RELEASING.md: "What is published" table parsed to no rows — has it been reformatted?')
  }
  return rows
}

/** Every `<number> packages` statement in `source` (number word or digits), with its line. */
function countStatements(source) {
  const statements = []
  const wordPattern = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\s+packages\\b`, 'gi')
  const digitPattern = /\b(\d+)\s+packages\b/g
  source.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(wordPattern)) {
      statements.push({ line: i + 1, text: m[0], count: NUMBER_WORDS[m[1].toLowerCase()] })
    }
    for (const m of line.matchAll(digitPattern)) {
      statements.push({ line: i + 1, text: m[0], count: Number(m[1]) })
    }
  })
  return statements
}

function main() {
  const packages = publishablePackages()
  const truth = packages.length

  const releasingPath = join(repoRoot, 'docs', 'RELEASING.md')
  const releasingSource = readFileSync(releasingPath, 'utf8')
  const tableRows = releasingTableRows(releasingSource)
  const tableNames = tableRows.map((r) => r.name).sort()

  const problems = []

  const missingFromTable = packages.filter((p) => !tableNames.includes(p))
  const extraInTable = tableNames.filter((p) => !packages.includes(p))
  if (missingFromTable.length > 0 || extraInTable.length > 0) {
    const detail = []
    if (missingFromTable.length > 0) detail.push(`missing from the table: ${missingFromTable.join(', ')}`)
    if (extraInTable.length > 0) detail.push(`in the table but not a publishable package.json: ${extraInTable.join(', ')}`)
    problems.push(
      `docs/RELEASING.md: "What is published" table (${tableRows.length} row(s)) disagrees with ` +
        `packages/*/package.json (${truth} publishable package(s)) — ${detail.join('; ')}`,
    )
  }

  for (const doc of DOCS) {
    const source = doc === 'docs/RELEASING.md' ? releasingSource : readFileSync(join(repoRoot, doc), 'utf8')
    for (const statement of countStatements(source)) {
      if (statement.count !== truth) {
        problems.push(`${doc}:${statement.line}: says "${statement.text}", but the actual count is ${truth}`)
      }
    }
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: problems.length === 0, truth, packages, problems }, null, 2))
  } else if (problems.length === 0) {
    console.log(`package count lint: OK — ${truth} publishable packages, RELEASING.md table and all docs agree`)
  } else {
    console.error(`package count lint: ${problems.length} problem(s)\n`)
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(
      `\nThe truth is packages/*/package.json without "private": true (currently ${truth}: ${packages.join(', ')}).`,
    )
    console.error('Fix the doc to match, or fix the package that drifted.')
  }

  process.exit(problems.length === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error(`check-package-count: ${err.message}`)
  process.exit(1)
}
