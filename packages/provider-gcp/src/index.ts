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
export { BOOT_DISK_TYPES, gcpConfigSchema, regionOf, resolveSshCidrs, type BootDiskType, type GcpProviderConfig } from './config.js'
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
  /**
   * THE SETTINGS PANEL, DECLARED HERE (ADR-0027, issue #370). The same three controls and their
   * sentences used to be hand-written in core's `settings/fields.ts` and again as a block in the
   * SPA; both are gone, and this is the one place the words live. The prose moved verbatim.
   *
   * GCP IS THE FIREWALL SHAPE, and it migrated first of the four for that reason: `sshAllowedCidr`
   * is a declared `sshCidrList`, so ADR-0021's two-act control ships exercised by a shipped
   * provider rather than only by the fixture personal provider.
   *
   * THERE IS NO CREDENTIAL FIELD, and that is the point rather than an omission. GCP credentials
   * come from Application Default Credentials — the chain `gcloud` uses — so the config file has
   * no field that can hold key material and there is no box here inviting a paste. `keyFile` is a
   * PATH the schema accepts and this panel deliberately does not offer: a path to key material is
   * a decision made in the file, beside the file that holds the key.
   */
  settings: {
    title: 'Google Cloud',
    help:
      'Compute Engine instances in one zone, in one project you name. Credentials come from ' +
      'Application Default Credentials — the same chain `gcloud` uses — so there is no credential ' +
      'to type here.',
    fields: [
      {
        name: 'projectId',
        kind: 'string',
        label: 'Project id',
        example: 'my-project-123456',
        help:
          'The project every instance lives in. Required whenever GCP is enabled, and never inferred: ' +
          'a Google credential can be valid for many projects and names none of them, so a guess here ' +
          'would create billable machines in a project you did not pick.',
      },
      {
        name: 'zone',
        kind: 'string',
        label: 'Zone',
        example: 'us-central1-a',
        help:
          'The single zone new instances are created in. The default is us-central1-a rather than -c, ' +
          'deliberately — arm64 (Tau T2A) exists in only eight zones, and us-central1-c is not one of ' +
          'them.',
      },
      {
        name: 'sshAllowedCidr',
        kind: 'sshCidrList',
        label: 'SSH allowed from',
        example: '203.0.113.7/32',
        help:
          'Which networks may reach SSH on the boxes GCP creates here, as CIDRs — your own address as ' +
          'a /32 is the usual answer, and you can keep several so home and the office both work. ' +
          'Required whenever GCP is enabled, with no default on purpose. Saving pushes the change to ' +
          'GCP straight away; you do not have to launch a server for it to take effect.',
        warning:
          'This is a firewall rule: it decides which networks may reach SSH on every box GCP creates ' +
          'here. Removing a CIDR immediately ends new SSH connections from that network; existing ' +
          'sessions survive.',
      },
    ],
    offering: { noun: 'machine type', example: 't2a-standard-2' },
    advisories: [
      {
        surface: 'create',
        text: 'arm64 machine types come in two families in different zones — t2a-standard-* (Tau T2A) and c4a-standard-* (Axion) — so which one your zone sells depends on the zone; see docs/providers/gcp.md.',
      },
    ],
  },
}

export default gcpProviderFactory
