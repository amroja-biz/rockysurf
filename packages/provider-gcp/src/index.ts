import type { ProviderFactory } from '@rockysurf/provider-sdk'
import { gcpConfigSchema, type GcpProviderConfig } from './config.js'
import { makeGcpProvider } from './provider.js'

/**
 * `@rockysurf/provider-gcp` — Google Compute Engine over the plain REST API.
 *
 * The factory is what core loads: an id, a display name, a config schema, and a synchronous
 * constructor that does no I/O. Credentials are proven by `validateCredentials()`, which core
 * calls when it chooses to — not as a side effect of construction, and not by reading a key
 * file at boot.
 */

export { GCE_API_BASE, GceApi, lastSegment, type GceApiOptions } from './api.js'
export { COMPUTE_SCOPE, makeAdcTokenSource, type AdcTokenSourceOptions, type TokenSource } from './auth.js'
export { BOOT_DISK_TYPES, gcpConfigSchema, regionOf, resolveSshCidr, type BootDiskType, type GcpProviderConfig } from './config.js'
export { isAlreadyExists, isNotFound, RETRY_ANYWAY, toProviderError } from './errors.js'
export { parsePriceFeedDoc, PriceFeedClient, type PriceFeedDoc } from './feed.js'
export { allowedBootDiskTypes, buildOfferings, familyOf, isAvailableInZone, OFFERING_IDS } from './offerings.js'
export { C4A_ZONES, T2A_ZONES } from './prices.generated.js'
export {
  composeInstanceName,
  gceConsoleUrl,
  GCP_CAPABILITIES,
  GCP_MACHINE_TYPES,
  GCP_STATE_MAP,
  makeGcpProvider,
  requestIdFor,
  type GcpProviderOptions,
} from './provider.js'

export const GCP_PROVIDER_ID = 'gcp'

/**
 * The zod schema satisfies the SDK's `ConfigSchema<GcpProviderConfig>` structurally, which is
 * how this package gets a real validator while the SDK keeps zero runtime dependencies.
 */
export const gcpProviderFactory: ProviderFactory<GcpProviderConfig> = {
  id: GCP_PROVIDER_ID,
  displayName: 'Google Compute Engine',
  configSchema: gcpConfigSchema,
  createProvider: (config) => makeGcpProvider({ config }),
}

export default gcpProviderFactory
