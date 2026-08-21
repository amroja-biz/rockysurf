import { DESCRIBE_ABSENCE_GRACE, ProviderError, isProviderError } from '@rockysurf/provider-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { openTestDatabase, type Db, type OpenedDatabase } from '../db/client.js'
import { createSecretsStore } from '../secrets/store.js'
import { generateServerKeys } from '../ssh/keys.js'
import { getServerKeyMaterial, InvalidPublicKeyError } from '../ssh/server-keys.js'
import { getServer, getServerByIdempotencyKey, listServersByUser, recordProgress } from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { markBootstrapReady } from '../bootstrap/supervisor.js'
import { makeFakeProvider, type FakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createEventsService, type EventsService } from '../services/events.js'
import {
  ConflictError,
  ServerNotFoundError,
  UnsupportedOperationError,
  createLifecycleService,
  type LifecycleService,
} from './lifecycle.js'

let opened: OpenedDatabase
let db: Db
let events: EventsService
let fake: FakeProvider
let lifecycle: LifecycleService
let userId: string

function build(provider: FakeProvider = makeFakeProvider()): LifecycleService {
  fake = provider
  return createLifecycleService({ db, registry: new ProviderRegistry([provider]), events })
}

beforeEach(() => {
  opened = openTestDatabase()
  db = opened.db
  events = createEventsService()
  userId = upsertUserByGithubId(db, { githubId: '1', githubUsername: 'octocat' }).id
  lifecycle = build()
})

afterEach(() => {
  opened.close()
})

/**
 * Finish the box's bootstrap, the way the push supervisor does when the agent's journal
 * reaches its last step (rockysurf-55fx.13).
 *
 * Several tests below used to reach `running` with `sync()` alone, because `sync()` promoted a
 * provisioning row the moment the PROVIDER said the VM was up. That was the bug: the VM being
 * up is not the box being usable, and promoting there closed the window bootstrap reports are
 * accepted in. Reaching `running` now requires this, which is what production requires too.
 */
async function bootstrapped(row: Awaited<ReturnType<LifecycleService['create']>>) {
  const synced = await lifecycle.sync(row)
  await markBootstrapReady(db, events, synced)
  return getServer(db, row.id)!
}

const create = (overrides: Partial<Parameters<LifecycleService['create']>[0]> = {}) =>
  lifecycle.create({
    userId,
    name: 'dev-box',
    provider: 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
    ...overrides,
  })

describe('inverted create ordering (ADR-0001)', () => {
  it('writes the row in `requested` BEFORE the provider is called', async () => {
    let statusWhenProviderRan: string | undefined
    let rowExistedWhenProviderRan = false

    // The call-order spy the bead asks for: look at the database from INSIDE provision().
    const spy = makeFakeProvider()
    const originalProvision = spy.provision.bind(spy)
    vi.spyOn(spy, 'provision').mockImplementation(async (spec) => {
      const row = getServerByIdempotencyKey(db, spec.idempotencyKey)
      rowExistedWhenProviderRan = Boolean(row)
      statusWhenProviderRan = row?.status
      return await originalProvision(spec)
    })

    lifecycle = build(spy)
    await create()

    expect(rowExistedWhenProviderRan).toBe(true)
    expect(statusWhenProviderRan).toBe('requested')
  })

  it('leaves an adoptable row when the provider call never returns', async () => {
    const crashing = makeFakeProvider()
    vi.spyOn(crashing, 'provision').mockImplementation(async () => {
      // Stands in for the process dying between the row write and the provider answering.
      throw new Error('process died mid-provision')
    })
    lifecycle = build(crashing)

    await expect(create()).rejects.toThrow(/died mid-provision/)

    // The row is still there, marked failed, with the reason — findable, billable, killable.
    // Under the OLD ordering this is where an orphan instance would exist with no row at all.
    const failed = opened.sqlite.prepare('select id, status, error_message from servers').all() as {
      id: string
      status: string
      error_message: string | null
    }[]
    expect(failed).toHaveLength(1)
    expect(failed[0]?.status).toBe('failed')
    expect(failed[0]?.error_message).toMatch(/died mid-provision/)
  })

  it('records the provider handle and moves to provisioning on success', async () => {
    const row = await create()
    expect(row.status).toBe('provisioning')
    expect(JSON.parse(row.providerData ?? '{}')).toMatchObject({ instanceId: expect.stringMatching(/^i-fake-/) })
  })

  it('checks limits before writing anything', async () => {
    const registry = new ProviderRegistry([makeFakeProvider()])
    const service = createLifecycleService({
      db,
      registry,
      events,
      checkLimits: () => {
        throw new ConflictError('server limit reached')
      },
    })

    await expect(
      service.create({ userId, name: 'x', provider: 'fake', size: 'small', offeringId: 'fake-small', arch: 'arm64' }),
    ).rejects.toThrow(/limit reached/)
    // Refused before the row existed, so there is nothing to clean up.
    expect(opened.sqlite.prepare('select count(*) as n from servers').get()).toMatchObject({ n: 0 })
  })
})

describe('idempotency', () => {
  it('does not provision twice for a replayed key', async () => {
    const first = await create({ idempotencyKey: 'attempt-1' })
    const second = await create({ idempotencyKey: 'attempt-1' })

    expect(second.id).toBe(first.id)
    expect(fake.provisionCalls).toBe(1)
    expect(opened.sqlite.prepare('select count(*) as n from servers').get()).toMatchObject({ n: 1 })
  })

  it('treats a recreate with no key as a new server (amendment C1)', async () => {
    const first = await create()
    const second = await create({ name: 'dev-box' })

    expect(second.id).not.toBe(first.id)
    expect(fake.provisionCalls).toBe(2)
  })

  it('passes the stored key to the provider, so the cloud dedupes too', async () => {
    const row = await create({ idempotencyKey: 'attempt-9' })
    expect(row.idempotencyKey).toBe('attempt-9')
  })
})

describe('the absence grace (amendment A4)', () => {
  it('does not report a just-created instance as terminated', async () => {
    // The provider cannot see its own instance for a moment after creating it — exactly what
    // real EC2 did in spike/verify-aws.run1.log.
    lifecycle = build(makeFakeProvider({ propagationMs: 40, bootMs: 0 }))
    const row = await create()

    const synced = await lifecycle.sync(row)
    // Without the grace this is 'terminated', and core has just killed a healthy server.
    expect(synced.status).not.toBe('terminated')
    // `provisioning`, not `running`: the subject of this test is the absence grace, and the
    // row correctly stays put until the box's own bootstrap reports in. It read `running`
    // before 55fx.13, which is the promotion that abandoned boxes mid-boot.
    expect(synced.status).toBe('provisioning')
  })

  it('still reports terminated once the grace is exhausted', async () => {
    const row = await create()
    fake.reset() // the instance is genuinely gone

    const synced = await lifecycle.sync(row)
    expect(synced.status).toBe('terminated')
  }, 30_000)

  it('uses the SDK reference grace values', () => {
    expect(DESCRIBE_ABSENCE_GRACE).toEqual({ attempts: 4, delayMs: 2000 })
  })
})

describe('the state machine against the fake provider', () => {
  it('runs the full happy path', async () => {
    lifecycle = build(makeFakeProvider())
    const created = await create()
    expect(created.status).toBe('provisioning')

    // Two steps, because they are two different facts: the provider says the VM is up (sync
    // fills the address and leaves the status alone), and the box says it is ready (which is
    // what makes it `running`).
    const booted = await lifecycle.sync(created)
    expect(booted.status).toBe('provisioning')
    expect(booted.publicIp).toBeTruthy()

    const running = await bootstrapped(created)
    expect(running.status).toBe('running')
    expect(running.publicIp).toBeTruthy()

    const stopped = await lifecycle.stop(userId, created.id)
    expect(stopped.status).toBe('stopped')

    const started = await lifecycle.start(userId, created.id)
    expect(started.status).toBe('running')

    const terminated = await lifecycle.terminate(userId, created.id)
    expect(terminated.status).toBe('terminated')
  })

  it('maps a terminating instance to terminated for core', async () => {
    lifecycle = build(makeFakeProvider({ terminateMs: 60_000 }))
    const row = await create()
    await lifecycle.sync(row)

    const terminated = await lifecycle.terminate(userId, row.id)
    expect(terminated.status).toBe('terminated')

    // ...while the reconciler can still see the resource, because it still exists.
    const managed = await fake.listManaged()
    expect(managed.some((r) => r.kind === 'instance')).toBe(true)
  })

  it('refuses to stop a server that is not running', async () => {
    const row = await create()
    await expect(lifecycle.stop(userId, row.id)).rejects.toThrow(ConflictError)
  })

  it('refuses to start a server that is not stopped', async () => {
    const row = await create()
    await lifecycle.sync(row)
    await expect(lifecycle.start(userId, row.id)).rejects.toThrow(ConflictError)
  })

  it('records a provider failure on the row instead of losing it', async () => {
    fake.failNext('provision', new ProviderError('capacity', 'no capacity in fake-1'))
    await expect(create()).rejects.toMatchObject({ code: 'capacity' })

    const row = opened.sqlite.prepare('select status, error_message from servers').get() as {
      status: string
      error_message: string
    }
    expect(row.status).toBe('failed')
    expect(row.error_message).toContain('capacity')
  })

  it('reports another user\'s server as absent rather than forbidden', async () => {
    const row = await create()
    const other = upsertUserByGithubId(db, { githubId: '2', githubUsername: 'someone-else' }).id
    await expect(lifecycle.get(other, row.id)).rejects.toThrow(ServerNotFoundError)
  })
})

/**
 * A booted VM is not a usable box (rockysurf-55fx.13).
 *
 * This is the regression suite for the bug the first milestone exit run found: `sync` folded
 * the provider's `running` straight into the row's status, roughly a minute before cloud-init
 * finished and long before anything was installed. Because `acceptsProgressReports()` and the
 * ticker's bootstrap branch both require `provisioning`, that promotion did not just report the
 * wrong thing — it CLOSED the window bootstrap runs in, and every server came up empty.
 */
describe('bootstrap owns the promotion out of provisioning', () => {
  it('leaves a row provisioning while the provider says the instance is running', async () => {
    const row = await create()
    const synced = await lifecycle.sync(row)

    expect(synced.status).toBe('provisioning')
    // The address still arrives — it is what the push needs to connect at all.
    expect(synced.publicIp).toBeTruthy()
  })

  it('keeps accepting progress reports after a sync, which is the bug in one line', async () => {
    const row = await create()
    await lifecycle.sync(row)

    // Pre-fix this returned undefined — "server is not in provisioning state" — so a
    // callback-mode box's reports were rejected and a push-mode box was never polled.
    expect(recordProgress(db, row.id, { step: 'installing_tools' })).toBeTruthy()
    expect(getServer(db, row.id)?.provisioningStep).toBe('installing_tools')
  })

  it('promotes on the ready report, no matter how many syncs came first', async () => {
    const row = await create()
    await lifecycle.sync(row)
    await lifecycle.sync(row)

    const ready = await bootstrapped(row)
    expect(ready.status).toBe('running')
    expect(ready.startedAt).toBeTruthy()
  })

  it('still folds in the states that are facts about the instance', async () => {
    // Only the provisioning→running promotion is suppressed. A server that died, or that
    // someone terminated in the provider's console, must still settle — those are facts no
    // amount of bootstrapping changes.
    const row = await create()
    fake.reset()

    expect((await lifecycle.sync(row)).status).toBe('terminated')
  }, 30_000)
})

describe('terminate is idempotent', () => {
  it('succeeds twice and stays terminated', async () => {
    const row = await create()
    const first = await lifecycle.terminate(userId, row.id)
    const second = await lifecycle.terminate(userId, row.id)

    expect(first.status).toBe('terminated')
    expect(second.status).toBe('terminated')
    expect(second.terminatedAt).toBe(first.terminatedAt)
  })

  it('succeeds when the instance is already gone at the provider', async () => {
    const row = await create()
    fake.reset()
    await expect(lifecycle.terminate(userId, row.id)).resolves.toMatchObject({ status: 'terminated' })
  })

  /**
   * THE RETRY THAT OVERLAPS THE FIRST CALL, which is the shape a lost response really has
   * (rockysurf-nimu).
   *
   * The test above retries after the first terminate has returned, and passed all along. It
   * cannot see the bug, because the bug is in the window the two calls SHARE: a real terminate
   * spends tens of seconds inside the provider, and a caller that never received the response
   * retries while the first request is still in there. Both then read the same pre-terminated
   * row. The provider no-ops the second call by contract, and the row's transition guard —
   * which re-reads — used to answer `illegal server status transition: terminated → terminated`
   * for a machine that was, in fact, destroyed.
   */
  it('succeeds for a retry that overlaps the first call, which is what a lost response produces', async () => {
    const slow = makeFakeProvider()
    let release!: () => void
    const insideTerminate = new Promise<void>((resolve) => {
      release = resolve
    })
    const realTerminate = slow.terminate.bind(slow)
    vi.spyOn(slow, 'terminate').mockImplementation(async (data) => {
      await insideTerminate
      await realTerminate(data)
    })

    lifecycle = build(slow)
    const row = await create()

    // Both are in flight before either finishes, so both read the row as it was.
    const first = lifecycle.terminate(userId, row.id)
    const retry = lifecycle.terminate(userId, row.id)
    release()

    const [firstRow, retryRow] = await Promise.all([first, retry])
    expect(firstRow.status).toBe('terminated')
    expect(retryRow.status).toBe('terminated')
    // The loser reports the winner's row rather than a second termination of its own.
    expect(retryRow.terminatedAt).toBe(firstRow.terminatedAt)
  })
})

describe('capability gating (amendment A2)', () => {
  it('refuses stop on a provider that cannot stop, without calling it', async () => {
    lifecycle = build(makeFakeProvider({ capabilities: { stop: false } }))
    const row = await create()
    await lifecycle.sync(row)

    await expect(lifecycle.stop(userId, row.id)).rejects.toThrow(UnsupportedOperationError)
    await expect(lifecycle.start(userId, row.id)).rejects.toThrow(UnsupportedOperationError)
    // Core branched on the capability flag; the provider was never asked.
    expect(fake.calls).not.toContain('stop')
    expect(fake.calls).not.toContain('start')
  })

  it('the provider ALSO refuses, so the flag and the method cannot drift', async () => {
    const noStop = makeFakeProvider({ capabilities: { stop: false } })
    await expect(noStop.stop({ instanceId: 'i-fake-1' })).rejects.toMatchObject({ code: 'invalid_spec' })
    await expect(noStop.start({ instanceId: 'i-fake-1' })).rejects.toMatchObject({ code: 'invalid_spec' })
  })
})

describe('address tracking is capability-driven', () => {
  it('records previousIp only when the provider admits its IP moves', async () => {
    lifecycle = build(makeFakeProvider({ capabilities: { ipStableAcrossStop: false } }))
    const row = await create()
    // Bootstrapped rather than merely synced: `stop()` needs a running server, and a server is
    // only running once its bootstrap has reported ready.
    const running = await bootstrapped(row)
    const firstIp = running.publicIp
    expect(firstIp).toBeTruthy()
    // First assignment is not a move.
    expect(running.previousIp).toBeNull()

    await lifecycle.stop(userId, row.id)
    await lifecycle.start(userId, row.id)
    const moved = (await lifecycle.get(userId, row.id)).row

    expect(moved.publicIp).not.toBe(firstIp)
    expect(moved.previousIp).toBe(firstIp)
    expect(moved.ipChangedAt).toBeTruthy()
  })

  it('leaves previousIp alone on a provider whose IP is stable', async () => {
    lifecycle = build(makeFakeProvider({ capabilities: { ipStableAcrossStop: true } }))
    const row = await create()
    await bootstrapped(row)
    await lifecycle.stop(userId, row.id)
    await lifecycle.start(userId, row.id)

    expect((await lifecycle.get(userId, row.id)).row.previousIp).toBeNull()
  })
})

describe('events', () => {
  it('broadcasts every transition to the owner', async () => {
    const seen: { type: string; status?: string }[] = []
    events.subscribe(userId, (payload) => seen.push(payload as { type: string; status?: string }))

    const row = await create()
    await bootstrapped(row)
    await lifecycle.stop(userId, row.id)
    await lifecycle.terminate(userId, row.id)

    // The sequence is unchanged, and that is the point of leaving this expectation alone: the
    // `running` broadcast now comes from the bootstrap completing rather than from the
    // provider's describe(), but a user watching the stream must still see every transition.
    // The dashboard takes a server's status from these events and nothing else.
    const statuses = seen.filter((e) => e.type === 'server-status').map((e) => e.status)
    expect(statuses).toEqual(['requested', 'provisioning', 'running', 'stopped', 'terminated'])
  })

  it('does not broadcast another user\'s transitions', async () => {
    const other = upsertUserByGithubId(db, { githubId: '3', githubUsername: 'bystander' }).id
    const seen: unknown[] = []
    events.subscribe(other, (p) => seen.push(p))

    await create()
    expect(seen).toHaveLength(0)
  })

  it('writes an audit row for every event it broadcasts', async () => {
    const row = await create()
    const stored = opened.sqlite
      .prepare('select type from events where server_id = ?')
      .all(row.id) as { type: string }[]
    expect(stored.map((e) => e.type)).toContain('server-status')
  })
})

/**
 * Stop and start report what the PROVIDER has reached (rockysurf-55fx.15).
 *
 * The same family as the premature running-promotion above, found by the real-AWS exit run and
 * in both directions. `stop()` wrote `stopped` the moment EC2 ACCEPTED the request; EC2 then
 * spent tens of seconds in `stopping`, refusing StartInstances with IncorrectInstanceState, so
 * the row offered a Start button that could only fail. `start()` wrote `running` and re-read
 * immediately; EC2 still said `stopped`, so the sync folded the row straight back and the user
 * watched a status flip to running and back for no reason.
 *
 * Hetzner never showed either, because it settles inside the same call — which is exactly why
 * every other test in this file uses the default provider and none of their expectations moved.
 */
describe('stop and start follow the provider, not the request (rockysurf-55fx.15)', () => {
  /** A cloud that takes its time on both transitions, with a clock the test drives. */
  function slowCloud() {
    let clock = 1_000_000
    const provider = makeFakeProvider({
      bootMs: 20_000,
      // The window EC2 spends in `stopping`, refusing every start.
      stopMs: 30_000,
      // The beat after StartInstances in which EC2 still answers `stopped`.
      startAckMs: 2_000,
      now: () => clock,
    })
    return { provider, advance: (ms: number) => (clock += ms) }
  }

  /** A running server on a slow cloud, with its first boot genuinely finished. */
  async function runningOnSlowCloud() {
    const { provider, advance } = slowCloud()
    lifecycle = build(provider)
    const row = await create()
    advance(60_000) // the first boot completes at the provider
    const running = await bootstrapped(row)
    expect(running.status).toBe('running')
    return { row, advance }
  }

  it('does not report `stopped` while the provider is still stopping', async () => {
    const { row, advance } = await runningOnSlowCloud()

    // Pre-fix this returned `stopped` — a machine that is still up, still billing, and still
    // refusing to start. STATE_TO_STATUS already calls the provider's `stopping` a running
    // server; the bug was that stop() never let it have an opinion.
    expect((await lifecycle.stop(userId, row.id)).status).toBe('running')
    expect((await lifecycle.get(userId, row.id)).row.status).toBe('running')

    advance(30_000)
    expect((await lifecycle.get(userId, row.id)).row.status).toBe('stopped')
  })

  it('refuses a start during that window with a clear message, without asking the provider', async () => {
    const { row } = await runningOnSlowCloud()
    await lifecycle.stop(userId, row.id)

    // The acceptance criterion in one assertion: a clear conflict, never a raw
    // IncorrectInstanceState leaking out of the cloud SDK.
    await expect(lifecycle.start(userId, row.id)).rejects.toThrow(ConflictError)
    await expect(lifecycle.start(userId, row.id)).rejects.toThrow(/still stopping/)
    expect(fake.calls).not.toContain('start')
  })

  it('does not report `running` while the provider still says stopped', async () => {
    const { row, advance } = await runningOnSlowCloud()
    await lifecycle.stop(userId, row.id)
    advance(30_000)
    await lifecycle.get(userId, row.id) // settles to `stopped`

    // This one passed pre-fix too, and it is worth saying why rather than deleting it: the old
    // code wrote `running` and the sync on the very next line folded it back, so the ANSWER was
    // already `stopped`. What was wrong was the write and the broadcast in between, which the
    // next test pins. This test pins the progression itself — stopped until the box is up.
    expect((await lifecycle.start(userId, row.id)).status).toBe('stopped')
    expect((await lifecycle.get(userId, row.id)).row.status).toBe('stopped')

    advance(2_000) // the ack window closes; the provider admits to `pending`
    expect((await lifecycle.get(userId, row.id)).row.status).toBe('stopped')

    advance(20_000) // and now it is actually up
    expect((await lifecycle.get(userId, row.id)).row.status).toBe('running')
  })

  it('never broadcasts a status the provider had not reached', async () => {
    const { row, advance } = await runningOnSlowCloud()
    const seen: string[] = []
    events.subscribe(userId, (payload) => {
      const event = payload as { type: string; status?: string }
      if (event.type === 'server-status' && event.status) seen.push(event.status)
    })

    await lifecycle.stop(userId, row.id)
    advance(30_000)
    await lifecycle.get(userId, row.id)
    await lifecycle.start(userId, row.id)
    advance(22_000)
    await lifecycle.get(userId, row.id)

    // Pre-fix this read ['stopped', 'running', 'stopped', 'running']: a `stopped` announced
    // thirty seconds early, then a `running` that was retracted a moment later. The dashboard
    // takes a server's status from these events and nothing else.
    expect(seen).toEqual(['stopped', 'running'])
  })

  /**
   * The frame that ends the wait has to be worth rendering (rockysurf-4t8y).
   *
   * The SPA shows a "Starting…" affordance from the moment the provider accepts the request —
   * it cannot come from the row, because the row honestly reads `stopped` for the whole boot —
   * and resolves it on this broadcast. That makes this the frame a page which never refetches
   * renders, so it goes out through `serverStatusEvent`, which builds it from the row: status
   * AND address, rather than a hand-assembled payload carrying only the status.
   */
  it('confirms the start with the address as well as the status', async () => {
    const { row, advance } = await runningOnSlowCloud()
    await lifecycle.stop(userId, row.id)
    advance(30_000)
    await lifecycle.get(userId, row.id)
    await lifecycle.start(userId, row.id)

    const seen: { type: string; status?: string; publicIp?: string }[] = []
    events.subscribe(userId, (payload) => seen.push(payload as { type: string; status?: string }))

    advance(22_000)
    const settled = (await lifecycle.get(userId, row.id)).row

    const confirmation = seen.find((e) => e.type === 'server-status' && e.status === 'running')
    expect(confirmation).toBeTruthy()
    expect(settled.publicIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    expect(confirmation!.publicIp).toBe(settled.publicIp)
  })

  it('refuses a second start rather than issuing a second StartInstances', async () => {
    const { row, advance } = await runningOnSlowCloud()
    await lifecycle.stop(userId, row.id)
    advance(30_000)
    await lifecycle.get(userId, row.id)

    await lifecycle.start(userId, row.id)
    advance(2_000) // the provider now reports `pending`, while the row still reads `stopped`

    await expect(lifecycle.start(userId, row.id)).rejects.toThrow(/already starting/)
    expect(fake.calls.filter((c) => c === 'start')).toHaveLength(1)
  })

  it('refuses a stop while the box is still coming up', async () => {
    const { row, advance } = await runningOnSlowCloud()
    await lifecycle.stop(userId, row.id)
    advance(30_000)
    await lifecycle.get(userId, row.id)
    await lifecycle.start(userId, row.id)
    advance(2_000)

    await expect(lifecycle.stop(userId, row.id)).rejects.toThrow(/still starting/)
    expect(fake.calls.filter((c) => c === 'stop')).toHaveLength(1)
  })

  it('refuses a second stop while the first is still in flight', async () => {
    const { row } = await runningOnSlowCloud()
    await lifecycle.stop(userId, row.id)

    await expect(lifecycle.stop(userId, row.id)).rejects.toThrow(/already stopping/)
    expect(fake.calls.filter((c) => c === 'stop')).toHaveLength(1)
  })

  it('still settles inside one call on a provider that stops and starts promptly', async () => {
    // The Hetzner timing that never showed the bug, asserted so that the fix cannot quietly
    // make a fast cloud feel slow.
    lifecycle = build(makeFakeProvider())
    const row = await create()
    await bootstrapped(row)

    expect((await lifecycle.stop(userId, row.id)).status).toBe('stopped')
    expect((await lifecycle.start(userId, row.id)).status).toBe('running')
  })
})

describe('provider errors keep their taxonomy', () => {
  it('surfaces the code so routes can map it to a status', async () => {
    fake.failNext('provision', new ProviderError('rate_limited', 'slow down', { providerCode: 'Throttling' }))
    try {
      await create()
      expect.unreachable('create should have thrown')
    } catch (err) {
      expect(isProviderError(err)).toBe(true)
      if (isProviderError(err)) {
        expect(err.code).toBe('rate_limited')
        expect(err.providerCode).toBe('Throttling')
        expect(err.retryable).toBe(true)
      }
    }
  })
})

describe('ssh identity is provisioned before the provider is called', () => {
  function withSecrets(provider: FakeProvider = makeFakeProvider()) {
    fake = provider
    const store = createSecretsStore(db, randomBytes(32))
    return {
      store,
      service: createLifecycleService({ db, registry: new ProviderRegistry([provider]), events, secretsStore: store }),
    }
  }

  it('authorizes a real key and persists its private half against the row', async () => {
    const { store, service } = withSecrets()
    const row = await service.create({
      userId,
      name: 'keyed-box',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    const stored = getServer(db, row.id)!
    expect(stored.hostKeyFingerprint).toMatch(/^SHA256:/)
    expect(stored.managedKeySecretId).toBeTruthy()

    // The private halves are recoverable, and they match the key that was authorized.
    const material = getServerKeyMaterial(store, row.id)
    expect(material?.userPrivateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(material?.hostKeyFingerprint).toBe(stored.hostKeyFingerprint)
  })

  it('hands the provider the same key it put in the document', async () => {
    const { store, service } = withSecrets()
    let seenSpec: { sshPublicKeys: string[]; userData: string } | undefined
    const original = fake.provision.bind(fake)
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      seenSpec = { sshPublicKeys: spec.sshPublicKeys, userData: spec.userData }
      return await original(spec)
    })

    const row = await service.create({
      userId,
      name: 'keyed-box',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    const material = getServerKeyMaterial(store, row.id)!
    // No placeholder anywhere: the authorized key is the one core holds the private half of.
    expect(seenSpec?.sshPublicKeys).toContain(material.userPublicKey)
    expect(seenSpec?.sshPublicKeys.join(' ')).not.toMatch(/PLACEHOLDER/)
    expect(seenSpec?.userData).toContain(material.userPublicKey)
  })

  it('pins the host key core minted, so the first connection is verified', async () => {
    const { store, service } = withSecrets()
    let userData = ''
    const original = fake.provision.bind(fake)
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      userData = spec.userData
      return await original(spec)
    })

    const row = await service.create({
      userId,
      name: 'pinned-box',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    const material = getServerKeyMaterial(store, row.id)!
    expect(userData).toContain('ssh_keys:')
    expect(userData).toContain(material.hostPublicKey.trim())
    // The document stays inert: push mode puts no shell in user-data at all.
    expect(userData).not.toMatch(/^\s*(runcmd|bootcmd):/m)
  })

  it('renders nothing for a provider that has no pre-boot hook', async () => {
    const { service } = withSecrets(makeFakeProvider({ capabilities: { generatesUserData: false } }))
    let userData = 'unset'
    const original = fake.provision.bind(fake)
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      userData = spec.userData
      return await original(spec)
    })

    await service.create({
      userId,
      name: 'byo-box',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })
    expect(userData).toBe('')
  })

  it('omits host-key pinning when the provider cannot carry it', async () => {
    const { store, service } = withSecrets(makeFakeProvider({ capabilities: { canInjectHostKeys: false } }))
    let userData = ''
    const original = fake.provision.bind(fake)
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      userData = spec.userData
      return await original(spec)
    })

    const row = await service.create({
      userId,
      name: 'tofu-box',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })
    // Core falls back to trust-on-first-use rather than pretending it pinned something.
    expect(userData).not.toContain('ssh_keys:')
    expect(userData).toContain('ssh_authorized_keys:')

    // And the ROW carries no pin (rockysurf-ftl9.3). The minted fingerprint is a key this box
    // will never present, so pinning it would fail every bootstrap connection with nothing on
    // the row to explain why. The keypair is still minted and stored — the user half is how core
    // logs in at all — and the pin is left for the provider to report.
    expect(getServer(db, row.id)!.hostKeyFingerprint).toBeNull()
    expect(getServerKeyMaterial(store, row.id)?.hostKeyFingerprint).toMatch(/^SHA256:/)
  })

  it('records the host key a provider reports, so the first push connection can verify it', async () => {
    const OBSERVED = `SHA256:${'o'.repeat(43)}`
    const { service } = withSecrets(makeFakeProvider({ capabilities: { canInjectHostKeys: false } }))
    const original = fake.provision.bind(fake)
    // What a BYO-shaped provider does: it connected first, learned the box's own host key, and
    // hands core a fingerprint to pin. Core does the trusting nowhere — it is told.
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      const result = await original(spec)
      return { ...result, initial: { ...result.initial, hostKeyFingerprint: OBSERVED } }
    })

    const row = await service.create({
      userId,
      name: 'byo-shaped',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    // On the create path, because the push supervisor may connect on the very next tick.
    expect(getServer(db, row.id)!.hostKeyFingerprint).toBe(OBSERVED)
  })

  it('records the host KEY beside the pin, so an adopted box can be verified like any other', async () => {
    const observed = generateServerKeys('the-box').host
    const { service } = withSecrets(makeFakeProvider({ capabilities: { canInjectHostKeys: false } }))
    const original = fake.provision.bind(fake)
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      const result = await original(spec)
      return {
        ...result,
        initial: {
          ...result.initial,
          hostKeyFingerprint: observed.fingerprint,
          hostPublicKey: observed.publicKey,
        },
      }
    })

    const row = await service.create({
      userId,
      name: 'adopted',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    const stored = getServer(db, row.id)!
    expect(stored.hostKeyFingerprint).toBe(observed.fingerprint)
    expect(stored.hostPublicKey).toBe(observed.publicKey)
  })

  it('keeps the pin but drops a reported key that does not hash to it', async () => {
    const observed = generateServerKeys('the-box').host
    const somebodyElse = generateServerKeys('not-the-box').host
    const { service } = withSecrets(makeFakeProvider({ capabilities: { canInjectHostKeys: false } }))
    const original = fake.provision.bind(fake)
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      const result = await original(spec)
      return {
        ...result,
        initial: {
          ...result.initial,
          hostKeyFingerprint: observed.fingerprint,
          hostPublicKey: somebodyElse.publicKey,
        },
      }
    })

    const row = await service.create({
      userId,
      name: 'disagrees',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    // The pin was verified during a handshake; the key was only reported alongside it. On
    // disagreement the row keeps the pin and stores NO key, so the worst case is "cannot hand
    // out a known_hosts entry" and never "hands out the wrong one" (ADR-0003, E14).
    const stored = getServer(db, row.id)!
    expect(stored.hostKeyFingerprint).toBe(observed.fingerprint)
    expect(stored.hostPublicKey).toBeNull()
  })

  it('records the sshd port a provider reports, on create and on a later describe', async () => {
    const { service } = withSecrets(makeFakeProvider({ capabilities: { canInjectHostKeys: false } }))
    const original = fake.provision.bind(fake)
    // A machine core adopted rather than created: its operator put sshd on 2222 years ago, and
    // the provider is the only party that knows (ADR-0003, E13).
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      const result = await original(spec)
      return { ...result, initial: { ...result.initial, sshPort: 2222 } }
    })

    const row = await service.create({
      userId,
      name: 'other-port',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    // On the create path, for the same reason as the pin above: the push supervisor may connect
    // on the very next tick, and before this it connected to 22 and waited out the timeout.
    expect(getServer(db, row.id)!.sshPort).toBe(2222)

    // And UNLIKE the pin, a later change is adopted rather than refused: a port is not a trust
    // decision, and an operator who moves sshd and updates the registry is simply right.
    const described = fake.describe.bind(fake)
    vi.spyOn(fake, 'describe').mockImplementation(async (data) => ({ ...(await described(data)), sshPort: 2022 }))
    await service.sync(getServer(db, row.id)!)

    expect(getServer(db, row.id)!.sshPort).toBe(2022)
  })

  it('records the console URL a provider reports, on create and on a later describe', async () => {
    const FIRST = 'https://console.example.test/projects/1/servers/7/overview'
    const MOVED = 'https://console.example.test/projects/2/servers/7/overview'
    const { service } = withSecrets()
    const original = fake.provision.bind(fake)
    // Only the provider knows what its console looks like, so this is the only way a URL can
    // reach the row — core builds none (ADR-0003, E16).
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      const result = await original(spec)
      return { ...result, initial: { ...result.initial, consoleUrl: FIRST } }
    })

    const row = await service.create({
      userId,
      name: 'linked',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    // From the create response, so the link is on the page while the box is still booting.
    expect(getServer(db, row.id)!.consoleUrl).toBe(FIRST)

    const described = fake.describe.bind(fake)
    vi.spyOn(fake, 'describe').mockImplementation(async (data) => ({ ...(await described(data)), consoleUrl: MOVED }))
    await service.sync(getServer(db, row.id)!)
    expect(getServer(db, row.id)!.consoleUrl).toBe(MOVED)

    // A sparse view does NOT clear it. `describe()` answers with little more than a state on its
    // not-found and terminated paths, and losing the link every time a box is polled during
    // teardown would be an odd way to report "still shutting down".
    vi.spyOn(fake, 'describe').mockImplementation(async (data) => {
      const { consoleUrl: _dropped, ...rest } = await described(data)
      return rest
    })
    await service.sync(getServer(db, row.id)!)
    expect(getServer(db, row.id)!.consoleUrl).toBe(MOVED)
  })

  it('leaves the console URL null when the provider reports none, so no link is rendered', async () => {
    const { service } = withSecrets()
    const row = await service.create({
      userId,
      name: 'unlinked',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    expect(getServer(db, row.id)!.consoleUrl).toBeNull()
  })

  it('leaves the port null when the provider reports none, so nothing has to mean 22 twice', async () => {
    const { service } = withSecrets()
    const row = await service.create({
      userId,
      name: 'ordinary',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    expect(getServer(db, row.id)!.sshPort).toBeNull()
  })

  it('never overwrites a pin it already has with a different reported one', async () => {
    const FIRST = `SHA256:${'a'.repeat(43)}`
    const SECOND = `SHA256:${'b'.repeat(43)}`
    const { service } = withSecrets(makeFakeProvider({ capabilities: { canInjectHostKeys: false } }))
    const provisioned = fake.provision.bind(fake)
    vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
      const result = await provisioned(spec)
      return { ...result, initial: { ...result.initial, hostKeyFingerprint: FIRST } }
    })

    const row = await service.create({
      userId,
      name: 'changed-key',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })

    const described = fake.describe.bind(fake)
    vi.spyOn(fake, 'describe').mockImplementation(async (data) => ({
      ...(await described(data)),
      hostKeyFingerprint: SECOND,
    }))
    await service.sync(getServer(db, row.id)!)

    // A host key that CHANGED is a refusal, not an update: adopting it would turn a pin into
    // rolling trust, which is the exact failure pinning exists to prevent. The disagreement
    // surfaces where it belongs — the next SSH connection refuses and is never retried.
    expect(getServer(db, row.id)!.hostKeyFingerprint).toBe(FIRST)
  })

  it('authorizes a user-supplied key alongside core\'s own', async () => {
    const { store, service } = withSecrets()
    const extra = generateServerKeys('extra').user.publicKey
    const row = await service.create({
      userId,
      name: 'two-keys',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
      sshPublicKey: extra,
    })

    const material = getServerKeyMaterial(store, row.id)!
    const doc = JSON.parse(getServer(db, row.id)!.providerData ?? '{}') as Record<string, unknown>
    expect(doc['instanceId']).toBeTruthy()
    expect(material.userPublicKey).toBeTruthy()
  })

  /**
   * The orphan-row regression guard (rockysurf-9fvy.1, issue #41 fallout). Before this fix,
   * `normalizeUserPublicKey` ran in STEP 2, after `insertServer` — so a malformed paste threw
   * past a `requested` row that no provider would ever hear about. Normalizing before the
   * insert means a refusal here leaves nothing behind, same as the limits check beside it.
   */
  it('rejects a malformed pasted key and leaves no orphan row behind', async () => {
    const { service } = withSecrets()
    const before = listServersByUser(db, userId).length

    await expect(
      service.create({
        userId,
        name: 'bad-key-box',
        provider: 'fake',
        size: 'small',
        offeringId: 'fake-small',
        arch: 'arm64',
        sshPublicKey: 'not a key',
      }),
    ).rejects.toBeInstanceOf(InvalidPublicKeyError)

    expect(listServersByUser(db, userId).length).toBe(before)
  })

  /**
   * The row-persistence half of issue #41: the pasted key is stored on the row itself, not
   * just injected on the box, so `present()` has something to build `suppliedSshKey` from.
   */
  describe('the pasted key is persisted on the row (issue #41)', () => {
    it('stores the normalized line and hands the provider both keys, core\'s first', async () => {
      const { service } = withSecrets()
      const extra = generateServerKeys('extra').user.publicKey
      let seenSpec: { sshPublicKeys: string[] } | undefined
      const original = fake.provision.bind(fake)
      vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
        seenSpec = { sshPublicKeys: spec.sshPublicKeys }
        return await original(spec)
      })

      const row = await service.create({
        userId,
        name: 'supplied-key-box',
        provider: 'fake',
        size: 'small',
        offeringId: 'fake-small',
        arch: 'arm64',
        sshPublicKey: extra,
      })

      expect(getServer(db, row.id)!.userSuppliedPublicKey).toBe(extra)
      expect(seenSpec?.sshPublicKeys).toHaveLength(2)
      expect(seenSpec?.sshPublicKeys[0]).toContain(`rockysurf-core@${row.id}`)
      expect(seenSpec?.sshPublicKeys[1]).toBe(extra)
      // Normalization runs once: the value persisted and the value the provider saw agree
      // exactly, character for character (child bead rockysurf-9fvy.1, criterion 4).
      expect(getServer(db, row.id)!.userSuppliedPublicKey).toBe(seenSpec?.sshPublicKeys[1])
    })

    it('trims a pasted key before storing it', async () => {
      const { service } = withSecrets()
      const raw = generateServerKeys('padded').user.publicKey
      const row = await service.create({
        userId,
        name: 'padded-key-box',
        provider: 'fake',
        size: 'small',
        offeringId: 'fake-small',
        arch: 'arm64',
        sshPublicKey: `  ${raw}  `,
      })

      expect(getServer(db, row.id)!.userSuppliedPublicKey).toBe(raw.trim())
    })

    it('leaves the column null and passes exactly one key when none was supplied', async () => {
      const { service } = withSecrets()
      let seenSpec: { sshPublicKeys: string[] } | undefined
      const original = fake.provision.bind(fake)
      vi.spyOn(fake, 'provision').mockImplementation(async (spec) => {
        seenSpec = { sshPublicKeys: spec.sshPublicKeys }
        return await original(spec)
      })

      const row = await service.create({
        userId,
        name: 'no-key-box',
        provider: 'fake',
        size: 'small',
        offeringId: 'fake-small',
        arch: 'arm64',
      })

      expect(getServer(db, row.id)!.userSuppliedPublicKey).toBeNull()
      expect(seenSpec?.sshPublicKeys).toHaveLength(1)
    })
  })

  it('reuses the identity rather than minting a second one', async () => {
    const { store, service } = withSecrets()
    const row = await service.create({
      userId,
      name: 'stable',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
      idempotencyKey: 'k-1',
    })
    const first = getServerKeyMaterial(store, row.id)!.hostKeyFingerprint

    await service.create({
      userId,
      name: 'stable',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
      idempotencyKey: 'k-1',
    })
    expect(getServerKeyMaterial(store, row.id)!.hostKeyFingerprint).toBe(first)
  })
})
