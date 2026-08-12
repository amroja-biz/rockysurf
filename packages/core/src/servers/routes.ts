import { isProviderError, type ProviderErrorCode } from '@rockysurf/provider-sdk'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import { DEFAULT_SSH_PORT } from '../bootstrap/push.js'
import { InvalidTransitionError } from '../db/transitions.js'
import { LimitExceededError } from '../jobs/limits.js'
import type { ServerRow } from '../db/schema.js'
import { getServerRepositories, getServerTools } from '../db/repositories/servers.js'
import { badRequest, created, notFound, success } from '../http/responses.js'
import {
  ConflictError,
  ServerNotFoundError,
  UnsupportedOperationError,
  type LifecycleService,
} from './lifecycle.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { Context } from 'hono'

/**
 * `/api/v1/servers` — the routes `frontend/src/lib/api.ts` already calls.
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
  rdpPassword: z.string().optional(),
})

export interface ServerRoutesDeps {
  lifecycle: LifecycleService
  registry: ProviderRegistry
  /** Default provider when the request does not name one. */
  defaultProvider?: string
}

/** The row as the SPA expects to see it. Legacy field names, no internal columns. */
function present(row: ServerRow) {
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
    repositories: getServerRepositories(row),
    sshUser: row.sshUser,
    // Absent when it is 22, so every existing client keeps rendering `ssh user@host` unchanged
    // and only a host that really is somewhere else grows a `-p` (ADR-0003, E13).
    sshPort: row.sshPort && row.sshPort !== DEFAULT_SSH_PORT ? row.sshPort : undefined,
    bootstrapMode: row.bootstrapMode,
    hourlyCost:
      row.hourlyCostAmount === null
        ? undefined
        : { amount: row.hourlyCostAmount, currency: row.hourlyCostCurrency, fetchedAt: row.hourlyCostFetchedAt },
    totalUptimeSeconds: row.totalUptimeSeconds,
    estimatedTotalCost: row.estimatedTotalCost,
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
 * The envelope mirrors `http/responses.ts` exactly — `{ error, code }` — because
 * `frontend/src/lib/api.ts` reads `error` and hands the whole body to `ApiError`. It is built
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
      return success(c, (await lifecycle.list(c.get('user').id)).map(present))
    } catch (err) {
      return fail(c, err)
    }
  })

  routes.post('/api/v1/servers', zValidator('json', createBody), async (c) => {
    const body = c.req.valid('json')
    const user = c.get('user')

    const providerId = body.provider ?? deps.defaultProvider ?? registry.ids()[0]
    if (!providerId) return badRequest(c, 'no compute provider is configured')

    let provider
    try {
      provider = registry.get(providerId)
    } catch (err) {
      return fail(c, err)
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
        // A retried POST carrying the same key returns the original server and provisions
        // nothing — the standard header, so a client can be safe without inventing a scheme.
        ...(c.req.header('idempotency-key') ? { idempotencyKey: c.req.header('idempotency-key')! } : {}),
      })
      return created(c, present(row))
    } catch (err) {
      return fail(c, err)
    }
  })

  routes.get('/api/v1/servers/:serverId', async (c) => {
    try {
      return success(c, present(await lifecycle.get(c.get('user').id, c.req.param('serverId'))))
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
        return success(c, present(await lifecycle[action](c.get('user').id, c.req.param('serverId'))))
      } catch (err) {
        return fail(c, err)
      }
    })
  }

  return routes
}
