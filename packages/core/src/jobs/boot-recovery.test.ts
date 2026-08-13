import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_PASSWORD_ENV } from '../auth/admin.js'
import { defaultDatabasePath, openDatabase } from '../db/client.js'
import { getServer, insertServer, setProviderData, updateServerStatus } from '../db/repositories/servers.js'
import { listEventsForServer, upsertUserByGithubId } from '../db/repositories/users.js'
import { boot } from '../server.js'

/**
 * THE RESTART, through the real `boot()` path.
 *
 * This is the criterion rockysurf-55fx.4 left open and this task owes: the mechanism (run id
 * filtering plus resume) was proven in units and in the docker smoke test, but nothing killed
 * core and brought it back. The tests below do exactly that — write a database as a dying
 * process would leave it, then boot a fresh core over the same data directory and assert it
 * does something definite with every mid-flight row.
 *
 * Why through `boot()` and not `runStartupRecovery()` directly: the unit tests already cover
 * the pass's logic. What is unproven at that level is the WIRING — that boot actually calls it,
 * before the timers start, on the real database. That is the line that was missing for the
 * secrets store once already (`boot-keys.test.ts` exists because of it), and it is invisible to
 * every test that constructs the pass itself.
 */

const PASSWORD = 'correct-horse-battery-staple'

let dataDir: string
let booted: Awaited<ReturnType<typeof boot>> | undefined
let savedPassword: string | undefined

const dbPath = () => defaultDatabasePath(join(dataDir, 'data'))

/** Write the database the way a process killed mid-provision would have left it. */
function seedInterruptedServer(options: { provisioned: boolean }): string {
  const opened = openDatabase({ url: dbPath() })
  try {
    const userId = upsertUserByGithubId(opened.db, { githubId: '9', githubUsername: 'interrupted' }).id
    const row = insertServer(opened.db, {
      userId,
      name: 'mid-flight',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })
    if (options.provisioned) {
      setProviderData(opened.db, row.id, { instanceId: `i-${row.id}` })
      updateServerStatus(opened.db, row.id, 'provisioning')
    }
    return row.id
  } finally {
    opened.close()
  }
}

async function bootCore(): Promise<void> {
  process.env[ADMIN_PASSWORD_ENV] = PASSWORD
  booted = await boot({ argv: [], cwd: dataDir, env: {}, listen: false, log: () => {}, announce: () => {} })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rockysurf-recovery-'))
  savedPassword = process.env[ADMIN_PASSWORD_ENV]
  writeFileSync(join(dataDir, 'rockysurf.config.yaml'), `server:\n  dataDir: "${join(dataDir, 'data')}"\n`)
})

afterEach(async () => {
  await booted?.close()
  booted = undefined
  if (savedPassword === undefined) delete process.env[ADMIN_PASSWORD_ENV]
  else process.env[ADMIN_PASSWORD_ENV] = savedPassword
  rmSync(dataDir, { recursive: true, force: true })
})

describe('core restarts over a database left mid-flight', () => {
  // 20s, deliberately: this row carries provider data for an instance the fake provider has
  // never heard of, so `sync` walks the full DESCRIBE_ABSENCE_GRACE before it will call
  // absence "gone" (amendment A4). The slowness IS the behaviour under test — a recovery pass
  // that answered instantly here would be one that had skipped the grace.
  it('never leaves a row in its interrupted state', { timeout: 20_000 }, async () => {
    // First boot creates the database and the admin, then "dies".
    await bootCore()
    await booted!.close()
    booted = undefined

    const serverId = seedInterruptedServer({ provisioned: true })

    // Second boot: a brand new core over the same data directory.
    await bootCore()

    const row = getServer(booted!.db.db, serverId)!
    // Either outcome is acceptable; being left untouched in `provisioning` is not, because
    // nothing would ever move it again.
    expect(['provisioning', 'running', 'failed', 'terminated']).toContain(row.status)
    const kinds = listEventsForServer(booted!.db.db, serverId).map((e) => e.type)
    expect(
      kinds.some((k) => k.startsWith('recovery.')),
      `recovery said nothing about ${serverId}; events were ${kinds.join(', ') || '(none)'}`,
    ).toBe(true)
  })

  it('fails a row whose provider was never called, with the reason preserved', async () => {
    await bootCore()
    await booted!.close()
    booted = undefined

    // The clean half of the inverted create ordering: the row exists, no instance does.
    const serverId = seedInterruptedServer({ provisioned: false })

    await bootCore()

    const row = getServer(booted!.db.db, serverId)!
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toMatch(/before the provider was called/)
    expect(listEventsForServer(booted!.db.db, serverId).some((e) => e.type === 'recovery.failed')).toBe(true)
  })

  it('runs the recovery pass even when core is not listening', async () => {
    // `listen: false` is how the CLI and the tests open core. It is still core waking up, and
    // a row left stuck is just as stuck.
    await bootCore()
    await booted!.close()
    booted = undefined

    const serverId = seedInterruptedServer({ provisioned: false })
    await bootCore()

    expect(getServer(booted!.db.db, serverId)!.status).toBe('failed')
  })

  it('boots cleanly when there was nothing mid-flight', async () => {
    await bootCore()
    await booted!.close()
    booted = undefined

    await expect(bootCore()).resolves.toBeUndefined()
  })
})
