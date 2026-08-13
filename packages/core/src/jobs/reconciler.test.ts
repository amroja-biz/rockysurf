import type { ManagedResource } from '@rockysurf/provider-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { insertServer, setProviderData, updateServerStatus } from '../db/repositories/servers.js'
import { listEventsForServer, upsertUserByGithubId } from '../db/repositories/users.js'
import { events as eventsTable } from '../db/schema.js'
import type { ServerRow } from '../db/schema.js'
import { createEventsService, type EventsService } from '../services/events.js'
import { createReconcileTick } from './reconciler.js'

let opened: OpenedDatabase
let events: EventsService
let userId: string

const instance = (serverId?: string): ManagedResource => ({
  kind: 'instance',
  providerNativeId: `i-${serverId ?? 'unknown'}`,
  ownership: 'server-owned',
  ...(serverId ? { serverId } : {}),
})

/** The AWS shared SSH security group: tagged managed-by, and intentionally immortal. */
const sharedGroup: ManagedResource = {
  kind: 'security-group',
  providerNativeId: 'sg-0a949e8ed67c5a1bd',
  ownership: 'shared',
}

function registryOf(managed: ManagedResource[] | (() => Promise<never>)): never {
  const listManaged = typeof managed === 'function' ? managed : async () => managed
  return { list: () => [{ id: 'fake', listManaged }] } as never
}

function seed(status: 'running' | 'terminated' = 'running'): ServerRow {
  const row = insertServer(opened.db, {
    userId,
    name: 'dev-box',
    provider: 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
  })
  setProviderData(opened.db, row.id, { instanceId: `i-${row.id}` })
  updateServerStatus(opened.db, row.id, 'provisioning')
  const live = updateServerStatus(opened.db, row.id, 'running')
  return status === 'running' ? live : updateServerStatus(opened.db, row.id, 'terminated')
}

beforeEach(() => {
  opened = openTestDatabase()
  events = createEventsService()
  userId = upsertUserByGithubId(opened.db, { githubId: '1', githubUsername: 'tester' }).id
})

afterEach(() => {
  opened.close()
})

describe('cloud resources with no live row', () => {
  it('flags a server-owned orphan WITHOUT terminating it', async () => {
    const tick = createReconcileTick({
      db: opened.db,
      registry: registryOf([instance('srv-gone')]),
      events,
      sync: async (r) => r,
    })

    const result = await tick()
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0]).toMatchObject({ providerId: 'fake', kind: 'instance', serverId: 'srv-gone' })

    // v0.1 never auto-terminates: the record must say so, because the record is what a later
    // auto-reap feature will be justified by.
    const [event] = opened.db.select().from(eventsTable).all().filter((e) => e.type === 'reconciler.orphan_detected')
    expect(event).toBeDefined()
    expect(JSON.parse(event!.payload!)).toMatchObject({ action: 'flagged-only' })
  })

  it('NEVER flags a shared resource, even with nothing referencing it (amendment D1)', async () => {
    // Live evidence: after a real teardown the spike's AWS run reported no instances and still
    // reported this security group. Treating listManaged() as a delete-list would have removed
    // it from under every running server.
    const tick = createReconcileTick({
      db: opened.db,
      registry: registryOf([sharedGroup]),
      events,
      sync: async (r) => r,
    })

    const result = await tick()
    expect(result.orphans).toEqual([])
    expect(result.sharedSeen).toBe(1)
    expect(opened.db.select().from(eventsTable).all().filter((e) => e.type === 'reconciler.orphan_detected')).toEqual([])
  })

  it('does not flag a resource whose server row is alive', async () => {
    const row = seed()
    const tick = createReconcileTick({
      db: opened.db,
      registry: registryOf([instance(row.id), sharedGroup]),
      events,
      sync: async (r) => r,
    })

    const result = await tick()
    expect(result.orphans).toEqual([])
  })

  it('flags a resource whose row is terminated — the row is no longer live', async () => {
    const row = seed('terminated')
    const tick = createReconcileTick({
      db: opened.db,
      registry: registryOf([instance(row.id)]),
      events,
      sync: async (r) => r,
    })

    expect((await tick()).orphans).toHaveLength(1)
  })

  it('flags an unattributable server-owned resource', async () => {
    // A resource this installation created and cannot name is exactly what a human should see.
    const tick = createReconcileTick({
      db: opened.db,
      registry: registryOf([{ kind: 'volume', providerNativeId: 'vol-123', ownership: 'server-owned' }]),
      events,
      sync: async (r) => r,
    })
    expect((await tick()).orphans).toHaveLength(1)
  })
})

describe('rows whose cloud resource is gone', () => {
  it('records the row as vanished once sync moves it to a terminal status', async () => {
    const row = seed()
    // sync() owns the propagation grace (amendment A4); the reconciler believes whatever it
    // says rather than reimplementing the rule.
    const sync = vi.fn(async () => updateServerStatus(opened.db, row.id, 'terminated'))
    const tick = createReconcileTick({ db: opened.db, registry: registryOf([]), events, sync })

    const result = await tick()
    expect(result.vanished).toEqual([row.id])
    expect(listEventsForServer(opened.db, row.id).some((e) => e.type === 'reconciler.server_vanished')).toBe(true)
  })

  it('leaves a row alone while sync still reports it alive', async () => {
    const row = seed()
    const tick = createReconcileTick({ db: opened.db, registry: registryOf([]), events, sync: async (r) => r })
    expect((await tick()).vanished).toEqual([])
    expect(listEventsForServer(opened.db, row.id).some((e) => e.type === 'reconciler.server_vanished')).toBe(false)
  })

  it('skips rows that never reached a provider — recovery owns those', async () => {
    insertServer(opened.db, {
      userId,
      name: 'never-provisioned',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })
    const sync = vi.fn(async (r: ServerRow) => r)
    const tick = createReconcileTick({ db: opened.db, registry: registryOf([]), events, sync })

    await tick()
    expect(sync).not.toHaveBeenCalled()
  })
})

describe('resilience', () => {
  it('keeps going when one provider is unreachable', async () => {
    // A reconciler that gives up on the first API error stops running the day a token expires.
    const failing = { id: 'broken', listManaged: async () => { throw new Error('token expired') } }
    const working = { id: 'fake', listManaged: async () => [instance('srv-gone')] }
    const registry = { list: () => [failing, working] } as never

    const result = await createReconcileTick({ db: opened.db, registry, events, sync: async (r) => r })()
    expect(result.failed).toBe(1)
    expect(result.checked).toBe(1)
    expect(result.orphans).toHaveLength(1)
  })
})
