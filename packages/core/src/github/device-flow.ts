/**
 * GitHub's OAuth **device flow**, which is the whole of what the Connect GitHub button does
 * (rockysurf-7fyf.1).
 *
 * THE PROTOCOL IS TWO POST REQUESTS AND A GET, so it is written out here rather than pulled in:
 * `@octokit/oauth-methods` would be a dependency, a transitive tree and a version to keep, in
 * exchange for about sixty lines. Nothing here needs a library.
 *
 * `fetch` IS INJECTED, and that is what makes the tests offline. Every function takes an
 * optional `fetch` and falls back to the platform one, mirroring how `settings/routes.ts` takes
 * an optional `env` — so the route tests script GitHub's answers with a stub and CI never opens
 * a socket. There is no msw, no nock, and no live GitHub anywhere in this package's suite.
 *
 * NO `client_secret` ANYWHERE. The device flow does not use one — GitHub documents
 * `incorrect_client_credentials` as "client_secret not needed" — which is exactly what lets the
 * client id live in a plaintext config file with no custody story attached. See ADR-0007.
 *
 * WHAT THIS CANNOT DO: revoke. Revoking an OAuth token at GitHub is an authenticated call that
 * needs the client secret this design deliberately does not have, so "disconnect" is local
 * forgetting and the routes say so rather than implying otherwise.
 */

/** Where the flow starts. The operator's browser never talks to these — core polls them. */
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_VIEWER_URL = 'https://api.github.com/user'

/**
 * The scope asked for, and it is broad on purpose.
 *
 * `repo` is the classic OAuth scope that covers private repository CONTENTS; there is no
 * narrower classic scope that does, and classic scopes are all the device flow offers. So a
 * connected account hands Rocky Surf read/write access to every repository it can reach. That
 * trade-off is the price of one click and it was accepted deliberately — the alternative, a
 * per-repository fine-grained PAT, is still offered right below the button, and the web card
 * states the breadth in a sentence before the operator ever reaches GitHub's authorize screen.
 */
export const GITHUB_DEVICE_SCOPE = 'repo'

/**
 * What `slow_down` costs, per the OAuth device-flow RFC: the poll interval goes UP by five
 * seconds and stays up. Exported because the throttle that enforces it lives in `routes.ts`.
 */
export const SLOW_DOWN_INCREMENT_SECONDS = 5

/** The subset of `fetch` this module uses, so a stub need not implement the whole thing. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Every error code GitHub's device endpoints answer with, by name.
 *
 * Named rather than collapsed into "something went wrong" because each one has a different
 * cure, and two of them are cures the operator can apply in ten seconds — the message is the
 * whole value of the failure.
 */
export const DEVICE_FLOW_ERROR_CODES = [
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
  'unsupported_grant_type',
  'incorrect_client_credentials',
  'incorrect_device_code',
  'device_flow_disabled',
] as const

export type DeviceFlowErrorCode = (typeof DEVICE_FLOW_ERROR_CODES)[number]

/**
 * GitHub's codes in operator language.
 *
 * `device_flow_disabled` is the one that earns this table on its own: it is the single most
 * likely setup mistake — an OAuth App exists, the client id is right, and the "Enable Device
 * Flow" checkbox was never ticked — and GitHub's own reply is one word. Rendering that as a
 * generic failure would leave an operator with a working configuration and no idea what to
 * change.
 */
export const DEVICE_FLOW_MESSAGES: Record<DeviceFlowErrorCode, string> = {
  authorization_pending: 'Waiting for you to enter the code on github.com.',
  slow_down: 'GitHub asked for a slower poll. Still waiting for you to enter the code on github.com.',
  expired_token: 'The code expired before it was approved on github.com. Get a new code and try again.',
  access_denied: 'The authorization was declined on github.com. Nothing was connected.',
  unsupported_grant_type:
    'GitHub rejected the device-flow grant type. That is a bug in Rocky Surf rather than a setting ' +
    'you can change — please report it.',
  incorrect_client_credentials:
    'GitHub does not recognise this client ID. Check github.oauth.clientId against your OAuth App. ' +
    'The device flow needs no client secret, so a client ID with anything appended to it is the ' +
    'usual cause.',
  incorrect_device_code:
    'GitHub no longer recognises this device code. Start the connection again to get a new one.',
  device_flow_disabled:
    'This OAuth App does not have the device flow enabled. Open it at github.com/settings/developers, ' +
    'tick "Enable Device Flow" in its settings, and try again.',
}

export function isDeviceFlowErrorCode(code: string): code is DeviceFlowErrorCode {
  return (DEVICE_FLOW_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * A device-flow failure that is not a state of the flow — a refused start, a broken viewer
 * lookup, a network fault. Carries GitHub's own code when there was one, so the route can say
 * which mistake it was.
 */
export class GithubDeviceFlowError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GithubDeviceFlowError'
    this.code = code
  }
}

export interface DeviceCodeGrant {
  /** THE BEARER OF THE PENDING GRANT. Never leaves the server — see `routes.ts`. */
  deviceCode: string
  /** What the operator types on github.com, e.g. `WDJB-MJHT`. */
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
}

/**
 * One poll, as a discriminated union rather than an exception.
 *
 * `pending` is the ordinary answer and is not a failure; `denied` and `expired` are terminal
 * and not crashes either. Only the codes an operator has to fix arrive as `error`, and an
 * unrecognised code is its own case carrying GitHub's own text — a future code must reach the
 * operator as whatever GitHub said, never as house prose that predates it.
 */
export type PollResult =
  | { status: 'connected'; accessToken: string; scopes: readonly string[] }
  | {
      status: 'pending'
      code: 'authorization_pending' | 'slow_down'
      /** True for `slow_down`: the caller must add `SLOW_DOWN_INCREMENT_SECONDS` and keep it. */
      slowDown: boolean
      /** GitHub's own `interval`, when it sent one. Takes precedence over the increment. */
      intervalSeconds?: number
      message: string
    }
  | { status: 'denied'; code: 'access_denied'; message: string }
  | { status: 'expired'; code: 'expired_token'; message: string }
  | { status: 'error'; code: string; message: string }

export interface Viewer {
  login: string
  /** From the `x-oauth-scopes` response header — what the token ACTUALLY carries. */
  scopes: readonly string[]
}

interface GithubJson {
  error?: unknown
  error_description?: unknown
  device_code?: unknown
  user_code?: unknown
  verification_uri?: unknown
  expires_in?: unknown
  interval?: unknown
  access_token?: unknown
  scope?: unknown
  login?: unknown
  message?: unknown
}

const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' }

async function postJson(fetchImpl: FetchLike, url: string, body: Record<string, string>): Promise<GithubJson> {
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
  } catch (err) {
    // A control plane on a machine with no route out is an ordinary state, not a crash.
    throw new GithubDeviceFlowError('network', `Could not reach ${url}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new GithubDeviceFlowError(
      'unreadable_response',
      `GitHub answered ${url} with ${response.status} and a body that is not JSON.`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GithubDeviceFlowError('unreadable_response', `GitHub answered ${url} with an unexpected body.`)
  }
  return parsed as GithubJson
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** GitHub's own words when it sent any, otherwise ours for a code we know. */
function describe(code: string, description: unknown): string {
  if (isDeviceFlowErrorCode(code)) return DEVICE_FLOW_MESSAGES[code]
  return text(description) ?? `GitHub refused the device flow: ${code}.`
}

/**
 * Start a flow: ask GitHub for a code pair.
 *
 * The failure that matters here is `device_flow_disabled`, which this endpoint — not just the
 * token endpoint — answers with when the checkbox is off. It arrives as a thrown
 * `GithubDeviceFlowError` carrying the code, so the route can hand the operator the checkbox to
 * tick instead of a shrug.
 */
export async function requestDeviceCode(args: {
  clientId: string
  scope?: string
  fetch?: FetchLike
}): Promise<DeviceCodeGrant> {
  const fetchImpl = args.fetch ?? (globalThis.fetch as FetchLike)
  const body = await postJson(fetchImpl, GITHUB_DEVICE_CODE_URL, {
    client_id: args.clientId,
    scope: args.scope ?? GITHUB_DEVICE_SCOPE,
  })

  const error = text(body.error)
  if (error) throw new GithubDeviceFlowError(error, describe(error, body.error_description))

  const deviceCode = text(body.device_code)
  const userCode = text(body.user_code)
  const verificationUri = text(body.verification_uri)
  if (!deviceCode || !userCode || !verificationUri) {
    throw new GithubDeviceFlowError(
      'unreadable_response',
      'GitHub did not return a device code. Check github.oauth.clientId names a real OAuth App.',
    )
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresInSeconds: count(body.expires_in, 900),
    // GitHub's documented default when it omits one. Five seconds, not zero, because a missing
    // interval must never be read as "poll as fast as you like".
    intervalSeconds: count(body.interval, 5),
  }
}

/** One poll of the token endpoint. The caller owns the waiting; this makes one request. */
export async function pollForToken(args: {
  clientId: string
  deviceCode: string
  fetch?: FetchLike
}): Promise<PollResult> {
  const fetchImpl = args.fetch ?? (globalThis.fetch as FetchLike)
  const body = await postJson(fetchImpl, GITHUB_ACCESS_TOKEN_URL, {
    client_id: args.clientId,
    device_code: args.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })

  const error = text(body.error)
  if (!error) {
    const accessToken = text(body.access_token)
    if (!accessToken) {
      return {
        status: 'error',
        code: 'unreadable_response',
        message: 'GitHub answered the token endpoint with neither a token nor an error.',
      }
    }
    return { status: 'connected', accessToken, scopes: parseScopes(text(body.scope)) }
  }

  const message = describe(error, body.error_description)
  switch (error) {
    case 'authorization_pending':
      return { status: 'pending', code: 'authorization_pending', slowDown: false, message }
    case 'slow_down':
      return {
        status: 'pending',
        code: 'slow_down',
        slowDown: true,
        ...(typeof body.interval === 'number' ? { intervalSeconds: body.interval } : {}),
        message,
      }
    case 'access_denied':
      return { status: 'denied', code: 'access_denied', message }
    case 'expired_token':
      return { status: 'expired', code: 'expired_token', message }
    default:
      // `unsupported_grant_type`, `incorrect_client_credentials`, `incorrect_device_code`,
      // `device_flow_disabled` — and anything GitHub adds later, carrying its own text.
      return { status: 'error', code: error, message }
  }
}

/** Who the token belongs to, and what it actually carries. */
export async function fetchViewer(args: { token: string; fetch?: FetchLike }): Promise<Viewer> {
  const fetchImpl = args.fetch ?? (globalThis.fetch as FetchLike)
  let response: Response
  try {
    response = await fetchImpl(GITHUB_VIEWER_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${args.token}`,
        'user-agent': 'rockysurf',
      },
    })
  } catch (err) {
    throw new GithubDeviceFlowError('network', `Could not reach ${GITHUB_VIEWER_URL}: ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as GithubJson
  const login = text(body.login)
  if (!response.ok || !login) {
    throw new GithubDeviceFlowError(
      'viewer_lookup_failed',
      text(body.message) ?? `GitHub answered ${response.status} when asked who this token belongs to.`,
    )
  }

  // The header is the token's real grant; the token response's `scope` is what was asked for.
  return { login, scopes: parseScopes(response.headers.get('x-oauth-scopes') ?? undefined) }
}

/** `"repo, read:org"` → `['repo','read:org']`. Empty in, empty out. */
export function parseScopes(raw: string | undefined): readonly string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '')
}
