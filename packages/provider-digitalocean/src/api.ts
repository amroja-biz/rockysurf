import { ProviderError } from '@rockysurf/provider-sdk'
import { RETRY_ANYWAY, toProviderError } from './errors.js'
import type { DoErrorBody, DoPagination } from './types.js'

/**
 * The DigitalOcean HTTP client. Plain `fetch`, no vendor SDK.
 *
 * THE VENDOR-SDK DECISION, MEASURED RATHER THAN RECALLED (`vendor-sdks.md`, step 1). The API is
 * documented REST with JSON bodies and a bearer personal access token in one header — there is no
 * signed assertion flow, no credential chain and no token refresh, which is the entire class of
 * work a vendor library is worth buying for. The candidate declined was `dots-wrapper`, a
 * community TypeScript client; `@digitalocean/godo` is Go, and DigitalOcean publishes no official
 * JavaScript SDK for the control-plane API at all. Measure before quoting: the instruction is
 * `npm view <package>@<version> dist.unpackedSize`, and a version number rather than a date is
 * what makes such a figure checkable, because an npm tarball is immutable once published.
 *
 * What writing the transport by hand made visible, and a generated client would have hidden:
 *
 *  - **Every droplet action is asynchronous.** `POST /v2/droplets/{id}/actions` answers 201 with
 *    an Action whose `status` is `in-progress`, and the failure arrives later, in the body of
 *    `GET /v2/actions/{id}` — also a 200. Accepted is not done.
 *  - **The error body is the HTTP status restated.** `{ id, message, request_id }` where `id` is
 *    "a short identifier corresponding to the HTTP status code" — see `errors.ts` for what that
 *    costs and what this provider refuses to guess because of it.
 */

export const DIGITALOCEAN_API_BASE = 'https://api.digitalocean.com/v2'

export interface DigitaloceanApiOptions {
  token: string
  /** Injected in tests. */
  fetchImpl?: typeof fetch
  baseUrl?: string
  /** Retries for throttling, transport failures and 5xx. 0 disables. */
  maxRetries?: number
  retryBaseMs?: number
  /** Injected in tests so backoff does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class DigitaloceanApi {
  private readonly token: string
  private readonly doFetch: typeof fetch
  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: DigitaloceanApiOptions) {
    this.token = options.token
    this.doFetch = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl ?? DIGITALOCEAN_API_BASE
    this.maxRetries = options.maxRetries ?? 3
    this.retryBaseMs = options.retryBaseMs ?? 500
    this.sleep = options.sleep ?? defaultSleep
  }

  /**
   * One API call, with the error mapping and a bounded retry.
   *
   * Every failure leaves as a `ProviderError`: a provider that lets a raw `fetch` rejection escape
   * has broken the SDK contract, because core has no vocabulary for it.
   */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response
      try {
        response = await this.doFetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (cause) {
        // No HTTP status at all: the request never got a well-formed answer.
        lastError = new ProviderError('network', `digitalocean ${method} ${path} failed: ${String(cause)}`, { cause })
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt))
          continue
        }
        throw lastError
      }

      if (response.ok) return await this.decode<T>(response)

      const parsed = (await response.json().catch(() => null)) as Partial<DoErrorBody> | null
      const providerCode = parsed?.id ?? `http_${response.status}`
      const message = parsed?.message ?? `HTTP ${response.status}`
      const error = toProviderError(providerCode, message, { method, path, status: response.status })
      lastError = error

      if ((error.retryable || RETRY_ANYWAY.has(providerCode)) && attempt < this.maxRetries) {
        await this.sleep(this.retryAfterMs(response) ?? this.backoff(attempt))
        continue
      }
      throw error
    }

    throw lastError
  }

  /**
   * Walk `links.pages.next` to the end, collecting one keyed array.
   *
   * PAGE NUMBERS RATHER THAN THE `next` URL, deliberately. DigitalOcean returns an absolute URL in
   * `links.pages.next`, and following it verbatim would send every paged read at
   * `api.digitalocean.com` regardless of the `baseUrl` this client was constructed with — which
   * would make the test fake unreachable from page two onward and, worse, would look like it
   * worked. The presence of `next` is the signal; the cursor is ours.
   */
  async collect<T>(path: string, key: string, perPage = 100): Promise<T[]> {
    const out: T[] = []
    let page = 1

    // A hard stop: a pagination cursor that never terminates should fail loudly rather than spin
    // against a paid API.
    for (let guard = 0; guard < 50; guard++) {
      const separator = path.includes('?') ? '&' : '?'
      const body = await this.call<DoPagination & Record<string, unknown>>(
        'GET',
        `${path}${separator}page=${page}&per_page=${perPage}`,
      )
      out.push(...((body?.[key] as T[] | undefined) ?? []))
      if (!body?.links?.pages?.next) return out
      page += 1
    }

    throw new ProviderError('unknown', `digitalocean GET ${path}: pagination did not terminate after 50 pages`)
  }

  private async decode<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T
    const text = await response.text()
    return (text ? (JSON.parse(text) as T) : undefined) as T
  }

  private backoff(attempt: number): number {
    return this.retryBaseMs * 2 ** attempt
  }

  /** DigitalOcean sends `retry-after` in seconds on a 429; honour it over our own backoff. */
  private retryAfterMs(response: Response): number | undefined {
    const header = Number(response.headers.get('retry-after'))
    return Number.isFinite(header) && header > 0 ? header * 1000 : undefined
  }
}
