import type { Db } from '../db/client.js'
import { deleteExpiredSessions } from '../db/index.js'
import type { ServerRow } from '../db/schema.js'
import { readLive, type Live, type LimitsConfig } from '../config/index.js'
import type { BootstrapOnFailure } from '../config/schema.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { EventsService } from '../services/events.js'
import { createLimitsEnforcer, createSpendTracker, type SpendTracker } from './limits.js'
import { createProvisionTick, type BootstrapPoller } from './provision-ticker.js'
import { createReconcileTick, type ReconcileResult } from './reconciler.js'
import { createJob, type JobHandle } from './run-job.js'
import { createUptimeTick } from './uptime-ticker.js'

/**
 * The in-process job loop (ADR-0001): `setInterval` with an overlap guard, no queue, no
 * worker pool, no cron daemon.
 *
 * INTERVALS ARE NOT USER CONFIGURATION. They are deliberately absent from
 * `rockysurf.config.yaml`: they are an implementation detail with no good reason for a user to
 * touch, and every knob added to that schema is a knob that has to keep working forever. Tests
 * override them by dependency injection, which is the only caller that needs to.
 */

export const DEFAULT_INTERVALS = {
  /** Fast enough that a boot feels live in the UI, slow enough not to hammer a provider API. */
  provisionMs: 10_000,
  /** Cost accounting only needs to be roughly right; a minute is plenty. */
  uptimeMs: 60_000,
  /** Session rows are tiny and expiry is not urgent. */
  sessionSweepMs: 60 * 60 * 1000,
  /**
   * Reconciliation is a safety net, not a control loop: it exists to catch the disagreements
   * a crash leaves behind, and every run costs a listManaged() call per provider. Five minutes
   * bounds how long an orphan can bill unnoticed without making the cloud APIs a hot path.
   */
  reconcileMs: 5 * 60 * 1000,
} as const

export interface JobsDeps {
  db: Db
  registry: ProviderRegistry
  events: EventsService
  /**
   * The limits in force. A function since issue #264, so raising a cap on the Settings page
   * applies to the very next create rather than at the next restart.
   */
  limits: Live<LimitsConfig>
  /** From the lifecycle service. Already honours the describe() propagation grace. */
  sync: (row: ServerRow) => Promise<ServerRow>
  /** The push bootstrap driver (`bootstrap/supervisor.ts`), passed by `createApp`. */
  bootstrap?: BootstrapPoller
  /** `bootstrap.onFailure` from config: what a failed tool install does to the instance (ADR-0010). */
  onFailure?: BootstrapOnFailure
  intervals?: Partial<typeof DEFAULT_INTERVALS>
  now?: () => Date
  log?: (message: string) => void
}

export interface Jobs {
  readonly handles: readonly JobHandle[]
  /** Shared with the create path so a blocked create and the warning agree. */
  readonly spend: SpendTracker
  /** Pass to `createLifecycleService({ checkLimits })`. */
  readonly checkLimits: (input: { userId: string }, activeServers: number) => void
  start(): void
  /** Clear every timer and await whatever is in flight. Safe to call twice. */
  stop(): Promise<void>
  /** Run every job once, in order. Tests and the startup pass use this. */
  runAllNow(): Promise<void>
}

export function createJobs(deps: JobsDeps): Jobs {
  const intervals = { ...DEFAULT_INTERVALS, ...deps.intervals }
  const spend = createSpendTracker(deps.db, deps.limits, deps.now)

  const provisionTick = createProvisionTick({
    db: deps.db,
    registry: deps.registry,
    events: deps.events,
    sync: deps.sync,
    ...(deps.bootstrap ? { bootstrap: deps.bootstrap } : {}),
    ...(deps.onFailure ? { onFailure: deps.onFailure } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })

  const reconcileTick = createReconcileTick({
    db: deps.db,
    registry: deps.registry,
    events: deps.events,
    sync: deps.sync,
    ...(deps.log ? { log: deps.log } : {}),
  })

  const uptimeTick = createUptimeTick({
    db: deps.db,
    events: deps.events,
    spend,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })

  const handles: JobHandle[] = [
    createJob({
      name: 'provisionTicker',
      intervalMs: intervals.provisionMs,
      tick: provisionTick,
      // Jitter so the three jobs do not converge on the same millisecond and do all the work
      // at once every Nth tick.
      jitter: 0.1,
    }),
    createJob({ name: 'uptimeTicker', intervalMs: intervals.uptimeMs, tick: uptimeTick, jitter: 0.1 }),
    createJob({
      name: 'reconciler',
      intervalMs: intervals.reconcileMs,
      tick: reconcileTick,
      jitter: 0.1,
    }),
    createJob({
      name: 'sessionSweeper',
      intervalMs: intervals.sessionSweepMs,
      tick: () => {
        deleteExpiredSessions(deps.db)
      },
      jitter: 0.1,
    }),
  ]

  // The tracker primes itself at construction; refresh again with the injected clock so a
  // test's fake `now` decides which month the baseline belongs to.
  spend.refresh(deps.now?.())

  return {
    handles,
    spend,
    checkLimits: createLimitsEnforcer({
      db: deps.db,
      limits: deps.limits,
      spend,
      ...(deps.now ? { now: deps.now } : {}),
    }),

    start() {
      for (const handle of handles) handle.start()
    },

    async stop() {
      // Sequential rather than parallel: each stop awaits its own in-flight tick, and a tick
      // that is mid-write should finish before the next job's is interrupted.
      for (const handle of handles) await handle.stop()
    },

    async runAllNow() {
      for (const handle of handles) await handle.runNow()
    },
  }
}

export { createJob, type JobHandle, type JobOptions } from './run-job.js'
export {
  createLimitsEnforcer,
  createSpendTracker,
  LimitExceededError,
  type LimitReason,
  type SpendSnapshot,
  type SpendTracker,
} from './limits.js'
export {
  createProvisionTick,
  PROVISIONING_TIMEOUT_MS,
  type BootstrapPoller,
  type ProvisionTickResult,
} from './provision-ticker.js'
export { createUptimeTick, type UptimeTickResult } from './uptime-ticker.js'
export {
  createReconcileTick,
  type OrphanReport,
  type ReconcileResult,
  type ReconcilerDeps,
} from './reconciler.js'
export { runStartupRecovery, type RecoveryDeps, type RecoveryResult } from './recovery.js'
