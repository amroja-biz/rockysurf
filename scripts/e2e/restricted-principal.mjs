#!/usr/bin/env node
/**
 * The published IAM policy, proven under a principal that carries exactly it (rockysurf-gyp1.5).
 *
 *   node scripts/e2e/restricted-principal.mjs --profile sandbox
 *
 * WHAT THIS ADDS TO `lifecycle.mjs`. The gyp1.4 exit runs proved the provider's CALL LIST: every
 * action named in docs/providers/aws.md is one the provider really makes, on both architectures.
 * They could not prove the SCOPING, because they ran as an administrator — a Resource ARN with a
 * typo in it or a Condition that never matches is invisible to a principal that is allowed to do
 * everything anyway. This script deploys the SHIPPED CloudFormation role (deploy/aws/iam-role.yaml),
 * assumes it, and runs the same lifecycle under those credentials and nothing else. An
 * `UnauthorizedOperation` here is a bug in the published policy, not in the run.
 *
 * THIS SPENDS MONEY. One small instance per architecture, minutes each, terminated by
 * lifecycle.mjs's own `finally`. The sweep at the end reports anything that outlived it.
 *
 * `--profile` IS MANDATORY AND HAS NO DEFAULT. Every `aws` invocation below names it explicitly.
 * A client built without one uses this machine's default identity, which during gyp1.4 turned
 * out to be a read-only user in an entirely different account — the volume audit cheerfully
 * reported "no orphans" about somebody else's account. A wrong answer delivered confidently is
 * worse than an error, so the profile is a required argument rather than a fallback.
 *
 * NOTHING HERE PRINTS CREDENTIALS. The assumed session's keys are read from `sts assume-role`
 * into the child's environment and never logged, never written to the recording, never echoed
 * into an error message.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const TEMPLATE = join(REPO, 'deploy/aws/iam-role.yaml')
const LIFECYCLE = join(REPO, 'scripts/e2e/lifecycle.mjs')
const BIN = join(REPO, 'packages/rockysurf/dist/bin.js')
const RECORDINGS = join(REPO, 'scripts/e2e/recordings')

/* ------------------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)

const PROFILE = flag('profile')
const REGION = flag('region', 'us-east-1')
const STACK = flag('stack', 'rocky-surf-iam-role')
const OFFERINGS = flag('offerings', 't4g.small,t3.small').split(',').filter(Boolean)
const TRUST_OVERRIDE = flag('trust')
const KEEP_STACK = has('keep-stack')

if (!PROFILE || PROFILE.startsWith('--')) {
  console.error('usage: node scripts/e2e/restricted-principal.mjs --profile <aws-profile> [options]')
  console.error('')
  console.error('  --profile <name>     REQUIRED. The operator profile that owns the account. No default.')
  console.error(`  --region <name>      default ${REGION}`)
  console.error(`  --stack <name>       default ${STACK}; must begin with rocky-surf-`)
  console.error(`  --offerings a,b      default ${OFFERINGS.join(',')}`)
  console.error('  --trust <arn>        principal allowed to assume the role; default: the caller')
  console.error('  --keep-stack         leave the role deployed instead of deleting it')
  process.exit(2)
}

// The project's blast-radius rule, enforced rather than remembered: this script only ever
// creates or deletes a stack whose name says whose it is.
if (!STACK.startsWith('rocky-surf-')) {
  console.error(`refusing to touch stack '${STACK}': this script only manages rocky-surf-* stacks`)
  process.exit(2)
}

const t0 = Date.now()
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...args)

const results = []
const record = (ok, what, detail = '') => {
  results.push({ ok, what, detail })
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------------------- aws cli */

/**
 * Run the AWS CLI with the profile and region always attached.
 *
 * `quiet` keeps a command's stdout out of the log entirely. It is set for `assume-role`, whose
 * output is a live secret; the flag exists so that "do not print this" is a property of the call
 * rather than a discipline the caller has to remember at every use site.
 */
function aws(args, { quiet = false, allow = [] } = {}) {
  const out = spawnSync('aws', [...args, '--profile', PROFILE, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (out.error) throw new Error(`aws ${args[0]} ${args[1]}: ${out.error.message}`)
  const stderr = (out.stderr ?? '').trim()
  if (out.status !== 0) {
    if (allow.some((fragment) => stderr.includes(fragment))) return { tolerated: stderr }
    throw new Error(`aws ${args.slice(0, 2).join(' ')} failed (${out.status}):\n${stderr}`)
  }
  const stdout = (out.stdout ?? '').trim()
  if (!quiet && stdout && process.env.ROCKYSURF_E2E_VERBOSE) log(`    ${stdout.split('\n')[0]}`)
  if (!stdout) return {}
  try {
    return JSON.parse(stdout)
  } catch {
    // `cloudformation deploy` narrates in prose no matter what --output says.
    return { raw: stdout }
  }
}

/* ------------------------------------------------------------- who is allowed to assume it */

/**
 * The caller, as a principal a trust policy will accept.
 *
 * An SSO session's caller ARN is `arn:aws:sts::<acct>:assumed-role/<role>/<session>`, which is a
 * session, not a principal — putting it in a trust policy is rejected. The role behind it is the
 * principal, and only `iam:GetRole` knows its real ARN, because IAM Identity Center roles live
 * under a `/aws-reserved/sso.amazonaws.com/...` path that the session ARN does not show.
 */
function trustPrincipal(identity) {
  if (TRUST_OVERRIDE) return TRUST_OVERRIDE
  const assumed = /^arn:aws[a-z-]*:sts::\d{12}:assumed-role\/([^/]+)\//.exec(identity.Arn)
  if (!assumed) return identity.Arn
  const role = aws(['iam', 'get-role', '--role-name', assumed[1]])
  return role.Role.Arn
}

/* ------------------------------------------------------------------- authorization probes */

/**
 * The AWS CLI, as the ASSUMED ROLE rather than as the operator.
 *
 * This is the one place that does not pass `--profile`, and the omission is the point: the
 * credentials are the restricted session, supplied through the environment. `AWS_PROFILE` is
 * deleted rather than merely left unset, because the SDK's credential chain skips environment
 * credentials whenever a profile is named — an inherited one would quietly run these probes as
 * the administrator and pass every single time.
 */
function awsAssumed(credentials, args) {
  const env = { ...process.env }
  delete env.AWS_PROFILE
  delete env.AWS_DEFAULT_PROFILE
  Object.assign(env, {
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_REGION: REGION,
  })
  const out = spawnSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8', env })
  return { status: out.status ?? 1, stderr: (out.stderr ?? '').trim(), stdout: (out.stdout ?? '').trim() }
}

/**
 * Ask EC2 whether the session MAY do something, without doing it.
 *
 * `--dry-run` runs the full authorization evaluation — resource ARNs, conditions and all — then
 * stops before any side effect, answering `DryRunOperation` for allowed and
 * `UnauthorizedOperation` for refused. That is what makes it possible to prove statements this
 * account cannot reach by running the lifecycle: the shared SSH group already exists here with
 * today's CIDR authorized, so a normal run never calls CreateSecurityGroup or
 * AuthorizeSecurityGroupIngress at all, and a self-hoster's first launch calls both.
 *
 * `expect: 'deny'` probes matter at least as much. A condition that never matches anything and a
 * condition that is simply absent look identical from a passing run; only a call that is supposed
 * to fail tells you the scoping is load-bearing rather than decorative.
 */
function probe(credentials, { label, expect = 'allow', args }) {
  const out = awsAssumed(credentials, [...args, '--dry-run'])
  const allowed = /DryRunOperation/.test(out.stderr) || out.status === 0
  const refused = /UnauthorizedOperation|AccessDenied|not authorized/.test(out.stderr)
  const verdict = allowed ? 'allowed' : refused ? 'refused' : 'inconclusive'
  const detail = verdict === 'inconclusive' ? out.stderr.split('\n')[0] : verdict
  record(verdict === (expect === 'allow' ? 'allowed' : 'refused'), `${label} (expected ${expect})`, detail)
  return verdict
}

/* ---------------------------------------------------------------------------- the run */

/**
 * Drive lifecycle.mjs under the assumed session.
 *
 * The child gets the session as environment credentials and `ROCKYSURF_E2E_AWS_PROFILE=''`, which
 * is how lifecycle.mjs is told to use the default chain. `AWS_PROFILE` is deleted from the child's
 * environment on purpose: the SDK's node credential chain SKIPS environment credentials whenever a
 * profile is named, so leaving an inherited `AWS_PROFILE` in place would silently run the whole
 * thing as the administrator again and prove nothing at all.
 *
 * The volume half of the orphan audit keeps the operator profile (`ROCKYSURF_E2E_AWS_AUDIT_PROFILE`).
 * `ec2:DescribeVolumes` is not a call the provider makes, so it is deliberately absent from the
 * published policy; auditing with the credentials under test would also mean an orphan the role
 * cannot see is an orphan the audit reports as clean. `ROCKYSURF_E2E_AWS_AUDIT_REQUIRED` makes that
 * a demand rather than a hope: the child refuses to start — before it creates anything — if the
 * audit would end up reading as the restricted session (rockysurf-ufwn).
 */
function runLifecycle(offering, credentials) {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.AWS_PROFILE
    delete env.AWS_DEFAULT_PROFILE
    Object.assign(env, {
      AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: credentials.SessionToken,
      AWS_REGION: REGION,
      ROCKYSURF_E2E_AWS_PROFILE: '',
      ROCKYSURF_E2E_AWS_AUDIT_PROFILE: PROFILE,
      ROCKYSURF_E2E_AWS_AUDIT_REQUIRED: '1',
    })

    const child = spawn(process.execPath, [LIFECYCLE, 'aws', offering], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let transcript = ''
    const capture = (chunk) => {
      const text = chunk.toString('utf8')
      transcript += text
      process.stdout.write(text)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.on('close', (code) => resolve({ code, transcript }))
  })
}

/** Every action AWS refused, named. This is the doc-bug detector. */
function deniedActions(transcript) {
  const denied = new Set()
  for (const match of transcript.matchAll(/not authorized to perform:?\s*([\w-]+:[\w*]+)/g)) denied.add(match[1])
  for (const match of transcript.matchAll(/UnauthorizedOperation[^\n]*?\b(ec2|ssm):([\w*]+)/g)) denied.add(`${match[1]}:${match[2]}`)
  // The bare code, for the case where EC2 refuses without naming the action — which is the usual
  // shape of an `UnauthorizedOperation` and the reason this run has to read its own transcript.
  if (denied.size === 0 && /UnauthorizedOperation|AccessDenied/.test(transcript)) denied.add('(refused; action not named in the error)')
  return [...denied]
}

/* ------------------------------------------------------------------------------ the sweep */

/** What is still alive in the account under this project's tag, read as the operator. */
function sweep(managedBy = 'rockysurf') {
  const instances = aws([
    'ec2', 'describe-instances',
    '--filters', `Name=tag:managed-by,Values=${managedBy}`, 'Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down',
    '--query', 'Reservations[].Instances[].[InstanceId,State.Name]',
  ])
  const volumes = aws([
    'ec2', 'describe-volumes',
    '--filters', `Name=tag:managed-by,Values=${managedBy}`,
    '--query', 'Volumes[].[VolumeId,State]',
  ])
  const groups = aws([
    'ec2', 'describe-security-groups',
    '--filters', `Name=tag:managed-by,Values=${managedBy}`,
    '--query', 'SecurityGroups[].[GroupId,GroupName]',
  ])
  return {
    instances: (instances ?? []).map((row) => row.join('=')),
    volumes: (volumes ?? []).map((row) => row.join('=')),
    groups: (groups ?? []).map((row) => row.join('=')),
  }
}

/* ---------------------------------------------------------------------------------- main */

async function main() {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing — run \`pnpm -r build\` first; this run drives the built binary`)
  }
  mkdirSync(RECORDINGS, { recursive: true })

  log(`=== restricted-principal verification of docs/providers/aws.md — ${OFFERINGS.join(', ')} ===`)

  const identity = aws(['sts', 'get-caller-identity'])
  log(`operator ${identity.Arn} (account ${identity.Account}, region ${REGION}, profile ${PROFILE})`)

  const trust = trustPrincipal(identity)
  log(`trust principal ${trust}`)

  /* ---- deploy the SHIPPED template ---- */
  // A stack that failed on CREATE sits in ROLLBACK_COMPLETE, which holds the NAME without
  // holding any resources, and `deploy` cannot update out of it — every retry fails with the
  // same unhelpful message until somebody deletes it by hand. Clearing a resourceless carcass of
  // this run's own stack is bookkeeping, not deletion; anything else is left strictly alone.
  const existing = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK], { allow: ['does not exist'] })
  const priorStatus = existing.Stacks?.[0]?.StackStatus
  if (priorStatus === 'ROLLBACK_COMPLETE' || priorStatus === 'REVIEW_IN_PROGRESS') {
    log(`clearing ${STACK} (${priorStatus}, holds no resources)`)
    aws(['cloudformation', 'delete-stack', '--stack-name', STACK])
    spawnSync('aws', ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', STACK, '--profile', PROFILE, '--region', REGION])
  } else if (priorStatus) {
    log(`stack ${STACK} exists (${priorStatus}); deploy will update it in place`)
  }

  log(`deploying stack ${STACK} from ${TEMPLATE}`)
  aws([
    'cloudformation', 'deploy',
    '--template-file', TEMPLATE,
    '--stack-name', STACK,
    '--capabilities', 'CAPABILITY_NAMED_IAM',
    '--no-fail-on-empty-changeset',
    '--parameter-overrides', `TrustedPrincipalArn=${trust}`, `ProviderRegion=${REGION}`,
  ])
  const described = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK])
  const outputs = Object.fromEntries((described.Stacks[0].Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]))
  record(!!outputs.RoleArn, 'shipped CloudFormation role deployed', outputs.RoleArn)

  /* ---- prove the role carries exactly the published policy, as deployed ---- */
  const policyNames = aws(['iam', 'list-role-policies', '--role-name', outputs.RoleName])
  record(policyNames.PolicyNames.length === 1, 'role carries exactly one inline policy', policyNames.PolicyNames.join(', '))
  const attached = aws(['iam', 'list-attached-role-policies', '--role-name', outputs.RoleName])
  record(attached.AttachedPolicies.length === 0, 'role carries no managed policies', String(attached.AttachedPolicies.length))

  /** A role is not immediately assumable after CreateRole; IAM is eventually consistent. */
  const assume = async (session) => {
    const deadline = Date.now() + 90_000
    for (;;) {
      try {
        const assumed = aws(
          ['sts', 'assume-role', '--role-arn', outputs.RoleArn, '--role-session-name', `rockysurf-gyp15-${session}`],
          { quiet: true },
        )
        return assumed.Credentials
      } catch (err) {
        if (Date.now() >= deadline) throw err
        await new Promise((r) => setTimeout(r, 5_000))
      }
    }
  }

  const failures = []
  try {
    /* ---- probes: the statements a run in THIS account cannot reach, plus the negatives ---- */
    const probeSession = await assume('probes')
    record(!!probeSession?.AccessKeyId, `assumed ${outputs.RoleName}`, 'session acquired (not printed)')

    const vpc = aws(['ec2', 'describe-vpcs', '--filters', 'Name=isDefault,Values=true', '--query', 'Vpcs[0].VpcId'])
    const sharedGroup = aws([
      'ec2', 'describe-security-groups',
      '--filters', 'Name=tag:managed-by,Values=rockysurf',
      '--query', 'SecurityGroups[0].GroupId',
    ])

    log('authorization probes (EC2 dry-run, under the restricted session)')
    // FIRST, AND THE ONE THAT GUARDS ALL THE OTHERS: a call the policy does NOT grant. If this
    // comes back allowed, the session is not the restricted role and every result below is
    // meaningless.
    probe(probeSession, {
      label: 'ec2:DescribeVolumes — not granted, the provider never calls it',
      expect: 'deny',
      args: ['ec2', 'describe-volumes'],
    })
    // Re-tagging an existing resource. The doc claims the ec2:CreateAction condition confines
    // TagOnCreate to tagging at creation; this is that claim, tested.
    if (typeof sharedGroup === 'string') {
      probe(probeSession, {
        label: 'ec2:CreateTags on an existing resource — TagOnCreate must not permit re-tagging',
        expect: 'deny',
        args: ['ec2', 'create-tags', '--resources', sharedGroup, '--tags', 'Key=gyp15-probe,Value=must-be-refused'],
      })
      probe(probeSession, {
        label: 'ec2:AuthorizeSecurityGroupIngress on the shared group',
        args: ['ec2', 'authorize-security-group-ingress', '--group-id', sharedGroup, '--protocol', 'tcp', '--port', '22', '--cidr', '192.0.2.1/32'],
      })
    }
    if (typeof vpc === 'string') {
      probe(probeSession, {
        label: 'ec2:CreateSecurityGroup — the cold-start path a self-hoster hits first',
        args: ['ec2', 'create-security-group', '--group-name', 'rocky-surf-gyp15-probe', '--description', 'gyp1.5 authorization probe', '--vpc-id', vpc],
      })
    }

    for (const offering of OFFERINGS) {
      /* ---- a fresh session per architecture: the second run must not inherit an expiring one ---- */
      const credentials = await assume(offering.replace(/\./g, '-'))
      record(!!credentials?.AccessKeyId, `assumed ${outputs.RoleName} for ${offering}`, 'session acquired (not printed)')

      log(`--- lifecycle under the restricted principal: ${offering} ---`)
      const { code, transcript } = await runLifecycle(offering, credentials)
      const recording = join(RECORDINGS, `aws-restricted-${offering.replace(/\./g, '-')}.log`)
      writeFileSync(recording, transcript)

      const denied = deniedActions(transcript)
      record(denied.length === 0, `${offering}: no action was refused by the policy`, denied.join(', '))
      record(code === 0, `${offering}: full lifecycle under the restricted principal`, `exit ${code}, recording ${recording}`)
      if (code !== 0 || denied.length > 0) failures.push({ offering, denied })
    }
  } finally {
    /* ---- the sweep runs whatever happened; an abandoned instance bills either way ---- */
    log('orphan sweep (operator credentials)')
    const left = sweep()
    record(left.instances.length === 0, 'no instances left alive in the account', left.instances.join(', '))
    record(left.volumes.length === 0, 'no volumes left behind', left.volumes.join(', '))
    log(`  shared security groups (survive by design): ${left.groups.join(', ') || 'none'}`)

    if (KEEP_STACK) {
      log(`stack ${STACK} kept (--keep-stack); it costs nothing and can be deleted with:`)
      log(`  aws cloudformation delete-stack --stack-name ${STACK} --profile ${PROFILE} --region ${REGION}`)
    } else {
      // Deleted on purpose. This account is where the policy is VERIFIED; a self-hoster deploys
      // their own from the same template. Leaving a standing assumable role behind for no reason
      // is a permission that outlives its justification.
      log(`deleting stack ${STACK}`)
      aws(['cloudformation', 'delete-stack', '--stack-name', STACK])
      const waited = spawnSync(
        'aws',
        ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', STACK, '--profile', PROFILE, '--region', REGION],
        { encoding: 'utf8' },
      )
      record(waited.status === 0, 'verification role deleted', (waited.stderr ?? '').trim().split('\n')[0] ?? '')
    }
  }

  /* ---- per-action summary ---- */
  log('--- summary ---')
  for (const { ok, what, detail } of results) log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (failures.length > 0) {
    log('')
    log('ONE OR MORE ACTIONS WERE REFUSED. That is a bug in the PUBLISHED POLICY, not in this run.')
    log('Fix deploy/aws/iam-role.yaml and docs/providers/aws.md together — `pnpm run lint` will')
    log('fail until they agree — and record the amendment. Do not widen a statement beyond the')
    log('action the error names.')
    for (const { offering, denied } of failures) log(`  ${offering}: ${denied.join(', ') || 'lifecycle failed without a permission error'}`)
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok).length
    log(failed === 0 ? 'RESULT: PASS — the published policy is sufficient and correctly scoped' : `RESULT: FAIL — ${failed} check(s)`)
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch((err) => {
    log('RESULT: FAIL — unhandled error')
    console.error(err.message)
    process.exit(1)
  })
