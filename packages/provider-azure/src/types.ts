/**
 * Azure Resource Manager wire types — only the fields this provider reads or writes.
 *
 * Transcribed from the REST reference for the api-versions pinned in `api.ts`. Kept deliberately
 * partial, the way `provider-hetzner`'s are: modelling fields nobody uses invites drift with an
 * API that adds them faster than we read them, and ARM adds them very fast.
 */

/** Every ARM resource carries these. */
export interface ArmResource {
  id: string
  name: string
  type: string
  location?: string
  tags?: Record<string, string>
}

/* -------------------------------------------------------------------------------- compute */

/**
 * A VM's lifecycle state as ARM reports it. Distinct from its POWER state, which lives in the
 * instance view — `provisioningState: 'Succeeded'` says the machine was built, not that it is on.
 */
export type ArmProvisioningState =
  | 'Creating'
  | 'Updating'
  | 'Succeeded'
  | 'Failed'
  | 'Deleting'
  | 'Migrating'
  | string

export interface ArmInstanceViewStatus {
  /** `PowerState/running`, `ProvisioningState/succeeded`, `ProvisioningState/failed/…`. */
  code?: string
  level?: 'Info' | 'Warning' | 'Error' | string
  displayStatus?: string
  message?: string
}

export interface ArmVirtualMachine extends ArmResource {
  properties?: {
    provisioningState?: ArmProvisioningState
    hardwareProfile?: { vmSize?: string }
    instanceView?: { statuses?: ArmInstanceViewStatus[] }
    networkProfile?: { networkInterfaces?: { id?: string }[] }
    storageProfile?: { osDisk?: { name?: string; managedDisk?: { id?: string } } }
  }
}

/**
 * One purchasable SKU in one location, from `Microsoft.Compute/skus`.
 *
 * Both halves of an offering come from here: `capabilities` carries vCPU and memory, so the
 * shape can never disagree with what Azure will actually sell, and `restrictions` carries the
 * per-SUBSCRIPTION availability that `Offering.available` exists for (ADR-0003, B1).
 */
export interface ArmResourceSku {
  name?: string
  resourceType?: string
  locations?: string[]
  capabilities?: { name?: string; value?: string }[]
  restrictions?: {
    /** `Location` or `Zone`. A whole-location restriction means this subscription cannot order it. */
    type?: string
    /** `NotAvailableForSubscription`, `QuotaId`, … */
    reasonCode?: string
    restrictionInfo?: { locations?: string[]; zones?: string[] }
  }[]
}

/* -------------------------------------------------------------------------------- network */

export interface ArmPublicIpAddress extends ArmResource {
  sku?: { name?: string; tier?: string }
  properties?: {
    provisioningState?: ArmProvisioningState
    publicIPAllocationMethod?: string
    ipAddress?: string
    dnsSettings?: { fqdn?: string }
  }
}

export interface ArmNetworkInterface extends ArmResource {
  properties?: {
    provisioningState?: ArmProvisioningState
    ipConfigurations?: {
      name?: string
      properties?: {
        privateIPAddress?: string
        publicIPAddress?: { id?: string; properties?: { ipAddress?: string } }
        subnet?: { id?: string }
      }
    }[]
    networkSecurityGroup?: { id?: string }
  }
}

export interface ArmSubnet extends ArmResource {
  properties?: { addressPrefix?: string; addressPrefixes?: string[] }
}

export interface ArmVirtualNetwork extends ArmResource {
  properties?: {
    provisioningState?: ArmProvisioningState
    addressSpace?: { addressPrefixes?: string[] }
    subnets?: ArmSubnet[]
  }
}

export interface ArmSecurityRule {
  name?: string
  properties?: {
    protocol?: string
    sourceAddressPrefix?: string
    sourcePortRange?: string
    destinationAddressPrefix?: string
    destinationPortRange?: string
    access?: 'Allow' | 'Deny' | string
    direction?: 'Inbound' | 'Outbound' | string
    priority?: number
    description?: string
  }
}

export interface ArmNetworkSecurityGroup extends ArmResource {
  properties?: {
    provisioningState?: ArmProvisioningState
    securityRules?: ArmSecurityRule[]
  }
}
