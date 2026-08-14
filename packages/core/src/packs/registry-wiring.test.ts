import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type CreatedApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { createRegistryClient } from './registry.js'
import { sha256Text } from './registry-index.js'
import type { SafeFetchResult } from './safe-fetch.js'

/**
 * The pack shop, through the whole application.
 *
 * CONTRIBUTING.md's rule, and this is the case it was written for: "if your change adds a
 * component that something else must wire up, add a test that boots the real thing and asserts
 * the seam". `registry-routes.test.ts` builds the routes itself, and that shape *cannot* see a
 * missing composition — it assembles what it is testing. This one calls `createApp`, signs in
 * over the real login route, and installs a pack from the registry into the picker.
 *
 * The claim being tested is the one from issue #9: **a pack from the registry appears without a
 * restart.** Everything else here is in service of it.
 */

const PASSWORD = 'correct-horse-battery-staple'

const PACK_YAML = `version: 1
pack:
  packId: rust-dev
  name: Rust Dev
  tools:
    - rustup
  displayOrder: 90
  enabled: true
tools:
  - toolId: rustup
    name: rustup
    description: The Rust toolchain installer
    category: base
    url: https://rustup.rs
    installScript: |
      curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh
    enabled: true
    installOrder: 30
    bootstrap: false
    runAs: root
`

const config: Config = configSchema.parse({})
const SOURCE = config.registry.sources[0]!
const INDEX = JSON.stringify({
  version: 1,
  generatedAt: '2026-08-14T00:00:00.000Z',
  packs: [
    {
      packId: 'rust-dev',
      name: 'Rust Dev',
      description: 'Installs 1 tool(s): rustup',
      path: 'packs/rust-dev.yaml',
      sha256: sha256Text(PACK_YAML),
      definesTools: ['rustup'],
      referencesTools: [],
      requiresRepos: false,
      requiresRdp: false,
    },
  ],
})

let opened: OpenedDatabase
let created: CreatedApp
let token: string
let fetchText: ReturnType<typeof vi.fn>

const send = (method: string, path: string) =>
  created.app.request(path, { method, headers: { authorization: `Bearer ${token}` } })

beforeEach(async () => {
  opened = openTestDatabase()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })

  // The real client, with only its fetch stubbed. The SSRF guard correctly refuses the loopback
  // a test server would live on, so a genuine HTTP round trip is not available here — the seam
  // under test is the wiring, and the guard has its own suite.
  const responses: Record<string, string> = {
    [`${SOURCE.url}/index.json`]: INDEX,
    [`${SOURCE.url}/packs/rust-dev.yaml`]: PACK_YAML,
  }
  fetchText = vi.fn(async (url: string): Promise<SafeFetchResult> => {
    const body = responses[url]
    return body === undefined ? { ok: false, reason: `Could not fetch ${url}` } : { ok: true, text: body }
  })

  created = createApp({
    db: opened.db,
    config,
    secrets,
    registry: createRegistryClient({ config: config.registry, fetchText: fetchText as never }),
  })

  const res = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  token = ((await res.json()) as { token: string }).token
})

afterEach(() => {
  opened.close()
  vi.restoreAllMocks()
})

describe('the pack shop, wired into the real app', () => {
  it('installs a registry pack into the server-create picker without a restart', async () => {
    // The whole of issue #9's runtime requirement, end to end through the composed app.
    expect(await (await send('GET', '/api/v1/surge-packs')).json()).toEqual([])

    const shop = (await (await send('GET', '/api/v1/admin/pack-registry')).json()) as {
      shelves: Array<{ packs: Array<{ packId: string }> }>
    }
    expect(shop.shelves[0]!.packs.map((p) => p.packId)).toEqual(['rust-dev'])

    const installed = await send(
      'POST',
      `/api/v1/admin/pack-registry/${encodeURIComponent(SOURCE.name)}/rust-dev/install`,
    )
    expect(installed.status).toBe(201)

    // Same process, no restart, no reload of anything.
    const packs = (await (await send('GET', '/api/v1/surge-packs')).json()) as Array<{
      packId: string
      tools: Array<{ toolId: string }>
    }>
    expect(packs.map((p) => p.packId)).toEqual(['rust-dev'])
    expect(packs[0]!.tools.map((t) => t.toolId)).toEqual(['rustup'])
  })

  it('serves the disclosure through the composed app', async () => {
    const res = await send('GET', `/api/v1/admin/pack-registry/${encodeURIComponent(SOURCE.name)}/rust-dev`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { disclosure: { rootStepCount: number; fetchesUrls: string[] } }
    expect(body.disclosure.rootStepCount).toBe(1)
    expect(body.disclosure.fetchesUrls).toContain('https://sh.rustup.rs')
  })

  it('requires admin, like every other route that can change what runs on a box', async () => {
    const res = await created.app.request('/api/v1/admin/pack-registry')
    expect(res.status).toBe(401)
  })

  it('builds a registry from config when none is injected, and does not fetch at startup', () => {
    // The default path, which the test above bypasses. Constructing the app must not put a
    // third party's outage on the startup path — a control plane with no route off the machine
    // has to start exactly as it did before this feature existed.
    const other = openTestDatabase()
    try {
      const app = createApp({ db: other.db, config, secrets: new MemorySecretStore() })
      expect(app.app).toBeDefined()
      // Nothing to assert about the network beyond this: the client that would do the fetching
      // is constructed lazily-fetching by design, and `registry.test.ts` pins that directly.
      expect(fetchText).not.toHaveBeenCalled()
    } finally {
      other.close()
    }
  })
})
