/**
 * WHICH CREDENTIALS THE ORPHAN AUDIT USES — and the rule that they must not be the run's
 * (rockysurf-ufwn, rockysurf-gyp1.5, rockysurf-evo1).
 *
 * The AWS lifecycle run has two principals in it, on purpose:
 *
 *   THE RUN      is the identity under test. Under rockysurf-evo1 that is the role deployed from
 *                deploy/aws/iam-role.yaml — exactly the policy this project publishes to
 *                self-hosters, and nothing more.
 *   THE AUDIT    is the operator. `ec2:DescribeVolumes` is not a call the provider makes, so it is
 *                deliberately absent from the published policy, and the volume half of the audit
 *                therefore cannot run under the run's own identity. It should not want to: an
 *                orphan the credentials under test cannot SEE is an orphan the audit calls clean.
 *
 * Two ways to hand over the operator's credentials, because the two contexts differ:
 *
 *   PROFILE      `ROCKYSURF_E2E_AWS_AUDIT_PROFILE=<name>` — a named profile in ~/.aws. What a
 *                workstation has, and what scripts/e2e/restricted-principal.mjs passes.
 *   ENVIRONMENT  `ROCKYSURF_E2E_AWS_AUDIT_{ACCESS_KEY_ID,SECRET_ACCESS_KEY,SESSION_TOKEN}` — a
 *                session handed over directly. What CI has, where there is no ~/.aws to name and
 *                the entry role's session has to be captured before the role-chaining hop
 *                overwrites the environment with the identity under test.
 *
 * AND THE STRICT MODE THAT MAKES IT A GUARANTEE. `ROCKYSURF_E2E_AWS_AUDIT_REQUIRED=1` says "this
 * run's own credentials are the restricted ones; the audit MUST be somebody else". Under it, an
 * unconfigured, half-configured or ambiguous split is a hard failure BEFORE the run spends money,
 * rather than an `UnauthorizedOperation` twelve minutes later that reads like a lifecycle bug —
 * and, worse, rather than a silent pass on the day somebody "fixes" that error by widening the
 * published policy to include `ec2:DescribeVolumes`. The caller pairs this decision with a
 * distinctness check on the resolved credentials themselves (see lifecycle.mjs), because a
 * correctly-shaped configuration that happens to name the same session is the failure this whole
 * arrangement exists to prevent.
 *
 * Nothing here reads a credential value for any purpose but passing it to the SDK, and nothing
 * here — including every error message — ever puts one in a string.
 */

/** Every environment variable this seam reads, named once so the self-test cannot drift. */
export const AUDIT_ENV = {
  runProfile: 'ROCKYSURF_E2E_AWS_PROFILE',
  profile: 'ROCKYSURF_E2E_AWS_AUDIT_PROFILE',
  accessKeyId: 'ROCKYSURF_E2E_AWS_AUDIT_ACCESS_KEY_ID',
  secretAccessKey: 'ROCKYSURF_E2E_AWS_AUDIT_SECRET_ACCESS_KEY',
  sessionToken: 'ROCKYSURF_E2E_AWS_AUDIT_SESSION_TOKEN',
  required: 'ROCKYSURF_E2E_AWS_AUDIT_REQUIRED',
}

/** The default profile a workstation run uses when it is told nothing at all. */
export const DEFAULT_PROFILE = 'sandbox'

/** An error the caller can present as a configuration problem rather than a stack trace. */
export class AuditCredentialError extends Error {
  constructor(message, remediation = []) {
    super(message)
    this.name = 'AuditCredentialError'
    this.remediation = remediation
  }
}

const value = (env, key) => (env[key] ?? '').trim()

/** `1`/`true`/`yes` mean strict. Empty, absent, `0` and `false` all mean "not strict". */
export function isStrict(env = process.env) {
  const raw = value(env, AUDIT_ENV.required).toLowerCase()
  return raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'no'
}

/**
 * The check that a well-SHAPED configuration does not stand in for: that the audit is a DIFFERENT
 * principal from the run.
 *
 * A session captured after the role-chaining hop, and a published policy quietly widened to include
 * `ec2:DescribeVolumes` so the nightly stops erroring, both leave a configuration that reads as
 * correct and audits with exactly the credentials it is meant to be checking. Comparing the two
 * resolved access key ids costs no API call and no permission, and catches both. The ids are
 * compared to each other and to nothing else; neither appears in the failure.
 */
export function assertDistinctPrincipals(auditAccessKeyId, runAccessKeyId) {
  if (auditAccessKeyId !== runAccessKeyId) return
  throw new AuditCredentialError('the orphan audit would run as the identity under test', [
    'Its credentials resolve to the same session as the run. An orphan the restricted role cannot',
    'see would be reported clean, which is the one thing this audit exists to prevent.',
    "In CI, the entry role's session must be captured BEFORE the role-chaining step, not after.",
  ])
}

/**
 * The credentials the RUN itself uses, as an SDK client config.
 *
 * A named profile locally, the default credential chain in CI — where the credentials arrive as
 * environment variables and there is no ~/.aws to name. `ROCKYSURF_E2E_AWS_PROFILE=''` (empty, not
 * absent) is how a caller forces the chain; absent means the workstation default.
 */
export function resolveRunCredentials(env = process.env) {
  const profile = env[AUDIT_ENV.runProfile] ?? DEFAULT_PROFILE
  return profile
    ? { source: 'profile', profile, clientConfig: { profile } }
    : { source: 'chain', profile: '', clientConfig: {} }
}

/**
 * The credentials the AUDIT uses, as an SDK client config, plus whether they are REQUIRED to be a
 * different principal from the run's.
 *
 * Throws `AuditCredentialError` rather than falling back whenever the configuration is one nobody
 * can have meant: both mechanisms at once, half an environment credential set, or — in strict mode
 * — no split at all. Falling back is what this bead was filed about.
 */
export function resolveAuditCredentials(env = process.env) {
  const strict = isStrict(env)
  const profile = value(env, AUDIT_ENV.profile)
  const accessKeyId = value(env, AUDIT_ENV.accessKeyId)
  const secretAccessKey = value(env, AUDIT_ENV.secretAccessKey)
  const sessionToken = value(env, AUDIT_ENV.sessionToken)
  const anyEnvCredential = !!(accessKeyId || secretAccessKey || sessionToken)

  if (profile && anyEnvCredential) {
    throw new AuditCredentialError(
      `the orphan audit is configured twice: ${AUDIT_ENV.profile} names a profile AND ` +
        `${AUDIT_ENV.accessKeyId}/… supply a session. Refusing to guess which one is current.`,
      [`Unset one of them. CI uses the environment set; a workstation uses ${AUDIT_ENV.profile}.`],
    )
  }

  // A half-set is never deliberate, and it is worth catching even when the run is not strict: the
  // SDK would silently ignore the fragment and audit as somebody else entirely.
  if (anyEnvCredential && !(accessKeyId && secretAccessKey)) {
    throw new AuditCredentialError(
      `the orphan audit's environment credentials are incomplete: ` +
        `${AUDIT_ENV.accessKeyId} and ${AUDIT_ENV.secretAccessKey} must be set together` +
        ` (${AUDIT_ENV.sessionToken} too, for a temporary session).`,
      ['Set all of them, or none of them.'],
    )
  }

  if (profile) {
    return { source: 'profile', strict, describe: `profile ${profile}`, clientConfig: { profile } }
  }

  if (accessKeyId) {
    return {
      source: 'environment',
      strict,
      describe: `session supplied through ${AUDIT_ENV.accessKeyId}`,
      clientConfig: {
        credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
      },
    }
  }

  if (strict) {
    throw new AuditCredentialError(
      `${AUDIT_ENV.required} is set — this run's credentials are the restricted ones under test — ` +
        `but no operator credentials were given for the orphan audit.`,
      [
        `ec2:DescribeVolumes is deliberately absent from the published policy (deploy/aws/iam-role.yaml),`,
        `so the audit cannot run under the identity being tested. Give it the operator's:`,
        `  a workstation: ${AUDIT_ENV.profile}=<an operator profile in ~/.aws>`,
        `  CI:            ${AUDIT_ENV.accessKeyId} / ${AUDIT_ENV.secretAccessKey} / ${AUDIT_ENV.sessionToken}`,
        `                 captured from the OIDC entry role BEFORE the role-chaining hop`,
        `See .github/workflows/nightly-real-cloud.yml and rockysurf-ufwn.`,
      ],
    )
  }

  // Nothing configured and nothing demanded: the audit reads with the run's own credentials, which
  // is correct whenever the run is already the operator (an unrestricted workstation run).
  const run = resolveRunCredentials(env)
  return {
    source: 'inherited',
    strict,
    describe: run.profile ? `the run's own credentials (profile ${run.profile})` : `the run's own credentials`,
    clientConfig: run.clientConfig,
  }
}
