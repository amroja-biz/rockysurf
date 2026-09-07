import { Hono } from 'hono'
import { isProviderError, type ProviderErrorCode } from '@rockysurf/provider-sdk'
import type { AppEnv } from '../app.js'
import { forbidden, success } from '../http/responses.js'
import type { ProviderRegistry } from './registry.js'

/**
 * `/api/v1/providers/credentials/check` — proving a Provider's credentials, on demand (#450).
 *
 * WHAT WAS WRONG. Every Provider implements `validateCredentials()` — the cheapest authenticated
 * call its cloud offers, which also proves the configured region — and nothing in the product
 * called it. Saving Settings → a cloud re-validated the values against the Provider's SCHEMA,
 * wrote the file and rebuilt the registry, so a wrong key, a wrong region or a missing permission
 * first surfaced on the New Server page, after the operator had left Settings.
 *
 * THE SAME MECHANISM AS THE ALLOW-LIST PUSH, deliberately (issue #304, ADR-0021). The settings
 * save names the Providers whose credentials this save may have changed (`credentialCheckNeeded`),
 * the page makes ONE follow-up call, and the per-Provider report lands in the same status block
 * on the Settings page that "SSH access at the cloud" lands in. The reasoning for keeping it out
 * of the save is `network/routes.ts`'s, unchanged and repeated here because it is the reason this
 * file exists rather than a block inside `settings/routes.ts`: a save is local, cheap and atomic,
 * ADR-0017 leans on all three, and a cloud API call inside it would put a file write at the mercy
 * of a network timeout. Here, a cloud that cannot be reached is one row in a report.
 *
 * NEVER FOR A DISABLED PROVIDER. The registry holds only the Providers that are enabled AND
 * loaded, so a disabled section has nothing here to reach; a requested id that is neither loaded
 * nor recorded as unavailable is simply absent from the report. An id that is enabled but did NOT
 * load is reported with the composition root's own reason, which is the same text the New Server
 * page shows for it — the operator asked whether this cloud is set up, and "it did not load" is
 * the honest answer to that question.
 *
 * Admin-only, like every route that reaches a cloud.
 */
export interface ProviderCredentialRoutesDeps {
  /** The live registry — rebuilt in place on a config change (ADR-0017), so this is always current. */
  registry: ProviderRegistry
}

/** One Provider's outcome, as the Settings page renders it. */
export interface CredentialCheckReport {
  /** The Provider's config-section id, which is what the page keys its row on. */
  provider: string
  /** The Provider's own display name, for the row's heading. */
  displayName: string
  status: 'verified' | 'failed'
  /**
   * The nine-code taxonomy (ADR-0003, F1) when the failure was a classified Provider error, so
   * the page can print the same headline the New Server page prints. Absent for anything else —
   * including a Provider that is enabled and did not load, which is not a cloud's answer at all.
   */
  code?: ProviderErrorCode
  /** What the cloud itself said, verbatim, after the nine-code mapping flattened it (F1). */
  providerCode?: string
  /** The Provider's own words. Empty on success — the page writes the verified line itself. */
  detail: string
}

/** The optional request body: which Providers to check. Absent means every loaded one. */
interface CheckRequestBody {
  providers?: readonly string[]
}

/** Read the body if there is one; a plain "check everything" sends none, and that must not error. */
async function readRequestedIds(c: { req: { json: () => Promise<unknown> } }): Promise<string[] | undefined> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return undefined
  }
  const requested = (body as CheckRequestBody | undefined)?.providers
  if (!Array.isArray(requested)) return undefined
  return requested.filter((id): id is string => typeof id === 'string')
}

export function createProviderCredentialRoutes(deps: ProviderCredentialRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  /** Admin, ahead of everything — this route spends an authenticated call at a cloud. */
  routes.use('/api/v1/providers/credentials/*', async (c, next) => {
    if (!c.get('user').isAdmin) return forbidden(c, 'Admin access required')
    await next()
  })

  routes.post('/api/v1/providers/credentials/check', async (c) => {
    const requested = await readRequestedIds(c)
    const loaded = deps.registry.ids()
    const unavailable = new Map(deps.registry.unavailable().map((entry) => [entry.id, entry.reason]))

    /**
     * WHICH PROVIDERS GET DIALLED. With no body, every Provider this process actually built —
     * which is exactly the set that is enabled and loaded. With one, the intersection of what was
     * asked for and what exists, so a request naming a Provider that is switched off produces no
     * row rather than a failure about a cloud nobody turned on.
     */
    const targets = (requested ?? loaded).filter((id) => loaded.includes(id) || unavailable.has(id))

    const checked = await Promise.all(
      targets.map(async (id): Promise<CredentialCheckReport> => {
        const failedToLoad = unavailable.get(id)
        if (failedToLoad !== undefined && !loaded.includes(id)) {
          return {
            provider: id,
            displayName: deps.registry.describe(id)?.displayName ?? id,
            status: 'failed',
            detail: failedToLoad,
          }
        }

        const provider = deps.registry.get(id)
        try {
          await provider.validateCredentials()
          return { provider: id, displayName: provider.displayName, status: 'verified', detail: '' }
        } catch (err) {
          /**
           * ONE CLOUD'S FAILURE IS ONE CLOUD'S FAILURE — `Promise.all` over handlers that each
           * catch their own error rather than `allSettled` over throwing ones, so the report is
           * total by construction, exactly as the sync route builds its own.
           */
          return {
            provider: id,
            displayName: provider.displayName,
            status: 'failed',
            ...(isProviderError(err) ? { code: err.code } : {}),
            ...(isProviderError(err) && err.providerCode ? { providerCode: err.providerCode } : {}),
            detail: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )

    return success(c, { checked })
  })

  return routes
}
