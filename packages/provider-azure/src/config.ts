import { z } from 'zod'

/**
 * Azure provider configuration.
 *
 * Structurally a `ConfigSchema<AzureProviderConfig>` from the SDK — zod's `parse` already has
 * that signature — which is how a provider gets a real validator while the SDK keeps zero
 * runtime dependencies.
 *
 * REGISTRATION FRICTION, recorded here as it is on the AWS and Hetzner sides: core's own config
 * schema defines the `providers.azure` section itself, because the dependency lint forbids core
 * from importing a concrete provider and the types-only SDK cannot export a zod schema. So this
 * schema and core's section describe the same thing twice and can drift. The fix is a
 * registration-time handoff — core validates the raw section with the schema the provider
 * package exports, at the point where it constructs the provider. Out of scope here; the factory
 * exports exactly what that handoff needs.
 *
 * NOTE WHAT IS NOT HERE: any field that could hold a client secret. Azure credentials come from
 * the environment, from a managed identity, or from the Azure CLI — see `credentials.ts`. A
 * secret in this file would be a secret in something that gets backed up, copied to a second
 * machine and pasted into bug reports, and the settings page would have to render a box inviting
 * someone to type one in.
 */

/** An IPv4 CIDR block: four octets and a prefix length. */
const CIDR_V4 = /^(\d{1,3}\.){3}\d{1,3}\/(3[0-2]|[12]?\d)$/

/** ARM resource names this provider derives are RFC 1123-ish; the subscription id is a GUID. */
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export const azureConfigSchema = z
  .strictObject({
    /**
     * The subscription every resource is created in. Required: there is no default subscription
     * to fall back to, and guessing one would create billable resources in an account nobody
     * named.
     */
    subscriptionId: z
      .string()
      .trim()
      .regex(GUID, { error: 'subscriptionId must be an Azure subscription GUID' }),

    /**
     * The ONE resource group this provider owns, and the scope its published role is granted at.
     *
     * A RESOURCE GROUP PER SERVER WAS THE OTHER CANDIDATE AND WAS REJECTED. It would make
     * `terminate()` an atomic `DELETE` on the group and an orphan sweep trivial — genuinely
     * attractive — but a role cannot be scoped to a resource group that does not exist yet, so
     * creating one per server needs `Microsoft.Resources/subscriptions/resourceGroups/write` and
     * `/delete` at SUBSCRIPTION scope. The least-privilege artifact we publish would then be a
     * role able to delete any resource group in the subscription, which is a far larger blast
     * radius than everything else this product does combined.
     *
     * Azure gives the same atomicity another way: `deleteOption: 'Delete'` on the OS disk, the
     * NIC and the public IP makes one `DELETE` on the VM cascade to all four resources. And a
     * single unfiltered listing of this group returns full tags on every item, where ARM's
     * `tagName`/`tagValue` filter drops them — so the shared group is also what makes
     * `listManaged()` one call with complete attribution.
     *
     * ONE group per provider instance, matching `listManaged()`'s construction-time scoping
     * (ADR-0003, D6). Rocky Surf does not create it: `az group create` is one command, and a
     * provider that creates its own scope cannot be granted a role scoped to it.
     */
    resourceGroup: z.string().trim().min(1).max(90),

    /** The Azure region. One per provider instance, for the same D6 reason. */
    location: z.string().trim().min(1).default('eastus'),

    /**
     * Who may reach SSH on the shared network security group.
     *
     * REQUIRED AND EXPLICIT, with no default, and this is the security decision of the whole
     * package — the same one `@rockysurf/provider-aws` makes and for the same reasons. Making it
     * configuration means it is written down, diffable and reviewable, and that the operator
     * states their intent rather than inheriting it from whatever address they had that morning.
     *
     * It matters more on Azure than on AWS, because a Standard-SKU public IP is closed to
     * inbound traffic by default: without this rule in the NSG, SSH does not work at all. The
     * failure is at least loud.
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
     * The `managed-by` tag value this provider owns.
     *
     * Everything it creates carries it, `listManaged()` reports on it, and `validateSpec()`
     * REFUSES a spec whose `managed-by` disagrees (ADR-0003, D3) — a VM tagged with anything
     * else is invisible to the reconciler and therefore an orphan from birth.
     */
    managedBy: z.string().trim().min(1).default('rockysurf'),

    /** The shared virtual network. Created on first provision if absent, adopted thereafter. */
    vnetName: z.string().trim().min(1).default('rockysurf-vnet'),
    /** The subnet within it. */
    subnetName: z.string().trim().min(1).default('rockysurf-subnet'),
    /** Address space for a vnet this provider creates. Ignored when one already exists. */
    vnetAddressPrefix: z.string().trim().min(1).default('10.42.0.0/16'),
    subnetAddressPrefix: z.string().trim().min(1).default('10.42.0.0/24'),

    /** The shared network security group. One per resource group, reused by every server. */
    nsgName: z.string().trim().min(1).default('rockysurf-ssh'),

    /** OS disk size in GiB. Azure's Ubuntu images are 30 GiB; a smaller disk is refused. */
    osDiskGb: z.coerce.number().int().min(30).max(32767).default(30),

    /**
     * Managed disk type. `Premium_LRS` is the default because these are dev boxes an agent
     * compiles on, and `Standard_LRS` spinning media makes that miserable.
     */
    osDiskType: z.enum(['Standard_LRS', 'StandardSSD_LRS', 'Premium_LRS']).default('Premium_LRS'),

    /**
     * The marketplace image, as publisher/offer, with the SKU chosen per architecture.
     *
     * Overridable because a pack author may want a different Ubuntu LTS. NOTE that Microsoft's
     * own cloud-init page still documents the pre-20.04 offer name `UbuntuServer`; the current
     * one is `ubuntu-24_04-lts`, per Canonical.
     */
    imagePublisher: z.string().trim().min(1).default('Canonical'),
    imageOffer: z.string().trim().min(1).default('ubuntu-24_04-lts'),
    /** SKU for amd64. Gen2. */
    imageSkuAmd64: z.string().trim().min(1).default('server'),
    /** SKU for arm64. A mismatch between this and an Arm VM size fails at create. */
    imageSkuArm64: z.string().trim().min(1).default('server-arm64'),

    /**
     * The admin account cloud-init creates. Core connects as this user.
     *
     * `azureuser` is the platform convention. Note that `root` is refused by Azure outright, so
     * this is not a place to be clever.
     */
    adminUsername: z.string().trim().min(1).default('azureuser'),

    /**
     * Whether the credential chain may fall back to `az account get-access-token`.
     *
     * True by default, so someone who has run `az login` can try Rocky Surf without first
     * creating a service principal. Set it false on a server: a control plane that can shell out
     * to whatever `az` resolves to on `PATH` has a wider trust boundary than one that cannot.
     */
    allowAzureCli: z.boolean().default(true),
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

export type AzureProviderConfig = z.infer<typeof azureConfigSchema>

/** The CIDR the shared NSG will actually authorize, after both guards have passed. */
export function resolveSshCidr(config: AzureProviderConfig): string {
  return config.sshAllowedCidr ?? '0.0.0.0/0'
}
