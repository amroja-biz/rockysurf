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
 * reason they look like this is that `frontend/src/lib/api.ts` already parses them — a
 * "close enough" shape is a broken SPA port.
 */

const PASSWORD = 'correct-horse-battery-staple'
const packsDir = fileURLToPath(new URL('../../../../packs/', import.meta.url))
const config: Config = configSchema.parse({})

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

beforeEach(async () => {
  opened = openTestDatabase()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  syncPacksToDb(opened.db, loadPacksFromDir(packsDir))
  created = createApp({ db: opened.db, config, secrets })

  const res = await send('POST', '/api/v1/auth/login', { password: PASSWORD })
  token = (await json(res)).token
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
    expect(packs.map((p: any) => p.packId)).toEqual([
      'ai-coding-agents',
      'amp-agents',
      'codex-cli',
      'gas-town',
      'open-claw',
    ])

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
})

describe('admin tools CRUD', () => {
  const NEW_TOOL = {
    name: 'Ripgrep',
    description: 'Fast recursive search',
    category: 'base',
    url: 'https://github.com/BurntSushi/ripgrep',
    installScript: 'apt-get install -y ripgrep\n',
    runAs: 'root',
  }

  it('creates, reads, updates and deletes', async () => {
    const createRes = await send('POST', '/api/v1/admin/tools', NEW_TOOL, auth())
    expect(createRes.status).toBe(201)
    const body = await json(createRes)
    // The id is derived from the name when not supplied, as the legacy handler did.
    expect(body.toolId).toBe('ripgrep')
    expect(body).toMatchObject({ enabled: true, installOrder: 100, bootstrap: false })

    expect((await json(await send('GET', '/api/v1/admin/tools/ripgrep', undefined, auth()))).name).toBe('Ripgrep')

    const updated = await json(
      await send('PUT', '/api/v1/admin/tools/ripgrep', { installOrder: 15, enabled: false }, auth()),
    )
    expect(updated).toMatchObject({ installOrder: 15, enabled: false, name: 'Ripgrep' })

    expect((await send('DELETE', '/api/v1/admin/tools/ripgrep', undefined, auth())).status).toBe(204)
    expect((await send('GET', '/api/v1/admin/tools/ripgrep', undefined, auth())).status).toBe(404)
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
      { name: 'Broken', tools: ['claude-code', 'no-such-tool'] },
      auth(),
    )
    expect(missing.status).toBe(400)
    expect((await json(missing)).error).toContain('Tools not found: no-such-tool')

    await send('PUT', '/api/v1/admin/tools/tmux', { enabled: false }, auth())
    const disabled = await send(
      'POST',
      '/api/v1/admin/surge-packs',
      { name: 'Also broken', tools: ['tmux'] },
      auth(),
    )
    expect(disabled.status).toBe(400)
    expect((await json(disabled)).error).toContain('Cannot include disabled tools')

    const ok = await send('POST', '/api/v1/admin/surge-packs', { name: 'Minimal', tools: ['claude-code'] }, auth())
    expect(ok.status).toBe(201)
    expect(await json(ok)).toMatchObject({
      packId: 'minimal',
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
