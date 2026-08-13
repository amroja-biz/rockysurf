#!/usr/bin/env node
/**
 * IAM policy drift lint (rockysurf-gyp1.5).
 *
 * Rocky Surf publishes its minimal AWS policy twice, because both copies have a job no other
 * form can do:
 *
 *   - `docs/providers/aws.md` — the JSON a reader can paste, annotated statement by statement.
 *     A policy nobody can read is a policy nobody audits.
 *   - `deploy/aws/iam-role.yaml` — the CloudFormation a self-hoster actually deploys, and the
 *     role the restricted-principal verification run assumes. This is the one that gets proven.
 *
 * Two copies of a security boundary is a drift bug waiting to happen: someone widens the
 * template to unblock a run, the doc keeps promising the narrow version, and the published
 * policy quietly stops being the policy anyone has ever tested. So they are compared here, and
 * this runs in `pnpm run lint`.
 *
 * The comparison is exact — statement order, action order, resource order and all. Formatting
 * discipline is cheap; "which of these two nearly-identical policies is authoritative" is not.
 *
 * The template's parameters stand in for the doc's placeholders:
 *
 *   ${ProviderRegion}  -> REGION          (the doc's placeholder, not the parameter's default:
 *                                          a reader substitutes their region by hand)
 *   ${AWS::AccountId}  -> ACCOUNT_ID      (likewise)
 *   any other Ref/Sub  -> that parameter's Default, which is what the doc's prose describes
 *
 * Usage: node scripts/check-iam-policy.mjs [--print]
 * Exits 0 when the two agree, 1 on any difference.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const DOC = 'docs/providers/aws.md'
const TEMPLATE = 'deploy/aws/iam-role.yaml'

/**
 * The doc's hand-substituted placeholders. Everything not named here renders to its parameter
 * Default, so adding a parameter to the template without touching this map is safe by default —
 * it only breaks the build if the doc disagrees with the default, which is exactly the case a
 * reader would otherwise hit.
 */
const PLACEHOLDERS = {
  ProviderRegion: 'REGION',
  'AWS::AccountId': 'ACCOUNT_ID',
}

/** yaml is not a root dependency; ask node for core's copy rather than guessing a store path. */
async function loadYaml() {
  const require = createRequire(join(repoRoot, 'packages/core/package.json'))
  return import(pathToFileURL(require.resolve('yaml')).href)
}

/**
 * CloudFormation short tags, as the intrinsic objects they are sugar for. Only the scalar forms
 * this template uses are defined: an unknown tag should fail loudly rather than parse to
 * something plausible and wrong.
 */
function cfnTags() {
  return [
    { tag: '!Ref', resolve: (value) => ({ Ref: value }) },
    { tag: '!Sub', resolve: (value) => ({ 'Fn::Sub': value }) },
    { tag: '!GetAtt', resolve: (value) => ({ 'Fn::GetAtt': value }) },
  ]
}

/** The fenced JSON block under `## The IAM policy`. */
function policyFromDoc(markdown) {
  const heading = markdown.indexOf('\n## The IAM policy')
  if (heading === -1) throw new Error(`${DOC}: no '## The IAM policy' heading`)
  const open = markdown.indexOf('```json', heading)
  if (open === -1) throw new Error(`${DOC}: no json code block under '## The IAM policy'`)
  const start = markdown.indexOf('\n', open) + 1
  const end = markdown.indexOf('```', start)
  if (end === -1) throw new Error(`${DOC}: unterminated json code block`)
  return JSON.parse(markdown.slice(start, end))
}

/** Resolve `Ref` / `Fn::Sub` against PLACEHOLDERS first, then parameter defaults. */
function resolveName(name, parameters) {
  if (name in PLACEHOLDERS) return PLACEHOLDERS[name]
  if (name.startsWith('AWS::')) {
    throw new Error(`${TEMPLATE}: pseudo-parameter \${${name}} in the policy has no doc placeholder`)
  }
  const parameter = parameters[name]
  if (!parameter) throw new Error(`${TEMPLATE}: policy references undeclared parameter '${name}'`)
  if (parameter.Default === undefined) {
    throw new Error(`${TEMPLATE}: parameter '${name}' has no Default, so the doc cannot show a value for it`)
  }
  return String(parameter.Default)
}

function render(node, parameters) {
  if (Array.isArray(node)) return node.map((item) => render(item, parameters))
  if (node && typeof node === 'object') {
    const keys = Object.keys(node)
    if (keys.length === 1 && keys[0] === 'Ref') return resolveName(node.Ref, parameters)
    if (keys.length === 1 && keys[0] === 'Fn::Sub') {
      return node['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (_, name) => resolveName(name, parameters))
    }
    if (keys.some((key) => key === 'Ref' || key.startsWith('Fn::'))) {
      throw new Error(`${TEMPLATE}: unsupported intrinsic in the policy: ${JSON.stringify(node)}`)
    }
    return Object.fromEntries(keys.map((key) => [key, render(node[key], parameters)]))
  }
  return node
}

function policyFromTemplate(yaml, source) {
  const template = yaml.parse(source, { customTags: cfnTags() })
  const role = template?.Resources?.ProviderRole
  if (!role) throw new Error(`${TEMPLATE}: no Resources.ProviderRole`)
  if (role.Type !== 'AWS::IAM::Role') throw new Error(`${TEMPLATE}: ProviderRole is ${role.Type}, expected AWS::IAM::Role`)

  const policies = role.Properties?.Policies ?? []
  const managed = role.Properties?.ManagedPolicyArns ?? []
  // A managed policy attached alongside the inline one would be invisible to a diff of the
  // inline document, which is the one way this lint could pass while the role is wider than the
  // doc. Refuse the shape rather than compare a half of it.
  if (managed.length > 0) throw new Error(`${TEMPLATE}: ProviderRole carries ManagedPolicyArns; the doc publishes one inline policy`)
  if (policies.length !== 1) throw new Error(`${TEMPLATE}: expected exactly 1 inline policy, found ${policies.length}`)

  return render(policies[0].PolicyDocument, template.Parameters ?? {})
}

/** Stable stringify: object keys sorted, array order significant. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Every path where the two differ, so the failure names the statement rather than the file. */
function differences(a, b, path = '$') {
  if (canonical(a) === canonical(b)) return []
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)
  if (!bothObjects) return [{ path, doc: a, template: b }]

  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  const label = (key) => (Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`)
  return keys.flatMap((key) => {
    if (!(key in a)) return [{ path: label(key), doc: undefined, template: b[key] }]
    if (!(key in b)) return [{ path: label(key), doc: a[key], template: undefined }]
    return differences(a[key], b[key], label(key))
  })
}

/** Name statements by Sid where we can, so a diff path reads as a policy location. */
function bySid(policy) {
  const statements = policy?.Statement
  if (!Array.isArray(statements)) return policy
  return { ...policy, Statement: Object.fromEntries(statements.map((s, i) => [s.Sid ?? `#${i}`, s])) }
}

const yaml = await loadYaml()
const doc = policyFromDoc(readFileSync(join(repoRoot, DOC), 'utf8'))
const template = policyFromTemplate(yaml, readFileSync(join(repoRoot, TEMPLATE), 'utf8'))

if (process.argv.includes('--print')) console.log(JSON.stringify(template, null, 2))

const orderMatches = canonical(doc) === canonical(template)
const diffs = differences(bySid(doc), bySid(template))

if (orderMatches) {
  const count = doc.Statement?.length ?? 0
  const actions = new Set(doc.Statement?.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])))
  console.log(`iam policy: ${DOC} and ${TEMPLATE} agree — ${count} statements, ${actions.size} distinct actions`)
  process.exit(0)
}

console.error(`iam policy DRIFT between ${DOC} and ${TEMPLATE}`)
if (diffs.length === 0) {
  // Same statements, different order. Harmless to AWS, not harmless to a reader comparing the
  // two by eye, and a reordering is exactly what hides an edit in a diff.
  console.error('  statements match but their order differs; keep the two files literally aligned')
} else {
  for (const { path, doc: inDoc, template: inTemplate } of diffs) {
    console.error(`  ${path}`)
    console.error(`    ${DOC}: ${inDoc === undefined ? '(absent)' : JSON.stringify(inDoc)}`)
    console.error(`    ${TEMPLATE}: ${inTemplate === undefined ? '(absent)' : JSON.stringify(inTemplate)}`)
  }
}
process.exit(1)
