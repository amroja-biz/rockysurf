import { readLive, type Live } from '../config/index.js'
import type { Db } from '../db/client.js'
import { recordProgress } from '../db/repositories/servers.js'
import { appendEvent } from '../db/repositories/users.js'
import { isValidProvisioningStep, statusForStep } from '../db/transitions.js'
import type { ProvisioningStep, ServerRow } from '../db/schema.js'
import type { EventsService } from '../services/events.js'
import type { SecretsStore } from '../secrets/store.js'
import { getServerKeyMaterial } from '../ssh/server-keys.js'
import { mintCallbackTokens } from '../db/repositories/bootstrap-tokens.js'
import { parseInstallPlan } from './plan.js'
import { bootstrapProgressEvent, serverStatusEvent } from './progress-event.js'
import {
  pushBootstrap,
  waitForSsh,
  type AgentState,
  type PushResult,
  type PushTarget,
} from './push.js'

/**
 * Drives one server's push bootstrap and turns what the box says into what core stores.
 *
 * The division of labour matters: `push.ts` knows SSH and the journal, this file knows the
 * database and the event stream, and neither knows the other's vocabulary. The journal is the
 * source of truth in both — the SSE lines are UX, and a dropped log line changes nothing about
 * what core believes happened.
 */

export interface PushRunnerDeps {
  db: Db
  events: EventsService
  secrets: SecretsStore
}

export interface RunPushBootstrapOptions {
  /** Extra environment for install steps — the git token and friends, never core's own. */
  secrets?: Record<string, string>
  /**
   * Override the port to dial. The ROW is the normal source (ADR-0003, E13) — this exists for
   * tests and for a caller that already knows better, and it wins when both are present.
   */
  sshPort?: number
  connectTimeoutMs?: number
  pollIntervalMs?: number
  onLog?: (line: string) => void
}

export class MissingKeyMaterialError extends Error {
  override readonly name = 'MissingKeyMaterialError'
  constructor(serverId: string) {
    super(`server ${serverId} has no stored SSH key material; it cannot be bootstrapped`)
  }
}

export class MissingAddressError extends Error {
  override readonly name = 'MissingAddressError'
  constructor(serverId: string) {
    super(`server ${serverId} has no public address yet`)
  }
}

/**
 * Choose a bootstrap mode (ADR-0002).
 *
 * Push is the default and needs nothing inbound. Callback is only possible when core has a
 * public URL for the box to call, so the absence of one settles it — and even when a URL
 * exists, push remains the default, because callback's costs (a credential resident on the
 * box, a runcmd, user-data that grows with the agent) are paid for nothing if core is
 * reachable outbound anyway.
 */
export function selectBootstrapMode(
  config: { server: { publicUrl?: string } },
  requested?: 'push' | 'callback',
): 'push' | 'callback' {
  if (requested !== 'callback') return 'push'
  if (!config.server.publicUrl) {
    // Refuse rather than silently downgrade. A caller that asked for callback has a reason —
    // a box core cannot dial — and quietly giving them push would produce a server that
    // provisions and then never bootstraps, with nothing in the logs explaining why.
    throw new CallbackUnavailableError()
  }
  return 'callback'
}

/**
 * The create-path wiring for bootstrap topology (rockysurf-55fx.4 addendum).
 *
 * Returns the two hooks the lifecycle needs: one that picks the mode before the row is
 * written, and one that mints callback tokens after it exists — `mintCallbackTokens` updates
 * the server row, so it cannot run before there is a row to update.
 *
 * PUSH MODE MINTS NOTHING, and that is the point. A push-mode box is never told a core URL and
 * never given a credential, so minting "just in case" would put a live token on a row for a
 * topology that has no way to use it — an unnecessary secret with an indefinite lifetime.
 */
export function bootstrapModeHooks(
  db: Db,
  /** Read at create time since #264, so saving `server.publicUrl` enables callback mode at once. */
  config: Live<{ server: { publicUrl?: string } }>,
  requested?: 'push' | 'callback',
): {
  selectMode: () => 'push' | 'callback'
  mintTokensIfNeeded: (serverId: string, mode: 'push' | 'callback') => void
} {
  return {
    selectMode: () => selectBootstrapMode(readLive(config), requested),
    mintTokensIfNeeded: (serverId, mode) => {
      if (mode !== 'callback') return
      mintCallbackTokens(db, serverId)
    },
  }
}

export class CallbackUnavailableError extends Error {
  override readonly name = 'CallbackUnavailableError'
  constructor() {
    super(
      'callback bootstrap needs a core the box can reach: set server.publicUrl, or use push mode, ' +
        'which needs no inbound connectivity at all',
    )
  }
}

/**
 * The label the agent reports, mapped onto a provisioning step core knows.
 *
 * A REPORT THAT WOULD PROMOTE THE ROW IS NOT ACCEPTED FROM HERE AT ALL (rockysurf-1c8z).
 *
 * `agent.sh` journals a step as `running` when it STARTS — `set_step "$id" running` sits above
 * `install_tool`, deliberately, so the SPA's timeline can light the step that is happening. For
 * every ordinary step that is exactly right. For the LAST one it was a lie: every plan the
 * resolver renders ends with a step whose `reports` is `ready`, `recordProgress('ready')` is
 * what flips the row to `running` and stamps `startedAt`, so a push-mode box was announced as
 * running the moment its final step began. A box that then died mid-step read as healthy, and
 * uptime and cost accrual had already started.
 *
 * `supervisor.ts` says of its own `markBootstrapReady` that stamping `ready` there rather than
 * trusting the plan's last step is "the ONLY thing" that promotes a push-mode row. That was the
 * design; this function was quietly the second path. Now it is not: the supervisor promotes when
 * the DRIVE COMPLETES, which is the fact worth writing down, and it broadcasts the status event
 * itself so nothing about rockysurf-xinr's live-update fix depends on this call.
 *
 * Stated as "would this report promote?" rather than as `label === 'ready'`, because
 * `statusForStep` is where that question is already answered — one definition, not two.
 */
function toProvisioningStep(state: AgentState): ProvisioningStep | undefined {
  const label = state.steps.find((s) => s.id === state.step)?.reports ?? state.step
  if (!isValidProvisioningStep(label)) return undefined
  return statusForStep(label) ? undefined : label
}

export async function runPushBootstrap(
  deps: PushRunnerDeps,
  row: ServerRow,
  options: RunPushBootstrapOptions = {},
): Promise<PushResult> {
  const material = getServerKeyMaterial(deps.secrets, row.id)
  // `!material.userPrivateKey` catches a retired key (ADR-0008) the same as an absent one: both
  // mean core has nothing to authenticate a push with. This should never actually happen —
  // retirement only runs after a bootstrap already reached `running`, and nothing re-drives a
  // running row — but a clear error here beats ssh2 rejecting an empty-string private key with
  // a message that reads like a network problem.
  if (!material || !material.userPrivateKey) throw new MissingKeyMaterialError(row.id)
  if (!row.publicIp) throw new MissingAddressError(row.id)
  if (!row.installPlan) throw new Error(`server ${row.id} has no install plan`)

  const port = options.sshPort ?? row.sshPort ?? undefined
  const target: PushTarget = {
    host: row.publicIp,
    // From the ROW, which is where the provider's answer landed. Before this, the port a BYO
    // host was registered on died at the provider boundary and core dialled 22 unconditionally
    // — so a host on 2222 was claimed, prepared, and then never bootstrapped (ftl9.12).
    ...(port ? { port } : {}),
    user: row.sshUser ?? 'rocky',
    privateKey: material.userPrivateKey,
    // The pin comes from the ROW, not from the key material: it is what core recorded when it
    // minted the identity, and the row is what a recovery pass has after a restart.
    hostKeyFingerprint: row.hostKeyFingerprint ?? material.hostKeyFingerprint,
  }

  const plan = parseInstallPlan(JSON.parse(row.installPlan))
  const client = await waitForSsh(target, {
    ...(options.connectTimeoutMs ? { timeoutMs: options.connectTimeoutMs } : {}),
  })

  try {
    return await pushBootstrap(client, {
      target,
      plan,
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
      onLog: (line) => {
        options.onLog?.(line)
        // Fire-and-forget: a stream nobody is listening to must not slow the install, and a
        // failed broadcast must not fail the bootstrap.
        void deps.events.broadcastToUser(row.userId, {
          type: 'bootstrap-log',
          serverId: row.id,
          line,
        } as never)
      },
      onState: (state) => {
        applyAgentState(deps, row, state)
      },
    })
  } finally {
    client.end()
  }
}

/**
 * Mirror of the callback-mode status route, for the topology where the box never speaks:
 * same row fields, same rules, no HTTP and no token because core read the journal itself.
 */
export function applyAgentState(deps: PushRunnerDeps, row: ServerRow, state: AgentState): void {
  const step = toProvisioningStep(state)
  // recordProgress owns the rules — valid step, only while provisioning, never backwards.
  const updated = step ? recordProgress(deps.db, row.id, { step }) : undefined

  appendEvent(deps.db, {
    type: 'bootstrap.step',
    serverId: row.id,
    userId: row.userId,
    ...(state.runId ? { runId: state.runId } : {}),
    payload: {
      step: state.step,
      status: state.status,
      ...(state.failedStep ? { failedStep: state.failedStep } : {}),
      // The log tail is diagnostic and can contain a lot; the event carries it because it is
      // the only record of WHY a step failed once the box is gone.
      ...(state.logTail ? { logTail: state.logTail } : {}),
      ...(state.notice ? { notice: state.notice } : {}),
    },
  })

  // THE LABEL GOES ON THE WIRE, NOT THE STEP ID (rockysurf-xinr). `state.step` is the plan's
  // journal key — `tool:beads` — and the SPA's timeline is a fixed list of provisioning steps,
  // so sending the id left every step unlit for the whole install. The id still travels, in
  // the field that means "id". A step whose `reports` is not a provisioning step at all is not
  // announced: there is nothing the timeline could do with it, and the log stream is already
  // carrying the detail.
  if (!step) return

  void deps.events.broadcastToUser(
    row.userId,
    bootstrapProgressEvent({
      serverId: row.id,
      step,
      stepId: state.step,
      status: updated?.status ?? row.status,
      publicIp: updated?.publicIp ?? row.publicIp,
      // Absent means "nothing unusual", and the SPA clears what it was showing — so a journal
      // that dropped its notice is a progress event without one, not a stale line on screen.
      notice: state.notice,
    }),
  )

  // A report that changed the row's status says so in the event type the SPA reads statuses
  // from (rockysurf-xinr): the dashboard reads a server's status from `server-status` alone, so
  // a change that only wrote the row would leave every open tab stale until a reload.
  //
  // Since rockysurf-1c8z no report reaching here can promote to `running` — `toProvisioningStep`
  // refuses those, and `markBootstrapReady` broadcasts its own. This stays because it is about
  // any status change, not that one, and the alternative is a broadcast that exists only for a
  // case somebody has to remember is impossible.
  if (updated && updated.status !== row.status) {
    void deps.events.broadcastToUser(row.userId, serverStatusEvent(updated))
  }
}
