/**
 * `@rockysurf/provider-digitalocean` — DigitalOcean droplets for Rocky Surf.
 *
 * The reference PERSONAL provider (ADR-0026): nothing in the Rocky Surf repository imports this
 * package and the composition root does not name it. An operator installs it under
 * `<dataDir>/providers` and names it in `providers.digitalocean.package`, and Rocky Surf composes
 * it beside the shipped five, gives it a Settings panel built from the declaration below
 * (ADR-0027), and prints one sentence beside it in the boot log: a provider runs with Rocky Surf's
 * full access — install ones you trust.
 *
 * The reasoning behind every capability is in `provider.ts`; the research that produced them is in
 * the README's Capabilities section, with the citation for each.
 */

export { DigitaloceanApi, DIGITALOCEAN_API_BASE, type DigitaloceanApiOptions } from './api.js'

export {
  DEFAULT_FIREWALL_NAME,
  DEFAULT_IMAGE,
  DigitaloceanConfigError,
  digitaloceanConfigSchema,
  resolveSshCidrs,
  type ConfigIssue,
  type DigitaloceanProviderConfig,
} from './config.js'

export { digitaloceanCodeOf, isNotFound, RETRY_ANYWAY, toProviderError } from './errors.js'

export {
  decodeTag,
  decodeTags,
  DO_TAG_MAX_LENGTH,
  DO_TAG_PATTERN,
  encodeTag,
  encodeTags,
  TAG_SEPARATOR,
} from './tags.js'

export {
  asDigitaloceanData,
  decodeSshKeyName,
  digitaloceanConsoleUrl,
  DIGITALOCEAN_PROVIDER_ID,
  DROPLET_STATE,
  fingerprintOf,
  makeDigitaloceanProvider,
  sshKeyName,
  sshSourcesOf,
  type DigitaloceanApiLike,
  type DigitaloceanData,
  type DigitaloceanProviderDeps,
} from './provider.js'

export type * from './types.js'

import type { ProviderFactory } from '@rockysurf/provider-sdk'
import { digitaloceanConfigSchema, type DigitaloceanProviderConfig } from './config.js'
import { DIGITALOCEAN_PROVIDER_ID, makeDigitaloceanProvider } from './provider.js'

/**
 * The package's default export: how to describe, validate and construct this provider.
 *
 * `createProvider` is synchronous and side-effect free — no network, no filesystem, no credential
 * check — so core can load the provider, show its identity and validate its configuration before
 * holding a live instance of it. Credentials are proven separately, by `validateCredentials()`.
 */
export const digitaloceanProviderFactory: ProviderFactory<DigitaloceanProviderConfig> = {
  id: DIGITALOCEAN_PROVIDER_ID,
  displayName: 'DigitalOcean',
  configSchema: digitaloceanConfigSchema,
  createProvider: (config) => makeDigitaloceanProvider(config),
  /**
   * Where the token lands, and the variable it may arrive under when the config field is empty
   * (ADR-0026, E18). Nothing is stored: the composition root hands the value straight to
   * `configSchema.parse`, and a variable exported after boot takes effect at the next restart.
   */
  credentialField: 'token',
  credentialEnv: ['DIGITALOCEAN_TOKEN'],
  /**
   * THE SETTINGS PANEL, DECLARED (ADR-0027). Every field an operator sets, in the order the panel
   * draws them, each with a kind, a label and a sentence. `enabled`, `package` and `sizes` are the
   * installation's and are added to every panel — declaring one is refused by conformance.
   */
  settings: {
    title: 'DigitalOcean',
    help: 'Droplets at DigitalOcean, driven with a personal access token from the API page of its control panel.',
    fields: [
      {
        name: 'token',
        kind: 'secret',
        label: 'Token Environment Variable',
        example: 'DIGITALOCEAN_TOKEN',
        help:
          'The NAME of an environment variable holding a read/write personal access token from ' +
          'cloud.digitalocean.com/account/api/tokens — `DIGITALOCEAN_TOKEN`, not the token itself. ' +
          'The token is scoped to one team, which is the team every droplet created here appears in.',
      },
      {
        name: 'region',
        kind: 'string',
        label: 'Region',
        example: 'nyc3',
        help:
          'Which datacentre region new droplets are created in — nyc1/nyc3 and sfo3 (US), lon1, ' +
          'fra1 and ams3 (Europe), sgp1, blr1 and syd1 (Asia-Pacific), tor1 (Canada). There is no ' +
          'default: a guessed region would create billable machines somewhere nobody chose.',
      },
      {
        name: 'image',
        kind: 'string',
        label: 'Base image',
        example: 'ubuntu-24-04-x64',
        help:
          'The DigitalOcean image slug new droplets boot from. It has to be a cloud-init image, ' +
          'because that is what carries the host key and the install plan on first boot.',
      },
      {
        name: 'sshAllowedCidr',
        kind: 'sshCidrList',
        label: 'SSH allowed from',
        example: '203.0.113.7/32',
        help:
          'Which networks may reach port 22 on the droplets created here, as CIDRs — your own ' +
          'address as a /32 is the usual answer. Saving this rewrites the cloud firewall, so a ' +
          'removed network stops being able to reach SSH in one step.',
      },
      {
        name: 'firewallName',
        kind: 'string',
        label: 'Firewall name',
        example: 'rockysurf-ssh',
        help:
          'The name of the one DigitalOcean cloud firewall this provider creates, owns and rewrites. ' +
          'A DigitalOcean firewall rule carries no record of who wrote it, so the name is the whole ' +
          'of the proof — a firewall you made yourself is never the one Rocky Surf converges.',
      },
      {
        name: 'vpcUuid',
        kind: 'string',
        label: 'VPC',
        example: '4d0f1b2e-8a6f-4c0d-9a6e-0f1a2b3c4d5e',
        help:
          'Optional. The UUID of the VPC new droplets join; leave it out and they join the default ' +
          'VPC of the region, which is what most accounts want.',
      },
    ],
    offering: { noun: 'droplet size', example: 's-2vcpu-4gb' },
    advisories: [
      {
        surface: 'create',
        text:
          'A powered-off droplet still bills at the full hourly rate on DigitalOcean, because the ' +
          'compute stays reserved on the hypervisor — only destroying it ends the charge.',
      },
      {
        surface: 'settings',
        text:
          'DigitalOcean sells no ARM droplets, so every size offered here is amd64.',
      },
    ],
  },
}

export default digitaloceanProviderFactory
