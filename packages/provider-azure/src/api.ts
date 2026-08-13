import { ProviderError } from '@rockysurf/provider-sdk'
import type { CredentialChain } from './credentials.js'
import { armErrorCode, armErrorMessage, RETRY_ANYWAY, toProviderError, type ArmErrorBody } from './errors.js'

/**
 * The Azure Resource Manager HTTP client. Plain `fetch`, no vendor SDK.
 *
 * This is the same bet `@rockysurf/provider-hetzner` makes and for the same reason: the ARM
 * surface this provider needs is about ten endpoints against a documented REST API, and the
 * alternative — `@azure/arm-compute` plus `@azure/arm-network` plus `@azure/arm-resources` plus
 * `@azure/identity` and `msal-node` — lands in the shipped CLI's install closure, which
 * `scripts/check-npx-closure.mjs` exists to keep an eye on.
 */

export const ARM_BASE = 'https://management.azure.com'

/**
 * Pinned api-versions, one per resource provider.
 *
 * PINNED RATHER THAN LATEST, deliberately. ARM's api-version is a contract: a newer one can
 * change defaults and response shapes, so "whatever is current" is a silent upgrade path into a
 * behaviour nobody chose. These are the current stable versions as of 2026-08-13, read off the
 * REST reference.
 *
 * `compute` must be 2021-03-01 or newer for the `deleteOption` fields that make `terminate()`
 * reap the whole instance rather than just the VM — Microsoft states that minimum explicitly.
 * The network side's minimum for `deleteOption` on a public IP is NOT documented (the example
 * literally prints `api-version=xx`), which is another reason to pin a version known to carry it
 * rather than to reason about a floor.
 */
export const API_VERSIONS = {
  compute: '2026-03-01',
  network: '2025-05-01',
  resources: '2021-04-01',
} as const

export interface ArmApiOptions {
  credentials: CredentialChain
  subscriptionId: string
  /** Injected in tests. */
  fetchImpl?: typeof fetch
  baseUrl?: string
  /** Retries for throttling, resource locks and 5xx. 0 disables. */
  maxRetries?: number
  retryBaseMs?: number
  /** Injected in tests so backoff does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class ArmApi {
  readonly subscriptionId: string
  private readonly credentials: CredentialChain
  private readonly doFetch: typeof fetch
  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: ArmApiOptions) {
    this.credentials = options.credentials
    this.subscriptionId = options.subscriptionId
    this.doFetch = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl ?? ARM_BASE
    this.maxRetries = options.maxRetries ?? 3
    this.retryBaseMs = options.retryBaseMs ?? 500
    this.sleep = options.sleep ?? defaultSleep
  }

  /**
   * One ARM call, with the error mapping and a bounded retry.
   *
   * Every failure leaves as a `ProviderError`: a provider that lets a raw `fetch` rejection
   * escape has broken the SDK contract, because core has no vocabulary for it.
   *
   * @param path an absolute ARM path beginning with `/subscriptions/...`, WITHOUT `api-version`
   * @param apiVersion which pinned version this resource provider speaks
   */
  async call<T>(
    method: string,
    path: string,
    apiVersion: string,
    body?: unknown,
  ): Promise<T> {
    // A `nextLink` arrives carrying its own api-version and continuation token; appending a
    // second one is rejected by ARM, so a path that already states a version keeps it.
    const separator = path.includes('?') ? '&' : '?'
    const url = path.includes('api-version=')
      ? `${this.baseUrl}${path}`
      : `${this.baseUrl}${path}${separator}api-version=${apiVersion}`
    let lastError: unknown
    // One free re-acquisition of the token on a 401, on the theory that the cached token expired
    // between the check and the call. A second 401 is a real authorization failure.
    let refreshed = false

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const token = await this.credentials.getToken()

      let response: Response
      try {
        response = await this.doFetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (cause) {
        // No HTTP status at all: the request never got a well-formed answer.
        lastError = new ProviderError('network', `azure ${method} ${path} failed: ${String(cause)}`, { cause })
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt))
          continue
        }
        throw lastError
      }

      if (response.ok) return await this.decode<T>(response)

      if (response.status === 401 && !refreshed) {
        // A token that ARM rejects is worth exactly one re-acquisition. Doing it inside the retry
        // loop rather than in the credential chain keeps the chain a pure token source.
        refreshed = true
        this.credentials.invalidate()
        continue
      }

      const parsed = (await response.json().catch(() => null)) as ArmErrorBody | null
      const providerCode = armErrorCode(parsed)
      const message = armErrorMessage(parsed) ?? `HTTP ${response.status}`
      const error = toProviderError(providerCode, message, { method, path, status: response.status })
      lastError = error

      const retryable = error.retryable || (providerCode !== undefined && RETRY_ANYWAY.has(providerCode))
      if (retryable && attempt < this.maxRetries) {
        // ARM is emphatic that a retry BEFORE `Retry-After` elapses is not processed and earns a
        // fresh penalty, so its value wins over our own backoff whenever it is present.
        await this.sleep(this.retryAfterMs(response) ?? this.backoff(attempt))
        continue
      }
      throw error
    }

    throw lastError
  }

  /**
   * Walk `nextLink` to the end, collecting `value[]`.
   *
   * ARM's continuation is an absolute URL that already carries its own `api-version` and
   * continuation token, so it is fetched as-is rather than rebuilt.
   */
  async collect<T>(path: string, apiVersion: string): Promise<T[]> {
    const out: T[] = []
    let page = await this.call<{ value?: T[]; nextLink?: string }>('GET', path, apiVersion)
    out.push(...(page.value ?? []))

    // A hard stop: a continuation that never terminates should fail loudly rather than spin
    // against a paid API.
    for (let guard = 0; guard < 100; guard++) {
      const next = page.nextLink
      if (!next) return out
      page = await this.callAbsolute<{ value?: T[]; nextLink?: string }>('GET', next)
      out.push(...(page.value ?? []))
    }

    throw new ProviderError('unknown', `azure GET ${path}: pagination did not terminate after 100 pages`)
  }

  /**
   * A `nextLink`, which ARM returns as a complete URL.
   *
   * Reduced to a path so it shares `call`'s token handling, retry and error mapping; the version
   * it already carries is what gets used, so the one passed here is only a fallback for a link
   * that states none.
   */
  private async callAbsolute<T>(method: string, url: string): Promise<T> {
    const path = url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : url
    return await this.call<T>(method, path, API_VERSIONS.resources)
  }

  private async decode<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T
    const text = await response.text()
    return (text ? (JSON.parse(text) as T) : undefined) as T
  }

  private backoff(attempt: number): number {
    return this.retryBaseMs * 2 ** attempt
  }

  /** ARM sends `Retry-After` in seconds on 429 and on some 5xx. Honour it over our own backoff. */
  private retryAfterMs(response: Response): number | undefined {
    const header = Number(response.headers.get('retry-after'))
    return Number.isFinite(header) && header > 0 ? header * 1000 : undefined
  }
}

/* ---------------------------------------------------------------- resource id construction */

/**
 * ARM resource ids, built rather than parsed.
 *
 * Every one of these is a path this provider both PUTs to and stores, so they live in one place:
 * a `providerNativeId` in `listManaged()` and the `id` a NIC references are the same string, and
 * building them twice is how they come to differ by a capital letter.
 */
export function resourceGroupPath(subscriptionId: string, resourceGroup: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`
}

export function resourcePath(
  subscriptionId: string,
  resourceGroup: string,
  type: string,
  name: string,
): string {
  return `${resourceGroupPath(subscriptionId, resourceGroup)}/providers/${type}/${name}`
}
