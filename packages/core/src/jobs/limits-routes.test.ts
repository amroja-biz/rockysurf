import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'

/**
 * The limits contract as a caller sees it: a refused create is a 403 naming the limit, not a
 * 500 and not a silent success. This is the half of rockysurf-55fx.6 that a user actually
 * meets.
 */

const PASSWORD = 'correct-horse-battery-staple'

let opened: OpenedDatabase
let app: ReturnType<typeof createApp>['app']
let cookie: string

const CREATE = { size: 'small' as const, name: 'dev-box' }

async function build(config: Config): Promise<void> {
  opened = openTestDatabase()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })

  app = createApp({
    db: opened.db,
    config,
    secrets,
    providers: new ProviderRegistry([makeFakeProvider()]),
  }).app

  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

const createServer = (body: Record<string, unknown> = CREATE) =>
  app.request('/api/v1/servers', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

afterEach(() => {
  opened.close()
})

describe('maxServers at the route', () => {
  beforeEach(async () => {
    await build(configSchema.parse({ limits: { maxServers: 1 } }))
  })

  it('allows the first create and refuses the second with 403 and a reason', async () => {
    expect((await createServer()).status).toBe(201)

    const refused = await createServer({ ...CREATE, name: 'second' })
    expect(refused.status).toBe(403)

    const body = (await refused.json()) as { code: string; reason: string; error: string }
    expect(body.code).toBe('limit_exceeded')
    expect(body.reason).toBe('max_servers')
    // The message has to tell the user what to do about it, not just that they cannot.
    expect(body.error).toContain('limits.maxServers')
  })
})

describe('createRatePerHour at the route', () => {
  beforeEach(async () => {
    await build(configSchema.parse({ limits: { maxServers: 50, createRatePerHour: 2 } }))
  })

  it('refuses once the hourly create budget is spent', async () => {
    expect((await createServer({ ...CREATE, name: 'one' })).status).toBe(201)
    expect((await createServer({ ...CREATE, name: 'two' })).status).toBe(201)

    const refused = await createServer({ ...CREATE, name: 'three' })
    expect(refused.status).toBe(403)
    expect((await refused.json())).toMatchObject({ reason: 'create_rate' })
  })
})

describe('spend cap at the route', () => {
  it('does not refuse anything while spend is under the cap', async () => {
    await build(configSchema.parse({ limits: { spendCap: { amount: 1000, currency: 'USD' } } }))
    expect((await createServer()).status).toBe(201)
  })
})
