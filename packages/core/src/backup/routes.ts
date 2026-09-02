import { Hono } from 'hono'
import type { ReloadOutcome } from '../config/live-config.js'
import type { Db } from '../db/client.js'
import type { AppEnv } from '../app.js'
import { badRequest, forbidden, success } from '../http/responses.js'
import { backupFilename, createBackup } from './create.js'
import { BACKUP_ARTIFACT, BACKUP_FORMAT_VERSION, backupSchema, migrateBackup, NEWER_BACKUP_REFUSAL } from './format.js'
import { restoreConfig, restoreDatabase, type ConfigRestoreOutcome, type RestoreDatabaseReport } from './restore.js'

/**
 * Backup and Restore over HTTP (issue #331, ADR-0023): the Settings page's two calls.
 *
 * ADMIN-ONLY, both of them, ahead of everything else — a backup is the installation's whole
 * control-plane state and a restore writes it.
 *
 * THE CUSTODY RULE HOLDS WITHOUT AN EXEMPTION. The download's secret rows are ciphertext
 * exactly as the `secrets` table holds them — no plaintext accessor is called anywhere in
 * this module (`secrets/route-inventory.test.ts` stays at one exemption), the master key is
 * never in the artifact, and the config text has its literal GitHub tokens redacted before it
 * leaves (`create.ts`). The one place restore handles plaintext — the github-token re-seal —
 * lives in `restore.ts`, returns counts, and never crosses this boundary.
 */

export interface BackupRoutesDeps {
  db: Db
  configPath?: string
  env?: NodeJS.ProcessEnv
  /** `configStore.reload` — the same reloader the settings save uses (ADR-0017). */
  reload?: () => ReloadOutcome
  /** This installation's master key, for the re-seal and the readability probe. */
  masterKey?: Buffer
  appVersion?: string
  now?: () => Date
  /** Recompute the spend snapshot after a restore lands rows and baseline adjustments. */
  refreshSpend?: () => void
}

/**
 * More than enough for any real artifact (rows are small; the heaviest are failed servers'
 * ~200-line install logs and 16 KiB user scripts), and small enough that a mistaken upload —
 * a database file, a tarball — is refused before it is buffered whole.
 */
export const RESTORE_BODY_LIMIT_BYTES = 32 * 1024 * 1024

export interface RestoreResponse {
  report: RestoreDatabaseReport
  config: ConfigRestoreOutcome | { written: false; applied: false; skipped: string; pinnedKept: string[] }
  /**
   * The GitHub tokens the backup deliberately left behind (owner ruling, issue #331), by
   * label — the list the operator works through on the Settings page afterwards.
   */
  tokensToReenter: string[]
}

export function createBackupRoutes(deps: BackupRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.use('/api/v1/backup/*', async (c, next) => {
    if (!c.get('user').isAdmin) return forbidden(c, 'Admin access required')
    await next()
  })
  routes.use('/api/v1/backup', async (c, next) => {
    if (!c.get('user').isAdmin) return forbidden(c, 'Admin access required')
    await next()
  })

  routes.get('/api/v1/backup', (c) => {
    const artifact = createBackup({
      db: deps.db,
      ...(deps.configPath ? { configPath: deps.configPath } : {}),
      ...(deps.appVersion ? { appVersion: deps.appVersion } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    })
    const at = (deps.now ?? (() => new Date()))()
    c.header('content-type', 'application/json; charset=utf-8')
    c.header('content-disposition', `attachment; filename="${backupFilename(at)}"`)
    return c.body(JSON.stringify(artifact, null, 2))
  })

  routes.post('/api/v1/backup/restore', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (declared > RESTORE_BODY_LIMIT_BYTES) {
      return c.json(
        {
          error: `that file is ${Math.round(declared / 1024 / 1024)} MB — larger than any Rocky Surf backup. A backup is one JSON file; this looks like something else.`,
          code: 'bad_request' as const,
        },
        413,
      )
    }
    let text: string
    try {
      text = await c.req.text()
    } catch {
      return badRequest(c, 'the request body could not be read')
    }
    if (text.length > RESTORE_BODY_LIMIT_BYTES) {
      return c.json(
        { error: 'that file is larger than any Rocky Surf backup — it looks like something else.', code: 'bad_request' as const },
        413,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return badRequest(c, 'this is not a Rocky Surf backup — the file is not valid JSON')
    }

    // The version gate runs BEFORE schema validation, so a future format that reshaped a
    // field is refused with the honest sentence rather than a misleading field error.
    const shape = parsed as { artifact?: unknown; formatVersion?: unknown }
    if (shape === null || typeof shape !== 'object' || shape.artifact !== BACKUP_ARTIFACT) {
      return badRequest(c, 'this is not a Rocky Surf backup file')
    }
    if (typeof shape.formatVersion !== 'number' || !Number.isInteger(shape.formatVersion) || shape.formatVersion < 1) {
      return badRequest(c, 'this backup carries no readable format version')
    }
    if (shape.formatVersion > BACKUP_FORMAT_VERSION) {
      return badRequest(c, NEWER_BACKUP_REFUSAL)
    }

    const checked = backupSchema.safeParse(parsed)
    if (!checked.success) {
      return badRequest(
        c,
        'this backup file is damaged or incomplete',
        checked.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      )
    }

    const artifact = migrateBackup(checked.data)

    // All database writes in one transaction (restore.ts); an error rolls the whole portion
    // back, so "restore failed" always means "nothing was applied".
    let report: RestoreDatabaseReport
    try {
      report = restoreDatabase(
        {
          db: deps.db,
          ...(deps.masterKey ? { masterKey: deps.masterKey } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
        artifact,
      )
    } catch (err) {
      return badRequest(c, `restore failed and nothing was applied: ${(err as Error).message}`)
    }

    const config = deps.configPath
      ? restoreConfig(
          {
            configPath: deps.configPath,
            ...(deps.env ? { env: deps.env } : {}),
            ...(deps.reload ? { reload: deps.reload } : {}),
          },
          artifact,
        )
      : ({
          written: false as const,
          applied: false as const,
          skipped: 'this core was built without a configuration file; the backup’s configuration was not applied',
          pinnedKept: [],
        } satisfies RestoreResponse['config'])

    deps.refreshSpend?.()

    const response: RestoreResponse = {
      report,
      config,
      tokensToReenter: artifact.config.redactedTokens.map((t) => t.label),
    }
    return success(c, response)
  })

  return routes
}
