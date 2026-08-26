/**
 * An in-memory Azure Resource Manager, for this package's tests.
 *
 * WHY A FAKE CLOUD RATHER THAN A ROUTE TABLE OF CANNED RESPONSES. The thing worth testing about
 * this provider is not "does it send the right JSON" — it is whether four resources that must be
 * created in one order and reaped in another actually end up gone. A route table cannot answer
 * that, because it has no state to be wrong about. This one holds resources in a map, so a test
 * can terminate a VM and then ASSERT THE DISK IS NOT THERE, which is the property the whole
 * provider is built around.
 *
 * It models exactly the ARM behaviours the provider depends on and no more:
 *
 *  - PUT creates or replaces by path, and is therefore idempotent by name the way ARM is
 *  - DELETE on a virtual machine honours the three `deleteOption: 'Delete'` fields, cascading to
 *    the OS disk and the NIC, and from the NIC to the public IP
 *  - creating a VM materialises its OS disk as a separate resource with `managedBy` pointing back
 *    at the VM and NO TAGS COPIED, which is the real Azure behaviour that `listManaged()` has to
 *    cope with
 *  - a public IP is assigned an address on create, and keeps it across deallocate/start
 *
 * Nothing here is exported from the package: it is excluded from the build in
 * `tsconfig.build.json`.
 */

import { ARM_BASE } from './api.js'
import { ENTRA_AUTHORITY } from './credentials.js'

export interface FakeResource {
  id: string
  name: string
  type: string
  location?: string
  tags?: Record<string, string>
  sku?: Record<string, unknown>
  properties?: Record<string, unknown>
  managedBy?: string
}

/** One recorded request, so a test can assert what was called and how often. */
export interface RecordedCall {
  method: string
  /** The path with the query string, as the provider built it. */
  path: string
  body?: unknown
}

export interface FakeArmOptions {
  subscriptionId?: string
  resourceGroup?: string
  location?: string
  /** Whether `GET /subscriptions/{s}/resourceGroups/{rg}` answers. False makes it 404. */
  resourceGroupExists?: boolean
  /** VM sizes the fake subscription may order, with their shapes. */
  skus?: {
    name: string
    cpu: number
    memoryGb: number
    arch: 'x64' | 'Arm64'
    restricted?: boolean
    /** Defaults to `['V1', 'V2']` — the common case. Set to `['V1']` for a Gen1-only fixture. */
    hyperVGenerations?: string[]
    /** Quota family. Defaults to one derived from the name, so every size has its own row. */
    family?: string
  }[]
  /**
   * Core quota rows served from `locations/{location}/usages` (issue #116). When absent, every
   * SKU family gets `limit: 10, currentValue: 0` and the regional total 100 — a subscription
   * with room, which is what the tests written before quota existed assumed.
   */
  usages?: { family: string; limit: number; currentValue?: number }[]
  /** The regional `cores` row. Defaults to limit 100. */
  regionalCores?: { limit: number; currentValue?: number }
}

/** The quota family a fake SKU draws from, when the fixture did not name one. */
const familyOf = (name: string): string => `fake${name.replace(/^Standard_/, '')}Family`

const DEFAULT_SKUS: NonNullable<FakeArmOptions['skus']> = [
  { name: 'Standard_B2ls_v2', cpu: 2, memoryGb: 4, arch: 'x64' },
  { name: 'Standard_B2s_v2', cpu: 2, memoryGb: 8, arch: 'x64' },
  { name: 'Standard_B2pls_v2', cpu: 2, memoryGb: 4, arch: 'Arm64' },
  { name: 'Standard_B2ps_v2', cpu: 2, memoryGb: 8, arch: 'Arm64' },
  { name: 'Standard_D2s_v5', cpu: 2, memoryGb: 8, arch: 'x64' },
  { name: 'Standard_D2ps_v5', cpu: 2, memoryGb: 8, arch: 'Arm64' },
]

/** A failure a test scripts onto the next matching call. */
interface ScriptedFailure {
  method: string
  pathIncludes: string
  status: number
  code: string
  message: string
  /** How many times to fail before letting the call through. Infinity by default. */
  times: number
}

export class FakeArm {
  readonly subscriptionId: string
  readonly resourceGroup: string
  readonly location: string
  readonly calls: RecordedCall[] = []
  /** path (lower-cased) → resource. */
  readonly resources = new Map<string, FakeResource>()

  private readonly skus: NonNullable<FakeArmOptions['skus']>
  private readonly usages: FakeArmOptions['usages']
  private readonly regionalCores: NonNullable<FakeArmOptions['regionalCores']>
  private readonly failures: ScriptedFailure[] = []
  private resourceGroupExists: boolean
  private addressCounter = 0
  private tokenIssued = 0

  constructor(options: FakeArmOptions = {}) {
    this.subscriptionId = options.subscriptionId ?? '00000000-0000-0000-0000-000000000000'
    this.resourceGroup = options.resourceGroup ?? 'rocky-surf-rg'
    this.location = options.location ?? 'eastus'
    this.resourceGroupExists = options.resourceGroupExists ?? true
    this.skus = options.skus ?? DEFAULT_SKUS
    this.usages = options.usages
    this.regionalCores = options.regionalCores ?? { limit: 100 }
  }

  /** How many bearer tokens the fake Entra endpoint has issued. Proves the token cache works. */
  tokensIssued(): number {
    return this.tokenIssued
  }

  /** Fail the next `times` calls matching method + a path substring, then behave normally. */
  failNext(
    method: string,
    pathIncludes: string,
    failure: { status?: number; code?: string; message?: string; times?: number } = {},
  ): void {
    this.failures.push({
      method,
      pathIncludes,
      status: failure.status ?? 500,
      code: failure.code ?? 'InternalServerError',
      message: failure.message ?? 'scripted failure',
      times: failure.times ?? Number.POSITIVE_INFINITY,
    })
  }

  /** Every resource of one ARM type currently in the fake group. */
  ofType(type: string): FakeResource[] {
    return [...this.resources.values()].filter((r) => r.type.toLowerCase() === type.toLowerCase())
  }

  /** Whether a resource exists, by the tail of its id. */
  has(type: string, name: string): boolean {
    return this.ofType(type).some((r) => r.name === name)
  }

  /** Drive a created VM to `Succeeded` / `PowerState/running`, as Azure would after a minute. */
  advanceToRunning(vmName: string): void {
    const vm = this.ofType('Microsoft.Compute/virtualMachines').find((r) => r.name === vmName)
    if (!vm) throw new Error(`fake: no VM named ${vmName}`)
    vm.properties = { ...vm.properties, provisioningState: 'Succeeded', powerState: 'running' }
  }

  /** Put a VM into an arbitrary state, for the states a lifecycle would not otherwise reach. */
  setVmState(vmName: string, provisioningState: string, powerState?: string): void {
    const vm = this.ofType('Microsoft.Compute/virtualMachines').find((r) => r.name === vmName)
    if (!vm) throw new Error(`fake: no VM named ${vmName}`)
    vm.properties = { ...vm.properties, provisioningState, ...(powerState ? { powerState } : {}) }
  }

  /** Remove a resource behind the provider's back, to model a teardown it did not make. */
  vanish(type: string, name: string): void {
    for (const [key, resource] of this.resources) {
      if (resource.type.toLowerCase() === type.toLowerCase() && resource.name === name) {
        this.resources.delete(key)
        this.detachFrom(resource.id)
      }
    }
  }

  /**
   * Clear `managedBy` on anything the departed resource owned.
   *
   * A managed disk whose VM is gone is DETACHED, not still claimed by a resource id that no
   * longer resolves — which is exactly what makes an orphaned disk unattributable, since Azure
   * never copied the VM's tags onto it either.
   */
  private detachFrom(ownerId: string): void {
    for (const resource of this.resources.values()) {
      if (resource.managedBy?.toLowerCase() === ownerId.toLowerCase()) delete resource.managedBy
    }
  }

  /** The `fetch` implementation to hand the provider. */
  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()

    // The Entra token endpoint, so one fetch drives the whole provider including its credentials.
    // Checked before the body is read: a token request is form-encoded, not JSON.
    if (url.startsWith(ENTRA_AUTHORITY)) {
      this.tokenIssued++
      return json(200, { token_type: 'Bearer', expires_in: 3599, access_token: `fake-token-${this.tokenIssued}` })
    }
    // Off an Azure VM there is no managed identity, which is the state a test runs in.
    if (url.includes('169.254.169.254')) return json(400, { error: 'no managed identity in a test' })

    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const path = url.startsWith(ARM_BASE) ? url.slice(ARM_BASE.length) : url
    this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) })

    const scripted = this.failures.find((f) => f.method === method && path.includes(f.pathIncludes) && f.times > 0)
    if (scripted) {
      scripted.times -= 1
      return json(scripted.status, { error: { code: scripted.code, message: scripted.message } })
    }

    return this.route(method, path, body)
  }

  private route(method: string, rawPath: string, body: unknown): Response {
    const [pathOnly = rawPath, query = ''] = rawPath.split('?')
    const group = `/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}`

    // GET /subscriptions/{s}/locations
    if (method === 'GET' && pathOnly === `/subscriptions/${this.subscriptionId}/locations`) {
      return json(200, { value: [{ name: this.location }, { name: 'westeurope' }] })
    }

    // GET /subscriptions/{s}/providers/Microsoft.Compute/skus
    if (method === 'GET' && pathOnly.endsWith('/providers/Microsoft.Compute/skus')) {
      return json(200, {
        value: this.skus.map((sku) => ({
          name: sku.name,
          resourceType: 'virtualMachines',
          family: sku.family ?? familyOf(sku.name),
          locations: [this.location],
          capabilities: [
            { name: 'vCPUs', value: String(sku.cpu) },
            { name: 'MemoryGB', value: String(sku.memoryGb) },
            { name: 'CpuArchitectureType', value: sku.arch },
            { name: 'HyperVGenerations', value: (sku.hyperVGenerations ?? ['V1', 'V2']).join(',') },
          ],
          restrictions: sku.restricted
            ? [
                {
                  type: 'Location',
                  reasonCode: 'NotAvailableForSubscription',
                  restrictionInfo: { locations: [this.location] },
                },
              ]
            : [],
        })),
      })
    }

    // GET /subscriptions/{s}/providers/Microsoft.Compute/locations/{l}/usages — core quota
    if (method === 'GET' && /\/providers\/Microsoft\.Compute\/locations\/[^/]+\/usages$/.test(pathOnly)) {
      const families =
        this.usages ??
        this.skus.map((sku) => ({ family: sku.family ?? familyOf(sku.name), limit: 10, currentValue: 0 }))
      const row = (value: string, limit: number, currentValue: number) => ({
        name: { value, localizedValue: value },
        currentValue,
        limit,
        unit: 'Count',
      })
      return json(200, {
        value: [
          row('cores', this.regionalCores.limit, this.regionalCores.currentValue ?? 0),
          ...families.map((f) => row(f.family, f.limit, f.currentValue ?? 0)),
        ],
      })
    }

    // GET {group}/resources — the reconciler's whole input
    if (method === 'GET' && pathOnly === `${group}/resources`) {
      return json(200, { value: [...this.resources.values()] })
    }

    // GET {group} — the resource group itself
    if (method === 'GET' && pathOnly === group) {
      return this.resourceGroupExists
        ? json(200, { id: group, name: this.resourceGroup, type: 'Microsoft.Resources/resourceGroups' })
        : notFound(`Resource group '${this.resourceGroup}' could not be found.`)
    }

    // POST {vm}/deallocate | /start
    if (method === 'POST' && /\/(deallocate|start|powerOff)$/.test(pathOnly)) {
      const action = pathOnly.slice(pathOnly.lastIndexOf('/') + 1)
      const vm = this.resources.get(pathOnly.slice(0, pathOnly.lastIndexOf('/')).toLowerCase())
      if (!vm) return notFound('The Resource could not be found.')
      vm.properties = {
        ...vm.properties,
        provisioningState: 'Succeeded',
        powerState: action === 'start' ? 'running' : action === 'deallocate' ? 'deallocated' : 'stopped',
      }
      return new Response(null, { status: 202 })
    }

    const key = pathOnly.toLowerCase()

    if (method === 'GET') {
      const resource = this.resources.get(key)
      if (!resource) return notFound(`The Resource '${pathOnly}' was not found.`)
      return json(200, this.present(resource, query))
    }

    if (method === 'PUT') {
      return json(200, this.put(pathOnly, body as Record<string, unknown>))
    }

    if (method === 'DELETE') {
      const resource = this.resources.get(key)
      if (!resource) return notFound(`The Resource '${pathOnly}' was not found.`)
      this.cascadeDelete(resource)
      return new Response(null, { status: 202 })
    }

    return json(400, { error: { code: 'InvalidRequestContent', message: `fake: unrouted ${method} ${pathOnly}` } })
  }

  /** A GET's projection, which is where `$expand=instanceView` is honoured. */
  private present(resource: FakeResource, query: string): FakeResource {
    if (!query.includes('$expand=instanceView')) return resource
    const powerState = resource.properties?.['powerState']
    const provisioningState = resource.properties?.['provisioningState']
    return {
      ...resource,
      properties: {
        ...resource.properties,
        instanceView: {
          statuses: [
            { code: `ProvisioningState/${String(provisioningState).toLowerCase()}`, level: 'Info' },
            ...(powerState
              ? [{ code: `PowerState/${String(powerState)}`, level: 'Info', displayStatus: `VM ${String(powerState)}` }]
              : []),
            ...(provisioningState === 'Failed'
              ? [{ code: 'ProvisioningState/failed/AllocationFailed', level: 'Error', message: 'no capacity' }]
              : []),
          ],
        },
      },
    }
  }

  private put(path: string, body: Record<string, unknown>): FakeResource {
    const type = typeOf(path)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const existing = this.resources.get(path.toLowerCase())

    const resource: FakeResource = {
      id: path,
      name,
      type,
      ...(typeof body?.['location'] === 'string' ? { location: body['location'] } : { location: this.location }),
      ...(body?.['tags'] ? { tags: body['tags'] as Record<string, string> } : {}),
      ...(body?.['sku'] ? { sku: body['sku'] as Record<string, unknown> } : {}),
      properties: { ...((body?.['properties'] as Record<string, unknown>) ?? {}), provisioningState: 'Succeeded' },
    }

    if (type === 'Microsoft.Network/virtualNetworks') {
      // Real ARM returns a vnet's subnets WITH their ids, both from the PUT that created them
      // inline and from every later GET. The fake used to echo the request body untouched, so
      // its inline subnets had no `id` — and the provider, which adopts a subnet only when it
      // can see one, re-wrote the subnet as a child on every single provision. That made a
      // faithful adopt path look like a rewrite, and it is why the shared-network test could
      // only pass while ensureNetwork() was memoized (rockysurf-3l4g).
      const subnets = (resource.properties?.['subnets'] as { name?: string }[] | undefined) ?? []
      resource.properties = {
        ...resource.properties,
        subnets: subnets.map((subnet) => ({ ...subnet, id: `${path}/subnets/${subnet.name}` })),
      }
    }

    if (type === 'Microsoft.Network/virtualNetworks/subnets') {
      // A child PUT has to become visible on the parent, or the next GET of the vnet reports a
      // subnet that demonstrably exists as missing.
      const vnetPath = path.slice(0, path.indexOf('/subnets/'))
      const vnet = this.resources.get(vnetPath.toLowerCase())
      if (vnet) {
        const siblings = ((vnet.properties?.['subnets'] as { name?: string }[] | undefined) ?? []).filter(
          (subnet) => subnet.name !== name,
        )
        vnet.properties = { ...vnet.properties, subnets: [...siblings, { ...resource, id: path }] }
      }
    }

    if (type === 'Microsoft.Network/publicIPAddresses') {
      // Assigned once and kept: a Standard SKU address is Static, which is the whole basis of
      // `ipStableAcrossStop`.
      const address = (existing?.properties?.['ipAddress'] as string | undefined) ?? `20.0.0.${++this.addressCounter}`
      resource.properties = { ...resource.properties, ipAddress: address }
    }

    if (type === 'Microsoft.Compute/virtualMachines') {
      resource.properties = { ...resource.properties, provisioningState: 'Creating', powerState: 'starting' }
      // The OS disk materialises as its OWN resource, with `managedBy` pointing back at the VM
      // and — as on real Azure — NONE of the VM's tags copied onto it.
      const storage = body?.['properties'] as { storageProfile?: { osDisk?: { name?: string } } } | undefined
      const diskName = storage?.storageProfile?.osDisk?.name ?? `${name}-osdisk`
      const diskPath = `/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Compute/disks/${diskName}`
      this.resources.set(diskPath.toLowerCase(), {
        id: diskPath,
        name: diskName,
        type: 'Microsoft.Compute/disks',
        location: this.location,
        managedBy: path,
        properties: { provisioningState: 'Succeeded' },
      })
    }

    this.resources.set(path.toLowerCase(), resource)
    return resource
  }

  /**
   * DELETE, with the `deleteOption` chain real Azure implements.
   *
   * VM -> its OS disk (osDisk.deleteOption) and its NIC (networkInterfaces[].properties
   * .deleteOption); NIC -> its public IP (ipConfigurations[].properties.publicIPAddress
   * .properties.deleteOption). A `Detach` anywhere strands everything below it, which is what
   * makes the cascade worth modelling rather than assuming.
   */
  private cascadeDelete(resource: FakeResource): void {
    this.resources.delete(resource.id.toLowerCase())
    // Whatever it owned and did not take with it is detached, not still pointing at a dead id.
    this.detachFrom(resource.id)

    if (resource.type === 'Microsoft.Compute/virtualMachines') {
      const props = resource.properties as
        | {
            storageProfile?: { osDisk?: { name?: string; deleteOption?: string } }
            networkProfile?: { networkInterfaces?: { id?: string; properties?: { deleteOption?: string } }[] }
          }
        | undefined

      const osDisk = props?.storageProfile?.osDisk
      if (osDisk?.deleteOption === 'Delete') {
        this.vanish('Microsoft.Compute/disks', osDisk.name ?? `${resource.name}-osdisk`)
      }

      for (const nic of props?.networkProfile?.networkInterfaces ?? []) {
        if (nic.properties?.deleteOption !== 'Delete' || !nic.id) continue
        const nicResource = this.resources.get(nic.id.toLowerCase())
        if (nicResource) this.cascadeDelete(nicResource)
      }
      return
    }

    if (resource.type === 'Microsoft.Network/networkInterfaces') {
      const props = resource.properties as
        | {
            ipConfigurations?: {
              properties?: { publicIPAddress?: { id?: string; properties?: { deleteOption?: string } } }
            }[]
          }
        | undefined
      for (const config of props?.ipConfigurations ?? []) {
        const pip = config.properties?.publicIPAddress
        if (pip?.properties?.deleteOption === 'Delete' && pip.id) this.resources.delete(pip.id.toLowerCase())
      }
    }
  }
}

/** `/subscriptions/…/providers/Microsoft.Network/publicIPAddresses/foo` → the type segment. */
function typeOf(path: string): string {
  const match = /\/providers\/([^/]+)\/([^/]+)\//.exec(`${path}/`)
  if (!match) return 'Unknown/unknown'
  // Child resources (`/virtualNetworks/v/subnets/s`) name their parent type plus the child's.
  const child = /\/providers\/[^/]+\/[^/]+\/[^/]+\/([^/]+)\/[^/]+$/.exec(path)
  return child ? `${match[1]}/${match[2]}/${child[1]}` : `${match[1]}/${match[2]}`
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function notFound(message: string): Response {
  return json(404, { error: { code: 'ResourceNotFound', message } })
}
