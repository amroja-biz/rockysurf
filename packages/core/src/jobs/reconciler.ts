import type { ManagedResource } from '@rockysurf/provider-sdk'
import type { Db } from '../db/client.js'
import { getServer, listServersByStatus } from '../db/repositories/servers.js'
import { appendEvent } from '../db/repositories/users.js'
import type { ServerRow } from '../db/schema.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { EventsService } from '../services/events.js'

/**
 * The reconciler: diff what each provider says it is running against what the database
 * believes, and report the disagreements.
 *
 * This is the job that makes "your laptop is the control plane" credible (ADR-0001). A laptop
 * closes its lid mid-provision; a process is killed between writing a row and calling the
 * provider. Both leave the two sides out of step, and without something that looks, the
 * failure mode is a billing instance nobody can see.
 *
 * TWO PREDICATES, BOTH LEARNED THE HARD WAY.
 *
 * 1. OWNERSHIP DECIDES WHAT AN UNMATCHED RESOURCE MEANS (amendment D1). A `server-owned`
 *    resource with no live row is a reap candidate. A `shared` one — AWS's SSH security group
 *    is the real case — is REPORT-ONLY, always, because it intentionally outlives every server
 *    that uses it. Live evidence from the spike: after a real teardown, `listManaged()`
 *    reported no instances and still reported `security-group/sg-0a949e8ed67c5a1bd`
 *    (`spike/recordings/aws-callback-lifecycle.txt:55-56`). A reconciler that treats
 *    `listManaged()` as a delete-list would have deleted the group out from under every
 *    running server.
 *
 * 2. ABSENCE IS NOT PROOF OF TERMINATION until the propagation grace has passed (amendment
 *    A4). EC2's DescribeInstances is eventually consistent: the spike saw a `describe()` 0.1s
 *    after a SUCCESSFUL launch return not-found, which read literally means "terminated". The
 *    grace is enforced by `lifecycle.sync`, so this job asks THAT rather than reimplementing
 *    the rule — and it only believes a row is gone once sync has said so.
 *
 * V0.1 DOES NOT AUTO-TERMINATE. An orphan is recorded and surfaced; a human decides. The
 * asymmetry is deliberate: failing to reap costs money, and reaping wrongly destroys someone's
 * work. Automatic clean-up becomes a config option once the flagging has been trusted in the
 * field for a while — the events this job writes are what will justify turning it on.
 */

/** Statuses whose rows legitimately correspond to a live cloud resource. */
const LIVE_STATUSES = ['requested', 'provisioning', 'running', 'stopped'] as const

export interface ReconcilerDeps {
  db: Db
  registry: ProviderRegistry
  events: EventsService
  /** From the lifecycle service: already honours the describe() propagation grace (A4). */
  sync: (row: ServerRow) => Promise<ServerRow>
  log?: (message: string) => void
}

export interface OrphanReport {
  providerId: string
  kind: string
  providerNativeId: string
  /** Present when the resource carries a server tag that no live row matches. */
  serverId?: string
}

export interface ReconcileResult {
  /** Providers actually reached. A provider that threw is counted in `failed`. */
  checked: number
  failed: number
  /** Cloud resources with no live row, server-owned: reap candidates, not reaped. */
  orphans: OrphanReport[]
  /** Shared resources with no live row: reported once, never actionable. */
  sharedSeen: number
  /** Rows whose cloud resource is gone, moved to a terminal status by sync. */
  vanished: string[]
}

export function createReconcileTick(deps: ReconcilerDeps): () => Promise<ReconcileResult> {
  const log = deps.log ?? (() => {})

  return async function reconcileTick(): Promise<ReconcileResult> {
    const result: ReconcileResult = { checked: 0, failed: 0, orphans: [], sharedSeen: 0, vanished: [] }

    const liveRows = listServersByStatus(deps.db, [...LIVE_STATUSES])
    const liveById = new Map(liveRows.map((row) => [row.id, row]))

    for (const provider of deps.registry.list()) {
      let managed: ManagedResource[]
      try {
        managed = await provider.listManaged()
        result.checked++
      } catch (err) {
        // One unreachable cloud must not stop the others: a reconciler that gives up on the
        // first API error is a reconciler that stops running the day a token expires.
        result.failed++
        log(`reconciler: ${provider.id} listManaged failed: ${String(err)}`)
        continue
      }

      for (const resource of managed) {
        if (resource.ownership === 'shared') {
          // Report-only, ALWAYS. Not an orphan even when nothing references it.
          result.sharedSeen++
          continue
        }

        // Server-owned. Attributable resources are matched by tag; an unattributable one is
        // reported too, because a resource this installation created and cannot name is
        // exactly the thing worth a human's attention.
        const matched = resource.serverId ? liveById.get(resource.serverId) : undefined
        if (matched) continue

        const orphan: OrphanReport = {
          providerId: provider.id,
          kind: resource.kind,
          providerNativeId: resource.providerNativeId,
          ...(resource.serverId ? { serverId: resource.serverId } : {}),
        }
        result.orphans.push(orphan)
        await reportOrphan(deps, orphan)
      }
    }

    /* ---- the other direction: a row whose cloud resource is gone. ---- */
    for (const row of liveRows) {
      if (!row.providerData) continue // never reached a provider; recovery owns this one
      try {
        // sync() owns the grace: it will not call absence "terminated" until the propagation
        // window has passed, which is the whole of amendment A4.
        const after = await deps.sync(row)
        if (after.status !== row.status && (after.status === 'terminated' || after.status === 'failed')) {
          result.vanished.push(row.id)
          appendEvent(deps.db, {
            type: 'reconciler.server_vanished',
            serverId: row.id,
            userId: row.userId,
            payload: { from: row.status, to: after.status, provider: row.provider },
          })
        }
      } catch (err) {
        log(`reconciler: sync failed for ${row.id}: ${String(err)}`)
      }
    }

    if (result.orphans.length > 0 || result.vanished.length > 0) {
      log(
        `reconciler: ${result.orphans.length} orphan(s), ${result.vanished.length} vanished row(s) ` +
          `across ${result.checked} provider(s)`,
      )
    }
    return result
  }
}

/**
 * Record an orphan and tell the operator.
 *
 * The event row is the durable half — it is what a later "clean these up" feature will read,
 * and what justifies turning auto-reap on. The SSE broadcast is the immediate half.
 */
async function reportOrphan(deps: ReconcilerDeps, orphan: OrphanReport): Promise<void> {
  appendEvent(deps.db, {
    type: 'reconciler.orphan_detected',
    ...(orphan.serverId ? { serverId: orphan.serverId } : {}),
    payload: {
      ...orphan,
      // Stated in the record itself, so an operator reading the event knows nothing was done
      // on their behalf and no cloud resource was destroyed by a background job.
      action: 'flagged-only',
      note: 'v0.1 never auto-terminates; a human decides',
    },
  })

  // There is no admin fan-out channel yet (the SSE service addresses users), so the durable
  // event above is the operator-facing record. When the row is still known, the owner also
  // gets it live; an orphan with no matching row has no user to tell, which is precisely why
  // the event table — not the stream — is the contract here.
  const owner = orphan.serverId ? getServer(deps.db, orphan.serverId)?.userId : undefined
  if (owner) {
    await deps.events.broadcastToUser(owner, {
      type: 'reconciler-orphan',
      provider: orphan.providerId,
      kind: orphan.kind,
      providerNativeId: orphan.providerNativeId,
      serverId: orphan.serverId,
    } as never)
  }
}
