import { isProviderError, type ComputeProvider, type ProvisionSpec } from '@rockysurf/provider-sdk'
import { describe, expect, it } from 'vitest'
import { FakeArm } from './arm-fake.js'
import { azureConfigSchema, type AzureProviderConfig } from './config.js'
import { CredentialChain } from './credentials.js'
import type { PriceFeedDoc } from './feed.js'
import { instanceStateOf, makeAzureProvider, powerStateOf, vmNameFrom } from './provider.js'

/**
 * The Azure provider, driven against an in-memory ARM (`arm-fake.ts`).
 *
 * The suite is organised around the one thing that makes this provider different from the other
 * two: an instance is FOUR resources, and the tests that matter most are the ones that assert
 * what is left in the fake resource group after something goes wrong.
 */

function configFor(fake: FakeArm, overrides: Partial<AzureProviderConfig> = {}): AzureProviderConfig {
  return azureConfigSchema.parse({
    subscriptionId: fake.subscriptionId,
    resourceGroup: fake.resourceGroup,
    location: fake.location,
    sshAllowedCidr: '203.0.113.7/32',
    ...overrides,
  })
}

/**
 * A fake hosted price feed (gh issue #100): prices come from `feed.ts` at runtime now, so
 * these tests hand the provider a canned document instead of letting it fetch. It covers
 * eastus only — a provider pointed anywhere else gets `hourly: null`, same as production.
 */
const FEED_FETCHED_AT = '2026-08-25T00:00:00.000Z'
const FEED: PriceFeedDoc = {
  fetchedAt: FEED_FETCHED_AT,
  currency: 'USD',
  regions: {
    eastus: {
      Standard_B2ls_v2: 0.0304,
      Standard_B2s_v2: 0.0608,
      Standard_B2pls_v2: 0.0244,
      Standard_B2ps_v2: 0.0486,
      Standard_D2s_v5: 0.096,
      Standard_D2ps_v5: 0.077,
    },
  },
}
const feedOf = (doc: PriceFeedDoc | null) => ({ get: async () => doc })

function providerFor(
  fake: FakeArm,
  overrides: Partial<AzureProviderConfig> = {},
  priceFeed: { get(): Promise<PriceFeedDoc | null> } = feedOf(FEED),
): ComputeProvider {
  return makeAzureProvider({
    config: configFor(fake, overrides),
    priceFeed,
    fetchImpl: fake.fetch,
    credentials: new CredentialChain({
      fetchImpl: fake.fetch,
      env: {
        AZURE_TENANT_ID: 'tenant',
        AZURE_CLIENT_ID: 'client',
        AZURE_CLIENT_SECRET: 'secret',
      },
      allowAzureCli: false,
    }),
    // Retries and the propagation grace both cost wall-clock time and neither is what most of
    // these tests are about. The grace's own suite reinstates a real attempt count.
    sleep: async () => {},
    maxRetries: 0,
  })
}

function specFor(overrides: Partial<ProvisionSpec> = {}): ProvisionSpec {
  return {
    serverId: 'dev-box-1',
    name: 'dev box 1',
    offeringId: 'Standard_B2ps_v2',
    arch: 'arm64',
    sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example'],
    userData: '#cloud-config\nssh_keys:\n  ed25519_private: |\n    KEY\n',
    tags: { 'managed-by': 'rockysurf', 'server-id': 'dev-box-1' },
    idempotencyKey: 'gen-1-abc',
    ...overrides,
  }
}

const VM = 'Microsoft.Compute/virtualMachines'
const DISK = 'Microsoft.Compute/disks'
const NIC = 'Microsoft.Network/networkInterfaces'
const PIP = 'Microsoft.Network/publicIPAddresses'

describe('provision', () => {
  it('creates the address, the interface and the machine, and reports an initial view', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)

    const result = await provider.provision(specFor())

    expect(fake.has(PIP, 'dev-box-1-ip')).toBe(true)
    expect(fake.has(NIC, 'dev-box-1-nic')).toBe(true)
    expect(fake.has(VM, 'dev-box-1')).toBe(true)
    expect(fake.has(DISK, 'dev-box-1-osdisk')).toBe(true)

    expect(result.data['vmName']).toBe('dev-box-1')
    expect(result.data['publicIpName']).toBe('dev-box-1-ip')
    // A6: the create call already knows the state, so core need not immediately describe().
    expect(result.initial.state).toBe('pending')
    expect(result.initial.consoleUrl).toContain('portal.azure.com')
  })

  it('sets every deleteOption the cascade depends on', async () => {
    const fake = new FakeArm()
    await providerFor(fake).provision(specFor())

    const vm = fake.ofType(VM)[0]!.properties as {
      storageProfile: { osDisk: { deleteOption: string } }
      networkProfile: { networkInterfaces: { properties: { deleteOption: string } }[] }
    }
    expect(vm.storageProfile.osDisk.deleteOption).toBe('Delete')
    expect(vm.networkProfile.networkInterfaces[0]!.properties.deleteOption).toBe('Delete')

    // The public IP's delete option is a property of the NIC that references it, and there is no
    // field on the VM that reaches it. Getting this one wrong strands a billable address.
    const nic = fake.ofType(NIC)[0]!.properties as {
      ipConfigurations: { properties: { publicIPAddress: { properties: { deleteOption: string } } } }[]
    }
    expect(nic.ipConfigurations[0]!.properties.publicIPAddress.properties.deleteOption).toBe('Delete')
  })

  it('base64-encodes the cloud-config into customData, which is what cloud-init reads', async () => {
    const fake = new FakeArm()
    const spec = specFor()
    await providerFor(fake).provision(spec)

    const osProfile = (fake.ofType(VM)[0]!.properties as { osProfile: { customData: string; adminUsername: string } })
      .osProfile
    expect(Buffer.from(osProfile.customData, 'base64').toString('utf8')).toBe(spec.userData)
    expect(osProfile.adminUsername).toBe('azureuser')
  })

  it('picks the arm64 image sku for an arm64 spec and the amd64 one otherwise', async () => {
    const arm = new FakeArm()
    await providerFor(arm).provision(specFor())
    const armImage = (arm.ofType(VM)[0]!.properties as { storageProfile: { imageReference: { sku: string } } })
      .storageProfile.imageReference
    expect(armImage.sku).toBe('server-arm64')

    const amd = new FakeArm()
    await providerFor(amd).provision(specFor({ arch: 'amd64', offeringId: 'Standard_B2s_v2' }))
    const amdImage = (amd.ofType(VM)[0]!.properties as { storageProfile: { imageReference: { sku: string } } })
      .storageProfile.imageReference
    expect(amdImage.sku).toBe('server')
  })

  it('creates the shared network once and adopts it on the next provision', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)

    await provider.provision(specFor())
    const afterFirst = fake.calls.filter((c) => c.method === 'PUT' && c.path.includes('/virtualNetworks/')).length
    await provider.provision(specFor({ serverId: 'dev-box-2', idempotencyKey: 'gen-1-def' }))

    expect(fake.ofType('Microsoft.Network/virtualNetworks')).toHaveLength(1)
    expect(fake.ofType('Microsoft.Network/networkSecurityGroups')).toHaveLength(1)
    // ADOPTED, not cached (rockysurf-3l4g). ensureNetwork() deliberately re-reads on every
    // provision — memoizing it meant a shared resource deleted out from under a running control
    // plane was never noticed, and the ssh rule below stopped being rewritten after the first
    // provision of each process. The guarantee that matters is unchanged and is what this
    // asserts: a second server finds the existing network and writes NOTHING to it.
    expect(fake.calls.filter((c) => c.method === 'PUT' && c.path.includes('/virtualNetworks/')).length).toBe(afterFirst)
  })

  it('re-creates the shared network when it was deleted out from under a running provider', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)

    await provider.provision(specFor())
    // Someone tidies up the resource group while the control plane keeps running — an operator,
    // a mis-scoped script, the documented recovery for a region change.
    fake.vanish('Microsoft.Network/virtualNetworks', 'rockysurf-vnet')
    fake.vanish('Microsoft.Network/networkSecurityGroups', 'rockysurf-ssh')

    // ensureNetwork() used to memoize its result for the life of the process, so the next
    // provision skipped creation entirely and drove straight into a NIC referencing an NSG that
    // no longer existed — InvalidResourceReference, until someone restarted (rockysurf-3l4g).
    await provider.provision(specFor({ serverId: 'dev-box-2', idempotencyKey: 'gen-1-def' }))

    expect(fake.has('Microsoft.Network/virtualNetworks', 'rockysurf-vnet')).toBe(true)
    expect(fake.has('Microsoft.Network/networkSecurityGroups', 'rockysurf-ssh')).toBe(true)
    expect(fake.has(VM, 'dev-box-2')).toBe(true)
  })

  it('refuses when the shared network already exists in a DIFFERENT region', async () => {
    const fake = new FakeArm()
    await providerFor(fake).provision(specFor())

    // The operator changes providers.azure.location. The shared vnet and NSG are found by NAME,
    // and a name says nothing about region — but Azure requires a NIC and the subnet and NSG it
    // references to be in one region, so this cannot work and must not be attempted.
    const moved = providerFor(fake, { location: 'westus2' })
    const err = await moved.provision(specFor({ serverId: 'dev-box-2', idempotencyKey: 'gen-1-def' })).catch((e) => e)

    expect(isProviderError(err)).toBe(true)
    expect(err.code).toBe('invalid_spec')
    // The message has to name BOTH regions and the way out. Azure's own answer to the attempt
    // says the NSG "was not found" — which is false, and sends the reader hunting the wrong bug.
    expect(err.message).toContain(fake.location)
    expect(err.message).toContain('westus2')
    expect(err.message).toContain('rockysurf-vnet')
    // Nothing was built in the new region on the way to failing.
    expect(fake.has(VM, 'dev-box-2')).toBe(false)
  })

  it('writes the ssh rule as a CHILD of the security group, so other rules survive', async () => {
    const fake = new FakeArm()
    await providerFor(fake).provision(specFor())

    // A PUT on the whole NSG would replace `securityRules` and silently delete every rule an
    // operator had added to it. The rule is written at its own path instead.
    const ruleWrite = fake.calls.find((c) => c.method === 'PUT' && c.path.includes('/securityRules/'))
    expect(ruleWrite).toBeDefined()
    const rule = (ruleWrite!.body as { properties: Record<string, unknown> }).properties
    expect(rule['sourceAddressPrefix']).toBe('203.0.113.7/32')
    expect(rule['destinationPortRange']).toBe('22')
    expect(rule['direction']).toBe('Inbound')
    expect(rule['access']).toBe('Allow')

    const nsgWrites = fake.calls.filter(
      (c) => c.method === 'PUT' && /networkSecurityGroups\/[^/]+$/.test(c.path.split('?')[0]!),
    )
    expect((nsgWrites[0]!.body as { properties: Record<string, unknown> }).properties).toEqual({})
  })
})

describe('idempotency', () => {
  it('returns the ORIGINAL machine on a replay, and creates nothing second', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const spec = specFor()

    const first = await provider.provision(spec)
    const replay = await provider.provision(spec)

    expect(replay.data['vmName']).toBe(first.data['vmName'])
    expect(fake.ofType(VM)).toHaveLength(1)
    expect(fake.ofType(DISK)).toHaveLength(1)
  })

  it('refuses a same-named create carrying a DIFFERENT key rather than updating it', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await provider.provision(specFor())

    // ARM would accept the PUT and silently mutate a running machine. This is the
    // IdempotentParameterMismatch case, and refusing is the only safe answer.
    await expect(provider.provision(specFor({ idempotencyKey: 'gen-2-xyz' }))).rejects.toMatchObject({
      code: 'conflict',
    })
  })
})

describe('provision failure paths', () => {
  it('reaps the address and the interface when the machine cannot be created', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    fake.failNext('PUT', '/virtualMachines/', { status: 409, code: 'AllocationFailed', message: 'no capacity' })

    await expect(provider.provision(specFor())).rejects.toMatchObject({ code: 'capacity' })

    // Nothing will ever come back for these: core marks the row failed WITHOUT storing a handle,
    // and a public IP bills whether or not anything is attached to it (the rkh3 lesson).
    expect(fake.ofType(PIP)).toHaveLength(0)
    expect(fake.ofType(NIC)).toHaveLength(0)
  })

  it('raises the ORIGINAL failure, not whatever went wrong tidying up', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    fake.failNext('PUT', '/virtualMachines/', { status: 409, code: 'AllocationFailed', message: 'no capacity' })
    fake.failNext('DELETE', '/networkInterfaces/', { status: 500, code: 'InternalServerError', message: 'nope' })

    const error = await provider.provision(specFor()).catch((e: unknown) => e)
    expect(isProviderError(error) && error.providerCode).toBe('AllocationFailed')
  })

  it('does NOT reap the interface when the machine actually exists', async () => {
    // `call()` retries a PUT that got no well-formed answer, so a VM this provision genuinely
    // created can be sitting there while the error in hand describes a lost response. Reaping
    // then would destroy the network interface of a live machine. Ownership is decided by what
    // exists and by the tags we wrote, never by whose call threw.
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const spec = specFor()

    let seenVmPut = false
    const flaky: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if ((init?.method ?? 'GET') === 'PUT' && url.includes('/virtualMachines/')) {
        await fake.fetch(input, init)
        seenVmPut = true
        throw new TypeError('socket hang up')
      }
      return fake.fetch(input, init)
    }

    const flakyProvider = makeAzureProvider({
      config: configFor(fake),
      fetchImpl: flaky,
      credentials: new CredentialChain({
        fetchImpl: fake.fetch,
        env: { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' },
        allowAzureCli: false,
      }),
      sleep: async () => {},
      maxRetries: 0,
    })

    const result = await flakyProvider.provision(spec)
    expect(seenVmPut).toBe(true)
    expect(result.data['vmName']).toBe('dev-box-1')
    expect(fake.has(NIC, 'dev-box-1-nic')).toBe(true)
    expect(fake.has(PIP, 'dev-box-1-ip')).toBe(true)
  })
})

describe('describe', () => {
  it('reports running with the public address once the machine is up', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())
    fake.advanceToRunning('dev-box-1')

    const view = await provider.describe(data)
    expect(view.state).toBe('running')
    expect(view.publicIp).toMatch(/^20\.0\.0\.\d+$/)
    expect(view.offeringId).toBe('Standard_B2ps_v2')
  })

  it('reads the address once and caches it, because a Standard SKU address never moves', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())
    fake.advanceToRunning('dev-box-1')

    await provider.describe(data)
    const reads = fake.calls.filter((c) => c.method === 'GET' && c.path.includes('/publicIPAddresses/')).length
    await provider.describe(data)
    await provider.describe(data)

    // describe() is polled in a loop by core; a second round trip per poll for a value that
    // cannot change is pure cost.
    expect(fake.calls.filter((c) => c.method === 'GET' && c.path.includes('/publicIPAddresses/')).length).toBe(reads)
  })

  it('maps Deleting to terminating, which still exists and still bills', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())
    fake.setVmState('dev-box-1', 'Deleting')

    expect((await provider.describe(data)).state).toBe('terminating')
  })

  it('maps Failed to failed and carries Azure’s own reason', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())
    fake.setVmState('dev-box-1', 'Failed')

    const view = await provider.describe(data)
    expect(view.state).toBe('failed')
    expect(view.failureReason).toContain('no capacity')
  })

  it('maps a deallocated machine to stopped', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())
    fake.setVmState('dev-box-1', 'Succeeded', 'deallocated')

    expect((await provider.describe(data)).state).toBe('stopped')
  })
})

describe('terminate', () => {
  it('one delete reaps the machine, its disk, its interface and its address', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())

    await provider.terminate(data)

    // The property the whole provider is built around. Azure PERSISTS all three by default.
    expect(fake.ofType(VM)).toHaveLength(0)
    expect(fake.ofType(DISK)).toHaveLength(0)
    expect(fake.ofType(NIC)).toHaveLength(0)
    expect(fake.ofType(PIP)).toHaveLength(0)
  })

  it('leaves the shared network standing', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())

    await provider.terminate(data)

    expect(fake.ofType('Microsoft.Network/virtualNetworks')).toHaveLength(1)
    expect(fake.ofType('Microsoft.Network/networkSecurityGroups')).toHaveLength(1)
  })

  it('is idempotent: a second call is a no-op, not an error', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())

    await provider.terminate(data)
    await expect(provider.terminate(data)).resolves.toBeUndefined()
  })

  it('collects an interface and address whose machine never existed', async () => {
    // The one case the cascade cannot cover: a create that failed after the NIC was made and
    // whose quiet reap could not finish. Nothing holds them, so there is no race with a VM
    // deletion and deleting them directly is the only thing that will ever collect them.
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())
    fake.vanish(VM, 'dev-box-1')

    await provider.terminate(data)

    expect(fake.ofType(NIC)).toHaveLength(0)
    expect(fake.ofType(PIP)).toHaveLength(0)
  })
})

describe('listManaged', () => {
  it('reports the machine and its secondary resources as server-owned, attributed', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await provider.provision(specFor())

    const managed = await provider.listManaged()
    const byKind = Object.fromEntries(managed.map((r) => [r.kind, r]))

    expect(byKind['instance']).toMatchObject({ ownership: 'server-owned', serverId: 'dev-box-1' })
    expect(byKind['network-interface']).toMatchObject({ ownership: 'server-owned', serverId: 'dev-box-1' })
    expect(byKind['public-ip']).toMatchObject({ ownership: 'server-owned', serverId: 'dev-box-1' })
  })

  it('attributes the OS disk through managedBy, because Azure copies no tags onto it', async () => {
    // The D4 orphan class. A tag-filtered sweep would never see a disk at all: Azure does not
    // copy a VM's tags onto the disk it creates from an image, so the disk is untagged.
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await provider.provision(specFor())

    expect(fake.ofType(DISK)[0]!.tags).toBeUndefined()
    const disk = (await provider.listManaged()).find((r) => r.kind === 'disk')
    expect(disk).toMatchObject({ ownership: 'server-owned', serverId: 'dev-box-1' })
  })

  it('still reports an orphaned disk, as an owned resource nobody can attribute', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await provider.provision(specFor())
    // The disk survives its machine — the exact orphan the cascade exists to prevent, and the
    // one an audit that walks instances never sees.
    fake.vanish(VM, 'dev-box-1')

    const disk = (await provider.listManaged()).find((r) => r.kind === 'disk')
    expect(disk).toBeDefined()
    expect(disk!.ownership).toBe('server-owned')
    expect(disk!.serverId).toBeUndefined()
  })

  it('reports the shared network as shared, so a reconciler never reaps it', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await provider.provision(specFor())

    const managed = await provider.listManaged()
    expect(managed.find((r) => r.kind === 'virtual-network')?.ownership).toBe('shared')
    expect(managed.find((r) => r.kind === 'network-security-group')?.ownership).toBe('shared')
  })

  it('ignores a resource carrying somebody else’s managed-by tag', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await provider.provision(specFor())
    const stranger = `/subscriptions/${fake.subscriptionId}/resourceGroups/${fake.resourceGroup}/providers/Microsoft.Compute/virtualMachines/not-ours`
    fake.resources.set(stranger.toLowerCase(), {
      id: stranger,
      name: 'not-ours',
      type: VM,
      tags: { 'managed-by': 'someone-else' },
    })

    expect((await provider.listManaged()).map((r) => r.providerNativeId)).not.toContain(stranger)
  })
})

describe('stop and start', () => {
  it('deallocates rather than powering off, because a powered-off VM still bills compute', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())

    await provider.stop(data)

    expect(fake.calls.some((c) => c.method === 'POST' && c.path.includes('/deallocate'))).toBe(true)
    expect(fake.calls.some((c) => c.path.includes('/powerOff'))).toBe(false)
    expect((await provider.describe(data)).state).toBe('stopped')
  })

  it('keeps the same public address across a stop and start', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())
    fake.advanceToRunning('dev-box-1')
    const before = (await provider.describe(data)).publicIp

    await provider.stop(data)
    await provider.start(data)

    // `ipStableAcrossStop: true` is a claim about Standard-SKU static addresses. If it were
    // false, core would have to re-read and re-publish the address after every start.
    expect((await provider.describe(data)).publicIp).toBe(before)
  })
})

describe('validateSpec', () => {
  it('refuses a spec whose managed-by disagrees with this provider', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    // D3: a VM tagged with anything else is invisible to the reconciler and an orphan from birth.
    await expect(
      provider.validateSpec(specFor({ tags: { 'managed-by': 'other', 'server-id': 'dev-box-1' } })),
    ).rejects.toMatchObject({ code: 'invalid_spec' })
  })

  it('refuses an id that is not hostname-safe', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await expect(provider.validateSpec(specFor({ serverId: 'srv_a1b2' }))).rejects.toMatchObject({
      code: 'invalid_spec',
    })
  })

  it('refuses a spec with no ssh key, which Azure would refuse anyway', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await expect(provider.validateSpec(specFor({ sshPublicKeys: [] }))).rejects.toMatchObject({
      code: 'invalid_spec',
    })
  })

  it('refuses user-data over the customData ceiling before anything is created', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await expect(provider.validateSpec(specFor({ userData: 'x'.repeat(49_153) }))).rejects.toMatchObject({
      code: 'invalid_spec',
    })
  })

  it('refuses an arm64 spec pointed at an x64 size', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await expect(
      provider.validateSpec(specFor({ arch: 'arm64', offeringId: 'Standard_B2s_v2' })),
    ).rejects.toMatchObject({ code: 'invalid_spec' })
  })
})

describe('validateCredentials', () => {
  it('passes when the credential can see the resource group and the region exists', async () => {
    const fake = new FakeArm()
    await expect(providerFor(fake).validateCredentials()).resolves.toBeUndefined()
  })

  it('names the missing resource group, and the command that creates it', async () => {
    const fake = new FakeArm({ resourceGroupExists: false })
    const error = await providerFor(fake)
      .validateCredentials()
      .catch((e: unknown) => e)
    expect(isProviderError(error)).toBe(true)
    expect((error as Error).message).toContain('az group create')
  })

  it('refuses a region this subscription does not have', async () => {
    const fake = new FakeArm()
    await expect(providerFor(fake, { location: 'mars-central-1' }).validateCredentials()).rejects.toMatchObject({
      code: 'invalid_spec',
    })
  })
})

describe('listOfferings', () => {
  it('reads shape from the live sku list and price from the hosted feed', async () => {
    const fake = new FakeArm()
    const offerings = await providerFor(fake).listOfferings()

    const arm = offerings.find((o) => o.id === 'Standard_B2ps_v2')!
    expect(arm.arch).toBe('arm64')
    expect(arm.cpu).toBe(2)
    expect(arm.memoryGb).toBe(8)
    // Currency and the "as of" stamp both come from the feed document (gh issue #100).
    expect(arm.hourly).toEqual({ amount: 0.0486, currency: 'USD', fetchedAt: FEED_FETCHED_AT })
    expect(arm.region).toBe('eastus')
    // The OS disk size this provider is configured to attach, not the image's default.
    expect(arm.diskGb).toBe(30)
  })

  it('lists the catalogue unpriced when the feed is unreachable (ADR-0009)', async () => {
    // The owner's no-fallback ruling: no feed means "prices unavailable", never a stale or
    // wrong number — and never a smaller catalogue. Creates must keep working.
    const fake = new FakeArm()
    const offerings = await providerFor(fake, {}, feedOf(null)).listOfferings()
    expect(offerings.length).toBeGreaterThan(0)
    expect(offerings.every((o) => o.hourly === null)).toBe(true)
  })

  it('offers both architectures', async () => {
    const fake = new FakeArm()
    const offerings = await providerFor(fake).listOfferings()
    expect(new Set(offerings.map((o) => o.arch))).toEqual(new Set(['amd64', 'arm64']))
  })

  it('reports a restricted size as unavailable rather than omitting it', async () => {
    // B1: a price is not an offer, and Azure restricts per SUBSCRIPTION. Omitting it would leave
    // core unable to tell "this cloud has no ARM" from "this account cannot order ARM".
    const fake = new FakeArm({
      skus: [
        { name: 'Standard_B2ps_v2', cpu: 2, memoryGb: 8, arch: 'Arm64', restricted: true },
        { name: 'Standard_B2s_v2', cpu: 2, memoryGb: 8, arch: 'x64' },
      ],
    })
    const offerings = await providerFor(fake).listOfferings()

    expect(offerings.find((o) => o.id === 'Standard_B2ps_v2')?.available).toBe(false)
    expect(offerings.find((o) => o.id === 'Standard_B2s_v2')?.available).toBe(true)
  })

  it('reports hourly null for a region the feed has no prices for', async () => {
    const fake = new FakeArm({ location: 'westeurope' })
    const offerings = await providerFor(fake, { location: 'westeurope' }).listOfferings()
    // `null` is "unknown, never free" — never a us-east number that would be wrong.
    expect(offerings.every((o) => o.hourly === null)).toBe(true)
  })

  it('omits a size whose shape cannot be read rather than fabricating one', async () => {
    const fake = new FakeArm()
    // A catalogue entry claiming 8 GB on a machine that has 4 is worse than one that is absent.
    fake.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('/Microsoft.Compute/skus')) {
        return new Response(
          JSON.stringify({ value: [{ name: 'Standard_B2ps_v2', resourceType: 'virtualMachines', capabilities: [] }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new FakeArm().fetch(input, init)
    }) as typeof fetch

    expect(await providerFor(fake).listOfferings()).toHaveLength(0)
  })

  it('omits a Gen1-only size because the default image SKU is Gen2 (rockysurf-o05s)', async () => {
    const fake = new FakeArm({
      skus: [
        // A size whose HyperVGenerations capability does not include V2 — cannot boot this
        // provider's default (Gen2) image, so it must never be listed as an offering.
        { name: 'Standard_D2s_v5', cpu: 2, memoryGb: 8, arch: 'x64', hyperVGenerations: ['V1'] },
        { name: 'Standard_D2ps_v5', cpu: 2, memoryGb: 8, arch: 'Arm64' },
      ],
    })
    const offerings = await providerFor(fake).listOfferings()

    expect(offerings.find((o) => o.id === 'Standard_D2s_v5')).toBeUndefined()
    expect(offerings.find((o) => o.id === 'Standard_D2ps_v5')).toBeDefined()
  })

  it('omits a size whose HyperVGenerations capability is missing entirely', async () => {
    const fake = new FakeArm()
    fake.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('/Microsoft.Compute/skus')) {
        return new Response(
          JSON.stringify({
            value: [
              {
                name: 'Standard_B2ps_v2',
                resourceType: 'virtualMachines',
                capabilities: [
                  { name: 'vCPUs', value: '2' },
                  { name: 'MemoryGB', value: '8' },
                  { name: 'CpuArchitectureType', value: 'Arm64' },
                  // No HyperVGenerations entry at all.
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new FakeArm().fetch(input, init)
    }) as typeof fetch

    expect(await providerFor(fake).listOfferings()).toHaveLength(0)
  })

  it('omits a size above the vCPU/memory ceiling (rockysurf-o05s)', async () => {
    const fake = new FakeArm({
      skus: [
        // Above SIZE_CEILING.maxCpu (128) — nothing this large is a dev box.
        { name: 'Standard_D2s_v5', cpu: 192, memoryGb: 512, arch: 'x64' },
        { name: 'Standard_D2ps_v5', cpu: 2, memoryGb: 8, arch: 'Arm64' },
      ],
    })
    const offerings = await providerFor(fake).listOfferings()

    expect(offerings.find((o) => o.id === 'Standard_D2s_v5')).toBeUndefined()
    expect(offerings.find((o) => o.id === 'Standard_D2ps_v5')).toBeDefined()
  })
})

/**
 * THE AZURE STATE VOCABULARY COLLIDES WITH THE SDK'S, AND NOT WHERE IT LOOKS LIKE IT DOES.
 *
 * Azure has TWO off states and the SDK has one, so the mapping cannot be made by matching
 * spellings — and matching spellings is exactly what a reader of either vocabulary would reach
 * for first:
 *
 *   Azure `PowerState/stopped`      = Stopped (Allocated). Disk intact, restartable, and STILL
 *                                     BILLING compute at the full rate.
 *   Azure `PowerState/deallocated`  = compute resources released. Disk intact, restartable, and
 *                                     NOT billing compute.
 *
 * The SDK's `stopped` is defined by what a caller can DO with the instance — "stopped with its
 * disk intact, restartable via start()" — not by what it costs. Both Azure states satisfy that,
 * so both map to `stopped`, and the billing difference is handled where it belongs: `stop()`
 * issues `deallocate`, so the only off state Rocky Surf ever creates is the free one.
 *
 * The dangerous mistake is the other direction. `deallocated` reads like "the resources are
 * gone", and mapping it to `terminated` would tell core a live, restartable, disk-holding box no
 * longer exists — after which terminate() short-circuits on it and nothing ever reaps the disk
 * or the address. That is the gyp1.4 failure shape reached by a different road, so it is pinned
 * here rather than left to a comment.
 */
describe('the two Azure off states (pinned)', () => {
  it('maps BOTH of Azure’s off states to the SDK’s one, and neither to terminated', () => {
    expect(instanceStateOf('Succeeded', 'deallocated')).toBe('stopped')
    expect(instanceStateOf('Succeeded', 'stopped')).toBe('stopped')

    // The whole point. `deallocated` reads like "gone" and is not.
    expect(instanceStateOf('Succeeded', 'deallocated')).not.toBe('terminated')
    expect(instanceStateOf('Succeeded', 'deallocated')).not.toBe('failed')
  })

  it('maps Deleting to terminating, never terminated — the resources still exist and still bill', () => {
    // The other spelling trap: `Deleting` looks final and is not. A reconciler must treat this
    // as PRESENT, because the disk, the interface and the address have not been released yet.
    expect(instanceStateOf('Deleting', undefined)).toBe('terminating')
    expect(instanceStateOf('Deleting', 'running')).not.toBe('terminated')
  })

  it('stop() reaches the free off state, not the billing one', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    const { data } = await provider.provision(specFor())

    await provider.stop(data)

    // If stop() issued powerOff, this would read `stopped` and the box would keep charging the
    // full compute rate for doing nothing — capabilities.stop would be true while delivering
    // none of what core uses it for.
    const vm = fake.ofType(VM)[0]!.properties as { powerState: string }
    expect(vm.powerState).toBe('deallocated')
  })
})

describe('state mapping', () => {
  it('reads a power state out of an instance view', () => {
    expect(powerStateOf([{ code: 'ProvisioningState/succeeded' }, { code: 'PowerState/running' }])).toBe('running')
    expect(powerStateOf([{ code: 'ProvisioningState/succeeded' }])).toBeUndefined()
  })

  it('treats an unrecognised power state as unknown rather than guessing', () => {
    // Microsoft publishes the state table but no exhaustive list of the code strings, so the
    // parser must not switch on a closed set.
    expect(instanceStateOf('Succeeded', 'hibernated')).toBe('unknown')
  })

  it('lets Deleting and Failed outrank any power reading', () => {
    expect(instanceStateOf('Deleting', 'running')).toBe('terminating')
    expect(instanceStateOf('Failed', 'running')).toBe('failed')
  })

  it('reads a vm name out of a managedBy id', () => {
    expect(vmNameFrom('/subscriptions/s/resourceGroups/g/providers/Microsoft.Compute/virtualMachines/box')).toBe('box')
    expect(vmNameFrom(undefined)).toBeUndefined()
  })
})

describe('core quota is the second gate on a create (issue #116)', () => {
  const skus = [
    { name: 'Standard_B2ps_v2', cpu: 2, memoryGb: 8, arch: 'Arm64' as const, family: 'standardBpsv2Family' },
    { name: 'Standard_D2ps_v5', cpu: 2, memoryGb: 8, arch: 'Arm64' as const, family: 'standardDPSv5Family' },
  ]

  it('lists a size whose family has no approved quota as unavailable, and says why', async () => {
    // The owner's subscription on 2026-08-26: B-series at 0, D-series at 10. The SKU gate said
    // nothing about either; the VM PUT refused the first with OperationNotAllowed.
    const fake = new FakeArm({
      skus,
      usages: [
        { family: 'standardBpsv2Family', limit: 0 },
        { family: 'standardDPSv5Family', limit: 10 },
      ],
    })
    const offerings = await providerFor(fake).listOfferings()

    const refused = offerings.find((o) => o.id === 'Standard_B2ps_v2')!
    expect(refused.available).toBe(false)
    expect(refused.unavailableReason).toContain('no core quota for standardBpsv2Family in eastus')
    expect(refused.unavailableReason).toContain('Azure portal')

    const allowed = offerings.find((o) => o.id === 'Standard_D2ps_v5')!
    expect(allowed.available).toBe(true)
    expect(allowed.unavailableReason).toBeUndefined()
  })

  it('counts cores already in use, so the last two cores of a family are not offered twice', async () => {
    const fake = new FakeArm({ skus, usages: [{ family: 'standardBpsv2Family', limit: 4, currentValue: 3 }] })
    const refused = (await providerFor(fake).listOfferings()).find((o) => o.id === 'Standard_B2ps_v2')!
    expect(refused.available).toBe(false)
    expect(refused.unavailableReason).toContain('limit 4, 3 in use, this size needs 2')
  })

  it("joins the family case-insensitively, because Azure's two endpoints disagree on the capital", async () => {
    const fake = new FakeArm({ skus, usages: [{ family: 'STANDARDBPSV2FAMILY', limit: 0 }] })
    const refused = (await providerFor(fake).listOfferings()).find((o) => o.id === 'Standard_B2ps_v2')!
    expect(refused.available).toBe(false)
  })

  it('applies the regional total as well as the family', async () => {
    const fake = new FakeArm({ skus, regionalCores: { limit: 10, currentValue: 9 } })
    const offerings = await providerFor(fake).listOfferings()
    expect(offerings.every((o) => !o.available)).toBe(true)
    expect(offerings[0]!.unavailableReason).toContain('core quota for the region in eastus is exhausted')
  })

  it('does not refuse a family with no quota row — absence of evidence is not a refusal', async () => {
    const fake = new FakeArm({ skus, usages: [{ family: 'somethingElseFamily', limit: 0 }] })
    const offerings = await providerFor(fake).listOfferings()
    expect(offerings.every((o) => o.available)).toBe(true)
  })

  it('gives the SKU restriction as the reason when that gate refuses first', async () => {
    const fake = new FakeArm({ skus: [{ ...skus[0]!, restricted: true }] })
    const refused = (await providerFor(fake).listOfferings())[0]!
    expect(refused.available).toBe(false)
    expect(refused.unavailableReason).toBe('not available to this subscription in eastus')
  })

  it('falls back to the SKU gate alone when the credential cannot read quota, and says so once', async () => {
    // An installation still on the two-action Catalogue Reader role. The size list must not
    // go dark, and nothing may be marked unavailable on the strength of a read that failed.
    const fake = new FakeArm({ skus, usages: [{ family: 'standardBpsv2Family', limit: 0 }] })
    fake.failNext('GET', '/usages', {
      status: 403,
      code: 'AuthorizationFailed',
      message: "The client does not have authorization to perform action 'Microsoft.Compute/locations/usages/read'",
    })
    const warnings: string[] = []
    const provider = makeAzureProvider({
      config: configFor(fake),
      priceFeed: feedOf(FEED),
      fetchImpl: fake.fetch,
      credentials: new CredentialChain({
        fetchImpl: fake.fetch,
        env: { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'secret' },
        allowAzureCli: false,
      }),
      sleep: async () => {},
      maxRetries: 0,
      log: (message) => warnings.push(message),
    })

    const first = await provider.listOfferings()
    expect(first.every((o) => o.available)).toBe(true)
    expect(first.every((o) => o.unavailableReason === undefined)).toBe(true)

    await provider.listOfferings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Microsoft.Compute/locations/usages/read')
  })

  it('makes the size resolver skip a quota-less family rather than offer it', async () => {
    // Before this change `small` on Azure resolved to the cheapest B-series size, which is the
    // family a fresh subscription has no quota for — the create then failed at the VM PUT.
    const fake = new FakeArm({
      skus,
      usages: [
        { family: 'standardBpsv2Family', limit: 0 },
        { family: 'standardDPSv5Family', limit: 10 },
      ],
    })
    const offerings = await providerFor(fake).listOfferings()
    const cheapestAvailable = offerings.filter((o) => o.available).sort((a, b) => a.hourly!.amount - b.hourly!.amount)[0]
    expect(cheapestAvailable?.id).toBe('Standard_D2ps_v5')
  })
})

