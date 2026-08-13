import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>

/** Where drizzle-kit writes migrations, and where the runner reads them from. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))

export interface OpenDatabaseOptions {
  /** File path, or ':memory:' for tests. */
  url: string
  /** Run pending migrations on open. Default true — see `runMigrations`. */
  migrate?: boolean
  /** Echo SQL. Off by default; noisy. */
  verbose?: boolean
}

export interface OpenedDatabase {
  db: Db
  /** The underlying driver, for pragmas and for closing. */
  sqlite: Database.Database
  close(): void
}

/**
 * Open the control-plane database.
 *
 * Two pragmas are set deliberately and both matter for "your laptop is the control plane":
 *
 *  - `journal_mode = WAL` lets the SSE readers and the job loop read while a write is in
 *    flight, instead of serializing behind it. Skipped for `:memory:`, where it does nothing.
 *  - `foreign_keys = ON` because SQLite does NOT enforce foreign keys by default. Every
 *    `references()` in the schema is decorative without it, and the cascade deletes that
 *    clean up sessions and server repositories would silently not happen.
 */
export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  const inMemory = options.url === ':memory:'
  if (!inMemory) mkdirSync(dirname(options.url), { recursive: true })

  const sqlite = new Database(options.url, options.verbose ? { verbose: console.log } : {})
  if (!inMemory) sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  const db = drizzle(sqlite, { schema })
  if (options.migrate !== false) runMigrations(db)

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  }
}

/**
 * Apply every pending migration. Called on boot, before anything reads a table.
 *
 * Drizzle records applied migrations in `__drizzle_migrations`, so this is idempotent and
 * cheap on an up-to-date database — which is what lets core call it unconditionally at
 * startup rather than making the operator remember a separate command.
 */
export function runMigrations(db: Db, migrationsFolder: string = MIGRATIONS_DIR): void {
  migrate(db, { migrationsFolder })
}

/** Convenience for tests: a migrated, isolated, in-memory database. */
export function openTestDatabase(): OpenedDatabase {
  return openDatabase({ url: ':memory:' })
}

/** Default on-disk location under the configured data directory. */
export function defaultDatabasePath(dataDir: string): string {
  return join(dataDir, 'rockysurf.db')
}
