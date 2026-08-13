#!/usr/bin/env node
/**
 * Self-test for the orphan audit's credential seam (rockysurf-ufwn).
 *
 *   node scripts/e2e/audit-credentials-selftest.mjs [--json]
 *
 * WHY THIS EXISTS AT ALL. The property being defended is "the audit reads with STRONGER
 * credentials than the run under test", and its failure mode is a green run: an orphan the
 * restricted role cannot see is an orphan the audit reports as clean. The only place the real
 * arrangement can be exercised end to end is a nightly against real AWS, which costs money and
 * happens once a day — so everything that can be proven without an AWS call is proven here, and
 * the nightly is left to prove only what it uniquely can (the OIDC exchange and the role chain).
 *
 * FOUR GROUPS, each catching a different way this rots:
 *
 *   1. THE DECISION TABLE. Every input the resolver can be handed, including the exact
 *      environment the nightly had when this bug was filed — run profile forced empty, no audit
 *      credentials, strict mode on — which must fail rather than fall through to the run's own.
 *   2. THE CI WIRING. The capture step must sit BETWEEN the two role assumptions. Below the
 *      second one it captures the restricted role instead, and every variable name still looks
 *      right. Ordering is the mechanism, so ordering is asserted.
 *   3. THE LOCAL WIRING. restricted-principal.mjs hands the child an operator profile and turns
 *      strict mode on, so the workstation path is defended by the same rule as CI.
 *   4. THE REFUSALS, FOR REAL. lifecycle.mjs is actually spawned in the two broken configurations
 *      and must exit non-zero having created nothing — no network call, no server, no spend. A
 *      refusal that is only unit-tested is a refusal nobody has watched happen.
 *
 * No dependencies beyond the AWS SDK the provider package already resolves, and no credentials:
 * the key ids below are fixtures, chosen to be obviously fake.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AUDIT_ENV,
  AuditCredentialError,
  assertDistinctPrincipals,
  isStrict,
  resolveAuditCredentials,
  resolveRunCredentials,
} from './aws-audit-credentials.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const WORKFLOW = join(REPO, '.github/workflows/nightly-real-cloud.yml')
const RESTRICTED = join(REPO, 'scripts/e2e/restricted-principal.mjs')
const LIFECYCLE = join(REPO, 'scripts/e2e/lifecycle.mjs')
const JSON_OUT = process.argv.includes('--json')

const results = []
const failures = []
const pass = (what, detail = '') => results.push({ ok: true, what, detail })
const fail = (what, detail = '') => {
  results.push({ ok: false, what, detail })
  failures.push(what)
}
const check = (ok, what, detail = '') => (ok ? pass(what, detail) : fail(what, detail))

/** Assert that a resolver call refuses, and that it refuses for the stated reason. */
const refuses = (what, env, fragment) => {
  try {
    resolveAuditCredentials(env)
    fail(what, 'it returned a configuration instead of refusing')
  } catch (err) {
    if (err instanceof AuditCredentialError && err.message.includes(fragment)) pass(what)
    else fail(what, `refused, but with: ${err.message}`)
  }
}

/* ------------------------------------------------------- 1: the decision table -------------- */

// An unconfigured workstation run: the operator is already the only identity in play.
{
  const got = resolveAuditCredentials({})
  check(got.source === 'inherited' && got.clientConfig.profile === 'sandbox', 'bare run audits with the default profile', got.source)
}

// The CI shape WITHOUT the second hop: the run is the entry role, which may read volumes itself.
{
  const got = resolveAuditCredentials({ [AUDIT_ENV.runProfile]: '' })
  check(
    got.source === 'inherited' && Object.keys(got.clientConfig).length === 0,
    'an empty run profile inherits the default credential chain',
    JSON.stringify(got.clientConfig),
  )
}

{
  const got = resolveAuditCredentials({ [AUDIT_ENV.runProfile]: '', [AUDIT_ENV.profile]: 'operator' })
  check(got.source === 'profile' && got.clientConfig.profile === 'operator', 'a named audit profile is used as given')
}

{
  const got = resolveAuditCredentials({
    [AUDIT_ENV.runProfile]: '',
    [AUDIT_ENV.accessKeyId]: 'AKIAEXAMPLEAUDIT',
    [AUDIT_ENV.secretAccessKey]: 'fixture-secret',
    [AUDIT_ENV.sessionToken]: 'fixture-token',
  })
  check(
    got.source === 'environment' &&
      got.clientConfig.credentials?.accessKeyId === 'AKIAEXAMPLEAUDIT' &&
      got.clientConfig.credentials?.sessionToken === 'fixture-token',
    'an audit session supplied through the environment is used as given',
  )
}

{
  // A long-lived IAM user has no session token; its absence must not look like a half-set.
  const got = resolveAuditCredentials({
    [AUDIT_ENV.accessKeyId]: 'AKIAEXAMPLEAUDIT',
    [AUDIT_ENV.secretAccessKey]: 'fixture-secret',
  })
  check(
    got.source === 'environment' && !('sessionToken' in got.clientConfig.credentials),
    'environment credentials without a session token are accepted',
  )
}

refuses('half an environment credential set is refused, not ignored', { [AUDIT_ENV.accessKeyId]: 'AKIAEXAMPLEAUDIT' }, 'incomplete')
refuses('a stray session token alone is refused', { [AUDIT_ENV.sessionToken]: 'fixture-token' }, 'incomplete')
refuses(
  'a profile AND an environment session together are refused rather than ranked',
  { [AUDIT_ENV.profile]: 'operator', [AUDIT_ENV.accessKeyId]: 'AKIAEXAMPLEAUDIT', [AUDIT_ENV.secretAccessKey]: 's' },
  'configured twice',
)

// THE BUG, AS FILED (rockysurf-ufwn): the nightly forced the run profile empty and never set an
// audit one, so the audit fell through to the default chain — which after the role-chaining hop
// holds the published policy, and ec2:DescribeVolumes is deliberately not in it.
refuses(
  'the exact environment that filed this bug is refused under strict mode',
  { [AUDIT_ENV.runProfile]: '', [AUDIT_ENV.required]: '1' },
  'no operator credentials',
)
refuses(
  'an audit profile set to the empty string does not silently fall back',
  { [AUDIT_ENV.runProfile]: '', [AUDIT_ENV.profile]: '', [AUDIT_ENV.required]: '1' },
  'no operator credentials',
)

{
  const got = resolveAuditCredentials({ [AUDIT_ENV.runProfile]: '', [AUDIT_ENV.profile]: 'operator', [AUDIT_ENV.required]: '1' })
  check(got.source === 'profile' && got.strict === true, 'a configured split satisfies strict mode')
}

// Without strict mode nothing changes for anyone: the plain workstation run keeps its old
// behaviour, which is what makes this safe to turn on only where it is true.
{
  const got = resolveAuditCredentials({ [AUDIT_ENV.runProfile]: '' })
  check(got.strict === false && got.source === 'inherited', 'a non-strict run is unchanged by this seam')
}

check(
  ['', '0', 'false', 'no'].every((v) => !isStrict({ [AUDIT_ENV.required]: v })) &&
    ['1', 'true', 'yes'].every((v) => isStrict({ [AUDIT_ENV.required]: v })),
  'strict mode reads the obvious truthy and falsy spellings',
)

{
  try {
    assertDistinctPrincipals('AKIAEXAMPLEONE', 'AKIAEXAMPLEONE')
    fail('identical principals are refused')
  } catch (err) {
    check(err instanceof AuditCredentialError && !/AKIA/.test([err.message, ...err.remediation].join()), 'identical principals are refused, without naming a key')
  }
  try {
    assertDistinctPrincipals('AKIAEXAMPLEONE', 'AKIAEXAMPLETWO')
    pass('distinct principals are accepted')
  } catch (err) {
    fail('distinct principals are accepted', err.message)
  }
}

/* --- the assumption underneath the distinctness check: the SDK honours BOTH client configs --- */
// Offline, with fixtures. If this ever stopped holding, the check above would compare two copies
// of the same environment credential and pass every time.
{
  const require = createRequire(join(REPO, 'packages/provider-aws/package.json'))
  const { EC2Client } = await import(pathToFileURL(require.resolve('@aws-sdk/client-ec2')).href)
  const keyOf = async (clientConfig) => {
    const client = new EC2Client({ region: 'us-east-1', ...clientConfig })
    try {
      return (await client.config.credentials()).accessKeyId
    } finally {
      client.destroy()
    }
  }
  const env = {
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLERUN',
    AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    [AUDIT_ENV.runProfile]: '',
    [AUDIT_ENV.accessKeyId]: 'AKIAEXAMPLEAUDIT',
    [AUDIT_ENV.secretAccessKey]: 'fixture-secret',
    [AUDIT_ENV.required]: '1',
  }
  const saved = { ...process.env }
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY })
  delete process.env.AWS_PROFILE
  try {
    const auditKey = await keyOf(resolveAuditCredentials(env).clientConfig)
    const runKey = await keyOf(resolveRunCredentials(env).clientConfig)
    check(auditKey === 'AKIAEXAMPLEAUDIT' && runKey === 'AKIAEXAMPLERUN', 'the SDK resolves the two configs to the two different sessions', `${auditKey !== runKey}`)
  } finally {
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/* ------------------------------------------------------- 2: the CI wiring ------------------- */

/**
 * The steps of the workflow's `aws:` job, in order, as raw text blocks.
 *
 * A hand-rolled split rather than a YAML parser, because the repository root takes no runtime
 * dependencies and this check has to run in the lint job before anything is built. It is scoped to
 * one file this project owns: the job's steps are the list items at six spaces of indentation.
 */
function awsJobSteps() {
  const text = readFileSync(WORKFLOW, 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === '  aws:')
  if (start === -1) throw new Error(`no aws: job in ${WORKFLOW}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i
      break
    }
  }
  const body = lines.slice(start, end)
  const stepsAt = body.findIndex((l) => l === '    steps:')
  if (stepsAt === -1) throw new Error('the aws: job has no steps:')
  const steps = []
  for (const line of body.slice(stepsAt + 1)) {
    if (/^ {6}- /.test(line)) steps.push(line)
    else if (steps.length > 0) steps[steps.length - 1] += `\n${line}`
  }
  return steps
}

try {
  const steps = awsJobSteps()
  const indexOf = (fragment) => steps.findIndex((s) => s.includes(fragment))

  const entry = indexOf('role-to-assume: ${{ secrets.AWS_NIGHTLY_ROLE_ARN }}')
  const chained = indexOf('role-chaining: true')
  const capture = indexOf(`${AUDIT_ENV.accessKeyId}=`)
  const lifecycle = indexOf('node scripts/e2e/lifecycle.mjs aws')

  check(entry !== -1 && chained !== -1 && lifecycle !== -1, 'the aws job still assumes both roles and runs the lifecycle', `${entry}/${chained}/${lifecycle}`)
  check(capture !== -1, 'the entry role\'s session is captured for the audit', `step ${capture}`)
  // THE ASSERTION THIS FILE EXISTS FOR. Below the chaining hop, the capture step would hand the
  // audit the very credentials under test, and every name in the file would still read correctly.
  check(
    capture > entry && capture < chained,
    'the capture step sits BETWEEN the two role assumptions',
    `entry=${entry} capture=${capture} chained=${chained}`,
  )
  check(lifecycle > chained, 'the lifecycle runs after the chaining hop', `${lifecycle} > ${chained}`)

  const captureStep = steps[capture] ?? ''
  check(
    [AUDIT_ENV.accessKeyId, AUDIT_ENV.secretAccessKey, AUDIT_ENV.sessionToken].every((name) => captureStep.includes(`${name}=`)),
    'the capture step exports the whole credential set the resolver reads',
  )
  check(
    !/echo "\$\{?AWS_(SECRET|SESSION)/.test(captureStep) && captureStep.includes('$GITHUB_ENV'),
    'the captured values go to $GITHUB_ENV rather than to the log',
  )

  const lifecycleStep = steps[lifecycle] ?? ''
  check(lifecycleStep.includes(`${AUDIT_ENV.runProfile}: ''`), 'the lifecycle step still forces the default chain for the run itself')
  check(lifecycleStep.includes(`${AUDIT_ENV.required}:`), 'the lifecycle step demands the split (strict mode)')
  check(
    /ROCKYSURF_E2E_AWS_AUDIT_REQUIRED: \$\{\{ vars\.AWS_PROVIDER_ROLE_ARN != '' &&/.test(lifecycleStep),
    'strict mode is demanded only when the chaining hop actually happens',
  )
  check(
    !steps.some((s) => s.includes(`${AUDIT_ENV.profile}:`)),
    'no stale audit-profile wiring is left in the workflow',
  )
} catch (err) {
  fail('the aws job could be read from the workflow', err.message)
}

/* ------------------------------------------------------- 3: the local wiring ---------------- */

{
  const source = readFileSync(RESTRICTED, 'utf8')
  check(new RegExp(`${AUDIT_ENV.profile}: PROFILE`).test(source), 'restricted-principal.mjs points the audit at the operator profile')
  check(new RegExp(`${AUDIT_ENV.required}: '1'`).test(source), 'restricted-principal.mjs demands the split too')
}

/* ------------------------------------------------------- 4: the refusals, for real ---------- */

/**
 * Spawn the lifecycle and assert it refuses BEFORE it does anything.
 *
 * `t3.small` is a real offering so argument validation passes; nothing reaches AWS because the
 * preflight is the first thing main() does. The absence of the run banner is the proof of that —
 * it is printed by the step after the preflight, and the step before it makes a network call.
 *
 * The credentials passed in are fixtures, so even a build in which the preflight has been deleted
 * cannot create anything: the run would get as far as an authentication failure and no further.
 * The timeout is what bounds that case; a refusal takes well under a second.
 */
function refusesToStart(what, env, fragment) {
  const out = spawnSync(process.execPath, [LIFECYCLE, 'aws', 't3.small'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
  })
  const transcript = `${out.stdout ?? ''}${out.stderr ?? ''}`
  if (out.status === 0) return fail(what, 'the lifecycle started anyway')
  if (!transcript.includes(fragment)) return fail(what, `refused, but without saying why: ${transcript.trim().split('\n').slice(-3).join(' | ')}`)
  if (/milestone exit run/.test(transcript)) return fail(what, 'it refused only after beginning the run')
  pass(what, `exit ${out.status}`)
}

refusesToStart(
  'a strict run with no audit credentials refuses to start',
  { [AUDIT_ENV.runProfile]: '', [AUDIT_ENV.required]: '1' },
  'ORPHAN AUDIT CREDENTIALS ARE MISCONFIGURED',
)

refusesToStart(
  'a strict run whose audit resolves to the identity under test refuses to start',
  {
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLESAME',
    AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    [AUDIT_ENV.runProfile]: '',
    [AUDIT_ENV.required]: '1',
    [AUDIT_ENV.accessKeyId]: 'AKIAEXAMPLESAME',
    [AUDIT_ENV.secretAccessKey]: 'fixture-secret',
  },
  'the orphan audit would run as the identity under test',
)

/* ------------------------------------------------------------------------------ report ------ */

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, results }, null, 2))
} else {
  for (const { ok, what, detail } of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  console.log()
  console.log(
    failures.length === 0
      ? `audit-credential self-test: all ${results.length} checks passed`
      : `audit-credential self-test: ${failures.length} of ${results.length} check(s) failed`,
  )
}
process.exit(failures.length === 0 ? 0 : 1)
