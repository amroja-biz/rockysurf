import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { mintCallbackTokens } from '../db/repositories/bootstrap-tokens.js'
import { getServer } from '../db/repositories/servers.js'
import { PROVISIONING_STEPS, type ServerRow } from '../db/schema.js'
import { loadPacksFromDir } from '../packs/loader.js'
import { syncPacksToDb } from '../packs/sync.js'
import { makeFakeProvider, type FakeProviderOptions } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createSecretsStore, type SecretsStore } from '../secrets/store.js'
import { createEventsService, type EventsService } from '../services/events.js'
import { applyAgentState } from './push-runner.js'
import { parseInstallPlan, type InstallPlan } from './plan.js'
import type { AgentState } from './push.js'

/**
 * What `bootstrap-progress` actually carries, watched from where the SPA watches it
 * (rockysurf-xinr).
 *
 * THIS IS THE TEST THAT WAS MISSING, and the shape of the gap is the same one 55fx.13 found:
 * every piece had passing unit tests and the composition was still wrong. Two topologies emit
 * this event — the callback route and the push runner — and each was tested against its own
 * idea of the payload, so nothing noticed that push was putting a PLAN STEP ID (`tool:beads`)
 * in the `step` field where callback puts a PROVISIONING STEP (`installing_tools`). The SPA
 * timeline is written against the second vocabulary, so on a real AWS create the log streamed
 * to completion while every step stayed unlit.
 *
 * So the assertions below are made on the bytes that leave core, read off a real SSE stream
 * opened the way the browser opens it, with the plan the create path really snapshotted. A
 * test that called the emitter and inspected its argument would have agreed with the bug.
 */

const PASSWORD = 'correct-horse-battery-staple'
const config: Config = configSchema.parse({})

let opened: OpenedDatabase
let store: MemorySecretStore
let events: EventsService
let secrets: SecretsStore
let created: ReturnType<typeof createApp>
let cookie: string

/** The shipped packs, so the plan under test is the one a real install would run. */
const packsDir = fileURLToPath(new URL('../../../../packs/', import.meta.url))

/**
 * Build the app over the current database, with a provider a test can shape.
 *
 * Callable again from inside a test, which is what the launch-phase cases need: an instance that
 * boots INSTANTLY reports `running` from `provision()` itself, so the two milestones collapse
 * into one and the interesting sequence — launching, then running — cannot happen. Replacing the
 * app rather than standing a second one beside it keeps one job loop per test.
 */
async function startApp(providerOptions: FakeProviderOptions = {}): Promise<void> {
  created = createApp({
    db: opened.db,
    config,
    secrets: store,
    secretsStore: secrets,
    events,
    providers: new ProviderRegistry([makeFakeProvider(providerOptions)]),
  })
  const login = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
}

/** Swap the app mid-test for one whose provider takes its time booting. */
async function restartApp(providerOptions: FakeProviderOptions): Promise<void> {
  await created.jobs.stop()
  await startApp(providerOptions)
}

beforeEach(async () => {
  opened = openTestDatabase()
  syncPacksToDb(opened.db, loadPacksFromDir(packsDir))
  store = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets: store, password: PASSWORD })
  events = createEventsService()
  secrets = createSecretsStore(opened.db, randomBytes(32))
  await startApp()
})

afterEach(async () => {
  await created.jobs.stop()
  opened.close()
})

/** A server created the way the SPA creates one, so its plan is the one core really renders. */
async function createServer(): Promise<{ row: ServerRow; plan: InstallPlan }> {
  const res = await created.app.request('/api/v1/servers', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ size: 'small', packId: 'ai-coding-agents' }),
  })
  expect(res.status).toBe(201)
  const { serverId } = (await res.json()) as { serverId: string }
  const row = getServer(opened.db, serverId)!
  return { row, plan: parseInstallPlan(row.installPlan!) }
}

/** The stream the browser opens, read frame by frame. */
async function openEventStream(): Promise<{
  next: (predicate?: (event: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>
  close: () => Promise<void>
}> {
  const res = await created.app.request('/api/v1/events', { headers: { cookie } })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const pending: Record<string, unknown>[] = []

  const drain = () => {
    const frames = buffered.split('\n\n')
    buffered = frames.pop() ?? ''
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length)
      if (!data) continue
      try {
        pending.push(JSON.parse(data) as Record<string, unknown>)
      } catch {
        // The greeting and heartbeats are not JSON messages; they are not what this reads.
      }
    }
  }

  return {
    async next(predicate = (event) => event['type'] === 'bootstrap-progress') {
      // Comfortably inside vitest's own timeout, so a missing frame fails with the frames that
      // DID arrive rather than with "the test timed out".
      const deadline = Date.now() + 2500
      for (;;) {
        const found = pending.findIndex(predicate)
        if (found >= 0) return pending.splice(found, 1)[0]!
        if (Date.now() > deadline) throw new Error(`no matching frame. Saw: ${JSON.stringify(pending)}`)
        const { value, done } = await reader.read()
        if (done) throw new Error('the stream closed before the frame arrived')
        buffered += decoder.decode(value, { stream: true })
        drain()
      }
    },
    close: () => reader.cancel(),
  }
}

/**
 * The journal `agent.sh` writes while a step is running: the plan's own step ids, each
 * carrying the `reports` label the resolver gave it.
 */
function journalAt(plan: InstallPlan, stepId: string, status: AgentState['status'] = 'running'): AgentState {
  return {
    planVersion: plan.version,
    serverId: plan.serverId,
    runId: plan.runId,
    step: stepId,
    status,
    updatedAt: new Date().toISOString(),
    steps: plan.steps.map((step) => ({
      id: step.id,
      reports: step.reports,
      status: step.id === stepId ? 'running' : 'pending',
    })),
  }
}

/** The first step of the plan that installs something — `tool:<id>`, reporting the tools label. */
const firstToolStep = (plan: InstallPlan) => plan.steps.find((step) => step.id.startsWith('tool:'))!

describe('bootstrap-progress, as the browser receives it', () => {
  it('carries a step the timeline knows when the push runner reports one', async () => {
    const { row, plan } = await createServer()
    const stream = await openEventStream()

    // Exactly what `pushBootstrap`'s `onState` hands over when the box starts installing.
    applyAgentState({ db: opened.db, events, secrets }, row, journalAt(plan, firstToolStep(plan).id))

    const event = await stream.next()
    // THE ASSERTION THAT WAS MISSING. `tool:beads` is a real thing that happened here, and the
    // SPA has no idea what it means: its timeline is a fixed list of provisioning steps.
    expect(PROVISIONING_STEPS).toContain(event['step'])
    expect(event['step']).toBe('installing_tools')
    // The lossy label costs nothing because the precise step rides alongside it, which is why
    // the SPA can show "Installing tools" and a support request can still name the step.
    expect(event['stepId']).toBe(firstToolStep(plan).id)
    expect(event['serverId']).toBe(row.id)

    await stream.close()
  })

  it('reports the same shape from the callback topology', async () => {
    const { row, plan } = await createServer()
    // Callback mode is the topology where the box speaks for itself; the report it POSTs is
    // built from the same plan step.
    const step = firstToolStep(plan)
    const stream = await openEventStream()

    // The row was created in push mode, which mints nothing — so the credential the box would
    // have been given is minted here. Nothing else about the report changes: it is the same
    // plan, the same step, and the route that receives it is the real one.
    const { callbackToken } = mintCallbackTokens(opened.db, row.id)

    const res = await created.app.request(`/internal/servers/${row.id}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        step: step.reports,
        stepId: step.id,
        status: 'running',
        token: callbackToken,
        runId: plan.runId,
      }),
    })
    expect(res.status).toBe(200)

    const event = await stream.next()
    expect(event['step']).toBe('installing_tools')
    expect(event['stepId']).toBe(step.id)

    await stream.close()
  })

  it('announces the promotion the report caused, as a status event', async () => {
    const { row, plan } = await createServer()
    const stream = await openEventStream()

    // Every plan the resolver renders ends with a step reporting `ready`, and THAT report is
    // what promotes the row to `running`. The SPA reads statuses from `server-status` alone,
    // so a promotion that emitted only a progress event left every open tab on "Provisioning"
    // until the user reloaded — `markBootstrapReady` finds nothing left to promote and says
    // nothing either.
    const ready = plan.steps.find((step) => step.reports === 'ready')!
    applyAgentState({ db: opened.db, events, secrets }, row, journalAt(plan, ready.id))

    const status = await stream.next((event) => event['type'] === 'server-status')
    expect(status['status']).toBe('running')
    expect(status['serverId']).toBe(row.id)
    expect(getServer(opened.db, row.id)?.status).toBe('running')

    await stream.close()
  })

  /**
   * The stretch nothing used to report (rockysurf-ljxi).
   *
   * `instance_launching` and `instance_running` were in the step list and drawn by the SPA from
   * the beginning, and no code path in core ever reported either — so a row went from `requested`
   * to `installing_tools` in one jump, across the instance boot and the SSH wait, which on real
   * AWS is the longest part of a create. These report core's OWN observation of the provider, so
   * the fixture is a provider that boots slowly enough to be watched: the default fake reports
   * `running` from `provision()` itself, which is honest but collapses both milestones into one.
   */
  describe('the launch phase, which nothing used to report', () => {
    let clock: number

    /** A provider whose instance sits in `pending` until the test says otherwise. */
    async function slowBootingProvider(): Promise<void> {
      clock = Date.now()
      await restartApp({ bootMs: 60_000, now: () => clock })
    }

    /** What the SPA does when it opens a server's page — and what the ticker does every 10s. */
    async function refresh(serverId: string): Promise<void> {
      const res = await created.app.request(`/api/v1/servers/${serverId}`, { headers: { cookie } })
      expect(res.status).toBe(200)
    }

    it('reports the launch as soon as the provider has taken the create', async () => {
      await slowBootingProvider()
      const stream = await openEventStream()

      const { row } = await createServer()

      const event = await stream.next()
      // Provider-confirmed and nothing more: `provision()` returned a handle and said `pending`.
      // Core is not claiming the box is up, only that it has been asked for and is coming.
      expect(event['step']).toBe('instance_launching')
      expect(event['serverId']).toBe(row.id)
      expect(event['status']).toBe('provisioning')
      // Row and event agree, so a reload and a live update show the same step.
      expect(getServer(opened.db, row.id)?.provisioningStep).toBe('instance_launching')

      await stream.close()
    })

    it('reports the machine running only once the provider says it is', async () => {
      await slowBootingProvider()
      const { row } = await createServer()
      const stream = await openEventStream()

      // A sync while the instance is still `pending` has nothing new to say: the step is a fact
      // about the machine, not a heartbeat, and it is only reported when it changes.
      await refresh(row.id)
      expect(getServer(opened.db, row.id)?.provisioningStep).toBe('instance_launching')

      clock += 60_000
      await refresh(row.id)

      const event = await stream.next()
      expect(event['step']).toBe('instance_running')
      // The label the SPA draws is "Machine running, waiting for SSH", and the status is what
      // makes that true: the provider has the machine up, and the row is STILL provisioning
      // because bootstrap owns the promotion. Running box, nothing installed on it yet.
      expect(event['status']).toBe('provisioning')
      const after = getServer(opened.db, row.id)!
      expect(after.provisioningStep).toBe('instance_running')
      expect(after.status).toBe('provisioning')

      await stream.close()
    })

    it('does not drag the row back down the list once bootstrap is under way', async () => {
      await slowBootingProvider()
      const { row, plan } = await createServer()
      clock += 60_000
      await refresh(row.id)
      expect(getServer(opened.db, row.id)?.provisioningStep).toBe('instance_running')

      // The install begins. From here the provider will answer `running` to every describe for
      // the rest of the create — the ticker syncs each row every ten seconds — so a milestone
      // reported unconditionally would walk the timeline BACKWARDS on the next tick, from
      // "Installing tools" to "Machine running", over and over until the box was ready.
      applyAgentState({ db: opened.db, events, secrets }, getServer(opened.db, row.id)!, journalAt(plan, firstToolStep(plan).id))
      expect(getServer(opened.db, row.id)?.provisioningStep).toBe('installing_tools')

      await refresh(row.id)
      await refresh(row.id)

      expect(getServer(opened.db, row.id)?.provisioningStep).toBe('installing_tools')
    })
  })

  it('promotes the row on the same vocabulary it puts on the wire', async () => {
    const { row, plan } = await createServer()
    const stream = await openEventStream()

    applyAgentState({ db: opened.db, events, secrets }, row, journalAt(plan, firstToolStep(plan).id))
    await stream.next()

    // The row and the event agree: a refresh and a live update show the same thing, which is
    // the property that failed on the owner's create — the row advanced, the stream did not.
    expect(getServer(opened.db, row.id)?.provisioningStep).toBe('installing_tools')

    await stream.close()
  })
})
