import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getServer } from '../db/repositories/servers.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createEventsService } from '../services/events.js'

/**
 * SAVED SSH PUBLIC KEYS, THROUGH THE REAL APP (issue #302).
 *
 * AT THE WIRING LEVEL, on the rule in CONTRIBUTING: the feature is a new hook on
 * `ServerRoutesDeps` that `createApp` has to supply from `currentConfig()`. A unit test of the
 * handler would pass with an app that never passes `savedSshKeys` at all — an empty picker on
 * every installation, and every unit test green — which is the exact failure
 * `docs/memories/2026-08-21-whole-boot-wiring-tests.md` was written about. So these build the
 * real app over a real parsed config and ask the real route.
 *
 * The second half is the point of the feature rather than the plumbing: a key CHOSEN from the
 * list has to reach a box by the same road a PASTED key does. It does — the SPA posts the
 * `sshPublicKey` string either way, so there is one create path and not two — and that is
 * asserted here rather than assumed, because "the picker fills the same field" is a claim about
 * the whole route, not about the picker.
 */

const PASSWORD = 'correct-horse-battery-staple'

const LAPTOP = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKPX6kWxlSdf7GU3Ve1I2dGGrKqdPBkR60OjKmHb9crV laptop'
const DESKTOP = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4nOEqLQMPa6QK8PPVoO7JVYqvvUEvFI0pOx1WLQO0k desktop'

let opened: OpenedDatabase
let app: ReturnType<typeof createApp>['app']
let cookie: string

async function build(keys: { name: string; publicKey: string }[]): Promise<void> {
  opened = openTestDatabase()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })

  const created = createApp({
    db: opened.db,
    config: configSchema.parse({ ssh: { keys } }),
    secrets,
    events: createEventsService(),
    providers: new ProviderRegistry([makeFakeProvider({ id: 'aws' })]),
  })
  app = created.app

  const login = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
}

afterEach(() => {
  opened.close()
})

async function listKeys(): Promise<{ name: string; publicKey: string }[]> {
  const res = await app.request('/api/v1/ssh-keys', { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as { name: string; publicKey: string }[]
}

describe('GET /api/v1/ssh-keys', () => {
  it('serves the keys the config file saved, name and all', async () => {
    await build([
      { name: 'laptop', publicKey: LAPTOP },
      { name: 'desktop', publicKey: DESKTOP },
    ])
    expect(await listKeys()).toEqual([
      { name: 'laptop', publicKey: LAPTOP },
      { name: 'desktop', publicKey: DESKTOP },
    ])
  })

  it('is an empty list on an installation that never saved one', async () => {
    await build([])
    expect(await listKeys()).toEqual([])
  })

  it('drops an entry nobody has typed a key into yet', async () => {
    // Settings' Add button writes `{ name, publicKey: '' }` before the person types. Offering
    // that as a choice would put a submit-time failure behind a menu item.
    await build([
      { name: 'not yet', publicKey: '' },
      { name: 'laptop', publicKey: LAPTOP },
    ])
    expect(await listKeys()).toEqual([{ name: 'laptop', publicKey: LAPTOP }])
  })

  it('needs a session, like everything else under /api/v1', async () => {
    await build([{ name: 'laptop', publicKey: LAPTOP }])
    expect((await app.request('/api/v1/ssh-keys')).status).toBe(401)
  })
})

describe('a key chosen from the list reaches the box the same way a pasted one does', () => {
  it('authorizes it on the server, appended after core own key', async () => {
    await build([{ name: 'laptop', publicKey: LAPTOP }])

    // What the New Server page posts once the picker has filled the field: the key itself, not
    // its name. The wire stays one anonymous string, so nothing downstream of this route — the
    // row, the plan, cloud-init, ADR-0008's retirement step — learned a new concept.
    const res = await app.request('/api/v1/servers', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ size: 'small', sshPublicKey: LAPTOP }),
    })
    expect(res.status).toBe(201)
    const { serverId } = (await res.json()) as { serverId: string }
    expect(getServer(opened.db, serverId)?.userSuppliedPublicKey).toBe(LAPTOP)
  })

  it('still refuses a private key at create time, whatever a picker may have been offering', async () => {
    await build([{ name: 'laptop', publicKey: LAPTOP }])
    const res = await app.request('/api/v1/servers', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        size: 'small',
        sshPublicKey: '-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEA',
      }),
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toMatch(/PRIVATE key/)
  })
})
