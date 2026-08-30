import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client.js'
import { getPack, listTools } from '../db/repositories/packs.js'
import {
  getServerEnvironment,
  getServerPackInputs,
  getServerRepositories,
  getServerTools,
  setInstallPlan,
} from '../db/repositories/servers.js'
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
  /**
   * Core's own newly-minted public key line (ADR-0008, issue #92) — needed only when `row`
   * also carries `userSuppliedPublicKey`, to render the plan step that removes exactly this
   * line from the box once bootstrap confirms the user's own key is authorized. The row itself
   * never holds the blob, only a fingerprint of it, so the caller (which just minted it) passes
   * it through rather than this function re-deriving it. Absent means no such step is rendered
   * — safe, not silent: the box simply keeps both keys, same as before this feature existed.
   */
  managedPublicKey?: string
  /**
   * The NAMES of the secret halves of the pack's inputs and of the creator's Environment
   * (issue #244). The plain halves are columns on the row and are read from it below; the
   * secret halves live in the encrypted store, which this function does not open — reading
   * values back to take their keys would be a plaintext accessor for nothing — so the create
   * path, which has the request in hand, passes the names through. Names are not secret.
   * Absent means no secret halves, which is every server created without any.
   */
  secretEnvironmentNames?: { packInputs: string[]; environment: string[] }
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
    // From the ROW, like the repositories and the supplied key beside it (issue #184): the row
    // is the record of what the user asked for, and the plan is derived from it — so a
    // re-render months later still renders the script the server was created with rather than
    // needing the create request to be replayed.
    ...(row.userScript ? { userScript: { script: row.userScript, runAs: row.userScriptRunAs ?? 'rocky' } } : {}),
    // The names that go into rocky's shell (issue #244): the plain halves off the row, the
    // secret halves from the caller. Names only — the values never enter the plan.
    shellEnvironment: {
      packInputs: [...Object.keys(getServerPackInputs(row)), ...(options.secretEnvironmentNames?.packInputs ?? [])],
      environment: [...Object.keys(getServerEnvironment(row)), ...(options.secretEnvironmentNames?.environment ?? [])],
    },
    ...(options.branding === false ? { branding: false } : {}),
    ...(row.userSuppliedPublicKey && options.managedPublicKey
      ? { userSuppliedPublicKey: row.userSuppliedPublicKey, managedPublicKey: options.managedPublicKey }
      : {}),
  })

  setInstallPlan(db, row.id, plan)
  return plan
}
