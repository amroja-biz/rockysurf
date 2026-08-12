import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDatabase, type Db, type OpenedDatabase } from '../db/client.js'
import {
  getServer,
  insertServer,
  setInstallPlan,
  setNetworkAddress,
  updateServerStatus,
} from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { createSecretsStore, type SecretsStore } from '../secrets/store.js'
import { createEventsService, type EventsService } from '../services/events.js'
import type { ServerRow } from '../db/schema.js'
import { HostKeyMismatchError, type AgentState, type PushResult } from './push.js'
import { MissingKeyMaterialError, type runPushBootstrap } from './push-runner.js'
import { createPushBootstrapSupervisor } from './supervisor.js'

/**
 * The adapter between the provision ticker and the push runner (rockysurf-55fx.13).
 *
 * These tests exist because nothing connected these two modules at all: the ticker declared a
 * `BootstrapPoller` seam, `runPushBootstrap` was written to fill it, and no code ever called
 * it — so on the real stack a server booted, went `running`, and sat there with nothing
 * installed. What is protected here is the shape mismatch that made the seam non-trivial: a
 * per-tick `poll()` driving a minutes-long SSH session.
 */

let opened: OpenedDatabase
let db: Db
let events: EventsService
let secrets: SecretsStore
let row: ServerRow

const PLAN = {
  version: 1,
  serverId: 'placeholder',
  mode: 'push',
  runId: 'plan-run',
  steps: [{ id: 'tool:node', reports: 'installing_tools', runAs: 'rocky', run: 'true' }],
}

const state = (over: Partial<AgentState> = {}): AgentState => ({
  planVersion: 1,
  serverId: row.id,
  runId: 'run-1',
  step: 'tool:node',
  status: 'done',
  updatedAt: new Date().toISOString(),
  steps: [],
  ...over,
})

const result = (over: Partial<PushResult> = {}): PushResult => ({
  launcher: 'systemd-run',
  state: state(),
  durationMs: 1,
  runId: 'run-1',
  skipped: [],
  ...over,
})

/** A stand-in for the real SSH drive, so these tests never open a socket. */
function fakeRun(impl: () => Promise<PushResult>): typeof runPushBootstrap {
  return (async () => await impl()) as typeof runPushBootstrap
}

const supervisor = (run: typeof runPushBootstrap, over: { maxAttempts?: number } = {}) =>
  createPushBootstrapSupervisor({
    db,
    events,
    secrets,
    log: () => {},
    run,
    ...over,
  })

/** Poll until the in-flight drive has settled, the way successive ticks would. */
async function pollUntilOutcome(poller: { poll: (r: ServerRow) => Promise<unknown> }) {
  return await vi.waitFor(async () => {
    const outcome = await poller.poll(getServer(db, row.id)!)
    expect(outcome).toBeTruthy()
    return outcome as { failed?: boolean; error?: string }
  })
}

beforeEach(() => {
  opened = openTestDatabase()
  db = opened.db
  events = createEventsService()
  secrets = createSecretsStore(db, randomBytes(32))
  const userId = upsertUserByGithubId(db, { githubId: '1', githubUsername: 'octocat' }).id
  row = insertServer(db, {
    userId,
    name: 'dev-box',
    provider: 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
  })
  updateServerStatus(db, row.id, 'provisioning')
  setNetworkAddress(db, row.id, { publicIp: '203.0.113.10' })
  setInstallPlan(db, row.id, { ...PLAN, serverId: row.id })
  row = getServer(db, row.id)!
})

afterEach(() => {
  opened.close()
})

describe('driving one push', () => {
  it('starts the drive on the first poll and answers immediately', async () => {
    let released: (() => void) | undefined
    const started = vi.fn()
    const poller = supervisor(
      fakeRun(async () => {
        started()
        await new Promise<void>((resolve) => (released = resolve))
        return result()
      }),
    )

    // The ticker asks a question every ten seconds; it cannot be made to wait out an install.
    expect(await poller.poll(row)).toBeUndefined()
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    released?.()
  })

  it('never runs two drives for one server at once', async () => {
    let released: (() => void) | undefined
    const started = vi.fn()
    const poller = supervisor(
      fakeRun(async () => {
        started()
        await new Promise<void>((resolve) => (released = resolve))
        return result()
      }),
    )

    await poller.poll(row)
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    // Six more ticks while the first install is still running. A second push would find the
    // live agent, mint a new run id, and both sides would wait on each other.
    for (let i = 0; i < 6; i++) expect(await poller.poll(row)).toBeUndefined()
    expect(started).toHaveBeenCalledTimes(1)
    released?.()
  })

  it('promotes the row to running and tells the user when the plan completes', async () => {
    const seen: { type: string; status?: string }[] = []
    events.subscribe(row.userId, (p) => seen.push(p as { type: string; status?: string }))

    const poller = supervisor(fakeRun(async () => result()))
    await poller.poll(row)

    await vi.waitFor(() => expect(getServer(db, row.id)?.status).toBe('running'))
    const done = getServer(db, row.id)!
    expect(done.provisioningStep).toBe('ready')
    // `startedAt` is stamped by the same rule that promotes, and it is what the cost ticker
    // accrues from — a server that never gets one is billed from nowhere.
    expect(done.startedAt).toBeTruthy()
    expect(seen.filter((e) => e.type === 'server-status').map((e) => e.status)).toContain('running')
  })
})

describe('failure', () => {
  it('reports a plan the agent could not finish, so the ticker fails the row', async () => {
    const poller = supervisor(
      fakeRun(async () => result({ state: state({ status: 'failed', failedStep: 'tool:node' }) })),
    )
    await poller.poll(row)

    const outcome = await pollUntilOutcome(poller)
    expect(outcome.failed).toBe(true)
    expect(outcome.error).toContain('tool:node')
    // The row is NOT failed here: failing it is the ticker's job, and it owns the event and the
    // instance teardown that go with it.
    expect(getServer(db, row.id)?.status).toBe('provisioning')
  })

  it('carries the reason onto the row, not just the step that failed', async () => {
    // Verbatim from the 55fx.9 exit run: the step name alone sent me digging through the
    // events table for the one line that explained it, which is not a thing a user can do.
    const logTail =
      '\u001b[0;34m==>\u001b[0m Installing to /home/rocky/.local/bin...\n' +
      '\u001b[0;31mError:\u001b[0m bd was installed but is not in PATH'
    const poller = supervisor(
      fakeRun(async () => result({ state: state({ status: 'failed', failedStep: 'tool:beads', logTail }) })),
    )
    await poller.poll(row)

    const outcome = await pollUntilOutcome(poller)
    expect(outcome.error).toContain('bd was installed but is not in PATH')
    // Colour codes stripped: a status field is read as text.
    expect(outcome.error).not.toContain('\u001b')
  })

  it('gives up immediately on a host-key mismatch instead of retrying it', async () => {
    const attempts = vi.fn()
    const poller = supervisor(
      fakeRun(async () => {
        attempts()
        throw new HostKeyMismatchError('SHA256:expected', 'SHA256:actual')
      }),
    )
    await poller.poll(row)

    const outcome = await pollUntilOutcome(poller)
    expect(outcome.failed).toBe(true)
    // The box answering is not the box core provisioned, and the next connection would carry
    // the secrets file to it. One attempt, then stop.
    expect(attempts).toHaveBeenCalledTimes(1)
    expect(outcome.error).toContain('host key mismatch')
  })

  it('gives up immediately when there is no key to connect with', async () => {
    const poller = supervisor(
      fakeRun(async () => {
        throw new MissingKeyMaterialError(row.id)
      }),
    )
    await poller.poll(row)
    expect((await pollUntilOutcome(poller)).failed).toBe(true)
  })

  it('retries a transient failure, then fails the server with the real reason', async () => {
    const attempts = vi.fn()
    const poller = supervisor(
      fakeRun(async () => {
        attempts()
        throw new Error('connect ETIMEDOUT')
      }),
      { maxAttempts: 3 },
    )

    let outcome: { failed?: boolean; error?: string } | undefined
    // Each tick starts a fresh drive; the box's journal makes that a resume, not a restart.
    for (let i = 0; i < 12 && !outcome?.failed; i++) {
      const answer = await poller.poll(getServer(db, row.id)!)
      if (answer) outcome = answer as { failed?: boolean; error?: string }
      await vi.waitFor(() => expect(attempts.mock.calls.length).toBeGreaterThan(0))
    }

    expect(attempts).toHaveBeenCalledTimes(3)
    expect(outcome?.failed).toBe(true)
    // The user is told what actually went wrong, not "provisioning did not complete within 30
    // minutes" half an hour later.
    expect(outcome?.error).toContain('ETIMEDOUT')
  })
})

describe('what it refuses to start', () => {
  it('waits rather than failing when the instance has no address yet', async () => {
    const started = vi.fn()
    const poller = supervisor(fakeRun(async () => (started(), result())))
    const noAddress = { ...row, publicIp: null }

    expect(await poller.poll(noAddress)).toBeUndefined()
    expect(started).not.toHaveBeenCalled()
  })

  it('fails a row that has no install plan, because nothing can fix that by waiting', async () => {
    const poller = supervisor(fakeRun(async () => result()))
    const outcome = (await poller.poll({ ...row, installPlan: null })) as { failed?: boolean; error?: string }

    expect(outcome.failed).toBe(true)
    expect(outcome.error).toContain('install plan')
  })
})
