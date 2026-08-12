import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getSetting } from '../db/repositories/settings.js'
import { sessions } from '../db/schema.js'
import { ADMIN_PASSWORD_HASH_KEY, ensureLocalAdmin, LOCAL_ADMIN_GITHUB_ID } from './admin.js'
import { generatePassword, hashPassword, verifyPassword } from './passwords.js'
import { MemorySecretStore, SettingsSecretStore } from './secret-store.js'
import { hashToken, issueSession, resolveSession, revokeSession } from './sessions.js'

let opened: OpenedDatabase

beforeEach(() => {
  opened = openTestDatabase()
})

afterEach(() => {
  opened.close()
})

describe('password hashing', () => {
  it('accepts the right password and rejects the wrong one', () => {
    const stored = hashPassword('hunter2')
    expect(verifyPassword('hunter2', stored)).toBe(true)
    expect(verifyPassword('hunter3', stored)).toBe(false)
  })

  it('salts, so the same password hashes differently every time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })

  it('never stores the password itself', () => {
    expect(hashPassword('hunter2')).not.toContain('hunter2')
  })

  it('returns false rather than throwing for an absent or malformed hash', () => {
    expect(verifyPassword('anything', undefined)).toBe(false)
    expect(verifyPassword('anything', '')).toBe(false)
    expect(verifyPassword('anything', 'not-a-hash')).toBe(false)
    expect(verifyPassword('anything', 'scrypt$1$2$3')).toBe(false)
    expect(verifyPassword('anything', 'bcrypt$1$2$3$c2FsdA==$aGFzaA==')).toBe(false)
  })

  it('normalizes unicode, so a password typed on a different keyboard still works', () => {
    // Composed vs decomposed "é" — visually identical, different bytes.
    const stored = hashPassword('café')
    expect(verifyPassword('café', stored)).toBe(true)
  })

  it('generates passwords without visually ambiguous characters', () => {
    for (let i = 0; i < 20; i++) {
      const password = generatePassword()
      expect(password).toHaveLength(20)
      expect(password).not.toMatch(/[0O1lI]/)
    }
    expect(generatePassword()).not.toBe(generatePassword())
  })
})

describe('sessions', () => {
  const userId = () => {
    const admin = ensureLocalAdmin({ db: opened.db, secrets: new MemorySecretStore(), password: 'x' })
    return admin.then((a) => a.user.id)
  }

  it('stores only the hash of the token', async () => {
    const id = await userId()
    const { token, session } = issueSession(opened.db, id)

    expect(session.tokenHash).toBe(hashToken(token))
    expect(session.tokenHash).not.toBe(token)

    const rows = opened.db.select().from(sessions).all()
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it('resolves a live token to its user', async () => {
    const id = await userId()
    const { token } = issueSession(opened.db, id)
    expect(resolveSession(opened.db, token)?.user.id).toBe(id)
  })

  it('treats absent, unknown and expired tokens identically', async () => {
    const id = await userId()
    expect(resolveSession(opened.db, undefined)).toBeUndefined()
    expect(resolveSession(opened.db, 'nope')).toBeUndefined()

    const { token } = issueSession(opened.db, id, -1000) // already expired
    expect(resolveSession(opened.db, token)).toBeUndefined()
  })

  it('revokes, and reports whether anything was revoked', async () => {
    const id = await userId()
    const { token } = issueSession(opened.db, id)

    expect(revokeSession(opened.db, token)).toBe(true)
    expect(resolveSession(opened.db, token)).toBeUndefined()
    expect(revokeSession(opened.db, token)).toBe(false)
    expect(revokeSession(opened.db, undefined)).toBe(false)
  })
})

describe('local admin bootstrap', () => {
  it('creates the admin, stores a hash, and announces the generated password once', async () => {
    const announced: string[] = []
    const secrets = new MemorySecretStore()
    const result = await ensureLocalAdmin({ db: opened.db, secrets, announce: (m) => announced.push(m) })

    expect(result.user.isAdmin).toBe(true)
    expect(result.user.githubId).toBe(LOCAL_ADMIN_GITHUB_ID)
    expect(result.generatedPassword).toBeDefined()
    expect(announced).toHaveLength(1)
    expect(verifyPassword(result.generatedPassword!, await secrets.get(ADMIN_PASSWORD_HASH_KEY))).toBe(true)
  })

  it('is idempotent: a second call neither regenerates nor re-announces', async () => {
    const announced: string[] = []
    const secrets = new MemorySecretStore()
    const first = await ensureLocalAdmin({ db: opened.db, secrets, announce: (m) => announced.push(m) })
    const stored = await secrets.get(ADMIN_PASSWORD_HASH_KEY)

    const second = await ensureLocalAdmin({ db: opened.db, secrets, announce: (m) => announced.push(m) })

    expect(second.user.id).toBe(first.user.id)
    expect(second.generatedPassword).toBeUndefined()
    expect(announced).toHaveLength(1)
    expect(await secrets.get(ADMIN_PASSWORD_HASH_KEY)).toBe(stored)
  })

  it('an explicit password overwrites the stored one, so it doubles as rotation', async () => {
    const secrets = new MemorySecretStore()
    await ensureLocalAdmin({ db: opened.db, secrets, password: 'first', announce: () => {} })
    await ensureLocalAdmin({ db: opened.db, secrets, password: 'second', announce: () => {} })

    const stored = await secrets.get(ADMIN_PASSWORD_HASH_KEY)
    expect(verifyPassword('second', stored)).toBe(true)
    expect(verifyPassword('first', stored)).toBe(false)
  })
})

describe('secret store fallback', () => {
  it('round-trips the admin hash through the settings table', async () => {
    const store = new SettingsSecretStore(opened.db)
    await store.set(ADMIN_PASSWORD_HASH_KEY, 'scrypt$stub')

    expect(await store.get(ADMIN_PASSWORD_HASH_KEY)).toBe('scrypt$stub')
    expect(getSetting(opened.db, ADMIN_PASSWORD_HASH_KEY)).toBe('scrypt$stub')

    await store.delete(ADMIN_PASSWORD_HASH_KEY)
    expect(await store.get(ADMIN_PASSWORD_HASH_KEY)).toBeUndefined()
  })

  it('refuses to hold anything reversible in the clear', async () => {
    // The guard that stops this fallback from quietly becoming the credential store before
    // the encrypted one (rockysurf-gonw.6) lands.
    const store = new SettingsSecretStore(opened.db)
    await expect(store.set('providers.hetzner.token', 'hz_live_token')).rejects.toThrow(/not encrypted at rest/)
    expect(getSetting(opened.db, 'providers.hetzner.token')).toBeUndefined()
  })
})
