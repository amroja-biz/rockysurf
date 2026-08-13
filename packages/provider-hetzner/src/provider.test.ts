import { isProviderError, ProviderError, stillExistsAtProvider, type ProvisionSpec } from '@rockysurf/provider-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  assertDescribeAbsenceGrace,
  assertFactoryShape,
  assertManagedShape,
  assertOfferingsShape,
  assertProviderErrorShape,
  assertProviderShape,
  type AbsenceGraceHarness,
  type DescribeRead,
} from '@rockysurf/provider-conformance'
import { hetznerConfigSchema, type HetznerProviderInput } from './config.js'
import hetznerProviderFactory, {
  asHetznerData,
  hetznerConsoleUrl,
  makeHetznerProvider,
  sshFingerprint,
} from './index.js'
import type { PriceTable } from './prices.js'

/**
 * Unit tests against a mocked `fetch`. Response bodies are transcribed from the official
 * Hetzner OpenAPI description, and the sold-out CAX fixture is a verbatim copy of what the
 * live API returned on 2026-08-11 — the observation that produced amendment B1.
 *
 * Ported from the spike's 46 tests, plus the surface the frozen SDK added: `available`,
 * resource ownership, `terminating`, `validateSpec`, `providerCode`, and the propagation grace.
 */

const TOKEN = 'test-token-not-a-real-credential'
const SERVER_ID = 'srv-9f2c1d3b4a5e'

interface Recorded {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

type RouteResult = { status: number; body?: unknown; headers?: Record<string, string> }

let calls: Recorded[] = []
let routes: { method: string; match: RegExp; handler: (req: Recorded) => RouteResult }[] = []

function on(method: string, match: RegExp, handler: RouteResult | ((req: Recorded) => RouteResult)) {
  routes.unshift({ method, match, handler: typeof handler === 'function' ? handler : () => handler })
}

const fetchImpl: typeof fetch = async (input, init) => {
  const path = String(input).replace('https://api.hetzner.cloud/v1', '')
  const method = init?.method ?? 'GET'
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
  const record: Recorded = { method, path, body }
  calls.push(record)

  const route = routes.find((r) => r.method === method && r.match.test(path))
  if (!route) throw new Error(`unmocked ${method} ${path}`)
  const { status, body: out, headers } = route.handler(record)
  return new Response(out === undefined ? null : JSON.stringify(out), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const build = (overrides: Partial<HetznerProviderInput> = {}) =>
  makeHetznerProvider({
    ...hetznerConfigSchema.parse({ token: TOKEN }),
    fetchImpl,
    maxRetries: 0,
    sleep: async () => {},
    ...overrides,
  })

const hetznerError = (status: number, code: string, message = code): RouteResult => ({
  status,
  body: { error: { code, message, details: null } },
})

const SPEC: ProvisionSpec = {
  serverId: SERVER_ID,
  name: 'dev-box',
  offeringId: 'cpx12',
  arch: 'amd64',
  sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2ULvJn8xU9d1kQK0Yy8sV3z0000000000000000000 core'],
  userData: '#cloud-config\nhostname: dev-box\n',
  tags: { 'managed-by': 'rockysurf', 'server-id': SERVER_ID },
  idempotencyKey: '9f2c1d3b4a5e6f7081920a1b2c3d4e5f',
}

const SSH_KEY = {
  id: 2323,
  name: `${SERVER_ID}-key-0`,
  fingerprint: 'b7:2f:30:a0:2f:6c:58:6c:21:04:58:61:ba:06:3b:2f',
  labels: { 'managed-by': 'rockysurf', 'server-id': SERVER_ID },
}

/**
 * The same key material already in the project under somebody else's key object — the case D2
 * exists for. What makes it foreign is the ABSENCE of this installation's attribution, which is
 * the only signal that distinguishes it from a key this provision minted and then rediscovered
 * (rockysurf-rkh3); a fixture labelled `server-id=<this server>` is by construction ours.
 */
const FOREIGN_KEY = { ...SSH_KEY, id: 5151, name: 'laptop', labels: {} }

/** Ours by `managed-by`, but minted for a different server: still not this provision's to reap. */
const OTHER_SERVERS_KEY = {
  ...SSH_KEY,
  id: 6161,
  name: 'srv-000000000000-key-0',
  labels: { 'managed-by': 'rockysurf', 'server-id': 'srv-000000000000' },
}

const server = (over: Record<string, unknown> = {}) => ({
  id: 42,
  name: SERVER_ID,
  status: 'running',
  created: '2026-08-11T23:55:00Z',
  public_net: {
    ipv4: { id: 1, ip: '49.13.94.234', dns_ptr: 'static.234.94.13.49.clients.your-server.de' },
    ipv6: null,
  },
  server_type: { name: 'cpx12' },
  labels: { 'managed-by': 'rockysurf', 'server-id': SERVER_ID },
  ...over,
})

const serverType = (over: Record<string, unknown> = {}) => ({
  id: 45,
  name: 'cpx12',
  cores: 1,
  memory: 2,
  disk: 40,
  deprecated: false,
  architecture: 'x86',
  prices: [{ location: 'fsn1', price_hourly: { net: '0.0216', gross: '0.0257' } }],
  locations: [{ id: 1, name: 'fsn1', available: true, recommended: true, deprecation: null }],
  ...over,
})

/** Verbatim shape of the real cax11 payload on 2026-08-11: priced everywhere, sellable nowhere. */
const SOLD_OUT_CAX = serverType({
  id: 45,
  name: 'cax11',
  cores: 2,
  memory: 4,
  disk: 40,
  architecture: 'arm',
  prices: [
    { location: 'fsn1', price_hourly: { net: '0.0052', gross: '0.0062' } },
    { location: 'hel1', price_hourly: { net: '0.0052', gross: '0.0062' } },
    { location: 'nbg1', price_hourly: { net: '0.0052', gross: '0.0062' } },
  ],
  locations: [
    { id: 1, name: 'fsn1', available: false, recommended: false, deprecation: null },
    { id: 2, name: 'nbg1', available: false, recommended: false, deprecation: null },
    { id: 3, name: 'hel1', available: false, recommended: false, deprecation: null },
  ],
})

const page = (key: string, items: unknown[], nextPage: number | null = null) => ({
  [key]: items,
  meta: { pagination: { page: 1, per_page: 50, next_page: nextPage, last_page: 1, total_entries: items.length } },
})

const PRICES: PriceTable = {
  fetchedAt: '2026-08-11T00:00:00.000Z',
  currency: 'EUR',
  hourly: { cpx12: { fsn1: 0.0079 } },
}

beforeEach(() => {
  calls = []
  routes = []
})

async function errorFrom(fn: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await fn()
  } catch (err) {
    if (isProviderError(err)) return err
    throw err
  }
  throw new Error('expected a ProviderError, but nothing was thrown')
}

/* ------------------------------------------------------------------ factory & conformance */

describe('factory and config schema', () => {
  it('satisfies the SDK factory contract', () => {
    assertFactoryShape(hetznerProviderFactory, hetznerConfigSchema.parse({ token: TOKEN }))
  })

  it('createProvider() does no I/O, so core can construct before it has credentials', () => {
    hetznerProviderFactory.createProvider(hetznerConfigSchema.parse({ token: 'unused' }))
    expect(calls).toEqual([])
  })

  it('applies defaults and requires a token', () => {
    expect(hetznerConfigSchema.parse({ token: TOKEN })).toEqual({
      token: TOKEN,
      location: 'fsn1',
      image: 'ubuntu-24.04',
      managedBy: 'rockysurf',
    })
    expect(() => hetznerConfigSchema.parse({})).toThrow()
    expect(() => hetznerConfigSchema.parse({ token: '' })).toThrow()
  })

  it('rejects an unknown key rather than ignoring it', () => {
    expect(() => hetznerConfigSchema.parse({ token: TOKEN, reigon: 'fsn1' })).toThrow()
  })

  it('declares the capabilities the matrix records', () => {
    expect(build().capabilities).toEqual({
      stop: true,
      ipStableAcrossStop: true,
      canInjectHostKeys: true,
      userDataMaxBytes: 32768,
      generatesUserData: true,
    })
    assertProviderShape(build())
  })
})

/* ------------------------------------------------------------------------ credentials */

describe('validateCredentials', () => {
  it('resolves when the token works and the location exists', async () => {
    on('GET', /^\/servers/, { status: 200, body: page('servers', []) })
    on('GET', /^\/locations\//, { status: 200, body: { location: { name: 'fsn1' } } })
    await expect(build().validateCredentials()).resolves.toBeUndefined()
    expect(calls.map((c) => c.path)).toEqual(['/servers?per_page=1', '/locations/fsn1'])
  })

  it('maps a rejected token to auth and keeps the native code', async () => {
    on('GET', /^\/servers/, hetznerError(401, 'unauthorized', 'unable to authenticate'))
    const err = await errorFrom(() => build().validateCredentials())
    expect(err.code).toBe('auth')
    expect(err.providerCode).toBe('unauthorized')
    expect(err.retryable).toBe(false)
    expect(err.message).not.toContain(TOKEN)
  })

  it('reports an unknown location as invalid_spec, not not_found', async () => {
    on('GET', /^\/servers/, { status: 200, body: page('servers', []) })
    on('GET', /^\/locations\//, hetznerError(404, 'not_found'))
    const err = await errorFrom(() => build({ location: 'nope' }).validateCredentials())
    expect(err.code).toBe('invalid_spec')
    expect(err.message).toContain('nope')
  })
})

/* ------------------------------------------------------------------------ validateSpec */

describe('validateSpec', () => {
  it('accepts a good spec without touching the network', async () => {
    await expect(build().validateSpec(SPEC)).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('refuses a serverId that is not hostname-safe', async () => {
    // The name IS the dedupe mechanism here, and sanitizing is not injective: srv_a and srv-a
    // would both become srv-a, two logical servers over one cloud resource.
    const err = await errorFrom(() => build().validateSpec({ ...SPEC, serverId: 'srv_9f2c' }))
    expect(err.code).toBe('invalid_spec')
    expect(err.message).toContain('hostname-safe')
  })

  it('refuses a spec whose managed-by disagrees with this provider (D3)', async () => {
    const err = await errorFrom(() =>
      build().validateSpec({ ...SPEC, tags: { ...SPEC.tags, 'managed-by': 'someone-else' } }),
    )
    expect(err.code).toBe('invalid_spec')
    expect(err.message).toContain('someone-else')
    expect(err.message).toContain('orphan')
  })

  it('refuses a spec with no managed-by tag at all', async () => {
    const err = await errorFrom(() => build().validateSpec({ ...SPEC, tags: { 'server-id': SERVER_ID } }))
    expect(err.code).toBe('invalid_spec')
  })

  it('refuses an empty key list', async () => {
    const err = await errorFrom(() => build().validateSpec({ ...SPEC, sshPublicKeys: [] }))
    expect(err.code).toBe('invalid_spec')
  })

  it('enforces the user-data ceiling before anything is created (A7)', async () => {
    await expect(build().validateSpec({ ...SPEC, userData: 'x'.repeat(32_768) })).resolves.toBeUndefined()
    const err = await errorFrom(() => build().validateSpec({ ...SPEC, userData: 'x'.repeat(32_769) }))
    expect(err.code).toBe('invalid_spec')
    expect(err.message).toContain('32768')
  })
})

/* -------------------------------------------------------------------------- offerings */

describe('listOfferings', () => {
  const withTypes = (types: unknown[], nextPage: number | null = null) => {
    let served = 0
    on('GET', /^\/server_types/, () => {
      served++
      return { status: 200, body: page('server_types', served === 1 ? types : [], served === 1 ? nextPage : null) }
    })
  }

  it('maps CAX to arm64 and CX/CPX to amd64', async () => {
    withTypes([serverType(), SOLD_OUT_CAX, serverType({ name: 'ccx13', architecture: 'x86' })])
    const offerings = await build().listOfferings()
    expect(offerings.map((o) => [o.id, o.arch])).toEqual([
      ['cpx12', 'amd64'],
      ['cax11', 'arm64'],
      ['ccx13', 'amd64'],
    ])
    assertOfferingsShape(offerings)
  })

  it('REPORTS sold-out types with available:false instead of hiding them (B1)', async () => {
    // The spike could only express "no ARM stock" by omitting the types, leaving core unable
    // to tell "this cloud has no ARM" from "ARM is sold out this afternoon".
    withTypes([serverType(), SOLD_OUT_CAX])
    const offerings = await build().listOfferings()

    expect(offerings).toHaveLength(2)
    const cax = offerings.find((o) => o.id === 'cax11')
    expect(cax).toMatchObject({ arch: 'arm64', available: false })
    expect(offerings.find((o) => o.id === 'cpx12')?.available).toBe(true)
  })

  it('does not treat a price in the region as an offer', async () => {
    // cax11 is priced in fsn1 and sellable in none of its locations; a price-based filter
    // would have advertised it. Availability lives only in locations[].
    withTypes([SOLD_OUT_CAX])
    expect((await build().listOfferings())[0]?.available).toBe(false)
  })

  it('drops types retired everywhere, and types not sold in this location', async () => {
    withTypes([
      serverType({ name: 'cx11', deprecated: true }),
      serverType({ name: 'ccx13', locations: [{ name: 'ash', available: true }], prices: [] }),
      serverType(),
    ])
    expect((await build().listOfferings()).map((o) => o.id)).toEqual(['cpx12'])
  })

  it('reports hourly null when the bundled table has no entry', async () => {
    withTypes([serverType()])
    expect((await build().listOfferings())[0]?.hourly).toBeNull()
  })

  it('joins the bundled price table, carrying currency and fetchedAt', async () => {
    withTypes([serverType()])
    const offering = (await build({ prices: PRICES }).listOfferings())[0]
    expect(offering?.hourly).toEqual({ amount: 0.0079, currency: 'EUR', fetchedAt: '2026-08-11T00:00:00.000Z' })
    assertOfferingsShape([offering!])
  })

  it('follows pagination to the last page', async () => {
    withTypes([serverType()], 2)
    await build().listOfferings()
    expect(calls.map((c) => c.path).filter((p) => p.startsWith('/server_types'))).toEqual([
      '/server_types?page=1&per_page=50',
      '/server_types?page=2&per_page=50',
    ])
  })

  it('prefers the LIVE inline price over the bundled table (gyp1.3)', async () => {
    // The price is already in the /server_types response this call had to make anyway, so
    // preferring a bundled number would show something staler for no saved request.
    withTypes([serverType()])
    on('GET', /^\/pricing/, { status: 200, body: { pricing: { currency: 'EUR', vat_rate: '19.00' } } })

    const offering = (await build({ prices: PRICES }).listOfferings())[0]
    // 0.0216 is the inline net rate on the fixture; 0.0079 is the bundled one.
    expect(offering?.hourly).toMatchObject({ amount: 0.0216, currency: 'EUR' })
    expect(offering?.hourly?.fetchedAt).not.toBe(PRICES.fetchedAt)
    expect(Date.parse(offering!.hourly!.fetchedAt)).toBeGreaterThan(Date.parse(PRICES.fetchedAt))
  })

  it('uses net, not gross, so the number is comparable between accounts', async () => {
    withTypes([serverType()])
    on('GET', /^\/pricing/, { status: 200, body: { pricing: { currency: 'EUR' } } })
    // The fixture's gross is 0.0257; VAT is a property of the customer, not of the machine.
    expect((await build().listOfferings())[0]?.hourly?.amount).toBe(0.0216)
  })

  it('falls back to the bundled table when a type carries no price for this location', async () => {
    withTypes([serverType({ prices: [{ location: 'ash', price_hourly: { net: '0.03', gross: '0.04' } }] })])
    on('GET', /^\/pricing/, { status: 200, body: { pricing: { currency: 'EUR' } } })

    const offering = (await build({ prices: PRICES }).listOfferings())[0]
    expect(offering?.hourly).toEqual({ amount: 0.0079, currency: 'EUR', fetchedAt: PRICES.fetchedAt })
  })

  it('still lists offerings when /pricing cannot be read, falling back rather than failing', async () => {
    // A read-only token, or a transient failure, must not take the whole catalogue down.
    withTypes([serverType()])
    on('GET', /^\/pricing/, hetznerError(403, 'forbidden'))

    const offerings = await build({ prices: PRICES }).listOfferings()
    expect(offerings).toHaveLength(1)
    expect(offerings[0]?.hourly).toEqual({ amount: 0.0079, currency: 'EUR', fetchedAt: PRICES.fetchedAt })
  })

  it('reports null when neither live nor bundled has a price', async () => {
    withTypes([serverType({ prices: [] })])
    on('GET', /^\/pricing/, { status: 200, body: { pricing: { currency: 'EUR' } } })
    expect((await build().listOfferings())[0]?.hourly).toBeNull()
  })
})

/* ------------------------------------------------------------------------- provision */

describe('provision', () => {
  function happyPath() {
    on('GET', /^\/ssh_keys\?fingerprint=/, { status: 200, body: { ssh_keys: [] } })
    on('POST', /^\/ssh_keys$/, { status: 201, body: { ssh_key: SSH_KEY } })
    on('POST', /^\/servers$/, { status: 201, body: { server: server({ status: 'initializing' }) } })
  }

  it('creates the key then the server, using the serverId as the dedupe name', async () => {
    happyPath()
    const { data, initial } = await build().provision(SPEC)

    expect(data).toEqual({ serverId: 42, name: SERVER_ID, ownedSshKeyIds: [2323] })
    expect(initial.state).toBe('pending')

    expect(calls.find((c) => c.method === 'POST' && c.path === '/servers')?.body).toEqual({
      name: SERVER_ID,
      server_type: 'cpx12',
      image: 'ubuntu-24.04',
      location: 'fsn1',
      start_after_create: true,
      ssh_keys: [2323],
      labels: { 'managed-by': 'rockysurf', 'server-id': SERVER_ID },
      user_data: SPEC.userData,
    })
  })

  it('returns an initial InstanceView so core need not immediately describe() (A6)', async () => {
    on('GET', /^\/ssh_keys\?fingerprint=/, { status: 200, body: { ssh_keys: [SSH_KEY] } })
    on('POST', /^\/servers$/, { status: 201, body: { server: server() } })

    const { initial } = await build().provision(SPEC)
    expect(initial).toEqual({
      state: 'running',
      publicIp: '49.13.94.234',
      publicDns: 'static.234.94.13.49.clients.your-server.de',
      offeringId: 'cpx12',
    })
  })

  it('reuses a key matched by fingerprint and does NOT claim ownership of it (D2)', async () => {
    on('GET', /^\/ssh_keys\?fingerprint=/, { status: 200, body: { ssh_keys: [FOREIGN_KEY] } })
    on('POST', /^\/servers$/, { status: 201, body: { server: server() } })

    const { data } = await build().provision(SPEC)
    // Reaping a key that already existed would break whoever else references it.
    expect(data['ownedSshKeyIds']).toEqual([])
    expect(calls.some((c) => c.method === 'POST' && c.path === '/ssh_keys')).toBe(false)
  })

  it('does not claim a key another server minted, even under the same installation', async () => {
    on('GET', /^\/ssh_keys\?fingerprint=/, { status: 200, body: { ssh_keys: [OTHER_SERVERS_KEY] } })
    on('POST', /^\/servers$/, { status: 201, body: { server: server() } })

    const { data } = await build().provision(SPEC)
    expect(data['ownedSshKeyIds']).toEqual([])
  })

  it('claims a key its own create already made but could not report (rockysurf-rkh3)', async () => {
    // What a retried POST looks like from here: the first attempt created the key and its
    // answer was lost, so the retry collides with the key this provision itself minted. Reading
    // that as "not created by me" is what leaked ssh-key 117001639 into four nightly runs.
    let lookups = 0
    on('GET', /^\/ssh_keys\?fingerprint=/, () => {
      lookups++
      return { status: 200, body: { ssh_keys: lookups === 1 ? [] : [SSH_KEY] } }
    })
    on('POST', /^\/ssh_keys$/, hetznerError(409, 'uniqueness_error'))
    on('POST', /^\/servers$/, { status: 201, body: { server: server() } })

    const { data } = await build().provision(SPEC)
    expect(data['ownedSshKeyIds']).toEqual([2323])
  })

  it('dedupes a replay onto the original server, and re-derives what it owns', async () => {
    on('GET', /^\/ssh_keys\?fingerprint=/, { status: 200, body: { ssh_keys: [SSH_KEY] } })
    on('GET', /^\/ssh_keys\?label_selector=/, { status: 200, body: { ssh_keys: [SSH_KEY] } })
    on('GET', /^\/servers\?name=/, { status: 200, body: page('servers', [server()]) })
    on('POST', /^\/servers$/, hetznerError(409, 'uniqueness_error', 'server name is already used'))

    const { data, initial } = await build().provision(SPEC)
    expect(data).toEqual({ serverId: 42, name: SERVER_ID, ownedSshKeyIds: [2323] })
    expect(initial.state).toBe('running')
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/servers')).toHaveLength(1)
  })

  it('rethrows uniqueness_error when the colliding name is not ours to find', async () => {
    on('GET', /^\/ssh_keys\?fingerprint=/, { status: 200, body: { ssh_keys: [SSH_KEY] } })
    on('GET', /^\/servers\?name=/, { status: 200, body: page('servers', []) })
    on('POST', /^\/servers$/, hetznerError(409, 'uniqueness_error'))

    const err = await errorFrom(() => build().provision(SPEC))
    expect(err.code).toBe('conflict')
    expect(err.providerCode).toBe('uniqueness_error')
  })

  it('recovers from a raced key creation', async () => {
    let lookups = 0
    on('GET', /^\/ssh_keys\?fingerprint=/, () => {
      lookups++
      return { status: 200, body: { ssh_keys: lookups === 1 ? [] : [FOREIGN_KEY] } }
    })
    on('POST', /^\/ssh_keys$/, hetznerError(409, 'uniqueness_error'))
    on('POST', /^\/servers$/, { status: 201, body: { server: server() } })

    const { data } = await build().provision(SPEC)
    expect(data['ownedSshKeyIds']).toEqual([]) // someone else got there first → not ours to reap
    expect(lookups).toBe(2)
  })

  it('reaps the keys it minted when the server create fails, rather than stranding them', async () => {
    // The keys exist before the server does, and a `provision()` that throws hands core no
    // handle to reach them with — core marks the row failed and the ids are gone. Nothing else
    // deletes them either: the reconciler reports orphans, it does not reap them (rkh3).
    happyPath()
    on('POST', /^\/servers$/, hetznerError(403, 'forbidden'))
    on('DELETE', /^\/ssh_keys\/2323$/, { status: 204 })

    const err = await errorFrom(() => build().provision(SPEC))
    expect(err.providerCode).toBe('forbidden')
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/ssh_keys/2323')).toBe(true)
  })

  it('leaves a key it does not own alone when the server create fails', async () => {
    on('GET', /^\/ssh_keys\?fingerprint=/, { status: 200, body: { ssh_keys: [FOREIGN_KEY] } })
    on('POST', /^\/servers$/, hetznerError(403, 'forbidden'))

    await errorFrom(() => build().provision(SPEC))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('reports the create failure, not a cleanup failure, when the key will not delete', async () => {
    // The operator needs the reason the server was not created. A key that survives is
    // recoverable — listManaged() reports it — but an error message replaced by the tidy-up's
    // own complaint is not.
    happyPath()
    on('POST', /^\/servers$/, hetznerError(403, 'forbidden'))
    on('DELETE', /^\/ssh_keys\/2323$/, hetznerError(500, 'server_error'))

    const err = await errorFrom(() => build().provision(SPEC))
    expect(err.providerCode).toBe('forbidden')
  })

  it('omits user_data entirely when the spec carries none', async () => {
    happyPath()
    await build().provision({ ...SPEC, userData: '' })
    expect(calls.find((c) => c.method === 'POST' && c.path === '/servers')?.body).not.toHaveProperty('user_data')
  })

  it('surfaces no-stock as capacity, which is retryable', async () => {
    on('GET', /^\/ssh_keys\?fingerprint=/, { status: 200, body: { ssh_keys: [SSH_KEY] } })
    on('POST', /^\/servers$/, hetznerError(412, 'resource_unavailable', 'error during placement'))

    const err = await errorFrom(() => build().provision({ ...SPEC, offeringId: 'cax11' }))
    expect(err.code).toBe('capacity')
    expect(err.retryable).toBe(true)
    expect(err.providerCode).toBe('resource_unavailable')
  })
})

/* -------------------------------------------------------------------------- describe */

describe('describe', () => {
  const data = { serverId: 42, name: SERVER_ID, ownedSshKeyIds: [] }

  it('maps a running server, with IP and offering', async () => {
    on('GET', /^\/servers\/42$/, { status: 200, body: { server: server() } })
    expect(await build().describe(data)).toEqual({
      state: 'running',
      publicIp: '49.13.94.234',
      publicDns: 'static.234.94.13.49.clients.your-server.de',
      offeringId: 'cpx12',
    })
  })

  it('maps deleting to terminating, NOT stopping (A3)', async () => {
    // The spike mapped this to 'stopping', which the app layer read as 'running' — a latent
    // bug that would resurrect a terminating row if anything polled it.
    on('GET', /^\/servers\/42$/, { status: 200, body: { server: server({ status: 'deleting' }) } })
    const view = await build().describe(data)
    expect(view.state).toBe('terminating')
    // Still present at the provider: a zero-orphan audit must not call this gone.
    expect(stillExistsAtProvider(view.state)).toBe(true)
  })

  it('maps the rest of the status vocabulary', async () => {
    const cases: [string, string][] = [
      ['initializing', 'pending'],
      ['starting', 'pending'],
      ['migrating', 'pending'],
      ['rebuilding', 'pending'],
      ['stopping', 'stopping'],
      ['off', 'stopped'],
      ['unknown', 'unknown'],
    ]
    for (const [hetzner, expected] of cases) {
      routes = []
      on('GET', /^\/servers\/42$/, { status: 200, body: { server: server({ status: hetzner }) } })
      expect((await build().describe(data)).state).toBe(expected)
    }
  })

  it('honours the propagation grace before believing a 404 (A4)', async () => {
    let attempts = 0
    on('GET', /^\/servers\/42$/, () => {
      attempts++
      return hetznerError(404, 'not_found')
    })

    const provider = build({ absenceGrace: { attempts: 4, delayMs: 0 } })
    expect(await provider.describe(data)).toEqual({ state: 'terminated' })
    // No propagation gap has ever been observed on Hetzner, but the rule says a provider may
    // lengthen the grace and may never skip it.
    expect(attempts).toBe(4)
  })

  it('believes the 404 immediately once the instance has been seen running', async () => {
    on('GET', /^\/servers\/42$/, { status: 200, body: { server: server() } })
    const provider = build({ absenceGrace: { attempts: 4, delayMs: 0 } })
    expect((await provider.describe(data)).state).toBe('running')

    let attempts = 0
    routes = []
    on('GET', /^\/servers\/42$/, () => {
      attempts++
      return hetznerError(404, 'not_found')
    })

    // Something seen running that is now absent really is gone — and this is the teardown
    // path, so paying the grace here would slow every terminate.
    expect(await provider.describe(data)).toEqual({ state: 'terminated' })
    expect(attempts).toBe(1)
  })

  it('gives up the grace and returns terminated if the instance reappears as gone', async () => {
    on('GET', /^\/servers\/42$/, hetznerError(404, 'not_found'))
    const provider = build({ absenceGrace: { attempts: 1, delayMs: 0 } })
    expect(await provider.describe(data)).toEqual({ state: 'terminated' })
  })

  it('still throws on a real failure', async () => {
    on('GET', /^\/servers\/42$/, hetznerError(401, 'unauthorized'))
    const err = await errorFrom(() => build().describe(data))
    expect(err.code).toBe('auth')
  })

  it('tolerates a server with no public IPv4', async () => {
    on('GET', /^\/servers\/42$/, { status: 200, body: { server: server({ public_net: { ipv4: null } }) } })
    const view = await build().describe(data)
    expect(view).toMatchObject({ state: 'running' })
    expect(view.publicIp).toBeUndefined()
  })

  it('rejects provider data that is not a Hetzner handle', async () => {
    const err = await errorFrom(() => build().describe({ instanceId: 'i-123' }))
    expect(err.code).toBe('invalid_spec')
    expect(() => asHetznerData({})).toThrow(ProviderError)
  })
})

/* ------------------------------------------------------------------------- terminate */

/**
 * The console deep link (ADR-0003, E16).
 *
 * The URL shape is `console.hetzner.com/projects/<project>/servers/<server>/overview` — the host
 * and the `/projects/<id>/<resource>/<id>/<tab>` structure are Hetzner's own, as used in their
 * documentation and community tutorials (e.g. `.../projects/<id>/networks/<id>/resources`).
 *
 * The numeric project id is the whole reason this needs configuration: an API token is scoped to
 * one project and NO Cloud API response ever names it, so there is nothing to derive it from.
 */
describe('the console link (E16)', () => {
  const data = { serverId: 42, name: SERVER_ID, ownedSshKeyIds: [] }

  it('reports nothing when no project id is configured, rather than guessing one', async () => {
    on('GET', /^\/servers\/42$/, { status: 200, body: { server: server() } })
    expect((await build().describe(data)).consoleUrl).toBeUndefined()
  })

  it('links the server to its console page when the project id is configured', async () => {
    on('GET', /^\/servers\/42$/, { status: 200, body: { server: server() } })
    expect((await build({ consoleProjectId: 1234567 }).describe(data)).consoleUrl).toBe(
      'https://console.hetzner.com/projects/1234567/servers/42/overview',
    )
  })

  it('uses the id of THIS server, not the one the last call asked about', () => {
    expect(hetznerConsoleUrl(1234567, 99)).toBe('https://console.hetzner.com/projects/1234567/servers/99/overview')
    expect(hetznerConsoleUrl(undefined, 99)).toBeUndefined()
  })

  it('is on the view provision returns, so the link works before the first sync', async () => {
    on('GET', /^\/ssh_keys/, { status: 200, body: page('ssh_keys', []) })
    on('POST', /^\/ssh_keys$/, { status: 201, body: { ssh_key: SSH_KEY } })
    on('POST', /^\/servers$/, { status: 201, body: { server: server({ status: 'initializing' }) } })

    const result = await build({ consoleProjectId: 1234567 }).provision(SPEC)
    expect(result.initial.consoleUrl).toBe('https://console.hetzner.com/projects/1234567/servers/42/overview')
  })

  it('takes the project id from configuration, string or number, and refuses a nonsense one', () => {
    // YAML gives strings as readily as numbers, and a project id read off an address bar is
    // pasted as text.
    expect(hetznerConfigSchema.parse({ token: TOKEN, consoleProjectId: '1234567' }).consoleProjectId).toBe(1234567)
    expect(hetznerConfigSchema.parse({ token: TOKEN }).consoleProjectId).toBeUndefined()
    expect(() => hetznerConfigSchema.parse({ token: TOKEN, consoleProjectId: 0 })).toThrow()
    expect(() => hetznerConfigSchema.parse({ token: TOKEN, consoleProjectId: 'my-project' })).toThrow()
  })
})

describe('terminate', () => {
  const data = { serverId: 42, name: SERVER_ID, ownedSshKeyIds: [2323] }

  it('deletes the server and every key it owns', async () => {
    on('DELETE', /^\/servers\/42$/, { status: 200, body: { action: { id: 9, status: 'running' } } })
    on('DELETE', /^\/ssh_keys\/2323$/, { status: 204 })

    await build().terminate(data)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /servers/42', 'DELETE /ssh_keys/2323'])
  })

  it('is idempotent: not-found is success on both resources', async () => {
    on('DELETE', /^\/servers\/42$/, hetznerError(404, 'not_found'))
    on('DELETE', /^\/ssh_keys\/2323$/, hetznerError(404, 'not_found'))

    const provider = build()
    await expect(provider.terminate(data)).resolves.toBeUndefined()
    await expect(provider.terminate(data)).resolves.toBeUndefined()
  })

  it('surfaces a non-404 failure rather than swallowing it', async () => {
    on('DELETE', /^\/servers\/42$/, hetznerError(423, 'protected', 'server is delete-protected'))
    const err = await errorFrom(() => build().terminate(data))
    expect(err.code).toBe('conflict')
    expect(err.providerCode).toBe('protected')
  })
})

/* ----------------------------------------------------------------------- listManaged */

describe('listManaged', () => {
  it('reports instances and secondary keys, both server-owned, with attribution', async () => {
    on('GET', /^\/servers\?label_selector=/, { status: 200, body: page('servers', [server()]) })
    on('GET', /^\/ssh_keys\?label_selector=/, { status: 200, body: page('ssh_keys', [SSH_KEY]) })

    const managed = await build().listManaged()
    expect(managed).toEqual([
      { kind: 'instance', providerNativeId: '42', ownership: 'server-owned', serverId: SERVER_ID },
      { kind: 'ssh-key', providerNativeId: '2323', ownership: 'server-owned', serverId: SERVER_ID },
    ])
    assertManagedShape(managed)
  })

  it('has nothing shared — unlike AWS, no Hetzner resource outlives its server', async () => {
    on('GET', /^\/servers\?label_selector=/, { status: 200, body: page('servers', [server()]) })
    on('GET', /^\/ssh_keys\?label_selector=/, { status: 200, body: page('ssh_keys', [SSH_KEY]) })
    expect((await build().listManaged()).every((r) => r.ownership === 'server-owned')).toBe(true)
  })

  it('filters on the configured managed-by prefix', async () => {
    on('GET', /^\/servers\?label_selector=/, { status: 200, body: page('servers', []) })
    on('GET', /^\/ssh_keys\?label_selector=/, { status: 200, body: page('ssh_keys', []) })

    await build({ managedBy: 'staging-rockysurf' }).listManaged()
    expect(calls.every((c) => c.path.includes(encodeURIComponent('managed-by=staging-rockysurf')))).toBe(true)
  })

  it('includes a terminating instance, because it still exists', async () => {
    on('GET', /^\/servers\?label_selector=/, {
      status: 200,
      body: page('servers', [server({ status: 'deleting' })]),
    })
    on('GET', /^\/ssh_keys\?label_selector=/, { status: 200, body: page('ssh_keys', []) })
    expect(await build().listManaged()).toHaveLength(1)
  })

  it('omits serverId for an owned key nobody can attribute', async () => {
    on('GET', /^\/servers\?label_selector=/, { status: 200, body: page('servers', []) })
    on('GET', /^\/ssh_keys\?label_selector=/, {
      status: 200,
      body: page('ssh_keys', [{ ...SSH_KEY, labels: { 'managed-by': 'rockysurf' } }]),
    })

    const [key] = await build().listManaged()
    expect(key?.serverId).toBeUndefined()
    expect(key?.ownership).toBe('server-owned')
  })

  it('returns nothing when the project holds nothing of ours', async () => {
    on('GET', /^\/servers\?label_selector=/, { status: 200, body: page('servers', []) })
    on('GET', /^\/ssh_keys\?label_selector=/, { status: 200, body: page('ssh_keys', []) })
    expect(await build().listManaged()).toEqual([])
  })
})

/* ------------------------------------------------------------------------ stop/start */

describe('stop and start', () => {
  const data = { serverId: 42, name: SERVER_ID, ownedSshKeyIds: [] }

  it('uses ACPI shutdown rather than pulling the plug', async () => {
    on('POST', /^\/servers\/42\/actions\/(shutdown|poweron)$/, {
      status: 201,
      body: { action: { id: 1, status: 'running' } },
    })
    const provider = build()
    await provider.stop(data)
    await provider.start(data)
    expect(calls.map((c) => c.path)).toEqual(['/servers/42/actions/shutdown', '/servers/42/actions/poweron'])
  })

  it('is a real implementation, because capabilities.stop is true', () => {
    // A provider that cannot stop implements both as unsupportedOperationError (A2).
    expect(build().capabilities.stop).toBe(true)
  })
})

/* -------------------------------------------------------------------- error taxonomy */

describe('error taxonomy', () => {
  const cases: [string, number, string, boolean][] = [
    ['rate_limit_exceeded', 429, 'rate_limited', true],
    ['resource_limit_exceeded', 403, 'quota', false],
    ['resource_unavailable', 412, 'capacity', true],
    ['no_space_left_in_location', 400, 'capacity', true],
    ['placement_error', 400, 'capacity', true],
    ['invalid_input', 400, 'invalid_spec', false],
    ['json_error', 400, 'invalid_spec', false],
    ['unsupported_error', 422, 'invalid_spec', false],
    ['uniqueness_error', 409, 'conflict', false],
    ['locked', 423, 'conflict', false],
    ['protected', 423, 'conflict', false],
    ['unauthorized', 401, 'auth', false],
    ['forbidden', 403, 'auth', false],
    ['token_readonly', 403, 'auth', false],
    ['not_found', 404, 'not_found', false],
    ['maintenance', 503, 'unknown', false],
    ['service_error', 500, 'unknown', false],
    ['action_failed', 500, 'unknown', false],
  ]

  for (const [providerCode, status, expected, retryable] of cases) {
    it(`maps ${providerCode} → ${expected}`, async () => {
      on('GET', /^\/servers/, hetznerError(status, providerCode))
      const err = await errorFrom(() => build().validateCredentials())
      assertProviderErrorShape(err)
      expect(err.code).toBe(expected)
      expect(err.providerCode).toBe(providerCode)
      // Retryability is DERIVED from the code (F2) — there is no field to contradict it.
      expect(err.retryable).toBe(retryable)
    })
  }

  it('keeps the native code even where the mapping is lossy', async () => {
    // `locked` means "busy, retry in ~2s" but lands on conflict, which reads as a
    // contradictory request. providerCode is what an operator needs to see (F1).
    on('GET', /^\/servers/, hetznerError(423, 'locked', 'server is locked'))
    const err = await errorFrom(() => build().validateCredentials())
    expect(err.code).toBe('conflict')
    expect(err.providerCode).toBe('locked')
  })

  it('maps an unrecognised code to unknown rather than crashing', async () => {
    on('GET', /^\/servers/, hetznerError(400, 'brand_new_hetzner_code'))
    const err = await errorFrom(() => build().validateCredentials())
    expect(err.code).toBe('unknown')
    expect(err.providerCode).toBe('brand_new_hetzner_code')
  })

  it('maps a transport failure to network, and never lets a raw fetch error escape', async () => {
    const exploding: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    const err = await errorFrom(() => build({ fetchImpl: exploding }).validateCredentials())
    assertProviderErrorShape(err)
    expect(err.code).toBe('network')
    expect(err.retryable).toBe(true)
  })

  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    let attempts = 0
    const waits: number[] = []
    on('GET', /^\/servers/, () => {
      attempts++
      return attempts === 1
        ? { ...hetznerError(429, 'rate_limit_exceeded'), headers: { 'retry-after': '2' } }
        : { status: 200, body: page('servers', []) }
    })
    on('GET', /^\/locations\//, { status: 200, body: { location: {} } })

    await build({ maxRetries: 2, sleep: async (ms) => void waits.push(ms) }).validateCredentials()
    expect(attempts).toBe(2)
    expect(waits[0]).toBe(2000)
  })

  it('retries `locked`, which the frozen taxonomy cannot mark retryable on its own', async () => {
    let attempts = 0
    on('GET', /^\/servers/, () => {
      attempts++
      return attempts === 1 ? hetznerError(423, 'locked') : { status: 200, body: page('servers', []) }
    })
    on('GET', /^\/locations\//, { status: 200, body: { location: {} } })

    await build({ maxRetries: 2, sleep: async () => {} }).validateCredentials()
    expect(attempts).toBe(2)
  })

  it('gives up after the retry budget', async () => {
    let attempts = 0
    on('GET', /^\/servers/, () => {
      attempts++
      return hetznerError(429, 'rate_limit_exceeded')
    })
    const err = await errorFrom(() => build({ maxRetries: 2, sleep: async () => {} }).validateCredentials())
    expect(err.code).toBe('rate_limited')
    expect(attempts).toBe(3)
  })
})

/**
 * The shared behavioural case, run against this provider (rockysurf-5i28).
 *
 * Hetzner has never shown a propagation gap and implemented the grace anyway; `provider-aws`
 * shipped without it and lost a live instance (rockysurf-gyp1.4). The rule now has a suite
 * every provider runs, rather than two independent readings of the same paragraph.
 */
describe('conformance: describe() absence grace', () => {
  const data = { serverId: 42, name: SERVER_ID, ownedSshKeyIds: [] }

  /** Answers `script` in order, repeating the last entry forever, and counts the calls. */
  function scriptGetServer(script: readonly DescribeRead[]): () => number {
    let reads = 0
    on('GET', /^\/servers\/42$/, () => {
      const answer = script[Math.min(reads, script.length - 1)]
      reads++
      return answer === 'absent' ? hetznerError(404, 'not_found') : { status: 200, body: { server: server() } }
    })
    return () => reads
  }

  const harness: AbsenceGraceHarness = {
    provider: 'hetzner',
    neverSeenRunning(script) {
      // A FRESH provider: `seenRunning` is per-instance state, and a server this one has never
      // described is exactly the ambiguous case the grace is for.
      const provider = build()
      const reads = scriptGetServer(script)
      return { run: async () => ({ view: await provider.describe(data), reads: reads() }) }
    },
    async goneAfterRunning() {
      const provider = build()
      on('GET', /^\/servers\/42$/, { status: 200, body: { server: server() } })
      await provider.describe(data)

      const reads = scriptGetServer(['absent'])
      return { run: async () => ({ view: await provider.describe(data), reads: reads() }) }
    },
  }

  it('honours the shared absence-grace contract', async () => {
    await assertDescribeAbsenceGrace(harness)
  })
})

/* ------------------------------------------------------------------------ primitives */

describe('ssh fingerprint', () => {
  it('computes the MD5 fingerprint Hetzner indexes keys by', () => {
    const fp = sshFingerprint(SPEC.sshPublicKeys[0]!)
    expect(fp).toMatch(/^([0-9a-f]{2}:){15}[0-9a-f]{2}$/)
  })

  it('ignores the comment and surrounding whitespace, which are not part of the identity', () => {
    const base = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2ULvJn8xU9d1kQK0Yy8sV3z0000000000000000000'
    expect(sshFingerprint(`${base} alice@laptop`)).toBe(sshFingerprint(`  ${base} bob@desktop\n`))
  })
})
