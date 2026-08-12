import { isHostnameSafeId } from '@rockysurf/provider-sdk'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type Db, type OpenedDatabase } from './client.js'
import { buildIdempotencyKey, newServerId } from './ids.js'
import {
  countActiveServersForUser,
  getProviderData,
  getServer,
  getServerByIdempotencyKey,
  getServerRepositories,
  getServerTools,
  insertServer,
  listServersByStatus,
  listServersByUser,
  listServersNeedingRecovery,
  recordProgress,
  setInstallPlan,
  setKeyMaterial,
  setProviderData,
  updateServerStatus,
} from './repositories/servers.js'
import { appendEvent, createSession, getLiveSessionByTokenHash, upsertUserByGithubId } from './repositories/users.js'
import { PROVISIONING_STEPS, SERVER_STATUSES, servers, type ServerStatus } from './schema.js'
import {
  canTransition,
  InvalidProvisioningStepError,
  InvalidTransitionError,
  isTerminalStatus,
  resolveIpChange,
  SERVER_STATUS_TRANSITIONS,
} from './transitions.js'

let opened: OpenedDatabase
let db: Db
let userId: string

beforeEach(() => {
  opened = openTestDatabase()
  db = opened.db
  userId = upsertUserByGithubId(db, { githubId: '12345', githubUsername: 'octocat' }).id
})

afterEach(() => {
  opened.close()
})

const create = (overrides: Partial<Parameters<typeof insertServer>[1]> = {}) =>
  insertServer(db, {
    userId,
    name: 'dev-box',
    provider: 'aws',
    size: 'small',
    offeringId: 't4g.small',
    arch: 'arm64',
    ...overrides,
  })

/** Drive a server to a status through legal transitions. */
function driveTo(id: string, target: ServerStatus): void {
  const path: Record<string, ServerStatus[]> = {
    provisioning: ['provisioning'],
    running: ['provisioning', 'running'],
    stopped: ['provisioning', 'running', 'stopped'],
    failed: ['failed'],
    terminated: ['terminated'],
  }
  for (const step of path[target] ?? []) updateServerStatus(db, id, step)
}

describe('migrations', () => {
  it('create every table from an empty database', () => {
    const names = opened.sqlite
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort()

    expect(names).toEqual([
      'events',
      'packs',
      'secrets',
      'server_repositories',
      'servers',
      'sessions',
      'settings',
      'tools',
      'users',
    ])
  })

  it('enforce foreign keys, which SQLite does not do by default', () => {
    expect(opened.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() => create({ userId: 'usr-does-not-exist' })).toThrow(/FOREIGN KEY/i)
  })

  it('use only Postgres-portable column types', () => {
    const columns = opened.sqlite
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%'")
      .all()
      .flatMap((t) => opened.sqlite.prepare(`pragma table_info(${(t as { name: string }).name})`).all())
      .map((c) => (c as { type: string }).type.toUpperCase())

    expect(new Set(columns)).toEqual(new Set(['TEXT', 'INTEGER', 'REAL']))
  })

  it('carry no AWS nouns from the old schema', () => {
    const columns = opened.sqlite
      .prepare('pragma table_info(servers)')
      .all()
      .map((c) => (c as { name: string }).name)

    for (const gone of ['stack_name', 'instance_id', 'key_pair_name', 'spot_instance', 'price_per_second']) {
      expect(columns).not.toContain(gone)
    }
    // ...and do carry the replacements.
    for (const present of ['provider_data', 'install_plan', 'bootstrap_mode', 'host_key_fingerprint']) {
      expect(columns).toContain(present)
    }
  })
})

describe('enums', () => {
  it('add requested and keep every other status', () => {
    expect(SERVER_STATUSES).toEqual(['requested', 'provisioning', 'running', 'stopped', 'terminated', 'failed'])
  })

  it('rename stack_creating to requested and keep the rest of the steps', () => {
    expect(PROVISIONING_STEPS).not.toContain('stack_creating')
    expect(PROVISIONING_STEPS).toEqual([
      'requested',
      'instance_launching',
      'instance_running',
      'installing_tools',
      'tools_installed',
      'cloning_repos',
      'ready',
    ])
  })
})

describe('ids and idempotency', () => {
  it('mint hostname-safe server ids (C2)', () => {
    for (let i = 0; i < 50; i++) {
      const id = newServerId()
      expect(isHostnameSafeId(id)).toBe(true)
      expect(id).not.toContain('_')
    }
  })

  it('give a recreated server a different key than the dead one (C1)', () => {
    const args = { userId, name: 'dev-box', provider: 'aws', offeringId: 't4g.small' }
    expect(buildIdempotencyKey(args)).not.toBe(buildIdempotencyKey(args))
  })

  it('reproduce a key when the generation is pinned', () => {
    const args = { userId, name: 'dev-box', provider: 'aws', offeringId: 't4g.small', generation: 'gen-1' }
    expect(buildIdempotencyKey(args)).toBe(buildIdempotencyKey(args))
  })

  it('refuse two rows with the same idempotency key', () => {
    create({ idempotencyKey: 'fixed-key' })
    expect(() => create({ idempotencyKey: 'fixed-key' })).toThrow(/UNIQUE/i)
  })

  it('find a row by its key, which is how a retry re-attaches', () => {
    const row = create({ idempotencyKey: 'fixed-key' })
    expect(getServerByIdempotencyKey(db, 'fixed-key')?.id).toBe(row.id)
  })
})

describe('insertServer writes the row first (ADR-0001)', () => {
  it('starts in requested, before any provider call', () => {
    const row = create()
    expect(row.status).toBe('requested')
    expect(row.provisioningStep).toBe('requested')
    expect(row.providerData).toBeNull()
  })

  it('defaults to push bootstrap and the rocky user', () => {
    const row = create()
    expect(row.bootstrapMode).toBe('push')
    expect(row.sshUser).toBe('rocky')
  })

  it('stores JSON lists as text the app parses', () => {
    const row = create({ tools: ['claude-code', 'node'], repositories: ['https://github.com/a/b'] })
    expect(typeof row.tools).toBe('string')
    expect(getServerTools(row)).toEqual(['claude-code', 'node'])
    expect(getServerRepositories(row)).toEqual(['https://github.com/a/b'])
  })

  it('records a Price as three columns (B2)', () => {
    const row = create({ hourlyCost: { amount: 0.0216, currency: 'EUR', fetchedAt: '2026-08-12T00:00:00Z' } })
    expect(row.hourlyCostAmount).toBe(0.0216)
    expect(row.hourlyCostCurrency).toBe('EUR')
    expect(row.hourlyCostFetchedAt).toBe('2026-08-12T00:00:00Z')
  })

  it('leaves a findable row when provisioning never happens', () => {
    const row = create()
    // This is the orphan the old ordering created: here the row exists, so recovery can see it.
    expect(listServersNeedingRecovery(db).map((r) => r.id)).toContain(row.id)
  })
})

describe('status transitions', () => {
  it('accept every legal transition', () => {
    for (const [from, targets] of Object.entries(SERVER_STATUS_TRANSITIONS)) {
      for (const to of targets) {
        const row = create({ idempotencyKey: `k-${from}-${to}` })
        driveTo(row.id, from as ServerStatus)
        expect(getServer(db, row.id)?.status).toBe(from)
        expect(() => updateServerStatus(db, row.id, to)).not.toThrow()
        expect(getServer(db, row.id)?.status).toBe(to)
      }
    }
  })

  it('reject every illegal transition', () => {
    let n = 0
    for (const from of SERVER_STATUSES) {
      for (const to of SERVER_STATUSES) {
        if (canTransition(from, to)) continue
        const row = create({ idempotencyKey: `bad-${from}-${to}` })
        driveTo(row.id, from)
        expect(() => updateServerStatus(db, row.id, to)).toThrow(InvalidTransitionError)
        // The row is untouched by a rejected transition.
        expect(getServer(db, row.id)?.status).toBe(from)
        n++
      }
    }
    expect(n).toBeGreaterThan(10)
  })

  it('treat terminated as absorbing', () => {
    expect(isTerminalStatus('terminated')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(false) // a failed server can still be cleaned up
  })

  it('stamp startedAt on the first move to running, and never again', () => {
    const row = create()
    driveTo(row.id, 'running')
    const first = getServer(db, row.id)!.startedAt
    expect(first).toBeTruthy()

    updateServerStatus(db, row.id, 'stopped')
    updateServerStatus(db, row.id, 'running')
    expect(getServer(db, row.id)!.startedAt).toBe(first)
  })

  it('record an error message on failure', () => {
    const row = create()
    updateServerStatus(db, row.id, 'failed', { errorMessage: 'capacity: no t4g.small available' })
    expect(getServer(db, row.id)!.errorMessage).toMatch(/no t4g.small/)
  })

  it('stamp terminatedAt', () => {
    const row = create()
    updateServerStatus(db, row.id, 'terminated')
    expect(getServer(db, row.id)!.terminatedAt).toBeTruthy()
  })
})

describe('progress reports, ported from updateServerStatus.ts', () => {
  it('reject an unknown step', () => {
    const row = create()
    driveTo(row.id, 'provisioning')
    expect(() => recordProgress(db, row.id, { step: 'stack_creating' })).toThrow(InvalidProvisioningStepError)
  })

  it('advance provisioningStep without touching status', () => {
    const row = create()
    driveTo(row.id, 'provisioning')
    const updated = recordProgress(db, row.id, { step: 'installing_tools' })
    expect(updated?.provisioningStep).toBe('installing_tools')
    expect(updated?.status).toBe('provisioning')
  })

  it('flip to running and stamp startedAt on ready', () => {
    const row = create()
    driveTo(row.id, 'provisioning')
    const updated = recordProgress(db, row.id, { step: 'ready' })
    expect(updated?.status).toBe('running')
    expect(updated?.startedAt).toBeTruthy()
  })

  it('ignore reports once the server is no longer provisioning', () => {
    const row = create()
    driveTo(row.id, 'running')
    // A late or replayed report from a superseded run must not move a finished row.
    expect(recordProgress(db, row.id, { step: 'installing_tools' })).toBeUndefined()
    expect(getServer(db, row.id)!.status).toBe('running')

    updateServerStatus(db, row.id, 'terminated')
    expect(recordProgress(db, row.id, { step: 'ready' })).toBeUndefined()
    expect(getServer(db, row.id)!.status).toBe('terminated')
  })

  it('treat the FIRST address as an assignment, not a change', () => {
    const row = create()
    driveTo(row.id, 'provisioning')
    const updated = recordProgress(db, row.id, { step: 'instance_running', publicIp: '203.0.113.10' })
    expect(updated?.publicIp).toBe('203.0.113.10')
    // The distinction that keeps "your IP moved" from firing on every successful boot.
    expect(updated?.previousIp).toBeNull()
    expect(updated?.ipChangedAt).toBeNull()
  })

  it('record previousIp and ipChangedAt when the address actually moves', () => {
    const row = create()
    driveTo(row.id, 'provisioning')
    recordProgress(db, row.id, { step: 'instance_running', publicIp: '203.0.113.10' })
    const moved = recordProgress(db, row.id, { step: 'installing_tools', publicIp: '198.51.100.7' })

    expect(moved?.publicIp).toBe('198.51.100.7')
    expect(moved?.previousIp).toBe('203.0.113.10')
    expect(moved?.ipChangedAt).toBeTruthy()
  })

  it('write nothing when the address is unchanged', () => {
    const row = create()
    driveTo(row.id, 'provisioning')
    recordProgress(db, row.id, { step: 'instance_running', publicIp: '203.0.113.10' })
    const same = recordProgress(db, row.id, { step: 'installing_tools', publicIp: '203.0.113.10' })
    expect(same?.previousIp).toBeNull()
  })

  it('resolveIpChange covers the three cases directly', () => {
    const now = '2026-08-12T00:00:00Z'
    expect(resolveIpChange(null, undefined, now)).toBeUndefined()
    expect(resolveIpChange(null, '1.2.3.4', now)).toEqual({ publicIp: '1.2.3.4' })
    expect(resolveIpChange('1.2.3.4', '1.2.3.4', now)).toBeUndefined()
    expect(resolveIpChange('1.2.3.4', '5.6.7.8', now)).toEqual({
      publicIp: '5.6.7.8',
      previousIp: '1.2.3.4',
      ipChangedAt: now,
    })
  })
})

describe('uptime and cost accrual belongs to the ticker alone', () => {
  /** Backdate a timestamp so a would-be accrual has something to measure. */
  const backdate = (id: string, field: 'startedAt' | 'stoppedAt', msAgo: number) =>
    db
      .update(servers)
      .set({ [field]: new Date(Date.now() - msAgo).toISOString() })
      .where(eq(servers.id, id))
      .run()

  it('does not accrue when a running server stops', () => {
    const row = create({ hourlyCost: { amount: 3600, currency: 'USD', fetchedAt: 'now' } })
    driveTo(row.id, 'running')
    backdate(row.id, 'startedAt', 10_000)

    updateServerStatus(db, row.id, 'stopped')

    // The ticker already credited this time against its own watermark. Crediting it again
    // here inflated every total by roughly the server's whole lifetime.
    const stopped = getServer(db, row.id)!
    expect(stopped.totalUptimeSeconds).toBe(0)
    expect(stopped.estimatedTotalCost).toBe(0)
    // ...but the timestamp that says WHEN it stopped is still this function's job.
    expect(stopped.stoppedAt).toBeTruthy()
  })

  it('does not accrue on terminate straight from running', () => {
    const row = create({ hourlyCost: { amount: 3600, currency: 'USD', fetchedAt: 'now' } })
    driveTo(row.id, 'running')
    backdate(row.id, 'startedAt', 3000)

    updateServerStatus(db, row.id, 'terminated')

    const terminated = getServer(db, row.id)!
    expect(terminated.totalUptimeSeconds).toBe(0)
    expect(terminated.terminatedAt).toBeTruthy()
  })

  it('never counts off-time across a stop -> start -> stop cycle', () => {
    const row = create({ hourlyCost: { amount: 3600, currency: 'USD', fetchedAt: 'now' } })
    driveTo(row.id, 'running')

    // First run, then a long time switched OFF, then a short second run.
    backdate(row.id, 'startedAt', 60_000)
    updateServerStatus(db, row.id, 'stopped')
    backdate(row.id, 'stoppedAt', 50_000)
    updateServerStatus(db, row.id, 'running')
    updateServerStatus(db, row.id, 'stopped')

    // The old formula measured the second accrual from the FIRST stoppedAt, so the 50s the
    // server spent switched off were counted as uptime — the exact opposite of the point.
    const final = getServer(db, row.id)!
    expect(final.totalUptimeSeconds).toBe(0)
    expect(final.estimatedTotalCost).toBe(0)
  })

  it('leaves the counters for the ticker to own', () => {
    // A plain assertion of the invariant: nothing in the transition path writes these two
    // columns, so there is exactly one writer and no second path to drift from it.
    const row = create({ hourlyCost: { amount: 3600, currency: 'USD', fetchedAt: 'now' } })
    driveTo(row.id, 'running')
    backdate(row.id, 'startedAt', 30_000)

    for (const to of ['stopped', 'running', 'stopped', 'terminated'] as const) {
      updateServerStatus(db, row.id, to)
      expect(getServer(db, row.id)!.totalUptimeSeconds).toBe(0)
    }
  })
})

describe('provider data stays opaque', () => {
  it('round-trips whatever the provider returned', () => {
    const row = create()
    setProviderData(db, row.id, { instanceId: 'i-0abc', region: 'us-east-1' })
    expect(getProviderData(getServer(db, row.id)!)).toEqual({ instanceId: 'i-0abc', region: 'us-east-1' })
  })

  it('round-trips a differently-shaped handle from another provider', () => {
    const row = create({ provider: 'hetzner', idempotencyKey: 'h1' })
    setProviderData(db, row.id, { serverId: 161666993, name: 'rocky-surf-x', sshKeyIds: [1, 2] })
    expect(getProviderData(getServer(db, row.id)!)).toEqual({
      serverId: 161666993,
      name: 'rocky-surf-x',
      sshKeyIds: [1, 2],
    })
  })

  it('returns undefined rather than throwing on garbage', () => {
    const row = create()
    db.update(servers).set({ providerData: 'not json' }).where(eq(servers.id, row.id)).run()
    expect(getProviderData(getServer(db, row.id)!)).toBeUndefined()
  })

  it('stores the install plan and key material', () => {
    const row = create()
    setInstallPlan(db, row.id, { version: 1, steps: [{ id: 'apt-basics' }] })
    setKeyMaterial(db, row.id, { hostKeyFingerprint: 'SHA256:abc', managedKeySecretId: 'sec-1' })

    const updated = getServer(db, row.id)!
    expect(JSON.parse(updated.installPlan!)).toMatchObject({ version: 1 })
    expect(updated.hostKeyFingerprint).toBe('SHA256:abc')
    expect(updated.managedKeySecretId).toBe('sec-1')
  })
})

describe('queries', () => {
  it('list a user\'s servers newest first', () => {
    const a = create({ name: 'a', idempotencyKey: 'a' })
    const b = create({ name: 'b', idempotencyKey: 'b' })
    db.update(servers).set({ createdAt: '2026-01-01T00:00:00Z' }).where(eq(servers.id, a.id)).run()
    db.update(servers).set({ createdAt: '2026-06-01T00:00:00Z' }).where(eq(servers.id, b.id)).run()

    expect(listServersByUser(db, userId).map((r) => r.id)).toEqual([b.id, a.id])
  })

  it('scope listings to one user', () => {
    create()
    const other = upsertUserByGithubId(db, { githubId: '999', githubUsername: 'someone-else' }).id
    expect(listServersByUser(db, other)).toHaveLength(0)
  })

  it('filter by status', () => {
    const row = create()
    driveTo(row.id, 'running')
    expect(listServersByStatus(db, ['running']).map((r) => r.id)).toEqual([row.id])
    expect(listServersByStatus(db, ['stopped'])).toHaveLength(0)
  })

  it('count only servers that still exist against the limit', () => {
    const a = create({ idempotencyKey: 'a' })
    const b = create({ idempotencyKey: 'b' })
    driveTo(b.id, 'terminated')
    expect(countActiveServersForUser(db, userId)).toBe(1)
    expect(a.id).toBeTruthy()
  })
})

describe('users, sessions and events', () => {
  it('match an existing user on github id, not username', () => {
    const renamed = upsertUserByGithubId(db, { githubId: '12345', githubUsername: 'octocat-renamed' })
    expect(renamed.id).toBe(userId) // same account
    expect(renamed.githubUsername).toBe('octocat-renamed')
  })

  it('find a live session and ignore an expired one', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    createSession(db, { userId, tokenHash: 'hash-live', expiresAt: future })
    createSession(db, { userId, tokenHash: 'hash-dead', expiresAt: '2020-01-01T00:00:00Z' })

    expect(getLiveSessionByTokenHash(db, 'hash-live')).toBeTruthy()
    expect(getLiveSessionByTokenHash(db, 'hash-dead')).toBeUndefined()
  })

  it('cascade sessions when a user is deleted', () => {
    createSession(db, { userId, tokenHash: 'h', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    opened.sqlite.prepare('delete from users where id = ?').run(userId)
    expect(getLiveSessionByTokenHash(db, 'h')).toBeUndefined()
  })

  it('append events carrying a run id, for superseded-run forensics', () => {
    const row = create()
    const event = appendEvent(db, {
      type: 'bootstrap.step',
      serverId: row.id,
      runId: 'run-1',
      payload: { step: 'installing_tools' },
    })
    expect(event.runId).toBe('run-1')
    expect(JSON.parse(event.payload!)).toEqual({ step: 'installing_tools' })
  })
})
