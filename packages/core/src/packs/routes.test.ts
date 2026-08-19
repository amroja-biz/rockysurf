import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppEnv, type CreatedApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { issueSession } from '../auth/sessions.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { loadPacksFromDir } from './loader.js'
import { createPackRoutes, type PackRoutesDeps } from './routes.js'
import { syncPacksToDb } from './sync.js'

/**
 * The HTTP surface, against the real shipped packs.
 *
 * The response shapes are asserted field by field rather than loosely, because the whole
 * reason they look like this is that the SPA's API client (`packages/web/src/lib/api.ts`)
 * already parses them — a "close enough" shape is a broken SPA port.
 *
 * Everything here reads `packs/`, which means every assertion is also a statement about what a
 * NEW pack file is allowed to be. Two rules follow, and both are load-bearing (rockysurf-d5an):
 * an assertion about the shipped set says so and scopes itself to `SHIPPED_PACK_IDS`, and an
 * assertion about a field the schema calls optional applies only to packs that declare it.
 * Anything else makes adding a pack an application change, which is the one thing the format
 * promises it is not.
 */

const PASSWORD = 'correct-horse-battery-staple'
const packsDir = fileURLToPath(new URL('../../../../packs/', import.meta.url))
const config: Config = configSchema.parse({})

/**
 * The packs this repository ships — pinned as a REQUIRED SUBSET, never as the whole list.
 *
 * Identity is worth pinning: a change that drops or renames a shipped pack should fail here
 * rather than in someone's browser. The exact-equality version of this list also failed on any
 * SEVENTH pack, which is a different thing entirely and is the bug this shape exists to avoid.
 */
const SHIPPED_PACK_IDS = ['ai-coding-agents', 'amp-agents', 'codex-cli', 'gas-town', 'open-claw', 'open-code']

let opened: OpenedDatabase
let created: CreatedApp
let token: string

const json = async (res: Response) => (await res.json()) as any
const auth = () => ({ authorization: `Bearer ${token}` })

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  created.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

/** A signed-in app over an arbitrary packs directory — the real one, or one a test built. */
const startApp = async (dir: string) => {
  const db = openTestDatabase()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: db.db, secrets, password: PASSWORD })
  const loaded = loadPacksFromDir(dir)
  expect(loaded.issues).toEqual([])
  syncPacksToDb(db.db, loaded)
  const app = createApp({ db: db.db, config, secrets })

  const res = await app.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  return { db, app, token: ((await res.json()) as any).token as string }
}

beforeEach(async () => {
  const started = await startApp(packsDir)
  opened = started.db
  created = started.app
  token = started.token
})

afterEach(() => opened.close())

describe('authentication', () => {
  it('requires a session for the public lists', async () => {
    expect((await send('GET', '/api/v1/tools')).status).toBe(401)
    expect((await send('GET', '/api/v1/surge-packs')).status).toBe(401)
  })

  it('requires admin for the admin routes', async () => {
    // A signed-in NON-admin gets 403 rather than 401: authenticated, not authorized.
    const user = upsertUserByGithubId(opened.db, { githubId: 'gh:2', githubUsername: 'someone' })
    const { token: userToken } = issueSession(opened.db, user.id)
    const res = await send('GET', '/api/v1/admin/tools', undefined, { authorization: `Bearer ${userToken}` })
    expect(res.status).toBe(403)
    expect((await json(res)).code).toBe('forbidden')
  })
})

/**
 * What the public list owes the SPA for EVERY pack it serves, shipped or contributed.
 *
 * The optional fields are asserted only when the pack declares one: schema.ts is the authority
 * on what a pack file must contain, and it calls `imageUrl`, `theme` and `guide` optional. The
 * assertion worth making about an optional field is that a declared one is well-formed and an
 * omitted one comes back absent rather than as `null` — which is what the SPA's API client
 * (`packages/web/src/lib/api.ts`) parses and what the server detail page branches on.
 */
const expectServedPackShape = (pack: any) => {
  expect(typeof pack.packId, JSON.stringify(pack)).toBe('string')
  expect(typeof pack.name, pack.packId).toBe('string')
  expect(typeof pack.requiresRepos, pack.packId).toBe('boolean')
  expect(typeof pack.requiresRdp, pack.packId).toBe('boolean')
  expect(pack.tools.length, `${pack.packId} installs nothing`).toBeGreaterThan(0)
  for (const tool of pack.tools) {
    expect(Object.keys(tool).sort(), pack.packId).toEqual(['category', 'description', 'name', 'toolId', 'url'])
  }
  // A declared optional field is a non-empty string; an omitted one is absent from the JSON,
  // not null. Nothing stronger belongs here — `imageUrl` is documented as a relative path OR an
  // absolute URL, so the shipped set's tighter `/images/surge-packs/*.png` rule is asserted
  // where it is true, on the shipped set.
  for (const field of ['imageUrl', 'theme', 'guide', 'desktop'] as const) {
    if (!(field in pack)) continue
    expect(typeof pack[field], `${pack.packId}.${field}`).toBe('string')
    expect(pack[field].length, `${pack.packId}.${field}`).toBeGreaterThan(0)
  }
  // Where it came from, derived, on every pack (rockysurf-jn71). Not optional the way the four
  // above are: a pack row is always in exactly one of these three states, so a pack served
  // without the field would leave the picker unable to file it under either tab.
  expect(['official', 'registry', 'local'], `${pack.packId}.provenance`).toContain(pack.provenance)
  // ...and the derived word is ALL that crosses. The path on disk, the registry's URL, the
  // digest and the trust label the operator consented to are operator infrastructure detail,
  // and this route is served to every logged-in user, not only to admins.
  for (const withheld of ['sourceFile', 'registry', 'registrySource', 'registryUrl', 'registrySha256', 'registryTrust']) {
    expect(withheld in pack, `${pack.packId}.${withheld} is not the public list's to serve`).toBe(false)
  }
}

describe('public shapes match the SPA client', () => {
  it('GET /api/v1/tools returns exactly the five public fields', async () => {
    const tools = await json(await send('GET', '/api/v1/tools', undefined, auth()))
    expect(tools.length).toBeGreaterThan(0)
    for (const t of tools) {
      expect(Object.keys(t).sort()).toEqual(['category', 'description', 'name', 'toolId', 'url'])
    }
    // No scripts on the public route, ever.
    expect(JSON.stringify(tools)).not.toContain('apt-get')
  })

  it('GET /api/v1/surge-packs expands tools and carries the new fields', async () => {
    const packs = await json(await send('GET', '/api/v1/surge-packs', undefined, auth()))
    // Containment, in display order: every shipped pack is served, still in the order the
    // display fields put them, and a pack added to `packs/` sits wherever its displayOrder
    // says without failing anything.
    const served = packs.map((p: any) => p.packId)
    expect(served.filter((id: string) => SHIPPED_PACK_IDS.includes(id))).toEqual(SHIPPED_PACK_IDS)
    for (const pack of packs) expectServedPackShape(pack)

    const openClaw = packs.find((p: any) => p.packId === 'open-claw')
    expect(openClaw).toMatchObject({ name: 'OpenClaw', requiresRepos: false, requiresRdp: true, desktop: 'xfce' })
    // The four hardcoded `packId === 'open-claw'` checks in the old UI are these three fields.
    expect(openClaw.tools[0]).toHaveProperty('toolId')
    expect(openClaw.tools[0]).toHaveProperty('name')
    expect(openClaw.tools.some((t: any) => t.toolId === 'desktop-environment')).toBe(true)

    const claude = packs.find((p: any) => p.packId === 'ai-coding-agents')
    expect(claude).toMatchObject({ requiresRepos: true, requiresRdp: false })
    expect(claude.desktop).toBeUndefined()
  })

  it('calls every pack that shipped in the tarball official, and derives it from the file', async () => {
    // What the Surge Pack picker's Official tab is (rockysurf-jn71), and what ADR-0006 says the
    // word may mean: backed by a `packs/*.yaml`, which is the one field no registry writes.
    const packs = await json(await send('GET', '/api/v1/surge-packs', undefined, auth()))
    for (const pack of packs.filter((p: any) => SHIPPED_PACK_IDS.includes(p.packId))) {
      expect(pack.provenance, pack.packId).toBe('official')
    }
  })

  it('carries the pack guide and its bundled image, which is what the server page renders', async () => {
    // rockysurf-7ckx and rockysurf-di5z meet on this route: the server detail page reads both
    // off the PUBLIC list, so a field that stops being projected here is an empty panel there
    // and nothing else in either package would notice.
    //
    // Scoped to the SHIPPED packs, because `guide` and `imageUrl` are optional in schema.ts and
    // in docs/writing-a-pack.md. What the shipped six promise a user is stricter than what the
    // format requires of a contributor, and this is the stricter promise.
    const packs = await json(await send('GET', '/api/v1/surge-packs', undefined, auth()))
    for (const pack of packs.filter((p: any) => SHIPPED_PACK_IDS.includes(p.packId))) {
      expect(typeof pack.guide, `${pack.packId} has no guide`).toBe('string')
      // Bundled with the SPA, never fetched from a host the operator does not run.
      expect(pack.imageUrl, pack.packId).toMatch(/^\/images\/surge-packs\/.+\.png$/)
      // Honesty, mechanically: every shipped pack installs `gh`, and none of them leaves a
      // usable $GITHUB_TOKEN in the user's shell, so every shipped guide has to say how to log
      // in. It is a rule about what those six install, not a rule about packs — a pack that
      // does not install `gh` has no business saying it.
      expect(pack.guide, pack.packId).toContain('gh auth login')
    }
  })
})

describe('a seventh pack file changes nothing about the application', () => {
  /**
   * The promise `packs/README.md` and `docs/writing-a-pack.md` make out loud — a pack is data,
   * and adding one never means touching the application — asserted mechanically, because for a
   * while it was not true and nothing in this suite noticed (rockysurf-d5an). Three outside
   * contributors in a row wrote a valid pack and were told by CI that their pack was broken.
   *
   * The seventh pack is written to exactly the DOCUMENTED contract and nothing more: no
   * `imageUrl`, no `theme`, no `guide`, all three of which schema.ts calls optional. If any
   * assertion in this file ever grows past what the format requires, this test is what fails,
   * and it fails here rather than in a stranger's pull request.
   */
  const SEVENTH_PACK = `version: 1
pack:
  packId: zz-contributed-pack
  name: A Contributed Pack
  tools:
    - zz-contributed-tool
  displayOrder: 70
  enabled: true
tools:
  - toolId: zz-contributed-tool
    name: A Contributed Tool
    description: Installed by a pack nobody in this repository wrote
    category: base
    url: https://example.com/contributed
    installScript: |
      set -euo pipefail
      echo contributed
    enabled: true
    installOrder: 20
    bootstrap: false
    runAs: root
`

  it('is loaded, synced and served with the whole public contract intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-seventh-pack-'))
    try {
      for (const name of readdirSync(packsDir).filter((n) => n.endsWith('.yaml'))) {
        copyFileSync(join(packsDir, name), join(dir, name))
      }
      writeFileSync(join(dir, 'zz-contributed-pack.yaml'), SEVENTH_PACK)

      // A whole app over the enlarged directory — same boot path, no edit anywhere in `src/`.
      const seventh = await startApp(dir)
      try {
        const res = await seventh.app.app.request('/api/v1/surge-packs', {
          headers: { authorization: `Bearer ${seventh.token}` },
        })
        expect(res.status).toBe(200)
        const packs = (await res.json()) as any[]

        // Every assertion the shipped packs pass, the contributed one passes too...
        for (const pack of packs) expectServedPackShape(pack)
        const served = packs.map((p) => p.packId)
        expect(served.filter((id) => SHIPPED_PACK_IDS.includes(id))).toEqual(SHIPPED_PACK_IDS)
        expect(served).toContain('zz-contributed-pack')

        // ...while declaring none of the optional fields, and its tool is expanded like any other.
        const contributed = packs.find((p) => p.packId === 'zz-contributed-pack')
        expect(contributed.imageUrl).toBeUndefined()
        expect(contributed.guide).toBeUndefined()
        expect(contributed.theme).toBeUndefined()
        expect(contributed).toMatchObject({ name: 'A Contributed Pack', requiresRepos: false, requiresRdp: false })
        expect(contributed.tools).toEqual([
          {
            toolId: 'zz-contributed-tool',
            name: 'A Contributed Tool',
            description: 'Installed by a pack nobody in this repository wrote',
            category: 'base',
            url: 'https://example.com/contributed',
          },
        ])
      } finally {
        seventh.db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('admin tools CRUD', () => {
  /**
   * Named so no real tool can ever collide with it. The id is derived from the name, so a
   * fixture called `Ripgrep` claimed `ripgrep` — and the day a pack installed ripgrep, this
   * test's POST would have returned 409 instead of 201 and blamed the pack (rockysurf-d5an).
   * A fixture that occupies a plausible id is a trap laid for a contributor.
   */
  const NEW_TOOL = {
    name: 'Test Fixture Tool',
    description: 'Stands in for a tool an admin types into the form',
    category: 'base',
    url: 'https://example.com/test-fixture-tool',
    installScript: 'apt-get install -y test-fixture-tool\n',
    runAs: 'root',
  }
  const NEW_TOOL_ID = 'test-fixture-tool'

  it('creates, reads, updates and deletes', async () => {
    const createRes = await send('POST', '/api/v1/admin/tools', NEW_TOOL, auth())
    expect(createRes.status).toBe(201)
    const body = await json(createRes)
    // The id is derived from the name when not supplied, as the legacy handler did.
    expect(body.toolId).toBe(NEW_TOOL_ID)
    expect(body).toMatchObject({ enabled: true, installOrder: 100, bootstrap: false })

    expect((await json(await send('GET', `/api/v1/admin/tools/${NEW_TOOL_ID}`, undefined, auth()))).name).toBe(
      NEW_TOOL.name,
    )

    const updated = await json(
      await send('PUT', `/api/v1/admin/tools/${NEW_TOOL_ID}`, { installOrder: 15, enabled: false }, auth()),
    )
    expect(updated).toMatchObject({ installOrder: 15, enabled: false, name: NEW_TOOL.name })

    expect((await send('DELETE', `/api/v1/admin/tools/${NEW_TOOL_ID}`, undefined, auth())).status).toBe(204)
    expect((await send('GET', `/api/v1/admin/tools/${NEW_TOOL_ID}`, undefined, auth())).status).toBe(404)
  })

  it('rejects a duplicate id with 409', async () => {
    await send('POST', '/api/v1/admin/tools', NEW_TOOL, auth())
    const again = await send('POST', '/api/v1/admin/tools', NEW_TOOL, auth())
    expect(again.status).toBe(409)
    expect((await json(again)).error).toContain('already exists')
  })

  it('reports field-level validation errors', async () => {
    const res = await send('POST', '/api/v1/admin/tools', { ...NEW_TOOL, category: 'nonsense' }, auth())
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.code).toBe('bad_request')
    expect(body.issues.some((i: any) => i.path === 'category')).toBe(true)
  })

  it('refuses to delete a tool a pack still uses', async () => {
    const res = await send('DELETE', '/api/v1/admin/tools/claude-code', undefined, auth())
    expect(res.status).toBe(409)
    expect((await json(res)).error).toContain('ai-coding-agents')
  })

  it('shows disabled tools to admins but hides them from the public list', async () => {
    await send('PUT', '/api/v1/admin/tools/tmux', { enabled: false }, auth())
    const adminIds = (await json(await send('GET', '/api/v1/admin/tools', undefined, auth()))).map((t: any) => t.toolId)
    const publicIds = (await json(await send('GET', '/api/v1/tools', undefined, auth()))).map((t: any) => t.toolId)
    expect(adminIds).toContain('tmux')
    expect(publicIds).not.toContain('tmux')
  })
})

describe('admin packs CRUD', () => {
  it('creates a pack and validates its tool references', async () => {
    const missing = await send(
      'POST',
      '/api/v1/admin/surge-packs',
      { name: 'Test Fixture Broken Pack', tools: ['claude-code', 'no-such-tool'] },
      auth(),
    )
    expect(missing.status).toBe(400)
    expect((await json(missing)).error).toContain('Tools not found: no-such-tool')

    await send('PUT', '/api/v1/admin/tools/tmux', { enabled: false }, auth())
    const disabled = await send(
      'POST',
      '/api/v1/admin/surge-packs',
      { name: 'Test Fixture Disabled Pack', tools: ['tmux'] },
      auth(),
    )
    expect(disabled.status).toBe(400)
    expect((await json(disabled)).error).toContain('Cannot include disabled tools')

    // Same rule as the tool fixture above: the pack id is derived from the name, so the name
    // has to be one no pack file would ever use.
    const ok = await send(
      'POST',
      '/api/v1/admin/surge-packs',
      { name: 'Test Fixture Pack', tools: ['claude-code'] },
      auth(),
    )
    expect(ok.status).toBe(201)
    expect(await json(ok)).toMatchObject({
      packId: 'test-fixture-pack',
      tools: ['claude-code'],
      displayOrder: 100,
      enabled: true,
      requiresRepos: false,
      requiresRdp: false,
    })
  })

  it('rejects a duplicate pack id', async () => {
    const res = await send(
      'POST',
      '/api/v1/admin/surge-packs',
      { packId: 'open-claw', name: 'Clash', tools: ['claude-code'] },
      auth(),
    )
    expect(res.status).toBe(409)
  })
})

describe('export and import', () => {
  it('exports a pack as a loadable YAML file', async () => {
    const res = await send('GET', '/api/v1/admin/surge-packs/open-claw/export', undefined, auth())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('yaml')
    expect(res.headers.get('content-disposition')).toContain('open-claw.yaml')

    const text = await res.text()
    expect(text).toContain('version: 1')
    expect(text).toContain('packId: open-claw')
    expect(text).toContain('desktop: xfce')
  })

  it('round-trips: export, delete, import, and the pack comes back intact', async () => {
    const exported = await (await send('GET', '/api/v1/admin/surge-packs/open-claw/export', undefined, auth())).text()
    const before = await json(await send('GET', '/api/v1/admin/surge-packs/open-claw', undefined, auth()))

    expect((await send('DELETE', '/api/v1/admin/surge-packs/open-claw', undefined, auth())).status).toBe(204)
    expect((await send('GET', '/api/v1/admin/surge-packs/open-claw', undefined, auth())).status).toBe(404)

    const imported = await send('POST', '/api/v1/admin/surge-packs/import', { yaml: exported }, auth())
    expect(imported.status).toBe(200)

    const after = await json(imported)
    // Everything the pack IS survives the round trip...
    const { sourceFile: beforeSource, ...beforeFields } = before
    const { sourceFile: afterSource, ...afterFields } = after
    expect(afterFields).toEqual(beforeFields)

    // ...but where it CAME FROM does not, and should not. The original row was file-backed;
    // an imported one is a database row the operator can edit. Conflating the two would let
    // the UI offer an edit that the next boot sync silently overwrites (ADR-0004).
    expect(beforeSource).toBe('open-claw.yaml')
    expect(afterSource).toBeNull()

    // And the re-export is byte-identical to the first one.
    const again = await (await send('GET', '/api/v1/admin/surge-packs/open-claw/export', undefined, auth())).text()
    expect(again).toBe(exported)
  })

  it('rejects an invalid import with field-level errors', async () => {
    const res = await send('POST', '/api/v1/admin/surge-packs/import', { yaml: 'version: 9\npack: {}\n' }, auth())
    expect(res.status).toBe(400)
    expect((await json(res)).issues.length).toBeGreaterThan(0)
  })

  it('rejects an import body that is neither yaml nor url', async () => {
    expect((await send('POST', '/api/v1/admin/surge-packs/import', { nope: 1 }, auth())).status).toBe(400)
  })
})

describe('import from URL', () => {
  // These go through createApp with the REAL guard — no stub — which is the wiring proof
  // that the route actually calls it. Literal addresses are screened before any socket is
  // opened, so nothing here touches a network.
  it.each([
    'http://169.254.169.254/latest/meta-data/iam/',
    'http://127.0.0.1:8080/pack.yaml',
    'http://10.0.0.5/pack.yaml',
    'http://[::1]/pack.yaml',
  ])('refuses %s with a 400 from the SSRF guard', async (url) => {
    const res = await send('POST', '/api/v1/admin/surge-packs/import', { url }, auth())
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('not a public address')
  })

  // The guard refuses loopback — correctly, and that includes any local test server — so
  // the stubbed paths mount the routes standalone with fetchText injected, behind a
  // middleware that plays the app's authenticated-admin part.
  const importVia = async (fetchText: NonNullable<PackRoutesDeps['fetchText']>, url: string) => {
    const standalone = new Hono<AppEnv>()
    standalone.use('*', async (c, next) => {
      c.set('user', upsertUserByGithubId(opened.db, { githubId: 'gh:admin-stub', githubUsername: 'stub', isAdmin: true }))
      await next()
    })
    standalone.route('/', createPackRoutes({ db: opened.db, fetchText }))
    return standalone.request('/api/v1/admin/surge-packs/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  }

  it('imports the text the guarded fetch returns', async () => {
    const exported = await (await send('GET', '/api/v1/admin/surge-packs/open-claw/export', undefined, auth())).text()
    expect((await send('DELETE', '/api/v1/admin/surge-packs/open-claw', undefined, auth())).status).toBe(204)

    const res = await importVia(async (url) => {
      expect(url).toBe('https://packs.example.com/open-claw.yaml')
      return { ok: true, text: exported }
    }, 'https://packs.example.com/open-claw.yaml')
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).packId).toBe('open-claw')
  })

  it('surfaces the guard refusal reason for an unreachable URL', async () => {
    const res = await importVia(
      async () => ({ ok: false, reason: 'Could not resolve packs.example.com' }),
      'https://packs.example.com/x.yaml',
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('Could not resolve packs.example.com')
  })
})
