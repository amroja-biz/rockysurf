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
  /**
   * Where the token comes from when the config field is empty (ADR-0026, E18). The same two
   * variables core's `PROVIDER_CREDENTIAL_ENV` has always named — `hcloud`'s own tooling reads the
   * second — so the wizard's detection and the composition's fallback keep agreeing.
   */
  credentialField: 'token',
  credentialEnv: ['HETZNER_TOKEN', 'HCLOUD_TOKEN'],
  /**
   * THE SETTINGS PANEL, DECLARED HERE (ADR-0027). Until this, the same three controls and their
   * sentences were hand-written in core's `settings/fields.ts` and again as a block in the SPA;
   * both are gone, and this is the one place the words live. The prose is the inventory's,
   * moved verbatim — the matchers in the page tests follow it.
   *
   * Hetzner is the first shipped provider to declare, deliberately: it is the token-shaped cloud
   * the `adding-providers` skill tells authors to copy, so it should be the shape they copy.
   */
  settings: {
    title: 'Hetzner',
    help: 'The quickest provider to start with: an API token from console.hetzner.com is the whole setup.',
    fields: [
      {
        name: 'token',
        kind: 'secret',
        label: 'Token Environment Variable',
        example: 'HETZNER_TOKEN',
        help:
          'The NAME of an environment variable holding a read/write API token from console.hetzner.com ' +
          '— `HETZNER_TOKEN`, not the token itself. The token is scoped to one project, which is the ' +
          'project every server created here appears in.',
      },
      {
        name: 'location',
        kind: 'string',
        label: 'Location',
        example: 'fsn1',
        help:
          'Which datacentre new servers are created in: fsn1/nbg1/hel1 (Germany, Finland), ash/hil ' +
          '(US), sin (Singapore). ARM (CAX) types are only sold in fsn1, nbg1 and hel1.',
      },
      {
        name: 'consoleProjectId',
        kind: 'number',
        label: 'Console project id',
        example: '1234567',
        help:
          'Optional, and used only to put a "View in Hetzner Console" link on a server\'s page. The API ' +
          'never reveals the number, so take it from the console address bar: ' +
          'console.hetzner.com/projects/1234567/servers. Leave it out and servers simply have no link.',
      },
    ],
    offering: { noun: 'server type', example: 'cpx21' },
    advisories: [
      {
        surface: 'create',
        text: 'ARM (CAX) server types are sold only in fsn1, nbg1 and hel1, and stock varies by the hour — a sold-out type is listed and marked unavailable rather than hidden.',
      },
    ],
  },
}

export default hetznerProviderFactory
