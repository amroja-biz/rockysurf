import {
  assertDescribeAbsenceGrace,
  assertFactoryShape,
  assertManagedShape,
  assertOfferingsShape,
  assertProviderErrorShape,
  assertProviderShape,
  type AbsenceGraceHarness,
  type DescribeRead,
} from '@rockysurf/provider-conformance'
import { DESCRIBE_ABSENCE_GRACE, type ComputeProvider } from '@rockysurf/provider-sdk'
import { describe, expect, it } from 'vitest'
import { FakeArm } from './arm-fake.js'
import azureProviderFactory from './index.js'
import { azureConfigSchema } from './config.js'
import { CredentialChain } from './credentials.js'
import { makeAzureProvider, type AzureData } from './provider.js'

/**
 * The shared conformance suite, run against this provider.
 *
 * Passing this is necessary and not sufficient — it checks the mechanical contract and the one
 * BEHAVIOURAL rule that has already cost a live instance. See the absence-grace block at the
 * bottom, which is the part that matters.
 */

const validConfig = {
  subscriptionId: '00000000-0000-0000-0000-000000000000',
  resourceGroup: 'rocky-surf-rg',
  location: 'eastus',
  sshAllowedCidr: '203.0.113.7/32',
}

function providerFor(fake: FakeArm): ComputeProvider {
  return makeAzureProvider({
    config: azureConfigSchema.parse(validConfig),
    fetchImpl: fake.fetch,
    credentials: new CredentialChain({
      fetchImpl: fake.fetch,
      env: { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' },
      allowAzureCli: false,
    }),
    sleep: async () => {},
    maxRetries: 0,
  })
}

describe('shape', () => {
  it('the factory exports an id, a schema and a synchronous constructor', () => {
    assertFactoryShape(azureProviderFactory, azureConfigSchema.parse(validConfig))
  })

  it('the provider implements all nine methods and declares every capability', () => {
    assertProviderShape(providerFor(new FakeArm()))
  })

  it('declares capabilities that match what this provider actually does', () => {
    const caps = providerFor(new FakeArm()).capabilities
    expect(caps.stop).toBe(true)
    // Standard-SKU public IPs are always Static, and a static address is released only on delete.
    expect(caps.ipStableAcrossStop).toBe(true)
    expect(caps.canInjectHostKeys).toBe(true)
    expect(caps.generatesUserData).toBe(true)
    // 48 KiB: Microsoft documents 64 KB for customData without saying whether that is measured
    // before or after the mandatory base64, and this is the value correct under either reading.
    expect(caps.userDataMaxBytes).toBe(49_152)
    // The SDK requires this dependency, and the suite checks it too.
    expect(caps.canInjectHostKeys && !caps.generatesUserData).toBe(false)
  })

  it('produces well-formed offerings', async () => {
    assertOfferingsShape(await providerFor(new FakeArm()).listOfferings())
  })

  it('produces well-formed managed-resource records', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    await provider.provision({
      serverId: 'conformance-1',
      name: 'conformance',
      offeringId: 'Standard_B2ps_v2',
      arch: 'arm64',
      sshPublicKeys: ['ssh-ed25519 AAAA test@example'],
      userData: '#cloud-config\n',
      tags: { 'managed-by': 'rockysurf', 'server-id': 'conformance-1' },
      idempotencyKey: 'gen-1',
    })
    assertManagedShape(await provider.listManaged())
  })

  it('throws ProviderErrors with frozen codes, never raw fetch failures', async () => {
    const fake = new FakeArm()
    const provider = providerFor(fake)
    fake.failNext('GET', '/resourceGroups/', { status: 403, code: 'AuthorizationFailed', message: 'nope' })

    const error = await provider.validateCredentials().catch((e: unknown) => e)
    assertProviderErrorShape(error)
  })
})

/* --------------------------------------------------------------- the absence grace (A4) */

/**
 * The propagation grace, asserted behaviourally rather than assumed.
 *
 * THE HONEST POSITION FOR AZURE, and it is different from the other two providers'. ARM is
 * generally read-after-write consistent on a resource's own URI, so the window `provider-aws`
 * measured on EC2 may simply not exist here — but **nobody has measured it**, because this
 * package was built without an Azure subscription. The rule is that a provider may lengthen the
 * grace and may never skip it, so Azure honours the reference value, and `rockysurf-ihtq.8` is
 * what can later replace this reasoning with a number.
 *
 * The reason this is asserted rather than commented is `provider-aws`: the rule was stated twice
 * in the SDK and that provider still shipped without it, because the only implementation any
 * test exercised was the fake, which gets it right. A rule only one implementation is checked
 * against is a rule the next author skips by accident.
 */
class AzureGraceHarness implements AbsenceGraceHarness {
  readonly provider = 'azure'
  readonly grace = { attempts: DESCRIBE_ABSENCE_GRACE.attempts }

  /**
   * A provider whose VM read answers a script, counting reads of THAT path only.
   *
   * The address read `describe()` makes after finding a machine is deliberately not counted: the
   * grace is about the instance read, and counting a second endpoint would make the assertions
   * pass for the wrong reason.
   */
  private build(script: readonly DescribeRead[]) {
    const fake = new FakeArm()
    // Two separate numbers on purpose. `reads` is what the assertions count and a caller may
    // reset; `cursor` is where the script has got to and must not move when they do.
    const counter = { reads: 0 }
    let cursor = 0
    const vmPath = '/providers/Microsoft.Compute/virtualMachines/'

    const scripted: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url.includes(vmPath)) {
        // The script answers in order and then repeats its LAST entry forever, so `['absent']`
        // is "gone, permanently" and `[…, 'running']` is an eventual-consistency window.
        const answer = script[Math.min(cursor, script.length - 1)] ?? 'absent'
        cursor++
        counter.reads++
        if (answer === 'absent') {
          return new Response(
            JSON.stringify({ error: { code: 'ResourceNotFound', message: 'not found' } }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            id: '/subscriptions/s/resourceGroups/g/providers/Microsoft.Compute/virtualMachines/graced',
            name: 'graced',
            type: 'Microsoft.Compute/virtualMachines',
            properties: {
              provisioningState: 'Succeeded',
              instanceView: { statuses: [{ code: 'PowerState/running', level: 'Info' }] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return fake.fetch(input, init)
    }

    const provider = makeAzureProvider({
      config: azureConfigSchema.parse(validConfig),
      fetchImpl: scripted,
      credentials: new CredentialChain({
        fetchImpl: fake.fetch,
        env: { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' },
        allowAzureCli: false,
      }),
      // Zeroing the delay changes what the suite COSTS, never what it proves: the assertions are
      // about how many reads are spent, not how long they take.
      absenceGrace: { attempts: DESCRIBE_ABSENCE_GRACE.attempts, delayMs: 0 },
      sleep: async () => {},
      maxRetries: 0,
    })

    const handle: AzureData = {
      vmName: 'graced',
      resourceGroup: 'rocky-surf-rg',
      subscriptionId: validConfig.subscriptionId,
      location: 'eastus',
      nicName: 'graced-nic',
      publicIpName: 'graced-ip',
      osDiskName: 'graced-osdisk',
    }
    return { provider, handle, counter }
  }

  neverSeenRunning(script: readonly DescribeRead[]) {
    const { provider, handle, counter } = this.build(script)
    return {
      run: async () => {
        const view = await provider.describe(handle)
        return { view, reads: counter.reads }
      },
    }
  }

  goneAfterRunning() {
    // One read that answers `running`, then absence forever. The provider must believe the
    // absence immediately: there is no ambiguity left to wait out, and this is the path core
    // polls in a loop during every teardown.
    const { provider, handle, counter } = this.build(['running', 'absent'])
    return {
      run: async () => {
        await provider.describe(handle)
        counter.reads = 0
        const view = await provider.describe(handle)
        return { view, reads: counter.reads }
      },
    }
  }
}

describe('describe() absence grace (ADR-0003, A4)', () => {
  it('honours the propagation grace, and spends it only where there is ambiguity', async () => {
    await assertDescribeAbsenceGrace(new AzureGraceHarness())
  })
})
