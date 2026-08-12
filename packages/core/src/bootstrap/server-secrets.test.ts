import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, type BootedApp } from '../server.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { newServerId, newUserId } from '../db/ids.js'
import { servers, users, type ServerRow } from '../db/schema.js'
import { createSecretsStore } from '../secrets/store.js'
import { mintCallbackTokens } from '../db/repositories/bootstrap-tokens.js'
import { createServerSecretsLoader, SECRET_ENV_KEYS, SECRET_ENV_KEY_NAMES } from './server-secrets.js'

/**
 * The secrets hook, unit-tested AND wired-tested (rockysurf-55fx.14).
 *
 * The wiring half is the point. `loadServerSecrets` had a passing unit-tested consumer on both
 * sides — the callback route served whatever it was handed, the push runner wrote whatever it
 * was given — and production still delivered nothing, because `boot()` never supplied the hook.
 * That is the same shape of gap 55fx.13 found: every unit test built the wiring it needed and
 * then asserted on it, which is exactly the test that cannot see a missing composition.
 */

let opened: OpenedDatabase

function seed(): { row: ServerRow; userId: string } {
  const userId = newUserId()
  const now = new Date().toISOString()
  // Unique identity per call: `users` has unique indexes on both GitHub columns, so two
  // servers for two different people need two distinct users.
  opened.db
    .insert(users)
    .values({
      id: userId,
      githubId: `gh:${userId}`,
      githubUsername: userId,
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const id = newServerId()
  const [row] = opened.db
    .insert(servers)
    .values({
      id,
      userId,
      name: id,
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
      status: 'provisioning',
      bootstrapMode: 'push',
      idempotencyKey: id,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()
  return { row: row!, userId }
}

beforeEach(() => {
  opened = openTestDatabase()
})

afterEach(() => {
  opened.close()
})

describe('the key-name contract', () => {
  it('is exactly the names packs are promised', () => {
    // Changing either of these breaks every pack written against them. The list is asserted
    // here so a rename has to be a deliberate act with a failing test in front of it.
    expect(SECRET_ENV_KEYS.githubToken).toBe('GITHUB_TOKEN')
    expect(SECRET_ENV_KEYS.rdpPassword).toBe('RDP_PASSWORD')
    expect([...SECRET_ENV_KEY_NAMES].sort()).toEqual(['GITHUB_TOKEN', 'RDP_PASSWORD'])
  })
})

describe('loading a server’s secrets', () => {
  it('reads the git token by USER and the desktop password by SERVER', () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row, userId } = seed()

    // One token per user, reused across their servers; one desktop password per box, because
    // it is set on that box's own `rocky` account.
    store.putGithubToken(userId, 'ghp_private_repos')
    store.putRdpPassword(row.id, 'hunter2')

    return createServerSecretsLoader(store)(row).then((env) => {
      expect(env).toEqual({ GITHUB_TOKEN: 'ghp_private_repos', RDP_PASSWORD: 'hunter2' })
    })
  })

  it('omits a key that has no secret rather than emitting it empty', async () => {
    // `RDP_PASSWORD=` would satisfy the resolver's `-z` guard and then set an EMPTY desktop
    // password. Absent is the honest answer, and the step fails with the message it already has.
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row, userId } = seed()
    store.putGithubToken(userId, 'ghp_only')

    const env = await createServerSecretsLoader(store)(row)
    expect(env).toEqual({ GITHUB_TOKEN: 'ghp_only' })
    expect(Object.keys(env)).not.toContain('RDP_PASSWORD')
  })

  it('returns nothing at all for a server with no secrets, without throwing', async () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row } = seed()
    await expect(createServerSecretsLoader(store)(row)).resolves.toEqual({})
  })

  it('does not leak one user’s token to another user’s server', async () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const mine = seed()
    const theirs = seed()
    store.putGithubToken(mine.userId, 'ghp_mine')

    expect(await createServerSecretsLoader(store)(theirs.row)).toEqual({})
    expect(await createServerSecretsLoader(store)(mine.row)).toEqual({ GITHUB_TOKEN: 'ghp_mine' })
  })
})

describe('boot() supplies the hook — the wiring that was missing', () => {
  let booted: BootedApp | undefined
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-secrets-'))
    writeFileSync(join(dir, 'rockysurf.config.yaml'), `server:\n  dataDir: "${join(dir, 'data')}"\n`)
  })

  afterEach(async () => {
    await booted?.close()
    booted = undefined
  })

  it('hands install steps a real environment, not an empty one', async () => {
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })

    // Seeded through the SAME store boot opened, so this proves the hook reads production's
    // store rather than one a test constructed for it.
    const userId = newUserId()
    const now = new Date().toISOString()
    booted.db.db
      .insert(users)
      .values({ id: userId, githubId: 'gh:1', githubUsername: 'someone', isAdmin: false, createdAt: now, updatedAt: now })
      .run()
    const id = newServerId()
    const [row] = booted.db.db
      .insert(servers)
      .values({
        id,
        userId,
        name: id,
        provider: 'fake',
        size: 'small',
        offeringId: 'fake-small',
        arch: 'arm64',
        status: 'provisioning',
        bootstrapMode: 'push',
        idempotencyKey: id,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()

    booted.secretsStore.putGithubToken(userId, 'ghp_from_boot')
    booted.secretsStore.putRdpPassword(id, 'desktop-pw')

    // Driven through the REAL callback route on the app `boot()` built — not through a loader
    // this test constructed. That distinction is the whole point: a test that supplies the
    // wiring it is checking is precisely the test that missed this bug for two milestones.
    const { planToken } = mintCallbackTokens(booted.db.db, id)
    const res = await booted.app.request(`/internal/servers/${id}/secrets?token=${planToken}`)

    expect(res.status).toBe(200)
    expect((await res.json()) as { secrets: Record<string, string> }).toEqual({
      secrets: { GITHUB_TOKEN: 'ghp_from_boot', RDP_PASSWORD: 'desktop-pw' },
    })
    // The most sensitive body core emits must never sit in a cache.
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('served an EMPTY set before the hook was supplied — the regression this guards', async () => {
    // Same route, same tokens, no secrets stored: proves the endpoint's emptiness used to be
    // indistinguishable from "this installation has no credentials", which is why nothing
    // caught it.
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })

    const userId = newUserId()
    const now = new Date().toISOString()
    booted.db.db
      .insert(users)
      .values({ id: userId, githubId: 'gh:2', githubUsername: 'nobody', isAdmin: false, createdAt: now, updatedAt: now })
      .run()
    const id = newServerId()
    booted.db.db
      .insert(servers)
      .values({
        id,
        userId,
        name: id,
        provider: 'fake',
        size: 'small',
        offeringId: 'fake-small',
        arch: 'arm64',
        status: 'provisioning',
        bootstrapMode: 'callback',
        idempotencyKey: id,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const { planToken } = mintCallbackTokens(booted.db.db, id)
    const res = await booted.app.request(`/internal/servers/${id}/secrets?token=${planToken}`)
    expect(await res.json()).toEqual({ secrets: {} })
  })
})
