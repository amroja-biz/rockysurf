import { assertProviderErrorShape } from '@rockysurf/provider-conformance'
import { isProviderError, ProviderError } from '@rockysurf/provider-sdk'
import { describe, expect, it } from 'vitest'
import { GceApi, lastSegment } from './api.js'
import { makeAdcTokenSource, type TokenSource } from './auth.js'
import { isAlreadyExists, isNotFound, toProviderError } from './errors.js'
import type { GceOperation } from './types.js'

/**
 * The transport layer, driven entirely through an injected `fetch` and an injected token
 * source. Nothing here performs I/O or needs a Google Cloud credential, which is the property
 * that lets this package be built and verified without an account.
 */

const PROJECT = 'demo-project'

const tokenSource: TokenSource = { getAccessToken: async () => 'test-token' }

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/** A scripted `fetch`: each entry answers one call, and the last entry repeats forever. */
function scriptedFetch(replies: Reply[]) {
  const calls: { url: string; method: string; body: unknown; authorization: string | null }[] = []

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const index = Math.min(calls.length, replies.length - 1)
    const reply = replies[index] ?? {}
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get('authorization'),
    })

    const status = reply.status ?? 200
    // `null`, not `''`: the Response constructor refuses a body on a null-body status (204).
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status,
      headers: reply.headers ?? {},
    })
  }) as unknown as typeof fetch

  return { impl, calls }
}

function api(replies: Reply[], overrides: Partial<ConstructorParameters<typeof GceApi>[0]> = {}) {
  const { impl, calls } = scriptedFetch(replies)
  const client = new GceApi({
    projectId: PROJECT,
    tokenSource,
    fetchImpl: impl,
    // Retries and operation polling are real behaviour and are exercised below; the WAITING is
    // not, so the delays are zeroed rather than the counts.
    sleep: async () => {},
    operationPollMs: 0,
    ...overrides,
  })
  return { client, calls }
}

const httpError = (reason: string, message = 'nope') => ({ error: { errors: [{ reason, message }], message } })

describe('error mapping', () => {
  it.each([
    ['unauthorized', 401, 'auth'],
    ['forbidden', 403, 'auth'],
    ['accessNotConfigured', 403, 'auth'],
    ['notFound', 404, 'not_found'],
    ['alreadyExists', 409, 'conflict'],
    ['resourceNotReady', 400, 'conflict'],
    ['quotaExceeded', 403, 'quota'],
    ['rateLimitExceeded', 429, 'rate_limited'],
    ['invalid', 400, 'invalid_spec'],
    ['backendError', 503, 'unknown'],
  ])('maps the HTTP reason %s onto %s', async (reason, status, expected) => {
    const { client } = api([{ status, body: httpError(reason) }], { maxRetries: 0 })
    const err = await client.call('GET', '/anything').catch((e: unknown) => e)

    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe(expected)
    // The cloud's own word survives the flattening (ADR-0003, F1).
    expect(isProviderError(err) && err.providerCode).toBe(reason)
  })

  it.each([
    ['ZONE_RESOURCE_POOL_EXHAUSTED', 'capacity'],
    ['QUOTA_EXCEEDED', 'quota'],
    ['RESOURCE_ALREADY_EXISTS', 'conflict'],
    ['RESOURCE_NOT_FOUND', 'not_found'],
    ['INTERNAL_ERROR', 'unknown'],
  ])('maps the operation code %s onto %s', (code, expected) => {
    // Operation failures speak a different vocabulary from HTTP errors, and land in the same
    // nine codes. A provider that only mapped the HTTP shape would report a failed create as
    // a successful one, because the insert itself answered 200.
    const err = toProviderError({ code }, 'boom', { method: 'operation', path: 'insert' })
    expect(err.code).toBe(expected)
    expect(err.providerCode).toBe(code)
  })

  it('falls back to the HTTP status when the reason is one it has never seen', async () => {
    const { client } = api([{ status: 403, body: httpError('someBrandNewReason') }], { maxRetries: 0 })
    const err = await client.call('GET', '/anything').catch((e: unknown) => e)
    expect(isProviderError(err) && err.code).toBe('auth')
    expect(isProviderError(err) && err.providerCode).toBe('someBrandNewReason')
  })

  it('reports a body-less failure rather than throwing while parsing it', async () => {
    const { client } = api([{ status: 500, body: undefined }], { maxRetries: 0 })
    const err = await client.call('GET', '/anything').catch((e: unknown) => e)
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('unknown')
  })

  it('maps a fetch rejection to network rather than letting it escape raw', async () => {
    const failing = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const client = new GceApi({ projectId: PROJECT, tokenSource, fetchImpl: failing, sleep: async () => {} })

    const err = await client.call('GET', '/anything').catch((e: unknown) => e)
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('network')
  })

  it('recognises not-found and already-exists, which callers special-case', () => {
    expect(isNotFound(toProviderError({ reason: 'notFound' }, 'x', { method: 'GET', path: '/p' }))).toBe(true)
    expect(isAlreadyExists(toProviderError({ reason: 'alreadyExists' }, 'x', { method: 'POST', path: '/p' }))).toBe(true)
    expect(isAlreadyExists(toProviderError({ code: 'RESOURCE_ALREADY_EXISTS' }, 'x', { method: 'op', path: '/p' }))).toBe(
      true,
    )
    expect(isNotFound(new ProviderError('conflict', 'unrelated'))).toBe(false)
  })
})

describe('requests', () => {
  it('sends the bearer token and the project-scoped path', async () => {
    const { client, calls } = api([{ body: { name: 'us-central1-a' } }])
    await client.call('GET', `${client.projectPath}/zones/us-central1-a`)

    expect(calls[0]?.authorization).toBe('Bearer test-token')
    expect(calls[0]?.url).toBe('https://compute.googleapis.com/compute/v1/projects/demo-project/zones/us-central1-a')
  })

  it('decodes an empty 204 body without failing to parse it', async () => {
    const { client } = api([{ status: 204 }])
    await expect(client.call('DELETE', '/thing')).resolves.toBeUndefined()
  })
})

describe('retries', () => {
  it('retries a rate limit and then succeeds', async () => {
    const { client, calls } = api([
      { status: 429, body: httpError('rateLimitExceeded') },
      { status: 200, body: { ok: true } },
    ])
    await expect(client.call('GET', '/thing')).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it('retries resourceNotReady, which the taxonomy does not derive as retryable', async () => {
    // `conflict` is not in RETRYABLE_PROVIDER_ERROR_CODES, but GCE's resourceNotReady means
    // "another operation is running on this resource, try again shortly" — the same shape as
    // Hetzner's `locked`, and the reason RETRY_ANYWAY exists.
    const { client, calls } = api([
      { status: 400, body: httpError('resourceNotReady') },
      { status: 200, body: { ok: true } },
    ])
    await expect(client.call('GET', '/thing')).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it('does not retry an auth failure', async () => {
    const { client, calls } = api([{ status: 403, body: httpError('forbidden') }])
    await expect(client.call('GET', '/thing')).rejects.toThrow(ProviderError)
    expect(calls).toHaveLength(1)
  })

  it('gives up after a bounded number of attempts rather than spinning', async () => {
    const { client, calls } = api([{ status: 429, body: httpError('rateLimitExceeded') }], { maxRetries: 2 })
    await expect(client.call('GET', '/thing')).rejects.toThrow(ProviderError)
    expect(calls).toHaveLength(3)
  })
})

describe('operations', () => {
  const pending: GceOperation = { name: 'op-1', status: 'PENDING', zone: 'https://x/zones/us-central1-a' }

  it('polls until DONE and hands back the finished operation', async () => {
    const { client, calls } = api([
      { body: pending },
      { body: { ...pending, status: 'RUNNING' } },
      { body: { ...pending, status: 'DONE', targetId: '42', targetLink: 'https://x/instances/dev-box' } },
    ])

    const done = await client.callAndWait('POST', `${client.projectPath}/zones/us-central1-a/instances`, { name: 'x' })
    expect(done.status).toBe('DONE')
    expect(done.targetId).toBe('42')
    expect(calls).toHaveLength(3)
  })

  it('polls a zonal operation on the zone endpoint', async () => {
    const { client, calls } = api([{ body: pending }, { body: { ...pending, status: 'DONE' } }])
    await client.callAndWait('POST', '/x')
    expect(calls[1]?.url).toContain('/projects/demo-project/zones/us-central1-a/operations/op-1')
  })

  it('polls a global operation on the global endpoint', async () => {
    // Firewall operations are GLOBAL while instance operations are ZONAL — different
    // endpoints and different IAM permissions. Polling the wrong one 404s.
    const global: GceOperation = { name: 'op-fw', status: 'PENDING' }
    const { client, calls } = api([{ body: global }, { body: { ...global, status: 'DONE' } }])
    await client.callAndWait('POST', '/x')
    expect(calls[1]?.url).toContain('/projects/demo-project/global/operations/op-fw')
  })

  it('throws a mapped ProviderError when a DONE operation carries an error', async () => {
    // THE CASE THAT MATTERS. Every request here answered HTTP 200: the insert was accepted and
    // the poll succeeded. Only the body says the launch failed, so a client that read status
    // codes alone would report a box that does not exist as created.
    const { client } = api([
      { body: pending },
      {
        body: {
          ...pending,
          status: 'DONE',
          httpErrorStatusCode: 503,
          error: { errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: 'no capacity in us-central1-a' }] },
        },
      },
    ])

    const err = await client.callAndWait('POST', '/x').catch((e: unknown) => e)
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('capacity')
    expect(isProviderError(err) && err.retryable).toBe(true)
    expect(isProviderError(err) && err.providerCode).toBe('ZONE_RESOURCE_POOL_EXHAUSTED')
    expect(String(err)).toContain('no capacity in us-central1-a')
  })

  it('stops waiting on an operation that never finishes', async () => {
    let now = 0
    const { client } = api([{ body: pending }], {
      operationTimeoutMs: 10,
      sleep: async () => {
        now += 100
      },
    })
    const realNow = Date.now
    Date.now = () => realNow() + now
    try {
      const err = await client.callAndWait('POST', '/x').catch((e: unknown) => e)
      assertProviderErrorShape(err)
      expect(String(err)).toContain('did not reach DONE')
    } finally {
      Date.now = realNow
    }
  })
})

describe('pagination', () => {
  it('follows nextPageToken to the end', async () => {
    const { client, calls } = api([
      { body: { items: [{ id: 1 }], nextPageToken: 'page-2' } },
      { body: { items: [{ id: 2 }] } },
    ])
    await expect(client.collect(`${client.projectPath}/zones/us-central1-a/instances`)).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ])
    expect(calls[1]?.url).toContain('pageToken=page-2')
  })

  it('appends its query correctly to a path that already has one', async () => {
    const { client, calls } = api([{ body: { items: [] } }])
    await client.collect(`${client.projectPath}/zones/us-central1-a/instances?filter=labels.x%3Dy`)
    expect(calls[0]?.url).toContain('?filter=labels.x%3Dy&maxResults=')
  })

  it('fails loudly rather than spinning on a cursor that never terminates', async () => {
    const { client } = api([{ body: { items: [{ id: 1 }], nextPageToken: 'forever' } }])
    await expect(client.collect('/things')).rejects.toThrow(/did not terminate/)
  })
})

describe('self-link handling', () => {
  it('reduces a GCE self-link to the bare name every caller wants', () => {
    expect(lastSegment('https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a')).toBe('us-central1-a')
    expect(lastSegment('https://x/machineTypes/t2a-standard-2')).toBe('t2a-standard-2')
    expect(lastSegment('us-central1-a')).toBe('us-central1-a')
  })
})

describe('the ADC token source', () => {
  it('reports a broken credential as an auth ProviderError, not a raw library error', async () => {
    // Core branches on the nine codes and has no other vocabulary for failure, so the auth
    // library's own error must not cross the boundary. A path that does not exist is the
    // cheapest way to make the chain fail without touching the network.
    const source = makeAdcTokenSource({ keyFile: '/nonexistent/rockysurf-test-key.json' })
    const err = await source.getAccessToken().catch((e: unknown) => e)

    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('auth')
    // The message has to name the three places a credential can come from: this is the error
    // an operator sees when nothing is configured, and it is the only instruction they get.
    expect(String(err)).toContain('GOOGLE_APPLICATION_CREDENTIALS')
    expect(String(err)).toContain('gcloud auth application-default login')
    expect(String(err)).toContain('providers.gcp.keyFile')
  })
})
