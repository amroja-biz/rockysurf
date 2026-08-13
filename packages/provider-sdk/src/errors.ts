/**
 * Error taxonomy. Frozen at nine codes by ADR-0003 (amendments F1, F2).
 */

/**
 * The complete v0 taxonomy. Every provider failure maps onto exactly one of these nine
 * codes, and the list does not grow: when the spike's Hetzner provider mapped all 22 of that
 * API's documented codes, every one landed somewhere. Three landed *badly* — `locked` (busy,
 * retry in ~2s) reads as `conflict`; `maintenance` and `service_error` read as `unknown`,
 * erasing "this is the cloud's fault, not yours"; `token_readonly` reads as `auth`,
 * indistinguishable from a bad token. The answer is {@link ProviderError.providerCode}, not a
 * tenth code (ADR-0003, F1).
 *
 * - `auth` — credentials rejected, expired, or lacking permission for this call.
 * - `quota` — the account's limit for a resource is reached. Raising it is a human action.
 * - `capacity` — the cloud has no stock right now. Retryable; a different size or region may work.
 * - `invalid_spec` — the request is malformed or asks for something this provider cannot do.
 *   Also the code for an unsupported operation (see {@link unsupportedOperationError}).
 * - `not_found` — the referenced resource does not exist. See the propagation-grace rule on
 *   `ComputeProvider.describe`: absence is not proof of termination on an eventually
 *   consistent API.
 * - `rate_limited` — throttled. Retryable after a backoff.
 * - `conflict` — the resource is busy, locked, or already exists in a contradictory state.
 * - `network` — the request never got a well-formed answer. Retryable.
 * - `unknown` — anything unrecognized, including provider 5xx.
 */
export type ProviderErrorCode =
  | 'auth'
  | 'quota'
  | 'capacity'
  | 'invalid_spec'
  | 'not_found'
  | 'rate_limited'
  | 'conflict'
  | 'network'
  | 'unknown'

/** All nine codes, for exhaustiveness checks and tests. Frozen. */
export const PROVIDER_ERROR_CODES = [
  'auth',
  'quota',
  'capacity',
  'invalid_spec',
  'not_found',
  'rate_limited',
  'conflict',
  'network',
  'unknown',
] as const satisfies readonly ProviderErrorCode[]

/**
 * The codes worth retrying, as a property OF the code (ADR-0003, F2).
 *
 * The sketch carried a separate `retryable` boolean, which was a second source of truth that
 * could contradict the first — a `rate_limited` error constructed with `retryable: false` was
 * expressible and meaningless. Retryability is now derived, so it cannot disagree.
 *
 * `unknown` is deliberately absent: a provider 5xx is often worth retrying, but so is nothing
 * else in that bucket, and callers that want to retry it should do so on their own evidence.
 */
export const RETRYABLE_PROVIDER_ERROR_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'rate_limited',
  'capacity',
  'network',
])

/** Whether a failure with this code is worth retrying unchanged. Derived, never stored. */
export function isRetryableProviderErrorCode(code: ProviderErrorCode): boolean {
  return RETRYABLE_PROVIDER_ERROR_CODES.has(code)
}

export interface ProviderErrorOptions {
  /**
   * The provider's own error code, verbatim — `locked`, `service_error`, `token_readonly`,
   * `InsufficientInstanceCapacity`. Carried so an operator can see what the cloud actually
   * said after the nine-code mapping has flattened it (ADR-0003, F1).
   *
   * Never branch core logic on this. It is provider-specific by construction, and branching on
   * it recreates the `provider.id` conditionals the whole SDK exists to prevent.
   */
  providerCode?: string
  /** The underlying error, kept for logs and debugging. */
  cause?: unknown
}

/**
 * The only error type a provider may throw across the interface boundary.
 *
 * A provider that lets a raw SDK or `fetch` error escape has broken its contract: core
 * branches on {@link ProviderErrorCode} and has no other vocabulary for failure.
 */
export class ProviderError extends Error {
  override readonly name = 'ProviderError'
  readonly code: ProviderErrorCode
  readonly providerCode: string | undefined

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.code = code
    this.providerCode = options.providerCode
  }

  /**
   * Derived from {@link code} — there is no `retryable` field to set, and no way for the two
   * to disagree (ADR-0003, F2).
   */
  get retryable(): boolean {
    return isRetryableProviderErrorCode(this.code)
  }
}

/** Narrowing helper for `catch` blocks, which receive `unknown`. */
export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError
}

/**
 * The error a provider throws from an operation its capabilities say it does not support —
 * in practice `stop`/`start` on a provider with `capabilities.stop === false`.
 *
 * ADR-0003 (A2) makes `stop`/`start` required methods rather than optional ones, so that
 * `capabilities.stop` stays the single source of truth core branches on. The stated cost is
 * that providers which cannot stop must implement two throwing methods; this helper is the
 * whole implementation of both.
 */
export function unsupportedOperationError(providerId: string, operation: string): ProviderError {
  return new ProviderError(
    'invalid_spec',
    `provider '${providerId}' does not support ${operation}() — check capabilities before calling`,
  )
}
