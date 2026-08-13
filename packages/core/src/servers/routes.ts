import { isProviderError, type ProviderErrorCode } from '@rockysurf/provider-sdk'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import { DEFAULT_SSH_PORT } from '../bootstrap/push.js'
import { InvalidTransitionError } from '../db/transitions.js'
import { LimitExceededError } from '../jobs/limits.js'
import type { ServerRow } from '../db/schema.js'
import { getServerRepositories, getServerTools, isBillingRow } from '../db/repositories/servers.js'
import { badRequest, created, notFound, success } from '../http/responses.js'
import { validate } from '../http/validate.js'
import type { IndexedRefusal } from '../git/preflight.js'
import {
  ConflictError,
  ServerNotFoundError,
  UnsupportedOperationError,
  type LifecycleService,
} from './lifecycle.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { Context } from 'hono'

/**
 * `/api/v1/servers` — the routes the SPA's API client (`packages/web/src/lib/api.ts`) already calls.
 *
 * The paths and response shapes are held to what the SPA expects (`createServer`, `getServers`,
 * `getServer`, `startServer`, `stopServer`, `terminateServer`), so the 4d port stays mechanical.
 * `spotInstance` is accepted and ignored: spot is cut from v0.1, and rejecting a field the
 * existing client still sends would break it for no gain.
 */

/**
 * ProviderError code → HTTP status.
 *
 * The distinction that matters here is WHOSE fault it is, because that decides whether the
 * caller should change the request, wait, or call an operator:
 *
 *  - `invalid_spec` and `not_found` are the caller's request → 4xx.
 *  - `quota` and `conflict` are a state conflict the caller can act on → 409.
 *  - `rate_limited` → 429, and `capacity` → 503, both retryable and both with meaning to a
 *    client that backs off.
 *  - `auth` is THIS INSTALLATION'S credentials being wrong, not the caller's → 500. A 401
 *    here would tell the user to log in again, which would not help at all.
 *  - `network` → 504 and `unknown` → 502: the upstream cloud failed or answered
 *    incomprehensibly. Both are gateway-shaped, because that is exactly what core is here.
 */
const PROVIDER_ERROR_STATUS: Record<ProviderErrorCode, ContentfulStatusCode> = {
  invalid_spec: 400,
  not_found: 404,
  conflict: 409,
  quota: 409,
  rate_limited: 429,
  capacity: 503,
  auth: 500,
  network: 504,
  unknown: 502,
}

/**
 * An operation the provider's capabilities forbid → **501 Not Implemented**.
 *
 * Chosen over 409 deliberately, and worth stating because the SDK routes it through
 * `ProviderError('invalid_spec')`, which would otherwise land on 400. It is not a conflict
 * with the resource's current state — a BYO host is not "temporarily un-stoppable", it can
 * never be stopped — and it is not a malformed request, because asking a provider to stop is
 * perfectly well-formed. 501 is the status for "this server does not support the
 * functionality required", which is precisely the case.
 */
const UNSUPPORTED_STATUS: ContentfulStatusCode = 501

const createBody = z.object({
  name: z.string().trim().min(1).max(63).optional(),
  size: z.enum(['small', 'medium', 'large']),
  provider: z.string().trim().min(1).optional(),
  offeringId: z.string().trim().min(1).optional(),
  arch: z.enum(['amd64', 'arm64']).optional(),
  packId: z.string().trim().min(1).optional(),
  tools: z.array(z.string()).optional(),
  repositories: z.array(z.string()).optional(),
  /** Accepted and ignored — spot is cut from v0.1. The existing SPA still sends it. */
  spotInstance: z.boolean().optional(),
  sshPublicKey: z.string().optional(),
  /**
   * The remote-desktop password for a `requiresRdp` pack, set on the box's `rocky` account.
   *
   * MINIMUM LENGTH IS ENFORCED HERE, not only in the SPA (rockysurf-z0wf). The form has
   * always required eight characters; the API accepted anything and — until this bead —
   * dropped it, so the one place a short value could be refused was the one place a
   * non-browser caller never reaches. A value this route accepts is a value that ends up
   * authenticating a desktop session.
   */
  rdpPassword: z.string().min(8).optional(),
  /**
   * Create even though a repository URL failed its preflight (rockysurf-k6xp).
   *
   * REFUSE BY DEFAULT, override on request — decided that way rather than warn-by-default
   * because the cost of the two mistakes is not symmetric. A wrongly-refused create costs one
   * checkbox; a wrongly-allowed one costs a full boot, a full bootstrap, and a failed box that
   * goes on billing until somebody notices (which is 4byx, and the reason this bead exists).
   *
   * It is an explicit field rather than an absent check, because the honest limits of the
   * preflight are real: a forge behind a flaky network, a token core cannot predict the box
   * will actually use, a host that answers discovery differently. Every one of those is a case
   * where the user knows better than the check does, and none of them should mean "you cannot
   * create this server".
   */
  createAnyway: z.boolean().optional(),
})

export interface ServerRoutesDeps {
  lifecycle: LifecycleService
  registry: ProviderRegistry
  /** Default provider when the request does not name one. */
  defaultProvider?: string
  /**
   * Check each repository URL before an instance is launched (rockysurf-k6xp).
   *
   * IN THE ROUTE, so the SPA, the CLI and the MCP server are covered by construction rather
   * than by three callers each remembering — the same reason `priceOffering` lives in the
   * lifecycle rather than here. Optional so a core built without git configuration, and every
   * test that does not care, simply does not check.
   */
  preflightRepositories?: (urls: readonly string[]) => Promise<IndexedRefusal[]>
  /**
   * The scope IDENTITIES a box built for these repositories carries (rockysurf-18lq).
   *
   * Injected for the same reason `preflightRepositories` is: the answer depends on the config
   * file, and the route must not grow a dependency on it. Optional, so a core built without git
   * configuration says nothing rather than saying "none" — which are different claims.
   */
  githubTokenScopes?: (repositories: readonly string[]) => string[]
  /** Whether the instance-wide `github.pat` — which every box carries — is configured at all. */
  carriesFallbackToken?: boolean
}

/** The row as the SPA expects to see it. Legacy field names, no internal columns. */
function present(row: ServerRow, deps: ServerRoutesDeps) {
  const repos = getServerRepositories(row)
  return {
    serverId: row.id,
    name: row.name,
    provider: row.provider,
    size: row.size,
    offeringId: row.offeringId,
    arch: row.arch,
    status: row.status,
    provisioningStep: row.provisioningStep ?? undefined,
    publicIp: row.publicIp ?? undefined,
    publicDns: row.publicDns ?? undefined,
    previousIp: row.previousIp ?? undefined,
    ipChangedAt: row.ipChangedAt ?? undefined,
    packId: row.packId ?? undefined,
    tools: getServerTools(row),
    repositories: repos,
    /**
     * WHICH GIT TOKENS THIS BOX HOLDS, by scope, never by value (rockysurf-18lq).
     *
     * A box no longer receives every configured token — only the ones its declared repositories
     * selected — so "which of them did this one get" became a question with an answer worth
     * showing. It is also the honest place to state the cost of narrowing: a repository cloned
     * by hand later, that nobody declared here, gets whatever the fallback covers and nothing
     * else.
     *
     * Absent (rather than `[]`) when core has no git configuration to answer from, because
     * "this installation configures no tokens" and "this box was given none of them" are
     * different facts and a page that showed them identically would be guessing on the reader's
     * behalf.
     */
    githubTokenScopes: deps.githubTokenScopes?.(repos),
    carriesFallbackToken: deps.carriesFallbackToken,
    sshUser: row.sshUser,
    // Absent when it is 22, so every existing client keeps rendering `ssh user@host` unchanged
    // and only a host that really is somewhere else grows a `-p` (ADR-0003, E13).
    sshPort: row.sshPort && row.sshPort !== DEFAULT_SSH_PORT ? row.sshPort : undefined,
    // Absent unless the provider reported one, which is the only way core ever gets a console
    // URL — it does not know what any provider's console looks like (ADR-0003, E16).
    consoleUrl: row.consoleUrl ?? undefined,
    bootstrapMode: row.bootstrapMode,
    hourlyCost:
      row.hourlyCostAmount === null
        ? undefined
        : { amount: row.hourlyCostAmount, currency: row.hourlyCostCurrency, fetchedAt: row.hourlyCostFetchedAt },
    totalUptimeSeconds: row.totalUptimeSeconds,
    estimatedTotalCost: row.estimatedTotalCost,
    /**
     * Present only when the machine is metering and the STATUS does not say so (rockysurf-4byx).
     *
     * Computed here rather than left to each client to derive from `providerState`, so the SPA,
     * the CLI and the MCP server cannot disagree about which provider states count as billing —
     * and so the honesty is a property of the API rather than of three front ends each
     * remembering. Absent on a plain `running` row, where `status` already tells the whole
     * truth and a second billing notice would be noise.
     *
     * `since` is when core CONFIRMED the machine was billing, not when it started — see the
     * column's own comment. A client showing a cost beside this should say so.
     */
    billing:
      isBillingRow(row) && row.status !== 'running'
        ? {
            live: true as const,
            providerState: row.providerState ?? undefined,
            since: row.billingSince ?? undefined,
            confirmedAt: row.providerStateAt ?? undefined,
          }
        : undefined,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    stoppedAt: row.stoppedAt ?? undefined,
    terminatedAt: row.terminatedAt ?? undefined,
  }
}

/**
 * Turn a thrown lifecycle or provider error into the response envelope.
 *
 * The envelope mirrors `http/responses.ts` exactly — `{ error, code }` — because the SPA's
 * API client (`packages/web/src/lib/api.ts`) reads `error` and hands the whole body to `ApiError`. It is built
 * here rather than through those helpers only because the statuses this needs (501, 502, 503,
 * 504) are outside that module's fixed table.
 */
function fail(c: Context, err: unknown) {
  if (err instanceof ServerNotFoundError) return notFound(c, 'Server not found')
  // A configured limit refused the request (rockysurf-55fx.6). 403 rather than 429: the
  // caller is not being throttled for going too fast, they are being told this installation
  // will not do it. `reason` lets the UI say WHICH limit without parsing prose.
  if (err instanceof LimitExceededError) {
    return c.json({ error: err.message, code: 'limit_exceeded', reason: err.reason, ...err.detail }, 403)
  }
  if (err instanceof UnsupportedOperationError) {
    return c.json({ error: err.message, code: 'unsupported_operation' }, UNSUPPORTED_STATUS)
  }
  if (err instanceof ConflictError || err instanceof InvalidTransitionError) {
    return c.json({ error: err.message, code: 'conflict' }, 409)
  }
  if (isProviderError(err)) {
    const status = PROVIDER_ERROR_STATUS[err.code]
    return c.json(
      {
        error: err.message,
        code: err.code,
        // What the cloud actually said, after the nine-code mapping flattened it (F1).
        ...(err.providerCode ? { providerCode: err.providerCode } : {}),
        retryable: err.retryable,
      },
      status,
    )
  }
  throw err // genuinely unexpected: let the app's onError log it as a 500
}

export function createServerRoutes(deps: ServerRoutesDeps): Hono<AppEnv> {
  const { lifecycle, registry } = deps
  const routes = new Hono<AppEnv>()

  /**
   * Providers, their capabilities, and what they can sell.
   *
   * The offerings ride along rather than living at their own endpoint because the create page
   * needs both together — it has to resolve a t-shirt size to a CONCRETE offering and show its
   * price before the user submits, and splitting that across two requests only creates a
   * window where the page knows one and not the other.
   *
   * A provider whose `listOfferings()` fails does not fail the whole response: the others are
   * still usable, and the failed one arrives with an empty list and an `offeringsError` the UI
   * can show. One cloud having a bad day should not make the create page unusable for the
   * other.
   */
  routes.get('/api/v1/providers', async (c) => {
    const providers = await Promise.all(
      registry.list().map(async (p) => {
        try {
          return {
            id: p.id,
            displayName: p.displayName,
            capabilities: p.capabilities,
            offerings: await p.listOfferings(),
          }
        } catch (err) {
          return {
            id: p.id,
            displayName: p.displayName,
            capabilities: p.capabilities,
            offerings: [],
            offeringsError: isProviderError(err) ? err.message : String(err),
          }
        }
      }),
    )
    return success(c, providers)
  })

  routes.get('/api/v1/servers', async (c) => {
    try {
      return success(c, (await lifecycle.list(c.get('user').id)).map((row) => present(row, deps)))
    } catch (err) {
      return fail(c, err)
    }
  })

  /*
   * `validate`, not the bare `zValidator` this route used to call (rockysurf-k6xp).
   *
   * It was the only non-test site in core still using the raw validator, so a schema failure
   * here came back as `@hono/zod-validator`'s own `{success:false, error:{name,message}}` —
   * an OBJECT where every client reads a string. The SPA rendered "API Error: 400 Bad
   * Request", and the CLI and the MCP server both printed `[object Object]`, because
   * `CoreApiError` passes `body.error` to `super()`. This bead adds a field-level refusal to
   * this very route, so the envelope it lands in had to be the one the clients can read.
   */
  routes.post('/api/v1/servers', validate('json', createBody), async (c) => {
    const body = c.req.valid('json')
    const user = c.get('user')

    /**
     * WHICH CLOUD THIS SERVER LANDS ON, and why there is no silent fallback (rockysurf-va2l).
     *
     * The old rule ended in `registry.ids()[0]`, so a request that named no provider on a
     * two-cloud installation was created on whichever one composition happened to build first
     * — a spend decision settled by the order of a table in `compose.ts`. Registration order
     * is not consent.
     *
     * So: an explicit `provider` wins, then a configured default, then the only provider there
     * is. Past that the request is genuinely ambiguous and is refused, naming the ids the
     * caller may choose from — actionable for the SPA, the CLI's `--provider` and the MCP
     * tool's `provider`, all of which can name one.
     */
    const ids = registry.ids()
    const providerId = body.provider ?? deps.defaultProvider ?? (ids.length === 1 ? ids[0] : undefined)
    if (!providerId) {
      if (ids.length === 0) return badRequest(c, 'no compute provider is configured')
      return badRequest(
        c,
        `more than one provider is configured, so which one to create on is not implied: name it in "provider". Configured: ${ids.join(', ')}`,
      )
    }

    let provider
    try {
      provider = registry.get(providerId)
    } catch (err) {
      return fail(c, err)
    }

    /**
     * The repository preflight, BEFORE the offering lookup and long before the provider is
     * asked for a machine (rockysurf-k6xp).
     *
     * Placed here for the reason `checkLimits` is placed where it is: this is the last point at
     * which a refusal leaves nothing behind. A URL typo used to be discovered at the clone
     * step, which is nearly the last thing a bootstrap does — after a boot, after cloud-init,
     * after every tool in the pack — and the box that discovered it kept running and kept
     * billing (4byx). kvkr's doctrine, applied to repositories: fail before the money.
     *
     * The refusal is field-level, names every bad URL rather than the first, and carries the
     * override in its own message so the way out is where the problem is.
     */
    if (deps.preflightRepositories && body.repositories?.length && !body.createAnyway) {
      const refusals = await deps.preflightRepositories(body.repositories)
      if (refusals.length > 0) {
        return badRequest(
          c,
          refusals.length === 1
            ? `${refusals[0]!.reason} Create it anyway by sending "createAnyway": true.`
            : `${refusals.length} of the repositories could not be opened. Create anyway by sending "createAnyway": true.`,
          // The path is into the request body, so a form can put each message on its own field
          // rather than dumping the lot into one banner.
          refusals.map((refusal) => ({ path: `repositories.${refusal.index}`, message: refusal.reason })),
        )
      }
    }

    // Resolve the offering when the caller gave a size rather than a native id. Full t-shirt
    // resolution (and the arch-unavailable fallback) is deliberately out of scope here — see
    // ADR-0003's "deliberately unresolved". This picks the cheapest AVAILABLE offering,
    // which is what `Offering.available` was added for.
    let offeringId = body.offeringId
    let arch = body.arch
    if (!offeringId || !arch) {
      const offerings = (await provider.listOfferings()).filter((o) => o.available)
      const chosen = offerings.sort((a, b) => (a.hourly?.amount ?? Infinity) - (b.hourly?.amount ?? Infinity))[0]
      if (!chosen) {
        return c.json({ error: `provider ${providerId} has no available offerings right now`, code: 'capacity' }, 503)
      }
      offeringId ??= chosen.id
      arch ??= chosen.arch
    }

    try {
      const row = await lifecycle.create({
        userId: user.id,
        name: body.name ?? `server-${Date.now().toString(36)}`,
        provider: providerId,
        size: body.size,
        offeringId,
        arch,
        ...(body.packId ? { packId: body.packId } : {}),
        ...(body.tools ? { tools: body.tools } : {}),
        ...(body.repositories ? { repositories: body.repositories } : {}),
        /**
         * THE TWO CREDENTIALS THE BODY CARRIES, which this call used to leave behind
         * (rockysurf-z0wf). Both fields were declared on `createBody`, validated, and then
         * never named again: `lifecycle.create` has taken an `sshPublicKey` since it was
         * written and gained `rdpPassword` with this bead, and neither was spread in here.
         *
         * The RDP one is what the bug reproduced from. The user typed a password into the
         * form, core dropped it, `secretsStore.getRdpPassword` therefore found nothing,
         * `secrets.env` omitted `RDP_PASSWORD` (correctly — an empty value would be worse),
         * and the plan's `rdp` step refused to run. The box came up with `rocky`'s shadow
         * field still holding cloud-init's `!`, so xrdp's sesman connected and PAM refused
         * every password there was to type.
         *
         * The SSH one failed more quietly and is the same defect in the same object literal:
         * a user who pasted their own public key got a box authorized for core's key alone,
         * which still works — through the SPA's key download — so nothing looked broken.
         */
        ...(body.sshPublicKey ? { sshPublicKey: body.sshPublicKey } : {}),
        ...(body.rdpPassword ? { rdpPassword: body.rdpPassword } : {}),
        // A retried POST carrying the same key returns the original server and provisions
        // nothing — the standard header, so a client can be safe without inventing a scheme.
        ...(c.req.header('idempotency-key') ? { idempotencyKey: c.req.header('idempotency-key')! } : {}),
      })
      return created(c, present(row, deps))
    } catch (err) {
      return fail(c, err)
    }
  })

  routes.get('/api/v1/servers/:serverId', async (c) => {
    try {
      return success(c, present(await lifecycle.get(c.get('user').id, c.req.param('serverId')), deps))
    } catch (err) {
      return fail(c, err)
    }
  })

  for (const [path, action] of [
    ['start', 'start'],
    ['stop', 'stop'],
    ['terminate', 'terminate'],
  ] as const) {
    routes.post(`/api/v1/servers/:serverId/${path}`, async (c) => {
      try {
        return success(c, present(await lifecycle[action](c.get('user').id, c.req.param('serverId')), deps))
      } catch (err) {
        return fail(c, err)
      }
    })
  }

  return routes
}
