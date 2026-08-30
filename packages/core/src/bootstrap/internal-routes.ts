import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { consumePlanToken, retirePlanToken, verifyCallbackToken } from '../db/repositories/bootstrap-tokens.js'
import { getServer, recordProgress, setManagedSshKeyRetired } from '../db/repositories/servers.js'
import type { ProvisioningStep, ServerRow } from '../db/schema.js'
import { InvalidProvisioningStepError } from '../db/transitions.js'
import { badRequest, failure, notFound, success, unauthorized } from '../http/responses.js'
import { validate } from '../http/validate.js'
import type { BootstrapOnFailure } from '../config/schema.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { SecretsStore } from '../secrets/store.js'
import type { EventsService } from '../services/events.js'
import { retireManagedUserKey } from '../ssh/server-keys.js'
import { parseInstallPlan } from './plan.js'
import { bootstrapProgressEvent, serverStatusEvent } from './progress-event.js'
import { failBootstrap, labelSourcesFor, recordWarnings } from './failure.js'
import { explainStep } from './failure-report.js'

/**
 * The box-facing routes. Callback mode only.
 *
 * These are the ONLY routes in core a machine talks to without a session, so the rules are
 * tighter than anywhere else:
 *
 *  - authentication is a per-server token, compared in constant time, hashed at rest;
 *  - the status token and the plan token are DIFFERENT credentials with different lifetimes,
 *    and no route that returns anything secret accepts the status token — it lives on the box
 *    for the whole bootstrap and is readable from instance metadata;
 *  - a report from a superseded run is recorded and acknowledged, but MUST NOT move the row
 *    (conformance item 4). Without that rule a re-push reads the previous run's terminal
 *    status and reports success before the agent has started.
 *
 * The state machine itself is NOT re-derived here. `db/transitions.ts` is the verbatim port of
 * the legacy Lambda backend's status-update handler and carries its own tests; this file is
 * transport, authentication and persistence around it.
 *
 * Mounted under `/internal`, which the session middleware deliberately does not cover.
 */

export interface InternalRoutesDeps {
  db: Db
  events: EventsService
  /**
   * Reads the decrypted per-server secrets the agent needs. Injected rather than imported so
   * this file never reaches into the secret store itself, and so a deployment that has no
   * secrets to hand out can pass nothing.
   */
  loadServerSecrets?: (server: ServerRow) => Promise<Record<string, string>>
  /**
   * Retires core's own managed key once a supplied-key box's bootstrap finishes (ADR-0008,
   * issue #92) — the callback-mode counterpart to `supervisor.ts`'s push-mode trigger. Optional
   * for the same reason `loadServerSecrets` is: a deployment with no secrets store to reach into
   * simply never retires anything, the same as it never had key material to serve in the first
   * place.
   */
  secrets?: SecretsStore
  /**
   * What a failed tool install does to the machine (ADR-0010). The registry is what lets this
   * route release an instance the same way the ticker does for push mode; without it — a
   * deployment with no providers wired — a failure is recorded and the machine is left alone.
   */
  registry?: Pick<ProviderRegistry, 'get' | 'has'>
  onFailure?: BootstrapOnFailure
}

const statusBody = z.strictObject({
  /** The display label from the plan's `reports`. */
  step: z.string().min(1),
  token: z.string().min(1),
  /** The plan step id. Present from the agent; labels alone are lossy. */
  stepId: z.string().min(1).optional(),
  /** Which bootstrap attempt this belongs to. A mismatch is recorded, not applied. */
  runId: z.string().min(1).optional(),
  /** The PLAN's status. Stays `running` past an optional step's failure. */
  status: z.enum(['running', 'done', 'failed']).optional(),
  /** The reported STEP's own outcome (ADR-0010) — how a failed optional step is noticed. */
  stepStatus: z.enum(['pending', 'running', 'done', 'failed']).optional(),
  /** The failed step's log tail, from the agent's journal. Bounded by the agent at 60 lines. */
  logTail: z.string().max(64 * 1024).optional(),
  /**
   * The agent's own log, last lines, on a TERMINAL `failed` report only (#168). This is the
   * whole install's narrative — every step's output runs through `agent.log` — and once a
   * failed tool install's machine is released (ADR-0010) this POST is the only copy callback
   * mode ever gets. Bounded by the agent at 200 lines and 64 KiB; the cap here matches, because
   * a report refused whole is a failure core never records.
   */
  agentLog: z.string().max(64 * 1024).optional(),
  publicIp: z.string().min(1).optional(),
  /** Why the current step is waiting, in one line (#129). Shown under the active step. */
  // Room for the retry notice (#205): a tool name, a mirror URL that can run to 120
  // characters, the remedy, the bound and the choice. A report over the cap is refused whole,
  // and a refused report is a notice the user never sees.
  notice: z.string().max(1000).optional(),
})

/** `?token=` for the GETs: a query parameter is what a `curl` in cloud-init can carry. */
const tokenQuery = z.object({ token: z.string().min(1) })

export function createInternalRoutes(deps: InternalRoutesDeps): Hono {
  const { db, events } = deps
  const routes = new Hono()

  /** Absent server and wrong token look identical from outside: both 401, same work. */
  function authenticate(serverId: string, presented: string): ServerRow | undefined {
    const server = getServer(db, serverId)
    if (!server) return undefined
    return verifyCallbackToken(server, presented) ? server : undefined
  }

  /* --------------------------------------------------------------- progress reports */

  routes.post('/internal/servers/:id/status', validate('json', statusBody), async (c) => {
    const body = c.req.valid('json')
    const server = authenticate(c.req.param('id'), body.token)
    if (!server) return unauthorized(c, 'Invalid callback token')

    // The run id filter, before anything else that could move the row. A superseded run's
    // report is real data — it is retained for forensics — but it describes a bootstrap that
    // is no longer the one core is waiting on.
    const currentRunId = currentRunIdOf(server)
    if (body.runId && currentRunId && body.runId !== currentRunId) {
      console.warn(
        `stale report for ${server.id}: runId ${body.runId} is not the current run ${currentRunId}`,
      )
      return c.json({ accepted: false, reason: 'stale_run', runId: currentRunId }, 202)
    }

    // Every rule the legacy handler encoded — step validity, provisioning-only acceptance,
    // `ready` flipping the row to running and stamping startedAt, and first-address-is-not-a-
    // change — lives in `recordProgress`. Re-deriving any of it here would be a second source
    // of truth for a state machine that already has tests.
    let updated: ServerRow | undefined
    try {
      updated = recordProgress(db, server.id, { step: body.step, publicIp: body.publicIp })
    } catch (err) {
      if (err instanceof InvalidProvisioningStepError) return badRequest(c, err.message)
      throw err
    }
    // `undefined` is the ported "not in provisioning state" refusal, not a missing row.
    if (!updated) return badRequest(c, 'Server is not in provisioning state')

    /*
     * THE PLAN FAILED (ADR-0010). Until this, a callback-mode failure was not recorded at all:
     * the row sat in `provisioning` until the 30-minute timeout failed it as "did not complete"
     * — the wrong reason, minutes late, with the machine kept. Now it takes the same path push
     * mode does, from the evidence the agent could send: the step's log tail. Push mode reads
     * the whole file over SSH; callback mode has no channel for that, and `logComplete: false`
     * on the report says so.
     */
    if (body.status === 'failed' && body.stepId) {
      const failed = await failBootstrap(
        {
          db,
          events,
          registry: deps.registry ?? { get: () => { throw new Error('no provider registry') }, has: () => false },
          ...(deps.onFailure ? { onFailure: deps.onFailure } : {}),
        },
        updated,
        {
          failure: explainStep({
            stepId: body.stepId,
            captured: { log: body.logTail ?? '', complete: false },
            // The agent log also carries the step's `FAILED (rc=N)` line — the only place the
            // exit code lives — so the report gains it the same way push mode's does.
            ...(body.agentLog ? { agentLog: body.agentLog } : {}),
            labels: labelSourcesFor(db, updated),
          }),
          // Preserved with the server record (#168): the last ~200 lines of the whole install
          // log, not just the one failed step's tail.
          ...(body.agentLog ? { agentLogTail: body.agentLog } : {}),
        },
      )
      return success(c, { accepted: true, step: body.step, status: failed.status })
    }

    // An OPTIONAL step failed and the plan went on — a repository that did not clone. Noted on
    // the row as it happens, merged by step id, so the box that comes up says what is not on it.
    if (body.stepStatus === 'failed' && body.stepId) {
      recordWarnings({ db }, updated, {
        warnings: [
          explainStep({
            stepId: body.stepId,
            captured: { log: body.logTail ?? '', complete: false },
            labels: labelSourcesFor(db, updated),
          }),
        ],
        mode: 'merge',
      })
    }

    // Bootstrap is over, so the powerful credential goes away. This is what makes "the
    // secrets endpoint stops serving after provisioning completes" a property of the system
    // rather than a check each route has to remember: there is one rule, in one place, and
    // after it runs the plan token authenticates nothing.
    if (updated.status === 'running') retirePlanToken(db, server.id)

    // Callback mode's half of ADR-0008 / issue #92 — the same "row just reached running" point
    // push mode's `markBootstrapReady` caller hooks its trigger onto, but reached from the
    // box's own POST instead of core's SSH poll, because core never opens SSH for a
    // callback-mode bootstrap and so has no drive to hook this onto. The reasoning for why
    // `status === 'running'` alone is sufficient proof the removal step succeeded — the plan's
    // last step is REQUIRED, not optional, so a plan that reached `running` reached it through
    // that step — lives in `resolver.ts`'s `suppliedKeyOnlyScript`.
    if (updated.status === 'running' && server.userSuppliedPublicKey && deps.secrets) {
      try {
        retireManagedUserKey(deps.secrets, server.id)
        setManagedSshKeyRetired(db, server.id)
      } catch (err) {
        // The box is fully installed and already promoted; a failure here must not turn a
        // working box into a failed one. Logged so an operator can still notice a generated
        // key that outlived its purpose.
        console.error(`could not retire the managed key for ${server.id}: ${String(err)}`)
      }
    }

    // `bootstrap-progress`, the same type push mode emits, because it IS the same event — one
    // bootstrap step moved — and the SPA should not have to know which topology delivered it.
    // This was `server.progress` until the client was written and the divergence became
    // visible; dot-separated was also the odd one out across every other event core sends.
    //
    // Built through the shared constructor since rockysurf-xinr: "the same event" was a
    // comment rather than a fact, and push mode was filling `step` with something else.
    // `body.step` is a provisioning step by now — `recordProgress` refused it otherwise.
    await events.broadcastToUser(
      server.userId,
      bootstrapProgressEvent({
        serverId: server.id,
        step: body.step as ProvisioningStep,
        ...(body.stepId ? { stepId: body.stepId } : {}),
        status: updated.status,
        publicIp: updated.publicIp,
        ...(body.notice ? { notice: body.notice } : {}),
      }),
    )

    // The report that promotes the row announces the promotion, in the event type the SPA
    // reads statuses from. The plan's last step reports `ready`, so without this a box that
    // finished bootstrapping stayed "Provisioning" in every open tab until a reload.
    if (updated.status !== server.status) {
      await events.broadcastToUser(server.userId, serverStatusEvent(updated))
    }

    return success(c, { accepted: true, step: body.step, status: updated.status })
  })

  /* ------------------------------------------------------------------- plan delivery */

  routes.get('/internal/servers/:id/plan', validate('query', tokenQuery), (c) => {
    const outcome = spendPlanToken(c.req.param('id'), c.req.valid('query').token)
    if ('response' in outcome) return outcome.response(c)

    if (!outcome.server.installPlan) return notFound(c, 'No install plan has been snapshotted')
    // Parsed rather than passed through, so a corrupt snapshot fails here with a field path
    // instead of on the box with a jq error.
    return success(c, parseInstallPlan(outcome.server.installPlan))
  })

  /* ---------------------------------------------------------------- secrets delivery */

  /**
   * SANCTIONED SECRET HANDOVER. This route returns decrypted material — the git token and the
   * remote-desktop password the agent needs — and is listed in the custody test's exemption
   * list for that reason.
   *
   * What earns the exemption: it authenticates with the short-lived, budgeted PLAN token
   * rather than the long-lived status token; it serves only the secrets belonging to the one
   * server named in the path; it stops working the moment the plan token expires or is
   * retired, which happens when provisioning completes; and every use after the first is
   * recorded on the row as a leak signal.
   */
  routes.get('/internal/servers/:id/secrets', validate('query', tokenQuery), async (c) => {
    const outcome = spendPlanToken(c.req.param('id'), c.req.valid('query').token)
    if ('response' in outcome) return outcome.response(c)

    const secrets = deps.loadServerSecrets ? await deps.loadServerSecrets(outcome.server) : {}
    // `no-store` because this body is the most sensitive thing core ever emits.
    c.header('cache-control', 'no-store')
    return success(c, { secrets })
  })

  /** Shared by the two token-gated GETs so the failure vocabulary cannot drift between them. */
  function spendPlanToken(
    serverId: string,
    presented: string,
  ): { server: ServerRow } | { response: (c: Parameters<typeof unauthorized>[0]) => Response } {
    const server = getServer(db, serverId)
    if (!server) return { response: (c) => unauthorized(c, 'Invalid plan token') }

    const outcome = consumePlanToken(db, server, presented)
    if (!outcome.ok) {
      if (outcome.reason === 'invalid') return { response: (c) => unauthorized(c, 'Invalid plan token') }
      // 410 rather than 401: the credential was real and is now gone. The box's retry rule is
      // never to replay a 4xx, so this ends the attempt rather than looping.
      const message = outcome.reason === 'expired' ? 'Plan token has expired' : 'Plan token budget is exhausted'
      return { response: (c) => failure(c, 'not_found', message) }
    }
    if (outcome.replay) {
      console.warn(`plan token for ${server.id} used ${outcome.uses} times — treat as leaked`)
    }
    return { server }
  }

  return routes
}

/**
 * The run id core is currently waiting on, read from the snapshotted plan.
 *
 * It lives in the plan rather than in its own column because the plan is what was handed to
 * the box: if the two ever disagreed, the box's copy would be the truth and the column would
 * be a second source of it.
 */
function currentRunIdOf(server: ServerRow): string | undefined {
  if (!server.installPlan) return undefined
  try {
    return parseInstallPlan(server.installPlan).runId
  } catch {
    return undefined
  }
}
