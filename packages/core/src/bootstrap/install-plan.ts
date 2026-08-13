import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client.js'
import { getPack, listTools } from '../db/repositories/packs.js'
import { getServerRepositories, getServerTools, setInstallPlan } from '../db/repositories/servers.js'
import type { BootstrapMode, ServerRow } from '../db/schema.js'
import type { InstallPlan } from './plan.js'
import { resolveInstallPlan, type ResolvablePack } from './resolver.js'

/**
 * Snapshot the install plan onto the row, at create time (rockysurf-55fx.13).
 *
 * `resolveInstallPlan` and `setInstallPlan` both landed with 55fx.4 and neither was ever
 * called outside tests, so every server created by the production stack carried
 * `installPlan: null` — which broke BOTH topologies for the same reason and in two different
 * ways: push refused to start (`runPushBootstrap` throws on a row with no plan) and callback
 * answered the box's plan fetch with a 404. This is the missing caller.
 *
 * Create time, not push time, is deliberate and comes from `plan.ts`: the snapshot is what
 * makes a re-push run the plan the server was CREATED with rather than whatever the pack says
 * today. A plan resolved lazily at first contact would quietly change under a server whose
 * pack was edited while it was booting.
 */

export interface SnapshotInstallPlanOptions {
  mode: BootstrapMode
  /** Core's own base URL. Required for callback mode, ignored for push. */
  publicUrl?: string
  /** Off only for tests. */
  branding?: boolean
}

/**
 * The pack this server is actually getting.
 *
 * A row with no `packId`, or one naming a pack that has since been deleted, still gets a plan:
 * the runtime-guaranteed base tools and the branding step. That is what keeps "the operator
 * removed a pack" from turning into "this server can never finish provisioning" — the resolver
 * always emits a step reporting `ready`, so the row still reaches `running`.
 */
function resolvePack(db: Db, row: ServerRow): ResolvablePack {
  const pack = row.packId ? getPack(db, row.packId) : undefined
  // An explicit per-server tool selection wins over the pack's list; the pack is the default,
  // not a floor.
  const selected = getServerTools(row)
  if (!pack) return { id: row.packId ?? 'none', tools: selected, requiresRdp: false }
  return {
    id: pack.id,
    tools: selected.length > 0 ? selected : pack.tools,
    requiresRdp: pack.requiresRdp,
    ...(pack.desktop ? { desktop: pack.desktop } : {}),
  }
}

export function snapshotInstallPlan(db: Db, row: ServerRow, options: SnapshotInstallPlanOptions): InstallPlan {
  const plan = resolveInstallPlan({
    serverId: row.id,
    // The plan's own run id. Push mints a fresh one per attempt and overrides this; callback
    // has no other place to carry one, so the snapshot is where its runId lives.
    runId: randomUUID(),
    mode: options.mode,
    ...(options.mode === 'callback' && options.publicUrl
      ? { callbackUrl: `${options.publicUrl.replace(/\/+$/, '')}/internal/servers/${row.id}/status` }
      : {}),
    pack: resolvePack(db, row),
    tools: listTools(db),
    repositories: getServerRepositories(row),
    ...(options.branding === false ? { branding: false } : {}),
  })

  setInstallPlan(db, row.id, plan)
  return plan
}
