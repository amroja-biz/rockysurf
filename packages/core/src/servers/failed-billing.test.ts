import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getProviderData, getServer, listBillingServers, recordProviderState } from '../db/repositories/servers.js'
import { createProvisionTick } from '../jobs/provision-ticker.js'
import { createReconcileTick } from '../jobs/reconciler.js'
import { createUptimeTick } from '../jobs/uptime-ticker.js'
import { makeFakeProvider, type FakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createSecretsStore } from '../secrets/store.js'
import { createEventsService, type EventsService } from '../services/events.js'

/**
 * A FAILED ROW WITH A LIVE INSTANCE BILLS, AND MUST SAY SO (rockysurf-4byx).
 *
 * The owner's live test: a repository-URL typo made bootstrap fail at the clone step. The row
 * went to `failed` and the EC2 stayed RUNNING — which was the design then, and for every failure
 * below the plan or outside a tool install it still is (ADR-0010 releases the machine only for a
 * failed TOOL install, and only with the report captured first). A kept box bills, and the
 * spend-cap doctrine (`jobs/limits.ts`) never stops a server on the strength of an estimate. The
 * bug was that the
 * card then read `Uptime 0s` and `Estimated cost $0.00`, because the uptime ticker selected
 * `status = 'running'`. The single state in which a user is paying for nothing at all was the
 * single state that reported nothing at all — the dec8 class of defect, a structural zero around
 * money, and worse than an inaccurate figure because it does not look like a figure at all.
 *
 * Everything here runs through the real HTTP route, the real job loop and the real provider
 * seam. The only fixture is the bootstrap poller, which IS the production interface — the push
 * supervisor returns exactly this shape when a box's journal reports a step failed — and the
 * clock the ticker reads, because a test cannot wait two hours.
 */

const PASSWORD = 'correct-horse-battery-staple'

/** First instant of the current UTC month: see the same note in `pricing.test.ts`. */
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

async function build(spendCap?: { amount: number; currency: string }): Promise<void> {
  opened = openTestDatabase()
  events = createEventsService()
  provider = makeFakeProvider()
  registry = new ProviderRegistry([provider])
  base = monthStart()

  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  created = createApp({
    db: opened.db,
    config: configSchema.parse({ limits: spendCap ? { spendCap } : {} }),
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

beforeEach(async () => {
  await build()
})

afterEach(() => {
  opened.close()
})

const request = (path: string, init: RequestInit = {}) =>
  created.app.request(path, { ...init, headers: { cookie, 'content-type': 'application/json', ...init.headers } })

async function createServer(name = 'first'): Promise<{ status: number; serverId?: string; body: Record<string, unknown> }> {
  const res = await request('/api/v1/servers', { method: 'POST', body: JSON.stringify({ size: 'small', name }) })
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, ...(typeof body['serverId'] === 'string' ? { serverId: body['serverId'] } : {}), body }
}

const row = (serverId: string) => getServer(opened.db, serverId)!

/**
 * Fail the server's bootstrap the way a clone-step typo does: the box comes up, the agent runs,
 * a step fails, and the INSTANCE IS LEFT ALONE. This is the real `createProvisionTick` driven by
 * the real `BootstrapPoller` shape, so the transition to `failed` is the product's own.
 */
async function failBootstrap(error = 'clone failed: repository not found'): Promise<void> {
  const tick = createProvisionTick({
    db: opened.db,
    registry,
    events,
    sync: created.sync,
    bootstrap: { poll: async () => ({ failed: true, error }) },
    log: () => {},
  })
  await tick()
}

/** Accrue as the real ticker would after `hours` of wall clock. */
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

/**
 * Pull both anchors back to the start of the month, which is how every test in this suite
 * simulates elapsed time. `billingSince` is rewritten alongside `startedAt` because the ticker
 * anchors on the EARLIER of the two, and a failed-before-`ready` row has only the former.
 */
function pretendItHasBeenUpSinceTheStartOfTheMonth(serverId: string): void {
  const at = base.toISOString()
  opened.db.run(`UPDATE servers SET billing_since = '${at}', started_at = '${at}' WHERE id = '${serverId}'`)
}

describe('a bootstrap failure leaves the machine running, and the row now admits it', () => {
  it('records the provider state and a billing anchor at create, before anything can fail', async () => {
    const { serverId } = await createServer()

    // Written from the `provision()` result, not from the row's status: the meter starts when
    // the provider hands back a machine.
    expect(row(serverId!).providerState).toBe('running')
    expect(row(serverId!).billingSince).not.toBeNull()
  })

  it('accrues uptime and cost on a FAILED row whose instance the provider still reports running', async () => {
    const { serverId } = await createServer()
    await failBootstrap()

    expect(row(serverId!).status).toBe('failed')
    expect(row(serverId!).errorMessage).toContain('repository not found')
    // The instance was deliberately not touched: that is the design this bead does not change.
    expect((await provider.describe(getProviderData(row(serverId!))!)).state).toBe('running')

    pretendItHasBeenUpSinceTheStartOfTheMonth(serverId!)
    await accrueFor(2)

    // Before this bead both of these were structurally zero, for as long as the box was left up.
    expect(row(serverId!).totalUptimeSeconds).toBe(2 * 3600)
    expect(row(serverId!).estimatedTotalCost).toBeCloseTo(0.02, 6)
  })

  it('tells all three front ends, through the one serializer, that the machine is still billing', async () => {
    const { serverId } = await createServer()
    await failBootstrap()

    const body = (await (await request(`/api/v1/servers/${serverId!}`)).json()) as Record<string, unknown>
    expect(body['status']).toBe('failed')
    expect(body['billing']).toEqual({
      live: true,
      providerState: 'running',
      since: expect.any(String),
      confirmedAt: expect.any(String),
    })
    // The reason is right beside it, so "terminate or diagnose" is an informed choice.
    expect(body['errorMessage']).toContain('repository not found')
  })

  it('says nothing extra on a healthy running row, where the status is already the whole truth', async () => {
    const { serverId } = await createServer()
    const body = (await (await request(`/api/v1/servers/${serverId!}`)).json()) as Record<string, unknown>
    // `provisioning`: the machine is billing and the status does not say so, so the flag is on.
    expect(body['status']).toBe('provisioning')
    expect(body['billing']).toMatchObject({ live: true })

    expect((await request(`/api/v1/servers/${serverId!}/terminate`, { method: 'POST' })).status).toBe(200)
    const gone = (await (await request(`/api/v1/servers/${serverId!}`)).json()) as Record<string, unknown>
    expect(gone['status']).toBe('terminated')
    expect(gone['billing']).toBeUndefined()
  })
})

describe('the cap counts a failed billing box, because that is what a cap is for', () => {
  it('refuses the next create once a failed-but-running row has eaten the budget', async () => {
    opened.close()
    await build({ amount: 0.02, currency: 'USD' })

    const first = await createServer()
    await failBootstrap()
    expect(row(first.serverId!).status).toBe('failed')

    pretendItHasBeenUpSinceTheStartOfTheMonth(first.serverId!)
    await accrueFor(3) // 0.03 USD on a 0.02 cap

    const refused = await createServer('second')
    expect(refused.status).toBe(403)
    expect(refused.body['reason']).toBe('spend_cap')

    // And the failed box is still standing, which is the doctrine: the cap blocks creates, it
    // never kills a machine somebody may still want to log into.
    expect(row(first.serverId!).status).toBe('failed')
  })

  it('counts an UNPRICED failed-but-running row among the servers the cap cannot see', async () => {
    opened.close()
    opened = openTestDatabase()
    events = createEventsService()
    provider = makeFakeProvider({
      offerings: [{ id: 'fake-small', cpu: 2, memoryGb: 4, arch: 'arm64', hourly: null, available: true, region: 'fake-1' }],
    })
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

    await createServer()
    await failBootstrap()

    // A failed row used to be excluded outright, so an unpriced one was invisible spend twice
    // over: no cost to accrue, and no mention in the count that admits the cap is incomplete.
    const costs = (await (await request('/api/v1/costs')).json()) as {
      monthToDate: { unpricedServers: number }
    }
    expect(costs.monthToDate.unpricedServers).toBe(1)
  })
})

describe('the sweep, which is what stops the meter when the machine really goes', () => {
  it('does not flag a failed row core still holds a handle for as an orphan', async () => {
    const { serverId } = await createServer()
    await failBootstrap()

    const reconcile = createReconcileTick({
      db: opened.db,
      registry,
      events,
      sync: created.sync,
      log: () => {},
    })
    const result = await reconcile()

    // Before this bead the row's instance had no live row to match, so every five minutes it
    // produced an orphan event for a resource nobody had lost — while the fact that it was
    // billing went unrecorded.
    expect(result.orphans.filter((orphan) => orphan.serverId === serverId)).toEqual([])
  })

  it('stops accruing once the instance is really gone, without anyone opening the page', async () => {
    const { serverId } = await createServer()
    await failBootstrap()
    pretendItHasBeenUpSinceTheStartOfTheMonth(serverId!)
    await accrueFor(1)
    expect(row(serverId!).totalUptimeSeconds).toBe(3600)

    // Killed in the provider's own console, behind core's back — the thing a user does when the
    // card finally tells them the box is still running.
    await provider.terminate(getProviderData(row(serverId!))!)

    const reconcile = createReconcileTick({
      db: opened.db,
      registry,
      events,
      sync: created.sync,
      log: () => {},
    })
    await reconcile()

    // The row STAYS failed (ADR-0010): `terminated` rows are hidden from the dashboard, and
    // hiding a failed row the moment its machine goes would hide the explanation with it — and
    // the machine going is now the ordinary end of a failed tool install. What changes is the
    // meter: the provider state is recorded as terminated, so the row stops billing.
    expect(row(serverId!).status).toBe('failed')
    expect(row(serverId!).providerState).toBe('terminated')
    expect(listBillingServers(opened.db).map((r) => r.id)).not.toContain(serverId)

    await accrueFor(5)
    expect(row(serverId!).totalUptimeSeconds).toBe(3600) // frozen where the machine died
  })
})

describe('a failed row core itself released stays released (ADR-0010, seen live 2026-08-26)', () => {
  it('does not let a provider read that lags the terminate put the row back on the meter', async () => {
    const { serverId } = await createServer()
    await failBootstrap()
    // What `failBootstrap`'s terminate path writes the moment the release call returns. The
    // fake instance is deliberately left running underneath, because that is what a cloud looks
    // like from core's side in the seconds after a DELETE is accepted — Azure answers
    // Succeeded/running, EC2 answers shutting-down — and the bug was that this window was
    // believed: the detail page's own GET synced the row, recorded `running` over `terminated`,
    // and the page relabelled Dismiss as Terminate on a machine that no longer existed.
    recordProviderState(opened.db, serverId!, 'terminated')
    expect((await provider.describe(getProviderData(row(serverId!))!)).state).toBe('running')

    const res = await request(`/api/v1/servers/${serverId}`)
    const body = (await res.json()) as Record<string, unknown>

    expect(row(serverId!).status).toBe('failed')
    expect(row(serverId!).providerState).toBe('terminated')
    expect(body['billing']).toBeUndefined()
    expect(listBillingServers(opened.db).map((r) => r.id)).not.toContain(serverId)

    // And the meter stays stopped: an hour of wall clock accrues nothing.
    pretendItHasBeenUpSinceTheStartOfTheMonth(serverId!)
    await accrueFor(1)
    expect(row(serverId!).totalUptimeSeconds).toBe(0)
  })

  it('leaves the rule out of it for a failed row core did NOT release, which keeps billing', async () => {
    const { serverId } = await createServer()
    await failBootstrap()

    const res = await request(`/api/v1/servers/${serverId}`)
    const body = (await res.json()) as Record<string, unknown>

    expect(row(serverId!).providerState).toBe('running')
    expect(body['billing']).toMatchObject({ live: true, providerState: 'running' })
  })
})
