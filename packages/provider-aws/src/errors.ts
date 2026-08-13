import { ProviderError, type ProviderErrorCode } from '@rockysurf/provider-sdk'

/**
 * EC2 and SSM errors onto the nine frozen codes.
 *
 * Ported from the spike, with one change the freeze required: the cloud's own code now rides
 * along as `providerCode` (ADR-0003, F1) instead of being flattened away. All 22 documented
 * Hetzner codes and every EC2 code land somewhere in the nine, but a few land badly —
 * `InsufficientInstanceCapacity` and a bad instance type are both "capacity"-ish to a human
 * and very different to an operator — so the verbatim string is preserved for the one person
 * who needs it. Never branch core logic on it.
 *
 * `retryable` is gone as a constructor argument: it is derived from the code (F2), so the two
 * can no longer contradict each other.
 */

interface AwsErrorish {
  name?: string
  message?: string
  $metadata?: { httpStatusCode?: number }
  $retryable?: { throttling?: boolean }
  Code?: string
  code?: string
}

const AUTH = new Set([
  'AuthFailure',
  'UnauthorizedOperation',
  'AccessDenied',
  'AccessDeniedException',
  'InvalidClientTokenId',
  'MissingAuthenticationToken',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'ExpiredTokenException',
  'CredentialsProviderError',
  'UnrecognizedClientException',
  'InvalidAccessKeyId',
  'OptInRequired',
])

const QUOTA = new Set([
  'InstanceLimitExceeded',
  'VcpuLimitExceeded',
  'VolumeLimitExceeded',
  'AddressLimitExceeded',
  'SecurityGroupLimitExceeded',
  'RulesPerSecurityGroupLimitExceeded',
  'ResourceLimitExceeded',
])

const CAPACITY = new Set([
  'InsufficientInstanceCapacity',
  'InsufficientCapacity',
  'InsufficientHostCapacity',
  'InsufficientReservedInstanceCapacity',
  'Unsupported',
])

const RATE_LIMITED = new Set([
  'RequestLimitExceeded',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'EC2ThrottledException',
  'RequestThrottled',
])

const CONFLICT = new Set([
  'IdempotentParameterMismatch',
  'InvalidGroup.Duplicate',
  'InvalidPermission.Duplicate',
  'IncorrectInstanceState',
  'IncorrectState',
  'ConcurrentTagAccess',
  'ResourceAlreadyExistsException',
  'ConcurrentAccess',
])

const INVALID_SPEC = new Set([
  'InvalidParameterValue',
  'InvalidParameterCombination',
  'InvalidParameter',
  'MissingParameter',
  'InvalidInstanceType',
  'InvalidBlockDeviceMapping',
  'InvalidUserDataSize',
  'ValidationError',
  'ValidationException',
])

const NETWORK = new Set([
  'TimeoutError',
  'NetworkingError',
  'AbortError',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
])

/** EC2 puts its code on `name`; SSM and some SDK paths use `Code`. */
export function awsErrorCode(err: unknown): string {
  const e = err as AwsErrorish
  return e?.name ?? e?.Code ?? e?.code ?? ''
}

/** True for the one error every caller has to special-case: the instance is not there. */
export function isNotFound(err: unknown): boolean {
  return awsErrorCode(err).endsWith('.NotFound')
}

function classify(code: string, status: number | undefined, throttling: boolean): ProviderErrorCode {
  if (AUTH.has(code)) return 'auth'
  if (RATE_LIMITED.has(code) || throttling) return 'rate_limited'
  if (QUOTA.has(code) || code.endsWith('LimitExceeded')) return 'quota'
  if (CAPACITY.has(code)) return 'capacity'
  if (CONFLICT.has(code)) return 'conflict'
  if (code.endsWith('.NotFound') || code === 'ParameterNotFound' || code === 'ResourceNotFoundException') {
    return 'not_found'
  }
  if (INVALID_SPEC.has(code) || code.endsWith('.Malformed') || code.startsWith('Invalid')) return 'invalid_spec'
  if (NETWORK.has(code)) return 'network'
  if (status === 429) return 'rate_limited'
  return 'unknown'
}

/**
 * Wrap anything thrown by the AWS SDK as a `ProviderError`.
 *
 * A provider that lets a raw SDK error escape has broken its contract: core branches on the
 * nine codes and has no other vocabulary for failure.
 */
export function mapAwsError(err: unknown, context: string): ProviderError {
  if (err instanceof ProviderError) return err

  const e = err as AwsErrorish
  const code = awsErrorCode(err)
  const status = e?.$metadata?.httpStatusCode
  const mapped = classify(code, status, Boolean(e?.$retryable?.throttling))

  const message = `${context}: ${code || 'error'}${e?.message ? ` — ${e.message}` : ''}`
  return new ProviderError(mapped, message, {
    ...(code ? { providerCode: code } : {}),
    cause: err,
  })
}
