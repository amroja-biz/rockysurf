import { ProviderError, type ProviderErrorCode } from '@rockysurf/provider-sdk'

/**
 * Compute Engine errors onto the nine frozen codes (ADR-0003, F1/F2).
 *
 * GCE fails in TWO structurally different ways and both have to land here, because core has
 * exactly one vocabulary for failure:
 *
 *  1. **An HTTP error**, `{ error: { code, message, errors: [{ reason, message }] } }`. The
 *     `reason` is the machine-readable part — `notFound`, `alreadyExists`, `quotaExceeded`.
 *  2. **A failed asynchronous Operation.** `instances.insert` returns HTTP 200 with an
 *     Operation, and the failure arrives later in `operation.error.errors[].code` with a
 *     SCREAMING_SNAKE code from a different vocabulary — `ZONE_RESOURCE_POOL_EXHAUSTED`,
 *     `QUOTA_EXCEEDED`, `RESOURCE_ALREADY_EXISTS`. A provider that only maps the first shape
 *     reports "created successfully" for a create that failed.
 *
 * Both vocabularies are mapped below, and whichever string the cloud actually used rides
 * through verbatim as `providerCode`. Never branch core logic on it.
 *
 * Two mappings that are lossy enough to be worth naming, in the spirit of the Hetzner
 * provider's note on `locked`:
 *
 *  - `ZONE_RESOURCE_POOL_EXHAUSTED` becomes `capacity`, which is right and retryable, but the
 *    thing an operator needs to know — that a DIFFERENT ZONE would work right now — survives
 *    only in the message and the provider code.
 *  - `accessNotConfigured` becomes `auth`, where it is indistinguishable from a bad credential
 *    even though the fix is completely different: enable the Compute Engine API on the project.
 *    The message preserves it because that is a one-command fix nobody guesses.
 */

/** HTTP-error `reason` strings. */
const REASON_MAP: Readonly<Record<string, ProviderErrorCode>> = {
  unauthorized: 'auth',
  forbidden: 'auth',
  insufficientPermissions: 'auth',
  accessNotConfigured: 'auth',
  authError: 'auth',
  notFound: 'not_found',
  alreadyExists: 'conflict',
  resourceInUseByAnotherResource: 'conflict',
  resourceNotReady: 'conflict',
  conditionNotMet: 'conflict',
  invalid: 'invalid_spec',
  invalidParameter: 'invalid_spec',
  badRequest: 'invalid_spec',
  required: 'invalid_spec',
  quotaExceeded: 'quota',
  limitExceeded: 'quota',
  rateLimitExceeded: 'rate_limited',
  userRateLimitExceeded: 'rate_limited',
  backendError: 'unknown',
  internalError: 'unknown',
}

/** Operation `error.errors[].code` strings, which are a separate vocabulary. */
const OPERATION_CODE_MAP: Readonly<Record<string, ProviderErrorCode>> = {
  ZONE_RESOURCE_POOL_EXHAUSTED: 'capacity',
  ZONE_RESOURCE_POOL_EXHAUSTED_WITH_ALLOCATION: 'capacity',
  RESOURCE_POOL_EXHAUSTED: 'capacity',
  RESOURCE_AVAILABILITY_UNAVAILABLE: 'capacity',
  QUOTA_EXCEEDED: 'quota',
  LIMIT_EXCEEDED: 'quota',
  RESOURCE_ALREADY_EXISTS: 'conflict',
  RESOURCE_IN_USE_BY_ANOTHER_RESOURCE: 'conflict',
  RESOURCE_NOT_READY: 'conflict',
  RESOURCE_NOT_FOUND: 'not_found',
  NOT_FOUND: 'not_found',
  INVALID_USAGE: 'invalid_spec',
  INVALID_RESOURCE_USAGE: 'invalid_spec',
  CONDITION_NOT_MET: 'conflict',
  PERMISSIONS_ERROR: 'auth',
  INTERNAL_ERROR: 'unknown',
  RATE_LIMIT_EXCEEDED: 'rate_limited',
}

/**
 * HTTP status as the fallback, for the failures that carry no code we recognize.
 *
 * A failed Operation reports `httpErrorStatusCode`, so this is reachable from both shapes.
 */
function fromStatus(status: number | undefined): ProviderErrorCode {
  if (status === undefined) return 'unknown'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 412) return 'invalid_spec'
  return 'unknown'
}

/**
 * Codes worth retrying that the frozen taxonomy does NOT already derive as retryable.
 *
 * `rate_limited`, `capacity` and `network` retry by derivation (F2). `RESOURCE_NOT_READY` does
 * not, and it is GCE's "another operation is running on this resource, try again shortly" —
 * the same shape as Hetzner's `locked`, and the same reason for a set the client consults
 * directly rather than reading `error.retryable`.
 */
export const RETRY_ANYWAY: ReadonlySet<string> = new Set([
  'resourceNotReady',
  'RESOURCE_NOT_READY',
  'backendError',
  'internalError',
  'INTERNAL_ERROR',
])

export interface GceErrorContext {
  method: string
  path: string
  status?: number
  cause?: unknown
}

/** One GCE error item, from either an HTTP body or a failed Operation. */
export interface GceErrorItem {
  reason?: string
  code?: string
  message?: string
}

/**
 * Google answers a caller who cannot SEE a resource with `403 Required '<permission>'` rather
 * than with a 404, because confirming that something is absent is itself information about a
 * project the caller has no visibility into. So this exact shape — a 403 on a read — usually is
 * not a role that is short a permission. It is a different identity from the one the permission
 * was granted to, and the commonest cause by far is a stale
 * `application_default_credentials.json` left behind by unrelated work months earlier
 * (`rockysurf-6ose`, found in the first minutes of the real-GCE run). The tell an operator can
 * check in one command is that `gcloud` gets a 404 for the same call.
 *
 * Only reads are annotated. A 403 on a create or a delete genuinely can be a missing permission,
 * and a hint that fired on every 403 would be noise on the failures it does not explain.
 */
const STALE_ADC_HINT =
  'a 403 on a read means this caller cannot see the resource, not necessarily that the role is ' +
  'short a permission. If gcloud gets 404 for the same call, your Application Default ' +
  'Credentials are a different identity from your gcloud session — re-run ' +
  "'gcloud auth application-default login'"

function isNoVisibilityRead(context: GceErrorContext, message: string): boolean {
  return context.status === 403 && context.method.toUpperCase() === 'GET' && message.includes("Required '")
}

/**
 * Map a GCE failure onto the frozen taxonomy, keeping the cloud's own string verbatim.
 *
 * `reason` (HTTP) and `code` (Operation) are checked against their own tables and never against
 * each other's: the two vocabularies overlap in meaning and not in spelling, and a lookup that
 * fell through from one to the other would silently map by accident rather than by decision.
 */
export function toProviderError(item: GceErrorItem, message: string, context: GceErrorContext): ProviderError {
  const providerCode = item.reason ?? item.code
  const mapped =
    (item.reason !== undefined ? REASON_MAP[item.reason] : undefined) ??
    (item.code !== undefined ? OPERATION_CODE_MAP[item.code] : undefined) ??
    fromStatus(context.status)

  const where = `gcp ${context.method} ${context.path}`
  const hint = isNoVisibilityRead(context, message) ? ` — ${STALE_ADC_HINT}` : ''
  return new ProviderError(mapped, `${where}: ${providerCode ?? `HTTP ${context.status ?? '?'}`}: ${message}${hint}`, {
    ...(providerCode ? { providerCode } : {}),
    cause: context.cause,
  })
}

/** Whether a failure is GCE's "this does not exist". */
export function isNotFound(err: unknown): boolean {
  return err instanceof ProviderError && err.code === 'not_found'
}

/** Whether a failure is GCE's "a resource with that name is already there". */
export function isAlreadyExists(err: unknown): boolean {
  return (
    err instanceof ProviderError &&
    (err.providerCode === 'alreadyExists' || err.providerCode === 'RESOURCE_ALREADY_EXISTS')
  )
}
