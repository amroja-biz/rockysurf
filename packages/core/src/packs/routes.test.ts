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
import { deletePack, deleteTool } from '../db/repositories/packs.js'
import { issueSession } from '../auth/sessions.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { loadPacksFromDir } from './loader.js'
import { sha256Text } from './registry-index.js'
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
  // The one optional field that is a number, not a string (rockysurf-bbmi).
  if ('webPort' in pack) expect(typeof pack.webPort, `${pack.packId}.webPort`).toBe('number')
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
  it('GET /api/v1/tools returns exactly the six public fields', async () => {
    const tools = await json(await send('GET', '/api/v1/tools', undefined, auth()))
    expect(tools.length).toBeGreaterThan(0)
    for (const t of tools) {
      /**
       * SIX SINCE ISSUE #295, and the sixth earned its place rather than drifted in.
       * `alwaysInstall` is what lets the create page say "also installed, whichever pack you
       * pick" — without it a page listing a pack's tools understates what is about to run as
       * root on the box, and this repository's whole posture on packs is that what will run is
       * disclosed before it runs.
       *
       * It is on THIS list and deliberately not on the tools embedded in a served pack, whose
       * five-key shape `expectServedPackShape` still pins above: whether a tool also installs
       * on boxes built from other packs is a fact about the installation, not about the pack.
       */
      expect(Object.keys(t).sort()).toEqual([
        'alwaysInstall',
        'category',
        'description',
        'name',
        'toolId',
        'url',
      ])
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

    // The web-UI port crosses to the SPA when declared and is absent otherwise — the field
    // the server page renders the tunnel from (rockysurf-bbmi).
    const deepseek = packs.find((p: any) => p.packId === 'deepseek-harness')
    expect(deepseek).toMatchObject({ webPort: 3080 })
    expect(claude.webPort).toBeUndefined()
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

  it('records the URL it came from, so the row does not read as one somebody typed here', async () => {
    // Issue #88. A pack fetched from off this machine and a pack created in the admin form used
    // to be the same row — `local`, "created here" — which is false about the first, and false
    // in the direction an operator cares about: this is shell that will run as root on a box.
    const exported = await (await send('GET', '/api/v1/admin/surge-packs/open-claw/export', undefined, auth())).text()
    expect((await send('DELETE', '/api/v1/admin/surge-packs/open-claw', undefined, auth())).status).toBe(204)

    const url = 'https://packs.example.com/open-claw.yaml'
    const res = await importVia(async () => ({ ok: true, text: exported }), url)
    const body = (await res.json()) as any
    expect(body.registry).toMatchObject({
      source: 'a URL import',
      url,
      sha256: sha256Text(exported),
      // Never one of the labels an operator wrote next to a source they configured, and never
      // `official`: a one-off fetch has no such line anywhere.
      trust: 'unverified',
    })
  })

  it('records nothing for a pasted file, because there is nothing true to record', async () => {
    const exported = await (await send('GET', '/api/v1/admin/surge-packs/open-claw/export', undefined, auth())).text()
    expect((await send('DELETE', '/api/v1/admin/surge-packs/open-claw', undefined, auth())).status).toBe(204)

    const res = await send('POST', '/api/v1/admin/surge-packs/import', { yaml: exported }, auth())
    expect(res.status).toBe(200)
    expect((await json(res)).registry).toBeNull()
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

/**
 * `inputs` SURVIVES EVERY PATH IT HAS TO (issue #189, ADR-0013).
 *
 * A new pack field is only real if it makes the whole trip: YAML file → database row → public
 * API → back to YAML. Each hop has its own mapping written by hand (`sync.ts`, `packs.ts`'s
 * hydrate/upsert, `packFields`, `renderPackFile`), so a field that is added to the schema and
 * forgotten in one of them typechecks, ships, and silently asks the user for nothing.
 */
describe('a pack that declares inputs (issue #189)', () => {
  const YAML_WITH_INPUTS = [
    'version: 1',
    'pack:',
    '  packId: headlong',
    '  name: Headlong',
    '  tools:',
    '    - headlong',
    '  displayOrder: 50',
    '  enabled: true',
    '  requiresRepos: false',
    '  requiresRdp: false',
    '  inputs:',
    '    - name: HEADLONG_HEADLESS',
    '      label: Headless install',
    '      description: Install without Docker.',
    '      required: true',
    '      default: "1"',
    '    - name: HEADLONG_API_KEY',
    '      label: Headlong API key',
    '      secret: true',
    'tools:',
    '  - toolId: headlong',
    '    name: Headlong',
    '    description: Headlong',
    '    category: agent',
    '    url: https://example.test/headlong',
    '    installScript: |',
    '      set -euo pipefail',
    '      echo "$HEADLONG_HEADLESS"',
    '    enabled: true',
    '    installOrder: 40',
    '    bootstrap: false',
    '    runAs: rocky',
    '',
  ].join('\n')

  it('reaches the public list, which is what the create form builds its fields from', async () => {
    expect((await send('POST', '/api/v1/admin/surge-packs/import', { yaml: YAML_WITH_INPUTS }, auth())).status).toBe(200)

    const packs = (await json(await send('GET', '/api/v1/surge-packs', undefined, auth()))) as Array<Record<string, unknown>>
    const headlong = packs.find((p) => p['packId'] === 'headlong')!
    expect(headlong['inputs']).toEqual([
      {
        name: 'HEADLONG_HEADLESS',
        label: 'Headless install',
        description: 'Install without Docker.',
        required: true,
        secret: false,
        default: '1',
      },
      { name: 'HEADLONG_API_KEY', label: 'Headlong API key', required: false, secret: true },
    ])
  })

  it('is absent, not empty, on a pack that asks for nothing', async () => {
    const packs = (await json(await send('GET', '/api/v1/surge-packs', undefined, auth()))) as Array<Record<string, unknown>>
    expect('inputs' in packs.find((p) => p['packId'] === 'open-claw')!).toBe(false)
  })

  it('round-trips back out to YAML that re-imports identically', async () => {
    await send('POST', '/api/v1/admin/surge-packs/import', { yaml: YAML_WITH_INPUTS }, auth())
    const exported = await (await send('GET', '/api/v1/admin/surge-packs/headlong/export', undefined, auth())).text()
    expect(exported).toContain('HEADLONG_HEADLESS')
    expect(exported).toContain('secret: true')

    expect((await send('POST', '/api/v1/admin/surge-packs/import', { yaml: exported }, auth())).status).toBe(200)
    const again = await (await send('GET', '/api/v1/admin/surge-packs/headlong/export', undefined, auth())).text()
    expect(again).toBe(exported)
  })

  it('survives an admin edit that says nothing about inputs', async () => {
    // The admin pack editor has no inputs control and sends none. Without the `?? existing`
    // fallback on the PUT, renaming a pack there would silently delete its declaration and
    // break the create form for it.
    await send('POST', '/api/v1/admin/surge-packs/import', { yaml: YAML_WITH_INPUTS }, auth())
    const res = await send('PUT', '/api/v1/admin/surge-packs/headlong', { name: 'Headlong 2' }, auth())
    expect(res.status).toBe(200)

    const packs = (await json(await send('GET', '/api/v1/surge-packs', undefined, auth()))) as Array<Record<string, unknown>>
    const headlong = packs.find((p) => p['packId'] === 'headlong')!
    expect(headlong['name']).toBe('Headlong 2')
    expect((headlong['inputs'] as unknown[]).length).toBe(2)
  })

  it('refuses a pack whose input claims a name Rocky Surf already exports', async () => {
    const bad = YAML_WITH_INPUTS.replace('name: HEADLONG_HEADLESS', 'name: GITHUB_TOKEN')
    const res = await send('POST', '/api/v1/admin/surge-packs/import', { yaml: bad }, auth())
    expect(res.status).toBe(400)
    expect(JSON.stringify((await json(res)).issues)).toMatch(/already exports/)
  })
})

/**
 * Sharing ONE tool between installations (issue #289, ADR-0018).
 *
 * The pack export/import above shares a whole box. This shares the unit people actually trade:
 * "here is how I install my linter." The tests that matter are the ones about what may NOT
 * happen — a file-backed row overwritten, a pack file misread as a tool file, a URL fetched
 * through anything but the SSRF guard, or a URL import that forgets where it came from
 * (issue #299 adds the arm and the provenance it records).
 */
describe('tool export and import', () => {
  const TOOL_YAML = [
    'version: 1',
    'tools:',
    '  - toolId: acme-linter',
    '    name: Acme Linter',
    '    description: Lints the things',
    '    category: base',
    '    url: https://example.com/acme',
    '    installOrder: 40',
    '    runAs: root',
    '    bootstrap: false',
    '    enabled: true',
    '    installScript: |',
    '      set -euo pipefail',
    '      acme --version >/dev/null',
    '',
  ].join('\n')

  it('exports a personal tool as a downloadable tool file', async () => {
    await send('POST', '/api/v1/admin/tools/import', { yaml: TOOL_YAML }, auth())

    const res = await send('GET', '/api/v1/admin/tools/acme-linter/export', undefined, auth())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/yaml')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="acme-linter.yaml"')

    const text = await res.text()
    expect(text).toContain('toolId: acme-linter')
    expect(text).not.toContain('pack:')
    // Provenance is this installation's fact about its own disk; it must not travel.
    expect(text).not.toContain('sourceFile')
    expect(text).not.toContain('alwaysInstall')
  })

  it('exports a file-backed tool too — those bytes are already public in the repository', async () => {
    const res = await send('GET', '/api/v1/admin/tools/git/export', undefined, auth())
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('sourceFile')
  })

  it('404s for a tool that does not exist', async () => {
    expect((await send('GET', '/api/v1/admin/tools/nope/export', undefined, auth())).status).toBe(404)
  })

  it('imports a tool as personal — null sourceFile, so boot never touches it', async () => {
    const res = await send('POST', '/api/v1/admin/tools/import', { yaml: TOOL_YAML }, auth())
    expect(res.status).toBe(201)

    const tools = (await json(await send('GET', '/api/v1/admin/tools', undefined, auth()))) as any[]
    const imported = tools.find((t) => t.toolId === 'acme-linter')
    expect(imported.name).toBe('Acme Linter')
    expect(imported.sourceFile).toBeUndefined()
  })

  it('round-trips across installations byte for byte', async () => {
    await send('POST', '/api/v1/admin/tools/import', { yaml: TOOL_YAML }, auth())
    const exported = await (await send('GET', '/api/v1/admin/tools/acme-linter/export', undefined, auth())).text()

    // A second installation, holding only the bytes.
    const other = await startApp(packsDir)
    const post = await other.app.app.request('/api/v1/admin/tools/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${other.token}` },
      body: JSON.stringify({ yaml: exported }),
    })
    expect(post.status).toBe(201)

    const reExported = await (
      await other.app.app.request('/api/v1/admin/tools/acme-linter/export', {
        headers: { authorization: `Bearer ${other.token}` },
      })
    ).text()
    expect(reExported).toBe(exported)
    other.db.close()
  })

  /**
   * THE REFUSAL THAT MATTERS MOST. A file-backed row belongs to the boot reconcile (ADR-0004),
   * so an import allowed to win here would be undone at the next restart — the operator would
   * watch their tool "work" and then quietly revert. A 409 that explains itself beats that.
   */
  it('refuses to overwrite a tool that comes from a pack file', async () => {
    const collide = TOOL_YAML.replace('acme-linter', 'git')
    const res = await send('POST', '/api/v1/admin/tools/import', { yaml: collide }, auth())
    expect(res.status).toBe(409)
    const body = await json(res)
    expect(body.code).toBe('conflict')
    expect(body.error).toContain('git')
    expect(body.error).toContain('pack file')

    // And the shipped definition is untouched.
    const tool = await json(await send('GET', '/api/v1/admin/tools/git', undefined, auth()))
    expect(tool.name).not.toBe('Acme Linter')
  })

  it('replaces a personal tool of the same id, which is what re-importing an edit means', async () => {
    await send('POST', '/api/v1/admin/tools/import', { yaml: TOOL_YAML }, auth())
    const edited = TOOL_YAML.replace('name: Acme Linter', 'name: Acme Linter 2')
    expect((await send('POST', '/api/v1/admin/tools/import', { yaml: edited }, auth())).status).toBe(201)

    const tool = await json(await send('GET', '/api/v1/admin/tools/acme-linter', undefined, auth()))
    expect(tool.name).toBe('Acme Linter 2')
  })

  it('tells someone who pasted a pack file which door to use', async () => {
    const packYaml = await (
      await send('GET', '/api/v1/admin/surge-packs/open-code/export', undefined, auth())
    ).text()
    const res = await send('POST', '/api/v1/admin/tools/import', { yaml: packYaml }, auth())
    expect(res.status).toBe(400)
    expect(JSON.stringify((await json(res)).issues)).toContain('this is a pack file')
  })

  it('refuses bootstrap: true, which is the runtime’s to promise', async () => {
    const res = await send(
      'POST',
      '/api/v1/admin/tools/import',
      { yaml: TOOL_YAML.replace('bootstrap: false', 'bootstrap: true') },
      auth(),
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify((await json(res)).issues)).toContain('reserved')
  })

  /**
   * THE `url` ARM (issue #299), now that the `tools` table carries provenance columns. The
   * three tests below are the tool halves of the pack import's own URL suite: the guard is
   * really wired, the URL is recorded, and a paste records nothing.
   */

  // Real guard, no stub — the wiring proof that the route actually calls it. Literal private
  // addresses are screened before any socket opens, so nothing here touches a network.
  it.each([
    'http://169.254.169.254/latest/meta-data/iam/',
    'http://127.0.0.1:8080/tool.yaml',
    'http://10.0.0.5/tool.yaml',
    'http://[::1]/tool.yaml',
  ])('refuses %s with a 400 from the SSRF guard', async (url) => {
    const res = await send('POST', '/api/v1/admin/tools/import', { url }, auth())
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('not a public address')
  })

  // The guard refuses loopback — correctly — so the stubbed happy path mounts the routes
  // standalone with fetchText injected, behind a middleware playing the authenticated admin.
  const importToolVia = async (fetchText: NonNullable<PackRoutesDeps['fetchText']>, url: string) => {
    const standalone = new Hono<AppEnv>()
    standalone.use('*', async (c, next) => {
      c.set('user', upsertUserByGithubId(opened.db, { githubId: 'gh:tool-stub', githubUsername: 'stub', isAdmin: true }))
      await next()
    })
    standalone.route('/', createPackRoutes({ db: opened.db, fetchText }))
    return standalone.request('/api/v1/admin/tools/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  }

  it('imports the text the guarded fetch returns', async () => {
    const url = 'https://tools.example.com/acme-linter.yaml'
    const res = await importToolVia(async (u) => {
      expect(u).toBe(url)
      return { ok: true, text: TOOL_YAML }
    }, url)
    expect(res.status).toBe(201)
    expect(((await res.json()) as any)[0].toolId).toBe('acme-linter')
  })

  it('records the URL it came from, so the row does not read as one somebody typed here', async () => {
    // Issue #88 at tool granularity: a tool fetched from off this machine is root shell, and a
    // row that could not say where it came from was the reason ADR-0018 deferred this arm.
    const url = 'https://tools.example.com/acme-linter.yaml'
    const res = await importToolVia(async () => ({ ok: true, text: TOOL_YAML }), url)
    const body = (await res.json()) as any
    expect(body[0].registry).toMatchObject({
      source: 'a URL import',
      url,
      sha256: sha256Text(TOOL_YAML),
      // Never an operator-written label and never `official`: a one-off fetch has no such line.
      trust: 'unverified',
    })
  })

  it('surfaces the guard refusal reason for an unreachable URL', async () => {
    const res = await importToolVia(
      async () => ({ ok: false, reason: 'Could not resolve tools.example.com' }),
      'https://tools.example.com/x.yaml',
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('Could not resolve tools.example.com')
  })

  it('records nothing for a pasted file, because there is nothing true to record', async () => {
    const res = await send('POST', '/api/v1/admin/tools/import', { yaml: TOOL_YAML }, auth())
    expect(res.status).toBe(201)
    expect((await json(res))[0].registry).toBeNull()
  })

  it('requires admin', async () => {
    const user = upsertUserByGithubId(opened.db, { githubId: 'gh:3', githubUsername: 'someone' })
    const { token: userToken } = issueSession(opened.db, user.id)
    const headers = { authorization: `Bearer ${userToken}` }
    expect((await send('GET', '/api/v1/admin/tools/git/export', undefined, headers)).status).toBe(403)
    expect((await send('POST', '/api/v1/admin/tools/import', { yaml: TOOL_YAML }, headers)).status).toBe(403)
  })
})

/**
 * Forking a pack, and the record of where the fork came from (issue #295).
 *
 * The owner's model is a forked repository: an official pack is never edited in place, and
 * modifying one gives you a pack of your own. `derivedFromPackId` is the whole of what makes
 * that legible afterwards — without it a fork is just another personal pack, and the Surge
 * Packs page cannot say "you have your own version of this" on the official pack's card.
 */
describe('a personal pack that was forked from another (issue #295)', () => {
  const fork = (over: Record<string, unknown> = {}) => ({
    packId: 'my-agents',
    name: 'My agents',
    tools: ['claude-code'],
    requiresRepos: false,
    requiresRdp: false,
    derivedFromPackId: 'ai-coding-agents',
    ...over,
  })

  it('records the pack it was forked from, and serves it on both projections', async () => {
    const res = await send('POST', '/api/v1/admin/surge-packs', fork(), auth())
    expect(res.status).toBe(201)
    expect((await json(res)).derivedFromPackId).toBe('ai-coding-agents')

    const publicList = await json(await send('GET', '/api/v1/surge-packs', undefined, auth()))
    expect(publicList.find((p: any) => p.packId === 'my-agents').derivedFromPackId).toBe('ai-coding-agents')
  })

  it('refuses a parent that does not exist, and refuses itself', async () => {
    // Checked once, at create time — the same rule `servers.tools` moved to in #289, where
    // leniency was right for RENDERING an old row and wrong as the answer to a fresh request.
    const missing = await send('POST', '/api/v1/admin/surge-packs', fork({ derivedFromPackId: 'nope' }), auth())
    expect(missing.status).toBe(400)

    const itself = await send('POST', '/api/v1/admin/surge-packs', fork({ derivedFromPackId: 'my-agents' }), auth())
    expect(itself.status).toBe(400)
  })

  /**
   * THE BLOCKER THIS COLUMN WOULD OTHERWISE HAVE HIT. The admin pack PUT builds a whole row
   * from the form, so an `upsertPack` that assigned `derivedFromPackId` unconditionally would
   * erase it the first time somebody added a tool to their own fork — which is the single most
   * likely thing anyone will ever do to a fork, and the entire point of this issue.
   */
  it('keeps its parent when a tool is added to it later', async () => {
    await send('POST', '/api/v1/admin/surge-packs', fork(), auth())
    const res = await send('PUT', '/api/v1/admin/surge-packs/my-agents', { tools: ['claude-code', 'git'] }, auth())
    expect(res.status).toBe(200)
    expect((await json(res)).derivedFromPackId).toBe('ai-coding-agents')
  })

  it('survives its parent being deleted, keeping the id as the record', async () => {
    await send('POST', '/api/v1/admin/surge-packs', fork(), auth())
    // A release can drop a pack (#290 dropped one). The fork is a database row with a null
    // `sourceFile`, so nothing deletes it, and the dangling id is still the truth about where
    // it began — the UI checks before dereferencing rather than the column being cleared.
    deletePack(opened.db, 'ai-coding-agents')

    const res = await send('GET', '/api/v1/admin/surge-packs/my-agents', undefined, auth())
    expect(res.status).toBe(200)
    expect((await json(res)).derivedFromPackId).toBe('ai-coding-agents')
  })

  /**
   * PROVENANCE DOES NOT EXPORT — and the artwork goes with it (owner's ruling).
   *
   * On this installation a fork wears its parent's image with a delta over it. Neither half
   * travels: `derivedFromPackId` is not in `packSchema` and never was, so the recipient cannot
   * draw the delta — and official artwork with no delta, on an installation that never forked
   * anything, is a personal pack wearing a first-party face (ADR-0006).
   */
  it('exports neither the parent id nor the artwork it inherited', async () => {
    await send('POST', '/api/v1/admin/surge-packs', fork({ imageUrl: '/images/surge-packs/claude-code.png' }), auth())

    const res = await send('GET', '/api/v1/admin/surge-packs/my-agents/export', undefined, auth())
    expect(res.status).toBe(200)
    const yaml = await res.text()
    expect(yaml).not.toContain('derivedFromPackId')
    expect(yaml).not.toContain('imageUrl')
  })

  /**
   * THE OTHER HALF OF THE PREDICATE, and the one it would be easy to break by keying the strip
   * on the fork relationship instead. An official pack's export is how an operator sends a pack
   * upstream as a pull request (ADR-0004), so it must be the file that shipped — artwork
   * included. Stripping here would mean a contributed pack losing its image on the way to the
   * repository.
   */
  it('keeps a file-backed pack\'s own artwork, because that export is a pull request', async () => {
    const shipped = (await json(await send('GET', '/api/v1/admin/surge-packs', undefined, auth()))).find(
      (p: any) => p.sourceFile && p.imageUrl,
    )
    expect(shipped, 'a shipped pack with artwork').toBeTruthy()

    const yaml = await (
      await send('GET', `/api/v1/admin/surge-packs/${shipped.packId}/export`, undefined, auth())
    ).text()
    expect(yaml).toContain('imageUrl')
    expect(yaml).toContain(shipped.imageUrl)
  })

  /**
   * A pack IMPORTED from an official pack's export keeps the artwork too, even though it is not
   * file-backed and the path is root-relative. It was never forked here — the art arrived inside
   * the file the operator was handed, so it has already travelled legitimately, and stripping it
   * would break the export/import/re-export round trip while preventing nothing.
   */
  it("keeps artwork on a pack imported from an official pack's export", async () => {
    const yaml = await (
      await send('GET', '/api/v1/admin/surge-packs/open-claw/export', undefined, auth())
    ).text()
    expect(yaml).toContain('imageUrl')

    await send('DELETE', '/api/v1/admin/surge-packs/open-claw', undefined, auth())
    const imported = await json(await send('POST', '/api/v1/admin/surge-packs/import', { yaml }, auth()))
    // No longer file-backed, and no parent: it was imported, not forked.
    expect(imported.sourceFile).toBeNull()
    expect(imported.derivedFromPackId).toBeUndefined()

    const again = await (
      await send('GET', '/api/v1/admin/surge-packs/open-claw/export', undefined, auth())
    ).text()
    expect(again).toContain('imageUrl')
  })

  /**
   * A fork whose owner set their OWN artwork keeps it. The rule exists to stop borrowed
   * first-party art travelling, not to take away an image somebody chose and can serve.
   */
  it('keeps a personal pack\'s own absolute-url artwork', async () => {
    await send(
      'POST',
      '/api/v1/admin/surge-packs',
      fork({ packId: 'my-own-art', imageUrl: 'https://example.test/mine.png' }),
      auth(),
    )

    const yaml = await (
      await send('GET', '/api/v1/admin/surge-packs/my-own-art/export', undefined, auth())
    ).text()
    expect(yaml).toContain('https://example.test/mine.png')
  })

  /**
   * The pack file format has never heard of this field, and `strictObject` is what makes that
   * a loud refusal rather than a silently dropped promise — the same guarantee #298 pinned for
   * `alwaysInstall` on the tool file. A pack file cannot import a parentage it invented.
   */
  it('refuses a pack file that names derivedFromPackId', async () => {
    const yaml = [
      'version: 1',
      'pack:',
      '  packId: pretender',
      '  name: Pretender',
      '  derivedFromPackId: ai-coding-agents',
      '  tools:',
      '    - pretender-tool',
      '  displayOrder: 50',
      '  enabled: true',
      '  requiresRepos: false',
      '  requiresRdp: false',
      'tools:',
      '  - toolId: pretender-tool',
      '    name: Pretender Tool',
      '    description: Does nothing',
      '    category: base',
      '    url: https://example.test/pretender',
      '    installScript: |',
      '      set -euo pipefail',
      '      true',
      '    enabled: true',
      '    installOrder: 40',
      '    runAs: root',
      '    bootstrap: false',
      '',
    ].join('\n')
    const res = await send('POST', '/api/v1/admin/surge-packs/import', { yaml }, auth())
    expect(res.status).toBe(400)
    expect(JSON.stringify((await json(res)).issues)).toContain('derivedFromPackId')
  })
})

/**
 * "Install this tool on every box" as a REQUEST field (issue #295).
 *
 * The column is set through these routes and through no file, which is the whole design in one
 * sentence: `toolSchema` is untouched, so both file formats refuse the key by construction
 * (`tool-file.test.ts` pinned that before the column existed), and the two request bodies
 * `.extend()` it on instead.
 */
describe('alwaysInstall on the tool routes (issue #295)', () => {
  it('defaults to false, and can be set on create and on update', async () => {
    const created = await json(
      await send(
        'POST',
        '/api/v1/admin/tools',
        {
          name: 'House Style',
          description: 'every box',
          category: 'base',
          url: 'https://example.test/house',
          installScript: 'true',
          runAs: 'root',
        },
        auth(),
      ),
    )
    expect(created.alwaysInstall).toBe(false)

    const updated = await json(
      await send('PUT', `/api/v1/admin/tools/${created.toolId}`, { alwaysInstall: true }, auth()),
    )
    expect(updated.alwaysInstall).toBe(true)
  })

  /**
   * THE ONE FIELD OF A FILE-BACKED TOOL AN OPERATOR MAY SET, and the UI says so in as many
   * words. Everything else on a shipped tool is rewritten from its YAML at the next boot
   * (ADR-0004), so offering to edit it would be offering an edit that disappears. This is not
   * file content: no file format has it, and where a tool installs on THIS machine was never
   * the repository's to decide.
   */
  it('is settable on a file-backed tool, unlike everything else on it', async () => {
    const shipped = await json(await send('GET', '/api/v1/admin/tools', undefined, auth()))
    const fileBacked = shipped.find((t: any) => t.sourceFile)
    expect(fileBacked, 'a shipped tool to mark').toBeTruthy()

    const res = await send('PUT', `/api/v1/admin/tools/${fileBacked.toolId}`, { alwaysInstall: true }, auth())
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.alwaysInstall).toBe(true)
    // Still owned by its file — this changed where it installs, not what it is.
    expect(body.sourceFile).toBe(fileBacked.sourceFile)
  })

  /**
   * A ROUND TRIP LANDS ON FALSE, and that is the point rather than a rough edge. A tool file
   * says how to install something; "and put it on every box" is a decision the person
   * receiving it has not made. Exporting it would be this installation making a promise on
   * their behalf — so the export drops it, and the import cannot reinstate it because the
   * format has no such key.
   */
  it('is not carried by an exported tool file, and comes back false', async () => {
    await send(
      'POST',
      '/api/v1/admin/tools',
      {
        toolId: 'travelling-tool',
        name: 'Travelling Tool',
        description: 'goes places',
        category: 'base',
        url: 'https://example.test/travel',
        installScript: 'true',
        runAs: 'root',
        alwaysInstall: true,
      },
      auth(),
    )

    const yaml = await (await send('GET', '/api/v1/admin/tools/travelling-tool/export', undefined, auth())).text()
    expect(yaml).not.toContain('alwaysInstall')

    deleteTool(opened.db, 'travelling-tool')
    const reimported = await json(await send('POST', '/api/v1/admin/tools/import', { yaml }, auth()))
    expect(reimported[0].alwaysInstall).toBe(false)
  })

  it('appears on the public tool list, so the create page can disclose it', async () => {
    const shipped = await json(await send('GET', '/api/v1/admin/tools', undefined, auth()))
    const target = shipped.find((t: any) => t.enabled)
    await send('PUT', `/api/v1/admin/tools/${target.toolId}`, { alwaysInstall: true }, auth())

    const listed = await json(await send('GET', '/api/v1/tools', undefined, auth()))
    expect(listed.find((t: any) => t.toolId === target.toolId).alwaysInstall).toBe(true)
  })
})
