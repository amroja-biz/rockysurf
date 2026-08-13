import { z } from 'zod'

/**
 * Google Compute Engine provider configuration.
 *
 * Structurally a `ConfigSchema<GcpProviderConfig>` from the SDK — zod's `parse` already has
 * that signature — which is how a provider gets a real validator while the SDK keeps zero
 * runtime dependencies.
 *
 * REGISTRATION FRICTION, recorded here as it was on the Hetzner and AWS sides, and now for the
 * third time: core's own config schema defines the `providers.gcp` section itself, because the
 * dependency lint forbids core from importing a concrete provider and the types-only SDK cannot
 * export a zod schema. So this schema and core's section describe the same thing twice and can
 * drift. The fix is a registration-time handoff — core validates the raw section with the schema
 * the provider package exports, at the point where it constructs the provider. Out of scope
 * here; the factory exports exactly what that handoff needs. Three copies is the point at which
 * this stops being an anecdote and starts being a pattern worth paying to remove.
 */

/** An IPv4 CIDR block: four octets and a prefix length. */
const CIDR_V4 = /^(\d{1,3}\.){3}\d{1,3}\/(3[0-2]|[12]?\d)$/

/**
 * A GCE zone: a region id with a single-letter suffix, e.g. `us-central1-a`.
 *
 * Validated by shape rather than against a list, because the list of zones grows without this
 * package being republished. A zone that has the right shape and does not exist is caught by
 * `validateCredentials()`, which reads it and reports the cloud's own 404.
 */
const ZONE = /^[a-z]+-[a-z]+\d+-[a-z]$/

/**
 * A GCP project ID: 6-30 characters, lowercase letters, digits and hyphens, starting with a
 * letter and not ending with one hyphen. Google's own documented rule.
 */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/

/**
 * A resource name GCE will accept: RFC 1035, and it must START WITH A LETTER.
 *
 * Stricter than the SDK's `isHostnameSafeId`, which permits a leading digit. That difference is
 * load-bearing rather than pedantic — see `composeInstanceName` in `provider.ts`, where the
 * configured prefix is what guarantees a legal name for a server id that begins with a digit.
 */
const RESOURCE_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/

export const gcpConfigSchema = z
  .strictObject({
    /**
     * The project every resource lives in. REQUIRED, with no default.
     *
     * GCP has no equivalent of an implicit account: a credential can be valid for many projects
     * and names none of them by itself, so guessing one would mean creating billable machines
     * somewhere the operator did not choose. `gcloud config get-value project` is deliberately
     * not consulted — a firewall rule and a running VM should not depend on the ambient state of
     * somebody's shell.
     */
    projectId: z
      .string()
      .trim()
      .regex(PROJECT_ID, { error: 'projectId must be a GCP project ID, e.g. "my-project-123456"' }),

    /**
     * The single zone this provider instance manages.
     *
     * ONE zone per instance, matching `listManaged()`'s construction-time scoping (ADR-0003,
     * D6): multi-zone is deliberately unresolved in v0, and a process that needs two zones
     * constructs two providers.
     *
     * The default is `us-central1-a` rather than `us-central1-c` and that is not arbitrary:
     * arm64 (Tau T2A) exists in only eight zones and `us-central1-c` is NOT one of them, so the
     * obvious-looking default would silently be an amd64-only installation.
     */
    zone: z
      .string()
      .trim()
      .regex(ZONE, { error: 'zone must be a GCE zone, e.g. "us-central1-a"' })
      .default('us-central1-a'),

    /**
     * Path to a service-account key file. Omit to use the ambient credential chain.
     *
     * A PATH, NEVER KEY MATERIAL, which is the same posture `providers.byo.identityFile` takes.
     * There is deliberately no field in this schema that can hold a private key: the object is
     * strict, so `privateKey`, `credentials` or a pasted JSON blob is a parse error rather than a
     * secret written into a file that gets committed. The key stays where the operator's own
     * tooling put it.
     *
     * Application Default Credentials is the preferred path and needs nothing here at all —
     * `gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS`, a workload
     * identity federation binding, or the metadata server when core itself runs on GCP.
     */
    keyFile: z.string().trim().min(1).optional(),

    /**
     * Who may reach SSH on the shared firewall rule.
     *
     * REQUIRED AND EXPLICIT, with no default, for exactly the reasons the AWS provider states:
     * a firewall rule is a security decision that belongs in a file somebody can diff and
     * review, not one inferred at runtime from whatever network the operator happens to be on.
     *
     * GCP makes this more pressing than AWS does, not less. A default VPC ships with a
     * `default-allow-ssh` rule opening tcp:22 to 0.0.0.0/0 for every instance in the network, so
     * an operator may already be more exposed than they think. This provider does not touch that
     * rule — deleting somebody else's firewall is not ours to do — but it never widens it
     * either, and `docs/providers/gcp.md` says plainly that the default VPC's own rule is worth
     * a look.
     */
    sshAllowedCidr: z
      .string()
      .trim()
      .regex(CIDR_V4, { error: 'sshAllowedCidr must be an IPv4 CIDR block, e.g. 203.0.113.7/32' })
      .optional(),

    /**
     * The escape hatch for `0.0.0.0/0`, which `sshAllowedCidr` alone will not accept.
     *
     * Opening SSH to the entire internet has to be TWO deliberate acts, not one typo. These
     * boxes run agent-authored code and hold a git token.
     */
    allowAllCidr: z.boolean().default(false),

    /**
     * Value of the `managed-by` label this provider owns, and the prefix of every name it
     * creates.
     *
     * `listManaged()` filters on exactly this, and `validateSpec()` refuses a spec that
     * disagrees with it — an instance labelled with anything else is invisible to every audit
     * built on the label, which makes it an orphan from the moment it is created (ADR-0003, D3).
     */
    managedBy: z
      .string()
      .trim()
      .regex(RESOURCE_NAME, {
        error:
          'managedBy must be a legal GCE resource name (lowercase, starting with a letter) — it prefixes every ' +
          'instance name this provider creates',
      })
      .default('rockysurf'),

    /**
     * Name of the shared SSH firewall rule, which doubles as the network tag that selects the
     * instances it applies to.
     *
     * One name for both is deliberate. A GCE firewall rule does not reference instances; it
     * matches a network tag, and the instances carry the tag. Keeping them the same string means
     * an operator reading either one in the console can find the other, and there is one fewer
     * thing to configure into disagreement.
     */
    firewallRuleName: z
      .string()
      .trim()
      .regex(RESOURCE_NAME, { error: 'firewallRuleName must be a legal GCE resource name' })
      .default('rockysurf-ssh'),

    /** The VPC network the instances join. `default` is the auto-mode network every project has. */
    network: z
      .string()
      .trim()
      .regex(RESOURCE_NAME, { error: 'network must be a legal GCE resource name' })
      .default('default'),

    /**
     * Boot disk size in GB. GCE bills the boot disk separately from the instance, so this is a
     * line on the operator's bill that `Offering.hourly` does not cover.
     */
    bootDiskGb: z.coerce.number().int().min(10).max(65536).default(20),

    /** Boot disk type. `pd-balanced` is the general-purpose SSD-backed default. */
    bootDiskType: z.enum(['pd-balanced', 'pd-standard', 'pd-ssd']).default('pd-balanced'),

    /** The project publishing the base image. Canonical's public images live here. */
    imageProject: z.string().trim().min(1).default('ubuntu-os-cloud'),

    /**
     * Base image family, WITHOUT the architecture suffix.
     *
     * GCE publishes Ubuntu as two families whose names end in exactly the SDK's own
     * architecture words — `ubuntu-2404-lts-amd64` and `ubuntu-2404-lts-arm64` — so the arch is
     * appended rather than substituted. Overridable because a pack author may want a different
     * LTS, and resolved through the image FAMILY endpoint so a new patched image is picked up
     * without republishing this package.
     */
    imageFamilyPrefix: z.string().trim().min(1).default('ubuntu-2404-lts'),
  })
  .refine((config) => config.allowAllCidr || config.sshAllowedCidr !== undefined, {
    path: ['sshAllowedCidr'],
    error:
      'sshAllowedCidr is required: state which network may reach SSH, e.g. "203.0.113.7/32". ' +
      'To open SSH to the whole internet, set allowAllCidr: true as well — deliberately.',
  })
  .refine((config) => !(config.sshAllowedCidr === '0.0.0.0/0' && !config.allowAllCidr), {
    path: ['sshAllowedCidr'],
    error: '0.0.0.0/0 additionally requires allowAllCidr: true. Opening SSH to the internet is two decisions, not one.',
  })

export type GcpProviderConfig = z.infer<typeof gcpConfigSchema>

/** The CIDR the shared firewall rule will actually authorize, after both guards have passed. */
export function resolveSshCidr(config: GcpProviderConfig): string {
  return config.sshAllowedCidr ?? '0.0.0.0/0'
}

/**
 * The region a zone belongs to: `us-central1-a` → `us-central1`.
 *
 * Offerings are reported per zone (that is the granularity stock and price actually vary at),
 * but prices are published per region, so the price table is keyed by region and this is the
 * join.
 */
export function regionOf(zone: string): string {
  return zone.slice(0, zone.lastIndexOf('-'))
}
