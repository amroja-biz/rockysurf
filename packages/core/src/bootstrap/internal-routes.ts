import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { consumePlanToken, retirePlanToken, verifyCallbackToken } from '../db/repositories/bootstrap-tokens.js'
import { getServer, recordProgress } from '../db/repositories/servers.js'
import type { ServerRow } from '../db/schema.js'
import { InvalidProvisioningStepError } from '../db/transitions.js'
import { badRequest, failure, notFound, success, unauthorized } from '../http/responses.js'
import { validate } from '../http/validate.js'
import type { EventsService } from '../services/events.js'
import { parseInstallPlan } from './plan.js'

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
 * `backend/src/servers/updateServerStatus.ts` and carries its own tests; this file is
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
}

const statusBody = z.strictObject({
  /** The display label from the plan's `reports`. */
  step: z.string().min(1),
  token: z.string().min(1),
  /** The plan step id. Present from the agent; labels alone are lossy. */
  stepId: z.string().min(1).optional(),
  /** Which bootstrap attempt this belongs to. A mismatch is recorded, not applied. */
  runId: z.string().min(1).optional(),
  status: z.enum(['running', 'done', 'failed']).optional(),
  publicIp: z.string().min(1).optional(),
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

    // Bootstrap is over, so the powerful credential goes away. This is what makes "the
    // secrets endpoint stops serving after provisioning completes" a property of the system
    // rather than a check each route has to remember: there is one rule, in one place, and
    // after it runs the plan token authenticates nothing.
    if (updated.status === 'running') retirePlanToken(db, server.id)

    await events.broadcastToUser(server.userId, {
      // `bootstrap-progress`, the same type push mode emits, because it IS the same event —
      // one bootstrap step moved — and the SPA should not have to know which topology
      // delivered it. This was `server.progress` until the client was written and the
      // divergence became visible; dot-separated was also the odd one out across every other
      // event core sends.
      type: 'bootstrap-progress',
      serverId: server.id,
      step: body.step,
      stepId: body.stepId,
      status: updated.status,
      publicIp: updated.publicIp ?? undefined,
    })

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
