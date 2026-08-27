import { ProviderError } from '@rockysurf/provider-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { upsertPack } from '../db/repositories/packs.js'
import { getServer } from '../db/repositories/servers.js'
import { parseInstallPlan, PLAN_VERSION } from '../bootstrap/plan.js'
import type { PackInput } from '../packs/schema.js'
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

  /**
   * A TERMINATED ROW IS STILL READABLE, AND STILL SAYS HOW THE BOX WAS BUILT (issue #125).
   *
   * The report: the servers page lists boxes that have come and gone, and there was no way to
   * click one and see what it was. The route was never the obstacle — `syncObserved` skips the
   * provider call for a terminated row and serves what is stored, and nothing in the repository
   * ever deletes a server — but nothing pinned either fact, so a later "prune terminated rows"
   * or a stricter status filter would take the history with it and no test would notice.
   *
   * What is asserted is the CONFIGURATION, not the status: provider, region, size, offering,
   * architecture, pack, tools, repositories and the two timestamps that bracket the box's life.
   * That list is the answer to "how was this thing configured", which is the question the issue
   * asks and the one a row with a dead machine can still answer.
   */
  it('serves a terminated server as the record of how it was configured', async () => {
    const created = (await (
      await post('/api/v1/servers', { ...CREATE, name: 'gone-box', repositories: [] })
    ).json()) as { serverId: string }
    await post(`/api/v1/servers/${created.serverId}/terminate`)

    const res = await get(`/api/v1/servers/${created.serverId}`)
    // Not a 404, and not filtered out of the list either: the row outlives the machine.
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe('terminated')
    expect(body['terminatedAt']).toEqual(expect.any(String))
    expect(body['createdAt']).toEqual(expect.any(String))

    // The placement and the shape of the machine, which is what "how was it configured" means.
    expect(body['provider']).toBe('fake')
    // Stamped at create from the resolved offering — the column existed and nothing wrote it.
    expect(body['region']).toBe('fake-1')
    expect(body['size']).toBe('small')
    expect(body['offeringId']).toBe('fake-small')
    expect(body['arch']).toBeTruthy()
    expect(body['packId']).toBe('ai-coding-agents')
    expect(body['tools']).toEqual(expect.any(Array))
    expect(body['repositories']).toEqual(expect.any(Array))

    // And it is still the user's own row: another account's terminated server is still a 404,
    // which is the ownership check this feature must not quietly widen.
    const listed = (await (await get('/api/v1/servers')).json()) as Array<{ serverId: string }>
    expect(listed.some((row) => row.serverId === created.serverId)).toBe(true)
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

/**
 * `size` BECOMES OPTIONAL, AND `'custom'` IS DERIVED — issue #24 PR 1 (rockysurf-kh3u).
 *
 * The machine-type picker (packages/web/src/pages/CreateServerPage.tsx) posts `offeringId` and
 * OMITS `size` entirely; core is the one place that turns that into a `'custom'` row, and the
 * literal must never arrive over the wire itself.
 */
describe('size is optional once offeringId names the machine (rockysurf-kh3u)', () => {
  it('creates from offeringId + arch alone, with no size in the body at all', async () => {
    const res = await post('/api/v1/servers', {
      packId: 'ai-coding-agents',
      offeringId: 'fake-medium',
      arch: 'amd64',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['offeringId']).toBe('fake-medium')
    expect(body['arch']).toBe('amd64')
    // Derived, never left null and never the caller's problem to have supplied.
    expect(body['size']).toBe('custom')
  })

  it('creates from offeringId alone (no arch, no size), deriving both', async () => {
    const res = await post('/api/v1/servers', { packId: 'ai-coding-agents', offeringId: 'fake-medium' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['offeringId']).toBe('fake-medium')
    expect(body['arch']).toBe('amd64') // fake-medium's own arch, from the catalogue
    expect(body['size']).toBe('custom')
  })

  it('keeps a caller-supplied size alongside an offeringId, rather than overwriting it', async () => {
    // The column is display sugar; a caller who stated a real size gets to keep it.
    const res = await post('/api/v1/servers', {
      packId: 'ai-coding-agents',
      size: 'large',
      offeringId: 'fake-medium',
      arch: 'amd64',
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as Record<string, unknown>)['size']).toBe('large')
  })

  it('400s naming BOTH fields when neither size nor offeringId is sent', async () => {
    const res = await post('/api/v1/servers', { packId: 'ai-coding-agents' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: { path: string; message: string }[] }
    const paths = (body.issues ?? []).map((i) => i.path)
    expect(paths).toContain('size')
    expect(paths).toContain('offeringId')
  })

  it('never accepts the literal "custom" as a size from the wire', async () => {
    const res = await post('/api/v1/servers', { packId: 'ai-coding-agents', size: 'custom' })
    expect(res.status).toBe(400)
  })

  it('still resolves size-only creates exactly as before (unaffected by the optional field)', async () => {
    const res = await post('/api/v1/servers', CREATE)
    expect(res.status).toBe(201)
    expect(((await res.json()) as Record<string, unknown>)['size']).toBe('small')
  })
})

/**
 * The user's own first-boot script (issue #184, ADR-0011).
 *
 * Asserted at the ROUTE rather than only at the resolver, because the route is where the three
 * decisions that are not the resolver's live: what counts as "no script", what a bare `runAs`
 * means, and how big a script may be. All three are reachable by the CLI and the MCP server as
 * well as by the form, which is exactly why they are here and not in the SPA.
 */
describe('a user script at create time (issue #184)', () => {
  const planFor = (serverId: string) => parseInstallPlan(JSON.parse(getServer(opened.db, serverId)!.installPlan!))

  it('stores the script and renders it as the plan\'s user-script step', async () => {
    const res = await post('/api/v1/servers', { ...CREATE, userScript: 'echo hello\n', userScriptRunAs: 'root' })
    expect(res.status).toBe(201)
    const { serverId } = (await res.json()) as { serverId: string }

    const row = getServer(opened.db, serverId)!
    expect(row.userScript).toBe('echo hello')
    expect(row.userScriptRunAs).toBe('root')

    const step = planFor(serverId).steps.find((s) => s.id === 'user-script')!
    expect(step).toBeDefined()
    expect(step.runAs).toBe('root')
    expect(step.optional).toBe(true)
    expect(step.run.endsWith('echo hello')).toBe(true)
  })

  it('defaults the runner to rocky — the account whose toolchain the pack just built', async () => {
    const { serverId } = (await (await post('/api/v1/servers', { ...CREATE, userScript: 'echo hi' })).json()) as {
      serverId: string
    }
    expect(getServer(opened.db, serverId)!.userScriptRunAs).toBe('rocky')
    expect(planFor(serverId).steps.find((s) => s.id === 'user-script')!.runAs).toBe('rocky')
  })

  it('treats an empty or whitespace-only script as no script at all', async () => {
    for (const userScript of ['', '   \n\t ']) {
      const { serverId } = (await (await post('/api/v1/servers', { ...CREATE, userScript })).json()) as {
        serverId: string
      }
      expect(getServer(opened.db, serverId)!.userScript).toBeNull()
      expect(planFor(serverId).steps.map((s) => s.id)).not.toContain('user-script')
    }
  })

  it('refuses a runAs with nothing to run, rather than creating a box without the script', async () => {
    const res = await post('/api/v1/servers', { ...CREATE, userScriptRunAs: 'root' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: { path: string }[] }
    expect(body.error).toMatch(/userScriptRunAs/)
    expect(body.issues?.[0]?.path).toBe('userScript')
  })

  it('refuses a runAs that names nobody', async () => {
    expect((await post('/api/v1/servers', { ...CREATE, userScript: 'x', userScriptRunAs: 'nobody' })).status).toBe(400)
  })

  it('refuses a script over 16 KiB — the ceiling EC2 puts on user data', async () => {
    expect((await post('/api/v1/servers', { ...CREATE, userScript: 'x'.repeat(16384) })).status).toBe(201)
    expect((await post('/api/v1/servers', { ...CREATE, userScript: 'x'.repeat(16385) })).status).toBe(400)
  })

  it('does not echo the script back on the response — nothing renders it', async () => {
    const res = await post('/api/v1/servers', { ...CREATE, userScript: 'echo hello' })
    const body = (await res.json()) as Record<string, unknown>
    expect('userScript' in body).toBe(false)
    expect(JSON.stringify(body)).not.toContain('echo hello')
  })
})

/**
 * WHAT THE PACK ASKS FOR (issue #189, ADR-0013).
 *
 * Driven through the real `createApp`, not a hand-wired route, because the check only exists if
 * composition supplies the `packInputs` lookup — the exact shape of failure
 * `docs/memories/2026-08-21-whole-boot-wiring-tests.md` describes, and the shape the
 * `loadServerSecrets` hook already failed in once. A pack row is written straight into the
 * database, which is where `app.ts` reads the declaration from (ADR-0004: the table is the cache
 * of `packs/*.yaml`).
 */
describe('a pack that declares inputs', () => {
  const PACK_ID = 'headlong'

  const declare = (inputs: PackInput[]): void => {
    upsertPack(opened.db, {
      id: PACK_ID,
      name: 'Headlong',
      tools: [],
      displayOrder: 1,
      enabled: true,
      requiresRepos: false,
      requiresRdp: false,
      inputs,
    })
  }

  const create = (packInputs?: Record<string, string>) =>
    post('/api/v1/servers', { ...CREATE, packId: PACK_ID, ...(packInputs ? { packInputs } : {}) })

  const planSnapshot = (serverId: string) =>
    parseInstallPlan(JSON.parse(getServer(opened.db, serverId)!.installPlan!))

  beforeEach(() => {
    declare([
      { name: 'HEADLONG_HEADLESS', label: 'Headless install', required: true, secret: false, default: '1' },
      { name: 'HEADLONG_API_KEY', label: 'Headlong API key', required: false, secret: true },
      { name: 'HEADLONG_ENDPOINT', label: 'Endpoint', required: false, secret: false },
    ])
  })

  it('stores the non-secret values on the row and returns them on the detail route', async () => {
    const { serverId } = (await (await create({ HEADLONG_ENDPOINT: 'https://example.test' })).json()) as {
      serverId: string
    }
    // The declared default is applied by core, not by the caller.
    expect(JSON.parse(getServer(opened.db, serverId)!.packInputs!)).toEqual({
      HEADLONG_HEADLESS: '1',
      HEADLONG_ENDPOINT: 'https://example.test',
    })

    const body = (await (await get(`/api/v1/servers/${serverId}`)).json()) as Record<string, unknown>
    expect(body['packInputs']).toEqual({ HEADLONG_HEADLESS: '1', HEADLONG_ENDPOINT: 'https://example.test' })
  })

  it('keeps a secret input off the row and out of every route', async () => {
    const res = await create({ HEADLONG_API_KEY: 'sk-live-do-not-leak' })
    const { serverId } = (await res.json()) as { serverId: string }

    // Not on the detail route...
    expect(JSON.stringify(await (await get(`/api/v1/servers/${serverId}`)).json())).not.toContain('sk-live-do-not-leak')
    // ...not in the list...
    expect(JSON.stringify(await (await get('/api/v1/servers')).json())).not.toContain('sk-live-do-not-leak')
    // ...and not on the row, whose column holds only the non-secret half.
    const row = getServer(opened.db, serverId)!
    expect(row.packInputs).not.toContain('sk-live-do-not-leak')
    expect(JSON.parse(row.packInputs!)).toEqual({ HEADLONG_HEADLESS: '1' })
  })

  it('keeps every value out of the plan snapshot, which is pushed at 0644', async () => {
    const { serverId } = (await (
      await create({ HEADLONG_API_KEY: 'sk-live-do-not-leak', HEADLONG_ENDPOINT: 'https://example.test' })
    ).json()) as { serverId: string }

    // Values travel in `secrets.env` (0600), never in `plan.json` — which is written 0644 and is
    // quoted in failure reports. `PLAN_VERSION` therefore does not move: nothing about the
    // plan's shape changed, and no agent has to understand anything new.
    const plan = planSnapshot(serverId)
    expect(JSON.stringify(plan)).not.toContain('sk-live-do-not-leak')
    expect(JSON.stringify(plan)).not.toContain('https://example.test')
    expect(plan.version).toBe(PLAN_VERSION)
  })

  it('refuses a name the pack does not ask for rather than dropping it', async () => {
    const res = await create({ HEADLONG_HEADLES: '1' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: { path: string }[] }
    expect(body.error).toMatch(/does not ask for "HEADLONG_HEADLES"/)
    expect(body.issues?.[0]?.path).toBe('packInputs.HEADLONG_HEADLES')
  })

  it('refuses a required input with no value and no default, before a machine is launched', async () => {
    declare([{ name: 'HEADLONG_TOKEN', label: 'Headlong token', required: true, secret: false }])
    const before = fake.provisionCalls
    const res = await create()
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/Headlong token is required/)
    // Fail before the money: the provider was never asked for a machine.
    expect(fake.provisionCalls).toBe(before)
  })

  it('refuses an oversized value', async () => {
    expect((await create({ HEADLONG_ENDPOINT: 'x'.repeat(4096) })).status).toBe(201)
    expect((await create({ HEADLONG_ENDPOINT: 'x'.repeat(4097) })).status).toBe(400)
  })

  it('refuses a multi-line value, which secrets.env could not carry', async () => {
    expect((await create({ HEADLONG_ENDPOINT: 'one\ntwo' })).status).toBe(400)
  })

  it('accepts a create for a pack that asks for nothing, and refuses inputs for it', async () => {
    expect((await post('/api/v1/servers', CREATE)).status).toBe(201)
    const res = await post('/api/v1/servers', { ...CREATE, packInputs: { ANYTHING: '1' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/asks for no inputs/)
  })
})

/**
 * THE USER'S OWN ENVIRONMENT (issue #197, ADR-0014).
 *
 * Through the real `createApp` for the same reason the pack-input suite is: the collision check
 * needs composition to supply the `packInputs` lookup, and a check nothing wires is a check that
 * does not exist (`docs/memories/2026-08-21-whole-boot-wiring-tests.md`).
 */
describe('an environment the creator supplied', () => {
  const PACK_ID = 'headlong'

  const declare = (inputs: PackInput[]): void => {
    upsertPack(opened.db, {
      id: PACK_ID,
      name: 'Headlong',
      tools: [],
      displayOrder: 1,
      enabled: true,
      requiresRepos: false,
      requiresRdp: false,
      inputs,
    })
  }

  const create = (
    environment?: Record<string, { value: string; secret?: boolean }>,
    packInputs?: Record<string, string>,
  ) =>
    post('/api/v1/servers', {
      ...CREATE,
      packId: PACK_ID,
      ...(environment ? { environment } : {}),
      ...(packInputs ? { packInputs } : {}),
    })

  beforeEach(() => {
    declare([{ name: 'HEADLONG_HEADLESS', label: 'Headless install', required: false, secret: false }])
  })

  it('stores the plain values on the row and returns them on the detail route', async () => {
    const { serverId } = (await (
      await create({ MY_ENDPOINT: { value: 'https://mine.test' }, MY_FLAG: { value: '1' } })
    ).json()) as { serverId: string }

    expect(JSON.parse(getServer(opened.db, serverId)!.environment!)).toEqual({
      MY_ENDPOINT: 'https://mine.test',
      MY_FLAG: '1',
    })

    const body = (await (await get(`/api/v1/servers/${serverId}`)).json()) as Record<string, unknown>
    expect(body['environment']).toEqual({ MY_ENDPOINT: 'https://mine.test', MY_FLAG: '1' })
    // Kept apart from what the pack asked for, because the page says which is which.
    expect(body['packInputs']).toBeUndefined()
  })

  it('keeps a secret line off the row and out of every route', async () => {
    const { serverId } = (await (
      await create({ MY_TOKEN: { value: 'ghp-do-not-leak', secret: true }, MY_FLAG: { value: '1' } })
    ).json()) as { serverId: string }

    expect(JSON.stringify(await (await get(`/api/v1/servers/${serverId}`)).json())).not.toContain('ghp-do-not-leak')
    expect(JSON.stringify(await (await get('/api/v1/servers')).json())).not.toContain('ghp-do-not-leak')
    const row = getServer(opened.db, serverId)!
    expect(row.environment).not.toContain('ghp-do-not-leak')
    expect(JSON.parse(row.environment!)).toEqual({ MY_FLAG: '1' })
  })

  it('keeps every value out of the plan snapshot, and does not move PLAN_VERSION', async () => {
    const { serverId } = (await (
      await create({
        MY_TOKEN: { value: 'ghp-do-not-leak', secret: true },
        MY_ENDPOINT: { value: 'https://mine.test' },
      })
    ).json()) as { serverId: string }

    const plan = parseInstallPlan(JSON.parse(getServer(opened.db, serverId)!.installPlan!))
    expect(JSON.stringify(plan)).not.toContain('ghp-do-not-leak')
    expect(JSON.stringify(plan)).not.toContain('https://mine.test')
    expect(plan.version).toBe(PLAN_VERSION)
  })

  it('refuses a name the pack already asks for, naming the key', async () => {
    const before = fake.provisionCalls
    const res = await create({ HEADLONG_HEADLESS: { value: '1' } })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: { path: string }[] }
    expect(body.error).toContain('HEADLONG_HEADLESS')
    expect(body.issues?.[0]?.path).toBe('environment.HEADLONG_HEADLESS')
    // Fail before the money, like every other create-time check here.
    expect(fake.provisionCalls).toBe(before)
  })

  it('refuses a name Rocky Surf exports to every step', async () => {
    expect((await create({ GITHUB_TOKEN: { value: 'ghp-x' } })).status).toBe(400)
    expect((await create({ HOME: { value: '/tmp' } })).status).toBe(400)
  })

  it('accepts GIT_AUTHOR_NAME, which the setup preamble never writes (issue #197)', async () => {
    expect((await create({ GIT_AUTHOR_NAME: { value: 'Ada Lovelace' } })).status).toBe(201)
    expect((await create({ GIT_CONFIG_COUNT: { value: '9' } })).status).toBe(400)
  })

  it('refuses an oversized or multi-line value', async () => {
    expect((await create({ MY_KEY: { value: 'x'.repeat(4096) } })).status).toBe(201)
    expect((await create({ MY_KEY: { value: 'x'.repeat(4097) } })).status).toBe(400)
    expect((await create({ MY_KEY: { value: 'one\ntwo' } })).status).toBe(400)
  })

  it('refuses a shape that is not { value, secret }', async () => {
    // A bare string is the shape `packInputs` takes, and sending it here would mean a caller
    // believed a value was secret when nothing said so.
    expect((await post('/api/v1/servers', { ...CREATE, environment: { MY_KEY: 'plain' } })).status).toBe(400)
    expect(
      (await post('/api/v1/servers', { ...CREATE, environment: { MY_KEY: { value: '1', sekret: true } } })).status,
    ).toBe(400)
  })

  it('creates exactly as before when nothing is sent', async () => {
    const { serverId } = (await (await post('/api/v1/servers', { ...CREATE, packId: PACK_ID })).json()) as {
      serverId: string
    }
    expect(getServer(opened.db, serverId)!.environment).toBeNull()
    const body = (await (await get(`/api/v1/servers/${serverId}`)).json()) as Record<string, unknown>
    expect(body['environment']).toBeUndefined()
  })
})
