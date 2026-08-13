#!/usr/bin/env node
/**
 * Azure RBAC role drift lint (rockysurf-ihtq.7).
 *
 * The Azure counterpart of `scripts/check-iam-policy.mjs`, and it exists for the same reason.
 * Rocky Surf publishes its minimal Azure permissions twice, because both copies have a job no
 * other form can do:
 *
 *   - `docs/providers/azure.md` — the action list a reader can audit, annotated. A policy nobody
 *     can read is a policy nobody audits.
 *   - `deploy/azure/role.bicep` — the infrastructure-as-code a self-hoster actually deploys.
 *     This is the one that gets granted.
 *
 * Two copies of a security boundary is a drift bug waiting to happen: someone widens the
 * template to unblock a run, the doc keeps promising the narrow version, and the published role
 * quietly stops being the role anyone has deployed. So they are compared here, and this runs in
 * `pnpm run lint`.
 *
 * The comparison is EXACT, order included. Formatting discipline is cheap; "which of these two
 * nearly-identical action lists is authoritative" is not.
 *
 * WHY IT PARSES BICEP WITH A REGEX, which is normally a bad idea. The thing being compared is
 * two arrays of literal strings, and Bicep's own form for one is a bracketed list of quoted
 * strings — a shape narrow enough to read exactly. The parser refuses anything it does not
 * recognise rather than skipping it, so a line it cannot read fails the build instead of
 * silently dropping an action out of the comparison, which is the only failure mode that would
 * matter. Compiling with `az bicep build` was the alternative and would make CI depend on the
 * Azure CLI being installed.
 *
 * Usage: node scripts/check-azure-role.mjs [--print]
 * Exits 0 when the two agree, 1 on any difference.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const DOC = 'docs/providers/azure.md'
const TEMPLATE = 'deploy/azure/role.bicep'

/**
 * The two roles, and the Bicep variable each one's actions live in.
 *
 * `scope` is compared too. It is not decoration: the whole argument for the split is that the
 * operational role is confined to one resource group, and a doc claiming that while the template
 * assigns at subscription scope would be the most consequential drift possible here.
 */
const ROLES = [
  { key: 'Rocky Surf Provider', variable: 'operationalActions', scope: 'resource group' },
  { key: 'Rocky Surf Catalogue Reader', variable: 'catalogueActions', scope: 'subscription' },
]

/** The fenced JSON block under `## The role`. */
function publishedRoles(markdown) {
  const heading = markdown.indexOf('\n## The role')
  if (heading === -1) throw new Error(`${DOC}: no '## The role' heading`)
  const open = markdown.indexOf('```json', heading)
  if (open === -1) throw new Error(`${DOC}: no json code block under '## The role'`)
  const start = markdown.indexOf('\n', open) + 1
  const end = markdown.indexOf('```', start)
  if (end === -1) throw new Error(`${DOC}: unterminated json code block`)
  return JSON.parse(markdown.slice(start, end))
}

/**
 * One `var <name> = [ … ]` from the template, as an array of strings.
 *
 * Everything between the brackets must be a quoted string or a comment. A line that is neither
 * is refused, because an action list this lint silently skipped part of would pass while
 * granting more than the doc promises.
 */
function bicepArray(source, variable) {
  const open = source.indexOf(`var ${variable} = [`)
  if (open === -1) throw new Error(`${TEMPLATE}: no 'var ${variable} = ['`)
  const bodyStart = source.indexOf('[', open) + 1
  // The closing bracket at the start of a line, which is the only form the template uses and the
  // only one that can be found without a real parser.
  const bodyEnd = source.indexOf('\n]', bodyStart)
  if (bodyEnd === -1) throw new Error(`${TEMPLATE}: unterminated array for '${variable}'`)

  const actions = []
  for (const raw of source.slice(bodyStart, bodyEnd).split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('//')) continue
    const quoted = /^'([^']*)'$/.exec(line)
    if (!quoted) {
      throw new Error(
        `${TEMPLATE}: '${variable}' contains a line this lint cannot read: ${line}\n` +
          'Every entry must be a single-quoted string on its own line, so the published list and ' +
          'the deployed one can be compared exactly.',
      )
    }
    actions.push(quoted[1])
  }
  if (actions.length === 0) throw new Error(`${TEMPLATE}: '${variable}' is empty`)
  return actions
}

/** Which scope a role definition is assignable at, read from its `assignableScopes`. */
function bicepScope(source, roleName) {
  // Both roles declare exactly one assignable scope, and which one is the security claim.
  const marker = roleName.includes('Catalogue') ? 'catalogueRole' : 'operationalRole'
  const block = source.slice(source.indexOf(`resource ${marker} `))
  if (!block) throw new Error(`${TEMPLATE}: no 'resource ${marker}'`)
  const scopes = /assignableScopes:\s*\[\s*([^\]]+)\]/.exec(block)
  if (!scopes) throw new Error(`${TEMPLATE}: ${marker} declares no assignableScopes`)
  const entries = scopes[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (entries.length !== 1) {
    throw new Error(`${TEMPLATE}: ${marker} declares ${entries.length} assignable scopes; expected exactly 1`)
  }
  if (entries[0] === 'targetResourceGroup.id') return 'resource group'
  if (entries[0] === 'subscription().id') return 'subscription'
  throw new Error(`${TEMPLATE}: ${marker} has an assignable scope this lint does not recognise: ${entries[0]}`)
}

const doc = publishedRoles(readFileSync(join(repoRoot, DOC), 'utf8'))
const template = readFileSync(join(repoRoot, TEMPLATE), 'utf8')

const differences = []
let totalActions = 0

for (const role of ROLES) {
  const published = doc[role.key]
  if (!published) {
    differences.push(`${DOC} does not publish a role called '${role.key}'`)
    continue
  }

  const deployedActions = bicepArray(template, role.variable)
  const deployedScope = bicepScope(template, role.key)
  totalActions += deployedActions.length

  if (published.scope !== deployedScope) {
    differences.push(
      `${role.key}: scope differs — ${DOC} says '${published.scope}', ${TEMPLATE} assigns at '${deployedScope}'`,
    )
  }
  if (deployedScope !== role.scope) {
    differences.push(`${role.key}: ${TEMPLATE} assigns at '${deployedScope}', but this lint expects '${role.scope}'`)
  }

  const publishedActions = published.actions ?? []
  for (const action of publishedActions) {
    if (!deployedActions.includes(action)) differences.push(`${role.key}: ${DOC} grants ${action}, ${TEMPLATE} does not`)
  }
  for (const action of deployedActions) {
    if (!publishedActions.includes(action)) {
      // The direction that matters: the deployed role is wider than the published one.
      differences.push(`${role.key}: ${TEMPLATE} grants ${action}, ${DOC} does not publish it`)
    }
  }
  if (
    publishedActions.length === deployedActions.length &&
    publishedActions.join('\n') !== deployedActions.join('\n') &&
    differences.length === 0
  ) {
    // Same actions, different order. Harmless to Azure, not harmless to a reader comparing the
    // two by eye, and a reordering is exactly what hides an edit in a diff.
    differences.push(`${role.key}: the same actions are listed in a different order; keep the two files aligned`)
  }
}

if (process.argv.includes('--print')) console.log(JSON.stringify(doc, null, 2))

if (differences.length === 0) {
  console.log(`azure role: ${DOC} and ${TEMPLATE} agree — ${ROLES.length} roles, ${totalActions} actions`)
  process.exit(0)
}

console.error(`azure role DRIFT between ${DOC} and ${TEMPLATE}\n`)
for (const difference of differences) console.error(`  ${difference}`)
console.error('\nThe published role is the one a self-hoster audits; the template is the one they deploy.')
console.error('Two copies of a security boundary must not be allowed to disagree.')
process.exit(1)
