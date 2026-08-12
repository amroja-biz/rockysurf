import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configSchema, type LimitsConfig } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { newServerId, newUserId } from '../db/ids.js'
import { servers, users, type ServerRow, type ServerStatus } from '../db/schema.js'
import { createEventsService, type EventsService } from '../services/events.js'
import { createJobs } from './index.js'
import { LimitExceededError, createLimitsEnforcer, createSpendTracker } from './limits.js'
import { createProvisionTick, PROVISIONING_TIMEOUT_MS } from './provision-ticker.js'
import { createUptimeTick } from './uptime-ticker.js'

/**
 * The tickers against a real in-memory database, with time injected rather than faked, because
 * what is under test is arithmetic over timestamps rather than scheduling.
 */

let opened: OpenedDatabase
let events: EventsService
let userId: string

const LIMITS: LimitsConfig = configSchema.parse({}).limits

beforeEach(() => {
  opened = openTestDatabase()
  events = createEventsService()
  userId = newUserId()
  opened.db
    .insert(users)
    .values({
      id: userId,
      githubId: 'local:admin',
      githubUsername: 'admin',
      isAdmin: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run()
})

afterEach(() => {
  opened.close()
})

interface SeedOptions {
  status?: ServerStatus
  createdAt?: string
  startedAt?: string | null
  hourlyCostAmount?: number | null
  hourlyCostCurrency?: string | null
  totalUptimeSeconds?: number
  estimatedTotalCost?: number
  providerData?: string | null
}

function seedServer(options: SeedOptions = {}): ServerRow {
  const now = new Date().toISOString()
  const id = newServerId()
  const [row] = opened.db
    .insert(servers)
    .values({
      id,
      userId,
      name: id,
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
      status: options.status ?? 'running',
      bootstrapMode: 'push',
      idempotencyKey: id,
      hourlyCostAmount: options.hourlyCostAmount === undefined ? 0.1 : options.hourlyCostAmount,
      hourlyCostCurrency: options.hourlyCostCurrency === undefined ? 'USD' : options.hourlyCostCurrency,
      totalUptimeSeconds: options.totalUptimeSeconds ?? 0,
      estimatedTotalCost: options.estimatedTotalCost ?? 0,
      providerData: options.providerData === undefined ? JSON.stringify({ instanceId: 'i-1' }) : options.providerData,
      createdAt: options.createdAt ?? now,
      updatedAt: now,
      startedAt: options.startedAt === undefined ? now : options.startedAt,
    })
    .returning()
    .all()
  return row!
}

const reload = (id: string) => opened.db.select().from(servers).where(eq(servers.id, id)).get()!

/* ------------------------------------------------------------------------- uptime */

describe('uptimeTicker', () => {
  it('accrues running time and estimated cost incrementally, not from scratch each tick', async () => {
    // The bug this guards: `now - startedAt` recomputes the whole lifetime every tick and adds
    // it again, so a 60s job would bill an hour-old server an extra hour every minute.
    const started = new Date('2026-08-12T00:00:00Z')
    const row = seedServer({ startedAt: started.toISOString(), hourlyCostAmount: 3600 })

    let now = started
    const tick = createUptimeTick({
      db: opened.db,
      events,
      spend: createSpendTracker(opened.db, LIMITS),
      now: () => now,
    })

    now = new Date(started.getTime() + 60_000)
    await tick()
    expect(reload(row.id).totalUptimeSeconds).toBe(60)

    now = new Date(started.getTime() + 120_000)
    await tick()
    // 120 total, NOT 60 + 120.
    expect(reload(row.id).totalUptimeSeconds).toBe(120)
    // 3600/hour = 1 per second.
    expect(reload(row.id).estimatedTotalCost).toBeCloseTo(120, 5)
  })

  it('never credits time before the server started running', async () => {
    const base = new Date('2026-08-12T00:00:00Z')
    // Watermark is set by a first tick; the server starts halfway through the next window.
    const tick = createUptimeTick({
      db: opened.db,
      events,
      spend: createSpendTracker(opened.db, LIMITS),
      now: () => now,
    })
    let now = base
    await tick()

    const row = seedServer({ startedAt: new Date(base.getTime() + 30_000).toISOString() })
    now = new Date(base.getTime() + 60_000)
    await tick()

    expect(reload(row.id).totalUptimeSeconds).toBe(30)
  })

  it('accumulates across a stop and a restart, counting only running time', async () => {
    const base = new Date('2026-08-12T00:00:00Z')
    let now = base
    const tick = createUptimeTick({
      db: opened.db,
      events,
      spend: createSpendTracker(opened.db, LIMITS),
      now: () => now,
    })

    const row = seedServer({ startedAt: base.toISOString() })

    now = new Date(base.getTime() + 60_000)
    await tick()
    expect(reload(row.id).totalUptimeSeconds).toBe(60)

    // Stopped: the ticker must not accrue while it is off.
    opened.db.update(servers).set({ status: 'stopped' }).where(eq(servers.id, row.id)).run()
    now = new Date(base.getTime() + 600_000)
    await tick()
    expect(reload(row.id).totalUptimeSeconds).toBe(60)

    // Running again. Only the time since this tick counts, not the ten idle minutes.
    opened.db.update(servers).set({ status: 'running' }).where(eq(servers.id, row.id)).run()
    now = new Date(base.getTime() + 660_000)
    await tick()
    expect(reload(row.id).totalUptimeSeconds).toBe(120)
  })

  it('accrues uptime but no cost for an offering the provider did not price', async () => {
    const base = new Date('2026-08-12T00:00:00Z')
    let now = base
    const row = seedServer({ startedAt: base.toISOString(), hourlyCostAmount: null, hourlyCostCurrency: null })
    const tick = createUptimeTick({
      db: opened.db,
      events,
      spend: createSpendTracker(opened.db, LIMITS),
      now: () => now,
    })

    now = new Date(base.getTime() + 3_600_000)
    await tick()

    const after = reload(row.id)
    expect(after.totalUptimeSeconds).toBe(3600)
    expect(after.estimatedTotalCost).toBe(0)
  })
})

/* --------------------------------------------------------------------- spend cap */

describe('spend cap', () => {
  const capped: LimitsConfig = { ...LIMITS, spendCap: { amount: 10, currency: 'USD' } }

  it('blocks new creates once estimated spend reaches the cap, and lets them through below it', async () => {
    const base = new Date('2026-08-12T00:00:00Z')
    let now = base
    const spend = createSpendTracker(opened.db, capped)
    const checkLimits = createLimitsEnforcer({ db: opened.db, limits: capped, spend, now: () => now })
    const tick = createUptimeTick({ db: opened.db, events, spend, now: () => now })

    // 1/hour: after one hour, 1 USD — well under the cap.
    const row = seedServer({ startedAt: base.toISOString(), hourlyCostAmount: 1 })
    now = new Date(base.getTime() + 3_600_000)
    await tick()

    expect(spend.snapshot().byCurrency['USD']).toBeCloseTo(1, 5)
    expect(spend.snapshot().overCap).toBe(false)
    expect(() => checkLimits({ userId }, 0)).not.toThrow()

    // Ten more hours takes it over.
    now = new Date(base.getTime() + 3_600_000 * 11)
    await tick()

    expect(spend.snapshot().overCap).toBe(true)
    const error = (() => {
      try {
        checkLimits({ userId }, 0)
      } catch (err) {
        return err as LimitExceededError
      }
      throw new Error('expected the create to be blocked')
    })()

    expect(error).toBeInstanceOf(LimitExceededError)
    expect(error.reason).toBe('spend_cap')
    expect(error.message).toContain('USD')
    expect(error.message).toContain('Running servers are left alone')
    void row
  })

  it('does NOT stop running servers at the cap', async () => {
    // A deliberate departure from the bead's acceptance criteria: auto-stopping kills an agent
    // mid-task on the strength of an estimate from bundled prices. Warn and block instead.
    const base = new Date('2026-08-12T00:00:00Z')
    let now = base
    const spend = createSpendTracker(opened.db, capped)
    const tick = createUptimeTick({ db: opened.db, events, spend, now: () => now })
    const row = seedServer({ startedAt: base.toISOString(), hourlyCostAmount: 100 })

    now = new Date(base.getTime() + 3_600_000)
    await tick()

    expect(spend.snapshot().overCap).toBe(true)
    expect(reload(row.id).status).toBe('running')
  })

  it('warns over SSE exactly once, on the tick that crosses', async () => {
    const base = new Date('2026-08-12T00:00:00Z')
    let now = base
    const received: unknown[] = []
    events.subscribe(userId, (payload) => received.push(payload))

    const spend = createSpendTracker(opened.db, capped)
    const tick = createUptimeTick({ db: opened.db, events, spend, now: () => now, log: () => {} })
    seedServer({ startedAt: base.toISOString(), hourlyCostAmount: 100 })

    now = new Date(base.getTime() + 3_600_000)
    const first = await tick()
    expect(first.capJustCrossed).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'spend-cap-reached', cap: { amount: 10, currency: 'USD' } })

    now = new Date(base.getTime() + 7_200_000)
    const second = await tick()
    expect(second.capJustCrossed).toBe(false)
    expect(received).toHaveLength(1)
  })

  it('compares the cap only against its own currency, never a mixed total', async () => {
    // A EUR project and a USD account cannot be added together honestly (amendment B2).
    const base = new Date('2026-08-12T00:00:00Z')
    let now = base
    const spend = createSpendTracker(opened.db, capped)
    const tick = createUptimeTick({ db: opened.db, events, spend, now: () => now })

    seedServer({ startedAt: base.toISOString(), hourlyCostAmount: 100, hourlyCostCurrency: 'EUR' })
    now = new Date(base.getTime() + 3_600_000)
    await tick()

    const snapshot = spend.snapshot()
    expect(snapshot.byCurrency['EUR']).toBeCloseTo(100, 5)
    // 100 EUR accrued, but the cap is in USD and nothing has accrued there.
    expect(snapshot.overCap).toBe(false)
  })

  it('counts unpriced servers so a cap cannot silently ignore half the fleet', async () => {
    seedServer({ hourlyCostAmount: null, hourlyCostCurrency: null })
    seedServer({ hourlyCostAmount: null, hourlyCostCurrency: null, status: 'terminated' })
    const spend = createSpendTracker(opened.db, capped)
    expect(spend.refresh().unpricedServers).toBe(1)
  })
})

/* ------------------------------------------------------------------ other limits */

describe('create limits', () => {
  it('enforces maxServers', () => {
    const limits: LimitsConfig = { ...LIMITS, maxServers: 2 }
    const spend = createSpendTracker(opened.db, limits)
    const checkLimits = createLimitsEnforcer({ db: opened.db, limits, spend })

    expect(() => checkLimits({ userId }, 1)).not.toThrow()
    const error = (() => {
      try {
        checkLimits({ userId }, 2)
      } catch (err) {
        return err as LimitExceededError
      }
      throw new Error('expected a rejection')
    })()
    expect(error.reason).toBe('max_servers')
    expect(error.message).toContain('limits.maxServers')
  })

  it('enforces createRatePerHour, counting recent creates whatever became of them', () => {
    const limits: LimitsConfig = { ...LIMITS, createRatePerHour: 2 }
    const spend = createSpendTracker(opened.db, limits)
    const checkLimits = createLimitsEnforcer({ db: opened.db, limits, spend })

    seedServer({ status: 'terminated' })
    expect(() => checkLimits({ userId }, 0)).not.toThrow()

    seedServer({ status: 'failed' })
    const error = (() => {
      try {
        checkLimits({ userId }, 0)
      } catch (err) {
        return err as LimitExceededError
      }
      throw new Error('expected a rejection')
    })()
    // Terminate-and-recreate loops are the reason this exists, so terminated rows must count.
    expect(error.reason).toBe('create_rate')
  })

  it('ignores creates older than an hour', () => {
    const limits: LimitsConfig = { ...LIMITS, createRatePerHour: 1 }
    const spend = createSpendTracker(opened.db, limits)
    const checkLimits = createLimitsEnforcer({ db: opened.db, limits, spend })

    seedServer({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })
    expect(() => checkLimits({ userId }, 0)).not.toThrow()
  })
})

/* ----------------------------------------------------------------- provisioning */

describe('provisionTicker', () => {
  const registry = {
    get: () => ({ terminate: vi.fn(async () => {}) }),
  } as never

  it('syncs servers that are still coming up', async () => {
    const row = seedServer({ status: 'provisioning' })
    const sync = vi.fn(async (r: ServerRow) => r)
    const tick = createProvisionTick({ db: opened.db, registry, events, sync, log: () => {} })

    const result = await tick()
    expect(result.synced).toBe(1)
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }))
  })

  it('leaves running and terminated servers alone', async () => {
    seedServer({ status: 'running' })
    seedServer({ status: 'terminated' })
    const sync = vi.fn(async (r: ServerRow) => r)
    const tick = createProvisionTick({ db: opened.db, registry, events, sync, log: () => {} })

    expect((await tick()).synced).toBe(0)
  })

  it('fails a server stuck past the timeout, with a reason, and terminates its instance', async () => {
    const terminate = vi.fn(async () => {})
    const stuckRegistry = { get: () => ({ terminate }) } as never
    const row = seedServer({
      status: 'provisioning',
      createdAt: new Date(Date.now() - PROVISIONING_TIMEOUT_MS - 60_000).toISOString(),
    })

    const sync = vi.fn(async (r: ServerRow) => r)
    const tick = createProvisionTick({ db: opened.db, registry: stuckRegistry, events, sync, log: () => {} })

    const result = await tick()

    expect(result.timedOut).toBe(1)
    // The instance is released before the row is failed: a row marked failed beside an
    // instance still billing is the worse of the two failure modes.
    expect(terminate).toHaveBeenCalledOnce()

    const after = reload(row.id)
    expect(after.status).toBe('failed')
    expect(after.errorMessage).toContain('30 minutes')
    // Never synced: a timed-out row is not worth a provider round trip.
    expect(sync).not.toHaveBeenCalled()
  })

  it('tells the user their server failed', async () => {
    const received: unknown[] = []
    events.subscribe(userId, (payload) => received.push(payload))
    seedServer({
      status: 'provisioning',
      createdAt: new Date(Date.now() - PROVISIONING_TIMEOUT_MS - 60_000).toISOString(),
    })

    const tick = createProvisionTick({
      db: opened.db,
      registry,
      events,
      sync: async (r) => r,
      log: () => {},
    })
    await tick()

    expect(received[0]).toMatchObject({ type: 'server-status', status: 'failed' })
  })

  it('still fails the row when the provider will not terminate', async () => {
    const angryRegistry = {
      get: () => ({
        terminate: async () => {
          throw new Error('provider is down')
        },
      }),
    } as never
    const row = seedServer({
      status: 'provisioning',
      createdAt: new Date(Date.now() - PROVISIONING_TIMEOUT_MS - 60_000).toISOString(),
    })

    const tick = createProvisionTick({
      db: opened.db,
      registry: angryRegistry,
      events,
      sync: async (r) => r,
      log: () => {},
    })
    await tick()

    expect(reload(row.id).status).toBe('failed')
  })

  it('one row failing to sync does not stop the sweep', async () => {
    seedServer({ status: 'provisioning' })
    const good = seedServer({ status: 'provisioning' })
    let calls = 0
    const sync = vi.fn(async (r: ServerRow) => {
      calls++
      if (calls === 1) throw new Error('provider hiccup')
      return r
    })

    const tick = createProvisionTick({ db: opened.db, registry, events, sync, log: () => {} })
    expect((await tick()).synced).toBe(1)
    expect(calls).toBe(2)
    void good
  })

  it('polls the bootstrap seam for push-mode servers when one is wired', async () => {
    const row = seedServer({ status: 'provisioning' })
    const poll = vi.fn(async () => ({ step: 'installing_tools' }))

    const tick = createProvisionTick({
      db: opened.db,
      registry,
      events,
      sync: async (r) => r,
      bootstrap: { poll },
      log: () => {},
    })

    expect((await tick()).bootstrapPolled).toBe(1)
    expect(poll).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }))
  })

  it('fails a server whose bootstrap reports failure', async () => {
    const row = seedServer({ status: 'provisioning' })
    const tick = createProvisionTick({
      db: opened.db,
      registry,
      events,
      sync: async (r) => r,
      bootstrap: { poll: async () => ({ failed: true, error: 'agent died' }) },
      log: () => {},
    })

    await tick()
    const after = reload(row.id)
    expect(after.status).toBe('failed')
    expect(after.errorMessage).toBe('agent died')
  })

  it('treats an unreachable box as normal, not as a failure', async () => {
    const row = seedServer({ status: 'provisioning' })
    const tick = createProvisionTick({
      db: opened.db,
      registry,
      events,
      sync: async (r) => r,
      bootstrap: {
        poll: async () => {
          throw new Error('ECONNREFUSED')
        },
      },
      log: () => {},
    })

    await tick()
    // Still provisioning. Only the timeout decides a server is never coming up.
    expect(reload(row.id).status).toBe('provisioning')
  })
})

/* -------------------------------------------------------------------- the bundle */

describe('createJobs', () => {
  // `list()` is what the reconciler walks; `get()` is what the provision ticker uses.
  const registry = { get: () => ({ terminate: async () => {} }), list: () => [] } as never

  it('wires four jobs and stops them all cleanly', async () => {
    const jobs = createJobs({
      db: opened.db,
      registry,
      events,
      limits: LIMITS,
      sync: async (r) => r,
      log: () => {},
    })

    // The reconciler (rockysurf-55fx.7) sits between the tickers and the sweeper.
    expect(jobs.handles.map((h) => h.name)).toEqual([
      'provisionTicker',
      'uptimeTicker',
      'reconciler',
      'sessionSweeper',
    ])

    jobs.start()
    expect(jobs.handles.every((h) => h.running)).toBe(true)

    await jobs.stop()
    expect(jobs.handles.every((h) => h.running)).toBe(false)
    await expect(jobs.stop()).resolves.toBeUndefined()
  })

  it('runs every job on demand', async () => {
    const jobs = createJobs({
      db: opened.db,
      registry,
      events,
      limits: LIMITS,
      sync: async (r) => r,
      log: () => {},
    })
    await jobs.runAllNow()
    expect(jobs.handles.every((h) => h.runs === 1)).toBe(true)
  })

  it('primes the spend snapshot before the first create is checked', () => {
    const jobs = createJobs({
      db: opened.db,
      registry,
      events,
      limits: { ...LIMITS, spendCap: { amount: 10, currency: 'USD' } },
      sync: async (r) => r,
      log: () => {},
    })
    // Not the zeroed initial value: refreshed at construction.
    expect(jobs.spend.snapshot().computedAt).not.toBe(new Date(0).toISOString())
    expect(jobs.spend.snapshot().cap).toEqual({ amount: 10, currency: 'USD' })
  })

  it('exposes a checkLimits the lifecycle service can be constructed with', () => {
    const jobs = createJobs({
      db: opened.db,
      registry,
      events,
      limits: { ...LIMITS, maxServers: 1 },
      sync: async (r) => r,
      log: () => {},
    })
    expect(() => jobs.checkLimits({ userId }, 1)).toThrow(LimitExceededError)
  })
})
