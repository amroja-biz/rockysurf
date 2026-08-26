import {
  assertHostnameSafeId,
  DESCRIBE_ABSENCE_GRACE,
  ProviderError,
  unsupportedOperationError,
  type Architecture,
  type ComputeProvider,
  type InstanceState,
  type InstanceView,
  type ManagedResource,
  type Offering,
  type ProviderCapabilities,
  type ProviderData,
  type ProvisionResult,
  type ProvisionSpec,
} from '@rockysurf/provider-sdk'
import { API_VERSIONS, ArmApi, resourceGroupPath, resourcePath } from './api.js'
import { resolveSshCidr, type AzureProviderConfig } from './config.js'
import { PriceFeedClient, type PriceFeedDoc } from './feed.js'
import { CredentialChain, type CredentialChainOptions } from './credentials.js'
import { azureCodeOf, isNotFound } from './errors.js'
import { buildOfferings } from './offerings.js'
import type {
  ArmNetworkInterface,
  ArmNetworkSecurityGroup,
  ArmPublicIpAddress,
  ArmResource,
  ArmResourceSku,
  ArmVirtualMachine,
  ArmVirtualNetwork,
 ArmUsage,
} from './types.js'

/**
 * Azure, as plain ARM REST calls.
 *
 * THE ONE THING THAT MAKES THIS PROVIDER DIFFERENT from the other two: on EC2 and on Hetzner an
 * instance is one resource, and `terminate()` is one call. On Azure a running dev box is FOUR
 * resources — the virtual machine, its OS disk, its network interface and its public IP — and
 * Azure's default is to PERSIST all of them when the VM is deleted. A provider written the
 * obvious way leaks three billable resources per server, forever, and an audit that walks
 * virtual machines never sees them.
 *
 * The answer is `deleteOption: 'Delete'`, set in three places at create time so that one
 * `DELETE` on the VM cascades: on the OS disk and the NIC in the VM's own body, and on the
 * public IP inside the NIC's body (the public IP's delete option is a property of the NIC that
 * references it, NOT of the VM — deleting the NIC is what deletes the address). Everything else
 * about this file follows from that chain, including the order resources are created in and what
 * happens on a failure halfway through.
 */

export const AZURE_PROVIDER_ID = 'azure'

const MANAGED_BY_TAG = 'managed-by'
const SERVER_ID_TAG = 'server-id'
/**
 * The idempotency key, kept as a tag.
 *
 * ARM is idempotent by NAME within a resource group, which gets us most of the way: a replayed
 * create with the same derived name does not make a second machine. But it is not `ClientToken`
 * — a replay carrying DIFFERENT properties UPDATES the existing resource rather than refusing —
 * so the key is written where a later call can read it back and tell a replay from a collision.
 */
const IDEMPOTENCY_TAG = 'idempotency-key'

/**
 * Capabilities. Two of these are measured against Azure's documentation rather than against
 * Azure, and say so: this package was built without an Azure subscription, and
 * `rockysurf-ihtq.8` is the owner-gated run that turns the reasoned ones into measured ones.
 */
const CAPABILITIES: ProviderCapabilities = {
  /**
   * Deallocate, not power-off. Both preserve the disk and only one stops the bill: a
   * powered-off Azure VM is still charged full compute rate for doing nothing, which makes it
   * useless as the cost lever `stop` exists to be.
   */
  stop: true,
  /**
   * TRUE, and this is a property of the address rather than of the VM. Basic-SKU public IPs were
   * retired on 2025-09-30, so every address this provider allocates is Standard, and Standard is
   * always `Static` — Azure offers no Dynamic-Standard combination. A static address is released
   * only when the address resource itself is deleted, so it survives deallocate/start. Unlike
   * EC2, there is nothing for core to re-read after a start.
   */
  ipStableAcrossStop: true,
  /**
   * REASONED, NOT YET MEASURED. Azure's Ubuntu images are cloud-init provisioned and
   * `osProfile.customData` is what cloud-init consumes, so `#cloud-config` with an `ssh_keys:`
   * block should place a host key core minted before first boot, exactly as on the other two
   * clouds. Upstream cloud-init's `cc_ssh` does precisely that and Microsoft documents no
   * override — but nobody has run it on a real Azure Ubuntu 24.04 image, and this flag is a
   * SECURITY POSTURE rather than a feature toggle: `true` promises there is no
   * trust-on-first-use window on the connection that carries the secrets file. If the
   * owner-gated run disproves it, this becomes `false` and the capability matrix and provider
   * doc change with it.
   */
  canInjectHostKeys: true,
  /**
   * 48 KiB, which is smaller than Azure's documented ceiling on purpose.
   *
   * Microsoft documents `customData` as "the size can't exceed 64 KB" and does NOT say whether
   * that is measured before or after the mandatory base64 encoding — and base64 inflates by a
   * third, so the two readings differ by 16 KB. 49152 is the largest value that is correct under
   * either reading. In push mode the rendered document is ~2.1KB and constant however much
   * software the install plan adds (ADR-0002), so this ceiling is nowhere near binding, and
   * guessing high to reclaim headroom nobody uses would buy a provider-side rejection at
   * provision time.
   */
  userDataMaxBytes: 49_152,
  generatesUserData: true,
}

/**
 * What this provider persists per instance.
 *
 * The secondary resources are named here rather than re-derived, because `terminate()` has to be
 * able to reap them when the cascade cannot: a create that failed after the NIC existed leaves a
 * handle whose VM never did, and the only record of what to clean up is this object.
 */
export interface AzureData extends ProviderData {
  /** The VM's ARM name, which is `spec.serverId`. */
  vmName: string
  resourceGroup: string
  subscriptionId: string
  location: string
  nicName: string
  publicIpName: string
  osDiskName: string
}

/** Parse the opaque handle, failing loudly rather than reading `undefined.vmName` later. */
export function asAzureData(data: ProviderData): AzureData {
  const vmName = data['vmName']
  const resourceGroup = data['resourceGroup']
  const subscriptionId = data['subscriptionId']
  if (typeof vmName !== 'string' || typeof resourceGroup !== 'string' || typeof subscriptionId !== 'string') {
    throw new ProviderError(
      'invalid_spec',
      'provider data is not an Azure handle: expected { vmName, resourceGroup, subscriptionId }',
    )
  }
  const str = (key: string, fallback: string) => (typeof data[key] === 'string' ? (data[key] as string) : fallback)
  return {
    vmName,
    resourceGroup,
    subscriptionId,
    location: str('location', ''),
    nicName: str('nicName', `${vmName}-nic`),
    publicIpName: str('publicIpName', `${vmName}-ip`),
    osDiskName: str('osDiskName', `${vmName}-osdisk`),
  }
}

/* ------------------------------------------------------------------------- state mapping */

/**
 * A VM's power state, from an instance-view status code like `PowerState/running`.
 *
 * PARSED DEFENSIVELY RATHER THAN SWITCHED ON A CLOSED SET. Microsoft's states-and-billing page
 * documents the STATES (Starting, Running, Stopping, Stopped, Deallocating, Deallocated) but
 * only ever prints one of the code strings literally, and publishes no exhaustive enumeration of
 * the rest. Treating an unrecognised suffix as `unknown` is what the SDK's `unknown` state is
 * for — "the provider returned a state this SDK does not model. Never guess on the caller's
 * behalf."
 */
export function powerStateOf(statuses: { code?: string }[] | undefined): string | undefined {
  const code = statuses?.find((s) => s.code?.startsWith('PowerState/'))?.code
  return code?.slice('PowerState/'.length).toLowerCase()
}

const POWER_STATE: Readonly<Record<string, InstanceState>> = {
  starting: 'pending',
  running: 'running',
  stopping: 'stopping',
  // Azure's "Stopped" is Stopped(Allocated) and still bills compute. It is reachable only if
  // somebody powers a box off outside Rocky Surf, since `stop()` deallocates — but it exists,
  // and reporting it as anything other than `stopped` would misdescribe a restartable box.
  stopped: 'stopped',
  deallocating: 'stopping',
  deallocated: 'stopped',
}

/**
 * ARM's two state fields onto the frozen state machine.
 *
 * `provisioningState` and the power state answer different questions and both are needed:
 * provisioning describes the RESOURCE (is it built, is it being deleted, did it fail) while
 * power describes the MACHINE (is it on). A VM that is being started reads
 * `provisioningState: Updating` with `PowerState/starting`, so power wins wherever it is
 * present — except for the two provisioning states that outrank any power reading, because a
 * VM being deleted or a VM that failed to build is not describable by whether it is switched on.
 */
export function instanceStateOf(
  provisioningState: string | undefined,
  powerState: string | undefined,
): InstanceState {
  // Irreversibly on its way out, but NOT gone: the disk, the NIC and the address still exist and
  // still bill, so a reconciler must treat it as present (ADR-0003, A3).
  if (provisioningState === 'Deleting') return 'terminating'
  if (provisioningState === 'Failed') return 'failed'
  if (powerState !== undefined) return POWER_STATE[powerState] ?? 'unknown'
  if (provisioningState === 'Creating' || provisioningState === 'Updating') return 'pending'
  // `Succeeded` with no power reading means the instance view was not expanded or has not caught
  // up. The resource exists; how it is running is genuinely not known.
  return provisioningState === 'Succeeded' ? 'pending' : 'unknown'
}

/**
 * A VM's page in the Azure portal (ADR-0003, E16).
 *
 * Unlike Hetzner, nothing has to be configured for this: an ARM resource id already contains the
 * subscription, the resource group and the name, and the portal resolves a resource without
 * being told the tenant. Someone signed in to a different tenant lands on a "resource not found"
 * rather than in somebody else's project, which is why this is safe to always emit.
 */
export function azurePortalUrl(resourceId: string): string | undefined {
  if (!resourceId) return undefined
  return `https://portal.azure.com/#resource${resourceId}/overview`
}

/* -------------------------------------------------------------------------------- factory */

export interface AzureProviderOptions {
  config: AzureProviderConfig
  /** Injected by tests; production builds its own chain from the environment. */
  credentials?: CredentialChain
  credentialOptions?: CredentialChainOptions
  /** Injected by tests, so no test touches Azure. */
  fetchImpl?: typeof fetch
  baseUrl?: string
  maxRetries?: number
  retryBaseMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Overrides the describe() propagation grace. Never to skip it — only to lengthen it. */
  absenceGrace?: { attempts: number; delayMs: number }
  /** Injected by tests; production builds a `PriceFeedClient` from the config. */
  priceFeed?: { get(): Promise<PriceFeedDoc | null> }
  /** Where one-line operational warnings go. Defaults to `console.warn`. */
  log?: (message: string) => void
}

/** How long a quota read is believed. `currentValue` moves with every create, including ours. */
const QUOTA_TTL_MS = 60_000
/** How long an unreadable quota is not retried, so a sick endpoint costs one attempt a minute. */
const QUOTA_RETRY_MS = 30_000

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function makeAzureProvider(options: AzureProviderOptions): ComputeProvider {
  const { config } = options
  const { subscriptionId, resourceGroup, location, managedBy } = config
  const priceFeed = options.priceFeed ?? new PriceFeedClient(config.pricesUrl, config.pricesRefreshHours)
  const log = options.log ?? ((message: string) => console.warn(message))

  const credentials =
    options.credentials ??
    new CredentialChain({
      allowAzureCli: config.allowAzureCli,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...options.credentialOptions,
    })

  const api = new ArmApi({
    credentials,
    subscriptionId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  })

  const grace = options.absenceGrace ?? DESCRIBE_ABSENCE_GRACE
  const sleep = options.sleep ?? defaultSleep

  /**
   * Instances this provider has observed running, which is what keeps the propagation grace
   * cheap where it does not matter. An instance seen running and now absent really is gone —
   * believe it immediately. One never seen running might be a create that has not propagated.
   */
  const seenRunning = new Set<string>()

  /**
   * Public IP addresses already read, keyed by the address resource's name.
   *
   * Safe to cache for the life of the process precisely because `ipStableAcrossStop` is true:
   * every address here is Standard SKU and therefore Static, and a static address changes only
   * when the resource is deleted. Caching it is what keeps `describe()` — which core polls in a
   * loop — to ONE round trip rather than two.
   */
  const addressCache = new Map<string, string>()

  /** Per-process caches. Everything here is cheap to rebuild and safe to lose. */
  let subnetId: string | undefined
  let nsgId: string | undefined
  let skuCache: ArmResourceSku[] | undefined
  let quota: { until: number; value: readonly ArmUsage[] | null } | undefined
  let quotaInflight: Promise<readonly ArmUsage[] | null> | undefined
  let quotaUnreadableReported = false

  const groupPath = () => resourceGroupPath(subscriptionId, resourceGroup)
  const vmPath = (name: string) =>
    resourcePath(subscriptionId, resourceGroup, 'Microsoft.Compute/virtualMachines', name)
  const nicPath = (name: string) =>
    resourcePath(subscriptionId, resourceGroup, 'Microsoft.Network/networkInterfaces', name)
  const pipPath = (name: string) =>
    resourcePath(subscriptionId, resourceGroup, 'Microsoft.Network/publicIPAddresses', name)

  const names = (serverId: string) => ({
    vm: serverId,
    nic: `${serverId}-nic`,
    pip: `${serverId}-ip`,
    osDisk: `${serverId}-osdisk`,
  })

  async function deleteIgnoringNotFound(path: string, apiVersion: string): Promise<void> {
    try {
      await api.call<void>('DELETE', path, apiVersion)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  /**
   * Delete resources on a path where the CALLER's own failure is what must reach core.
   *
   * A cleanup that throws would replace the real error — the reason the VM was not created —
   * with whatever went wrong tidying up, and core reports that string to the operator. So a
   * resource that will not delete is left for `listManaged()` to surface instead, which is the
   * report-and-let-a-human-decide contract the reconciler already has.
   */
  async function reapQuietly(nicName: string, pipName: string): Promise<void> {
    // Order matters: the address cannot be deleted while a NIC references it.
    for (const [path, version] of [
      [nicPath(nicName), API_VERSIONS.network],
      [pipPath(pipName), API_VERSIONS.network],
    ] as const) {
      try {
        await deleteIgnoringNotFound(path, version)
      } catch {
        /* reported by listManaged(), never raised over the original failure */
      }
    }
  }

  /**
   * Refuse a shared resource that exists in a DIFFERENT region than the one we are provisioning
   * into (rockysurf-3l4g).
   *
   * Azure requires a network interface and the subnet and NSG it references to be in the same
   * region. The shared vnet and NSG are looked up BY NAME within the resource group, and a name
   * says nothing about region — so after an operator changes `location`, the lookup happily
   * finds the old region's resources and hands their ids to the NIC PUT, which fails with:
   *
   *   InvalidResourceReference: Resource .../networkSecurityGroups/rockysurf-ssh referenced by
   *   resource .../networkInterfaces/srv-XXXX-nic was not found.
   *
   * "was not found" is the wrong sentence: it exists. An operator reading that looks for a
   * deleted resource or a permissions problem, and the one thing it does not suggest is the
   * real cause. Azure does append a region hint, but only as the second clause of a sentence
   * whose first clause is false.
   *
   * Changing region is ordinary, and on Azure it is MORE likely than elsewhere: per-subscription
   * SKU restrictions and per-family core quotas mean an operator may be forced to move regions
   * to find capacity at all. So this fails early, at the resource that is actually wrong, and
   * says what to do about it.
   *
   * Refusing rather than auto-creating a second region's pair is the conservative half of the
   * fix: sharing one resource group across regions would change how these resources are named,
   * which is a decision with a migration attached rather than a bug fix.
   */
  function assertSameRegion(resource: ArmResource, name: string, kind: string): void {
    const found = resource.location?.toLowerCase()
    if (!found || found === location.toLowerCase()) return
    throw new ProviderError(
      'invalid_spec',
      `the shared ${kind} ${name} already exists in ${resource.location}, but this provider is ` +
        `configured for ${location}. Azure requires a network interface and the subnet and NSG ` +
        `it uses to be in one region, so no server can be created here while they disagree. ` +
        `Either set providers.azure.location back to ${resource.location}, or delete ${name} ` +
        `from the ${resourceGroup} resource group and let it be recreated in ${location} — ` +
        `deleting is safe once no servers remain in ${resource.location}.`,
    )
  }

  /**
   * The shared network, created on first provision and adopted forever after.
   *
   * BOTH THE SUBNET AND THE SSH RULE ARE WRITTEN AS CHILD RESOURCES, not by PUTting the whole
   * virtual network or the whole security group. That is not a style preference: a PUT on a
   * parent replaces its children, so writing the whole NSG would silently delete every other
   * rule an operator had added to it, and writing the whole vnet would delete their other
   * subnets. A child PUT touches exactly the one thing this provider owns.
   *
   * These are `shared` in `listManaged()` for the same reason AWS's security group is: a
   * reconciler treating the managed list as a delete-list would otherwise tear them out from
   * under every running instance (ADR-0003, D1).
   */
  async function ensureNetwork(): Promise<{ subnetId: string; nsgId: string }> {
    /*
     * DELIBERATELY NOT MEMOIZED (rockysurf-3l4g).
     *
     * This used to open with `if (subnetId && nsgId) return { subnetId, nsgId }`, caching the
     * result for the lifetime of the process. That cached three bugs at once:
     *
     *  1. It never re-checked that the shared resources still EXIST. Delete them out from under
     *     a running control plane — an operator tidying up, a mis-scoped script, a half-finished
     *     create — and every subsequent create went straight to the NIC PUT referencing an NSG
     *     that was gone, failing with `InvalidResourceReference` until someone restarted. The
     *     documented recovery ("delete them and let them be recreated") silently did not work.
     *  2. It short-circuited the securityRules PUT below, whose own comment promises the rule is
     *     "written every time so a changed sshAllowedCidr takes effect on the next provision".
     *     It did not: only the first provision of each process wrote it.
     *  3. It hid a changed `location` for as long as the process lived.
     *
     * The cost of dropping it is two GETs per create, against an operation that then spends
     * minutes building a virtual machine. The reads are what make this function honest.
     */
    const vnetPath = resourcePath(
      subscriptionId,
      resourceGroup,
      'Microsoft.Network/virtualNetworks',
      config.vnetName,
    )
    const tags = { [MANAGED_BY_TAG]: managedBy }

    let vnet: ArmVirtualNetwork | undefined
    try {
      vnet = await api.call<ArmVirtualNetwork>('GET', vnetPath, API_VERSIONS.network)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }

    if (vnet) assertSameRegion(vnet, config.vnetName, 'virtual network')

    if (!vnet) {
      vnet = await api.call<ArmVirtualNetwork>('PUT', vnetPath, API_VERSIONS.network, {
        location,
        tags,
        properties: {
          addressSpace: { addressPrefixes: [config.vnetAddressPrefix] },
          subnets: [{ name: config.subnetName, properties: { addressPrefix: config.subnetAddressPrefix } }],
        },
      })
    }

    const existingSubnet = vnet.properties?.subnets?.find((s) => s.name === config.subnetName)
    if (existingSubnet?.id) {
      subnetId = existingSubnet.id
    } else {
      // The vnet is an operator's own, or ours from a config that named a different subnet.
      // Adding one child leaves their other subnets alone.
      const created = await api.call<ArmResource>('PUT', `${vnetPath}/subnets/${config.subnetName}`, API_VERSIONS.network, {
        properties: { addressPrefix: config.subnetAddressPrefix },
      })
      subnetId = created.id
    }

    const nsgPath = resourcePath(
      subscriptionId,
      resourceGroup,
      'Microsoft.Network/networkSecurityGroups',
      config.nsgName,
    )
    let nsg: ArmNetworkSecurityGroup | undefined
    try {
      nsg = await api.call<ArmNetworkSecurityGroup>('GET', nsgPath, API_VERSIONS.network)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    if (nsg) assertSameRegion(nsg, config.nsgName, 'network security group')

    if (!nsg) {
      nsg = await api.call<ArmNetworkSecurityGroup>('PUT', nsgPath, API_VERSIONS.network, {
        location,
        tags,
        properties: {},
      })
    }
    nsgId = nsg.id

    // The SSH rule, written every time so a changed `sshAllowedCidr` takes effect on the next
    // provision rather than silently applying only to a fresh installation. It comes from
    // CONFIGURATION, never from a runtime lookup of the caller's own address — see config.ts.
    await api.call<unknown>('PUT', `${nsgPath}/securityRules/rockysurf-ssh`, API_VERSIONS.network, {
      properties: {
        description: 'rockysurf sshAllowedCidr',
        protocol: 'Tcp',
        sourceAddressPrefix: resolveSshCidr(config),
        sourcePortRange: '*',
        destinationAddressPrefix: '*',
        destinationPortRange: '22',
        access: 'Allow',
        direction: 'Inbound',
        // Well above Azure's own defaults (which start at 65000) and clear of the 100-299 band
        // operators conventionally keep for their own rules.
        priority: 300,
      },
    })

    if (!subnetId || !nsgId) {
      throw new ProviderError('unknown', `could not resolve ${config.vnetName}/${config.subnetName} or ${config.nsgName}`)
    }
    return { subnetId, nsgId }
  }

  /** The public address for one instance, cached because a Standard SKU address never moves. */
  async function addressOf(pipName: string): Promise<string | undefined> {
    const cached = addressCache.get(pipName)
    if (cached) return cached
    try {
      const pip = await api.call<ArmPublicIpAddress>('GET', pipPath(pipName), API_VERSIONS.network)
      const ip = pip.properties?.ipAddress
      if (ip) addressCache.set(pipName, ip)
      return ip
    } catch (err) {
      // A missing or unreadable address is not a reason to fail a describe: the state of the
      // machine is the answer core needs, and a sparse view is legal.
      if (isNotFound(err)) return undefined
      throw err
    }
  }

  function viewOf(vm: ArmVirtualMachine, publicIp?: string): InstanceView {
    const provisioningState = vm.properties?.provisioningState
    const powerState = powerStateOf(vm.properties?.instanceView?.statuses)
    const state = instanceStateOf(provisioningState, powerState)
    if (state === 'running' && vm.name) seenRunning.add(vm.name)

    const failureReason =
      state === 'failed'
        ? (vm.properties?.instanceView?.statuses?.find((s) => s.level === 'Error')?.message ??
          `Azure reports provisioningState ${provisioningState}`)
        : undefined
    const consoleUrl = vm.id ? azurePortalUrl(vm.id) : undefined

    return {
      state,
      ...(publicIp ? { publicIp } : {}),
      ...(vm.properties?.hardwareProfile?.vmSize ? { offeringId: vm.properties.hardwareProfile.vmSize } : {}),
      ...(consoleUrl ? { consoleUrl } : {}),
      ...(failureReason ? { failureReason } : {}),
    }
  }

  /** The whole catalogue, read once per process. Shapes and availability do not change hourly. */
  async function resourceSkus(): Promise<ArmResourceSku[]> {
    if (skuCache) return skuCache
    const filter = encodeURIComponent(`location eq '${location}'`)
    skuCache = await api.collect<ArmResourceSku>(
      `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/skus?$filter=${filter}`,
      API_VERSIONS.compute,
    )
    return skuCache
  }

  /**
   * The region's core quota — the second gate on a create, which `Microsoft.Compute/skus`
   * knows nothing about (issue #116). See `quotaRefusal()` in offerings.ts for what is done
   * with it.
   *
   * Cached briefly rather than per process like the SKUs: `currentValue` moves with every
   * machine this subscription creates, including ours, so a catalogue read a minute after a
   * launch should see the cores it consumed. Single-flight, same as the price feed.
   *
   * NULL MEANS "COULD NOT READ", NEVER "NO QUOTA". The published `Rocky Surf Catalogue Reader`
   * role gained `locations/usages/read` with this change, and an installation still on the
   * previous role gets `AuthorizationFailed` here. That must not take the create form down or
   * mark every size unavailable: it degrades to the SKU gate alone — the v0.1 behaviour — and
   * says so once in the log, naming the action to add. Any other failure degrades the same way
   * for a shorter window; the catalogue is more useful stale than absent.
   */
  async function coreQuota(): Promise<readonly ArmUsage[] | null> {
    if (quota && Date.now() < quota.until) return quota.value
    quotaInflight ??= (async () => {
      try {
        const value = await api.collect<ArmUsage>(
          `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${location}/usages`,
          API_VERSIONS.compute,
        )
        quota = { until: Date.now() + QUOTA_TTL_MS, value }
        return value
      } catch (err) {
        const unauthorised = err instanceof ProviderError && err.code === 'auth'
        if (unauthorised && !quotaUnreadableReported) {
          quotaUnreadableReported = true
          log(
            `[azure] core quota for ${location} is not readable by this credential, so the size list ` +
              'reflects SKU availability only and a size may still be refused for quota at create. ' +
              'Grant Microsoft.Compute/locations/usages/read (the current Rocky Surf Catalogue Reader ' +
              `role has it; redeploy deploy/azure/role.bicep). ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        quota = { until: Date.now() + (unauthorised ? QUOTA_TTL_MS : QUOTA_RETRY_MS), value: null }
        return null
      } finally {
        quotaInflight = undefined
      }
    })()
    return quotaInflight
  }

  const provider: ComputeProvider = {
    id: AZURE_PROVIDER_ID,
    displayName: 'Microsoft Azure',
    capabilities: CAPABILITIES,

    /**
     * Prove the credential, the subscription, the resource group AND the region in two calls.
     *
     * The resource group read is the cheapest authenticated call that means anything here: a
     * token that works against a subscription whose resource group this provider cannot see is
     * not working credentials for any purpose this provider has, and that is by far the most
     * likely misconfiguration given the published role is scoped to exactly one group.
     */
    async validateCredentials(): Promise<void> {
      try {
        await api.call<ArmResource>('GET', groupPath(), API_VERSIONS.resources)
      } catch (err) {
        if (isNotFound(err)) {
          throw new ProviderError(
            'invalid_spec',
            `azure resource group '${resourceGroup}' does not exist in subscription ${subscriptionId}, ` +
              `or this credential cannot see it. Create it with: az group create --name ${resourceGroup} ` +
              `--location ${location}`,
            { providerCode: azureCodeOf(err), cause: err },
          )
        }
        throw err
      }

      const locations = await api.collect<{ name?: string }>(
        `/subscriptions/${subscriptionId}/locations`,
        API_VERSIONS.resources,
      )
      if (locations.length > 0 && !locations.some((l) => l.name === location)) {
        throw new ProviderError('invalid_spec', `azure location '${location}' is not available to this subscription`)
      }
    },

    /**
     * Reject a spec before anything is created (ADR-0003, A7).
     *
     * Cheap, local, and none of it touches the network — except the offering check, which reads
     * a catalogue this provider caches after its first call.
     */
    async validateSpec(spec: ProvisionSpec): Promise<void> {
      // The VM name IS the idempotency mechanism here, so an unsafe id is not cosmetic: ARM
      // would reject some of them outright, and sanitizing is not injective (ADR-0003, C2).
      assertHostnameSafeId(spec.serverId)

      if (spec.sshPublicKeys.length === 0) {
        // Not merely our rule: `disablePasswordAuthentication: true` with no key is refused by
        // Azure, and the alternative is a VM with a password on it.
        throw new ProviderError('invalid_spec', 'at least one ssh public key is required')
      }
      if (!spec.idempotencyKey) {
        throw new ProviderError('invalid_spec', 'idempotencyKey is required — it is written as a tag and read back on replay')
      }

      const bytes = Buffer.byteLength(spec.userData, 'utf8')
      if (bytes > CAPABILITIES.userDataMaxBytes) {
        throw new ProviderError(
          'invalid_spec',
          `userData is ${bytes}B against Azure's ${CAPABILITIES.userDataMaxBytes}B customData ceiling. ` +
            'Move work out of user-data rather than raising the limit.',
        )
      }

      // Amendment D3. Without this a VM can be created that `listManaged()` will never
      // attribute, which makes it an orphan from birth.
      const declared = spec.tags[MANAGED_BY_TAG]
      if (declared !== undefined && declared !== managedBy) {
        throw new ProviderError(
          'invalid_spec',
          `tags['${MANAGED_BY_TAG}'] is '${declared}' but this provider reconciles '${managedBy}'`,
        )
      }

      const offering = (await provider.listOfferings()).find((o) => o.id === spec.offeringId)
      if (!offering) throw new ProviderError('invalid_spec', `no such offering in ${location}: ${spec.offeringId}`)
      if (offering.arch !== spec.arch) {
        throw new ProviderError(
          'invalid_spec',
          `arch ${spec.arch} does not match offering ${offering.id} (${offering.arch}). ` +
            'An Arm64 image on an x64 size is refused by Azure at create time.',
        )
      }
    },

    async listOfferings(): Promise<Offering[]> {
      return buildOfferings(await resourceSkus(), location, config.osDiskGb, await priceFeed.get(), await coreQuota())
    },

    /**
     * Create one instance — four resources, in the one order that lets the cascade work.
     *
     * Public IP, then NIC (which references the address and carries its delete option), then the
     * VM (which references the NIC and carries the disk's and the NIC's delete options). Each
     * step's resource is named deterministically from `spec.serverId`, so the whole sequence is
     * replayable: ARM's PUT is idempotent by name, and a retry of any step is a no-op rather than
     * a duplicate.
     */
    async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
      await provider.validateSpec(spec)

      const name = names(spec.serverId)
      const tags: Record<string, string> = {
        ...spec.tags,
        [MANAGED_BY_TAG]: managedBy,
        [SERVER_ID_TAG]: spec.serverId,
        [IDEMPOTENCY_TAG]: spec.idempotencyKey,
      }
      const data: AzureData = {
        vmName: name.vm,
        resourceGroup,
        subscriptionId,
        location,
        nicName: name.nic,
        publicIpName: name.pip,
        osDiskName: name.osDisk,
      }

      // IDEMPOTENCY, READ BEFORE WRITE. ARM would happily accept a PUT over an existing VM and
      // silently mutate somebody's running machine, which is precisely what an EC2 ClientToken
      // refuses to do. So the key we wrote last time is read back first.
      const existing = await findVm(name.vm)
      if (existing) {
        const previousKey = existing.tags?.[IDEMPOTENCY_TAG]
        if (previousKey !== undefined && previousKey !== spec.idempotencyKey) {
          throw new ProviderError(
            'conflict',
            `a VM named '${name.vm}' already exists in ${resourceGroup} and was created by a different ` +
              'request. This is the IdempotentParameterMismatch case: refusing rather than updating ' +
              "somebody else's machine.",
          )
        }
        // Same key, or an untagged VM this provider is re-adopting: the replay resolves to the
        // ORIGINAL instance rather than making a second one.
        return { data, initial: viewOf(existing, await addressOf(name.pip)) }
      }

      const { subnetId: subnet, nsgId: nsg } = await ensureNetwork()

      try {
        await api.call<ArmPublicIpAddress>('PUT', pipPath(name.pip), API_VERSIONS.network, {
          location,
          tags,
          // Standard is the only choice: Basic was retired on 2025-09-30. Standard is always
          // Static, which is what makes `ipStableAcrossStop` true.
          sku: { name: 'Standard', tier: 'Regional' },
          properties: { publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4' },
        })

        await api.call<ArmNetworkInterface>('PUT', nicPath(name.nic), API_VERSIONS.network, {
          location,
          tags,
          properties: {
            // The NSG rides on the NIC rather than on the subnet, so this provider never edits
            // the network configuration of a subnet an operator may share with other things.
            networkSecurityGroup: { id: nsg },
            ipConfigurations: [
              {
                name: 'ipconfig1',
                properties: {
                  primary: true,
                  privateIPAllocationMethod: 'Dynamic',
                  subnet: { id: subnet },
                  publicIPAddress: {
                    id: pipPath(name.pip),
                    // THE PUBLIC IP'S DELETE OPTION LIVES HERE, on the NIC that references it,
                    // and nowhere else. There is no field on the VM that reaches it: the chain
                    // is VM deleted -> NIC deleted -> address deleted, and a `Detach` anywhere
                    // in it strands everything downstream.
                    properties: { deleteOption: 'Delete' },
                  },
                },
              },
            ],
          },
        })

        const vm = await api.call<ArmVirtualMachine>('PUT', vmPath(name.vm), API_VERSIONS.compute, {
          location,
          tags,
          properties: {
            hardwareProfile: { vmSize: spec.offeringId },
            storageProfile: {
              imageReference: {
                publisher: config.imagePublisher,
                offer: config.imageOffer,
                sku: spec.arch === 'arm64' ? config.imageSkuArm64 : config.imageSkuAmd64,
                version: 'latest',
              },
              osDisk: {
                name: name.osDisk,
                createOption: 'FromImage',
                caching: 'ReadWrite',
                diskSizeGB: config.osDiskGb,
                managedDisk: { storageAccountType: config.osDiskType },
                deleteOption: 'Delete',
              },
            },
            osProfile: {
              computerName: name.vm,
              adminUsername: config.adminUsername,
              // cloud-init consumes customData, and Azure requires it base64-encoded. The
              // separate `properties.userData` field is NOT this: it is readable from IMDS and
              // mutable after boot, and cloud-init does not read it.
              ...(spec.userData ? { customData: Buffer.from(spec.userData, 'utf8').toString('base64') } : {}),
              linuxConfiguration: {
                disablePasswordAuthentication: true,
                provisionVMAgent: true,
                ssh: {
                  // `path` is not inferred by Azure; it must name the target account's file.
                  publicKeys: spec.sshPublicKeys.map((keyData) => ({
                    path: `/home/${config.adminUsername}/.ssh/authorized_keys`,
                    keyData: keyData.trim(),
                  })),
                },
              },
            },
            networkProfile: {
              networkInterfaces: [
                { id: nicPath(name.nic), properties: { primary: true, deleteOption: 'Delete' } },
              ],
            },
          },
        })

        // A6: hand back what the create call already knows, so core does not immediately call
        // describe() — a round trip into whatever consistency window ARM may have.
        return { data, initial: viewOf(vm) }
      } catch (err) {
        // NOTHING WILL EVER COME BACK FOR THE ADDRESS AND THE NIC (the rkh3 lesson, applied to a
        // second cloud). Every path that reaches here throws, and core's response to a throwing
        // `provision()` is to mark the row `failed` WITHOUT storing a handle — so these two
        // resources are unreachable from the database the moment this error leaves, and a public
        // IP bills whether or not anything is attached to it.
        //
        // BUT OWNERSHIP IS DECIDED BY WHAT EXISTS, NOT BY WHOSE CALL THREW. `call()` retries a
        // PUT that got no well-formed answer, so a VM this provision genuinely created can be
        // sitting there while the error in hand describes a lost response. Reaping the NIC then
        // would destroy the network interface of a live machine. So: look first.
        const created = await findVm(name.vm).catch(() => undefined)
        if (created && created.tags?.[IDEMPOTENCY_TAG] === spec.idempotencyKey) {
          return { data, initial: viewOf(created) }
        }

        await reapQuietly(name.nic, name.pip)
        throw err
      }
    },

    /**
     * Read one instance's state.
     *
     * ABSENCE IS NOT PROOF OF TERMINATION, AND THE RETRY LIVES HERE (ADR-0003, A4). Worth
     * stating plainly for this provider, because the honest answer is different from the other
     * two's: **nobody has measured whether ARM has a propagation window, because this package
     * was built without an Azure subscription.** ARM is generally read-after-write consistent on
     * a resource's own URI, so the EC2 window may well not exist here. That is a reason to
     * expect the grace to be cheap, not a reason to skip it — the rule says a provider may
     * lengthen it and may never skip it, and `provider-aws` is the standing evidence for why:
     * it shipped without the grace, believed a first not-found, and core marked a running,
     * billing instance dead while eighty-five tests stayed green (rockysurf-gyp1.4).
     *
     * It is also nearly free. The grace applies only to an instance never observed running, so
     * the teardown loop — where every instance has been running — never pays for it.
     *
     * `rockysurf-ihtq.8`, the owner-gated real-Azure run, is what can replace this reasoning
     * with a measurement.
     */
    async describe(data: ProviderData): Promise<InstanceView> {
      const handle = asAzureData(data)
      const attempts = seenRunning.has(handle.vmName) ? 1 : Math.max(1, grace.attempts)

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const vm = await findVm(handle.vmName, { expandInstanceView: true })
        if (vm) {
          const view = viewOf(vm)
          // Skip the address read for a box on its way out: it is about to stop existing, and
          // core does not need an address to finish a teardown.
          if (view.state === 'terminating' || view.state === 'terminated') return view
          const publicIp = await addressOf(handle.publicIpName)
          return publicIp ? { ...view, publicIp } : view
        }
        if (attempt < attempts) {
          await sleep(grace.delayMs)
          continue
        }
        // Absence, believed. A vanished instance is a normal teardown outcome, never an error:
        // core polls this in a loop and throwing would make success an error path.
        return { state: 'terminated' }
      }

      return { state: 'terminated' }
    },

    /**
     * Destroy the instance and everything created for it.
     *
     * ONE DELETE, THREE CASCADES — see the note at the top of this file. What is left here is
     * the case the cascade cannot cover: a handle whose VM never existed, because a create
     * failed after the address and the NIC were made and the quiet reap could not finish. Then
     * nothing holds those two resources, there is no race with a VM deletion, and deleting them
     * directly is both safe and the only thing that will ever collect them.
     */
    async terminate(data: ProviderData): Promise<void> {
      const handle = asAzureData(data)

      let vmExisted = true
      try {
        await api.call<void>('DELETE', vmPath(handle.vmName), API_VERSIONS.compute)
      } catch (err) {
        // Idempotent: not-found is SUCCESS. A second call is a no-op, not an error.
        if (!isNotFound(err)) throw err
        vmExisted = false
      }

      seenRunning.delete(handle.vmName)
      addressCache.delete(handle.publicIpName)

      if (!vmExisted) {
        await deleteIgnoringNotFound(nicPath(handle.nicName), API_VERSIONS.network)
        await deleteIgnoringNotFound(pipPath(handle.publicIpName), API_VERSIONS.network)
      }
    },

    /**
     * Everything attributable to this installation.
     *
     * THE WHOLE RESOURCE GROUP IS LISTED, not a tag-filtered subset, and that is a deliberate
     * consequence of the shared-resource-group decision in `config.ts`. Two reasons, and the
     * second is the one that matters:
     *
     *  1. ARM's `$filter=tagName eq … and tagValue eq …` DOES NOT RETURN THE TAGS of the
     *     resources it matches — so a filtered listing can find a resource and then cannot say
     *     which server it belongs to. The reconciler needs both.
     *  2. **Azure does not copy a VM's tags onto the OS disk it creates from an image.** A
     *     tag-filtered sweep would therefore never see a disk at all, which is the exact orphan
     *     class ADR-0003 (D4) exists to prevent: a volume that survives its instance, bills
     *     forever, and is invisible to any audit that walks instances. A disk left behind is
     *     attributed here through its `managedBy`, which points at the VM that owns it, and is
     *     still reported when that is gone — as an owned resource nobody can attribute, which
     *     the SDK models on purpose and which is precisely the finding worth surfacing.
     *
     * The resource group is Rocky Surf's own by configuration and by the scope its published
     * role is granted at, so listing all of it is not overreach.
     */
    async listManaged(): Promise<ManagedResource[]> {
      const resources = await api.collect<ArmResource & { managedBy?: string }>(
        `${groupPath()}/resources`,
        API_VERSIONS.resources,
      )

      return resources.flatMap<ManagedResource>((resource) => {
        const kind = KIND_BY_TYPE[resource.type] ?? resource.type
        const ownership = SHARED_TYPES.has(resource.type) ? 'shared' : 'server-owned'

        // A resource carrying somebody else's managed-by tag is somebody else's. An UNTAGGED one
        // is not dismissed the same way: that is what an orphaned disk looks like.
        const tagged = resource.tags?.[MANAGED_BY_TAG]
        if (tagged !== undefined && tagged !== managedBy) return []

        const serverId = resource.tags?.[SERVER_ID_TAG] ?? vmNameFrom(resource.managedBy)
        return [
          {
            kind,
            providerNativeId: resource.id,
            ownership,
            ...(ownership === 'server-owned' && serverId ? { serverId } : {}),
          },
        ]
      })
    },

    /**
     * DEALLOCATE, not power off.
     *
     * Both preserve the disk and only one stops the bill: a powered-off Azure VM is charged the
     * full compute rate for doing nothing, so `powerOff` would make `capabilities.stop` true
     * while delivering none of what core uses it for — idle auto-stop is v0.1's cost lever
     * (ADR-0003). The disk and the address keep billing either way, which is the honest cost of
     * a box you can start again.
     *
     * The long-running operation is not awaited: `describe()` is the poller, and blocking here
     * would make a fast call slow for everyone.
     */
    async stop(data: ProviderData): Promise<void> {
      if (!CAPABILITIES.stop) throw unsupportedOperationError(AZURE_PROVIDER_ID, 'stop')
      const { vmName } = asAzureData(data)
      await api.call<unknown>('POST', `${vmPath(vmName)}/deallocate`, API_VERSIONS.compute, {})
      seenRunning.delete(vmName)
    },

    async start(data: ProviderData): Promise<void> {
      if (!CAPABILITIES.stop) throw unsupportedOperationError(AZURE_PROVIDER_ID, 'start')
      const { vmName } = asAzureData(data)
      await api.call<unknown>('POST', `${vmPath(vmName)}/start`, API_VERSIONS.compute, {})
      // The address survives a deallocate (ipStableAcrossStop: true), so unlike EC2 there is
      // nothing for core to re-read afterwards.
    },
  }

  /** One VM by name, or undefined. Not-found is an answer here, never an error. */
  async function findVm(
    vmName: string,
    options: { expandInstanceView?: boolean } = {},
  ): Promise<ArmVirtualMachine | undefined> {
    const path = options.expandInstanceView ? `${vmPath(vmName)}?$expand=instanceView` : vmPath(vmName)
    try {
      return await api.call<ArmVirtualMachine>('GET', path, API_VERSIONS.compute)
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
  }

  return provider
}

/**
 * ARM resource types that outlive the servers they serve.
 *
 * Reported by `listManaged()` so an audit can account for them, NOT so a reconciler can reap
 * them: deleting either of these breaks every running instance in the group (ADR-0003, D1).
 */
const SHARED_TYPES: ReadonlySet<string> = new Set([
  'Microsoft.Network/virtualNetworks',
  'Microsoft.Network/networkSecurityGroups',
])

/** ARM type → the free-form `kind` an audit prints. Core never branches on it. */
const KIND_BY_TYPE: Readonly<Record<string, string>> = {
  'Microsoft.Compute/virtualMachines': 'instance',
  'Microsoft.Compute/disks': 'disk',
  'Microsoft.Network/networkInterfaces': 'network-interface',
  'Microsoft.Network/publicIPAddresses': 'public-ip',
  'Microsoft.Network/virtualNetworks': 'virtual-network',
  'Microsoft.Network/networkSecurityGroups': 'network-security-group',
}

/**
 * The VM name out of a `managedBy` resource id, which is how an untagged OS disk is attributed.
 *
 * Azure sets `managedBy` on a managed disk to the resource id of the VM it is attached to. Since
 * a VM's name IS the server id here, that is a complete attribution — and it is the only one
 * available, because Azure does not copy the VM's tags onto the disk.
 */
export function vmNameFrom(managedBy: string | undefined): string | undefined {
  const match = /\/providers\/Microsoft\.Compute\/virtualMachines\/([^/]+)$/i.exec(managedBy ?? '')
  return match?.[1]
}

/** Re-exported so the composition root and tests can name the architectures without the SDK. */
export type { Architecture }
