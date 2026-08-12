import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type CreatedApp } from './app.js'
import { ensureLocalAdmin } from './auth/admin.js'
import { MemorySecretStore } from './auth/secret-store.js'
import { configSchema, type Config } from './config/index.js'
import { openTestDatabase, type OpenedDatabase } from './db/client.js'

/**
 * Serving the SPA.
 *
 * The rule under test is the fallback boundary. A single-page app owns client-side routes, so
 * `/servers/srv-abc123` has to return `index.html` — otherwise a reload or a shared link 404s.
 * But that fallback must NOT swallow API paths: if it did, a typo'd endpoint would answer
 * `200 text/html`, and the client would fail while parsing HTML as JSON rather than reporting
 * the 404 that actually happened. That failure is genuinely hard to read from the client side,
 * which is why it is pinned here.
 */

const config: Config = configSchema.parse({})
const INDEX = '<!doctype html><title>Rocky Surf</title><div id="root"></div>'

let opened: OpenedDatabase
let publicDir: string
let created: CreatedApp

async function build(withBundle: boolean): Promise<CreatedApp> {
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: 'correct-horse-battery-staple' })
  return createApp({ db: opened.db, config, secrets, ...(withBundle ? { publicDir } : {}) })
}

beforeEach(() => {
  opened = openTestDatabase()
  publicDir = mkdtempSync(join(tmpdir(), 'rockysurf-spa-'))
  writeFileSync(join(publicDir, 'index.html'), INDEX)
  mkdirSync(join(publicDir, 'assets'), { recursive: true })
  writeFileSync(join(publicDir, 'assets', 'app.js'), 'console.log("hi")')
})

afterEach(() => {
  opened.close()
  rmSync(publicDir, { recursive: true, force: true })
})

describe('with a bundle wired in', () => {
  beforeEach(async () => {
    created = await build(true)
  })

  it('serves index.html at the root', async () => {
    const res = await created.app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="root"')
  })

  it('falls back to index.html for a client-side route, so a reload works', async () => {
    const res = await created.app.request('/servers/srv-abc123')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="root"')
  })

  it('does NOT swallow unknown API paths', async () => {
    // The bug this prevents: 200 text/html for a mistyped endpoint, which surfaces on the
    // client as a JSON parse error rather than as the 404 it is.
    for (const path of ['/api/v1/nope', '/internal/servers/x/nope']) {
      const res = await created.app.request(path)
      expect(res.status, path).not.toBe(200)
      expect(res.headers.get('content-type') ?? '', path).not.toContain('text/html')
    }
  })

  it('leaves /health answering as itself', async () => {
    const res = await created.app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('still refuses an unauthenticated API call rather than returning the shell', async () => {
    const res = await created.app.request('/api/v1/servers')
    expect(res.status).toBe(401)
  })
})

describe('without a bundle', () => {
  it('explains what is missing instead of 404ing', async () => {
    created = await build(false)
    const res = await created.app.request('/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('no web bundle is configured')
    expect(body).toContain('pnpm --filter @rockysurf/web build')
  })
})
