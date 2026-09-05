import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../app.js'
import { configSchema } from '../config/schema.js'
import { openTestDatabase, type Db } from '../db/client.js'
import { countServersOnProvider, insertServer, updateServerStatus } from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import type { SafeFetchResult } from '../packs/safe-fetch.js'
import { installProviderPackage, installedProviderManifest, providerPackageDir } from './install.js'
import { createProviderShopClient } from './shop.js'
import { createProviderShopRoutes } from './shop-routes.js'
import { providerPackageMembers, tarballBytes } from './tar.fixture.js'

/**
 * The provider shop's routes: browse, install, remove (ADR-0028).
 *
 * The install path is asserted END TO END against a real temporary data directory and a real
 * config file, because the two halves it has to keep in step are exactly the two that could
 * drift: a package on disk under `<dataDir>/providers`, and a `providers.<id>.package` line in
 * the file. One without the other is either an invisible directory or a config file pointing at
 * nothing, and both are states the operator would meet as "the provider I installed is not
 * there".
 *
 * The tarball is built in the test rather than fetched or committed — see `tar.fixture.ts`.
 */

const BASE = configSchema.parse({}).registry.sources[0]!.url
const SHOP = configSchema.parse({}).registry.sources[0]!.name

const PACKAGE = '@fixture/rockysurf-provider-nimbus'
const TARBALL_URL = 'https://example.test/nimbus-1.0.0.tgz'
const ARTIFACT = tarballBytes(providerPackageMembers({ name: PACKAGE, version: '1.0.0' }))

const ENTRY = {
  providerId: 'nimbus',
  name: 'Nimbus Cloud',
  description: 'A fixture cloud.',
  version: '1.0.0',
  package: PACKAGE,
  tarball: TARBALL_URL,
  sha256: createHash('sha256').update(ARTIFACT).digest('hex'),
  settings: [{ name: 'token', label: 'API token variable', kind: 'secret' }],
  capabilities: {
    stop: true,
    ipStableAcrossStop: true,
    canInjectHostKeys: false,
    generatesUserData: false,
    userDataMaxBytes: 0,
    billsWhileStopped: true,
  },
}

const listing = (providers: unknown[] = [ENTRY]) =>
  JSON.stringify({ version: 1, generatedAt: '2026-09-04T00:00:00.000Z', providers })

let db: Db
let dir: string
let configPath: string
const scratch: string[] = []

/** A file that already validates and already has a provider section, so a save has to preserve it. */
const CONFIG = [
  'server:',
  '  dataDir: DATA',
  'providers:',
  '  byo:',
  '    enabled: true',
  '    hosts:',
  '      - name: workshop',
  '        host: 192.0.2.10',
  '',
].join('\n')

beforeEach(() => {
  db = openTestDatabase().db
  dir = mkdtempSync(join(tmpdir(), 'rockysurf-shop-routes-'))
  scratch.push(dir)
  configPath = join(dir, 'config.yaml')
  writeFileSync(configPath, CONFIG.replace('DATA', join(dir, 'data')))
})
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const providersDir = () => join(dir, 'data', 'providers')

function stubFetch(responses: Record<string, string>) {
  return vi.fn(async (url: string): Promise<SafeFetchResult> => {
    const body = responses[url]
    return body === undefined ? { ok: false, reason: `Could not fetch ${url}` } : { ok: true, text: body }
  })
}

const stubBytes = vi.fn(async (url: string) =>
  url === TARBALL_URL
    ? ({ ok: true, bytes: ARTIFACT, url } as const)
    : ({ ok: false, reason: `Could not fetch ${url}` } as const),
)

/**
 * The routes behind a parent that supplies the admin user the real session middleware would.
 * Registered on the PARENT, because Hono matches in registration order.
 */
function mount(overrides: Partial<Parameters<typeof createProviderShopRoutes>[0]> = {}, index = listing()) {
  const parent = new Hono<AppEnv>()
  parent.use('*', async (c, next) => {
    c.set('user', { id: 'u1', isAdmin: true } as never)
    await next()
  })
  parent.route(
    '/',
    createProviderShopRoutes({
      db,
      shop: createProviderShopClient({
        config: configSchema.parse({}).registry,
        fetchText: stubFetch({ [`${BASE}/providers.json`]: index }),
      }),
      providersDir,
      configPath,
      configuredProviderIds: () => Object.keys((readConfigTree().providers ?? {}) as object),
      countServers: () => 0,
      // The real installer, with the fetch seam stubbed: the unpacking, the digest check and
      // the resolver all run for real, and nothing leaves the machine.
      install: (entry, deps) => installProviderPackage(entry, { ...deps, fetchBytes: stubBytes }),
      ...overrides,
    }),
  )
  return parent
}

function readConfigTree(): Record<string, unknown> {
  const text = readFileSync(configPath, 'utf8')
  const providers: Record<string, unknown> = {}
  // Deliberately crude: this only has to answer "which provider keys does the file name", and a
  // second YAML parse here would be a second definition of the file's shape.
  let inProviders = false
  for (const line of text.split('\n')) {
    if (/^providers:/.test(line)) {
      inProviders = true
      continue
    }
    if (inProviders && /^\S/.test(line)) inProviders = false
    const key = inProviders ? /^ {2}([a-z0-9-]+):/.exec(line) : null
    if (key) providers[key[1]!] = {}
  }
  return { providers }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json()

describe('browsing the provider shelves', () => {
  it('serves the trust sentence itself, and never takes one from the listing', async () => {
    const res = await mount().request('/api/v1/admin/provider-registry')
    const body = await json(res)
    expect(body.trustSentence).toBe("a provider runs with Rocky Surf's full access — install ones you trust.")
    expect(body.shelves[0].providers[0]).not.toHaveProperty('trustSentence')
  })

  it('says what each entry asks for and what its machines can do, before anything is installed', async () => {
    const body = await json(await mount().request('/api/v1/admin/provider-registry'))
    const entry = body.shelves[0].providers[0]
    expect(entry.settings).toEqual([{ name: 'token', label: 'API token variable', kind: 'secret' }])
    expect(entry.capabilities.billsWhileStopped).toBe(true)
    expect(entry).toMatchObject({ installed: false, installedVersion: null })
  })

  it('reports a shelf that cannot be read as one shelf with a reason, not as an empty shop', async () => {
    const routes = mount({}, 'not json at all')
    const body = await json(await routes.request('/api/v1/admin/provider-registry'))
    expect(body.shelves[0].failure.kind).toBe('invalid')
    expect(body.shelves[0].providers).toEqual([])
  })

  it('refuses a non-admin', async () => {
    const parent = new Hono<AppEnv>()
    parent.use('*', async (c, next) => {
      c.set('user', { id: 'u2', isAdmin: false } as never)
      await next()
    })
    parent.route('/', createProviderShopRoutes({
      db,
      providersDir,
      configPath,
      configuredProviderIds: () => [],
      countServers: () => 0,
    }))
    expect((await parent.request('/api/v1/admin/provider-registry')).status).toBe(403)
  })
})

describe('installing', () => {
  it('writes the package under the data directory and the two lines into the config file', async () => {
    const routes = mount()
    const res = await routes.request(`/api/v1/admin/provider-registry/${encodeURIComponent(SHOP)}/nimbus/install`, {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toMatchObject({ providerId: 'nimbus', package: PACKAGE, version: '1.0.0', restartRequired: true })
    expect(body.restartReason).toContain('Restart')

    expect(existsSync(join(providerPackageDir(providersDir(), PACKAGE), 'index.js'))).toBe(true)
    const config = readFileSync(configPath, 'utf8')
    expect(config).toMatch(/nimbus:/)
    expect(config).toContain(`package: "${PACKAGE}"`)
    expect(config).toMatch(/nimbus:[\s\S]*enabled: true/)
    // The rest of the file is untouched, comments and all — it went through the Document API.
    expect(config).toMatch(/byo:[\s\S]*enabled: true/)
  })

  it('then reports the entry as installed, at the version on disk', async () => {
    const routes = mount()
    await routes.request(`/api/v1/admin/provider-registry/${encodeURIComponent(SHOP)}/nimbus/install`, {
      method: 'POST',
    })
    const body = await json(await routes.request('/api/v1/admin/provider-registry'))
    expect(body.shelves[0].providers[0]).toMatchObject({ installed: true, installedVersion: '1.0.0' })
  })

  it('is 404 for a provider the source does not list', async () => {
    const routes = mount()
    const res = await routes.request(
      `/api/v1/admin/provider-registry/${encodeURIComponent(SHOP)}/absent/install`,
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
  })

  it('writes nothing at all when the artifact is refused', async () => {
    const routes = mount({}, listing([{ ...ENTRY, sha256: 'b'.repeat(64) }]))
    const res = await routes.request(`/api/v1/admin/provider-registry/${encodeURIComponent(SHOP)}/nimbus/install`, {
      method: 'POST',
    })

    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('does not match the digest')
    expect(readFileSync(configPath, 'utf8')).not.toContain('nimbus')
    expect(existsSync(providerPackageDir(providersDir(), PACKAGE))).toBe(false)
  })

  it('takes the package off the disk again when the config file could not be written', async () => {
    const routes = mount({ configPath: join(dir, 'does-not-exist', 'config.yaml') })
    const res = await routes.request(`/api/v1/admin/provider-registry/${encodeURIComponent(SHOP)}/nimbus/install`, {
      method: 'POST',
    })
    expect(res.status).toBe(400)
    expect(existsSync(providerPackageDir(providersDir(), PACKAGE))).toBe(false)
  })
})

describe('removing', () => {
  async function installed() {
    const routes = mount()
    await routes.request(`/api/v1/admin/provider-registry/${encodeURIComponent(SHOP)}/nimbus/install`, {
      method: 'POST',
    })
    return routes
  }

  it('deletes the package and the whole config section', async () => {
    const routes = await installed()
    const res = await routes.request('/api/v1/admin/personal-providers/nimbus', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ providerId: 'nimbus', removed: PACKAGE, restartRequired: true })
    expect(readFileSync(configPath, 'utf8')).not.toContain('nimbus')
    expect(installedProviderManifest(providersDir(), PACKAGE)).toBeUndefined()
  })

  it('refuses while servers made with that provider still exist, and names how many', async () => {
    const routes = mount({ countServers: () => 2 })
    await routes.request(`/api/v1/admin/provider-registry/${encodeURIComponent(SHOP)}/nimbus/install`, {
      method: 'POST',
    })
    const res = await routes.request('/api/v1/admin/personal-providers/nimbus', { method: 'DELETE' })

    expect(res.status).toBe(409)
    expect((await json(res)).error).toContain('2 server(s)')
    // Nothing was touched: the package is still installed and the section is still in the file.
    expect(installedProviderManifest(providersDir(), PACKAGE)?.version).toBe('1.0.0')
    expect(readFileSync(configPath, 'utf8')).toContain('nimbus')
  })

  it('is 404 for a provider the config file does not name', async () => {
    const res = await mount().request('/api/v1/admin/personal-providers/absent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  /**
   * The counter `app.ts` actually wires in, against a real row — so the refusal above is not
   * merely a stub agreeing with itself.
   */
  it('counts live rows on that provider from the database, and terminates none of them', async () => {
    await installed()
    const user = upsertUserByGithubId(db, { githubId: 'g1', githubUsername: 'someone', isAdmin: true })
    const row = insertServer(db, {
      userId: user.id,
      name: 'box',
      provider: 'nimbus',
      size: 'small',
      offeringId: 'n-small',
      arch: 'amd64',
      region: 'sky-1',
    })
    expect(countServersOnProvider(db, 'nimbus')).toBe(1)

    const withRealCount = mount({ countServers: (id) => countServersOnProvider(db, id) })
    const res = await withRealCount.request('/api/v1/admin/personal-providers/nimbus', { method: 'DELETE' })
    expect(res.status).toBe(409)

    updateServerStatus(db, row.id, 'terminated')
    expect(countServersOnProvider(db, 'nimbus')).toBe(0)
    const second = await mount({ countServers: (id) => countServersOnProvider(db, id) }).request(
      '/api/v1/admin/personal-providers/nimbus',
      { method: 'DELETE' },
    )
    expect(second.status).toBe(200)
  })
})
