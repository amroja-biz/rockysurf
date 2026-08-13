import { ProviderError, type ProviderErrorCode } from '@rockysurf/provider-sdk'

/**
 * Azure Resource Manager error codes mapped onto the nine frozen codes.
 *
 * ARM answers failures as `{ "error": { "code", "message", "details": [...] } }`, and the useful
 * code is frequently one level down in `details[]` rather than at the top — a template or
 * validation failure reports a generic outer code with the real one nested. {@link armErrorCode}
 * walks that.
 *
 * Three of these land badly in the nine, which is exactly why every error carries
 * `providerCode` verbatim (ADR-0003, F1):
 *
 *  - `OperationNotAllowed` is Compute's answer for BOTH "that operation is not allowed on this
 *    SKU" and "you are out of vCPU quota in this region". It maps to `quota`, because quota is
 *    overwhelmingly the case an operator hits, and the verbatim message is what tells the two
 *    apart. A caller reading only the nine codes cannot.
 *  - `AnotherOperationInProgress` is `conflict`, which reads as a contradictory request when it
 *    actually means "wait about two seconds". It is Azure's `locked`, and like Hetzner's it is
 *    both `conflict` and worth retrying, which the frozen taxonomy cannot express because
 *    retryability is derived from the code (F2). {@link RETRY_ANYWAY} is how the HTTP client
 *    retries it anyway.
 *  - `RetryableErrorDueToAnotherOperation` arrives as HTTP 429 from Microsoft.Network but is a
 *    resource LOCK rather than a rate limit. It is retryable either way, so the flattening to
 *    `rate_limited` costs an operator only the explanation.
 */
const CODE_MAP: Readonly<Record<string, ProviderErrorCode>> = {
  // auth — the credential is rejected, or lacks permission for this call
  AuthorizationFailed: 'auth',
  LinkedAuthorizationFailed: 'auth',
  InvalidAuthenticationToken: 'auth',
  InvalidAuthenticationTokenTenant: 'auth',
  ExpiredAuthenticationToken: 'auth',
  AuthenticationFailed: 'auth',
  SubscriptionNotFound: 'auth',
  DisabledSubscription: 'auth',

  // quota — a limit the account holds. Raising it is a human action.
  ResourceQuotaExceeded: 'quota',
  OperationNotAllowed: 'quota',
  QuotaExceeded: 'quota',
  PublicIPCountLimitReached: 'quota',
  NetworkInterfaceCountLimitReached: 'quota',
  SubscriptionRequestsThrottled: 'rate_limited',

  // capacity — the region has no stock right now. Retryable; another size or region may work.
  AllocationFailed: 'capacity',
  ZonalAllocationFailed: 'capacity',
  OverconstrainedAllocationRequest: 'capacity',
  OverconstrainedZonalAllocationRequest: 'capacity',
  SkuNotAvailable: 'capacity',

  // not_found — see the propagation-grace rule on describe(); absence is not proof of death
  ResourceNotFound: 'not_found',
  NotFound: 'not_found',
  ResourceGroupNotFound: 'not_found',
  ParentResourceNotFound: 'not_found',
  ImageNotFound: 'not_found',

  // rate_limited
  TooManyRequests: 'rate_limited',
  RetryableErrorDueToAnotherOperation: 'rate_limited',

  // conflict — busy, locked, or contradictory
  Conflict: 'conflict',
  AnotherOperationInProgress: 'conflict',
  ResourceGroupBeingDeleted: 'conflict',
  InUseSubnetCannotBeDeleted: 'conflict',
  PropertyChangeNotAllowed: 'conflict',
  ReservedResourceName: 'conflict',

  // invalid_spec — the request asks for something Azure will not do
  InvalidParameter: 'invalid_spec',
  InvalidRequestContent: 'invalid_spec',
  InvalidResourceReference: 'invalid_spec',
  InvalidTemplateDeployment: 'invalid_spec',
  RequestDisallowedByPolicy: 'invalid_spec',
  SubnetIsFull: 'invalid_spec',
  SubnetsNotInSameVnet: 'invalid_spec',
  PrivateIPAddressNotInSubnet: 'invalid_spec',
  MissingSubscriptionRegistration: 'invalid_spec',

  // unknown — the cloud's fault rather than ours, which the nine codes cannot say
  InternalServerError: 'unknown',
  ServiceUnavailable: 'unknown',
  GatewayTimeout: 'unknown',
}

/**
 * Codes worth retrying that the nine-code taxonomy does NOT already mark retryable.
 *
 * `rate_limited`, `capacity` and `network` are retryable by derivation. `AnotherOperationInProgress`
 * is not — it maps to `conflict` — and it is the one Azure code where waiting a couple of seconds
 * genuinely fixes things, because ARM serialises operations on a single resource. The HTTP client
 * consults this set directly rather than `error.retryable`, the same way the Hetzner client does
 * for `locked`.
 */
export const RETRY_ANYWAY: ReadonlySet<string> = new Set([
  'AnotherOperationInProgress',
  'InternalServerError',
  'ServiceUnavailable',
  'GatewayTimeout',
  'RetryableErrorDueToAnotherOperation',
])

/** The `{ error: { code, message, details } }` envelope, as much of it as we read. */
export interface ArmErrorBody {
  error?: {
    code?: string
    message?: string
    target?: string
    details?: { code?: string; message?: string }[]
  }
  /** Entra ID's token endpoint uses the OAuth shape instead, not ARM's. */
  error_description?: string
}

/**
 * The most specific code in an ARM error body.
 *
 * ARM nests the interesting code inside `details[]` for anything that went through a validation
 * or template path, and reports a generic wrapper at the top. Preferring the nested one is what
 * makes the difference between reporting `InvalidTemplateDeployment` and reporting
 * `QuotaExceeded`, which are the same failure described at two levels of usefulness.
 */
export function armErrorCode(body: ArmErrorBody | null | undefined): string | undefined {
  const nested = body?.error?.details?.find((detail) => detail.code)?.code
  return nested ?? body?.error?.code
}

/** The human half of an ARM error body, preferring whichever level carried the code. */
export function armErrorMessage(body: ArmErrorBody | null | undefined): string | undefined {
  const nested = body?.error?.details?.find((detail) => detail.code)
  return nested?.message ?? body?.error?.message ?? body?.error_description
}

/**
 * Map one ARM failure onto the frozen taxonomy, keeping Azure's own code verbatim.
 *
 * The HTTP status is the fallback rather than the primary signal, because ARM's codes are far
 * more specific than its statuses — a 409 is `Conflict` or `AnotherOperationInProgress` and
 * those want different handling.
 */
export function toProviderError(
  providerCode: string | undefined,
  message: string,
  context: { method: string; path: string; status?: number; cause?: unknown },
): ProviderError {
  const code = classify(providerCode, context.status)
  const label = providerCode ?? `HTTP ${context.status ?? '?'}`
  return new ProviderError(code, `azure ${context.method} ${context.path}: ${label}: ${message}`, {
    ...(providerCode ? { providerCode } : {}),
    cause: context.cause,
  })
}

function classify(providerCode: string | undefined, status: number | undefined): ProviderErrorCode {
  const mapped = providerCode ? CODE_MAP[providerCode] : undefined
  if (mapped) return mapped

  // Unrecognised code: fall back to the status, which is coarse but never wrong in the way a
  // guess at the code's meaning would be.
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status !== undefined && status >= 500) return 'unknown'
  if (status !== undefined && status >= 400) return 'invalid_spec'
  return 'unknown'
}

/** Whether a failure is Azure's "this does not exist". */
export function isNotFound(err: unknown): boolean {
  return err instanceof ProviderError && err.code === 'not_found'
}

/** The Azure code behind a ProviderError, when it came from ARM. */
export function azureCodeOf(err: unknown): string | undefined {
  return err instanceof ProviderError ? err.providerCode : undefined
}
