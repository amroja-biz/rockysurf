import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { getSetting, setSetting } from '../db/repositories/settings.js'
import { listBillingServers, listServersByStatus, servers } from '../db/index.js'
import type { EventsService } from '../services/events.js'
import type { SpendSnapshot, SpendTracker } from './limits.js'

/**
 * Accrue running time and estimated cost, then re-evaluate the spend cap.
 *
 * ACCRUAL IS INCREMENTAL, against a persisted watermark. The obvious implementation —
 * `now - startedAt` — is wrong for a job that runs every minute: it recomputes the whole
 * lifetime each tick and adds it again. So the ticker stores when it last accrued and adds
 * only the slice since then, clamped to the server's own start so a server created mid-tick
 * is not credited with time before it existed.
 *
 * This ticker is the SINGLE WRITER of `totalUptimeSeconds`/`estimatedTotalCost` (4d7acae
 * removed transition-time accrual in `db/repositories/servers.ts`, which both double-counted
 * against this watermark and mis-measured restarts from the first `stoppedAt`). Residual,
 * deliberate under-count: the slice between the last tick and a stop is never credited —
 * at most one tick interval per stop, always in the user's favor.
 *
 * WHAT IT WALKS FOLLOWS THE PROVIDER, NOT THE STATUS (rockysurf-4byx). This job used to select
 * `status = 'running'`, which reads as obviously right and hid the one case where a user pays
 * for nothing whatsoever: a bootstrap that fails leaves the row `failed` and the instance UP —
 * failed boxes are kept for diagnosis, and the cap doctrine never stops servers — so the card
 * reported `Uptime 0s / $0.00` beside a metering EC2 for as long as the user left it there.
 * `listBillingServers` asks the question the bill answers instead: is there a machine, and is
 * the provider charging for it. `isBillingRow` owns that predicate; this job owns the arithmetic.
 */

const WATERMARK_KEY = 'jobs.uptime.accruedThrough'

export interface UptimeTickerDeps {
  db: Db
  events: EventsService
  spend: SpendTracker
  /** Injected in tests. */
  now?: () => Date
  /** Where the cap warning goes, if anywhere. Defaults to stderr. */
  log?: (message: string) => void
}

export interface UptimeTickResult {
  accruedServers: number
  accruedSeconds: number
  spend: SpendSnapshot
  /** True on the tick where the cap was first crossed. */
  capJustCrossed: boolean
}

export function createUptimeTick(deps: UptimeTickerDeps): () => Promise<UptimeTickResult> {
  const { db, events, spend } = deps
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((message: string) => console.error(message))

  let wasOverCap = false

  return async function tick(): Promise<UptimeTickResult> {
    const at = now()
    const nowIso = at.toISOString()
    const stored = getSetting(db, WATERMARK_KEY)
    // No watermark yet — a fresh install, or the first tick after this job was added. Fall
    // back to each server's own `startedAt` rather than to "now", so a server that has been
    // running since before the first tick is credited from when it actually started instead
    // of silently losing that time.
    const watermark = stored ? Date.parse(stored) : undefined

    let accruedServers = 0
    let accruedSeconds = 0

    for (const row of listBillingServers(db)) {
      // Never credit time before this row's machine existed, however far back the watermark is.
      //
      // THE EARLIER OF THE TWO TIMESTAMPS, not a preference between them, because they are two
      // kinds of evidence for the same thing and neither is always present. `startedAt` is
      // stamped when bootstrap reported `ready`; `billingSince` when the provider first
      // confirmed a metering instance, which is minutes EARLIER on a healthy create and the only
      // one of the two that exists at all on a row that failed on the way to `ready`. Preferring
      // `billingSince` outright would move the anchor FORWARD on a row that predates the column
      // — every server the owner already had, whose stamp is written the first time the new code
      // syncs it — and lose the history behind it on any install whose watermark is not yet set.
      const anchor = Math.min(
        ...[row.billingSince, row.startedAt].filter((iso) => iso !== null).map((iso) => Date.parse(iso)),
        // No evidence at all: anchor at now, which credits nothing this tick rather than
        // inventing a start.
        at.getTime(),
      )
      const from = Math.max(watermark ?? anchor, anchor)
      const seconds = Math.floor((at.getTime() - from) / 1000)
      if (seconds <= 0) continue

      const patch: Record<string, unknown> = {
        totalUptimeSeconds: row.totalUptimeSeconds + seconds,
        updatedAt: nowIso,
      }
      if (row.hourlyCostAmount !== null) {
        patch['estimatedTotalCost'] = row.estimatedTotalCost + (row.hourlyCostAmount * seconds) / 3600
      }
      db.update(servers).set(patch).where(eq(servers.id, row.id)).run()

      accruedServers++
      accruedSeconds += seconds
    }

    setSetting(db, WATERMARK_KEY, nowIso)

    const snapshot = spend.refresh(at)
    const capJustCrossed = snapshot.overCap && !wasOverCap

    if (capJustCrossed && snapshot.cap) {
      const spent = snapshot.byCurrency[snapshot.cap.currency] ?? 0
      log(
        `[spend-cap] estimated ${spent.toFixed(2)} ${snapshot.cap.currency} this month, at or over the ` +
          `${snapshot.cap.amount} ${snapshot.cap.currency} cap. New servers are blocked; running servers ` +
          'are left alone.',
      )
      // Tell every open stream, not just the one that happens to create next. This is the only
      // warning a user gets before their next create is refused.
      for (const userId of new Set(listServersByStatus(db, ['running', 'stopped']).map((r) => r.userId))) {
        await events.broadcastToUser(userId, {
          type: 'spend-cap-reached',
          month: snapshot.month,
          spent,
          cap: snapshot.cap,
          unpricedServers: snapshot.unpricedServers,
          message: 'New servers are blocked until spend falls below the cap. Running servers are unaffected.',
        })
      }
    }

    wasOverCap = snapshot.overCap
    return { accruedServers, accruedSeconds, spend: snapshot, capJustCrossed }
  }
}
