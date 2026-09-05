/**
 * `@rockysurf/provider-azure` — Microsoft Azure compute, as plain ARM REST calls.
 *
 * The third cloud, and the first written from the FROZEN SDK rather than from the de-risking
 * spike — which makes it the freeze's first real test. It needed no amendment: ADR-0003's shape
 * absorbed a cloud whose instances are four resources rather than one, whose idempotency
 * primitive is a resource name rather than a token, and whose credentials come from four
 * different places, without a new field.
 *
 * Two decisions this package exists to record, both argued where they are implemented:
 *
 *  - **No vendor SDK.** Plain `fetch` against the documented ARM REST API, the same bet
 *    `@rockysurf/provider-hetzner` makes. MEASURED RATHER THAN ASSUMED, because a dependency
 *    ruling asserted from taste is one nobody can check — unpacked sizes from the registry on
 *    2026-08-13:
 *
 *      @azure/arm-network   43.0 MB      @azure/identity       3.5 MB
 *      @azure/arm-compute   19.5 MB      @azure/msal-node      2.4 MB (via identity)
 *      @azure/arm-resources  1.9 MB      @azure/core-*         1.1 MB+ (via both)
 *
 *    The four direct packages alone are ~68 MB before their own trees, in a package `npx
 *    rockysurf` installs on every cold start, and `scripts/check-npx-closure.mjs` exists because
 *    the AWS SDK is already the heaviest thing this project ships.
 *
 *    THIS PACKAGE'S ENTIRE PRODUCTION CLOSURE IS TWO ENTRIES: `@rockysurf/provider-sdk`, which
 *    has zero runtime dependencies by acceptance criterion, and `zod`, which core and both other
 *    cloud providers already pull in. So it introduces no new third-party package at all.
 *
 *    The cost is that this package implements the token flow itself and does not inherit
 *    `DefaultAzureCredential`'s full chain; see `credentials.ts`, which says so plainly rather
 *    than implying parity.
 *  - **One shared resource group, not one per server.** A group per server would make
 *    `terminate()` atomic, and it would also force the published least-privilege role to be
 *    granted at SUBSCRIPTION scope with permission to delete any resource group in the
 *    account. `deleteOption: 'Delete'` buys the same atomicity for a role scoped to one group;
 *    see `config.ts`.
 */

import type { ProviderFactory } from '@rockysurf/provider-sdk'
import { azureConfigSchema, type AzureProviderConfig } from './config.js'
import { AZURE_PROVIDER_ID, makeAzureProvider } from './provider.js'

export { API_VERSIONS, ARM_BASE, ArmApi, resourceGroupPath, resourcePath, type ArmApiOptions } from './api.js'

export { azureConfigSchema, resolveSshCidrs, type AzureProviderConfig } from './config.js'

export {
  ARM_RESOURCE,
  ARM_SCOPE,
  CredentialChain,
  ENTRA_AUTHORITY,
  IMDS_TOKEN_URL,
  JWT_BEARER_ASSERTION_TYPE,
  type AccessToken,
  type CredentialChainOptions,
  type CredentialSource,
} from './credentials.js'

export { armErrorCode, armErrorMessage, azureCodeOf, isNotFound, RETRY_ANYWAY, toProviderError } from './errors.js'

export {
  architectureFromName,
  architectureOf,
  AZURE_SIZES,
  buildOfferings,
  isAvailable,
} from './offerings.js'

export { parsePriceFeedDoc, PriceFeedClient, type PriceFeedDoc } from './feed.js'

export {
  asAzureData,
  azurePortalUrl,
  AZURE_PROVIDER_ID,
  instanceStateOf,
  makeAzureProvider,
  powerStateOf,
  vmNameFrom,
  type AzureData,
  type AzureProviderOptions,
} from './provider.js'

// Conformance assertions live in `@rockysurf/provider-conformance`. They are test-only, so this
// runtime barrel does not re-export them: a provider package should not make its consumers carry
// a test helper.

export type * from './types.js'

/**
 * The package's default export: how to describe, validate and construct this provider.
 *
 * `createProvider` is synchronous and side-effect free — no network, no filesystem, no
 * credential check — so core can load the provider, show its identity, and validate its
 * configuration before holding a live instance of it. Credentials are proven separately, by
 * `validateCredentials()`, when core chooses to.
 */
export const azureProviderFactory: ProviderFactory<AzureProviderConfig> = {
  id: AZURE_PROVIDER_ID,
  displayName: 'Microsoft Azure',
  configSchema: azureConfigSchema,
  createProvider: (config) => makeAzureProvider({ config }),
  /**
   * THE SETTINGS PANEL, DECLARED HERE (ADR-0027, issue #370). The prose moved verbatim out of
   * core's `settings/fields.ts` and the SPA's hand-written block, both of which are gone.
   *
   * NO CREDENTIAL FIELD, and that is the point. Azure credentials come from the environment, a
   * managed identity or `az login` — there is nowhere in the config file to put a client secret,
   * so there is no box here inviting someone to paste one. `allowAzureCli` is the one Azure field
   * this panel does not offer: it is a trust boundary rather than a setting (docs/providers/azure.md
   * tells an operator to harden a control plane with `allowAzureCli: false`), and narrowing which
   * credential sources a process will accept is a decision made in the file it boots from.
   */
  settings: {
    title: 'Azure',
    help:
      'Virtual machines in one Azure region, in one resource group you create. Credentials come from ' +
      'the environment, a managed identity, or `az login`, so there is no credential to type here.',
    fields: [
      {
        name: 'subscriptionId',
        kind: 'string',
        label: 'Subscription id',
        example: '00000000-0000-0000-0000-000000000000',
        help: 'The Azure subscription every VM, disk, network interface and address is created in.',
      },
      {
        name: 'resourceGroup',
        kind: 'string',
        label: 'Resource group',
        example: 'rocky-surf-rg',
        help:
          'The one resource group Rocky Surf owns. You create it — `az group create --name ' +
          'rocky-surf-rg --location eastus` — because a role cannot be scoped to a group that does not ' +
          'exist yet, and the published Azure role is granted at exactly this group.',
      },
      {
        name: 'location',
        kind: 'string',
        label: 'Location',
        example: 'eastus',
        help: 'Which Azure region new VMs are created in, e.g. eastus.',
      },
      {
        name: 'sshAllowedCidr',
        kind: 'sshCidrList',
        label: 'SSH allowed from',
        example: '203.0.113.7/32',
        help:
          'Which networks may reach SSH on the boxes Azure creates here, as CIDRs — your own address as ' +
          'a /32 is the usual answer, and you can keep several so home and the office both work. ' +
          'Required whenever Azure is enabled, with no default on purpose. Saving pushes the change to ' +
          'Azure straight away; you do not have to launch a server for it to take effect.',
        warning:
          'This is a firewall rule: it decides which networks may reach SSH on every box Azure creates ' +
          'here. Removing a CIDR immediately ends new SSH connections from that network; existing ' +
          'sessions survive.',
      },
    ],
    offering: { noun: 'VM size', example: 'Standard_B2ps_v2' },
    advisories: [
      {
        surface: 'create',
        text: 'The VM sizes with a `p` in them (B2ps_v2, D2ps_v5) are ARM (Ampere) and are the cheap, fast default here.',
      },
    ],
  },
}

export default azureProviderFactory
