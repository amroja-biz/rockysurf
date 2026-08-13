import { ProviderError, type ProviderErrorCode } from '@rockysurf/provider-sdk'

/**
 * Hetzner's machine-readable error codes mapped onto the nine frozen codes.
 *
 * All 22 documented codes land somewhere. Three land BADLY, and that is why every error
 * carries `providerCode` (ADR-0003, F1) — the flattening is lossy and an operator needs to
 * see what the cloud actually said:
 *
 *  - `locked` — the resource is busy running another action, i.e. "retry in about 2s". As
 *    `conflict` it reads as a contradictory request. It is also the only Hetzner code that is
 *    both `conflict` AND worth retrying, which the frozen taxonomy cannot express, since
 *    retryability is derived from the code (F2). Callers that want to retry it must look at
 *    `providerCode`.
 *  - `maintenance` / `service_error` — as `unknown` they lose "this is the cloud's fault, not
 *    yours", which is the single most useful thing to tell a user staring at a failure.
 *  - `token_readonly` — as `auth` it is indistinguishable from a wrong token, though the fix
 *    is completely different: mint a read/write token, not a new one.
 */
const CODE_MAP: Readonly<Record<string, ProviderErrorCode>> = {
  unauthorized: 'auth',
  forbidden: 'auth',
  token_readonly: 'auth',
  not_found: 'not_found',
  invalid_input: 'invalid_spec',
  json_error: 'invalid_spec',
  unsupported_error: 'invalid_spec',
  uniqueness_error: 'conflict',
  conflict: 'conflict',
  locked: 'conflict',
  protected: 'conflict',
  rate_limit_exceeded: 'rate_limited',
  resource_limit_exceeded: 'quota',
  resource_unavailable: 'capacity',
  no_space_left_in_location: 'capacity',
  placement_error: 'capacity',
  server_error: 'unknown',
  service_error: 'unknown',
  maintenance: 'unknown',
  action_failed: 'unknown',
}

/**
 * Codes worth retrying that the nine-code taxonomy does NOT already mark retryable.
 *
 * `rate_limited`, `capacity` and `network` are retryable by derivation. `locked` is not, and
 * it is the one Hetzner code where waiting a couple of seconds genuinely fixes things, so the
 * HTTP client consults this set directly rather than `error.retryable`.
 */
export const RETRY_ANYWAY = new Set<string>(['locked', 'maintenance', 'service_error', 'server_error'])

/** Map a Hetzner error body to the frozen taxonomy, keeping the native code verbatim. */
export function toProviderError(
  providerCode: string,
  message: string,
  context: { method: string; path: string; status?: number; cause?: unknown },
): ProviderError {
  const code = CODE_MAP[providerCode] ?? 'unknown'
  return new ProviderError(code, `hetzner ${context.method} ${context.path}: ${providerCode}: ${message}`, {
    providerCode,
    cause: context.cause,
  })
}

/** The Hetzner code behind a ProviderError, when it came from the API. */
export function hetznerCodeOf(err: unknown): string | undefined {
  return err instanceof ProviderError ? err.providerCode : undefined
}

/** Whether a failure is Hetzner's "this does not exist". */
export function isNotFound(err: unknown): boolean {
  return err instanceof ProviderError && err.code === 'not_found'
}
