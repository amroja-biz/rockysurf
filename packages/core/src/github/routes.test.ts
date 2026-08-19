import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type CreatedApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { DEFAULT_SESSION_TTL_MS, issueSession } from '../auth/sessions.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getSetting } from '../db/repositories/settings.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { KEY_BYTES } from '../secrets/crypto.js'
import { createSecretsStore, type SecretsStore } from '../secrets/store.js'
import {
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_VIEWER_URL,
  type FetchLike,
} from './device-flow.js'
import { connectionKey } from './routes.js'

/**
 * The four Connect GitHub routes, driven through the real app (rockysurf-7fyf.1).
 *
 * WHOLE APP, REAL DATABASE, REAL SECRETS STORE, STUBBED GITHUB. The claims worth testing are
 * all about seams — that the device code stays server-side, that the token reaches the
 * encrypted store and no response body, that a flow belongs to the user who started it — and
 * none of them can be asserted against a mocked route handler. GitHub itself is the one thing
 * that is stubbed, through the injected `fetch`, so this suite passes with no network.
 *
 * TIME IS FAKED, NOT WAITED OUT. The poll throttle and the flow expiry are both clock
 * arithmetic, so `vi.useFakeTimers({ toFake: ['Date'] })` moves the clock and the assertions
 * stay synchronous. Only `Date` is faked — nothing here schedules anything.
 */

const PASSWORD = 'correct-horse-battery-staple'
const MASTER_KEY = randomBytes(KEY_BYTES)
const CLIENT_ID = 'Iv1.testclientid0000'
const DEVICE_CODE = 'dc-3b19e2-NEVER-LEAVES-THE-SERVER'
/** The value every response body in this file is scanned for. */
const ACCESS_TOKEN = 'gho_FAKEtokenSHOULDneverLEAK1234567890'

const GRANT = {
  device_code: DEVICE_CODE,
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}

let opened: OpenedDatabase
let store: SecretsStore
let created: CreatedApp
let adminId: string
let token: string
let stub: ReturnType<typeof githubStub>

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

/** GitHub, scripted per endpoint. The last scripted poll answer repeats. */
function githubStub(script: { deviceCode?: unknown; polls?: unknown[]; viewer?: unknown; viewerStatus?: number } = {}) {
  const calls: string[] = []
  let pollIndex = 0
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    if (url === GITHUB_DEVICE_CODE_URL) return json(script.deviceCode ?? GRANT)
    if (url === GITHUB_ACCESS_TOKEN_URL) {
      const answers = script.polls ?? [{ access_token: ACCESS_TOKEN, scope: 'repo' }]
      const answer = answers[Math.min(pollIndex, answers.length - 1)]
      pollIndex += 1
      return json(answer)
    }
    if (url === GITHUB_VIEWER_URL) {
      return json(script.viewer ?? { login: 'octocat' }, {
        status: script.viewerStatus ?? 200,
        headers: { 'x-oauth-scopes': 'repo' },
      })
    }
    throw new Error(`the stub was asked for an endpoint nobody scripted: ${url}`)
  }
  return {
    fetch: fetchImpl,
    calls,
    pollCount: () => pollIndex,
  }
}

/** Build (or rebuild) the app. Called per test so config and script vary case by case. */
async function build(options: { config?: Config; script?: Parameters<typeof githubStub>[0] } = {}): Promise<void> {
  stub = githubStub(options.script)
  const secrets = new MemorySecretStore()
  const admin = await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  adminId = admin.user.id
  created = createApp({
    db: opened.db,
    config: options.config ?? withClientId(),
    secrets,
    secretsStore: store,
    githubFetch: stub.fetch,
  })
  const res = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  token = ((await res.json()) as { token: string }).token
}

const withClientId = (extra: Record<string, unknown> = {}): Config =>
  configSchema.parse({ github: { oauth: { clientId: CLIENT_ID }, ...extra } })

const auth = (t = token) => ({ authorization: `Bearer ${t}` })

const getConnection = (t = token) => created.app.request('/api/v1/github/connection', { headers: auth(t) })
const postConnect = (t = token) =>
  created.app.request('/api/v1/github/connect', { method: 'POST', headers: auth(t) })
const postPoll = (flowId: string, t = token) =>
  created.app.request(`/api/v1/github/connect/${flowId}/poll`, { method: 'POST', headers: auth(t) })
const deleteConnection = (t = token) =>
  created.app.request('/api/v1/github/connection', { method: 'DELETE', headers: auth(t) })

interface StartBody {
  flowId: string
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
}

async function start(): Promise<StartBody> {
  const res = await postConnect()
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as StartBody
}

/** Past the server-side throttle, so the next poll really reaches the stub. */
const waitOutInterval = (seconds = 6) => vi.advanceTimersByTime(seconds * 1000)

const githubTokenRefs = (ownerId: string) => store.listSecretRefs({ kind: 'github-token', ownerId })

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  opened = openTestDatabase()
  store = createSecretsStore(opened.db, MASTER_KEY)
  await build()
})

afterEach(() => {
  vi.useRealTimers()
  opened.close()
})

/* ------------------------------------------------------------------- GET /connection */

describe('GET /api/v1/github/connection', () => {
  it('reports an unconfigured installation without pretending it is broken', async () => {
    await build({ config: configSchema.parse({}) })

    const res = await getConnection()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      clientIdConfigured: false,
      connected: false,
      configFallbackSet: false,
    })
  })

  it('reports the client id and the config fallback separately', async () => {
    await build({ config: withClientId({ pat: 'ghp_fallbackFromTheConfigFile' }) })

    const body = (await (await getConnection()).json()) as Record<string, unknown>

    expect(body.clientIdConfigured).toBe(true)
    expect(body.configFallbackSet).toBe(true)
    expect(body.connected).toBe(false)
  })

  it('answers "connected" from the secret ref, and names the account once one exists', async () => {
    const { flowId } = await start()
    waitOutInterval()
    expect((await (await postPoll(flowId)).json()) as Record<string, unknown>).toMatchObject({
      status: 'connected',
    })

    const body = (await (await getConnection()).json()) as Record<string, unknown>

    expect(body).toMatchObject({ connected: true, login: 'octocat', scopes: ['repo'] })
    expect(typeof body.connectedAt).toBe('string')
  })
})

/* ------------------------------------------------------------------------- the start */

describe('POST /api/v1/github/connect', () => {
  it('refuses with the config field to fill in when no OAuth App is configured', async () => {
    await build({ config: configSchema.parse({}) })

    const res = await postConnect()

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('github.oauth.clientId')
    expect(stub.calls, 'a start with no client id must not reach GitHub at all').toEqual([])
  })

  it('returns the code pair and keeps the device code on the server', async () => {
    const res = await postConnect()
    const text = await res.clone().text()
    const body = (await res.json()) as StartBody

    expect(res.status).toBe(200)
    expect(body.userCode).toBe('WDJB-MJHT')
    expect(body.verificationUri).toBe('https://github.com/login/device')
    expect(body.expiresInSeconds).toBe(900)
    expect(body.intervalSeconds).toBe(5)
    expect(body.flowId).toBeTruthy()
    // The one that would actually be the leak: whoever holds the device code can redeem the
    // pending grant, so it must never appear in a response body.
    expect(text).not.toContain(DEVICE_CODE)
    expect(body.flowId).not.toBe(DEVICE_CODE)
  })

  it('surfaces device_flow_disabled as itself, because the cure is a checkbox', async () => {
    await build({ script: { deviceCode: { error: 'device_flow_disabled' } } })

    const res = await postConnect()

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; githubCode: string }
    expect(body.githubCode).toBe('device_flow_disabled')
    expect(body.error).toContain('Enable Device Flow')
  })
})

/* -------------------------------------------------------------------------- the poll */

describe('POST /api/v1/github/connect/:flowId/poll', () => {
  it('answers pending without calling GitHub when the interval has not elapsed', async () => {
    const { flowId } = await start()
    const before = stub.pollCount()

    const res = await postPoll(flowId)

    expect(res.status).toBe(200)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ status: 'pending' })
    expect(stub.pollCount(), 'an early poll must be throttled server-side, not forwarded').toBe(before)
  })

  it('walks pending → pending → connected and stores the token in the encrypted store', async () => {
    await build({
      script: { polls: [{ error: 'authorization_pending' }, { error: 'authorization_pending' }, { access_token: ACCESS_TOKEN, scope: 'repo' }] },
    })
    const { flowId } = await start()

    waitOutInterval()
    const first = (await (await postPoll(flowId)).json()) as Record<string, unknown>
    waitOutInterval()
    const second = (await (await postPoll(flowId)).json()) as Record<string, unknown>
    waitOutInterval()
    const third = (await (await postPoll(flowId)).json()) as Record<string, unknown>

    expect(first).toMatchObject({ status: 'pending' })
    expect(second).toMatchObject({ status: 'pending' })
    expect(third).toMatchObject({ status: 'connected', login: 'octocat', scopes: ['repo'] })

    // Asserted through the METADATA listing, never by reading the value back — the same rule
    // the routes themselves follow.
    expect(githubTokenRefs(adminId)).toHaveLength(1)
    const stored = getSetting(opened.db, connectionKey(adminId))
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored!)).toMatchObject({ login: 'octocat', scopes: ['repo'] })
  })

  it('lengthens the interval on slow_down and keeps it lengthened', async () => {
    await build({ script: { polls: [{ error: 'slow_down' }, { error: 'authorization_pending' }] } })
    const { flowId, intervalSeconds } = await start()
    expect(intervalSeconds).toBe(5)

    waitOutInterval()
    const slowed = (await (await postPoll(flowId)).json()) as { intervalSeconds: number; slowDown: boolean }
    expect(slowed).toMatchObject({ status: 'pending', slowDown: true, intervalSeconds: 10 })

    // Six seconds was enough before slow_down and is not enough now: the throttle really moved.
    const before = stub.pollCount()
    waitOutInterval()
    const early = (await (await postPoll(flowId)).json()) as { intervalSeconds: number }
    expect(stub.pollCount()).toBe(before)
    expect(early.intervalSeconds).toBe(10)
  })

  it('refuses a poll from an account that did not start the flow', async () => {
    const { flowId } = await start()
    const stranger = upsertUserByGithubId(opened.db, { githubId: '99', githubUsername: 'stranger' }).id
    const strangerToken = issueSession(opened.db, stranger, DEFAULT_SESSION_TTL_MS).token
    waitOutInterval()

    const res = await postPoll(flowId, strangerToken)

    expect(res.status).toBe(403)
    expect(githubTokenRefs(stranger)).toEqual([])
  })

  it('reports denial and expiry as themselves, and drops the flow', async () => {
    await build({ script: { polls: [{ error: 'access_denied' }] } })
    const { flowId } = await start()
    waitOutInterval()

    const denied = await postPoll(flowId)
    expect((await denied.json()) as Record<string, unknown>).toMatchObject({ status: 'denied' })
    // The flow is gone, so a repeat poll is a 404 rather than a second trip to GitHub.
    waitOutInterval()
    expect((await postPoll(flowId)).status).toBe(404)
    expect(githubTokenRefs(adminId)).toEqual([])
  })

  it('lets a code expire rather than looping against a wall', async () => {
    await build({ script: { polls: [{ error: 'authorization_pending' }] } })
    const { flowId, expiresInSeconds } = await start()

    vi.advanceTimersByTime((expiresInSeconds + 1) * 1000)
    const res = await postPoll(flowId)

    expect(res.status).toBe(404)
    expect(githubTokenRefs(adminId)).toEqual([])
  })

  it('stores the token even when GitHub will not say whose it is', async () => {
    await build({ script: { viewer: { message: 'Bad credentials' }, viewerStatus: 401 } })
    const { flowId } = await start()
    waitOutInterval()

    const body = (await (await postPoll(flowId)).json()) as Record<string, unknown>

    expect(body).toMatchObject({ status: 'connected', login: null, scopes: ['repo'] })
    expect(githubTokenRefs(adminId)).toHaveLength(1)
  })
})

/* ---------------------------------------------------------------- DELETE /connection */

describe('DELETE /api/v1/github/connection', () => {
  it('forgets both rows, says it did not revoke, and is idempotent', async () => {
    const { flowId } = await start()
    waitOutInterval()
    await postPoll(flowId)
    expect(githubTokenRefs(adminId)).toHaveLength(1)

    const first = await deleteConnection()
    const firstBody = (await first.json()) as { removed: boolean; message: string }

    expect(first.status).toBe(200)
    expect(firstBody.removed).toBe(true)
    expect(firstBody.message).toContain('NOT revoked at GitHub')
    expect(firstBody.message).toContain('github.com/settings/applications')
    expect(githubTokenRefs(adminId)).toEqual([])
    expect(getSetting(opened.db, connectionKey(adminId))).toBeUndefined()

    const second = await deleteConnection()
    expect(second.status).toBe(200)
    expect(((await second.json()) as { removed: boolean }).removed).toBe(false)
  })
})

/* ---------------------------------------------------------------------- the custody */

describe('custody', () => {
  /**
   * THE ONE THAT WOULD ACTUALLY CATCH THE LEAK. Every response from every route in a full
   * connect-and-disconnect cycle is scanned for the token string, so a future `login` field
   * that accidentally carried the credential — or a debug echo — fails here rather than in
   * somebody's browser.
   */
  it('never puts the token in any response body', async () => {
    await build({
      script: { polls: [{ error: 'authorization_pending' }, { access_token: ACCESS_TOKEN, scope: 'repo' }] },
    })

    const bodies: string[] = []
    bodies.push(await (await getConnection()).text())
    const startRes = await postConnect()
    const startText = await startRes.clone().text()
    bodies.push(startText)
    const { flowId } = (await startRes.json()) as StartBody
    waitOutInterval()
    bodies.push(await (await postPoll(flowId)).text())
    waitOutInterval()
    bodies.push(await (await postPoll(flowId)).text())
    bodies.push(await (await getConnection()).text())
    bodies.push(await (await deleteConnection()).text())

    expect(bodies).toHaveLength(6)
    for (const body of bodies) {
      expect(body, 'a response body carried the access token').not.toContain(ACCESS_TOKEN)
      expect(body, 'a response body carried the device code').not.toContain(DEVICE_CODE)
    }
  })
})
