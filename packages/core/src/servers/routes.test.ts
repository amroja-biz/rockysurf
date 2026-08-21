import { ProviderError } from '@rockysurf/provider-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getServer } from '../db/repositories/servers.js'
import { markBootstrapReady } from '../bootstrap/supervisor.js'
import { makeFakeProvider, type FakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createEventsService, type EventsService } from '../services/events.js'
import { fingerprintPublicKey } from '../ssh/keys.js'

const PASSWORD = 'correct-horse-battery-staple'

let opened: OpenedDatabase
let fake: FakeProvider
let app: ReturnType<typeof createApp>['app']
let events: EventsService
let cookie: string

const config: Config = configSchema.parse({})

async function login(): Promise<string> {
  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

const get = (path: string) => app.request(path, { headers: { cookie } })
const patch = (path: string, body: unknown) =>
  app.request(path, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const CREATE = { size: 'small' as const, spotInstance: false, packId: 'ai-coding-agents' }

async function build(provider: FakeProvider = makeFakeProvider()): Promise<void> {
  fake = provider
  opened = openTestDatabase()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  events = createEventsService()
  app = createApp({
    db: opened.db,
    config,
    secrets,
    events,
    providers: new ProviderRegistry([provider]),
  }).app
  cookie = await login()
}

beforeEach(async () => {
  await build()
})

afterEach(() => {
  opened.close()
})

describe('the routes the SPA already calls', () => {
  it('requires a session', async () => {
    expect((await app.request('/api/v1/servers')).status).toBe(401)
    expect((await app.request('/api/v1/servers', { method: 'POST' })).status).toBe(401)
  })

  it('creates a server and returns the legacy shape', async () => {
    const res = await post('/api/v1/servers', CREATE)
    expect(res.status).toBe(201)

    const body = (await res.json()) as Record<string, unknown>
    // `serverId`, not `id` — the SPA's API client (packages/web/src/lib/api.ts) reads this field.
    expect(body['serverId']).toMatch(/^srv-/)
    expect(body['status']).toBe('provisioning')
    expect(body['name']).toBeTruthy()
    expect(body['tools']).toEqual([])
  })

  it('lists only the caller\'s servers', async () => {
    await post('/api/v1/servers', CREATE)
    const res = await get('/api/v1/servers')
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown[]).toHaveLength(1)
  })

  it('gets one server, and 404s an unknown id', async () => {
    const { serverId } = (await (await post('/api/v1/servers', CREATE)).json()) as { serverId: string }
    expect((await get(`/api/v1/servers/${serverId}`)).status).toBe(200)
    expect((await get('/api/v1/servers/srv-nope')).status).toBe(404)
  })

  it('runs start, stop and terminate', async () => {
    const { serverId } = (await (await post('/api/v1/servers', CREATE)).json()) as { serverId: string }
    await get(`/api/v1/servers/${serverId}`) // syncs the address; the row stays provisioning
    // A GET is no longer enough to make a server runnable, and stop/start refusing a
    // provisioning row is the correct 409: until bootstrap reports ready the box is mid-install
    // and stopping it would interrupt the install rather than pause a working machine.
    await markBootstrapReady(opened.db, events, getServer(opened.db, serverId)!)

    expect((await post(`/api/v1/servers/${serverId}/stop`)).status).toBe(200)
    expect((await post(`/api/v1/servers/${serverId}/start`)).status).toBe(200)

    const terminated = await post(`/api/v1/servers/${serverId}/terminate`)
    expect(terminated.status).toBe(200)
    expect(((await terminated.json()) as { status: string }).status).toBe('terminated')
  })

  /**
   * A RETRIED TERMINATE ANSWERS 200, NOT 409 (rockysurf-nimu).
   *
   * At the route this is the whole bug: an MCP client whose terminate response was lost retries
   * it, and the answer it sees is what it reports to the model. `409 illegal server status
   * transition: terminated → terminated` for a box that is gone makes an agent — which
   * SECURITY.md contracts to report a refusal and stop — announce a failure that did not happen
   * and send a human looking for an instance nobody is billing for.
   *
   * Driven through the route rather than the service because the route is where the answer gets
   * its status code, and the 409 is the artifact the caller acted on.
   */
  it('answers a retried terminate with 200, including one sent while the first is still running', async () => {
    const { serverId } = (await (await post('/api/v1/servers', CREATE)).json()) as { serverId: string }

    const sequential = [
      await post(`/api/v1/servers/${serverId}/terminate`),
      await post(`/api/v1/servers/${serverId}/terminate`),
    ]
    expect(sequential.map((r) => r.status)).toEqual([200, 200])

    // And the overlapping case, on a fresh box with a provider held open mid-terminate — the
    // one the sequential retry above cannot reach. See lifecycle.test.ts for why it is the
    // shape a lost response really has.
    let release!: () => void
    const insideTerminate = new Promise<void>((resolve) => {
      release = resolve
    })
    const realTerminate = fake.terminate.bind(fake)
    vi.spyOn(fake, 'terminate').mockImplementation(async (data) => {
      await insideTerminate
      await realTerminate(data)
    })

    const second = (await (await post('/api/v1/servers', CREATE)).json()) as { serverId: string }
    const inFlight = post(`/api/v1/servers/${second.serverId}/terminate`)
    const retry = post(`/api/v1/servers/${second.serverId}/terminate`)
    release()

    const answers = await Promise.all([inFlight, retry])
    expect(answers.map((r) => r.status)).toEqual([200, 200])
    for (const answer of answers) {
      expect(((await answer.json()) as { status: string }).status).toBe('terminated')
    }
  })

  it('accepts and ignores spotInstance, which the existing client still sends', async () => {
    expect((await post('/api/v1/servers', { ...CREATE, spotInstance: true })).status).toBe(201)
  })

  it('rejects a malformed body with 400', async () => {
    expect((await post('/api/v1/servers', { size: 'enormous' })).status).toBe(400)
  })

  /**
   * A pasted key that isn't one (issue #41 fallout, rockysurf-9fvy.1). Before this fix,
   * `normalizeUserPublicKey` ran after the row was already written, so this was a 500 with an
   * orphaned `requested` row behind it — see `lifecycle.test.ts` for the row-count guard.
   */
  it('maps a malformed sshPublicKey to 400 with a code, not a 500', async () => {
    const res = await post('/api/v1/servers', { ...CREATE, sshPublicKey: 'not a key' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('invalid_public_key')
    expect(body.error).toBeTruthy()
  })

  /**
   * The API surface of issue #41: `suppliedSshKey` is present, with a real fingerprint, only
   * for a server created with a pasted key — and ABSENT (not null) for one created without.
   */
  describe('the supplied key is exposed through the API (issue #41)', () => {
    const USER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKPX6kWxlSdf7GU3Ve1I2dGGrKqdPBkR60OjKmHb9crV laptop'

    it('serves the fingerprint of the key the caller supplied', async () => {
      const created = (await (await post('/api/v1/servers', { ...CREATE, sshPublicKey: USER_KEY })).json()) as {
        serverId: string
      }

      const body = (await (await get(`/api/v1/servers/${created.serverId}`)).json()) as Record<string, unknown>
      expect(body['suppliedSshKey']).toEqual({ fingerprint: fingerprintPublicKey(USER_KEY), comment: 'laptop' })
    })

    it('omits the field entirely for a server created without one', async () => {
      const created = (await (await post('/api/v1/servers', CREATE)).json()) as { serverId: string }

      const body = (await (await get(`/api/v1/servers/${created.serverId}`)).json()) as Record<string, unknown>
      expect('suppliedSshKey' in body).toBe(false)
    })
  })

  /**
   * The console deep link, end to end through the projection (ADR-0003, E16).
   *
   * The interesting half is the absence: a provider with no console must produce a row with no
   * `consoleUrl` at all, because that is what tells the SPA not to render a link. Core has no
   * fallback to fall back to — it does not know what any provider's console looks like.
   */
  it('serves the console URL a provider reported, and no field at all when none was', async () => {
    const bare = (await (await post('/api/v1/servers', CREATE)).json()) as { serverId: string }
    const before = (await (await get(`/api/v1/servers/${bare.serverId}`)).json()) as Record<string, unknown>
    expect(before['consoleUrl']).toBeUndefined()

    const CONSOLE = 'https://console.example.test/projects/1/servers/7/overview'
    const described = fake.describe.bind(fake)
    vi.spyOn(fake, 'describe').mockImplementation(async (data) => ({ ...(await described(data)), consoleUrl: CONSOLE }))

    const after = (await (await get(`/api/v1/servers/${bare.serverId}`)).json()) as Record<string, unknown>
    expect(after['consoleUrl']).toBe(CONSOLE)
  })

  it('exposes provider capabilities so the UI can gate its own buttons', async () => {
    const res = await get('/api/v1/providers')
    expect(res.status).toBe(200)
    const [provider] = (await res.json()) as { id: string; capabilities: { stop: boolean } }[]
    expect(provider?.id).toBe('fake')
    expect(provider?.capabilities.stop).toBe(true)
  })
})

describe('idempotency over HTTP', () => {
  it('replays an Idempotency-Key without provisioning twice', async () => {
    const first = await post('/api/v1/servers', CREATE, { 'idempotency-key': 'req-1' })
    const second = await post('/api/v1/servers', CREATE, { 'idempotency-key': 'req-1' })

    const a = (await first.json()) as { serverId: string }
    const b = (await second.json()) as { serverId: string }
    expect(b.serverId).toBe(a.serverId)
    expect(fake.provisionCalls).toBe(1)
  })
})

describe('error mapping', () => {
  it('maps an unsupported operation to 501, not 400', async () => {
    await build(makeFakeProvider({ capabilities: { stop: false } }))
    const { serverId } = (await (await post('/api/v1/servers', CREATE)).json()) as { serverId: string }
    await get(`/api/v1/servers/${serverId}`)

    const res = await post(`/api/v1/servers/${serverId}/stop`)
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('unsupported_operation')
    expect(body.error).toMatch(/does not support stop/)
  })

  it('maps a state conflict to 409', async () => {
    const { serverId } = (await (await post('/api/v1/servers', CREATE)).json()) as { serverId: string }
    // Still provisioning, so stopping makes no sense.
    const res = await post(`/api/v1/servers/${serverId}/stop`)
    expect(res.status).toBe(409)
  })

  it.each([
    ['capacity', 503],
    ['rate_limited', 429],
    ['quota', 409],
    ['auth', 500],
    ['network', 504],
    ['unknown', 502],
    ['invalid_spec', 400],
  ] as const)('maps ProviderError %s to %i', async (code, status) => {
    fake.failNext('provision', new ProviderError(code, `simulated ${code}`, { providerCode: 'X-1' }))
    const res = await post('/api/v1/servers', CREATE)
    expect(res.status).toBe(status)

    const body = (await res.json()) as { error: string; code: string; providerCode?: string; retryable?: boolean }
    expect(body.code).toBe(code)
    // The envelope keeps `error` for the SPA, and carries what the cloud actually said (F1).
    expect(body.error).toContain(`simulated ${code}`)
    expect(body.providerCode).toBe('X-1')
  })

  it('marks retryable codes as retryable in the body', async () => {
    fake.failNext('provision', new ProviderError('capacity', 'no capacity'))
    const body = (await (await post('/api/v1/servers', CREATE)).json()) as { retryable: boolean }
    expect(body.retryable).toBe(true)
  })
})

describe('the providers endpoint feeds the create page', () => {
  it('returns capabilities AND offerings in one response', async () => {
    const res = await get('/api/v1/providers')
    expect(res.status).toBe(200)

    const [provider] = (await res.json()) as {
      id: string
      capabilities: { stop: boolean; canInjectHostKeys: boolean }
      offerings: { id: string; arch: string; available: boolean; hourly: { amount: number; currency: string; fetchedAt: string } | null }[]
    }[]

    expect(provider?.id).toBe('fake')
    expect(provider?.capabilities.stop).toBe(true)
    // The page resolves a size to a concrete offering before submit, so it needs these.
    expect(provider?.offerings.length).toBeGreaterThan(0)
    expect(provider?.offerings.every((o) => typeof o.arch === 'string')).toBe(true)
  })

  it('reports sold-out offerings rather than hiding them', async () => {
    const res = await get('/api/v1/providers')
    const [provider] = (await res.json()) as { offerings: { id: string; available: boolean }[] }[]
    expect(provider?.offerings.some((o) => !o.available)).toBe(true)
  })

  it('carries the price with its fetchedAt stamp, so the UI can date it', async () => {
    const res = await get('/api/v1/providers')
    const [provider] = (await res.json()) as {
      offerings: { id: string; hourly: { amount: number; currency: string; fetchedAt: string } | null }[]
    }[]
    const priced = provider?.offerings.find((o) => o.hourly !== null)
    expect(priced?.hourly).toMatchObject({
      amount: expect.any(Number),
      currency: expect.any(String),
      fetchedAt: expect.any(String),
    })
  })

  it('does not fail the whole response when one provider cannot list', async () => {
    const broken = makeFakeProvider()
    broken.listOfferings = async () => {
      throw new ProviderError('rate_limited', 'slow down')
    }
    await build(broken)

    const res = await get('/api/v1/providers')
    expect(res.status).toBe(200)
    const [provider] = (await res.json()) as { offerings: unknown[]; offeringsError?: string }[]
    expect(provider?.offerings).toEqual([])
    expect(provider?.offeringsError).toContain('slow down')
  })
})

/**
 * Which cloud a create lands on (rockysurf-va2l).
 *
 * The rule used to end in `registry.ids()[0]`, so on a two-cloud installation the cloud that
 * got the server — and the bill — was decided by the order providers happened to be built in.
 * These cases pin the replacement: explicit wins, one provider needs no saying, and genuine
 * ambiguity is refused rather than guessed.
 */
/**
 * The display fields, editable after create (issue #46).
 *
 * The report was a dashboard of `server-mt0nilwv`s: the auto-minted name is the only word on
 * a card, and it says nothing. Name and description are core-side display facts — the
 * provider identity is the row's `id` — so editing them is one PATCH, no cloud involved.
 */
describe('editing the display fields (issue #46)', () => {
  async function created(): Promise<string> {
    return ((await (await post('/api/v1/servers', CREATE)).json()) as { serverId: string }).serverId
  }

  it('renames and describes, and later clears the description with an empty string', async () => {
    const serverId = await created()

    const edited = await patch(`/api/v1/servers/${serverId}`, {
      name: 'training-box',
      description: 'DeepSeek eval rig',
    })
    expect(edited.status).toBe(200)
    const row = (await edited.json()) as Record<string, unknown>
    expect(row['name']).toBe('training-box')
    expect(row['description']).toBe('DeepSeek eval rig')

    // '' is an instruction — clear it — and the name, omitted, stays put.
    const cleared = (await (await patch(`/api/v1/servers/${serverId}`, { description: '' })).json()) as Record<
      string,
      unknown
    >
    expect(cleared['name']).toBe('training-box')
    expect(cleared['description']).toBeUndefined()

    // The list serves the same edit — one present(), not two truths.
    const listed = (await (await get('/api/v1/servers')).json()) as { name: string }[]
    expect(listed[0]?.name).toBe('training-box')
  })

  it('refuses an empty patch, an empty name, and an unknown server', async () => {
    const serverId = await created()
    expect((await patch(`/api/v1/servers/${serverId}`, {})).status).toBe(400)
    expect((await patch(`/api/v1/servers/${serverId}`, { name: '   ' })).status).toBe(400)
    expect((await patch('/api/v1/servers/srv-nope', { name: 'ghost' })).status).toBe(404)
  })

  it('carries a description given at create straight through to the row', async () => {
    const res = await post('/api/v1/servers', { ...CREATE, description: 'demo for the launch GIF' })
    expect(res.status).toBe(201)
    const { serverId } = (await res.json()) as { serverId: string }
    const row = (await (await get(`/api/v1/servers/${serverId}`)).json()) as Record<string, unknown>
    expect(row['description']).toBe('demo for the launch GIF')
  })
})

/**
 * The list survives a provider that cannot be asked (rockysurf-gg9x).
 *
 * The report: the owner's GCP application-default credentials hit Google's periodic reauth,
 * and GET /servers answered 500 over a list that was mostly healthy AWS and Hetzner rows —
 * "Could not load your servers", with the one message that named the fix (`gcloud auth
 * application-default login`) visible only in the response nobody rendered. An expired
 * credential for one cloud is an ordinary event on a self-hosted laptop, so the read
 * degrades: stored rows, the provider's own message beside the stale ones, verbatim.
 */
describe('a provider whose credentials have expired (rockysurf-gg9x)', () => {
  const REAUTH = new ProviderError(
    'auth',
    'could not obtain Google Cloud credentials. Run `gcloud auth application-default login`.',
  )

  /** One broken cloud, one healthy one, one server on each. */
  async function twoClouds(): Promise<{ broken: FakeProvider; staleId: string; freshId: string }> {
    const a = makeFakeProvider({ id: 'cloud-a' })
    const b = makeFakeProvider({ id: 'cloud-b' })
    opened = openTestDatabase()
    const secrets = new MemorySecretStore()
    await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
    events = createEventsService()
    app = createApp({
      db: opened.db,
      config,
      secrets,
      events,
      providers: new ProviderRegistry([a, b]),
    }).app
    cookie = await login()

    const stale = (await (await post('/api/v1/servers', { ...CREATE, provider: 'cloud-a' })).json()) as { serverId: string }
    const fresh = (await (await post('/api/v1/servers', { ...CREATE, provider: 'cloud-b' })).json()) as { serverId: string }
    vi.spyOn(a, 'describe').mockImplementation(async () => {
      throw REAUTH
    })
    return { broken: a, staleId: stale.serverId, freshId: fresh.serverId }
  }

  it('serves every stored row with the provider message beside the stale ones, not a 500', async () => {
    const { staleId, freshId } = await twoClouds()

    const res = await get('/api/v1/servers')
    expect(res.status).toBe(200)
    const rows = (await res.json()) as { serverId: string; syncError?: string }[]
    expect(rows).toHaveLength(2)
    // The remedy the provider wrote into its message reaches the client verbatim...
    expect(rows.find((r) => r.serverId === staleId)?.syncError).toContain('gcloud auth application-default login')
    // ...and the healthy cloud's row is served as if nothing happened.
    expect(rows.find((r) => r.serverId === freshId)?.syncError).toBeUndefined()
  })

  it('degrades the single-server read the same way, and an unknown id is still a 404', async () => {
    const { staleId } = await twoClouds()

    const res = await get(`/api/v1/servers/${staleId}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { syncError?: string }).syncError).toContain('gcloud auth')
    // Ownership is still a refusal, not a row with an excuse attached.
    expect((await get('/api/v1/servers/srv-nope')).status).toBe(404)
  })
})

describe('choosing the provider on create', () => {
  /** Like `build`, but with an arbitrary number of providers rather than exactly one. */
  async function buildWith(providers: FakeProvider[]): Promise<void> {
    opened = openTestDatabase()
    const secrets = new MemorySecretStore()
    await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
    events = createEventsService()
    app = createApp({
      db: opened.db,
      config,
      secrets,
      events,
      providers: new ProviderRegistry(providers),
    }).app
    cookie = await login()
  }

  const two = () => [makeFakeProvider({ id: 'cloud-a' }), makeFakeProvider({ id: 'cloud-b' })]

  it('uses the only provider there is, without being asked', async () => {
    await buildWith([makeFakeProvider({ id: 'only-cloud' })])
    const res = await post('/api/v1/servers', CREATE)
    expect(res.status).toBe(201)
    expect((await res.json() as Record<string, unknown>)['provider']).toBe('only-cloud')
  })

  it('creates on the provider the caller named', async () => {
    await buildWith(two())
    const res = await post('/api/v1/servers', { ...CREATE, provider: 'cloud-b' })
    expect(res.status).toBe(201)
    expect((await res.json() as Record<string, unknown>)['provider']).toBe('cloud-b')
  })

  it('refuses to guess when several are configured, and names the choices', async () => {
    await buildWith(two())
    const res = await post('/api/v1/servers', CREATE)
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: string }
    // Actionable: the caller is told exactly which ids it may send.
    expect(body.error).toContain('cloud-a')
    expect(body.error).toContain('cloud-b')
    expect(body.error).toContain('provider')
  })

  it('creates nothing when it refuses', async () => {
    await buildWith(two())
    await post('/api/v1/servers', CREATE)
    expect((await (await get('/api/v1/servers')).json()) as unknown[]).toHaveLength(0)
  })

  it('still says "no compute provider is configured" when there is none', async () => {
    await buildWith([])
    const res = await post('/api/v1/servers', CREATE)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('no compute provider is configured')
  })
})
