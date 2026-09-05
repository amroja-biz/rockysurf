import {
  assertDescribeAbsenceGrace,
  assertFactoryShape,
  assertManagedShape,
  assertOfferingsShape,
  assertSettingsShape,
  type AbsenceGraceProbe,
  type DescribeRead,
} from '@rockysurf/provider-conformance'
import { isProviderError, type ProviderError, type ProvisionSpec } from '@rockysurf/provider-sdk'
import { describe, expect, it } from 'vitest'
import { digitaloceanConfigSchema, type DigitaloceanProviderConfig } from './config.js'
import { emptyCloud, fakeFetch, FAKE_BASE, type FakeCloud } from './fake-cloud.js'
import factory from './index.js'
import {
  asDigitaloceanData,
  digitaloceanConsoleUrl,
  DROPLET_STATE,
  fingerprintOf,
  makeDigitaloceanProvider,
  sshKeyName,
  sshSourcesOf,
} from './provider.js'
import { DigitaloceanApi } from './api.js'
import type { DoFirewall, DoSshKey } from './types.js'

const VALID_CONFIG = digitaloceanConfigSchema.parse({
  token: 'do-personal-access-token',
  region: 'nyc3',
  sshAllowedCidr: ['203.0.113.7/32'],
})

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0000000000000000000000000000000000000000 dev@box'

const SPEC: ProvisionSpec = {
  serverId: 'dev-box',
  name: 'dev box',
  offeringId: 's-2vcpu-4gb',
  arch: 'amd64',
  sshPublicKeys: [PUBLIC_KEY],
  userData: '#cloud-config\nssh_keys:\n  ed25519_private: |\n    x\n',
  tags: { 'managed-by': 'rockysurf', 'server-id': 'dev-box' },
  idempotencyKey: 'dev-box-1',
}

function build(cloud: FakeCloud = emptyCloud(), overrides: Partial<DigitaloceanProviderConfig> = {}) {
  const provider = makeDigitaloceanProvider(
    { ...VALID_CONFIG, ...overrides },
    {
      fetchImpl: fakeFetch(cloud),
      baseUrl: FAKE_BASE,
      maxRetries: 0,
      sleep: async () => {},
      grace: { attempts: 4, delayMs: 0 },
    },
  )
  return { cloud, provider }
}

const methodsFor = (cloud: FakeCloud, needle: string) => cloud.requests.filter((request) => request.includes(needle))

const bodyOf = (cloud: FakeCloud, request: string) => cloud.bodies[cloud.requests.indexOf(request)]

/* ------------------------------------------------------------------ conformance */

describe('conformance', () => {
  it('has the factory, provider and settings shape', () => {
    assertFactoryShape(factory, VALID_CONFIG)
    assertSettingsShape(factory, VALID_CONFIG)
  })

  it('returns well-formed offerings', async () => {
    const { provider } = build()
    assertOfferingsShape(await provider.listOfferings())
  })

  it('returns well-formed managed resources', async () => {
    const cloud = emptyCloud()
    cloud.droplets.set(1, { id: 1, name: 'dev-box', status: 'active', tags: ['managed-by:rockysurf', 'server-id:dev-box'] })
    cloud.keys.set(9, { id: 9, name: sshKeyName('rockysurf', 'dev-box', 0), fingerprint: 'aa:bb' })
    cloud.firewalls.push({ id: 'fw-1', name: 'rockysurf-ssh' })
    const { provider } = build(cloud)
    assertManagedShape(await provider.listManaged())
  })

  /**
   * The absence grace, behaviourally. The two probes are NOT symmetrical: `goneAfterRunning` has
   * to hand `describe()` an instance the provider has already observed running, which means
   * describing it once and then resetting the read counter — while the script cursor keeps its
   * place. Sharing one counter rewinds the script and fails the third assertion as if the
   * provider were broken.
   */
  it('honours the describe() absence grace', async () => {
    const HANDLE = { dropletId: 1, name: 'dev-box', ownedSshKeyIds: [] }

    class ScriptedCloud {
      reads = 0
      #cursor = 0
      constructor(private readonly script: readonly DescribeRead[]) {}
      fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input)
        if (!url.includes('/droplets/1')) throw new Error(`unexpected request ${url}`)
        const answer = this.script[Math.min(this.#cursor, this.script.length - 1)]
        this.#cursor += 1
        this.reads += 1
        return answer === 'running'
          ? new Response(
              JSON.stringify({ droplet: { id: 1, name: 'dev-box', status: 'active', networks: { v4: [] } } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : new Response(JSON.stringify({ id: 'not_found', message: 'not found' }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            })
      }) as typeof fetch
    }

    const scripted = (script: readonly DescribeRead[]) => {
      const cloud = new ScriptedCloud(script)
      const provider = makeDigitaloceanProvider(VALID_CONFIG, {
        fetchImpl: cloud.fetchImpl,
        baseUrl: FAKE_BASE,
        maxRetries: 0,
        sleep: async () => {},
        grace: { attempts: 4, delayMs: 0 },
      })
      return { cloud, provider }
    }

    await assertDescribeAbsenceGrace({
      provider: 'digitalocean',
      grace: { attempts: 4 },
      neverSeenRunning: (script): AbsenceGraceProbe => {
        const { cloud, provider } = scripted(script)
        return { run: async () => ({ view: await provider.describe(HANDLE), reads: cloud.reads }) }
      },
      goneAfterRunning: async (): Promise<AbsenceGraceProbe> => {
        const { cloud, provider } = scripted(['running', 'absent'])
        await provider.describe(HANDLE)
        // Count from the moment it went absent. This resets `reads` ONLY — the script cursor
        // keeps its place, which is why the two are separate counters.
        cloud.reads = 0
        return { run: async () => ({ view: await provider.describe(HANDLE), reads: cloud.reads }) }
      },
    })
  })
})

/* ------------------------------------------------------- trap 1: the status vocabulary */

describe('the status map', () => {
  it('is exactly this mapping, so a future edit cannot pass unnoticed', () => {
    expect(DROPLET_STATE).toEqual({
      new: 'pending',
      active: 'running',
      // `off` is a droplet powered off with its disk intact — restartable, and on this cloud
      // still billing at the full rate. It is the SDK's `stopped` and never its `terminated`.
      off: 'stopped',
      // The disk has been archived off the hypervisor and `start()` is not what revives it.
      archive: 'unknown',
    })
  })

  it('never maps anything to terminated', () => {
    // `terminated` is reserved for ABSENCE, and only after the propagation grace.
    expect(Object.values(DROPLET_STATE)).not.toContain('terminated')
  })

  it('reports off as stopped, with the console url', async () => {
    const cloud = emptyCloud()
    cloud.droplets.set(7, {
      id: 7,
      name: 'dev-box',
      status: 'off',
      size_slug: 's-2vcpu-4gb',
      networks: { v4: [{ ip_address: '203.0.113.9', type: 'public' }] },
    })
    const { provider } = build(cloud)
    const view = await provider.describe({ dropletId: 7, name: 'dev-box' })
    expect(view).toMatchObject({
      state: 'stopped',
      publicIp: '203.0.113.9',
      offeringId: 's-2vcpu-4gb',
      consoleUrl: 'https://cloud.digitalocean.com/droplets/7',
    })
  })

  it('carries DigitalOcean own word when it has nothing to map onto', async () => {
    const cloud = emptyCloud()
    cloud.droplets.set(8, { id: 8, name: 'dev-box', status: 'archive' })
    const { provider } = build(cloud)
    const view = await provider.describe({ dropletId: 8, name: 'dev-box' })
    expect(view.state).toBe('unknown')
    expect(view.failureReason).toContain('archive')
  })

  it('reads only the PUBLIC address of a droplet in a VPC', async () => {
    const cloud = emptyCloud()
    cloud.droplets.set(9, {
      id: 9,
      name: 'dev-box',
      status: 'active',
      networks: { v4: [{ ip_address: '10.116.0.2', type: 'private' }, { ip_address: '198.51.100.4', type: 'public' }] },
    })
    const { provider } = build(cloud)
    expect((await provider.describe({ dropletId: 9, name: 'dev-box' })).publicIp).toBe('198.51.100.4')
  })
})

describe('the grace floor', () => {
  it('refuses to be built with a grace shorter than the SDK floor', () => {
    expect(() => makeDigitaloceanProvider(VALID_CONFIG, { grace: { attempts: 1, delayMs: 0 } })).toThrow(
      /below the SDK floor/,
    )
  })
})

/* ---------------------------------------------------------------------- offerings */

describe('listOfferings', () => {
  it('reports the sizes sold in this region, sold-out ones included', async () => {
    const { provider } = build()
    const offerings = await provider.listOfferings()
    expect(offerings.map((offering) => offering.id).sort()).toEqual([
      's-1vcpu-1gb',
      's-1vcpu-2gb-retired',
      's-2vcpu-4gb',
    ])
    // Withdrawn rather than hidden: core needs "this size is not orderable" to be a different
    // answer from "this size does not exist".
    expect(offerings.find((offering) => offering.id === 's-1vcpu-2gb-retired')?.available).toBe(false)
  })

  it('sells no arm64, because DigitalOcean does not', async () => {
    const { provider } = build()
    expect((await provider.listOfferings()).every((offering) => offering.arch === 'amd64')).toBe(true)
  })

  it('quotes the live hourly price in USD, converting megabytes to gigabytes', async () => {
    const { provider } = build()
    const offering = (await provider.listOfferings()).find((candidate) => candidate.id === 's-2vcpu-4gb')
    expect(offering).toMatchObject({ cpu: 2, memoryGb: 4, diskGb: 80 })
    expect(offering?.hourly?.amount).toBe(0.03571)
    expect(offering?.hourly?.currency).toBe('USD')
    expect(Number.isNaN(Date.parse(offering?.hourly?.fetchedAt ?? ''))).toBe(false)
  })

  it('reports a price it does not know as null, never as zero', async () => {
    const cloud = emptyCloud()
    cloud.sizes = [{ slug: 's-priceless', memory: 1024, vcpus: 1, disk: 10, regions: ['nyc3'], available: true }]
    const { provider } = build(cloud)
    expect((await provider.listOfferings())[0]?.hourly).toBeNull()
  })
})

/* --------------------------------------------------------------------- validateSpec */

describe('validateSpec', () => {
  const check = async (spec: Partial<ProvisionSpec>) => {
    const { provider } = build()
    return await provider.validateSpec({ ...SPEC, ...spec } as ProvisionSpec).then(
      () => undefined,
      (err: unknown) => err as ProviderError,
    )
  }

  it('accepts a well-formed spec', async () => {
    expect(await check({})).toBeUndefined()
  })

  it('refuses a spec whose managed-by disagrees with this provider', async () => {
    const err = await check({ tags: { 'managed-by': 'someone-else', 'server-id': 'dev-box' } })
    expect(err?.code).toBe('invalid_spec')
    expect(err?.message).toContain('orphan')
  })

  it('asserts the server id is hostname-safe rather than sanitizing it', async () => {
    const err = await check({ serverId: 'Dev Box!' })
    expect(err).toBeDefined()
    expect(isProviderError(err)).toBe(true)
  })

  it('refuses a tag value it could not round-trip, rather than mangling it', async () => {
    const err = await check({ tags: { 'managed-by': 'rockysurf', 'server-id': 'dev-box', owner: 'a:b' } })
    expect(err?.code).toBe('invalid_spec')
    expect(err?.message).toContain('round trip')
  })

  it('enforces the documented 64 KiB user-data ceiling, and allows exactly it', async () => {
    expect(await check({ userData: 'x'.repeat(65_536) })).toBeUndefined()
    const err = await check({ userData: 'x'.repeat(65_537) })
    expect(err?.code).toBe('invalid_spec')
    expect(err?.message).toContain('65536')
  })

  it('refuses a spec with no ssh key', async () => {
    expect((await check({ sshPublicKeys: [] }))?.code).toBe('invalid_spec')
  })
})

/* ----------------------------------------------------------------------- provision */

describe('provision', () => {
  it('creates the firewall when there is none, with SSH in and everything out', async () => {
    const { cloud, provider } = build()
    await provider.provision(SPEC)

    expect(cloud.firewalls).toHaveLength(1)
    const firewall = cloud.firewalls[0]!
    expect(firewall.name).toBe('rockysurf-ssh')
    expect(sshSourcesOf(firewall)).toEqual(['203.0.113.7/32'])
    expect(firewall.tags).toEqual(['managed-by:rockysurf'])
    // A cloud firewall with no outbound rules blocks ALL egress, which would leave a droplet that
    // cannot fetch a package or clone a repository — and nothing in the logs pointing at why.
    expect(firewall.outbound_rules?.map((rule) => rule.protocol).sort()).toEqual(['icmp', 'tcp', 'udp'])
  })

  it('is ADDITIVE against an existing firewall and never revokes', async () => {
    const cloud = emptyCloud()
    cloud.firewalls.push({
      id: 'fw-1',
      name: 'rockysurf-ssh',
      tags: ['managed-by:rockysurf'],
      inbound_rules: [{ protocol: 'tcp', ports: '22', sources: { addresses: ['198.51.100.0/24'] } }],
    })
    const { provider } = build(cloud)
    await provider.provision(SPEC)

    // The operator's other network is still there. A launch may only ever widen access.
    expect(sshSourcesOf(cloud.firewalls[0])).toEqual(['198.51.100.0/24', '203.0.113.7/32'])
  })

  it('does not rewrite a firewall that already allows everything configured', async () => {
    const cloud = emptyCloud()
    cloud.firewalls.push({
      id: 'fw-1',
      name: 'rockysurf-ssh',
      tags: ['managed-by:rockysurf'],
      inbound_rules: [{ protocol: 'tcp', ports: '22', sources: { addresses: ['203.0.113.7/32'] } }],
    })
    const { provider } = build(cloud)
    await provider.provision(SPEC)
    expect(methodsFor(cloud, 'PUT /firewalls')).toHaveLength(0)
  })

  it('re-tags a firewall that has lost the tag, even when its CIDRs already match', async () => {
    const cloud = emptyCloud()
    cloud.firewalls.push({
      id: 'fw-1',
      name: 'rockysurf-ssh',
      tags: [],
      inbound_rules: [{ protocol: 'tcp', ports: '22', sources: { addresses: ['203.0.113.7/32'] } }],
    })
    const { provider } = build(cloud)
    await provider.provision(SPEC)

    // The tag is what makes the firewall apply to the droplet at all: matching CIDRs on an
    // object nothing is attached to would be a rule enforcing nothing.
    expect(cloud.firewalls[0]?.tags).toEqual(['managed-by:rockysurf'])
    expect(methodsFor(cloud, 'PUT /firewalls')).toHaveLength(1)
  })

  it('creates an ssh key it owns, named with the pairs that prove it', async () => {
    const { cloud, provider } = build()
    const result = await provider.provision(SPEC)

    const key = [...cloud.keys.values()][0]!
    expect(key.name).toBe('managed-by:rockysurf server-id:dev-box #0')
    expect(asDigitaloceanData(result.data).ownedSshKeyIds).toEqual([key.id])
  })

  it('does not claim a key that already existed', async () => {
    const cloud = emptyCloud()
    const stranger: DoSshKey = { id: 42, name: 'my laptop', fingerprint: fingerprintOf(PUBLIC_KEY) }
    cloud.keys.set(42, stranger)
    const { provider } = build(cloud)

    const result = await provider.provision(SPEC)
    // Referenced by the create, and not ours to reap: it may be embedded in other droplets.
    expect(asDigitaloceanData(result.data).ownedSshKeyIds).toEqual([])
    expect(cloud.keys.get(42)).toBe(stranger)
  })

  it('passes user-data through unchanged and reports the initial view', async () => {
    const { cloud, provider } = build()
    const result = await provider.provision(SPEC)

    expect((bodyOf(cloud, 'POST /droplets') as { user_data?: string }).user_data).toBe(SPEC.userData)
    expect(result.initial.state).toBe('pending')
    expect(result.initial.consoleUrl).toBe(digitaloceanConsoleUrl(asDigitaloceanData(result.data).dropletId))
  })

  it('encodes the tags as key:value, because DigitalOcean has no "="', async () => {
    const { cloud, provider } = build()
    await provider.provision(SPEC)
    expect((bodyOf(cloud, 'POST /droplets') as { tags?: string[] }).tags?.sort()).toEqual([
      'managed-by:rockysurf',
      'server-id:dev-box',
    ])
  })

  it('resolves a replayed create to the original droplet rather than making a second one', async () => {
    const { cloud, provider } = build()
    const first = await provider.provision(SPEC)
    const second = await provider.provision(SPEC)

    expect(asDigitaloceanData(second.data).dropletId).toBe(asDigitaloceanData(first.data).dropletId)
    expect(methodsFor(cloud, 'POST /droplets').filter((request) => request === 'POST /droplets')).toHaveLength(1)
    // And it re-derives ownership from the names, so a replay still knows what it must reap.
    expect(asDigitaloceanData(second.data).ownedSshKeyIds).toEqual(asDigitaloceanData(first.data).ownedSshKeyIds)
  })

  it('reaps the keys it minted when the droplet create fails', async () => {
    const cloud = emptyCloud({ createFails: 'size is not available in this region' })
    const { provider } = build(cloud)

    await expect(provider.provision(SPEC)).rejects.toThrow(/size is not available/)
    // Core marks the row failed WITHOUT storing a handle, so nothing would ever come back for
    // these. They are attributable to this server and to no other.
    expect([...cloud.keys.values()]).toEqual([])
  })

  it('leaves a key it did not mint alone when the droplet create fails', async () => {
    const cloud = emptyCloud({ createFails: 'nope' })
    cloud.keys.set(42, { id: 42, name: 'my laptop', fingerprint: fingerprintOf(PUBLIC_KEY) })
    const { provider } = build(cloud)

    await expect(provider.provision(SPEC)).rejects.toThrow()
    expect(cloud.keys.has(42)).toBe(true)
  })
})

/* ----------------------------------------------------------------------- terminate */

describe('terminate', () => {
  const seeded = () => {
    const cloud = emptyCloud()
    cloud.droplets.set(1, { id: 1, name: 'dev-box', status: 'active' })
    cloud.keys.set(9, { id: 9, name: sshKeyName('rockysurf', 'dev-box', 0), fingerprint: 'aa:bb' })
    return cloud
  }

  it('reaps the droplet and the keys it owns', async () => {
    const cloud = seeded()
    const { provider } = build(cloud)
    await provider.terminate({ dropletId: 1, name: 'dev-box', ownedSshKeyIds: [9] })
    expect(cloud.droplets.size).toBe(0)
    expect(cloud.keys.size).toBe(0)
  })

  it('is idempotent — not-found is success, because reconcilers retry', async () => {
    const cloud = seeded()
    const { provider } = build(cloud)
    const handle = { dropletId: 1, name: 'dev-box', ownedSshKeyIds: [9] }
    await provider.terminate(handle)
    await expect(provider.terminate(handle)).resolves.toBeUndefined()
  })

  it('reads as terminating while the destroy is in flight, not as running', async () => {
    const cloud = seeded()
    cloud.deleteLingers = true
    const { provider } = build(cloud)
    const handle = { dropletId: 1, name: 'dev-box', ownedSshKeyIds: [] }

    await provider.terminate(handle)
    // DigitalOcean still reports `active`. Believing it would tell core a machine on its way out
    // is healthy, and a reconciler would leave it alone.
    expect((await provider.describe(handle)).state).toBe('terminating')
  })

  it('reads as terminated once the droplet is gone', async () => {
    const cloud = seeded()
    const { provider } = build(cloud)
    const handle = { dropletId: 1, name: 'dev-box', ownedSshKeyIds: [] }
    await provider.describe(handle)
    await provider.terminate(handle)
    expect((await provider.describe(handle)).state).toBe('terminated')
  })
})

/* ---------------------------------------------------------------------- stop/start */

describe('stop and start', () => {
  const running = () => {
    const cloud = emptyCloud()
    cloud.droplets.set(1, { id: 1, name: 'dev-box', status: 'active' })
    return cloud
  }

  it('stops with an ACPI shutdown, and describe() sees it stopped', async () => {
    const cloud = running()
    const { provider } = build(cloud)
    await provider.stop({ dropletId: 1, name: 'dev-box' })
    expect(bodyOf(cloud, 'POST /droplets/1/actions')).toEqual({ type: 'shutdown' })
    expect((await provider.describe({ dropletId: 1, name: 'dev-box' })).state).toBe('stopped')
  })

  it('does not fail on a droplet that is already off', async () => {
    const cloud = running()
    const { provider } = build(cloud)
    await provider.stop({ dropletId: 1, name: 'dev-box' })
    await expect(provider.stop({ dropletId: 1, name: 'dev-box' })).resolves.toBeUndefined()
  })

  it('starts a stopped droplet, and does not fail on one already running', async () => {
    const cloud = running()
    cloud.droplets.get(1)!.status = 'off'
    const { provider } = build(cloud)
    await provider.start({ dropletId: 1, name: 'dev-box' })
    expect(cloud.droplets.get(1)?.status).toBe('active')
    await expect(provider.start({ dropletId: 1, name: 'dev-box' })).resolves.toBeUndefined()
  })

  it('still raises a refusal that is not "already in that state"', async () => {
    const { provider } = build(emptyCloud())
    await expect(provider.stop({ dropletId: 404, name: 'ghost' })).rejects.toThrow()
  })
})

/* --------------------------------------------------------------------- listManaged */

describe('listManaged', () => {
  it('reports droplets and keys as server-owned and the firewall as shared', async () => {
    const cloud = emptyCloud()
    cloud.droplets.set(1, {
      id: 1,
      name: 'dev-box',
      status: 'active',
      tags: ['managed-by:rockysurf', 'server-id:dev-box'],
    })
    cloud.keys.set(9, { id: 9, name: sshKeyName('rockysurf', 'dev-box', 0), fingerprint: 'aa:bb' })
    cloud.keys.set(10, { id: 10, name: 'somebody else laptop', fingerprint: 'cc:dd' })
    cloud.firewalls.push({ id: 'fw-1', name: 'rockysurf-ssh' })
    const { provider } = build(cloud)

    const managed = await provider.listManaged()
    expect(managed).toEqual([
      { kind: 'droplet', providerNativeId: '1', ownership: 'server-owned', serverId: 'dev-box' },
      { kind: 'ssh-key', providerNativeId: '9', ownership: 'server-owned', serverId: 'dev-box' },
      // Shared: one object serves every droplet in the account, so a reaper must never delete it.
      { kind: 'firewall', providerNativeId: 'fw-1', ownership: 'shared' },
    ])
  })

  it('does not claim a key belonging to another installation', async () => {
    const cloud = emptyCloud()
    cloud.keys.set(11, { id: 11, name: sshKeyName('someone-else', 'their-box', 0), fingerprint: 'ee:ff' })
    const { provider } = build(cloud)
    expect(await provider.listManaged()).toEqual([])
  })
})

/* ------------------------------------------------------------------ syncSshAccess */

describe('syncSshAccess', () => {
  const withFirewall = (addresses: string[]): FakeCloud => {
    const cloud = emptyCloud()
    cloud.firewalls.push({
      id: 'fw-1',
      name: 'rockysurf-ssh',
      tags: ['managed-by:rockysurf'],
      inbound_rules: [{ protocol: 'tcp', ports: '22', sources: { addresses } }],
      outbound_rules: [{ protocol: 'tcp', ports: '0', destinations: { addresses: ['0.0.0.0/0'] } }],
    })
    return cloud
  }

  it('skips rather than creating the firewall a settings save has no business creating', async () => {
    const { cloud, provider } = build()
    const result = await provider.syncSshAccess!()
    expect(result.status).toBe('skipped')
    expect(result.applied).toEqual([])
    expect(result.detail).toContain('creates it at the first launch')
    expect(cloud.firewalls).toHaveLength(0)
  })

  it('reports unchanged when the firewall already matches, which is the question being asked', async () => {
    const cloud = withFirewall(['203.0.113.7/32'])
    const { provider } = build(cloud)
    const result = await provider.syncSshAccess!()
    expect(result.status).toBe('unchanged')
    expect(result.applied).toEqual(['203.0.113.7/32'])
  })

  it('converges to exactly the configured list in ONE write', async () => {
    const cloud = withFirewall(['198.51.100.0/24', '203.0.113.7/32'])
    const { provider } = build(cloud, { sshAllowedCidr: ['203.0.113.8/32'] })

    const result = await provider.syncSshAccess!()
    expect(result.status).toBe('updated')
    expect(result.applied).toEqual(['203.0.113.8/32'])
    expect(sshSourcesOf(cloud.firewalls[0])).toEqual(['203.0.113.8/32'])
    expect(methodsFor(cloud, 'PUT /firewalls')).toHaveLength(1)
    expect(result.detail).toContain('198.51.100.0/24')
  })

  it('always reports nothing, because this cloud has no per-rule authorship to report', async () => {
    // Whole-object authorship (ADR-0021's amendment): there is no stamped extra to offer and no
    // unstamped entry to keep, so a keep-or-remove prompt has nothing to draw and removing a CIDR
    // takes effect in the one write above.
    const cloud = withFirewall(['198.51.100.0/24'])
    const { provider } = build(cloud)
    const result = await provider.syncSshAccess!()
    expect(result.reported).toEqual([])
    expect(result.removable).toEqual([])
  })

  it('keeps the outbound rules, so a converge does not cut the box off from the internet', async () => {
    const cloud = withFirewall(['198.51.100.0/24'])
    const { provider } = build(cloud)
    await provider.syncSshAccess!()
    expect(cloud.firewalls[0]?.outbound_rules?.map((rule) => rule.protocol).sort()).toEqual(['icmp', 'tcp', 'udp'])
  })

  it('never deletes the shared object', async () => {
    const cloud = withFirewall(['198.51.100.0/24'])
    const { provider } = build(cloud)
    await provider.syncSshAccess!()
    expect(methodsFor(cloud, 'DELETE /firewalls')).toEqual([])
    expect(cloud.firewalls).toHaveLength(1)
  })

  it('does not touch a firewall the operator named something else', async () => {
    const cloud = emptyCloud()
    const theirs: DoFirewall = {
      id: 'fw-theirs',
      name: 'my-own-firewall',
      inbound_rules: [{ protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } }],
    }
    cloud.firewalls.push(theirs)
    const { provider } = build(cloud)

    expect((await provider.syncSshAccess!()).status).toBe('skipped')
    expect(cloud.firewalls[0]).toEqual(theirs)
  })

  it('says "I do not know" rather than "applied" when the cloud does not answer', async () => {
    const provider = makeDigitaloceanProvider(VALID_CONFIG, {
      fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
      baseUrl: FAKE_BASE,
      syncDeadlineMs: 5,
    })
    const result = await provider.syncSshAccess!()
    expect(result.status).toBe('failed')
    expect(result.applied).toEqual([])
    expect(result.detail).toContain('Nothing was deleted')
  })
})

/* ------------------------------------------------------------- validateCredentials */

describe('validateCredentials', () => {
  it('proves the token and the region in one pass', async () => {
    const { provider } = build()
    await expect(provider.validateCredentials()).resolves.toBeUndefined()
  })

  it('names the regions that do exist when the configured one does not', async () => {
    const { provider } = build(emptyCloud(), { region: 'atlantis' })
    await expect(provider.validateCredentials()).rejects.toThrow(/nyc3/)
  })

  it('reports a region that is closed to new droplets as capacity, not as a bad region', async () => {
    const { provider } = build(emptyCloud(), { region: 'ams2' })
    const err = (await provider.validateCredentials().catch((error: unknown) => error)) as ProviderError
    expect(err.code).toBe('capacity')
  })

  it('reports a rejected token as auth, keeping DigitalOcean own id', async () => {
    const unauthorized = (async () =>
      new Response(JSON.stringify({ id: 'unauthorized', message: 'Unable to authenticate you.' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const provider = makeDigitaloceanProvider(VALID_CONFIG, { fetchImpl: unauthorized, baseUrl: FAKE_BASE, maxRetries: 0 })
    const err = (await provider.validateCredentials().catch((error: unknown) => error)) as ProviderError
    expect(err.code).toBe('auth')
    expect(err.providerCode).toBe('unauthorized')
    expect(err.retryable).toBe(false)
  })
})

/* ----------------------------------------------------------------------- transport */

describe('the transport', () => {
  it('pages with its OWN cursor, so a fake cloud is still reachable on page two', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input))
      seen.push(url.toString())
      const page = url.searchParams.get('page')
      const body =
        page === '1'
          ? {
              droplets: [{ id: 1 }],
              // An ABSOLUTE url at the real API, which is what DigitalOcean sends. Following it
              // verbatim would send page two at api.digitalocean.com and never reach this fake.
              links: { pages: { next: 'https://api.digitalocean.com/v2/droplets?page=2&per_page=100' } },
            }
          : { droplets: [{ id: 2 }], links: {} }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const api = new DigitaloceanApi({ token: 't', fetchImpl, baseUrl: FAKE_BASE })
    expect(await api.collect<{ id: number }>('/droplets', 'droplets')).toEqual([{ id: 1 }, { id: 2 }])
    expect(seen.every((url) => url.startsWith(FAKE_BASE))).toBe(true)
  })

  it('retries a throttled call and honours retry-after', async () => {
    let calls = 0
    const slept: number[] = []
    const fetchImpl = (async () => {
      calls += 1
      return calls === 1
        ? new Response(JSON.stringify({ id: 'too_many_requests', message: 'slow down' }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '2' },
          })
        : new Response(JSON.stringify({ account: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const api = new DigitaloceanApi({
      token: 't',
      fetchImpl,
      baseUrl: FAKE_BASE,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    await api.call('GET', '/account')
    expect(calls).toBe(2)
    expect(slept).toEqual([2000])
  })

  it('turns a transport failure into a network ProviderError rather than letting it escape', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET')
    }) as typeof fetch
    const api = new DigitaloceanApi({ token: 't', fetchImpl, baseUrl: FAKE_BASE, maxRetries: 0 })
    const err = (await api.call('GET', '/account').catch((error: unknown) => error)) as ProviderError
    expect(err.code).toBe('network')
    expect(err.retryable).toBe(true)
  })
})
