import { isProviderError } from '@rockysurf/provider-sdk'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import { readLive, type Config, type Live } from '../config/index.js'
import { badRequest, conflict, failure, success } from '../http/responses.js'
import { validate } from '../http/validate.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { EnvProvidedCredentialError, type SecretsStore } from '../secrets/index.js'
import { computeSetupState } from './state.js'

/**
 * `/api/v1/setup` — what the first-run wizard reads and writes (rockysurf-hzi7.2).
 *
 * Two routes, both authenticated: the wizard runs AFTER the admin has signed in with the
 * password printed at boot, which is what makes "the wizard verifies login works" true by
 * construction rather than by a separate check.
 *
 * Nothing here branches on a provider id. `POST` validates through
 * `registry.get(id).validateCredentials()`, so a provider that does not exist yet needs no
 * code in this file when it arrives — which is the same rule the rest of core follows.
 */

export interface SetupRoutesDeps {
  /** Read per request since #264, so the wizard reflects a save without a restart. */
  config: Live<Config>
  registry: ProviderRegistry
  /** Absent when core has no encrypted store; the wizard then reports credentials read-only. */
  secrets?: SecretsStore
  env?: NodeJS.ProcessEnv
}

const credentialBody = z.strictObject({
  /** The provider's own credential. Hetzner: an API token. */
  token: z.string().trim().min(1, { error: 'a credential is required' }),
})

export function createSetupRoutes(deps: SetupRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  const state = () =>
    computeSetupState({
      config: readLive(deps.config),
      registry: deps.registry,
      ...(deps.secrets ? { secrets: deps.secrets } : {}),
      ...(deps.env ? { env: deps.env } : {}),
    })

  routes.get('/api/v1/setup', (c) => success(c, state()))

  /**
   * Store a provider credential, after proving it works.
   *
   * ORDER IS THE POINT: validate first, store second. Storing an unverified token would leave
   * an installation that looks configured and fails at the first create, which is exactly the
   * failure the wizard exists to prevent. The provider's own error message is surfaced
   * VERBATIM — `ProviderError` messages already name the cloud's own code, and rewriting them
   * into house prose would throw away the one string that tells a user whether they pasted a
   * read-only token or a wrong one.
   */
  routes.post('/api/v1/setup/providers/:id', validate('json', credentialBody), async (c) => {
    const id = c.req.param('id')
    const { token } = c.req.valid('json')

    const configured = state().providers.find((p) => p.id === id)
    if (!configured) return badRequest(c, `unknown provider: ${id}`)
    if (configured.readOnlyReason) return conflict(c, configured.readOnlyReason)
    if (!deps.secrets) {
      return conflict(c, 'this installation has no encrypted secrets store, so credentials cannot be saved here')
    }

    /**
     * STORE-THEN-VERIFY-ON-RESTART, when the provider is not loaded.
     *
     * A provider is only in the registry once the composition root could build it, and it can
     * only build one that HAS a credential (rockysurf-55fx.12). So on a fresh install the
     * provider a user wants to configure is precisely the one that is not loaded — and
     * refusing here created a deadlock the boot log walked people into, since it tells them to
     * "paste it in the setup wizard".
     *
     * The credential is therefore stored unverified, and the response says so in as many
     * words. Storing something unproven is a real cost, accepted deliberately: the alternative
     * is a wizard that can never configure anything, and the encrypted store is the same place
     * the credential would end up anyway. Restart-after-wizard is the documented v0.1
     * behaviour; when the provider IS loaded — re-entering a token for a working cloud — the
     * credential is still proven before it is written.
     */
    const verifiable = configured.loaded

    if (verifiable) {
      const provider = deps.registry.get(id)
      try {
        await provider.validateCredentials()
      } catch (err) {
        if (isProviderError(err)) {
          // Verbatim, plus the cloud's own code when there is one (amendment F1).
          return failure(c, err.code === 'auth' ? 'unauthorized' : 'bad_request', err.message)
        }
        throw err
      }
    }

    try {
      deps.secrets.putProviderToken(id, token, deps.env)
    } catch (err) {
      // The refuse-persist rule, reached by a race: the env var appeared between the read and
      // the write. Its message already explains itself.
      if (err instanceof EnvProvidedCredentialError) return conflict(c, err.message)
      throw err
    }

    return success(c, {
      ok: true,
      verified: verifiable,
      ...(verifiable
        ? {}
        : {
            message:
              `Saved and encrypted. ${configured.displayName} is not running in this process yet, so the ` +
              'credential could not be checked against the cloud — restart Rocky Surf to load the provider ' +
              'and verify it.',
          }),
      setup: state(),
    })
  })

  return routes
}
