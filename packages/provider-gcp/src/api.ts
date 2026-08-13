import { ProviderError } from '@rockysurf/provider-sdk'
import type { TokenSource } from './auth.js'
import { RETRY_ANYWAY, toProviderError } from './errors.js'
import type { GceErrorBody, GceOperation } from './types.js'

/**
 * The Compute Engine HTTP client. Plain `fetch`, an injected token source, no vendor SDK on
 * the compute path — see `auth.ts` for why the line is drawn there and not somewhere else.
 *
 * It carries one thing neither the AWS nor the Hetzner client needed: an OPERATION POLLER.
 * Every mutating GCE call returns HTTP 200 with an `Operation` whose `status` is `PENDING`,
 * and the real answer — created, out of stock, over quota, name already taken — arrives on a
 * later `zoneOperations.get`. A client that returned as soon as the insert responded would
 * report a launch that failed as a launch that succeeded, which is the same class of lie the
 * `describe()` grace rule exists to prevent at the other end of the lifecycle.
 */

export const GCE_API_BASE = 'https://compute.googleapis.com/compute/v1'

export interface GceApiOptions {
  projectId: string
  tokenSource: TokenSource
  /** Injected in tests, so no test performs I/O. */
  fetchImpl?: typeof fetch
  baseUrl?: string
  /** Retries for throttling, `resourceNotReady`, and 5xx. 0 disables. */
  maxRetries?: number
  retryBaseMs?: number
  /** Injected in tests so backoff does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>
  /** How long to wait for an asynchronous Operation to reach DONE. */
  operationTimeoutMs?: number
  operationPollMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class GceApi {
  readonly projectId: string
  private readonly tokenSource: TokenSource
  private readonly doFetch: typeof fetch
  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly operationTimeoutMs: number
  private readonly operationPollMs: number

  constructor(options: GceApiOptions) {
    this.projectId = options.projectId
    this.tokenSource = options.tokenSource
    this.doFetch = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl ?? GCE_API_BASE
    this.maxRetries = options.maxRetries ?? 3
    this.retryBaseMs = options.retryBaseMs ?? 500
    this.sleep = options.sleep ?? defaultSleep
    // Five minutes. A GCE instance insert is normally DONE in seconds; a poll still running
    // after five minutes is a fault worth reporting rather than something to keep waiting on.
    this.operationTimeoutMs = options.operationTimeoutMs ?? 300_000
    this.operationPollMs = options.operationPollMs ?? 1000
  }

  /** `/projects/{projectId}` — the prefix every path in this client is relative to. */
  get projectPath(): string {
    return `/projects/${this.projectId}`
  }

  /**
   * One API call, with the error mapping and a bounded retry.
   *
   * Every failure leaves as a `ProviderError`. A provider that lets a raw `fetch` rejection or
   * a JSON body escape has broken the SDK contract.
   */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const token = await this.tokenSource.getAccessToken()

      let response: Response
      try {
        response = await this.doFetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (cause) {
        // No HTTP status at all: the request never got a well-formed answer.
        lastError = new ProviderError('network', `gcp ${method} ${path} failed: ${String(cause)}`, { cause })
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt))
          continue
        }
        throw lastError
      }

      if (response.ok) return await this.decode<T>(response)

      const parsed = (await response.json().catch(() => null)) as GceErrorBody | null
      const detail = parsed?.error?.errors?.[0] ?? {}
      const message = detail.message ?? parsed?.error?.message ?? `HTTP ${response.status}`
      const error = toProviderError(detail, message, { method, path, status: response.status })
      lastError = error

      const providerCode = error.providerCode ?? ''
      if ((error.retryable || RETRY_ANYWAY.has(providerCode)) && attempt < this.maxRetries) {
        await this.sleep(this.retryAfterMs(response) ?? this.backoff(attempt))
        continue
      }
      throw error
    }

    throw lastError
  }

  /**
   * Issue a mutating call and wait for the Operation it returns to reach `DONE`.
   *
   * The returned Operation is the DONE one, so `targetLink`/`targetId` are populated and a
   * caller can learn what was actually created without a second lookup.
   */
  async callAndWait(method: string, path: string, body?: unknown): Promise<GceOperation> {
    const operation = await this.call<GceOperation>(method, path, body)
    return await this.waitForOperation(operation, `${method} ${path}`)
  }

  /**
   * Poll an Operation to `DONE`, then throw if it finished badly.
   *
   * THE FAILURE IS IN THE BODY, NOT IN THE STATUS CODE. A DONE operation carrying
   * `error.errors[]` came back as HTTP 200 on every request involved, so nothing about the
   * transport says anything went wrong. This is the only place that reads it, and it is why
   * every mutating call in this provider goes through here rather than through `call()`.
   */
  async waitForOperation(operation: GceOperation, context: string): Promise<GceOperation> {
    let current = operation
    const deadline = Date.now() + this.operationTimeoutMs

    while (current.status !== 'DONE') {
      if (Date.now() >= deadline) {
        throw new ProviderError(
          'unknown',
          `gcp ${context}: operation ${current.name ?? '(unnamed)'} did not reach DONE within ` +
            `${this.operationTimeoutMs}ms (last status ${current.status ?? 'unknown'})`,
        )
      }

      const path = this.operationPath(current)
      if (!path) {
        throw new ProviderError(
          'unknown',
          `gcp ${context}: operation ${current.name ?? '(unnamed)'} names neither a zone nor a region, ` +
            'so there is no endpoint to poll it on',
        )
      }

      await this.sleep(this.operationPollMs)
      current = await this.call<GceOperation>('GET', path)
    }

    const failure = current.error?.errors?.[0]
    if (failure) {
      const message = failure.message ?? current.httpErrorMessage ?? 'operation failed'
      throw toProviderError(failure, message, {
        method: 'operation',
        path: context,
        status: current.httpErrorStatusCode,
      })
    }

    return current
  }

  /**
   * Walk `nextPageToken` to the end, collecting one keyed array.
   *
   * The hard stop is deliberate: a cursor that never terminates should fail loudly rather than
   * spin against a metered API.
   */
  async collect<T>(path: string, perPage = 500): Promise<T[]> {
    const out: T[] = []
    let pageToken: string | undefined

    for (let guard = 0; guard < 50; guard++) {
      const separator = path.includes('?') ? '&' : '?'
      const query = `${path}${separator}maxResults=${perPage}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      const body = await this.call<{ items?: T[]; nextPageToken?: string }>('GET', query)
      out.push(...(body?.items ?? []))
      if (!body?.nextPageToken) return out
      pageToken = body.nextPageToken
    }

    throw new ProviderError('unknown', `gcp GET ${path}: pagination did not terminate after 50 pages`)
  }

  /**
   * Where to poll an operation, which depends on where it was created.
   *
   * Instance operations are ZONAL and firewall operations are GLOBAL. The distinction is not
   * cosmetic — they are different endpoints and different IAM permissions
   * (`compute.zoneOperations.get` vs `compute.globalOperations.get`), so a role granting only
   * the first makes firewall creation fail at the poll rather than at the insert, which is a
   * confusing way to learn about it. Both are in the published role for this reason.
   */
  private operationPath(operation: GceOperation): string | undefined {
    const name = operation.name
    if (!name) return undefined
    if (operation.zone) return `${this.projectPath}/zones/${lastSegment(operation.zone)}/operations/${name}`
    if (operation.region) return `${this.projectPath}/regions/${lastSegment(operation.region)}/operations/${name}`
    return `${this.projectPath}/global/operations/${name}`
  }

  private async decode<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T
    const text = await response.text()
    return (text ? (JSON.parse(text) as T) : undefined) as T
  }

  private backoff(attempt: number): number {
    return this.retryBaseMs * 2 ** attempt
  }

  /** Google sends `Retry-After` in seconds on 429; honour it over our own backoff. */
  private retryAfterMs(response: Response): number | undefined {
    const header = Number(response.headers.get('retry-after'))
    return Number.isFinite(header) && header > 0 ? header * 1000 : undefined
  }
}

/**
 * The last path segment of a GCE self-link.
 *
 * GCE reports references as full URLs — a zone arrives as
 * `https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a`, and a machine type
 * the same way. Everything this provider does with them wants the bare name, and every one of
 * them is the last segment.
 */
export function lastSegment(url: string): string {
  const trimmed = url.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}
