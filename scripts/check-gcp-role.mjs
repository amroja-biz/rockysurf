#!/usr/bin/env node
/**
 * GCP custom-role drift lint (rockysurf-ev41.7).
 *
 * Rocky Surf publishes its minimal GCP permission set twice, because both copies have a job no
 * other form can do:
 *
 *   - `docs/providers/gcp.md` — the list a reader can audit, annotated call by call. A policy
 *     nobody can read is a policy nobody checks.
 *   - `deploy/gcp/rockysurf-role.yaml` — the file `gcloud iam roles create --file=` consumes,
 *     which is what a self-hoster actually deploys.
 *
 * Two copies of a security boundary is a drift bug waiting to happen: someone widens the
 * deployable file to unblock a run, the doc keeps promising the narrow version, and the
 * published policy quietly stops being the policy anyone has. So they are compared here, and
 * this runs in `pnpm run lint`.
 *
 * This is the GCP counterpart of `check-iam-policy.mjs`, and it is simpler for a reason worth
 * noting: a GCP custom role is a flat list of permission strings, with no resource ARNs, no
 * conditions and no parameters to resolve. The whole security boundary is the list, so
 * comparing the list compares everything.
 *
 * THREE THINGS ARE CHECKED, not one:
 *   1. the two permission lists are identical, as sets;
 *   2. neither has a duplicate, which `gcloud` accepts and a reviewer would not;
 *   3. the count the doc states in prose matches the list, because a stale "needs N
 *      permissions" is exactly the sentence a reader takes on trust.
 *
 * Usage: node scripts/check-gcp-role.mjs [--print]
 * Exits 0 when they agree, 1 on any difference.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const DOC = 'docs/providers/gcp.md'
const ROLE = 'deploy/gcp/rockysurf-role.yaml'

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8')

/**
 * Permissions from a YAML `includedPermissions:` block.
 *
 * Deliberately a line scanner rather than a YAML parse: the doc's copy lives inside a fenced
 * code block in Markdown, the role file is a real YAML document, and one function that reads
 * both means the two can never be compared through different lenses. Comments and blank lines
 * are skipped; anything else inside the block must be a `- permission` item.
 */
function permissionsIn(text, where) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trimEnd() === 'includedPermissions:')
  if (start === -1) throw new Error(`${where}: no 'includedPermissions:' block found`)

  const permissions = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (trimmed === '' || trimmed.startsWith('#')) continue
    // The block ends at the fence closing the doc's code block, or at the next top-level key.
    if (trimmed.startsWith('```')) break
    if (!trimmed.startsWith('-')) break

    const permission = trimmed.slice(1).trim()
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(permission)) {
      throw new Error(`${where}: '${permission}' does not look like a GCP permission`)
    }
    permissions.push(permission)
  }

  if (permissions.length === 0) throw new Error(`${where}: the includedPermissions block is empty`)
  return permissions
}

/** The number the doc states in prose, so a stale sentence cannot survive a permission change. */
function statedCount(doc) {
  const match = /needs \*\*(\d+) permissions\*\*/.exec(doc)
  if (!match) throw new Error(`${DOC}: could not find the "needs **N permissions**" sentence`)
  return Number(match[1])
}

const problems = []

let docPermissions = []
let rolePermissions = []
let stated = 0

try {
  const doc = read(DOC)
  docPermissions = permissionsIn(doc, DOC)
  rolePermissions = permissionsIn(read(ROLE), ROLE)
  stated = statedCount(doc)
} catch (err) {
  console.error(`gcp role lint: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const duplicates = (list, where) => {
  const seen = new Set()
  for (const permission of list) {
    if (seen.has(permission)) problems.push(`${where} lists ${permission} twice`)
    seen.add(permission)
  }
}

duplicates(docPermissions, DOC)
duplicates(rolePermissions, ROLE)

const docSet = new Set(docPermissions)
const roleSet = new Set(rolePermissions)

for (const permission of rolePermissions) {
  if (!docSet.has(permission)) {
    problems.push(`${ROLE} grants ${permission}, which ${DOC} does not publish`)
  }
}
for (const permission of docPermissions) {
  if (!roleSet.has(permission)) {
    problems.push(`${DOC} publishes ${permission}, which ${ROLE} does not grant`)
  }
}

if (stated !== rolePermissions.length) {
  problems.push(`${DOC} says "needs ${stated} permissions" but the role grants ${rolePermissions.length}`)
}

if (process.argv.includes('--print')) {
  console.log(rolePermissions.join('\n'))
}

if (problems.length === 0) {
  console.log('gcp role lint: OK')
  console.log(`  ${DOC} and ${ROLE} publish the same ${rolePermissions.length} permissions.`)
  process.exit(0)
}

console.error(`gcp role lint: ${problems.length} problem(s)\n`)
for (const problem of problems) console.error(`  ${problem}`)
console.error(
  '\nThe published permission list and the deployable role are the same security boundary in two\n' +
    'places. When they disagree, a self-hoster deploys one thing and audits another.',
)
process.exit(1)
