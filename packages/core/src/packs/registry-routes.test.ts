import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../app.js'
import { syncPacksAtBoot } from '../boot/packs.js'
import { openTestDatabase } from '../db/client.js'
import type { Db } from '../db/client.js'
import { getPack, listPacks, listTools } from '../db/repositories/packs.js'
import { configSchema } from '../config/schema.js'
import { createRegistryClient } from './registry.js'
import { sha256Text } from './registry-index.js'
import { createPackRoutes } from './routes.js'
import type { SafeFetchResult } from './safe-fetch.js'

/**
 * The pack shop's routes: browse, disclose, install.
 *
 * Two things are load-bearing here beyond "the endpoint works".
 *
 * The first is that a registry install goes through THE SAME code that a YAML import goes
 * through, so the two cannot drift into producing different rows for the same file. That is
 * asserted by installing one pack both ways and comparing.
 *
 * The second is the trap the whole stage is written around: provenance must not live in
 * `sourceFile`, because the boot reconcile deletes every file-backed row whose file it cannot
 * find. So there is a test that installs from a registry and then runs the REAL boot sync
 * against a populated `packs/` directory, and requires the installed pack to still be there.
 */

const PACK_YAML = `version: 1
pack:
  packId: rust-dev
  name: Rust Dev
  tools:
    - rustup
  displayOrder: 90
  enabled: true
  guide: |
    Run rustup default stable once you are on the box.
tools:
  - toolId: rustup
    name: rustup
    description: The Rust toolchain installer
    category: base
    url: https://rustup.rs
    installScript: |
      set -euo pipefail
      curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh
      sh /tmp/rustup.sh -y --no-modify-path
    enabled: true
    installOrder: 30
    bootstrap: false
    runAs: root
`

const ENTRY = {
  packId: 'rust-dev',
  name: 'Rust Dev',
  description: 'Installs 1 tool(s): rustup',
  path: 'packs/rust-dev.yaml',
  sha256: sha256Text(PACK_YAML),
  definesTools: ['rustup'],
  referencesTools: [],
  requiresRepos: false,
  requiresRdp: false,
}

const INDEX = JSON.stringify({ version: 1, generatedAt: '2026-08-14T00:00:00.000Z', packs: [ENTRY] })

const BASE = configSchema.parse({}).registry.sources[0]!.url
const SHOP = configSchema.parse({}).registry.sources[0]!.name

function stubFetch(responses: Record<string, string>) {
  return vi.fn(async (url: string): Promise<SafeFetchResult> => {
    const body = responses[url]
    return body === undefined ? { ok: false, reason: `Could not fetch ${url}` } : { ok: true, text: body }
  })
}

const OK = { [`${BASE}/index.json`]: INDEX, [`${BASE}/packs/rust-dev.yaml`]: PACK_YAML }

let db: Db
const scratch: string[] = []

beforeEach(() => {
  db = openTestDatabase().db
})
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/**
 * The pack routes behind a parent that supplies the admin user the real session middleware
 * would. Middleware has to be registered on a parent, not appended to the child: Hono matches in
 * registration order, so a `use('*')` added after the routes never runs for them.
 */
function mount(deps: Parameters<typeof createPackRoutes>[0]) {
  const parent = new Hono<AppEnv>()
  parent.use('*', async (c, next) => {
    c.set('user', { id: 'u1', isAdmin: true } as never)
    await next()
  })
  parent.route('/', createPackRoutes(deps))
  return parent
}

function app(responses: Record<string, string> = OK, overrides: Record<string, unknown> = {}) {
  const config = configSchema.parse({ registry: overrides }).registry
  return mount({ db, registry: createRegistryClient({ config, fetchText: stubFetch(responses) }) })
}

/** Routes with NO registry at all, which is a legitimate embedder configuration. */
const appWithoutRegistry = () => mount({ db })

const get = (routes: ReturnType<typeof app>, path: string) => routes.request(path)
const post = (routes: ReturnType<typeof app>, path: string) => routes.request(path, { method: 'POST' })

/**
 * Response bodies are read as `any`, matching `routes.test.ts`. These are assertions about a
 * JSON envelope this file already pins field by field; restating the shape as a type would be
 * a second definition to keep in step, and a wrong one would make the test pass.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json()

describe('browsing the shop', () => {
  it('returns a shelf per configured source, with each pack labelled by that source', async () => {
    const res = await get(app(), '/api/v1/admin/pack-registry')
    expect(res.status).toBe(200)
    const parsed = await json(res)

    expect(parsed.enabled).toBe(true)
    expect(parsed.shelves).toHaveLength(1)
    expect(parsed.shelves[0].source).toMatchObject({ name: SHOP, trust: 'community' })
    expect(parsed.shelves[0].packs[0]).toMatchObject({
      packId: 'rust-dev',
      sourceName: SHOP,
      trust: 'community',
      installed: false,
    })
  })

  it('marks a pack already in the catalog as installed', async () => {
    await post(app(), `/api/v1/admin/pack-registry/${encodeURIComponent(SHOP)}/rust-dev/install`)
    const parsed = await json(await get(app(), '/api/v1/admin/pack-registry'))
    expect(parsed.shelves[0].packs[0].installed).toBe(true)
  })

  it('carries a shelf’s failure rather than presenting an empty shop', async () => {
    // An operator has to be able to tell "this registry is down" from "this registry has
    // nothing in it". Collapsing both into an empty list makes an outage invisible.
    const parsed = await json(await get(app({}), '/api/v1/admin/pack-registry'))
    expect(parsed.shelves[0].packs).toEqual([])
    expect(parsed.shelves[0].failure).toMatchObject({ kind: 'unreachable' })
  })

  it('reports a disabled registry as disabled', async () => {
    const parsed = await json(await get(app(OK, { enabled: false }), '/api/v1/admin/pack-registry'))
    expect(parsed.shelves[0].failure).toMatchObject({ kind: 'disabled' })
  })

  it('answers with an empty shop when no registry is wired at all', async () => {
    // An embedder building these routes without a registry is not an error state, and from the
    // outside it is the same situation as `enabled: false`. Inventing a second one helps nobody.
    const parsed = await json(await get(appWithoutRegistry(), '/api/v1/admin/pack-registry'))
    expect(parsed).toMatchObject({ enabled: false, shelves: [] })
  })
})

describe('the disclosure', () => {
  const disclose = () =>
    get(app(), `/api/v1/admin/pack-registry/${encodeURIComponent(SHOP)}/rust-dev`)

  it('carries every script verbatim, because that is the control', async () => {
    // The scripts are the ground truth an operator consents to. Anything derived is a reading
    // aid; this is the thing itself.
    const parsed = await json(await disclose())
    expect(parsed.disclosure.tools[0].installScript).toContain('sh /tmp/rustup.sh -y --no-modify-path')
    expect(parsed.yaml).toBe(PACK_YAML)
  })

  it('counts the steps that run as root and lists every URL the scripts fetch', async () => {
    const parsed = await json(await disclose())
    expect(parsed.disclosure.rootStepCount).toBe(1)
    expect(parsed.disclosure.fetchesUrls).toContain('https://sh.rustup.rs')
  })

  it('says the derived summary is not complete', async () => {
    // A URL list extracted by pattern-matching shell cannot be complete — a script can build a
    // URL from variables. A page that presents the summary without saying so is telling the
    // operator they have seen everything, and they have not.
    const parsed = await json(await disclose())
    expect(parsed.disclosure.summaryIsComplete).toBe(false)
  })

  it('does not install anything', async () => {
    await disclose()
    expect(listPacks(db)).toEqual([])
  })

  it('refuses a pack whose bytes do not match the published digest', async () => {
    const res = await get(
      app({ ...OK, [`${BASE}/packs/rust-dev.yaml`]: `${PACK_YAML}# tampered\n` }),
      `/api/v1/admin/pack-registry/${encodeURIComponent(SHOP)}/rust-dev`,
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('does not match the digest')
  })

  it('404s for a pack the registry does not list', async () => {
    const res = await get(app(), `/api/v1/admin/pack-registry/${encodeURIComponent(SHOP)}/nope`)
    expect(res.status).toBe(404)
  })
})

describe('installing', () => {
  const install = (routes = app()) =>
    post(routes, `/api/v1/admin/pack-registry/${encodeURIComponent(SHOP)}/rust-dev/install`)

  it('writes the pack and its tools, and records where it came from', async () => {
    const res = await install()
    expect(res.status).toBe(201)

    const pack = getPack(db, 'rust-dev')!
    expect(pack.name).toBe('Rust Dev')
    expect(listTools(db).map((t) => t.id)).toContain('rustup')
    expect(pack.registrySource).toBe(SHOP)
    expect(pack.registrySha256).toBe(ENTRY.sha256)
    expect(pack.registryTrust).toBe('community')
    expect(pack.registryUrl).toBe(BASE)
  })

  it('leaves sourceFile NULL — the whole reason provenance has its own columns', async () => {
    await install()
    expect(getPack(db, 'rust-dev')!.sourceFile).toBeNull()
  })

  it('survives a boot reconcile against a populated packs/ directory', async () => {
    // THE TRAP THIS STAGE IS WRITTEN AROUND. `syncPacksToDb` deletes every row whose
    // `sourceFile` is set and whose file the boot cannot find, so provenance recorded there
    // would make a registry install vanish on the next restart. This runs the REAL boot sync,
    // with a real pack file present so the reconcile actually executes rather than declining.
    await install()

    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-boot-packs-'))
    scratch.push(dir)
    mkdirSync(join(dir, 'packs'), { recursive: true })
    writeFileSync(
      join(dir, 'packs/shipped.yaml'),
      JSON.stringify({
        version: 1,
        pack: { packId: 'shipped', name: 'Shipped', tools: ['a-tool'], displayOrder: 1, enabled: true },
        tools: [
          {
            toolId: 'a-tool',
            name: 'A tool',
            description: 'Ships with the release',
            category: 'base',
            url: 'https://example.com',
            installScript: 'echo hi\n',
            enabled: true,
            installOrder: 10,
            bootstrap: false,
            runAs: 'root',
          },
        ],
      }),
    )

    const result = syncPacksAtBoot({ db, dataDir: dir, cwd: dir, log: () => {} })
    expect(result.reconciled).toBe(true)

    const survived = getPack(db, 'rust-dev')
    expect(survived, 'the registry pack must survive a reconcile it was never part of').toBeDefined()
    expect(survived!.registrySource).toBe(SHOP)
    // And the file-backed pack arrived alongside it, so both kinds coexist.
    expect(getPack(db, 'shipped')?.sourceFile).toBe('shipped.yaml')
  })

  it('produces the same rows as importing the identical YAML by hand', async () => {
    // One function turns a PackFile into rows, and this is what says so. Two write paths would
    // drift, and the drift would surface as a catalog that behaves differently depending on
    // where a pack came from.
    await install()
    const viaRegistry = getPack(db, 'rust-dev')!

    const fresh = openTestDatabase().db
    const importer = mount({ db: fresh })
    const res = await importer.request('/api/v1/admin/surge-packs/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: PACK_YAML }),
    })
    expect(res.status).toBe(200)
    const viaImport = getPack(fresh, 'rust-dev')!

    const shape = (p: typeof viaRegistry) => ({
      id: p.id,
      name: p.name,
      tools: p.tools,
      displayOrder: p.displayOrder,
      enabled: p.enabled,
      guide: p.guide,
      requiresRepos: p.requiresRepos,
      requiresRdp: p.requiresRdp,
      sourceFile: p.sourceFile,
    })
    expect(shape(viaRegistry)).toEqual(shape(viaImport))
    // The one intended difference: an import carries no provenance, an install does.
    expect(viaImport.registrySource).toBeNull()
    expect(viaRegistry.registrySource).toBe(SHOP)
  })

  it('re-verifies the digest at install rather than trusting the disclosure screen', async () => {
    // An install that took its YAML from the client would let whatever reached the disclosure
    // decide what runs as root, which defeats the point of having verified it.
    const res = await install(app({ ...OK, [`${BASE}/packs/rust-dev.yaml`]: `${PACK_YAML}# tampered\n` }))
    expect(res.status).toBe(400)
    expect(listPacks(db)).toEqual([])
  })

  it('surfaces provenance through the admin API, separately from sourceFile', async () => {
    await install()
    const parsed = await json(await get(app(), '/api/v1/admin/surge-packs'))
    const pack = parsed.find((p: { packId: string }) => p.packId === 'rust-dev')
    expect(pack.sourceFile).toBeNull()
    expect(pack.registry).toMatchObject({ source: SHOP, trust: 'community', sha256: ENTRY.sha256 })
  })

  it('appears in the public pack list with no restart', async () => {
    // The acceptance criterion from the issue, at route level: installed, then immediately
    // choosable when creating a server.
    const routes = app()
    expect(await json(await get(routes, '/api/v1/surge-packs'))).toEqual([])
    await install(routes)
    const packs = await json(await get(routes, '/api/v1/surge-packs'))
    expect(packs.map((p: { packId: string }) => p.packId)).toEqual(['rust-dev'])
  })

  it('404s when no registry is configured', async () => {
    const res = await post(
      appWithoutRegistry(),
      `/api/v1/admin/pack-registry/${encodeURIComponent(SHOP)}/rust-dev/install`,
    )
    expect(res.status).toBe(404)
  })
})

describe('a later YAML import over an installed pack', () => {
  it('clears the provenance, because the bytes are no longer the registry’s', async () => {
    // Leaving it would attribute an operator's own local file to somebody else — which is the
    // opposite of what a provenance field is for.
    const routes = app()
    await post(routes, `/api/v1/admin/pack-registry/${encodeURIComponent(SHOP)}/rust-dev/install`)
    expect(getPack(db, 'rust-dev')!.registrySource).toBe(SHOP)

    await routes.request('/api/v1/admin/surge-packs/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: PACK_YAML.replace('name: Rust Dev', 'name: My Rust') }),
    })
    const pack = getPack(db, 'rust-dev')!
    expect(pack.name).toBe('My Rust')
    expect(pack.registrySource).toBeNull()
  })
})
