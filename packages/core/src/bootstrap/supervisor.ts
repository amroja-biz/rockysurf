import type { Db } from '../db/client.js'
import { recordProgress } from '../db/repositories/servers.js'
import { appendEvent } from '../db/repositories/users.js'
import type { ServerRow } from '../db/schema.js'
import type { BootstrapPoller } from '../jobs/provision-ticker.js'
import type { SecretsStore } from '../secrets/store.js'
import type { EventsService } from '../services/events.js'
import { HostKeyMismatchError } from './push.js'
import { MissingKeyMaterialError, runPushBootstrap } from './push-runner.js'

/**
 * The adapter between the provision ticker and the push runner (rockysurf-55fx.13).
 *
 * These two were built to meet and never introduced: `provision-ticker.ts` declared a
 * `BootstrapPoller` seam "for when 55fx.4 lands", 55fx.4 landed `runPushBootstrap`, and nothing
 * ever called it — so on the production stack a server booted, went `running`, and sat there
 * with nothing installed. This is the few lines that seam predicted, plus the one thing it did
 * not: the shapes do not actually match.
 *
 * `poll()` is a per-tick question that must answer in milliseconds. `runPushBootstrap` is a
 * MINUTES-LONG drive that holds an SSH connection open, uploads the agent, launches it and
 * watches the journal to completion. So this is a supervisor, not a poller: the first `poll()`
 * for a server STARTS the drive and returns "nothing yet"; later polls report that it is still
 * running; and the poll after it settles reports how it ended. The ticker keeps its 10-second
 * cadence throughout and is never blocked by an install.
 *
 * THE TICKER OWNS THE FIRST PUSH — not the create path. Three reasons, in order of weight:
 *
 *  1. **Create and restart-recovery become the same code path.** A server that was mid-install
 *     when core stopped is, to this supervisor, indistinguishable from one that has just been
 *     created: both are push-mode rows in `provisioning` with no active run. The startup
 *     recovery pass already re-attaches those rows and the ticker already sweeps them, so
 *     resume needs no second trigger and cannot drift from the first one.
 *  2. **The address arrives late.** A push needs `publicIp`, which several providers do not
 *     return from `provision()` at all — it appears on a later `describe()`. The ticker syncs
 *     the row and then polls, in that order, so the address is simply there; a create-path
 *     push would have to wait for one inside an HTTP request.
 *  3. **Nothing should launch a twenty-minute background task out of a request handler.** The
 *     job loop is the part of this process that owns long-running work, and it already has
 *     the overlap guard, the timeout and the failure path.
 *
 * The cost is up to one tick — ten seconds — before a new server's install begins. That is
 * invisible next to the minute or so a box takes to finish booting.
 */

export interface PushSupervisorDeps {
  db: Db
  events: EventsService
  /** Holds the per-server private key material the push authenticates with. */
  secrets: SecretsStore
  /**
   * The installed software's secrets — the git token and friends. Same source the callback
   * topology serves from `/internal/servers/:id/secrets`, so both modes install with the same
   * material rather than each having its own idea of what a server was given.
   */
  loadServerSecrets?: (row: ServerRow) => Promise<Record<string, string>>
  log?: (message: string) => void
  /** Injected by tests. Defaults to the real SSH drive. */
  run?: typeof runPushBootstrap
  /** Consecutive infrastructure failures before the server is failed outright. */
  maxAttempts?: number
}

/**
 * Three, not one and not unbounded.
 *
 * One would fail a server on a single dropped connection. Unbounded would retry silently until
 * the 30-minute provisioning timeout fired, and the user would be told "provisioning did not
 * complete" when core knew perfectly well that the host key was wrong or the disk was full.
 * Three attempts is enough to ride out a transient network fault and still leave the real
 * error on the row.
 */
const DEFAULT_MAX_ATTEMPTS = 3

interface Outcome {
  step?: string
  failed?: boolean
  error?: string
}

/**
 * The end of bootstrap: the row becomes `running`, and the user's open streams hear about it.
 *
 * Exported because it is the definition of "this server finished", not an implementation
 * detail of the supervisor — `lifecycle.sync` now deliberately refuses to promote a
 * provisioning row, so this is the ONLY path from `provisioning` to `running` for a push-mode
 * server, and a test that wants a running server has to go through it rather than fake it.
 *
 * The `server-status` broadcast is load-bearing rather than decorative: the dashboard reads a
 * server's status from that event type alone (`DashboardPage.tsx`), so a promotion that only
 * wrote the row would leave every open tab showing "provisioning" until the user reloaded.
 */
export async function markBootstrapReady(db: Db, events: EventsService, row: ServerRow): Promise<ServerRow | undefined> {
  const updated = recordProgress(db, row.id, { step: 'ready' })
  if (!updated) return undefined

  appendEvent(db, { type: 'server-status', serverId: updated.id, userId: updated.userId, payload: {} })
  await events.broadcastToUser(updated.userId, {
    type: 'server-status',
    serverId: updated.id,
    status: updated.status,
    ...(updated.publicIp ? { publicIp: updated.publicIp } : {}),
  })
  return updated
}

/**
 * The last thing the failing step said, trimmed to fit a status field.
 *
 * Installers put their verdict on the final line and their colour codes everywhere, so the
 * escape sequences come out — a status field is read as text, and `[0;31mError:` helps
 * nobody.
 */
function lastLineOf(logTail: string | undefined, limit = 200): string {
  if (!logTail) return ''
  const cleaned = logTail
    // eslint-disable-next-line no-control-regex -- ANSI SGR sequences, which is the point
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const last = cleaned.at(-1)
  if (!last) return ''
  return `: ${last.length > limit ? `${last.slice(0, limit)}…` : last}`
}

/** Errors that will never succeed on a retry, so retrying only delays the truth. */
function isFatal(error: unknown): boolean {
  // A host-key mismatch is the one SSH error that must never be retried: the box answering is
  // not the box core provisioned, and the next connection would carry the secrets file to it.
  return error instanceof HostKeyMismatchError || error instanceof MissingKeyMaterialError
}

export function createPushBootstrapSupervisor(deps: PushSupervisorDeps): BootstrapPoller {
  const log = deps.log ?? ((message: string) => console.error(message))
  const run = deps.run ?? runPushBootstrap
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  /** Servers with a drive in flight in THIS process. The single-flight guard. */
  const active = new Set<string>()
  /** How a settled drive ended, waiting for the next poll to collect it. */
  const settled = new Map<string, Outcome>()
  /** Consecutive infrastructure failures per server. Reset by success. */
  const attempts = new Map<string, number>()

  function finish(serverId: string, outcome?: Outcome): void {
    active.delete(serverId)
    if (outcome) settled.set(serverId, outcome)
  }

  async function drive(row: ServerRow): Promise<void> {
    const secrets = (await deps.loadServerSecrets?.(row)) ?? {}
    const result = await run(
      { db: deps.db, events: deps.events, secrets: deps.secrets },
      row,
      Object.keys(secrets).length > 0 ? { secrets } : {},
    )

    if (result.state.status === 'failed') {
      const failedStep = result.state.failedStep ?? result.state.step
      // Carry the reason, not just the location. This error becomes the row's `errorMessage`,
      // which is the only thing the user is shown — and "bootstrap failed at step 'tool:beads'"
      // sends them digging through the events table for the one line that actually explains it
      // (that is exactly what the 55fx.9 exit run made me do). The journal's log tail is that
      // line; it is trimmed because a whole install log does not belong in a status field.
      finish(row.id, { failed: true, error: `bootstrap failed at step '${failedStep}'${lastLineOf(result.state.logTail)}` })
      return
    }

    /*
     * Stamp `ready` here rather than trusting the plan's last step to report it.
     *
     * `recordProgress('ready')` is what promotes the row to `running` and stamps `startedAt`,
     * and with the sync gate in `lifecycle.sync` it is now the ONLY thing that does. Every
     * plan the resolver renders ends with a step reporting `ready`, but that is a property of
     * the resolver, not a guarantee of this contract — and a plan whose last step happened to
     * report something else would leave a perfectly healthy box stuck in `provisioning` until
     * the 30-minute timeout terminated it. The completion of the drive is the fact; this
     * writes it down.
     */
    await markBootstrapReady(deps.db, deps.events, row)
    attempts.delete(row.id)
    finish(row.id)
  }

  return {
    async poll(row: ServerRow): Promise<Outcome | undefined> {
      const collected = settled.get(row.id)
      if (collected) {
        settled.delete(row.id)
        return collected
      }

      if (active.has(row.id)) return undefined
      // Not an error, just not yet: an instance with no address is one the provider has not
      // finished wiring up. The ticker's timeout is what decides it never will.
      if (!row.publicIp) return undefined
      if (!row.installPlan) {
        return { failed: true, error: 'server has no install plan; it was created before one was snapshotted' }
      }

      active.add(row.id)
      // Deliberately not awaited: this is the point of the supervisor. Every failure path
      // below ends in `finish`, so a drive can never leave the server marked active forever.
      void drive(row).catch((error: unknown) => {
        if (isFatal(error)) {
          attempts.delete(row.id)
          finish(row.id, { failed: true, error: String(error) })
          return
        }

        const attempt = (attempts.get(row.id) ?? 0) + 1
        attempts.set(row.id, attempt)
        log(`[bootstrap] push attempt ${attempt}/${maxAttempts} failed for ${row.id}: ${String(error)}`)
        if (attempt >= maxAttempts) {
          attempts.delete(row.id)
          finish(row.id, { failed: true, error: `bootstrap failed after ${attempt} attempts: ${String(error)}` })
          return
        }
        // Retryable and under the cap: clear the flag and let the next tick start a fresh
        // drive. The box's journal makes that a resume, not a restart — completed steps are
        // skipped.
        finish(row.id)
      })

      return undefined
    },
  }
}
