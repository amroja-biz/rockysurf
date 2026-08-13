/**
 * `@rockysurf/provider-hetzner` — Hetzner Cloud compute provider.
 *
 * Ported in Milestone 4b from `spike/src/providers/hetzner.ts`, which ran a full verified
 * lifecycle against the real API (`spike/recordings/hetzner-lifecycle.txt`, 20.3s, zero
 * orphans), onto the frozen SDK (ADR-0003). Plain `fetch` against the documented REST API — no
 * vendor SDK, and therefore no transitive dependency tree to audit or to slow an `npx` cold
 * start.
 *
 * Three behaviours the port preserves, each learned the hard way and each now expressible in
 * the SDK where the spike had to write a comment instead:
 *
 *  - **The server NAME is the idempotency mechanism.** Hetzner has no `ClientToken`
 *    equivalent, so a replayed create is caught as `uniqueness_error` and resolved to the
 *    original server. This is why `ProvisionSpec.serverId` must be hostname-safe: the
 *    sanitizing map would have to be injective, and it cannot be.
 *  - **The create call cannot take raw key material**, so the provider creates first-class SSH
 *    Key objects it then owns and must reap — `ManagedResource.ownership: 'server-owned'`
 *    (D2). Keys matched to something pre-existing are never claimed.
 *  - **`deleting` is `terminating`, not `stopping`** (A3). The spike mapped it to `stopping`,
 *    which the app layer read as `running`; the frozen state machine has somewhere honest to
 *    put it.
 */

export { HetznerApi, HETZNER_API_BASE, type HetznerApiOptions } from './api.js'

export { hetznerConfigSchema, type HetznerProviderConfig, type HetznerProviderInput } from './config.js'

export { hetznerCodeOf, isNotFound, RETRY_ANYWAY, toProviderError } from './errors.js'

export { BUNDLED_PRICES, lookupPrice, type PriceTable } from './prices.js'

export {
  asHetznerData,
  hetznerConsoleUrl,
  HETZNER_PROVIDER_ID,
  makeHetznerProvider,
  sshFingerprint,
  type HetznerData,
} from './provider.js'

// Conformance assertions live in `@rockysurf/provider-conformance` (rockysurf-lw72). They are
// test-only, so this runtime barrel does not re-export them: a provider package should not
// make its consumers carry a test helper.

export type * from './types.js'

import type { ProviderFactory } from '@rockysurf/provider-sdk'
import { hetznerConfigSchema, type HetznerProviderConfig } from './config.js'
import { HETZNER_PROVIDER_ID, makeHetznerProvider } from './provider.js'

/**
 * The package's default export: how to describe, validate and construct this provider.
 *
 * `createProvider` is synchronous and side-effect free — no network, no filesystem, no
 * credential check — so core can load a provider, show its identity, and validate its
 * configuration before holding a live instance of it. Credentials are proven separately, by
 * `validateCredentials()`, when core chooses to.
 */
export const hetznerProviderFactory: ProviderFactory<HetznerProviderConfig> = {
  id: HETZNER_PROVIDER_ID,
  displayName: 'Hetzner Cloud',
  configSchema: hetznerConfigSchema,
  createProvider: (config) => makeHetznerProvider(config),
}

export default hetznerProviderFactory
