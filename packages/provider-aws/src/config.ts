import { normalizeSshCidrs, opensSshToTheInternet } from '@rockysurf/provider-sdk'
import { z } from 'zod'

/**
 * AWS provider configuration.
 *
 * Structurally a `ConfigSchema<AwsProviderConfig>` from the SDK — zod's `parse` already has
 * that signature — which is how a provider gets a real validator while the SDK keeps zero
 * runtime dependencies.
 *
 * REGISTRATION FRICTION, recorded here as it was on the Hetzner side: core's own config schema
 * defines the `providers.aws` section itself, because the dependency lint forbids core from
 * importing a concrete provider and the types-only SDK cannot export a zod schema. So this
 * schema and core's section describe the same thing twice and can drift. The fix is a
 * registration-time handoff — core validates the raw section with the schema the provider
 * package exports, at the point where it constructs the provider. Out of scope here; the
 * factory exports exactly what that handoff needs.
 */

/** An IPv4 CIDR block: four octets and a prefix length. */
const CIDR_V4 = /^(\d{1,3}\.){3}\d{1,3}\/(3[0-2]|[12]?\d)$/

/**
 * One entry in `sshAllowedCidr`.
 *
 * Split out from the list because issue #304 made the setting a list and every entry has to
 * satisfy the same rule the single value used to: a literal IPv4 CIDR, so the operator's intent
 * is legible to anyone reading the file.
 */
const sshCidrEntry = z
  .string()
  .trim()
  .regex(CIDR_V4, { error: 'sshAllowedCidr must be an IPv4 CIDR block, e.g. 203.0.113.7/32' })

export const awsConfigSchema = z
  .strictObject({
    /**
     * The single region this provider instance manages.
     *
     * ONE region per instance, matching `listManaged()`'s construction-time scoping
     * (ADR-0003, D6): multi-region is deliberately unresolved in v0, and a process that needs
     * two regions constructs two providers.
     */
    region: z.string().trim().min(1).default('us-east-1'),

    /**
     * Named profile from the shared credentials file. Omit to use the default chain
     * (environment, SSO, instance role, and so on).
     */
    profile: z.string().trim().min(1).optional(),

    /**
     * URL of this provider's hosted price-feed document (gh issue #100, ADR-0009).
     *
     * Injected by core's compose wiring from `pricing.feedUrl` — an operator sets that, not
     * this. Absent (pricing disabled, or a config bypassing compose) means no feed: every
     * offering lists with `hourly: null`, and everything else keeps working.
     */
    pricesUrl: z.url().optional(),

    /** How often the feed is re-read, in hours. Injected from `pricing.refreshHours`. */
    pricesRefreshHours: z.coerce.number().positive().max(720).default(6),

    /**
     * Who may reach SSH on the shared security group.
     *
     * REQUIRED AND EXPLICIT, with no default, and this is the security decision of the whole
     * package. The spike scoped the rule to whatever address the operator happened to have at
     * the time, discovered by calling out to checkip.amazonaws.com. That is fine for a scratch
     * script and wrong for a product: it silently breaks the moment the operator's network
     * changes, it depends on an outbound call to a third party to decide a firewall rule, and
     * it hides a security-relevant choice inside runtime behaviour where nobody reviews it.
     *
     * Making it configuration means it is written down, diffable, and reviewable — and that
     * the operator states their intent rather than inheriting it from their coffee shop's
     * NAT. ADR-0003 (E11) reached the same conclusion from the other direction when it
     * rejected an `ensureAccess()` interface method: security-group maintenance is provider
     * configuration.
     */
    sshAllowedCidr: z
      .union([sshCidrEntry, z.array(sshCidrEntry)])
      .transform(normalizeSshCidrs)
      .refine((cidrs) => cidrs.length > 0, {
        error:
          'sshAllowedCidr must name at least one network. An empty list would leave SSH reachable ' +
          'from nowhere, which is never what an edit to this setting intends — add the replacement ' +
          'before removing the last entry.',
      })
      .optional(),

    /**
     * The escape hatch for `0.0.0.0/0`, which `sshAllowedCidr` alone will not accept.
     *
     * Opening SSH to the entire internet has to be TWO deliberate acts, not one typo. These
     * boxes run agent-authored code and hold a git token; a `/0` that arrives by accident is
     * the difference between a dev box and an incident. Someone who genuinely wants it —
     * a demo, a CI runner behind other controls — can still have it, and will have said so
     * twice in a file someone else can read.
     */
    allowAllCidr: z.boolean().default(false),

    /**
     * Value of the `managed-by` tag this provider owns.
     *
     * `listManaged()` filters on exactly this, and `validateSpec()` refuses a spec that
     * disagrees with it — an instance tagged with anything else is invisible to every audit
     * built on the tag, which makes it an orphan from the moment it is created (ADR-0003, D3).
     */
    managedBy: z.string().trim().min(1).default('rockysurf'),

    /** Name of the shared SSH security group. One per region, reused by every server. */
    securityGroupName: z.string().trim().min(1).default('rockysurf-ssh'),

    /**
     * Root volume size in GiB. The AMI's own root device name is read at provision time;
     * guessing it attaches a SECOND volume that survives termination (ADR-0003, D4).
     */
    rootVolumeGb: z.coerce.number().int().min(8).max(16384).default(20),

    /**
     * Base image family, as an SSM public parameter path with `{arch}` substituted.
     *
     * Overridable because a pack author may want a different Ubuntu LTS, but the default is
     * the one both spike lifecycles ran on.
     */
    amiParameterPrefix: z
      .string()
      .trim()
      .min(1)
      .default('/aws/service/canonical/ubuntu/server/24.04/stable/current'),
  })
  .refine((config) => config.allowAllCidr || config.sshAllowedCidr !== undefined, {
    path: ['sshAllowedCidr'],
    error:
      'sshAllowedCidr is required: state which network may reach SSH, e.g. "203.0.113.7/32". ' +
      'To open SSH to the whole internet, set allowAllCidr: true as well — deliberately.',
  })
  .refine(
    (config) => !(config.sshAllowedCidr !== undefined && opensSshToTheInternet(config.sshAllowedCidr) && !config.allowAllCidr),
    {
      path: ['sshAllowedCidr'],
      error:
        '0.0.0.0/0 additionally requires allowAllCidr: true. Opening SSH to the internet is two decisions, not one. ' +
        'ANY entry in the list being 0.0.0.0/0 opens SSH to the whole internet — the other entries do not narrow it.',
    },
  )

export type AwsProviderConfig = z.infer<typeof awsConfigSchema>

/**
 * The CIDRs the shared group will actually authorize, after both guards have passed.
 *
 * The `?? ['0.0.0.0/0']` is not a default for the setting — the schema refuses a config that
 * omits `sshAllowedCidr` unless `allowAllCidr: true` is present, so the only way to reach this
 * branch is to have asked for the whole internet, twice, in writing.
 */
export function resolveSshCidrs(config: AwsProviderConfig): string[] {
  return config.sshAllowedCidr ?? ['0.0.0.0/0']
}
