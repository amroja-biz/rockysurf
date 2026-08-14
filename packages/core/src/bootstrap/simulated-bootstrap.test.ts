import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type Db, type OpenedDatabase } from '../db/client.js'
import {
  getServer,
  insertServer,
  setInstallPlan,
  setNetworkAddress,
  updateServerStatus,
} from '../db/repositories/servers.js'
import { setSetting } from '../db/repositories/settings.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import type { ServerRow } from '../db/schema.js'
import { loadPacksFromDir } from '../packs/loader.js'
import { syncPacksToDb } from '../packs/sync.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createSecretsStore, type SecretsStore } from '../secrets/store.js'
import { createEventsService, type EventPayload, type EventsService } from '../services/events.js'
import { createSimulatedBootstrap, resolveBudgetMs, SIMULATED_BOOTSTRAP_MS_ENV } from './simulated-bootstrap.js'
import type { PushResult } from './push.js'
import type { runPushBootstrap } from './push-runner.js'
import { createPushBootstrapSupervisor } from './supervisor.js'

/**
 * The trial run somebody with no cloud account actually gets (rockysurf-8fkz).
 *
 * `compose.ts` has always registered the in-memory provider when nothing real is configured, and
 * has always said why: "so someone can run `npx rockysurf`, create a server, and see the whole UI
 * work without an AWS account". It did not work. Promotion out of `provisioning` belongs to a
 * server's own bootstrap (rockysurf-55fx.13) and the only two things that could report one needed
 * either SSH to a real box or a real box that could dial core — so the trial run reached
 * `instance_running`, stayed there, accrued no uptime, and was terminated by the 30-minute
 * timeout with no message explaining why.
 *
 * What is protected here is that the fix did NOT buy that outcome with a shortcut. There is no
 * second promotion path and no branch on a provider id: a provider that declares
 * `simulatedInstances` (ADR-0003, E15) gets its plan driven in-process by an agent that speaks the
 * same journal, and everything downstream — `recordProgress`, the timeline events, the promotion,
 * the uptime ticker, the spend cap — is the machinery a real create uses, untouched.
 */

const PASSWORD = 'correct-horse-battery-staple'

/** The shipped packs, so the plan being simulated is the one a real install would run. */
const packsDir = fileURLToPath(new URL('../../../../packs/', import.meta.url))

let opened: OpenedDatabase
let events: EventsService
let created: ReturnType<typeof createApp>
let cookie: string

/**
 * The trial-run installation: no cloud configured, so the in-memory provider is registered the
 * way `composeRegistry` registers it.
 */
async function startTrialApp(config: Config): Promise<void> {
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  created = createApp({
    db: opened.db,
    config,
    secrets,
    secretsStore: createSecretsStore(opened.db, randomBytes(32)),
    events,
    providers: new ProviderRegistry([makeFakeProvider({ bootMs: 0, simulateBootstrap: true })]),
  })
  const login = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
}

async function createServer(): Promise<ServerRow> {
  const res = await created.app.request('/api/v1/servers', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ size: 'small', packId: 'ai-coding-agents' }),
  })
  expect(res.status).toBe(201)
  const { serverId } = (await res.json()) as { serverId: string }
  return getServer(opened.db, serverId)!
}

/** Tick the job loop the way the running process does, until the row settles or time runs out. */
async function tickUntilRunning(serverId: string): Promise<ServerRow> {
  return await vi.waitFor(
    async () => {
      await created.jobs.runAllNow()
      const row = getServer(opened.db, serverId)!
      expect(row.status).toBe('running')
      return row
    },
    { timeout: 10_000, interval: 25 },
  )
}

beforeEach(() => {
  opened = openTestDatabase()
  syncPacksToDb(opened.db, loadPacksFromDir(packsDir))
  events = createEventsService()
  // Fast-forward, using the knob the demo tape and a CI run both use rather than a test-only
  // seam: if this variable stopped being read, this suite would take twenty seconds per case.
  vi.stubEnv(SIMULATED_BOOTSTRAP_MS_ENV, '0')
})

afterEach(async () => {
  await created?.jobs.stop()
  vi.unstubAllEnvs()
  opened.close()
})

describe('the no-cloud trial run', () => {
  it('reaches ready through the same pipeline a real create uses, with the timeline lit', async () => {
    await startTrialApp(configSchema.parse({}))
    const server = await createServer()

    const seen: EventPayload[] = []
    const unsubscribe = events.subscribe(server.userId, (payload) => seen.push(payload))
    try {
      const row = await tickUntilRunning(server.id)

      // Promotion, and the only kind there is: `recordProgress('ready')` flipped the row and
      // stamped the clock the uptime ticker bills from.
      expect(row.provisioningStep).toBe('ready')
      expect(row.startedAt).toBeTruthy()
      expect(row.errorMessage).toBeNull()

      // THE STEPS THE SPA'S TIMELINE IS WRITTEN AGAINST, in the provisioning-step vocabulary
      // rather than the plan's step ids (rockysurf-xinr). A trial run whose timeline never lights
      // up is the first impression this bead exists to fix, so it is asserted on the bytes core
      // broadcasts, not on the row.
      const progressSteps = seen
        .filter((payload) => (payload as { type?: string }).type === 'bootstrap-progress')
        .map((payload) => (payload as unknown as { step: string }).step)
      expect(progressSteps).toContain('installing_tools')
      expect(progressSteps.at(-1)).toBe('ready')

      // And the plan's own step ids travelled in the field that means "id", so the log a user
      // watches names the tools the pack really lists.
      const stepIds = seen
        .filter((payload) => (payload as { type?: string }).type === 'bootstrap-progress')
        .map((payload) => (payload as unknown as { stepId?: string }).stepId)
      expect(stepIds).toContain('tool:claude-code')
    } finally {
      unsubscribe()
    }
  })

  it('accrues uptime and estimated cost, so a spend cap can be crossed with no cloud account', async () => {
    // 0.001 USD against the fake catalogue's 0.01/hour: six minutes of uptime crosses it. This is
    // the measurement that could not be taken before — the row never reached `running`, so the
    // ticker never saw it and month-to-date spend was permanently zero (rockysurf-dec8).
    await startTrialApp(configSchema.parse({ limits: { spendCap: { amount: 0.001, currency: 'USD' } } }))
    const server = await createServer()
    const running = await tickUntilRunning(server.id)

    expect(running.hourlyCostAmount).toBe(0.01)

    // Six minutes of wall clock, without waiting six minutes: move the row's start and the
    // ticker's watermark back together, which is the same arithmetic the ticker does on a core
    // that has genuinely been up that long.
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString()
    opened.sqlite.prepare('UPDATE servers SET started_at = ? WHERE id = ?').run(sixMinutesAgo, server.id)
    setSetting(opened.db, 'jobs.uptime.accruedThrough', sixMinutesAgo)

    await created.jobs.runAllNow()

    const billed = getServer(opened.db, server.id)!
    expect(billed.totalUptimeSeconds).toBeGreaterThanOrEqual(6 * 60)
    expect(billed.estimatedTotalCost).toBeGreaterThanOrEqual(0.001)

    // The cap is now a fact about this installation, not configuration nothing enforces.
    const refused = await created.app.request('/api/v1/servers', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ size: 'small', packId: 'ai-coding-agents' }),
    })
    expect(refused.status).toBe(403)
    expect(JSON.stringify(await refused.json())).toContain('spendCap')

    // The doctrine's other half: the running server was not touched to pay for the refusal.
    expect(getServer(opened.db, server.id)!.status).toBe('running')
  })

  it('stops and starts afterwards, like any other running server', async () => {
    await startTrialApp(configSchema.parse({}))
    const server = await createServer()
    await tickUntilRunning(server.id)

    const stop = await created.app.request(`/api/v1/servers/${server.id}/stop`, { method: 'POST', headers: { cookie } })
    expect(stop.status).toBe(200)
    expect(getServer(opened.db, server.id)!.status).toBe('stopped')

    const start = await created.app.request(`/api/v1/servers/${server.id}/start`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(start.status).toBe(200)
    // Started, and NOT sent back through bootstrap: the box was already installed, and a second
    // simulated install would re-report steps the timeline has already passed.
    const restarted = getServer(opened.db, server.id)!
    expect(restarted.status).toBe('running')
    expect(restarted.provisioningStep).toBe('ready')
  })
})

/**
 * The blast radius, stated as a test.
 *
 * This provider's other job is the permanent CI test double, and hundreds of tests create a
 * server against it and then drive progress themselves — or assert that a row deliberately STAYS
 * in `provisioning`, which is the 55fx.13 rule. A simulation that ran for every fake provider
 * would be a second writer racing every one of them.
 */
describe('the CI test double', () => {
  it('does not simulate unless it is asked to', () => {
    expect(makeFakeProvider().capabilities.simulatedInstances).toBeUndefined()
    expect(makeFakeProvider({ simulateBootstrap: true }).capabilities.simulatedInstances).toBe(true)
  })
})

describe('choosing the drive', () => {
  let db: Db
  let secrets: SecretsStore
  let row: ServerRow

  const PLAN = {
    version: 1,
    serverId: 'placeholder',
    mode: 'push',
    runId: 'plan-run',
    steps: [
      { id: 'tool:node', reports: 'installing_tools', runAs: 'rocky', run: 'true' },
      { id: 'branding', reports: 'ready', runAs: 'root', run: 'true' },
    ],
  }

  beforeEach(() => {
    db = opened.db
    secrets = createSecretsStore(db, randomBytes(32))
    const userId = upsertUserByGithubId(db, { githubId: '1', githubUsername: 'octocat' }).id
    row = insertServer(db, {
      userId,
      name: 'dev-box',
      provider: 'imaginary',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })
    updateServerStatus(db, row.id, 'provisioning')
    setNetworkAddress(db, row.id, { publicIp: '203.0.113.10' })
    setInstallPlan(db, row.id, { ...PLAN, serverId: row.id })
    row = getServer(db, row.id)!
  })

  /** A stand-in for the real SSH drive, so these tests never open a socket. */
  const neverCalled = (async () => {
    throw new Error('the SSH drive was used for a provider with no machine')
  }) as typeof runPushBootstrap

  it('takes the simulated drive from the capability, not from the provider id', async () => {
    // The provider is called `imaginary`, and nothing in core has heard of it. All core knows is
    // what the capability says — which is the property ADR-0003 exists to protect.
    const poller = createPushBootstrapSupervisor({
      db,
      events,
      secrets,
      log: () => {},
      run: neverCalled,
      capabilities: () => ({
        stop: true,
        ipStableAcrossStop: true,
        canInjectHostKeys: true,
        userDataMaxBytes: 32768,
        generatesUserData: true,
        simulatedInstances: true,
      }),
      simulate: createSimulatedBootstrap({ totalMs: 0 }),
    })

    await poller.poll(row)
    await vi.waitFor(() => {
      expect(getServer(db, row.id)!.status).toBe('running')
    })
    expect(getServer(db, row.id)!.provisioningStep).toBe('ready')
  })

  it('uses the real SSH drive when the provider claims a real machine', async () => {
    const run = vi.fn(async () => ({ launcher: 'nohup', state: { status: 'done' }, durationMs: 1, runId: 'r', skipped: [] }) as unknown as PushResult)
    const poller = createPushBootstrapSupervisor({
      db,
      events,
      secrets,
      log: () => {},
      run: run as unknown as typeof runPushBootstrap,
      capabilities: () => ({
        stop: true,
        ipStableAcrossStop: true,
        canInjectHostKeys: true,
        userDataMaxBytes: 32768,
        generatesUserData: true,
      }),
      simulate: createSimulatedBootstrap({ totalMs: 0 }),
    })

    await poller.poll(row)
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalled()
    })
  })

  it('says plainly what is wrong when a provider declares the capability and nothing is wired', async () => {
    const messages: string[] = []
    const poller = createPushBootstrapSupervisor({
      db,
      events,
      secrets,
      log: (message) => messages.push(message),
      run: neverCalled,
      maxAttempts: 1,
      capabilities: () => ({
        stop: true,
        ipStableAcrossStop: true,
        canInjectHostKeys: true,
        userDataMaxBytes: 32768,
        generatesUserData: true,
        simulatedInstances: true,
      }),
    })

    await poller.poll(row)
    const outcome = await vi.waitFor(async () => {
      const result = await poller.poll(getServer(db, row.id)!)
      expect(result).toBeTruthy()
      return result as { failed?: boolean; error?: string }
    })

    // Not "connection refused" from a dial at a fake address: the misconfiguration, named.
    expect(outcome.failed).toBe(true)
    expect(outcome.error).toContain('simulatedInstances')
  })
})

describe('pacing', () => {
  it('spends its budget across the plan, so the timeline is watchable at any pack size', async () => {
    const db = opened.db
    const userId = upsertUserByGithubId(db, { githubId: '2', githubUsername: 'hubot' }).id
    let row = insertServer(db, {
      userId,
      name: 'paced',
      provider: 'imaginary',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })
    updateServerStatus(db, row.id, 'provisioning')
    setInstallPlan(db, row.id, {
      version: 1,
      serverId: row.id,
      mode: 'push',
      runId: 'plan-run',
      steps: [
        { id: 'tool:a', reports: 'installing_tools', runAs: 'rocky', run: 'true' },
        { id: 'tool:b', reports: 'installing_tools', runAs: 'rocky', run: 'true' },
        { id: 'tool:c', reports: 'installing_tools', runAs: 'rocky', run: 'true' },
        { id: 'branding', reports: 'ready', runAs: 'root', run: 'true' },
      ],
    })
    row = getServer(db, row.id)!

    const slept: number[] = []
    const run = createSimulatedBootstrap({
      totalMs: 8000,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })

    const result = await run({ db, events, secrets: createSecretsStore(db, randomBytes(32)) }, row)

    // One pause per step, and the whole thing lands on the budget rather than on the pack size.
    expect(slept).toEqual([2000, 2000, 2000, 2000])
    expect(result.launcher).toBe('simulated')
    expect(result.state.status).toBe('done')

    // The drive advanced the timeline as far as a DRIVE can: `installing_tools` is the last
    // non-promoting label in this plan. It deliberately does not leave the row at `ready`
    // (rockysurf-1c8z) — declaring the box ready is the supervisor's call, made when the whole
    // run settles, and this function is invoked here without one. Asserting `ready` from here
    // was asserting the coupling that let a mid-final-step death read as running.
    expect(getServer(db, row.id)!.provisioningStep).toBe('installing_tools')
    expect(getServer(db, row.id)!.status).toBe('provisioning')
  })

  it('takes its budget from the environment, and shrugs off a typo in it', () => {
    expect(resolveBudgetMs({ env: { [SIMULATED_BOOTSTRAP_MS_ENV]: '1500' } })).toBe(1500)
    expect(resolveBudgetMs({ env: { [SIMULATED_BOOTSTRAP_MS_ENV]: '0' } })).toBe(0)
    // A pacing knob must not be the reason somebody's first server fails to bootstrap.
    expect(resolveBudgetMs({ env: { [SIMULATED_BOOTSTRAP_MS_ENV]: 'soon' } })).toBe(20_000)
    expect(resolveBudgetMs({ env: {} })).toBe(20_000)
  })
})
