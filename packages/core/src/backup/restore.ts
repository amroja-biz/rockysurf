import { readFileSync, statSync } from 'node:fs'
import { and, eq, getTableColumns } from 'drizzle-orm'
import { checkConfigText, type ConfigIssue, type ConfigWarning } from '../config/load.js'
import type { ReloadOutcome } from '../config/live-config.js'
import type { Db } from '../db/client.js'
import { newSecretId, newUserId } from '../db/ids.js'
import { packs, secrets, servers, serverRepositories, settings, tools, users } from '../db/schema.js'
import { open, seal, secretAad } from '../secrets/crypto.js'
import { applyChanges, parseTree } from '../settings/document.js'
import { writeAtomically } from '../settings/routes.js'
import type { BackupArtifact } from './format.js'

/**
 * Restore a backup artifact into this installation (issue #331, ADR-0023).
 *
 * MERGE, ID-PRESERVING, SKIP-EXISTING — never replace. Nothing that already exists here is
 * overwritten or deleted; every item lands, is skipped with a reason, or is refused with a
 * reason, and the report says which per domain. Skip-existing is what makes a re-run
 * idempotent, and idempotency is load-bearing: the config step can refuse (a `${VAR}` the new
 * machine lacks, an invalid file) after the database portion landed, and the fix is to sort
 * the environment out and restore the same artifact again.
 *
 * ALL DATABASE WRITES IN ONE TRANSACTION; the config file is a separate, later step. A throw
 * anywhere in the database portion rolls the whole portion back, so a restore can never
 * half-apply — and a config refusal cannot un-happen the database portion, which is exactly
 * why the database portion had to be idempotent.
 *
 * THE SCOPE LINE: this restores CONTROL-PLANE STATE. No machine is created, contacted or
 * "restored" — the machines live in the operator's cloud accounts and never left. Restored
 * server rows are records; the reconciler and `lifecycle.sync` then discover which machines
 * still answer, with the same flag-don't-terminate rules that govern a laptop reopened after
 * a week (`jobs/reconciler.ts`). BYO trust-on-first-use records travel too: the pinned or
 * recorded host-key fingerprint is a row column, so a restored BYO server keeps exactly the
 * trust decision its operator made.
 *
 * USER IDENTITY IS RECONCILED, NOT COPIED. The person restoring already exists here (the
 * local admin is `githubId: 'local:admin'` on every installation), and `users` is unique on
 * githubId AND githubUsername — so each backup user is MATCHED by githubId first, and only
 * inserted when genuinely absent. Server rows are remapped to the matched ids. The one secret
 * kind owned by a USER — `github-token` — is AAD-bound to that owner id, so a remapped user's
 * token is re-sealed under the new id using the master key present at restore; if the key
 * here is not the key that sealed it (absent and wrong are deliberately the same failure),
 * the row is dropped with "reconnect GitHub" rather than restored as a brick. Server-scoped
 * secrets travel verbatim: their owner ids (server ids) are preserved.
 *
 * NO PLAINTEXT LEAVES THIS MODULE. The re-seal and the readability probe both run inside it,
 * return counts and booleans, and are never called from a file that registers routes — the
 * custody rule (`secrets/route-inventory.test.ts`) keeps its single exemption.
 */

export interface RefusedItem {
  id: string
  reason: string
}

export interface DomainReport {
  restored: number
  skipped: number
  refused: RefusedItem[]
}

export interface SecretsReport {
  restored: number
  skipped: number
  /** Of the restored rows: how many the master key HERE can actually open. */
  readable: number
  unreadable: number
  dropped: RefusedItem[]
}

export interface RestoreDatabaseReport {
  users: DomainReport
  tools: DomainReport
  toolState: { applied: number; skipped: number }
  packs: DomainReport
  servers: DomainReport
  repositories: { restored: number; skipped: number }
  secrets: SecretsReport
  spend: { adjustedMonth?: string }
}

export interface RestoreDatabaseDeps {
  db: Db
  /** This installation's master key. Absent means every restored secret reports unreadable. */
  masterKey?: Buffer
  /** Injectable clock — the spend adjustment is month-bucketed (repo rule, #284). */
  now?: () => Date
}

const emptyDomain = (): DomainReport => ({ restored: 0, skipped: 0, refused: [] })

/**
 * The columns of `table` that `entry` supplies. Restoring by NAME from the live table
 * definition is what makes an older artifact land on a newer schema: a column the artifact
 * never heard of takes its default, and a field the schema no longer has is ignored.
 */
function pickColumns(entry: Record<string, unknown>, table: Parameters<typeof getTableColumns>[0]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(getTableColumns(table))) {
    if (key in entry && entry[key] !== undefined) out[key] = entry[key]
  }
  return out
}

export function restoreDatabase(deps: RestoreDatabaseDeps, artifact: BackupArtifact): RestoreDatabaseReport {
  const clock = deps.now ?? (() => new Date())

  return deps.db.transaction((tx) => {
    const report: RestoreDatabaseReport = {
      users: emptyDomain(),
      tools: emptyDomain(),
      toolState: { applied: 0, skipped: 0 },
      packs: emptyDomain(),
      servers: emptyDomain(),
      repositories: { restored: 0, skipped: 0 },
      secrets: { restored: 0, skipped: 0, readable: 0, unreadable: 0, dropped: [] },
      spend: {},
    }

    /* ------------------------------------------------ users: reconcile identity, build the map */

    /** backup user id → this installation's user id, for every user whose rows may land. */
    const userIdMap = new Map<string, string>()

    for (const entry of artifact.users) {
      const matched = tx.select().from(users).where(eq(users.githubId, entry.githubId)).get()
      if (matched) {
        // Same identity, already here — the local admin on every restore, a GitHub user who
        // reconnected. The existing profile wins; only the mapping is recorded.
        userIdMap.set(entry.id, matched.id)
        report.users.skipped++
        continue
      }
      const usernameTaken = tx.select().from(users).where(eq(users.githubUsername, entry.githubUsername)).get()
      if (usernameTaken) {
        // Same username, DIFFERENT githubId: two genuinely different accounts. Inserting is
        // impossible (unique index) and guessing which identity "wins" would hand one
        // account's servers to the other — refuse the user, and their rows below with them.
        report.users.refused.push({
          id: entry.githubUsername,
          reason: `the username "${entry.githubUsername}" already belongs to a different account on this installation`,
        })
        continue
      }
      const idTaken = tx.select().from(users).where(eq(users.id, entry.id)).get()
      const finalId = idTaken ? newUserId() : entry.id
      tx.insert(users)
        .values({ ...pickColumns(entry, users), id: finalId } as typeof users.$inferInsert)
        .run()
      userIdMap.set(entry.id, finalId)
      report.users.restored++
    }

    /* ------------------------------------------------ tools, and the switches on shipped ones */

    for (const entry of artifact.tools) {
      const existing = tx.select().from(tools).where(eq(tools.id, entry.id)).get()
      if (existing?.sourceFile) {
        // ADR-0018's import rule, for the same reason: the boot reconcile owns file-backed
        // rows, so a restore that "won" would be silently undone at the next restart.
        report.tools.refused.push({ id: entry.id, reason: 'a tool with this id comes from a pack file here' })
        continue
      }
      if (existing) {
        report.tools.skipped++
        continue
      }
      tx.insert(tools)
        .values({ ...pickColumns(entry, tools), sourceFile: null } as typeof tools.$inferInsert)
        .run()
      report.tools.restored++
    }

    for (const state of artifact.fileBackedToolState) {
      const existing = tx.select().from(tools).where(eq(tools.id, state.toolId)).get()
      // Applied only to a tool this release actually ships: the switches are installation
      // state ON a file-backed row (ADR-0020), and a release that dropped the tool has
      // nothing to switch.
      if (!existing?.sourceFile) {
        report.toolState.skipped++
        continue
      }
      const patch: Partial<typeof tools.$inferInsert> = {}
      if (state.alwaysInstall !== undefined) patch.alwaysInstall = state.alwaysInstall
      if (state.enabled !== undefined) patch.enabled = state.enabled
      if (Object.keys(patch).length === 0) {
        report.toolState.skipped++
        continue
      }
      tx.update(tools)
        .set({ ...patch, updatedAt: clock().toISOString() })
        .where(eq(tools.id, state.toolId))
        .run()
      report.toolState.applied++
    }

    /* ------------------------------------------------ packs */

    for (const entry of artifact.packs) {
      const existing = tx.select().from(packs).where(eq(packs.id, entry.id)).get()
      if (existing?.sourceFile) {
        report.packs.refused.push({ id: entry.id, reason: 'a pack with this id ships with this installation' })
        continue
      }
      if (existing) {
        report.packs.skipped++
        continue
      }
      tx.insert(packs)
        .values({ ...pickColumns(entry, packs), sourceFile: null } as typeof packs.$inferInsert)
        .run()
      report.packs.restored++
    }

    /* ------------------------------------------------ servers: records, never machines */

    const insertedServerIds = new Set<string>()
    /** Lifetime cost of the rows THIS restore inserted, for the spend-baseline adjustment. */
    const restoredTotals: Record<string, number> = {}

    for (const entry of artifact.servers) {
      const record = entry as Record<string, unknown>
      const oldUserId = typeof record.userId === 'string' ? record.userId : undefined
      const mappedUserId = oldUserId ? userIdMap.get(oldUserId) : undefined
      if (!mappedUserId) {
        report.servers.refused.push({
          id: entry.id,
          reason: 'its owner was not restored (see the users report)',
        })
        continue
      }
      const existing = tx.select().from(servers).where(eq(servers.id, entry.id)).get()
      if (existing) {
        report.servers.skipped++
        continue
      }
      tx.insert(servers)
        .values({ ...pickColumns(record, servers), userId: mappedUserId } as typeof servers.$inferInsert)
        .run()
      insertedServerIds.add(entry.id)
      report.servers.restored++
      if (typeof record.hourlyCostCurrency === 'string' && typeof record.estimatedTotalCost === 'number') {
        restoredTotals[record.hourlyCostCurrency] =
          (restoredTotals[record.hourlyCostCurrency] ?? 0) + record.estimatedTotalCost
      }
    }

    /* ------------------------------------------------ server ↔ repository join rows */

    for (const entry of artifact.serverRepositories) {
      const present =
        insertedServerIds.has(entry.serverId) ||
        tx.select().from(servers).where(eq(servers.id, entry.serverId)).get() !== undefined
      if (!present) {
        report.repositories.skipped++
        continue
      }
      const outcome = tx
        .insert(serverRepositories)
        .values({ serverId: entry.serverId, repositoryUrl: entry.repositoryUrl })
        .onConflictDoNothing()
        .run()
      if (outcome.changes > 0) report.repositories.restored++
      else report.repositories.skipped++
    }

    /* ------------------------------------------------ secrets: ciphertext in, booleans out */

    /** True when the master key HERE opens this sealed row. Never returns the plaintext. */
    const probe = (entry: (typeof artifact.secrets)[number], ownerId: string | null): boolean => {
      if (!deps.masterKey) return false
      try {
        open(deps.masterKey, entry, secretAad(entry.keyId, entry.kind, ownerId))
        return true
      } catch {
        return false
      }
    }

    const insertSecret = (entry: (typeof artifact.secrets)[number], ownerId: string | null, sealedOver?: { ciphertext: string; nonce: string; authTag: string }) => {
      const idTaken = tx.select().from(secrets).where(eq(secrets.id, entry.id)).get()
      tx.insert(secrets)
        .values({
          // Ids are preserved so `servers.managedKeySecretId` stays coherent; when an id is
          // taken a fresh one costs nothing, because retrieval is by (kind, ownerId).
          id: idTaken ? newSecretId() : entry.id,
          kind: entry.kind,
          ownerId,
          ciphertext: sealedOver?.ciphertext ?? entry.ciphertext,
          nonce: sealedOver?.nonce ?? entry.nonce,
          authTag: sealedOver?.authTag ?? entry.authTag,
          keyId: entry.keyId,
          createdAt: typeof (entry as Record<string, unknown>).createdAt === 'string' ? ((entry as Record<string, unknown>).createdAt as string) : clock().toISOString(),
          updatedAt: clock().toISOString(),
        })
        .run()
      report.secrets.restored++
    }

    for (const entry of artifact.secrets) {
      // Instance identity, not user data — excluded at create, and refused here in case a
      // hand-edited artifact carries one: a restored signing key would let old cookies live.
      if (entry.kind === 'session-signing-key') continue

      if (entry.kind === 'github-token') {
        const finalOwner = entry.ownerId ? userIdMap.get(entry.ownerId) : undefined
        if (!finalOwner) {
          report.secrets.dropped.push({ id: entry.kind, reason: 'its owner was not restored' })
          continue
        }
        const pairExists = tx
          .select()
          .from(secrets)
          .where(and(eq(secrets.kind, 'github-token'), eq(secrets.ownerId, finalOwner)))
          .get()
        if (pairExists) {
          // One row per (kind, owner), replaced rather than accumulated (SECURITY.md) — and
          // the token already here is the one that user most recently connected.
          report.secrets.skipped++
          continue
        }
        if (finalOwner === entry.ownerId) {
          insertSecret(entry, finalOwner)
          if (probe(entry, finalOwner)) report.secrets.readable++
          else report.secrets.unreadable++
          continue
        }
        // The owner id changed, and the GCM associated data binds the old one — the row must
        // be RE-SEALED under the new id. "Key absent" and "a different key" are deliberately
        // one path: both mean this installation cannot open the row, and a token that cannot
        // be opened should be re-obtained, not restored as a brick.
        if (!deps.masterKey) {
          report.secrets.dropped.push({
            id: entry.kind,
            reason: 'could not be re-encrypted for this installation — reconnect GitHub in Settings',
          })
          continue
        }
        try {
          const plaintext = open(deps.masterKey, entry, secretAad(entry.keyId, entry.kind, entry.ownerId))
          const resealed = seal(deps.masterKey, plaintext, secretAad(entry.keyId, entry.kind, finalOwner), entry.keyId)
          insertSecret(entry, finalOwner, resealed)
          report.secrets.readable++
        } catch {
          report.secrets.dropped.push({
            id: entry.kind,
            reason:
              'could not be re-encrypted for this installation — the master key here is not the one that sealed it. Reconnect GitHub in Settings.',
          })
        }
        continue
      }

      // Every other kind is server-scoped: ownerId is a server id, preserved verbatim, so the
      // row decrypts in place the moment the operator's own copy of the master key is present.
      const ownerId = entry.ownerId
      const ownerPresent =
        typeof ownerId === 'string' &&
        (insertedServerIds.has(ownerId) || tx.select().from(servers).where(eq(servers.id, ownerId)).get() !== undefined)
      if (!ownerPresent) {
        report.secrets.dropped.push({ id: entry.kind, reason: 'its server was not restored' })
        continue
      }
      const pairExists = tx
        .select()
        .from(secrets)
        .where(and(eq(secrets.kind, entry.kind), eq(secrets.ownerId, ownerId)))
        .get()
      if (pairExists) {
        report.secrets.skipped++
        continue
      }
      insertSecret(entry, ownerId)
      if (probe(entry, ownerId)) report.secrets.readable++
      else report.secrets.unreadable++
    }

    /* ------------------------------------------------ spend baseline: history is not this month */

    /*
     * The tracker primes the current month's baseline at boot (jobs/limits.ts), so without an
     * adjustment every restored row's LIFETIME cost would read as spend accrued THIS month —
     * and could trip the cap. The correction: whatever part of the restored history predates
     * this month belongs in the baseline.
     *
     *  - Backup made THIS month: the backup's own baseline row for the month is exactly the
     *    part that predates it; the remainder stays visible as month-to-date, matching what
     *    the old machine showed.
     *  - Backup made an EARLIER month: all of it predates this month, so the inserted rows'
     *    full totals go into the baseline.
     *
     * Applied only when this restore actually inserted servers — a re-run inserts none and
     * must not adjust twice. (A same-month restore that inserted only a subset uses the whole
     * backup baseline and therefore UNDERCOUNTS the subset's month-to-date; the tracker
     * clamps at zero, and fresh-install restore — the supported path — inserts everything.)
     */
    if (insertedServerIds.size > 0) {
      const currentMonth = clock().toISOString().slice(0, 7)
      const backupMonth = artifact.createdAt.slice(0, 7)
      let adjustment: Record<string, number> = restoredTotals
      if (backupMonth === currentMonth) {
        const row = artifact.settings.find((s) => s.key === `jobs.spend.baseline.${currentMonth}`)
        adjustment = {}
        if (row) {
          try {
            const parsed: unknown = JSON.parse(row.value)
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              for (const [currency, amount] of Object.entries(parsed)) {
                if (typeof amount === 'number') adjustment[currency] = amount
              }
            }
          } catch {
            // An unreadable baseline adjusts nothing; the month reads high rather than wrong.
          }
        }
      }
      if (Object.keys(adjustment).length > 0) {
        const key = `jobs.spend.baseline.${currentMonth}`
        const existing = tx.select().from(settings).where(eq(settings.key, key)).get()
        const merged: Record<string, number> = {}
        if (existing) {
          try {
            const parsed: unknown = JSON.parse(existing.value)
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              for (const [currency, amount] of Object.entries(parsed)) {
                if (typeof amount === 'number') merged[currency] = amount
              }
            }
          } catch {
            /* start clean */
          }
        }
        for (const [currency, amount] of Object.entries(adjustment)) {
          merged[currency] = (merged[currency] ?? 0) + amount
        }
        const now = clock().toISOString()
        tx.insert(settings)
          .values({ key, value: JSON.stringify(merged), updatedAt: now })
          .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(merged), updatedAt: now } })
          .run()
        report.spend.adjustedMonth = currentMonth
      }
    }

    return report
  })
}

/* ================================================================== the config file step */

export interface RestoreConfigDeps {
  configPath: string
  env?: NodeJS.ProcessEnv
  /** `configStore.reload`, when the app has one — the same reloader every save uses. */
  reload?: () => ReloadOutcome
}

export interface ConfigRestoreOutcome {
  /** The file was written. */
  written: boolean
  /** The running process adopted it (ADR-0017). False with `reloadBlocked` saying why. */
  applied: boolean
  /** Validation issues that refused the write. The file on disk is untouched. */
  refused?: readonly ConfigIssue[]
  /** Unset-`${VAR}` warnings — the file is written and applies; the environment catches up. */
  warnings?: readonly ConfigWarning[]
  reloadBlocked?: string
  /** The pinned paths kept at THIS machine's values rather than the backup's. */
  pinnedKept: string[]
}

/**
 * The four paths a restore keeps at the CURRENT installation's values, exactly the four the
 * settings editor pins (ADR-0017) — and for restore the stakes are higher than a stale
 * banner: writing the OLD machine's `server.dataDir` would make the next boot open a fresh
 * database at that path and "lose" everything this restore just wrote. `mcp.scopes` is
 * deliberately NOT here: it travels with the backup and waits for a restart, like any saved
 * change to it.
 */
const PINNED_ON_RESTORE: readonly (readonly string[])[] = [
  ['server', 'port'],
  ['server', 'host'],
  ['server', 'dataDir'],
  ['auth', 'mode'],
]

function valueAt(tree: unknown, path: readonly string[]): unknown {
  let cursor: unknown = tree
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

export function restoreConfig(deps: RestoreConfigDeps, artifact: BackupArtifact): ConfigRestoreOutcome {
  let currentText = ''
  let currentMode: number | null = null
  try {
    currentText = readFileSync(deps.configPath, 'utf8')
    currentMode = statSync(deps.configPath).mode & 0o777
  } catch {
    // No file yet — every pinned path mirrors "absent", which unsets the backup's value.
  }

  const currentTree = parseTree(currentText)
  const pinnedKept: string[] = []
  const changes = PINNED_ON_RESTORE.map((path) => {
    const value = valueAt(currentTree, path)
    const backupValue = valueAt(parseTree(artifact.config.text), path)
    if (JSON.stringify(value) !== JSON.stringify(backupValue)) pinnedKept.push(path.join('.'))
    return value === undefined ? { path, unset: true as const } : { path, value }
  })

  let candidate: string
  try {
    candidate = applyChanges(artifact.config.text, changes)
  } catch (err) {
    return {
      written: false,
      applied: false,
      refused: [{ path: 'config', message: `the backup's configuration could not be read: ${(err as Error).message}` }],
      pinnedKept: [],
    }
  }

  const env = deps.env ?? process.env
  const checked = checkConfigText(candidate, env)
  if (!checked.ok) {
    return { written: false, applied: false, refused: checked.issues, pinnedKept }
  }

  writeAtomically(deps.configPath, candidate, currentMode)
  const outcome: ReloadOutcome = deps.reload?.() ?? {
    applied: false,
    blocked: 'this core has no configuration reloader; the restored file takes effect at the next restart',
  }

  return {
    written: true,
    applied: outcome.applied,
    ...(checked.warnings.length > 0 ? { warnings: checked.warnings } : {}),
    ...(outcome.blocked ? { reloadBlocked: outcome.blocked } : {}),
    pinnedKept,
  }
}
