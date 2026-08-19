import { describe, expect, it } from 'vitest'
import {
  DEVICE_FLOW_ERROR_CODES,
  fetchViewer,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_DEVICE_SCOPE,
  GITHUB_VIEWER_URL,
  GithubDeviceFlowError,
  parseScopes,
  pollForToken,
  requestDeviceCode,
  type FetchLike,
} from './device-flow.js'

/**
 * The device-flow protocol, against a scripted `fetch` (rockysurf-7fyf.1).
 *
 * NOTHING HERE OPENS A SOCKET. Every call goes through an injected stub, which is the whole
 * reason `fetch` is a parameter — no msw, no nock, no recorded cassettes, and a suite that
 * passes on a machine with no route out. If a test in this file ever needs the network, the
 * production code has grown a call that skipped the seam.
 */

const CLIENT_ID = 'Iv1.testclientid0000'
const DEVICE_CODE = 'dc-3b19e2fake'
const ACCESS_TOKEN = 'gho_FAKEtokenSHOULDneverLEAK1234567890'

interface Call {
  url: string
  init?: RequestInit
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

/** A stub that answers each call from a script and records what it was asked. */
function scripted(...responses: (Response | (() => Response))[]): FetchLike & { calls: Call[] } {
  const calls: Call[] = []
  let index = 0
  const stub = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next === undefined) throw new Error(`the stub was called ${index} times with nothing scripted`)
    // Cloned rather than handed over: a Response body reads once, and the last scripted answer
    // is deliberately reused when a test polls more times than it scripted.
    return typeof next === 'function' ? next() : next.clone()
  }) as FetchLike & { calls: Call[] }
  stub.calls = calls
  return stub
}

const bodyOf = (call: Call): Record<string, string> => JSON.parse(String(call.init?.body)) as Record<string, string>

describe('requestDeviceCode', () => {
  it('asks GitHub for a code pair and returns what the operator needs', async () => {
    const fetch = scripted(
      json({
        device_code: DEVICE_CODE,
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 899,
        interval: 5,
      }),
    )

    const grant = await requestDeviceCode({ clientId: CLIENT_ID, fetch })

    expect(grant).toEqual({
      deviceCode: DEVICE_CODE,
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresInSeconds: 899,
      intervalSeconds: 5,
    })
    expect(fetch.calls[0]!.url).toBe(GITHUB_DEVICE_CODE_URL)
    expect(bodyOf(fetch.calls[0]!)).toEqual({ client_id: CLIENT_ID, scope: GITHUB_DEVICE_SCOPE })
  })

  it('asks for the repo scope, which is the breadth the epic accepted', () => {
    expect(GITHUB_DEVICE_SCOPE).toBe('repo')
  })

  it('sends no client_secret — the device flow does not use one', async () => {
    const fetch = scripted(
      json({ device_code: DEVICE_CODE, user_code: 'AAAA-BBBB', verification_uri: 'https://github.com/login/device' }),
    )
    await requestDeviceCode({ clientId: CLIENT_ID, fetch })
    expect(Object.keys(bodyOf(fetch.calls[0]!))).not.toContain('client_secret')
  })

  it('falls back to safe expiry and interval when GitHub omits them', async () => {
    const fetch = scripted(
      json({ device_code: DEVICE_CODE, user_code: 'AAAA-BBBB', verification_uri: 'https://github.com/login/device' }),
    )
    const grant = await requestDeviceCode({ clientId: CLIENT_ID, fetch })
    // Not zero: a missing interval must never be read as "poll as fast as you like".
    expect(grant.intervalSeconds).toBe(5)
    expect(grant.expiresInSeconds).toBe(900)
  })

  /**
   * THE LIKELIEST SETUP MISTAKE, and the reason this module has a message table at all: the
   * checkbox is off, and GitHub's whole answer is one word.
   */
  it('surfaces device_flow_disabled by name, with the checkbox to tick', async () => {
    const fetch = scripted(json({ error: 'device_flow_disabled' }, { status: 400 }))

    await expect(requestDeviceCode({ clientId: CLIENT_ID, fetch })).rejects.toMatchObject({
      code: 'device_flow_disabled',
    })
    await expect(requestDeviceCode({ clientId: CLIENT_ID, fetch })).rejects.toThrow(/Enable Device Flow/)
  })

  it('names a wrong client id rather than shrugging', async () => {
    const fetch = scripted(json({ error: 'incorrect_client_credentials' }, { status: 401 }))
    await expect(requestDeviceCode({ clientId: 'nope', fetch })).rejects.toThrow(/github\.oauth\.clientId/)
  })

  it('reports an unreachable GitHub as a device-flow error rather than a crash', async () => {
    const fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com')
    }) as FetchLike
    const err = await requestDeviceCode({ clientId: CLIENT_ID, fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GithubDeviceFlowError)
    expect((err as GithubDeviceFlowError).code).toBe('network')
  })

  it('refuses a 200 that carries neither a code nor an error', async () => {
    const fetch = scripted(json({ something: 'else' }))
    await expect(requestDeviceCode({ clientId: CLIENT_ID, fetch })).rejects.toThrow(/did not return a device code/)
  })
})

describe('pollForToken', () => {
  const poll = (fetch: FetchLike) => pollForToken({ clientId: CLIENT_ID, deviceCode: DEVICE_CODE, fetch })

  it('sends the device-code grant to the token endpoint', async () => {
    const fetch = scripted(json({ access_token: ACCESS_TOKEN, scope: 'repo' }))
    await poll(fetch)
    expect(fetch.calls[0]!.url).toBe(GITHUB_ACCESS_TOKEN_URL)
    expect(bodyOf(fetch.calls[0]!)).toEqual({
      client_id: CLIENT_ID,
      device_code: DEVICE_CODE,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
  })

  it('returns the token and the granted scopes on success', async () => {
    const result = await poll(scripted(json({ access_token: ACCESS_TOKEN, scope: 'repo,read:org' })))
    expect(result).toEqual({ status: 'connected', accessToken: ACCESS_TOKEN, scopes: ['repo', 'read:org'] })
  })

  /**
   * ALL EIGHT CODES, BY NAME. The table is the assertion: a code silently collapsing into
   * "something went wrong" is the failure this case exists to catch, so each one is checked for
   * its own status AND for a message that is not shared with its neighbours.
   */
  it('maps every documented error code to its own outcome', async () => {
    const outcomes = await Promise.all(
      DEVICE_FLOW_ERROR_CODES.map(async (code) => [code, await poll(scripted(json({ error: code })))] as const),
    )
    const byCode = Object.fromEntries(outcomes)

    expect(byCode.authorization_pending).toMatchObject({ status: 'pending', slowDown: false })
    expect(byCode.slow_down).toMatchObject({ status: 'pending', slowDown: true })
    expect(byCode.expired_token).toMatchObject({ status: 'expired', code: 'expired_token' })
    expect(byCode.access_denied).toMatchObject({ status: 'denied', code: 'access_denied' })
    expect(byCode.unsupported_grant_type).toMatchObject({ status: 'error', code: 'unsupported_grant_type' })
    expect(byCode.incorrect_client_credentials).toMatchObject({
      status: 'error',
      code: 'incorrect_client_credentials',
    })
    expect(byCode.incorrect_device_code).toMatchObject({ status: 'error', code: 'incorrect_device_code' })
    expect(byCode.device_flow_disabled).toMatchObject({ status: 'error', code: 'device_flow_disabled' })

    const messages = outcomes.map(([, result]) => ('message' in result ? result.message : ''))
    expect(new Set(messages).size, 'two codes share a message, so one of them says nothing').toBe(messages.length)
    expect(byCode.device_flow_disabled).toMatchObject({ message: expect.stringContaining('Enable Device Flow') })
  })

  it('carries GitHub’s own text through for a code it has never heard of', async () => {
    const result = await poll(
      scripted(json({ error: 'some_future_code', error_description: 'GitHub says this exact thing' })),
    )
    expect(result).toEqual({ status: 'error', code: 'some_future_code', message: 'GitHub says this exact thing' })
  })

  it('takes GitHub’s own interval on slow_down when it sends one', async () => {
    const result = await poll(scripted(json({ error: 'slow_down', interval: 10 })))
    expect(result).toMatchObject({ status: 'pending', slowDown: true, intervalSeconds: 10 })
  })

  it('treats a body with neither token nor error as an error rather than a connection', async () => {
    const result = await poll(scripted(json({})))
    expect(result).toMatchObject({ status: 'error' })
  })
})

describe('fetchViewer', () => {
  it('returns the login and the scopes the token actually carries', async () => {
    const fetch = scripted(json({ login: 'octocat' }, { headers: { 'x-oauth-scopes': 'repo, read:org' } }))

    const viewer = await fetchViewer({ token: ACCESS_TOKEN, fetch })

    expect(viewer).toEqual({ login: 'octocat', scopes: ['repo', 'read:org'] })
    expect(fetch.calls[0]!.url).toBe(GITHUB_VIEWER_URL)
    expect((fetch.calls[0]!.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it('throws with GitHub’s message when the token is refused', async () => {
    const fetch = scripted(json({ message: 'Bad credentials' }, { status: 401 }))
    await expect(fetchViewer({ token: 'nope', fetch })).rejects.toThrow(/Bad credentials/)
  })
})

describe('parseScopes', () => {
  it('splits, trims and drops the empties', () => {
    expect(parseScopes('repo, read:org ,')).toEqual(['repo', 'read:org'])
    expect(parseScopes('')).toEqual([])
    expect(parseScopes(undefined)).toEqual([])
  })
})
