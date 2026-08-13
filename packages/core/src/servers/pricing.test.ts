import { ProviderError, type Offering } from '@rockysurf/provider-sdk'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { markBootstrapReady } from '../bootstrap/supervisor.js'
import { configSchema } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getServer } from '../db/repositories/servers.js'
import { servers } from '../db/schema.js'
import type { SpendTracker } from '../jobs/limits.js'
import { createUptimeTick } from '../jobs/uptime-ticker.js'
import { makeFakeProvider, type FakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createEventsService, type EventsService } from '../services/events.js'

/**
 * PRICING, END TO END THROUGH THE REAL ROUTE (rockysurf-dec8).
 *
 * The bug this file exists for: `lifecycle.create` never wrote a price, so every row this
 * product had ever created had `hourly_cost_amount` NULL. The uptime ticker skips unpriced
 * rows, so month-to-date spend was permanently zero; the spend cap compares against that zero,
 * so `limits.spendCap` could not refuse anything; `/api/v1/costs` counted the entire fleet as
 * unpriced; and every MCP tool result carried a spend context of zeroes. SECURITY.md's
 * "budget-capped credit card" was, until this landed, enforced by nothing.
 *
 * So these tests are deliberately AT THE WIRING LEVEL rather than against the lifecycle service
 * in isolation: a real `POST /api/v1/servers` against a real app, on all three body shapes the
 * product actually sends, and then the real ticker and the real limits enforcer that the app
 * built for itself. A unit test of `priceOffering` would have passed for a fix that was never
 * called.
 *
 * The one thing simulated is elapsed time — the clock the ticker reads, and the `startedAt`
 * that says how long the box has been up. Both prices and arithmetic are the product's own.
 */

const PASSWORD = 'correct-horse-battery-staple'

/**
 * First instant of the current UTC month, so a whole simulated month-to-date fits inside the
 * month the spend tracker baselined itself against on the real clock. Advancing hours from
 * `new Date()` instead would fold the accrual into next month's baseline — and read as zero
 * spend — for anyone running the suite in the last hours of a month.
 */
const monthStart = (): Date => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

interface CostsBody {
  monthToDate: { month: string; byCurrency: Record<string, number>; unpricedServers: number }
  cap: { overCap: boolean; amount?: number; currency?: string }
  servers: { id: string; hourlyCost: { amount: number; currency: string } | null; pricedAt: string | null }[]
}

let opened: OpenedDatabase
let events: EventsService
let app: ReturnType<typeof createApp>['app']
let spend: SpendTracker
let cookie: string
let base: Date

interface BuildOptions {
  spendCap?: { amount: number; currency: string }
  provider?: FakeProvider
}

async function build(options: BuildOptions = {}): Promise<FakeProvider> {
  const provider = options.provider ?? makeFakeProvider()
  opened = openTestDatabase()
  events = createEventsService()
  base = monthStart()

  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })

  const created = createApp({
    db: opened.db,
    config: configSchema.parse({ limits: options.spendCap ? { spendCap: options.spendCap } : {} }),
    secrets,
    events,
    providers: new ProviderRegistry([provider]),
  })
  app = created.app
  // The app's OWN tracker — the one its limits enforcer consults and `/costs` reads. A tracker
  // built here beside it would prove nothing about what a create actually checks.
  spend = created.jobs.spend

  const login = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  return provider
}

afterEach(() => {
  opened.close()
})

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function create(body: Record<string, unknown>): Promise<{ status: number; serverId?: string; body: Record<string, unknown> }> {
  const res = await post('/api/v1/servers', body)
  const parsed = (await res.json()) as Record<string, unknown>
  return {
    status: res.status,
    ...(typeof parsed['serverId'] === 'string' ? { serverId: parsed['serverId'] } : {}),
    body: parsed,
  }
}

const costs = async (): Promise<CostsBody> =>
  (await (await app.request('/api/v1/costs', { headers: { cookie } })).json()) as CostsBody

const row = (serverId: string) => getServer(opened.db, serverId)!

/**
 * Run a created box for `hours`, and let the real ticker accrue against the real price.
 *
 * `markBootstrapReady` is how a row legitimately reaches `running` — the push supervisor's own
 * entry point. The `startedAt` rewrite is the simulation: it says the box came up at the start
 * of the month, which is the only fact a test cannot wait for.
 */
async function runFor(serverId: string, hours: number): Promise<void> {
  await markBootstrapReady(opened.db, events, row(serverId))
  opened.db.update(servers).set({ startedAt: base.toISOString() }).where(eq(servers.id, serverId)).run()

  const tick = createUptimeTick({
    db: opened.db,
    events,
    spend,
    now: () => new Date(base.getTime() + hours * 3_600_000),
  })
  await tick()
}

/* ------------------------------------------------------- the row carries a price */

describe('every create path prices the row it writes', () => {
  it('prices a size-only create — the body the SPA sends', async () => {
    await build()
    const { status, serverId } = await create({ size: 'small', spotInstance: false })
    expect(status).toBe(201)

    // The route picked the cheapest AVAILABLE offering; the price is that offering's own.
    const created = row(serverId!)
    expect(created.offeringId).toBe('fake-small')
    expect(created.hourlyCostAmount).toBe(0.01)
    expect(created.hourlyCostCurrency).toBe('USD')
    expect(created.hourlyCostFetchedAt).toBe('2026-08-12T00:00:00Z')
  })

  it('prices an offeringId-explicit create identically, where the route does no lookup at all', async () => {
    // This is the path the old fix-in-the-route would have missed: naming an offering makes
    // `routes.ts` skip its own `listOfferings()` entirely.
    await build()
    const { status, serverId } = await create({ size: 'medium', offeringId: 'fake-medium', arch: 'amd64' })
    expect(status).toBe(201)

    expect(row(serverId!).hourlyCostAmount).toBe(0.04)
    expect(row(serverId!).hourlyCostCurrency).toBe('USD')
  })

  it('prices the MCP and CLI create, which send a name and a size and nothing else', async () => {
    await build()
    const { status, serverId } = await create({ name: 'agent-box', size: 'small' })
    expect(status).toBe(201)
    expect(row(serverId!).hourlyCostAmount).toBe(0.01)
  })

  it('reports the price back through /costs, per server and per currency', async () => {
    await build()
    const { serverId } = await create({ size: 'small' })

    const body = await costs()
    expect(body.servers.find((s) => s.id === serverId)?.hourlyCost).toEqual({ amount: 0.01, currency: 'USD' })
    expect(body.servers.find((s) => s.id === serverId)?.pricedAt).toBe('2026-08-12T00:00:00Z')
    expect(body.monthToDate.unpricedServers).toBe(0)
  })
})

/* ------------------------------------------------------------- honestly unpriced */

describe('a provider that quotes no price', () => {
  /** BYO's shape: one offering per registered host, `hourly: null` — unknown, never free. */
  const unpricedHost: Offering[] = [
    { id: 'fake-small', cpu: 2, memoryGb: 4, arch: 'arm64', hourly: null, available: true, region: 'fake-1' },
  ]

  it('creates the server anyway and counts it as unpriced rather than as zero', async () => {
    await build({ provider: makeFakeProvider({ offerings: unpricedHost }) })
    const { status, serverId } = await create({ size: 'small' })
    expect(status).toBe(201)

    const created = row(serverId!)
    expect(created.hourlyCostAmount).toBeNull()
    expect(created.hourlyCostCurrency).toBeNull()
    expect(created.hourlyCostFetchedAt).toBeNull()

    const body = await costs()
    expect(body.monthToDate.unpricedServers).toBe(1)
    // Not a zero in a currency bucket: an unpriced row has no currency to be zero in.
    expect(body.monthToDate.byCurrency).toEqual({})
  })

  it('accrues uptime for it without inventing a cost, and never trips the cap', async () => {
    await build({
      spendCap: { amount: 0.02, currency: 'USD' },
      provider: makeFakeProvider({ offerings: unpricedHost }),
    })
    const { serverId } = await create({ size: 'small' })
    await runFor(serverId!, 3)

    expect(row(serverId!).totalUptimeSeconds).toBe(3 * 3600)
    expect(row(serverId!).estimatedTotalCost).toBe(0)

    const body = await costs()
    expect(body.cap.overCap).toBe(false)
    expect(body.monthToDate.unpricedServers).toBe(1)
    // The fleet is invisible to the cap, so the cap must not refuse on its account either.
    expect((await create({ size: 'small', name: 'second' })).status).toBe(201)
  })

  it('survives a catalogue it cannot read, unpriced rather than failed', async () => {
    const provider = await build()
    provider.failNext('listOfferings', new ProviderError('unknown', 'pricing API unreachable'))

    // Naming the offering keeps the route from consuming the failure first, so the one that
    // fails is the pricing lookup on the create path.
    const { status, serverId } = await create({ size: 'small', offeringId: 'fake-small', arch: 'arm64' })
    expect(status).toBe(201)
    expect(row(serverId!).status).toBe('provisioning')
    expect(row(serverId!).hourlyCostAmount).toBeNull()
    expect((await costs()).monthToDate.unpricedServers).toBe(1)
  })
})

/* --------------------------------------------- uptime, month-to-date, and the cap */

describe('the spend cap, on spend that is really there', () => {
  it('turns uptime on a priced row into month-to-date spend', async () => {
    await build()
    const { serverId } = await create({ size: 'small' })
    // A priced row with no uptime yet: the currency bucket exists, at zero.
    expect((await costs()).monthToDate.byCurrency).toEqual({ USD: 0 })

    await runFor(serverId!, 1)

    // One hour at 0.01/hour. Before this fix the row was unpriced and this stayed 0 forever.
    expect(row(serverId!).estimatedTotalCost).toBeCloseTo(0.01, 6)
    expect((await costs()).monthToDate.byCurrency['USD']).toBeCloseTo(0.01, 6)
  })

  it('REFUSES a create once accrued spend reaches the cap', async () => {
    await build({ spendCap: { amount: 0.02, currency: 'USD' } })

    const first = await create({ size: 'small' })
    expect(first.status).toBe(201)
    // Under the cap, creates are unaffected.
    expect(spend.snapshot().overCap).toBe(false)

    await runFor(first.serverId!, 3) // 0.03 USD, past the 0.02 cap

    const refused = await create({ size: 'small', name: 'second' })
    expect(refused.status).toBe(403)
    expect(refused.body['code']).toBe('limit_exceeded')
    expect(refused.body['reason']).toBe('spend_cap')
    expect(String(refused.body['error'])).toContain('limits.spendCap')

    // And the running server is left alone, which is the other half of the doctrine.
    expect(row(first.serverId!).status).toBe('running')
    expect((await costs()).cap.overCap).toBe(true)
  })

  it('does not count a row against a cap in a different currency, and does not hide it either', async () => {
    // Amendment B2, at the seam: prices are stored in the currency the provider quotes and are
    // never converted. A USD fleet under a EUR cap is not refused — and it is not silently zero
    // either, it is reported in its own bucket.
    await build({ spendCap: { amount: 0.001, currency: 'EUR' } })
    const { serverId } = await create({ size: 'small' })
    await runFor(serverId!, 3)

    const body = await costs()
    expect(body.monthToDate.byCurrency['USD']).toBeCloseTo(0.03, 6)
    expect(body.monthToDate.byCurrency['EUR']).toBeUndefined()
    expect(body.cap.overCap).toBe(false)
    expect((await create({ size: 'small', name: 'second' })).status).toBe(201)
  })
})
