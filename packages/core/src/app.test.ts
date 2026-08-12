import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type CreatedApp } from './app.js'
import { ensureLocalAdmin } from './auth/admin.js'
import { MemorySecretStore } from './auth/secret-store.js'
import { SESSION_COOKIE } from './auth/sessions.js'
import { configSchema, type Config } from './config/index.js'
import { openTestDatabase, type OpenedDatabase } from './db/client.js'
import { createEventsService, type EventsService } from './services/events.js'

const PASSWORD = 'correct-horse-battery-staple'

let opened: OpenedDatabase
let secrets: MemorySecretStore
let events: EventsService
let created: CreatedApp
let adminId: string

const config: Config = configSchema.parse({})

async function build(overrides: Partial<Parameters<typeof createApp>[0]> = {}): Promise<CreatedApp> {
  return createApp({ db: opened.db, config, secrets, events, ...overrides })
}

beforeEach(async () => {
  opened = openTestDatabase()
  secrets = new MemorySecretStore()
  events = createEventsService()
  const admin = await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  adminId = admin.user.id
  created = await build()
})

afterEach(() => {
  opened.close()
})

const post = (app: CreatedApp['app'], path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })

/** Log in and return the bearer token. */
async function login(app: CreatedApp['app'] = created.app, password = PASSWORD): Promise<string> {
  const res = await post(app, '/api/v1/auth/login', { password })
  expect(res.status).toBe(200)
  return ((await res.json()) as { token: string }).token
}

describe('health', () => {
  it('serves without a session', async () => {
    const res = await created.app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, name: 'rockysurf', authMode: 'local' })
  })

  it('reports which providers are enabled', async () => {
    const withHetzner = configSchema.parse({ providers: { hetzner: { enabled: true, token: 't' } } })
    const app = (await build({ config: withHetzner })).app
    expect(await (await app.request('/health')).json()).toMatchObject({ providers: ['hetzner'] })
  })
})

describe('login', () => {
  it('rejects a wrong password with 401 and issues nothing', async () => {
    const res = await post(created.app, '/api/v1/auth/login', { password: 'wrong' })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Invalid password', code: 'unauthorized' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('accepts the right password and sets an HttpOnly session cookie', async () => {
    const res = await post(created.app, '/api/v1/auth/login', { password: PASSWORD })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { user: { id: string; isAdmin: boolean }; token: string }
    expect(body.user.id).toBe(adminId)
    expect(body.user.isAdmin).toBe(true)
    expect(body.token).toHaveLength(64)

    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    // No TLS configured, so no Secure flag — it would be dropped on http://localhost.
    expect(cookie).not.toContain('Secure')
  })

  it('marks the cookie Secure when core is served over https', async () => {
    const https = configSchema.parse({ server: { publicUrl: 'https://rocky.example.com' } })
    const app = (await build({ config: https })).app
    const res = await post(app, '/api/v1/auth/login', { password: PASSWORD })
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('rejects a malformed body with a field path', async () => {
    const res = await post(created.app, '/api/v1/auth/login', {})
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; issues: { path: string }[] }
    expect(body.code).toBe('bad_request')
    expect(body.issues[0]?.path).toBe('password')
  })

  it('rejects an unknown field rather than ignoring it', async () => {
    const res = await post(created.app, '/api/v1/auth/login', { password: PASSWORD, admin: true })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('admin')
  })

  it('refuses password login when the configured auth mode is not local', async () => {
    const github = configSchema.parse({ auth: { mode: 'github-device' } })
    const app = (await build({ config: github })).app
    const res = await post(app, '/api/v1/auth/login', { password: PASSWORD })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('github-device')
  })
})

describe('authenticated access', () => {
  it('401s an unauthenticated API request', async () => {
    const res = await created.app.request('/api/v1/auth/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'unauthorized' })
  })

  it('401s a bogus token rather than erroring', async () => {
    const res = await created.app.request('/api/v1/auth/me', { headers: { authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  it('authorizes with the bearer token', async () => {
    const token = await login()
    const res = await created.app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { id: adminId, username: 'admin' } })
  })

  it('authorizes with the session cookie', async () => {
    const token = await login()
    const res = await created.app.request('/api/v1/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    })
    expect(res.status).toBe(200)
  })

  it('persists the session across app instances, because it lives in the database', async () => {
    const token = await login()
    // A brand-new app object over the SAME database: a restart of the process, in effect.
    const restarted = await build({ events: createEventsService() })
    const res = await restarted.app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { id: adminId } })
  })
})

describe('logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const token = await login()
    const auth = { authorization: `Bearer ${token}` }

    expect((await created.app.request('/api/v1/auth/me', { headers: auth })).status).toBe(200)

    const out = await post(created.app, '/api/v1/auth/logout', {}, auth)
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=;`)

    expect((await created.app.request('/api/v1/auth/me', { headers: auth })).status).toBe(401)
  })

  it('stays revoked across app instances', async () => {
    const token = await login()
    await post(created.app, '/api/v1/auth/logout', {}, { authorization: `Bearer ${token}` })
    const restarted = await build({ events: createEventsService() })
    const res = await restarted.app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('needs a session of its own — logging out is not an anonymous action', async () => {
    expect((await post(created.app, '/api/v1/auth/logout')).status).toBe(401)
  })
})

describe('SSE /api/v1/events', () => {
  /** Read decoded chunks until `predicate` is satisfied, then give up the reader. */
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    predicate: (seen: string) => boolean,
    budgetMs = 4000,
  ): Promise<string> {
    const decoder = new TextDecoder()
    const deadline = Date.now() + budgetMs
    let seen = ''
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
      if (predicate(seen)) return seen
    }
    throw new Error(`stream never satisfied the predicate. Saw:\n${seen}`)
  }

  it('401s without a session', async () => {
    expect((await created.app.request('/api/v1/events')).status).toBe(401)
  })

  it('opens a stream, greets the client, and delivers a broadcast', async () => {
    const token = await login()
    const res = await created.app.request('/api/v1/events', { headers: { authorization: `Bearer ${token}` } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const greeting = await readUntil(reader, (s) => s.includes('event: connected'))
    expect(greeting).toContain(adminId)

    await events.broadcastToUser(adminId, { type: 'server.updated', id: 'srv-abc' })
    const message = await readUntil(reader, (s) => s.includes('server.updated'))
    expect(message).toContain('srv-abc')

    await reader.cancel()
  })

  it('sends heartbeat comments so a proxy does not idle the stream out', async () => {
    const token = await login()
    const fast = await build({ heartbeatMs: 15, events: createEventsService() })
    const res = await fast.app.request('/api/v1/events', { headers: { authorization: `Bearer ${token}` } })

    const reader = res.body!.getReader()
    const seen = await readUntil(reader, (s) => s.includes(': heartbeat'))
    expect(seen).toContain(': heartbeat')

    await reader.cancel()
  })

  it('does not deliver another user\'s events', async () => {
    const token = await login()
    const res = await created.app.request('/api/v1/events', { headers: { authorization: `Bearer ${token}` } })
    const reader = res.body!.getReader()
    await readUntil(reader, (s) => s.includes('event: connected'))

    await events.broadcastToUser('usr-someone-else', { type: 'not.for.you' })
    await events.broadcastToUser(adminId, { type: 'for.you' })

    const seen = await readUntil(reader, (s) => s.includes('for.you'))
    expect(seen).not.toContain('not.for.you')

    await reader.cancel()
  })

  it('unsubscribes when the client goes away, so streams do not leak', async () => {
    const token = await login()
    expect(events.listenerCount(adminId)).toBe(0)

    const res = await created.app.request('/api/v1/events', { headers: { authorization: `Bearer ${token}` } })
    const reader = res.body!.getReader()
    await readUntil(reader, (s) => s.includes('event: connected'))
    expect(events.listenerCount(adminId)).toBe(1)

    await reader.cancel()
    // The abort handler runs a tick or two after cancel resolves.
    for (let i = 0; i < 50 && events.listenerCount(adminId) > 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(events.listenerCount(adminId)).toBe(0)
    expect(events.totalListeners).toBe(0)
  })
})

describe('serving the SPA', () => {
  it('explains what is missing at the root when no bundle is configured', async () => {
    // The 4d stub has been replaced by real serving (rockysurf-hzi7.6). With no `publicDir`
    // there is nothing to serve, and saying so beats a bare 404 for someone running core
    // from a checkout that has never built the web package. The serving path itself is
    // covered in spa-serving.test.ts.
    const res = await created.app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('no web bundle is configured')
  })
})
