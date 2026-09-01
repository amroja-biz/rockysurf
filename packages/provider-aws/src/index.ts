import type { ProviderFactory } from '@rockysurf/provider-sdk'
import { awsConfigSchema, type AwsProviderConfig } from './config.js'
import { makeAwsProvider } from './provider.js'

/**
 * `@rockysurf/provider-aws` — EC2 without CloudFormation.
 *
 * The factory is what core loads: an id, a display name, a config schema, and a synchronous
 * constructor that does no I/O. Credentials are proven by `validateCredentials()`, which core
 * calls when it chooses to — not as a side effect of construction.
 */

export { awsConfigSchema, resolveSshCidrs, type AwsProviderConfig } from './config.js'
export { awsErrorCode, isNotFound, mapAwsError } from './errors.js'
export { buildOfferings, OFFERING_IDS } from './offerings.js'
export { parsePriceFeedDoc, PriceFeedClient, type PriceFeedDoc } from './feed.js'
export { ec2ConsoleUrl, makeAwsProvider, type AwsProviderOptions } from './provider.js'

export const AWS_PROVIDER_ID = 'aws'

/**
 * The zod schema satisfies the SDK's `ConfigSchema<AwsProviderConfig>` structurally, which is
 * how this package gets a real validator while the SDK keeps zero runtime dependencies.
 */
export const awsProviderFactory: ProviderFactory<AwsProviderConfig> = {
  id: AWS_PROVIDER_ID,
  displayName: 'Amazon EC2',
  configSchema: awsConfigSchema,
  createProvider: (config) => makeAwsProvider({ config }),
}

export default awsProviderFactory
