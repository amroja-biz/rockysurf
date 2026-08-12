import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getServer, insertServer, setProviderData, updateServerStatus } from '../db/repositories/servers.js'
import { listEventsForServer, upsertUserByGithubId } from '../db/repositories/users.js'
import type { ServerRow } from '../db/schema.js'
import { runStartupRecovery } from './recovery.js'

/**
 * The startup recovery pass, and with it the criterion left open by rockysurf-55fx.4:
 * core dies mid-install, comes back, and re-attaches instead of leaving the row stuck.
 */

let opened: OpenedDatabase
let userId: string

function seedMidFlight(options: { provisioned?: boolean; status?: 'requested' | 'provisioning' } = {}): ServerRow {
  const row = insertServer(opened.db, {
    userId,
    name: 'dev-box',
    provider: 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
  })
  if (options.provisioned !== false) setProviderData(opened.db, row.id, { instanceId: `i-${row.id}` })
  if ((options.status ?? 'provisioning') === 'provisioning') updateServerStatus(opened.db, row.id, 'provisioning')
  return getServer(opened.db, row.id)!
}

beforeEach(() => {
  opened = openTestDatabase()
  userId = upsertUserByGithubId(opened.db, { githubId: '1', githubUsername: 'tester' }).id
})

afterEach(() => {
  opened.close()
})

describe('nothing is left stuck', () => {
  it('fails a row that never reached the provider, with a reason', async () => {
    // The clean half of the inverted create ordering: no instance was made, so nothing is
    // orphaned — but the row must not sit in `requested` forever either.
    const row = seedMidFlight({ provisioned: false, status: 'requested' })
    const result = await runStartupRecovery({ db: opened.db, sync: async (r) => r })

    expect(result.failed).toEqual([row.id])
    const after = getServer(opened.db, row.id)!
    expect(after.status).toBe('failed')
    expect(after.errorMessage).toMatch(/before the provider was called/)
  })

  it('examines every mid-flight row and leaves none in its original state', async () => {
    const a = seedMidFlight({ provisioned: false, status: 'requested' })
    const b = seedMidFlight()
    const result = await runStartupRecovery({ db: opened.db, sync: async (r) => r })

    expect(result.examined).toBe(2)
    expect([...result.failed, ...result.reattached, ...result.settled].sort()).toEqual([a.id, b.id].sort())
  })

  it('keeps going when one row throws, failing that row cleanly', async () => {
    const bad = seedMidFlight()
    const good = seedMidFlight()
    const sync = vi.fn(async (r: ServerRow) => {
      if (r.id === bad.id) throw new Error('provider exploded')
      return r
    })

    const result = await runStartupRecovery({ db: opened.db, sync })
    expect(result.failed).toContain(bad.id)
    expect(result.reattached).toContain(good.id)
    expect(getServer(opened.db, bad.id)!.status).toBe('failed')
  })
})

describe('what the provider says happened while core was down', () => {
  it('settles a row whose instance is gone', async () => {
    const row = seedMidFlight()
    // sync() owns the propagation grace (amendment A4): recovery believes it rather than
    // deciding for itself that absence means terminated.
    const sync = async () => updateServerStatus(opened.db, row.id, 'terminated')

    const result = await runStartupRecovery({ db: opened.db, sync })
    expect(result.settled).toEqual([row.id])
    expect(listEventsForServer(opened.db, row.id).some((e) => e.type === 'recovery.settled')).toBe(true)
  })

  it('re-attaches a row whose instance is still alive', async () => {
    const row = seedMidFlight()
    const result = await runStartupRecovery({ db: opened.db, sync: async (r) => r })

    expect(result.reattached).toEqual([row.id])
    // Still provisioning, NOT failed: an install may well be running on that box right now.
    expect(getServer(opened.db, row.id)!.status).toBe('provisioning')
  })
})

describe('re-attaching to an install that outlived core (rockysurf-55fx.4 criterion)', () => {
  it('reads the box journal and resumes watching rather than restarting the install', async () => {
    const row = seedMidFlight()
    // The agent kept installing under its transient systemd unit while core was dead. This is
    // the whole reason push mode launches it detached: core restarting is not the box's problem.
    const poll = vi.fn(async () => ({ step: 'installing_tools' }))

    const result = await runStartupRecovery({ db: opened.db, sync: async (r) => r, bootstrap: { poll } })

    expect(poll).toHaveBeenCalledOnce()
    expect(result.reattached).toEqual([row.id])
    const event = listEventsForServer(opened.db, row.id).find((e) => e.type === 'recovery.reattached')
    expect(event).toBeDefined()
    expect(JSON.parse(event!.payload!)).toMatchObject({ step: 'installing_tools' })
    // Nothing re-ran the install: recovery's only job is to start watching again.
    expect(getServer(opened.db, row.id)!.status).toBe('provisioning')
  })

  it('fails the row when the journal says a step failed while core was away', async () => {
    const row = seedMidFlight()
    const poll = vi.fn(async () => ({ failed: true, error: 'step tool:node failed: no space left on device' }))

    const result = await runStartupRecovery({ db: opened.db, sync: async (r) => r, bootstrap: { poll } })

    expect(result.failed).toEqual([row.id])
    const after = getServer(opened.db, row.id)!
    expect(after.status).toBe('failed')
    // The reason survives the restart, which is the only way the operator learns what happened
    // on a box that may already be gone.
    expect(after.errorMessage).toMatch(/no space left on device/)
  })

  it('re-attaches even when the box has nothing to report yet', async () => {
    // A box that is still booting is not an error; it is a box that is still booting.
    const row = seedMidFlight()
    const result = await runStartupRecovery({
      db: opened.db,
      sync: async (r) => r,
      bootstrap: { poll: async () => undefined },
    })
    expect(result.reattached).toEqual([row.id])
    expect(getServer(opened.db, row.id)!.status).toBe('provisioning')
  })

  it('does nothing at all when no row was mid-flight', async () => {
    const result = await runStartupRecovery({ db: opened.db, sync: async (r) => r })
    expect(result).toEqual({ examined: 0, reattached: [], settled: [], failed: [] })
  })
})
