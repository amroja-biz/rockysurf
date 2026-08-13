import type { Db } from '../db/client.js'
import { deleteSetting, getSetting, setSetting } from '../db/repositories/settings.js'

/**
 * The seam to the encrypted secrets store (rockysurf-gonw.6), which is being built in parallel.
 *
 * This file defines the NARROW interface this package needs — get, set, delete of a named
 * string — so the app can boot today and pick up real encryption later without any caller
 * changing. When gonw.6 lands, the adapter is one file: implement `SecretStore` over it and
 * pass it to `createApp`. Nothing in `auth/` knows how a secret is stored.
 *
 * `SettingsSecretStore` below is the fallback, and it is NOT encrypted at rest — it is the
 * plain `settings` table. That is acceptable for exactly what the app puts through it today,
 * the admin password's scrypt hash, which is not reversible and is not a credential for
 * anything else. It is NOT acceptable for provider tokens or SSH private keys, and the
 * `assertSuitableFor` guard below exists so a future caller cannot quietly widen its use:
 * anything outside the allowlist throws rather than being stored in the clear.
 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Keys that are safe to hold unencrypted, because they are already one-way or non-secret. */
const PLAINTEXT_SAFE = new Set<string>(['auth.local.passwordHash'])

export class SettingsSecretStore implements SecretStore {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<string | undefined> {
    return getSetting(this.db, key)
  }

  async set(key: string, value: string): Promise<void> {
    assertSuitableFor(key)
    setSetting(this.db, key, value)
  }

  async delete(key: string): Promise<void> {
    deleteSetting(this.db, key)
  }
}

function assertSuitableFor(key: string): void {
  if (PLAINTEXT_SAFE.has(key)) return
  throw new Error(
    `refusing to store "${key}" in the settings table, which is not encrypted at rest. ` +
      'Pass the real secrets store (rockysurf-gonw.6) to createApp() for anything reversible.',
  )
}

/** In-memory store for tests, and for anything that must not touch the database. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
}
