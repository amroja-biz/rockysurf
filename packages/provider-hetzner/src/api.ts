import { ProviderError } from '@rockysurf/provider-sdk'
import { RETRY_ANYWAY, toProviderError } from './errors.js'
import type { HetznerPagination } from './types.js'

/**
 * The Hetzner Cloud HTTP client. Plain `fetch`, no vendor SDK — which is the whole point of
 * this provider: ~600 lines against a documented REST API, with no transitive dependency tree
 * to audit or to slow an `npx` cold start.
 */

export const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1'

export interface HetznerApiOptions {
  token: string
  /** Injected in tests. */
  fetchImpl?: typeof fetch
  baseUrl?: string
  /** Retries for throttling, `locked`, and 5xx. 0 disables. */
  maxRetries?: number
  retryBaseMs?: number
  /** Injected in tests so backoff does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class HetznerApi {
  private readonly token: string
  private readonly doFetch: typeof fetch
  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: HetznerApiOptions) {
    this.token = options.token
    this.doFetch = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl ?? HETZNER_API_BASE
    this.maxRetries = options.maxRetries ?? 3
    this.retryBaseMs = options.retryBaseMs ?? 500
    this.sleep = options.sleep ?? defaultSleep
  }

  /**
   * One API call, with the error mapping and a bounded retry.
   *
   * Every failure leaves as a `ProviderError`: a provider that lets a raw `fetch` rejection
   * escape has broken the SDK contract, because core has no vocabulary for it.
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
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (cause) {
        // No HTTP status at all: the request never got a well-formed answer.
        lastError = new ProviderError('network', `hetzner ${method} ${path} failed: ${String(cause)}`, { cause })
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt))
          continue
        }
        throw lastError
      }

      if (response.ok) return await this.decode<T>(response)

      const parsed = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
      const providerCode = parsed?.error?.code ?? (response.status === 404 ? 'not_found' : 'server_error')
      const message = parsed?.error?.message ?? `HTTP ${response.status}`
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

  /** Walk `meta.pagination.next_page` to the end, collecting one keyed array. */
  async collect<T>(path: string, key: string, perPage = 50): Promise<T[]> {
    const out: T[] = []
    let page = 1

    // A hard stop: a pagination cursor that never terminates should fail loudly rather than
    // spin against a paid API.
    for (let guard = 0; guard < 50; guard++) {
      const separator = path.includes('?') ? '&' : '?'
      const body = await this.call<HetznerPagination & Record<string, unknown>>(
        'GET',
        `${path}${separator}page=${page}&per_page=${perPage}`,
      )
      out.push(...((body?.[key] as T[] | undefined) ?? []))
      const next = body?.meta?.pagination?.next_page
      if (!next) return out
      page = next
    }

    throw new ProviderError('unknown', `hetzner GET ${path}: pagination did not terminate after 50 pages`)
  }

  private async decode<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T
    const text = await response.text()
    return (text ? (JSON.parse(text) as T) : undefined) as T
  }

  private backoff(attempt: number): number {
    return this.retryBaseMs * 2 ** attempt
  }

  /** Hetzner sends `Retry-After` in seconds on 429; honour it over our own backoff. */
  private retryAfterMs(response: Response): number | undefined {
    const header = Number(response.headers.get('retry-after'))
    return Number.isFinite(header) && header > 0 ? header * 1000 : undefined
  }
}
