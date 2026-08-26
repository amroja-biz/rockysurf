import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDatabase, type Db, type OpenedDatabase } from '../db/client.js'
import { getBootstrapReport, getServer, insertServer, setProviderData, updateServerStatus } from '../db/repositories/servers.js'
import { listEventsForServer, upsertUserByGithubId } from '../db/repositories/users.js'
import type { ServerRow } from '../db/schema.js'
import { createEventsService, type EventsService } from '../services/events.js'
import { failBootstrap, recordWarnings, terminatesInstance } from './failure.js'
import { explainStep, type BootstrapReport, type StepReport } from './failure-report.js'

/**
 * The rule from the owner (ADR-0010): a failed TOOL install releases the machine, everything
 * else keeps it, and whatever happened the row says so. These tests state the rule against
 * the real repositories with a registry whose `terminate` is a spy.
 */

let opened: OpenedDatabase
let db: Db
let events: EventsService
let row: ServerRow

const toolFailure = (): StepReport =>
  explainStep({
    stepId: 'tool:build-essential',
    captured: { log: 'E: Failed to fetch http://us-east-1.ec2.ports.ubuntu.com/x.deb  503  Service Unavailable\nE: Unable to fetch some archives', complete: true },
    labels: { toolName: () => 'Build Essential' },
  })

const repoFailure = (): StepReport =>
  explainStep({
    stepId: 'repo:my-app',
    captured: { log: "fatal: repository 'https://github.com/acme/my-app/' not found", complete: false },
    labels: { repoUrl: () => 'https://github.com/acme/my-app' },
  })

function registryWith(terminate: (data: unknown) => Promise<void>) {
  return { has: () => true, get: () => ({ terminate }) } as never
}

beforeEach(() => {
  opened = openTestDatabase()
  db = opened.db
  events = createEventsService()
  const userId = upsertUserByGithubId(db, { githubId: '1', githubUsername: 'octocat' }).id
  row = insertServer(db, { userId, name: 'dev-box', provider: 'fake', size: 'small', offeringId: 'fake-small', arch: 'arm64' })
  updateServerStatus(db, row.id, 'provisioning')
  row = setProviderData(db, row.id, { instanceId: 'i-1' })
})

afterEach(() => opened.close())

describe('the rule', () => {
  it('is: a tool failure under the default policy, and nothing else', () => {
    expect(terminatesInstance({ phase: 'tool' })).toBe(true)
    expect(terminatesInstance({ phase: 'tool' }, 'terminate')).toBe(true)
    expect(terminatesInstance({ phase: 'tool' }, 'keep')).toBe(false)
    expect(terminatesInstance({ phase: 'repo' })).toBe(false)
    expect(terminatesInstance({ phase: 'setup' })).toBe(false)
    expect(terminatesInstance({ phase: 'finishing' })).toBe(false)
  })
})

describe('a failed tool install', () => {
  it('releases the machine, stops the meter, and says so on the row', async () => {
    const terminate = vi.fn(async () => {})
    const received: unknown[] = []
    events.subscribe(row.userId, (payload) => received.push(payload))

    const failed = await failBootstrap({ db, events, registry: registryWith(terminate), log: () => {} }, row, { failure: toolFailure() })

    expect(terminate).toHaveBeenCalledWith({ instanceId: 'i-1' })
    expect(failed.status).toBe('failed')
    // The meter stops on this tick, not the next sync's.
    expect(failed.providerState).toBe('terminated')

    const report = getBootstrapReport<BootstrapReport>(failed)!
    expect(report.failure?.instance).toBe('terminated')
    expect(report.failure?.cause).toBe('apt-mirror')
    expect(report.failure?.log).toContain('503')
    expect(report.failure?.logComplete).toBe(true)
    // The paragraph: what failed and what happened to the machine, in that order.
    expect(failed.errorMessage).toContain('Build Essential could not be installed')
    expect(failed.errorMessage).toContain('not billing')
    expect(received[0]).toMatchObject({ type: 'server-status', status: 'failed', error: failed.errorMessage })
    expect(listEventsForServer(db, row.id).map((e) => e.type)).toContain('bootstrap.failed')
  })

  it('keeps the machine when the operator asked for that, and says why it is still billing', async () => {
    const terminate = vi.fn(async () => {})
    const failed = await failBootstrap(
      { db, events, registry: registryWith(terminate), onFailure: 'keep', log: () => {} },
      row,
      { failure: toolFailure() },
    )
    expect(terminate).not.toHaveBeenCalled()
    expect(getBootstrapReport<BootstrapReport>(failed)?.failure?.instance).toBe('kept')
    expect(failed.errorMessage).toContain('bootstrap.onFailure')
    expect(failed.errorMessage).toContain('still billing')
  })

  it('still fails the row when the provider will not release the machine, and says the bill may be running', async () => {
    const failed = await failBootstrap(
      {
        db,
        events,
        registry: registryWith(async () => {
          throw new Error('provider is down')
        }),
        log: () => {},
      },
      row,
      { failure: toolFailure() },
    )
    expect(failed.status).toBe('failed')
    expect(failed.providerState).not.toBe('terminated')
    const report = getBootstrapReport<BootstrapReport>(failed)!
    expect(report.failure?.instance).toBe('terminate-failed')
    expect(report.failure?.instanceNote).toContain('provider is down')
    expect(failed.errorMessage).toContain('may still be billing')
  })

  it('has nothing to release when the row never reached a provider', async () => {
    const terminate = vi.fn(async () => {})
    const bare = setProviderData(db, row.id, {})
    const failed = await failBootstrap({ db, events, registry: registryWith(terminate), log: () => {} }, { ...bare, providerData: null }, {
      failure: toolFailure(),
    })
    expect(terminate).not.toHaveBeenCalled()
    expect(failed.status).toBe('failed')
    expect(getBootstrapReport<BootstrapReport>(failed)?.failure?.instanceNote).toContain('no machine')
  })
})

describe('any other failure', () => {
  it('keeps the machine and explains that only a tool install releases it', async () => {
    const terminate = vi.fn(async () => {})
    const failed = await failBootstrap({ db, events, registry: registryWith(terminate), log: () => {} }, row, { failure: repoFailure() })
    expect(terminate).not.toHaveBeenCalled()
    expect(failed.status).toBe('failed')
    const report = getBootstrapReport<BootstrapReport>(failed)!
    expect(report.failure?.instance).toBe('kept')
    expect(report.failure?.instanceNote).toContain('a repository clone')
    expect(failed.errorMessage).toContain('https://github.com/acme/my-app could not be cloned')
  })

  it('carries the warnings that came before the failure', async () => {
    const failed = await failBootstrap({ db, events, registry: registryWith(async () => {}), log: () => {} }, row, {
      failure: toolFailure(),
      warnings: [repoFailure()],
      agentLogTail: '--- repo:my-app: FAILED (rc=128)',
    })
    const report = getBootstrapReport<BootstrapReport>(failed)!
    expect(report.warnings.map((w) => w.stepId)).toEqual(['repo:my-app'])
    expect(report.agentLogTail).toContain('rc=128')
  })
})

describe('a failure after warnings arrived one at a time (callback mode)', () => {
  it('keeps the earlier warnings on the report, minus the step that has now failed for real', async () => {
    const earlier = recordWarnings({ db }, row, { warnings: [repoFailure()], mode: 'merge' })
    const failed = await failBootstrap({ db, events, registry: registryWith(async () => {}), log: () => {} }, earlier, {
      failure: toolFailure(),
    })
    const report = getBootstrapReport<BootstrapReport>(failed)!
    expect(report.failure?.stepId).toBe('tool:build-essential')
    expect(report.warnings.map((w) => w.stepId)).toEqual(['repo:my-app'])
  })
})

describe('warnings on a box that came up', () => {
  it('replaces the whole list in push mode, and clears it when there is nothing to say', () => {
    recordWarnings({ db }, row, { warnings: [repoFailure()], mode: 'replace' })
    expect(getBootstrapReport<BootstrapReport>(getServer(db, row.id)!)?.warnings).toHaveLength(1)
    expect(listEventsForServer(db, row.id).map((e) => e.type)).toContain('bootstrap.warning')

    const cleared = recordWarnings({ db }, getServer(db, row.id)!, { warnings: [], mode: 'replace' })
    expect(cleared.bootstrapReport).toBeNull()
  })

  it('merges one step at a time in callback mode, keyed by step id', () => {
    recordWarnings({ db }, row, { warnings: [repoFailure()], mode: 'merge' })
    const other = explainStep({ stepId: 'repo:other', captured: { log: 'fatal: x', complete: false } })
    recordWarnings({ db }, getServer(db, row.id)!, { warnings: [other], mode: 'merge' })
    // The same step again updates in place rather than duplicating.
    recordWarnings({ db }, getServer(db, row.id)!, { warnings: [repoFailure()], mode: 'merge' })

    const report = getBootstrapReport<BootstrapReport>(getServer(db, row.id)!)!
    expect(report.warnings.map((w) => w.stepId).sort()).toEqual(['repo:my-app', 'repo:other'])
  })
})
