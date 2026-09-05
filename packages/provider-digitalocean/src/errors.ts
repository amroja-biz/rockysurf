import { ProviderError, type ProviderErrorCode } from '@rockysurf/provider-sdk'

/**
 * DigitalOcean's error vocabulary mapped onto the nine frozen codes.
 *
 * THE SHAPE OF THE PROBLEM, stated first because it decides everything below. DigitalOcean's
 * error body is `{ id, message, request_id }`, and `id` is documented as "A short identifier
 * corresponding to the HTTP status code returned" — `not_found`, `unauthorized`,
 * `unprocessable_entity`. It is a restatement of the status line, not a machine-readable reason.
 * So unlike Hetzner, whose 22 codes each name a distinct failure, this cloud gives a provider
 * exactly as much information as HTTP does.
 *
 * The consequence, recorded rather than papered over: **a quota refusal and a malformed request
 * are the same `422 unprocessable_entity` here.** "You have reached your Droplet limit" and "size
 * is not a valid slug" arrive with identical machine-readable parts and differ only in the
 * human-readable `message`. This maps both to `invalid_spec` and does NOT sniff the message for
 * the word "limit":
 *
 *  - the sniff would be a string match against prose the cloud can reword at any time, and its
 *    failure mode is silent — a quota refusal reported as a malformed spec, or the reverse;
 *  - the two codes differ in exactly one behaviour a caller can act on, retryability, and
 *    `quota` and `invalid_spec` are both non-retryable, so the mistake would buy nothing;
 *  - the distinction survives where the operator can actually use it: `providerCode` carries the
 *    id verbatim and the message carries DigitalOcean's own sentence (ADR-0003, F1).
 *
 * If DigitalOcean ever publishes reason codes distinct from the status, this table is where they
 * go, and the sniff still does not belong here.
 */
const ID_MAP: Readonly<Record<string, ProviderErrorCode>> = {
  unauthorized: 'auth',
  forbidden: 'auth',
  not_found: 'not_found',
  bad_request: 'invalid_spec',
  unprocessable_entity: 'invalid_spec',
  conflict: 'conflict',
  too_many_requests: 'rate_limited',
  internal_server_error: 'unknown',
  server_error: 'unknown',
  service_unavailable: 'unknown',
  bad_gateway: 'unknown',
  gateway_timeout: 'unknown',
}

/** The same mapping keyed on the status, for a body that was not JSON or carried no `id`. */
const STATUS_MAP: Readonly<Record<number, ProviderErrorCode>> = {
  400: 'invalid_spec',
  401: 'auth',
  403: 'auth',
  404: 'not_found',
  409: 'conflict',
  422: 'invalid_spec',
  429: 'rate_limited',
  500: 'unknown',
  502: 'unknown',
  503: 'unknown',
  504: 'unknown',
}

/**
 * Ids worth retrying that the nine-code taxonomy does not already mark retryable.
 *
 * `rate_limited` and `network` are retryable by derivation. DigitalOcean's 5xx family is not, and
 * it is the one place where trying again a second later genuinely fixes things, so the HTTP client
 * consults this set directly rather than `error.retryable`.
 */
export const RETRY_ANYWAY = new Set<string>([
  'internal_server_error',
  'server_error',
  'service_unavailable',
  'bad_gateway',
  'gateway_timeout',
])

/** Map a DigitalOcean failure onto the frozen taxonomy, keeping its own id verbatim. */
export function toProviderError(
  providerCode: string,
  message: string,
  context: { method: string; path: string; status?: number; cause?: unknown },
): ProviderError {
  const code =
    ID_MAP[providerCode] ?? (context.status !== undefined ? STATUS_MAP[context.status] : undefined) ?? 'unknown'
  return new ProviderError(code, `digitalocean ${context.method} ${context.path}: ${providerCode}: ${message}`, {
    providerCode,
    cause: context.cause,
  })
}

/** The DigitalOcean id behind a ProviderError, when it came from the API. */
export function digitaloceanCodeOf(err: unknown): string | undefined {
  return err instanceof ProviderError ? err.providerCode : undefined
}

/** Whether a failure is DigitalOcean's "this does not exist". */
export function isNotFound(err: unknown): boolean {
  return err instanceof ProviderError && err.code === 'not_found'
}
