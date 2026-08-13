import { isProviderError, PROVIDER_ERROR_CODES } from '@rockysurf/provider-sdk'
import { describe, expect, it } from 'vitest'
import { API_VERSIONS, ArmApi, resourcePath } from './api.js'
import { CredentialChain } from './credentials.js'
import { armErrorCode, RETRY_ANYWAY, toProviderError } from './errors.js'

/**
 * The ARM client and the error mapping.
 *
 * The retry behaviour is the point of most of this: ARM is emphatic that a retry sent before
 * `Retry-After` elapses is not processed and earns a fresh penalty, so getting the backoff wrong
 * is worse than not retrying at all.
 */

const SUB = '00000000-0000-0000-0000-000000000000'

function apiWith(responses: (() => Response)[], options: { maxRetries?: number } = {}) {
  const slept: number[] = []
  let index = 0
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input)
    if (url.includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3599 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const next = responses[Math.min(index, responses.length - 1)]!
    index++
    return next()
  }

  const api = new ArmApi({
    credentials: new CredentialChain({
      fetchImpl: impl,
      env: { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' },
      allowAzureCli: false,
    }),
    subscriptionId: SUB,
    fetchImpl: impl,
    maxRetries: options.maxRetries ?? 3,
    retryBaseMs: 100,
    sleep: async (ms) => {
      slept.push(ms)
    },
  })
  return { api, slept, count: () => index }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('ArmApi', () => {
  it('appends the pinned api-version, and does not double it on a nextLink', async () => {
    const urls: string[] = []
    const impl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('login.microsoftonline.com')) {
        return json(200, { access_token: 'tok', expires_in: 3599 })
      }
      urls.push(url)
      return urls.length === 1
        ? json(200, { value: [{ name: 'one' }], nextLink: `${url}&$skipToken=abc` })
        : json(200, { value: [{ name: 'two' }] })
    }
    const api = new ArmApi({
      credentials: new CredentialChain({
        fetchImpl: impl,
        env: { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' },
        allowAzureCli: false,
      }),
      subscriptionId: SUB,
      fetchImpl: impl,
    })

    const all = await api.collect<{ name: string }>(`/subscriptions/${SUB}/resources`, API_VERSIONS.resources)

    expect(all.map((r) => r.name)).toEqual(['one', 'two'])
    // ARM rejects a URL carrying two api-version parameters, and a continuation always has one.
    expect(urls[1]!.match(/api-version=/g)).toHaveLength(1)
  })

  it('honours Retry-After over its own backoff on a 429', async () => {
    const { api, slept } = apiWith([
      () => json(429, { error: { code: 'SubscriptionRequestsThrottled', message: 'slow down' } }, { 'retry-after': '7' }),
      () => json(200, { ok: true }),
    ])

    await api.call('GET', `/subscriptions/${SUB}/resources`, API_VERSIONS.resources)

    // Seven seconds, not our 100ms base: a premature retry is not processed and returns a fresh,
    // longer penalty.
    expect(slept).toEqual([7000])
  })

  it('retries a resource lock, which the nine codes cannot mark retryable', async () => {
    // `AnotherOperationInProgress` maps to `conflict`, and retryability is DERIVED from the code
    // (F2), so the client consults RETRY_ANYWAY directly. It means "wait about two seconds",
    // not "your request contradicts itself".
    expect(RETRY_ANYWAY.has('AnotherOperationInProgress')).toBe(true)

    const { api, count } = apiWith([
      () => json(409, { error: { code: 'AnotherOperationInProgress', message: 'busy' } }),
      () => json(200, { ok: true }),
    ])

    await expect(api.call('POST', `/subscriptions/${SUB}/x`, API_VERSIONS.compute, {})).resolves.toBeDefined()
    expect(count()).toBe(2)
  })

  it('does not retry a request that is simply wrong', async () => {
    const { api, count } = apiWith([() => json(400, { error: { code: 'InvalidParameter', message: 'bad size' } })])

    await expect(api.call('PUT', `/subscriptions/${SUB}/x`, API_VERSIONS.compute, {})).rejects.toMatchObject({
      code: 'invalid_spec',
    })
    expect(count()).toBe(1)
  })

  it('re-acquires the token once on a 401 and retries', async () => {
    const { api, count } = apiWith([
      () => json(401, { error: { code: 'ExpiredAuthenticationToken', message: 'expired' } }),
      () => json(200, { ok: true }),
    ])

    await expect(api.call('GET', `/subscriptions/${SUB}/x`, API_VERSIONS.compute)).resolves.toBeDefined()
    expect(count()).toBe(2)
  })

  it('reports a second 401 as auth rather than looping', async () => {
    const { api } = apiWith([() => json(401, { error: { code: 'AuthorizationFailed', message: 'no' } })])

    await expect(api.call('GET', `/subscriptions/${SUB}/x`, API_VERSIONS.compute)).rejects.toMatchObject({
      code: 'auth',
    })
  })

  it('wraps a transport failure as a retryable network error, never a raw fetch rejection', async () => {
    const impl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('login.microsoftonline.com')) return json(200, { access_token: 'tok', expires_in: 3599 })
      throw new TypeError('socket hang up')
    }
    const api = new ArmApi({
      credentials: new CredentialChain({
        fetchImpl: impl,
        env: { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' },
        allowAzureCli: false,
      }),
      subscriptionId: SUB,
      fetchImpl: impl,
      maxRetries: 0,
    })

    const error = await api.call('GET', `/subscriptions/${SUB}/x`, API_VERSIONS.compute).catch((e: unknown) => e)
    // Core branches on the nine codes and has no vocabulary for a TypeError.
    expect(isProviderError(error) && error.code).toBe('network')
    expect(isProviderError(error) && error.retryable).toBe(true)
  })
})

describe('resource paths', () => {
  it('builds one id shape, so a NIC reference and an audit row are the same string', () => {
    expect(resourcePath(SUB, 'rg', 'Microsoft.Network/publicIPAddresses', 'box-ip')).toBe(
      `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/box-ip`,
    )
  })
})

describe('error mapping', () => {
  it('prefers the NESTED code, which is where the useful one lives', () => {
    // ARM reports a generic wrapper at the top and the real reason one level down for anything
    // that went through a validation path.
    expect(
      armErrorCode({
        error: {
          code: 'InvalidTemplateDeployment',
          message: 'deployment failed',
          details: [{ code: 'QuotaExceeded', message: 'no vCPUs left' }],
        },
      }),
    ).toBe('QuotaExceeded')
  })

  it('maps every code it knows onto one of the nine, keeping Azure’s own verbatim', () => {
    const cases: [string, string][] = [
      ['AuthorizationFailed', 'auth'],
      ['OperationNotAllowed', 'quota'],
      ['AllocationFailed', 'capacity'],
      ['SkuNotAvailable', 'capacity'],
      ['ResourceNotFound', 'not_found'],
      ['AnotherOperationInProgress', 'conflict'],
      ['SubscriptionRequestsThrottled', 'rate_limited'],
      ['InvalidParameter', 'invalid_spec'],
      ['InternalServerError', 'unknown'],
    ]
    for (const [azure, expected] of cases) {
      const error = toProviderError(azure, 'message', { method: 'GET', path: '/x' })
      expect(error.code, azure).toBe(expected)
      expect(PROVIDER_ERROR_CODES).toContain(error.code)
      // The flattening is lossy, and an operator needs to see what the cloud actually said.
      expect(error.providerCode).toBe(azure)
    }
  })

  it('falls back to the status for a code it has never seen', () => {
    // Coarse, but never wrong in the way a guess at an unknown code's meaning would be.
    expect(toProviderError('SomethingBrandNew', 'm', { method: 'GET', path: '/x', status: 403 }).code).toBe('auth')
    expect(toProviderError(undefined, 'm', { method: 'GET', path: '/x', status: 404 }).code).toBe('not_found')
    expect(toProviderError(undefined, 'm', { method: 'GET', path: '/x', status: 503 }).code).toBe('unknown')
  })
})
