import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { settings, type SettingRow } from '../schema.js'

/**
 * The `settings` key/value table.
 *
 * Lives here rather than beside its caller because `src/db/index.ts` states the rule: nothing
 * above `src/db/` imports `drizzle-orm` directly, so that the Postgres move stays a change in
 * this directory. Added by rockysurf-gonw.7 for the local-admin bootstrap.
 */

export function getSetting(db: Db, key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value
}

export function setSetting(db: Db, key: string, value: string): SettingRow {
  const updatedAt = new Date().toISOString()
  const [row] = db
    .insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
    .returning()
    .all()
  if (!row) throw new Error(`setSetting wrote no row for ${key}`)
  return row
}

export function deleteSetting(db: Db, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run()
}
