import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import {
  BILLING_INSTANCE_STATES,
  billingStatesFor,
  getProviderData,
  getServer,
  isBillingRow,
  listBillingServers,
  recordProviderState,
} from '../db/repositories/servers.js'
import { servers } from '../db/schema.js'
import { createUptimeTick } from '../jobs/uptime-ticker.js'
import { makeFakeProvider, type FakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createSecretsStore } from '../secrets/store.js'
import { createEventsService, type EventsService } from '../services/events.js'

/**
 * A STOPPED MACHINE ON A CLOUD THAT BILLS WHILE STOPPED KEEPS METERING (ADR-0025, issue #294).
 *
 * `BILLING_INSTANCE_STATES` used to say `stopped` is out "because compute billing ends there on
 * every provider core speaks to", and the first cloud the `adding-providers` skill was pointed
 * at — DigitalOcean, whose powered-off droplets bill at the full rate — made that sentence false.
 * The provider now says so through `capabilities.billsWhileStopped`, the lifecycle records it on
 * the row beside the provider's state, and everything that answers "is this machine costing
 * money" reads the row.
 *
 * The one case this suite exists for is the last one: the cloud is switched OFF in the config
 * while it still has a stopped, billing machine. The registry has no provider left to ask, and
 * the meter must keep running anyway — which is why the answer lives on the row and not in a
 * lookup.
 */

const PASSWORD = 'correct-horse-battery-staple'

const monthStart = (): Date => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

let opened: OpenedDatabase
let events: EventsService
let provider: FakeProvider
let registry: ProviderRegistry
let created: ReturnType<typeof createApp>
let cookie: string
let base: Date

async function build(billsWhileStopped: boolean): Promise<void> {
  opened = openTestDatabase()
  events = createEventsService()
  // The fake provider stops instantly, so one sync after `stop()` reads `stopped`.
  provider = makeFakeProvider(billsWhileStopped ? { capabilities: { billsWhileStopped: true } } : {})
  registry = new ProviderRegistry([provider])
  base = monthStart()

  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  created = createApp({
    db: opened.db,
    config: configSchema.parse({}),
    secrets,
    secretsStore: createSecretsStore(opened.db, randomBytes(32)),
    events,
    providers: registry,
  })

  const login = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
}

afterEach(() => {
  opened?.close()
})

const request = (path: string, init: RequestInit = {}) =>
  created.app.request(path, { ...init, headers: { cookie, 'content-type': 'application/json', ...init.headers } })

const row = (serverId: string) => getServer(opened.db, serverId)!

/**
 * Create a server, let the provider report it running, then stop it at the PROVIDER and sync —
 * the sequence that leaves `providerState: 'stopped'` on the row through the real lifecycle
 * (`recordProviderState` is only ever written from there).
 */
async function createAndStop(): Promise<string> {
  const res = await request('/api/v1/servers', { method: 'POST', body: JSON.stringify({ size: 'small', name: 'box' }) })
  const { serverId } = (await res.json()) as { serverId: string }
  await created.sync(row(serverId))
  expect(row(serverId).providerState).toBe('running')
  await provider.stop(getProviderData(row(serverId))!)
  await created.sync(row(serverId))
  expect(row(serverId).providerState).toBe('stopped')
  // Pull the anchor back to the start of the month so an accrual has something to measure.
  const at = base.toISOString()
  opened.db.run(`UPDATE servers SET billing_since = '${at}' WHERE id = '${serverId}'`)
  return serverId
}

/** Accrue as the real ticker would after `hours` of wall clock. Injected clock only (#284). */
async function accrueFor(hours: number): Promise<void> {
  const tick = createUptimeTick({
    db: opened.db,
    events,
    spend: created.jobs.spend,
    now: () => new Date(base.getTime() + hours * 3_600_000),
    log: () => {},
  })
  await tick()
}

describe('the per-row billing states', () => {
  it('are the base list unless the row says a stopped machine still bills', () => {
    expect(billingStatesFor({ billsWhileStopped: false })).toEqual(BILLING_INSTANCE_STATES)
    expect(billingStatesFor({ billsWhileStopped: true })).toEqual([...BILLING_INSTANCE_STATES, 'stopped'])
  })

  it('never puts stopped in the base list — that is the whole point of the flag', () => {
    expect(BILLING_INSTANCE_STATES).not.toContain('stopped')
  })
})

describe('a provider that bills while stopped', () => {
  it('has its answer recorded on the row by the lifecycle, and the row bills through stopped', async () => {
    await build(true)
    const serverId = await createAndStop()

    expect(row(serverId).billsWhileStopped).toBe(true)
    expect(isBillingRow(row(serverId))).toBe(true)
    expect(listBillingServers(opened.db).map((r) => r.id)).toContain(serverId)
  })

  it('tells every front end, through the one serializer, that the stopped machine is still billing', async () => {
    await build(true)
    const serverId = await createAndStop()

    const body = (await (await request(`/api/v1/servers/${serverId}`)).json()) as Record<string, unknown>
    expect(body['billing']).toMatchObject({ live: true, providerState: 'stopped' })
  })

  it('accrues cost while stopped', async () => {
    await build(true)
    const serverId = await createAndStop()
    const before = row(serverId).estimatedTotalCost

    await accrueFor(2)

    expect(row(serverId).totalUptimeSeconds).toBeGreaterThanOrEqual(7200)
    expect(row(serverId).estimatedTotalCost).toBeGreaterThan(before)
  })

  it('keeps accruing after the cloud is switched off in the config, because the row remembers', async () => {
    await build(true)
    const serverId = await createAndStop()

    // `enabled: false` on the provider: composition rebuilds the registry without it. There is
    // now nothing to ask about this cloud — and the meter must not stop.
    registry.replaceWith(new ProviderRegistry([]))
    expect(registry.has('fake')).toBe(false)

    await accrueFor(1)
    expect(row(serverId).totalUptimeSeconds).toBeGreaterThanOrEqual(3600)
    expect(isBillingRow(row(serverId))).toBe(true)
  })
})

describe('a provider that says nothing (every shipped cloud)', () => {
  it('stops the meter at stopped, exactly as before', async () => {
    await build(false)
    const serverId = await createAndStop()

    expect(row(serverId).billsWhileStopped).toBe(false)
    expect(isBillingRow(row(serverId))).toBe(false)
    expect(listBillingServers(opened.db).map((r) => r.id)).not.toContain(serverId)

    const body = (await (await request(`/api/v1/servers/${serverId}`)).json()) as Record<string, unknown>
    expect(body['billing']).toBeUndefined()

    const before = row(serverId).totalUptimeSeconds
    await accrueFor(2)
    expect(row(serverId).totalUptimeSeconds).toBe(before)
  })
})

describe('recordProviderState carries the flag as the provider\'s word', () => {
  it('stamps billingSince on a first confirmed stopped state only when the row bills while stopped', async () => {
    await build(false)
    const res = await request('/api/v1/servers', { method: 'POST', body: JSON.stringify({ size: 'small', name: 'a' }) })
    const { serverId } = (await res.json()) as { serverId: string }
    // Wipe what the create path wrote, so the stamp below is the one under test.
    opened.db.update(servers).set({ billingSince: null, providerState: null }).where(eq(servers.id, serverId)).run()

    recordProviderState(opened.db, serverId, 'stopped', '2026-09-04T00:00:00.000Z', false)
    expect(row(serverId).billingSince).toBeNull()

    recordProviderState(opened.db, serverId, 'stopped', '2026-09-04T00:00:01.000Z', true)
    expect(row(serverId).billingSince).toBe('2026-09-04T00:00:01.000Z')
    expect(row(serverId).billsWhileStopped).toBe(true)
  })

  it('refreshes the flag on every read, including an unknown one, and changes nothing else then', async () => {
    await build(false)
    const res = await request('/api/v1/servers', { method: 'POST', body: JSON.stringify({ size: 'small', name: 'a' }) })
    const { serverId } = (await res.json()) as { serverId: string }
    const before = row(serverId)

    const after = recordProviderState(opened.db, serverId, 'unknown', '2026-09-04T00:00:02.000Z', true)
    expect(after.billsWhileStopped).toBe(true)
    // `unknown` still writes no state and no stamp — the last real answer stands.
    expect(after.providerState).toBe(before.providerState)
    expect(after.providerStateAt).toBe(before.providerStateAt)
    expect(after.billingSince).toBe(before.billingSince)
  })
})
