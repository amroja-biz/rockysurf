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

export { azureConfigSchema, resolveSshCidr, type AzureProviderConfig } from './config.js'

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
}

export default azureProviderFactory
