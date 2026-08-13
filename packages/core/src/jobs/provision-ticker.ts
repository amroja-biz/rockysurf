import type { Db } from '../db/client.js'
import { getProviderData, listServersNeedingRecovery, updateServerStatus } from '../db/index.js'
import type { ServerRow } from '../db/schema.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { EventsService } from '../services/events.js'

/**
 * Drive servers that are still coming up, and fail the ones that never will.
 *
 * Two jobs in one tick because they walk the same short list:
 *
 *  1. **Sync** — refresh each in-flight row from the provider through `lifecycle.sync`, which
 *     already honours the `describe()` propagation grace, so a create that has not propagated
 *     is not mistaken for a vanished instance.
 *  2. **Timeout** — a server stuck in `requested`/`provisioning` past the deadline is failed
 *     and its instance terminated. This absorbs the old `checkProvisioningTimeout.ts` Lambda,
 *     including its 30-minute window; what changes is that the cloud resource is now released
 *     through `provider.terminate()` instead of by deleting a CloudFormation stack, and that
 *     the row is failed with a reason rather than a bare status.
 *
 * Terminating on timeout is the one destructive thing any job here does, and it is the right
 * call: a server stuck in `provisioning` for half an hour is a resource nobody is using and
 * everybody is paying for. It is also the case the old system already handled this way.
 */

/** The old Lambda's window, kept deliberately. */
export const PROVISIONING_TIMEOUT_MS = 30 * 60 * 1000

/**
 * What this ticker needs from bootstrap, and nothing more.
 *
 * FILLED by `bootstrap/supervisor.ts` (rockysurf-55fx.13). This was written as a seam for
 * 55fx.4 "which is in flight", predicting that its poller would satisfy the shape or need an
 * adapter of a few lines. 55fx.4 landed, both beads closed, and nobody wrote the adapter — so
 * every server on the production stack booted and then sat there with nothing installed, and
 * the milestone exit run was what finally noticed. The supervisor is that adapter; the reason
 * it is more than a few lines is that `poll()` is a per-tick question and the push it drives
 * takes minutes.
 */
export interface BootstrapPoller {
  /**
   * Read the box's own progress journal. Returns undefined when there is nothing to report
   * yet — a box that is not reachable is not an error, it is a box that is still booting.
   */
  poll(row: ServerRow): Promise<{ step?: string; failed?: boolean; error?: string } | undefined>
}

export interface ProvisionTickerDeps {
  db: Db
  registry: ProviderRegistry
  events: EventsService
  /** From the lifecycle service; already honours DESCRIBE_ABSENCE_GRACE. */
  sync: (row: ServerRow) => Promise<ServerRow>
  /**
   * Optional only for tests and for a core with no secrets store to hold SSH keys. Without it
   * the ticker syncs rows and installs nothing, which is precisely the failure 55fx.13 fixed —
   * so `createApp` passes one whenever it can build it.
   */
  bootstrap?: BootstrapPoller
  timeoutMs?: number
  now?: () => Date
  log?: (message: string) => void
}

export interface ProvisionTickResult {
  synced: number
  timedOut: number
  bootstrapPolled: number
}

export function createProvisionTick(deps: ProvisionTickerDeps): () => Promise<ProvisionTickResult> {
  const { db, registry, events, sync } = deps
  const timeoutMs = deps.timeoutMs ?? PROVISIONING_TIMEOUT_MS
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((message: string) => console.error(message))

  async function failStuck(row: ServerRow, ageMs: number): Promise<void> {
    const minutes = Math.round(ageMs / 60_000)
    const reason = `provisioning did not complete within ${Math.round(timeoutMs / 60_000)} minutes (stuck for ${minutes})`
    log(`[provision-ticker] timing out ${row.id}: ${reason}`)

    // Release the cloud resource first. If this throws, the row stays in provisioning and the
    // next tick tries again — better than a row marked failed beside an instance still billing.
    const data = getProviderData(row)
    if (data) {
      try {
        await registry.get(row.provider).terminate(data)
      } catch (error) {
        log(`[provision-ticker] could not terminate ${row.id} while timing it out: ${String(error)}`)
      }
    }

    const failed = updateServerStatus(db, row.id, 'failed', { errorMessage: reason })
    await events.broadcastToUser(failed.userId, {
      type: 'server-status',
      serverId: failed.id,
      status: failed.status,
      error: reason,
    })
  }

  return async function tick(): Promise<ProvisionTickResult> {
    const at = now().getTime()
    let synced = 0
    let timedOut = 0
    let bootstrapPolled = 0

    for (const row of listServersNeedingRecovery(db)) {
      const age = at - Date.parse(row.createdAt)

      if (age > timeoutMs) {
        // One failure must not stop the sweep: the next row may be the one actually stuck.
        try {
          await failStuck(row, age)
          timedOut++
        } catch (error) {
          log(`[provision-ticker] failed to time out ${row.id}: ${String(error)}`)
        }
        continue
      }

      let current = row
      try {
        current = await sync(row)
        synced++
      } catch (error) {
        log(`[provision-ticker] sync failed for ${row.id}: ${String(error)}`)
        continue
      }

      if (deps.bootstrap && current.bootstrapMode === 'push' && current.status === 'provisioning') {
        try {
          const progress = await deps.bootstrap.poll(current)
          if (progress) {
            bootstrapPolled++
            if (progress.failed) {
              const reason = progress.error ?? 'bootstrap reported failure'
              const failed = updateServerStatus(db, current.id, 'failed', { errorMessage: reason })
              await events.broadcastToUser(failed.userId, {
                type: 'server-status',
                serverId: failed.id,
                status: failed.status,
                error: reason,
              })
            }
          }
        } catch (error) {
          // A box that will not answer yet is normal, not a failure. Only the timeout above
          // decides that a server is never coming up.
          log(`[provision-ticker] bootstrap poll failed for ${current.id}: ${String(error)}`)
        }
      }
    }

    return { synced, timedOut, bootstrapPolled }
  }
}
