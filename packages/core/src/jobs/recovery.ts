import type { Db } from '../db/client.js'
import { listServersNeedingRecovery, updateServerStatus } from '../db/repositories/servers.js'
import { appendEvent } from '../db/repositories/users.js'
import type { ServerRow } from '../db/schema.js'
import type { BootstrapPoller } from './provision-ticker.js'

/**
 * The startup recovery pass: what core does about the servers it was in the middle of when it
 * last stopped.
 *
 * This is the other half of ADR-0001's inverted create ordering. Writing the row first means a
 * crash leaves a row with no instance rather than an instance with no row — but only if
 * something looks at those rows on the way back up. Without this pass, a laptop that closed
 * its lid mid-provision reopens to a server stuck in `provisioning` forever: no ticker will
 * finish it, no user can act on it, and the instance it may have created keeps billing.
 *
 * THE RULE: every row in a non-terminal pre-running state is either RE-ATTACHED or FAILED
 * CLEANLY. Never left as it was found. A row that cannot be resumed is more useful to its owner
 * as `failed` with a reason than as `provisioning` forever.
 *
 * Re-attachment is cheap by design, because push-mode bootstrap was built to survive exactly
 * this: the agent runs under a transient systemd unit that outlives core's SSH session, and it
 * journals every step to `state.json`. So core does not restart an install — it reads the
 * journal and picks up watching. The run id on that journal is what stops a resumed poll from
 * mistaking a PREVIOUS attempt's terminal status for this one's (ADR-0002 decision 7).
 */

export interface RecoveryDeps {
  db: Db
  /** From the lifecycle service; already honours the describe() propagation grace (A4). */
  sync: (row: ServerRow) => Promise<ServerRow>
  /** Reads the box's own journal. Absent in deployments with no push bootstrap wired. */
  bootstrap?: BootstrapPoller
  log?: (message: string) => void
}

export interface RecoveryResult {
  examined: number
  /** Rows whose install is still going and is now being watched again. */
  reattached: string[]
  /** Rows the provider says finished while core was down. */
  settled: string[]
  /** Rows that could not be resumed and were failed with a reason. */
  failed: string[]
}

export async function runStartupRecovery(deps: RecoveryDeps): Promise<RecoveryResult> {
  const log = deps.log ?? (() => {})
  const result: RecoveryResult = { examined: 0, reattached: [], settled: [], failed: [] }

  const rows = listServersNeedingRecovery(deps.db)
  if (rows.length === 0) return result
  log(`recovery: ${rows.length} server(s) were mid-flight when core last stopped`)

  for (const row of rows) {
    result.examined++
    try {
      await recoverOne(deps, row, result, log)
    } catch (err) {
      // A single unrecoverable row must not stop the pass: the next row might be the one the
      // operator is waiting on.
      fail(deps, row, `recovery failed: ${String(err)}`, result)
      log(`recovery: ${row.id} could not be recovered: ${String(err)}`)
    }
  }

  return result
}

async function recoverOne(
  deps: RecoveryDeps,
  row: ServerRow,
  result: RecoveryResult,
  log: (m: string) => void,
): Promise<void> {
  // A row that never reached the provider has no instance to re-attach to. It is the clean
  // half of the inverted ordering: nothing was created, so nothing is orphaned, and the row
  // is honestly a failure rather than a mystery.
  if (!row.providerData) {
    fail(deps, row, 'core stopped before the provider was called; no instance was created', result)
    return
  }

  // Ask the provider what actually happened while core was down. sync() owns the propagation
  // grace, so a just-created instance is not mistaken for a vanished one.
  const synced = await deps.sync(row)

  if (synced.status === 'terminated' || synced.status === 'failed') {
    result.settled.push(row.id)
    appendEvent(deps.db, {
      type: 'recovery.settled',
      serverId: row.id,
      userId: row.userId,
      payload: { from: row.status, to: synced.status },
    })
    return
  }

  // The instance exists. If a bootstrap poller is wired, read the box's own journal: an agent
  // launched under its transient unit has been installing this whole time, whether or not core
  // was watching.
  if (!deps.bootstrap) {
    // No poller: the row is legitimately still provisioning and the ticker will carry it. Do
    // not fail it — the instance is alive and an install may well be running on it.
    result.reattached.push(row.id)
    return
  }

  const progress = await deps.bootstrap.poll(synced)
  if (progress?.failed) {
    fail(deps, row, progress.error ?? 'the box reported a failed bootstrap step', result)
    return
  }

  result.reattached.push(row.id)
  appendEvent(deps.db, {
    type: 'recovery.reattached',
    serverId: row.id,
    userId: row.userId,
    payload: { status: synced.status, ...(progress?.step ? { step: progress.step } : {}) },
  })
  log(`recovery: re-attached ${row.id}${progress?.step ? ` at step ${progress.step}` : ''}`)
}

function fail(deps: RecoveryDeps, row: ServerRow, reason: string, result: RecoveryResult): void {
  // `failed` is reachable from every pre-running status, so this cannot throw on the state
  // machine — which matters, because this is the path that exists to leave nothing stuck.
  updateServerStatus(deps.db, row.id, 'failed', { errorMessage: reason })
  result.failed.push(row.id)
  appendEvent(deps.db, {
    type: 'recovery.failed',
    serverId: row.id,
    userId: row.userId,
    payload: { from: row.status, reason },
  })
}
