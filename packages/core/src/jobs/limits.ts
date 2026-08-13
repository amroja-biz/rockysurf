import { and, eq, gte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { getSetting, setSetting } from '../db/repositories/settings.js'
import { isBillingRow } from '../db/repositories/servers.js'
import { servers } from '../db/schema.js'
import type { LimitsConfig } from '../config/index.js'

/**
 * Limit enforcement: concurrency, create rate, and the spend cap.
 *
 * All three are enforced at CREATE, in `checkLimits`, which the lifecycle service calls before
 * it writes a row (that seam exists for exactly this). Enforcing after the row is written
 * would mean rejecting a create that has already provisioned something.
 *
 * WHY THE CAP DOES NOT STOP RUNNING SERVERS. The bead's acceptance criteria say reaching the
 * cap "stops running servers"; this implementation deliberately does NOT, on instruction and
 * on merit. Auto-stopping is destructive and irreversible in the way that matters: it kills an
 * agent mid-task on a box the user is depending on, in response to an ESTIMATE derived from
 * bundled prices that may be months stale (`hourlyCostFetchedAt`) and, for an unpriced
 * offering, may be missing entirely. A wrong estimate that blocks a new create costs the user
 * one click of annoyance; a wrong estimate that stops their running work costs them the work.
 * So: warn, and block new creates. Revisit when spend is measured rather than estimated.
 */

export type LimitReason = 'max_servers' | 'create_rate' | 'spend_cap'

/** Raised at create when a configured limit would be exceeded. Routes render it as 403. */
export class LimitExceededError extends Error {
  override readonly name = 'LimitExceededError'
  constructor(
    readonly reason: LimitReason,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/** Estimated spend for the current calendar month, per currency. */
export interface SpendSnapshot {
  /** `YYYY-MM`, UTC. */
  month: string
  /**
   * Accrued estimate this month, keyed by ISO 4217 code.
   *
   * Kept per-currency rather than summed because a Hetzner project billed in EUR and an AWS
   * account billed in USD cannot be added together honestly (amendment B2). The cap is
   * compared against its own currency's bucket only.
   */
  byCurrency: Record<string, number>
  cap?: { amount: number; currency: string }
  overCap: boolean
  /**
   * Servers whose provider quoted no price at all.
   *
   * Their spend is real and invisible to the cap, so the number is surfaced rather than
   * hidden: a cap that silently ignores half the fleet is worse than no cap.
   */
  unpricedServers: number
  computedAt: string
}

export interface SpendTracker {
  /** The last computed snapshot. Cheap; safe to call per request. */
  snapshot(): SpendSnapshot
  /** Recompute from the database. The uptime ticker calls this after it accrues. */
  refresh(now?: Date): SpendSnapshot
}

const monthKey = (now: Date) => now.toISOString().slice(0, 7)
const baselineKey = (month: string) => `jobs.spend.baseline.${month}`

/**
 * Month-to-date spend, as a difference against a baseline snapshotted at the month's first
 * tick.
 *
 * `servers.estimatedTotalCost` is a LIFETIME per-server accumulator, and nothing in the schema
 * buckets it by month, so month-to-date has to be derived. Taking the difference against a
 * stored baseline gets it right regardless of WHO accrued the cost — this ticker, or the
 * status transitions that accrue on stop and terminate — which a counter maintained only by
 * this job would not. It also survives a restart, because both halves are persisted.
 *
 * The estimate is clamped at zero: rows can be deleted, which would otherwise make the total
 * go backwards and the month look negative.
 */
export function createSpendTracker(db: Db, limits: LimitsConfig): SpendTracker {
  let current: SpendSnapshot = {
    month: monthKey(new Date()),
    byCurrency: {},
    ...(limits.spendCap ? { cap: limits.spendCap } : {}),
    overCap: false,
    unpricedServers: 0,
    computedAt: new Date(0).toISOString(),
  }

  function totals(): { byCurrency: Record<string, number>; unpriced: number } {
    const byCurrency: Record<string, number> = {}
    let unpriced = 0
    for (const row of db.select().from(servers).all()) {
      if (row.hourlyCostAmount === null || !row.hourlyCostCurrency) {
        // Terminated rows with no price were never going to contribute; only count fleet that
        // could still be costing something.
        //
        // `failed` used to be excluded outright, on the assumption that a failed server has
        // stopped costing money. It has not (rockysurf-4byx): a bootstrap failure leaves the
        // instance up, so an UNPRICED failed row is invisible spend twice over — no figure to
        // accrue and no mention in the one number that admits the cap is incomplete. It counts
        // whenever the provider says its machine is still metering.
        if (row.status !== 'terminated' && (row.status !== 'failed' || isBillingRow(row))) unpriced++
        continue
      }
      byCurrency[row.hourlyCostCurrency] = (byCurrency[row.hourlyCostCurrency] ?? 0) + row.estimatedTotalCost
    }
    return { byCurrency, unpriced }
  }

  function refresh(now = new Date()): SpendSnapshot {
    const month = monthKey(now)
    const { byCurrency: lifetime, unpriced } = totals()

    const stored = getSetting(db, baselineKey(month))
    let baseline: Record<string, number>
    if (stored) {
      baseline = JSON.parse(stored) as Record<string, number>
    } else {
      // First tick of this month: whatever has accrued so far belongs to previous months.
      baseline = lifetime
      setSetting(db, baselineKey(month), JSON.stringify(baseline))
    }

    const byCurrency: Record<string, number> = {}
    for (const [currency, total] of Object.entries(lifetime)) {
      byCurrency[currency] = Math.max(0, total - (baseline[currency] ?? 0))
    }

    const cap = limits.spendCap
    const spentInCapCurrency = cap ? (byCurrency[cap.currency] ?? 0) : 0

    current = {
      month,
      byCurrency,
      ...(cap ? { cap } : {}),
      overCap: cap ? spentInCapCurrency >= cap.amount : false,
      unpricedServers: unpriced,
      computedAt: now.toISOString(),
    }
    return current
  }

  // Prime immediately, so the month's baseline is captured BEFORE anything accrues against
  // it. Baselining lazily on the first tick would fold that tick's spend into the baseline and
  // silently lose it — the whole month would read as one tick short.
  refresh()

  return {
    snapshot: () => current,
    refresh,
  }
}

export interface LimitsEnforcerDeps {
  db: Db
  limits: LimitsConfig
  spend: SpendTracker
  /** Injected in tests. */
  now?: () => Date
}

/** Servers this user created in the last hour, whatever became of them. */
function createsInLastHour(db: Db, userId: string, now: Date): number {
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  return db
    .select()
    .from(servers)
    .where(and(eq(servers.userId, userId), gte(servers.createdAt, since)))
    .all().length
}

/**
 * The `checkLimits` hook the lifecycle service calls before writing a row.
 *
 * Order is deliberate: cheapest and most specific first, so the message the user gets names
 * the limit they actually hit rather than whichever was checked first.
 */
export function createLimitsEnforcer(deps: LimitsEnforcerDeps) {
  const { db, limits, spend } = deps
  const now = deps.now ?? (() => new Date())

  return function checkLimits(input: { userId: string }, activeServers: number): void {
    if (activeServers >= limits.maxServers) {
      throw new LimitExceededError(
        'max_servers',
        `you already have ${activeServers} servers and the configured limit is ${limits.maxServers}. ` +
          'Terminate one, or raise limits.maxServers in rockysurf.config.yaml.',
        { activeServers, maxServers: limits.maxServers },
      )
    }

    const recent = createsInLastHour(db, input.userId, now())
    if (recent >= limits.createRatePerHour) {
      throw new LimitExceededError(
        'create_rate',
        `you have created ${recent} servers in the last hour and the configured limit is ` +
          `${limits.createRatePerHour} per hour. This exists to blunt terminate-and-recreate loops, ` +
          'especially from the MCP server.',
        { recent, createRatePerHour: limits.createRatePerHour },
      )
    }

    const state = spend.snapshot()
    if (state.overCap && state.cap) {
      const spent = state.byCurrency[state.cap.currency] ?? 0
      throw new LimitExceededError(
        'spend_cap',
        `estimated spend this month is ${spent.toFixed(2)} ${state.cap.currency}, at or over the ` +
          `configured cap of ${state.cap.amount} ${state.cap.currency}. Running servers are left alone — ` +
          'raise limits.spendCap or terminate something, then try again.',
        { spent, cap: state.cap, month: state.month, unpricedServers: state.unpricedServers },
      )
    }
  }
}
