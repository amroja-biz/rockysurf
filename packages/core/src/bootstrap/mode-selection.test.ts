import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getServer, insertServer } from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { bootstrapModeHooks, CallbackUnavailableError } from './push-runner.js'

/**
 * Mode selection and what each mode costs the box (rockysurf-55fx.4).
 *
 * The property worth protecting is the asymmetry: callback mode needs tokens on the row so the
 * box can authenticate, and push mode needs NONE — a push-mode box is never told a core URL and
 * never handed a credential. Minting "just in case" would leave a live token on a row for a
 * topology with no way to use it.
 */

let opened: OpenedDatabase
let serverId: string

const REACHABLE = { server: { publicUrl: 'https://core.example' } }
const NAT = { server: {} }

beforeEach(() => {
  opened = openTestDatabase()
  const userId = upsertUserByGithubId(opened.db, { githubId: '1', githubUsername: 'tester' }).id
  serverId = insertServer(opened.db, {
    userId,
    name: 'dev-box',
    provider: 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
  }).id
})

afterEach(() => {
  opened.close()
})

describe('push mode', () => {
  it('is chosen by default, with or without a public URL', () => {
    expect(bootstrapModeHooks(opened.db, NAT).selectMode()).toBe('push')
    expect(bootstrapModeHooks(opened.db, REACHABLE).selectMode()).toBe('push')
  })

  it('mints NOTHING onto the row', () => {
    const hooks = bootstrapModeHooks(opened.db, REACHABLE)
    hooks.mintTokensIfNeeded(serverId, hooks.selectMode())

    const row = getServer(opened.db, serverId)!
    expect(row.planTokenHash).toBeNull()
    expect(row.callbackTokenHash).toBeNull()
    expect(row.planTokenExpiresAt).toBeNull()
  })
})

describe('callback mode', () => {
  it('is available only when core has a public URL for the box to call', () => {
    expect(bootstrapModeHooks(opened.db, REACHABLE, 'callback').selectMode()).toBe('callback')
  })

  it('refuses without a public URL rather than silently downgrading to push', () => {
    // A silent downgrade produces a server that provisions and then never bootstraps, with
    // nothing in the logs explaining why.
    expect(() => bootstrapModeHooks(opened.db, NAT, 'callback').selectMode()).toThrow(CallbackUnavailableError)
  })

  it('mints both tokens onto the row, hashed, with an expiry on the plan token', () => {
    const hooks = bootstrapModeHooks(opened.db, REACHABLE, 'callback')
    hooks.mintTokensIfNeeded(serverId, hooks.selectMode())

    const row = getServer(opened.db, serverId)!
    expect(row.planTokenHash).toBeTruthy()
    expect(row.callbackTokenHash).toBeTruthy()
    // Two distinct secrets with two lifetimes (amendment E8) — not one reused.
    expect(row.planTokenHash).not.toBe(row.callbackTokenHash)
    expect(row.planTokenExpiresAt).toBeTruthy()
    expect(new Date(row.planTokenExpiresAt!).getTime()).toBeGreaterThan(Date.now())
    expect(row.planTokenUses).toBe(0)
  })

  it('stores only hashes, never the tokens themselves', () => {
    const hooks = bootstrapModeHooks(opened.db, REACHABLE, 'callback')
    hooks.mintTokensIfNeeded(serverId, 'callback')
    const row = getServer(opened.db, serverId)!
    // A hash is fixed-width hex; a token is base64url of 32 bytes. If the raw token were
    // stored, a database leak would hand over live credentials.
    expect(row.planTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.callbackTokenHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('the hook contract', () => {
  it('does nothing for a mode it was not asked to prepare', () => {
    // Guards against a caller that computes 'callback' but passes 'push' through, or vice
    // versa: the mint is driven by the mode ARGUMENT, not by the configured request.
    const hooks = bootstrapModeHooks(opened.db, REACHABLE, 'callback')
    hooks.mintTokensIfNeeded(serverId, 'push')
    expect(getServer(opened.db, serverId)!.planTokenHash).toBeNull()
  })
})
