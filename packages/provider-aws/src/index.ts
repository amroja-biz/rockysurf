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
export { ec2ConsoleUrl, makeAwsProvider, SSH_RULE_DESCRIPTION, type AwsProviderOptions } from './provider.js'

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
  /**
   * THE SETTINGS PANEL, DECLARED HERE (ADR-0027, issue #370). The prose moved verbatim out of
   * core's `settings/fields.ts` and the SPA's hand-written block, both of which are gone.
   *
   * NO CREDENTIAL FIELD. AWS credentials come from the standard chain — environment, named
   * profile, instance role — and never from the config file, so the only credential-shaped
   * control here is `profile`, which names WHICH set of ambient credentials to use rather than
   * carrying one. That is the "Rocky Surf stores no cloud credentials" rule as a panel.
   *
   * `securityGroupName` is declared even though it never had a hand-written row: the provider has
   * accepted it since it was written and core's schema learned it in issue #343 (after #327
   * pointed the nightly at its own group), so leaving it off the panel would repeat that issue's
   * lesson in the other direction — a field the file accepts and no page shows.
   */
  settings: {
    title: 'AWS',
    help:
      'EC2 instances in one region. Credentials come from the standard AWS chain — environment, ' +
      'named profile, instance role — so there is no credential to type here.',
    fields: [
      {
        name: 'region',
        kind: 'string',
        label: 'Region',
        example: 'us-east-1',
        help: 'Which AWS region new instances are created in.',
      },
      {
        name: 'profile',
        kind: 'string',
        label: 'Profile',
        example: 'default',
        help:
          'A named profile from your shared AWS credentials file. Leave it unset to take whatever the ' +
          'default AWS chain resolves to.',
      },
      {
        name: 'sshAllowedCidr',
        kind: 'sshCidrList',
        label: 'SSH allowed from',
        example: '203.0.113.7/32',
        help:
          'Which networks may reach SSH on the boxes AWS creates here, as CIDRs — your own address as ' +
          'a /32 is the usual answer, and you can keep several so home and the office both work. ' +
          'Required whenever AWS is enabled, with no default on purpose. Saving pushes the change to ' +
          'AWS straight away; you do not have to launch a server for it to take effect.',
        warning:
          'This is a firewall rule: it decides which networks may reach SSH on every box AWS creates ' +
          'here. Removing a CIDR immediately ends new SSH connections from that network; existing ' +
          'sessions survive.',
      },
      {
        name: 'securityGroupName',
        kind: 'string',
        label: 'Security group name',
        example: 'rockysurf-ssh',
        help:
          'The shared SSH security group, one per region, that every box created here joins. Change it ' +
          'to keep two installations in one account off each other\'s firewall rule; the group is ' +
          'created on first use if it does not exist.',
      },
    ],
    offering: { noun: 'instance type', example: 't4g.medium' },
    advisories: [
      {
        surface: 'create',
        text: 't4g.* instance types are ARM (Graviton) and are the cheap, fast default here.',
      },
    ],
  },
}

export default awsProviderFactory
