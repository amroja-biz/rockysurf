import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { provisionServerKeys } from '../ssh/server-keys.js'
import type { ServerRow } from '../db/schema.js'
import { applyAgentState, runPushBootstrap } from './push-runner.js'
import { markBootstrapReady } from './supervisor.js'
import type { AgentState } from './push.js'

/**
 * WHERE CORE ACTUALLY DIALS (rockysurf-ftl9.12).
 *
 * The bug this file exists for was invisible to every test that stubbed the SSH drive: the port
 * a BYO host is registered on reached the provider, the provider used it for its own probe and
 * claim — and then died at the boundary, because `InstanceView` carried no port and the row had
 * no column. Core dialled 22. The host was claimed, given an account, keys and a sudoers rule,
 * and then never bootstrapped.
 *
 * So these tests assert against a REAL SOCKET rather than against a captured argument. A
 * listener on an ephemeral port stands in for the box's sshd; it accepts the TCP connection and
 * drops it, so the SSH handshake fails and `runPushBootstrap` rejects — which is fine, because
 * the fact under test is which port received a connection, not what happened after. A test that
 * asserted `PushTarget.port` instead would have passed on the broken code the day it shipped:
 * `PushTarget.port` already existed, and only a unit test ever set it.
 */

let opened: OpenedDatabase
let db: Db
let events: EventsService
let secrets: SecretsStore
let row: ServerRow

let listener: Server
let port: number
let connections: number

const PLAN = {
  version: 1,
  serverId: 'placeholder',
  mode: 'push',
  runId: 'plan-run',
  steps: [{ id: 'tool:node', reports: 'installing_tools', runAs: 'rocky', run: 'true' }],
}

function listen(): Promise<void> {
  return new Promise((resolve) => {
    listener = createServer((socket: Socket) => {
      connections++
      socket.destroy()
    })
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      port = typeof address === 'object' && address ? address.port : 0
      resolve()
    })
  })
}

/** Drive a push at the row as it now stands, and report only whether it reached us. */
async function attempt(): Promise<void> {
  await runPushBootstrap({ db, events, secrets }, getServer(db, row.id)!, {
    // Long enough for one connection attempt, short enough that a failure is a fast test.
    connectTimeoutMs: 400,
  }).catch(() => undefined)
}

beforeEach(async () => {
  connections = 0
  await listen()

  opened = openTestDatabase()
  db = opened.db
  events = createEventsService()
  secrets = createSecretsStore(db, randomBytes(32))
  const userId = upsertUserByGithubId(db, { githubId: '1', githubUsername: 'octocat' }).id
  row = insertServer(db, {
    userId,
    name: 'workshop',
    provider: 'byo',
    size: 'small',
    offeringId: 'workshop',
    arch: 'arm64',
  })
  updateServerStatus(db, row.id, 'provisioning')
  // The key material core authenticates with. Minted, not pinned: this stands in for a provider
  // that cannot inject a host key, which is the only kind that reports a port.
  provisionServerKeys(db, secrets, { serverId: row.id, pinHostKey: false })
  setInstallPlan(db, row.id, { ...PLAN, serverId: row.id })
  row = getServer(db, row.id)!
})

afterEach(async () => {
  opened.close()
  await new Promise<void>((resolve) => listener.close(() => resolve()))
})

describe('the port core dials in push mode', () => {
  it('is the one the provider reported, not 22', async () => {
    setNetworkAddress(db, row.id, { publicIp: '127.0.0.1', sshPort: port })

    await attempt()

    expect(connections).toBeGreaterThan(0)
  })

  it('is 22 when nothing reported one, which is every machine core provisioned itself', async () => {
    setNetworkAddress(db, row.id, { publicIp: '127.0.0.1' })

    await attempt()

    // The control for the test above: without a port on the row, this listener must see
    // nothing. Anything core reached on 22 is somebody else's sshd and not this assertion's
    // business.
    expect(connections).toBe(0)
  })

  it('lets an explicit option win over the row, for a caller that already knows better', async () => {
    setNetworkAddress(db, row.id, { publicIp: '127.0.0.1', sshPort: 1 })

    await runPushBootstrap({ db, events, secrets }, getServer(db, row.id)!, {
      sshPort: port,
      connectTimeoutMs: 400,
    }).catch(() => undefined)

    expect(connections).toBeGreaterThan(0)
  })
})

/**
 * WHEN A PUSH-MODE ROW BECOMES `running` (rockysurf-1c8z).
 *
 * `agent.sh` journals a step as `running` when it STARTS — `set_step "$id" running` sits above
 * `install_tool` deliberately, so the SPA's timeline can light the step that is happening. Every
 * plan the resolver renders ends with a step whose `reports` is `ready`, and
 * `recordProgress('ready')` is what flips the row to `running` and stamps `startedAt`. So the
 * row was promoted the moment the LAST step began: a box that then died mid-step read as
 * healthy, and uptime and cost accrual had already started.
 *
 * `supervisor.ts` had always claimed `markBootstrapReady` was "the ONLY thing" that promotes a
 * push-mode row. These pin that claim rather than the workaround.
 */
describe('a promoting report is not believed from the journal', () => {
  /** The journal as the agent writes it while a step is executing. */
  const journalAt = (stepId: string, stepStatus: 'running' | 'done'): AgentState => ({
    planVersion: 1,
    serverId: row.id,
    step: stepId,
    status: 'running',
    updatedAt: new Date().toISOString(),
    steps: [
      { id: 'tool:curl', reports: 'installing_tools', status: 'done' },
      { id: 'tool:branding', reports: 'ready', status: stepStatus },
    ],
  })

  it('leaves the row provisioning while the final step is still running', () => {
    applyAgentState({ db, events, secrets }, getServer(db, row.id)!, journalAt('tool:branding', 'running'))

    // The whole bug in one assertion: the box is mid-branding, and a machine that dies here must
    // not have read as running.
    expect(getServer(db, row.id)!.status).toBe('provisioning')
    expect(getServer(db, row.id)!.startedAt).toBeFalsy()
  })

  it('still leaves it provisioning once that step reports done, because completion is the drive’s to declare', () => {
    // Not an oversight: `markBootstrapReady` runs when the whole drive settles, which is a fact
    // about the run rather than about one step's exit code. A plan whose last step happened to
    // report something else must not strand a healthy box either.
    applyAgentState({ db, events, secrets }, getServer(db, row.id)!, journalAt('tool:branding', 'done'))
    expect(getServer(db, row.id)!.status).toBe('provisioning')
  })

  it('still records the ordinary steps, so the timeline lights up as they happen', () => {
    // The fix must not cost the thing rockysurf-xinr bought: a step that reports a NON-promoting
    // label is recorded while it runs, which is what drives the SPA's timeline.
    applyAgentState({ db, events, secrets }, getServer(db, row.id)!, journalAt('tool:curl', 'running'))
    expect(getServer(db, row.id)!.provisioningStep).toBe('installing_tools')
    expect(getServer(db, row.id)!.status).toBe('provisioning')
  })

  it('promotes when the supervisor says the drive finished, and not before', async () => {
    // The other half: having refused the journal's claim, something must still promote — and
    // the row must reach `running` with `startedAt` stamped.
    const promoted = await markBootstrapReady(db, events, getServer(db, row.id)!)
    expect(promoted?.status).toBe('running')
    expect(promoted?.startedAt).toBeTruthy()
  })
})
