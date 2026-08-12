import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { getSetting, setSetting } from '../db/repositories/settings.js'
import { listServersByStatus, servers } from '../db/index.js'
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

    for (const row of listServersByStatus(db, ['running'])) {
      // Never credit time before the server started running, however far back the watermark is.
      const startedAt = row.startedAt ? Date.parse(row.startedAt) : at.getTime()
      const from = Math.max(watermark ?? startedAt, startedAt)
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
