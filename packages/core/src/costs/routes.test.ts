import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type CreatedApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { insertServer } from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { servers as serversTable } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const PASSWORD = 'correct-horse-battery-staple'

let opened: OpenedDatabase
let created: CreatedApp
let token: string
let adminId: string

async function build(config: Config): Promise<void> {
  const secrets = new MemorySecretStore()
  const admin = await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  adminId = admin.user.id
  created = createApp({ db: opened.db, config, secrets })
  const res = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  token = ((await res.json()) as { token: string }).token
}

/** A server with a price and some accrued uptime, as the uptime ticker would leave it. */
function seedPriced(options: {
  userId?: string
  name?: string
  provider?: string
  currency?: string | null
  hourly?: number
  cost?: number
  uptime?: number
  fetchedAt?: string
}): string {
  const row = insertServer(opened.db, {
    userId: options.userId ?? adminId,
    name: options.name ?? 'dev-box',
    provider: options.provider ?? 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
  })
  opened.db
    .update(serversTable)
    .set({
      hourlyCostAmount: options.currency === null ? null : (options.hourly ?? 0.05),
      hourlyCostCurrency: options.currency === null ? null : (options.currency ?? 'USD'),
      hourlyCostFetchedAt: options.currency === null ? null : (options.fetchedAt ?? '2026-08-10T21:57:58Z'),
      totalUptimeSeconds: options.uptime ?? 3600,
      estimatedTotalCost: options.cost ?? 0.05,
    })
    .where(eq(serversTable.id, row.id))
    .run()
  return row.id
}

const costs = async () =>
  (await created.app.request('/api/v1/costs', { headers: { authorization: `Bearer ${token}` } })).json() as Promise<{
    monthToDate: { month: string; byCurrency: Record<string, number>; unpricedServers: number }
    lifetime: { byCurrency: Record<string, number> }
    limits: { maxServers: number; spendCap: { amount: number; currency: string } | null }
    cap: { overCap: boolean; amount?: number; currency?: string; fraction?: number }
    servers: { id: string; estimatedTotalCost: number; hourlyCost: unknown; pricedAt: string | null }[]
    pricedAtByProvider: Record<string, string>
    estimateNote: string
  }>

beforeEach(() => {
  opened = openTestDatabase()
})

afterEach(() => {
  opened.close()
})

describe('GET /api/v1/costs', () => {
  it('requires a session', async () => {
    await build(configSchema.parse({}))
    expect((await created.app.request('/api/v1/costs')).status).toBe(401)
  })

  it('reports per-server and fleet totals from row data', async () => {
    await build(configSchema.parse({}))
    seedPriced({ name: 'a', cost: 1.5, uptime: 7200 })
    seedPriced({ name: 'b', cost: 2.25, uptime: 3600 })

    const body = await costs()
    expect(body.servers).toHaveLength(2)
    expect(body.lifetime.byCurrency['USD']).toBeCloseTo(3.75)
    expect(body.servers[0]!.pricedAt).toBe('2026-08-10T21:57:58Z')
  })

  it('never sums across currencies', async () => {
    // A EUR project and a USD account cannot be added honestly (amendment B2); a single total
    // would be inventing an exchange rate.
    await build(configSchema.parse({}))
    seedPriced({ name: 'usd', currency: 'USD', cost: 10 })
    seedPriced({ name: 'eur', currency: 'EUR', cost: 5, provider: 'hetzner' })

    const body = await costs()
    expect(body.lifetime.byCurrency).toEqual({ USD: 10, EUR: 5 })
  })

  it('surfaces servers the provider quoted no price for', async () => {
    await build(configSchema.parse({}))
    seedPriced({ name: 'free-mystery', currency: null })

    const body = await costs()
    // A cap that silently ignores part of the fleet is worse than no cap, so the count is
    // reported rather than hidden.
    expect(body.monthToDate.unpricedServers).toBeGreaterThanOrEqual(1)
    expect(body.servers[0]!.hourlyCost).toBeNull()
  })

  it('reports the configured limits, read-only', async () => {
    await build(configSchema.parse({ limits: { maxServers: 3, spendCap: { amount: 50, currency: 'usd' } } }))
    const body = await costs()
    expect(body.limits.maxServers).toBe(3)
    expect(body.limits.spendCap).toEqual({ amount: 50, currency: 'USD' })
  })

  it('reports no cap when none is configured', async () => {
    await build(configSchema.parse({}))
    const body = await costs()
    expect(body.limits.spendCap).toBeNull()
    expect(body.cap.overCap).toBe(false)
    expect(body.cap.fraction).toBeUndefined()
  })

  it('reports the price provenance per provider', async () => {
    await build(configSchema.parse({}))
    seedPriced({ provider: 'aws', fetchedAt: '2026-08-01T00:00:00Z' })
    seedPriced({ provider: 'aws', fetchedAt: '2026-08-10T21:57:58Z' })
    seedPriced({ provider: 'hetzner', fetchedAt: '2026-08-12T00:00:00Z' })

    const body = await costs()
    // The most recent fetch per provider — what the UI's honesty line is built from.
    expect(body.pricedAtByProvider['aws']).toBe('2026-08-10T21:57:58Z')
    expect(body.pricedAtByProvider['hetzner']).toBe('2026-08-12T00:00:00Z')
  })

  it('says the estimates round down', async () => {
    await build(configSchema.parse({}))
    expect((await costs()).estimateNote).toMatch(/round down/i)
  })

  it("does not leak another user's spend", async () => {
    await build(configSchema.parse({}))
    const stranger = upsertUserByGithubId(opened.db, { githubId: '99', githubUsername: 'stranger' }).id
    seedPriced({ userId: stranger, name: 'theirs', cost: 99 })
    seedPriced({ name: 'mine', cost: 1 })

    const body = await costs()
    expect(body.servers).toHaveLength(1)
    expect(body.lifetime.byCurrency['USD']).toBeCloseTo(1)
  })

  it('carries no payment surface of any kind', async () => {
    // The acceptance criterion, asserted rather than eyeballed: no Stripe, no portal, no
    // subscription, no invoice anywhere in the response.
    await build(configSchema.parse({}))
    seedPriced({})
    const raw = JSON.stringify(await costs()).toLowerCase()
    for (const word of ['stripe', 'portal', 'subscription', 'invoice', 'payment', 'card', 'checkout']) {
      expect(raw).not.toContain(word)
    }
  })
})
