import {
  assertDescribeAbsenceGrace,
  assertFactoryShape,
  assertInstanceStateValid,
  assertManagedShape,
  assertOfferingsShape,
  assertProviderErrorShape,
  assertProviderShape,
  type AbsenceGraceHarness,
  type DescribeRead,
} from '@rockysurf/provider-conformance'
import { isProviderError, type ComputeProvider, type ProvisionSpec } from '@rockysurf/provider-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { GceApi } from './api.js'
import { gcpConfigSchema, type GcpProviderConfig } from './config.js'
import type { PriceFeedDoc } from './feed.js'
import gcpProviderFactory from './index.js'
import {
  composeInstanceName,
  gceConsoleUrl,
  GCP_STATE_MAP,
  makeGcpProvider,
  requestIdFor,
} from './provider.js'
import type { GceInstance } from './types.js'

const PROJECT = 'demo-project'
const ZONE = 'us-central1-a'
const CIDR = '203.0.113.7/32'
const SSH_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY rockysurf@core'
const IMAGE = 'https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-20260801'

/**
 * An in-memory Compute Engine, driven through the real `GceApi`.
 *
 * The fake sits at the HTTP boundary rather than at the client's, so every test here exercises
 * the actual request building, the actual error mapping and the actual operation polling. Only
 * the cloud is fake — which is the level at which `provider-hetzner` mocks, and the reason a
 * bug in path construction is visible to these tests at all.
 */
function fakeGce() {
  const instances = new Map<string, GceInstance>()
  const firewalls = new Map<string, { name: string; sourceRanges: string[]; targetTags: string[] }>()
  const byRequestId = new Map<string, string>()

  const state = {
    instances,
    firewalls,
    /** Reads of the single-instance GET path, which is what the absence-grace harness counts. */
    instanceReads: 0,
    /** Overrides the instance GET entirely, for scripted absence tests. */
    scriptedGet: undefined as undefined | (() => GceInstance | 'absent'),
    inserts: 0,
    /** The body of the most recent insert, so tests can assert on what was actually sent. */
    lastInsertBody: undefined as undefined | Record<string, unknown>,
    /** Forces the next insert to fail with the given reason. */
    failNextInsert: undefined as undefined | string,
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const error = (status: number, reason: string, message = reason) =>
    json({ error: { code: status, message, errors: [{ reason, message }] } }, status)

  /** Every mutating call answers with an already-DONE operation, zonal or global. */
  const doneOperation = (name: string, scope: 'zone' | 'global') =>
    json({
      name,
      status: 'DONE',
      ...(scope === 'zone' ? { zone: `https://x/projects/${PROJECT}/zones/${ZONE}` } : {}),
    })

  const instanceOf = (name: string, overrides: Partial<GceInstance> = {}): GceInstance => ({
    name,
    status: 'PROVISIONING',
    zone: `https://x/projects/${PROJECT}/zones/${ZONE}`,
    machineType: `https://x/projects/${PROJECT}/zones/${ZONE}/machineTypes/t2a-standard-2`,
    networkInterfaces: [{ accessConfigs: [{ natIP: '198.51.100.10', type: 'ONE_TO_ONE_NAT' }] }],
    ...overrides,
  })

  const impl = (async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(rawUrl))
    const path = url.pathname.replace('/compute/v1', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined

    // zones.get — the credential check
    if (method === 'GET' && path === `/projects/${PROJECT}/zones/${ZONE}`) {
      return json({ name: ZONE, status: 'UP' })
    }

    // image family resolution
    if (method === 'GET' && path.includes('/global/images/family/')) {
      return json({ name: 'ubuntu-2404-20260801', selfLink: IMAGE })
    }

    // firewalls
    if (path === `/projects/${PROJECT}/global/firewalls/rockysurf-ssh`) {
      const rule = firewalls.get('rockysurf-ssh')
      return rule ? json(rule) : error(404, 'notFound', 'firewall not found')
    }
    if (method === 'POST' && path === `/projects/${PROJECT}/global/firewalls`) {
      const name = String(body?.['name'])
      if (firewalls.has(name)) return error(409, 'alreadyExists', 'the firewall already exists')
      firewalls.set(name, {
        name,
        sourceRanges: (body?.['sourceRanges'] as string[]) ?? [],
        targetTags: (body?.['targetTags'] as string[]) ?? [],
      })
      return doneOperation('op-fw', 'global')
    }

    // instances.list
    if (method === 'GET' && path === `/projects/${PROJECT}/zones/${ZONE}/instances`) {
      const filter = url.searchParams.get('filter') ?? ''
      const match = /labels\.([^=]+)=(.+)/.exec(filter)
      const items = [...instances.values()].filter((instance) =>
        match ? instance.labels?.[match[1] ?? ''] === match[2] : true,
      )
      return json({ items })
    }

    // instances.insert
    if (method === 'POST' && path === `/projects/${PROJECT}/zones/${ZONE}/instances`) {
      state.inserts++
      state.lastInsertBody = body
      if (state.failNextInsert) {
        const reason = state.failNextInsert
        state.failNextInsert = undefined
        return error(reason === 'quotaExceeded' ? 403 : 400, reason)
      }

      const requestId = url.searchParams.get('requestId') ?? ''
      const existingByRequest = byRequestId.get(requestId)
      // GCE dedupes a replayed requestId onto the ORIGINAL operation rather than creating a
      // second machine.
      if (existingByRequest) return doneOperation('op-1', 'zone')

      const name = String(body?.['name'])
      if (instances.has(name)) return error(409, 'alreadyExists', `instance ${name} already exists`)

      instances.set(
        name,
        instanceOf(name, {
          labels: (body?.['labels'] as Record<string, string>) ?? {},
          tags: body?.['tags'] as { items?: string[] },
          metadata: body?.['metadata'] as GceInstance['metadata'],
          machineType: String(body?.['machineType']),
        }),
      )
      byRequestId.set(requestId, name)
      return doneOperation('op-1', 'zone')
    }

    const instanceMatch = /^\/projects\/[^/]+\/zones\/[^/]+\/instances\/([^/]+)(\/(stop|start))?$/.exec(path)
    if (instanceMatch) {
      const name = instanceMatch[1] ?? ''
      const action = instanceMatch[3]

      if (method === 'GET') {
        state.instanceReads++
        if (state.scriptedGet) {
          const scripted = state.scriptedGet()
          return scripted === 'absent' ? error(404, 'notFound', 'no such instance') : json(scripted)
        }
        const instance = instances.get(name)
        return instance ? json(instance) : error(404, 'notFound', 'no such instance')
      }

      if (method === 'DELETE') {
        if (!instances.has(name)) return error(404, 'notFound', 'no such instance')
        instances.delete(name)
        return doneOperation('op-del', 'zone')
      }

      if (method === 'POST' && action) {
        const instance = instances.get(name)
        if (!instance) return error(404, 'notFound', 'no such instance')
        // GCE's own vocabulary: a stopped instance reports TERMINATED, not STOPPED.
        instance.status = action === 'stop' ? 'TERMINATED' : 'RUNNING'
        return doneOperation(`op-${action}`, 'zone')
      }
    }

    return error(404, 'notFound', `unrouted ${method} ${path}`)
  }) as unknown as typeof fetch

  return { impl, state, instanceOf }
}

function config(overrides: Partial<GcpProviderConfig> = {}): GcpProviderConfig {
  return gcpConfigSchema.parse({ projectId: PROJECT, zone: ZONE, sshAllowedCidr: CIDR, ...overrides })
}

/**
 * A stand-in for `prices/v1/gcp.json` (gh issue #100, ADR-0009; rockysurf-ndx6).
 *
 * The real numbers now live in `scripts/gcp-transcribed-prices.json` and reach an install over
 * the network, so these tests inject a document rather than asserting against a bundled table —
 * the same `feedOf`/FEED pattern `provider-aws` and `provider-azure` use.
 *
 * TWO DATES, ON PURPOSE. The document-level `fetchedAt` is the OLDEST transcription (the
 * generator's floor), and `transcribedAt` carries the day each row was actually read off
 * Google's pricing page. That split is the honesty mechanism a daily republish must not
 * flatten, so it is fixtured here exactly as the generator emits it.
 */
const E2_T2A_TRANSCRIBED_AT = '2026-08-13T00:00:00.000Z'
const C4A_TRANSCRIBED_AT = '2026-08-21T00:00:00.000Z'

const FEED: PriceFeedDoc = {
  fetchedAt: E2_T2A_TRANSCRIBED_AT,
  currency: 'USD',
  transcribedAt: {
    't2a-standard-2': E2_T2A_TRANSCRIBED_AT,
    'e2-standard-2': E2_T2A_TRANSCRIBED_AT,
    'c4a-standard-4': C4A_TRANSCRIBED_AT,
  },
  regions: {
    'us-central1': { 't2a-standard-2': 0.077, 'e2-standard-2': 0.06701142, 'c4a-standard-4': 0.1796 },
  },
}

const feedOf = (doc: PriceFeedDoc | null) => ({ get: async () => doc })

let gce: ReturnType<typeof fakeGce>
let provider: ComputeProvider

function build(
  overrides: Partial<GcpProviderConfig> = {},
  priceFeed: { get(): Promise<PriceFeedDoc | null> } = feedOf(FEED),
): ComputeProvider {
  return makeGcpProvider({
    config: config(overrides),
    api: new GceApi({
      projectId: overrides.projectId ?? PROJECT,
      tokenSource: { getAccessToken: async () => 'test-token' },
      fetchImpl: gce.impl,
      sleep: async () => {},
      operationPollMs: 0,
    }),
    // The propagation grace is real behaviour and is exercised below; the WAITING is not, so
    // the delay is zeroed rather than the attempt count.
    sleep: async () => {},
    priceFeed,
  })
}

function spec(overrides: Partial<ProvisionSpec> = {}): ProvisionSpec {
  return {
    serverId: 'srv-abc123',
    name: 'dev-box',
    offeringId: 't2a-standard-2',
    arch: 'arm64',
    sshPublicKeys: [SSH_KEY],
    userData: '#cloud-config\n',
    tags: { 'managed-by': 'rockysurf', 'server-id': 'srv-abc123' },
    idempotencyKey: 'idem-abc',
    ...overrides,
  }
}

beforeEach(() => {
  gce = fakeGce()
  provider = build()
})

describe('SDK conformance', () => {
  it('satisfies the shared provider shape checks', () => {
    assertProviderShape(provider)
  })

  it('satisfies the factory shape, and createProvider does no I/O', () => {
    assertFactoryShape(gcpProviderFactory, config())
  })

  it('offers only well-formed offerings', async () => {
    assertOfferingsShape(await provider.listOfferings())
  })

  it('reports only well-formed managed resources', async () => {
    await provider.provision(spec())
    assertManagedShape(await provider.listManaged())
  })

  it('throws only ProviderErrors with frozen codes', async () => {
    gce.state.failNextInsert = 'quotaExceeded'
    await provider.provision(spec()).catch((err: unknown) => assertProviderErrorShape(err))
  })

  it('declares the capability profile from the matrix', () => {
    expect(provider.capabilities).toEqual({
      stop: true,
      ipStableAcrossStop: false,
      canInjectHostKeys: true,
      userDataMaxBytes: 262144,
      generatesUserData: true,
    })
  })
})

describe('the state map', () => {
  /**
   * THE WHOLE MAPPING, PINNED AS A LITERAL.
   *
   * The per-status tests below say what each mapping is; this one says that the set of mappings
   * is exactly this and nothing else, so that ANY edit — adding a status, removing one, or
   * "correcting" GCE's TERMINATED to the SDK's identically-spelled `terminated` — fails a test
   * whose name explains why it is failing rather than passing silently.
   *
   * That last case is the one this exists for. A maintainer who knows the SDK vocabulary and
   * not GCE's would read `TERMINATED: 'stopped'` as an obvious typo, and fixing it would tell
   * core that a stopped, disk-billing instance is gone (ADR-0003, A4 — arriving here through a
   * name collision rather than through eventual consistency).
   */
  it('is exactly this mapping, so a future edit cannot pass unnoticed', () => {
    expect(GCP_STATE_MAP).toEqual({
      PROVISIONING: 'pending',
      STAGING: 'pending',
      PENDING: 'pending',
      RUNNING: 'running',
      STOPPING: 'stopping',
      PENDING_STOP: 'stopping',
      // GCE's TERMINATED means "stopped, disk intact, restartable". It is NOT the SDK's
      // `terminated`, and changing it to that is a data-loss bug, not a spelling fix.
      STOPPED: 'stopped',
      TERMINATED: 'stopped',
      // GCE's word for an actual teardown in progress. This is the SDK's `terminating`.
      DEPROVISIONING: 'terminating',
      // Resumed by instances.resume, not instances.start, so reporting `stopped` would offer
      // core a start that fails.
      SUSPENDING: 'unknown',
      SUSPENDED: 'unknown',
      REPAIRING: 'unknown',
    })
  })

  it('never maps any GCE status to the SDK terminated', () => {
    // `terminated` is reserved for ABSENCE, and only after the propagation grace: it means the
    // provider has released the resources. No GCE status can produce it, because a GCE instance
    // that still answers instances.get still exists. Stated as its own assertion because it is
    // the invariant the trap violates, independent of any particular status name.
    expect(Object.values(GCP_STATE_MAP)).not.toContain('terminated')
  })

  it('maps GCE TERMINATED to stopped, NOT to terminated', () => {
    // THE TRAP THIS PROVIDER EXISTS TO AVOID. GCE and the SDK share the word and mean
    // different things by it: GCE's TERMINATED is "stopped, disk intact, restartable", and
    // reporting it as the SDK's `terminated` would tell core a live, billing resource is gone.
    expect(GCP_STATE_MAP['TERMINATED']).toBe('stopped')
  })

  it('maps DEPROVISIONING to terminating, which is the real teardown', () => {
    expect(GCP_STATE_MAP['DEPROVISIONING']).toBe('terminating')
  })

  it.each([
    ['PROVISIONING', 'pending'],
    ['STAGING', 'pending'],
    ['RUNNING', 'running'],
    ['STOPPING', 'stopping'],
    ['PENDING_STOP', 'stopping'],
    ['STOPPED', 'stopped'],
    ['SUSPENDED', 'unknown'],
    ['SUSPENDING', 'unknown'],
    ['REPAIRING', 'unknown'],
  ])('maps %s to %s', (gceStatus, expected) => {
    expect(GCP_STATE_MAP[gceStatus]).toBe(expected)
    assertInstanceStateValid(expected)
  })

  it('reports a status it has never heard of as unknown rather than guessing', async () => {
    await provider.provision(spec())
    const name = composeInstanceName('rockysurf', 'srv-abc123')
    const instance = gce.state.instances.get(name)!
    instance.status = 'SOMETHING_NEW'
    instance.statusMessage = 'the cloud invented a state'

    const view = await provider.describe({ instanceName: name, zone: ZONE, projectId: PROJECT })
    expect(view.state).toBe('unknown')
    expect(view.failureReason).toBe('the cloud invented a state')
  })

  it('a stopped instance is restartable rather than gone', async () => {
    const { data } = await provider.provision(spec())
    await provider.stop(data)
    // The fake sets GCE's own TERMINATED here, which is what a really-stopped box reports.
    expect((await provider.describe(data)).state).toBe('stopped')
    await provider.start(data)
    expect((await provider.describe(data)).state).toBe('running')
  })
})

describe('offerings and prices', () => {
  it('prices in USD with a fetchedAt stamp from the feed (amendment B2)', async () => {
    const offering = (await provider.listOfferings()).find((o) => o.id === 't2a-standard-2')
    expect(offering?.hourly).toEqual({ amount: 0.077, currency: 'USD', fetchedAt: E2_T2A_TRANSCRIBED_AT })
  })

  it('lists a type the feed carries no price for, unpriced rather than omitted', async () => {
    // Unlike provider-aws, an absent price here never means "this zone does not sell it": the
    // catalogue is a fixed list and availability is the `available` flag's job. e2-micro is in
    // GCP_TYPES and deliberately not in the fixture feed.
    const offering = (await provider.listOfferings()).find((o) => o.id === 'e2-micro')
    expect(offering).toBeDefined()
    expect(offering?.hourly).toBeNull()
  })

  it('lists every offering unpriced when the feed is unreachable, with the catalogue intact', async () => {
    // The owner's no-fallback ruling (ADR-0009): no stale bundled table, no missing catalogue.
    const offline = await build({}, feedOf(null)).listOfferings()
    const online = await provider.listOfferings()

    expect(offline.map((o) => o.id)).toEqual(online.map((o) => o.id))
    expect(offline.every((o) => o.hourly === null)).toBe(true)
    expect(offline.some((o) => o.available)).toBe(true)
  })

  it('offers both architectures', async () => {
    const offerings = await provider.listOfferings()
    expect(offerings.some((o) => o.arch === 'arm64')).toBe(true)
    expect(offerings.some((o) => o.arch === 'amd64')).toBe(true)
  })

  it('reports hourly null in a region the feed does not cover, rather than a wrong number', async () => {
    // Reusing a us-central1 price for europe-west4 would be silently wrong; null means unknown.
    const elsewhere = build({ zone: 'europe-west4-a' })
    expect((await elsewhere.listOfferings()).every((o) => o.hourly === null)).toBe(true)
  })

  it('marks arm64 unavailable in a zone that has neither T2A nor C4A, rather than omitting it', async () => {
    // AMENDMENT B1, doing real work. us-west3 carries neither arm64 family, and a size selector
    // must be able to say "this zone has no ARM" rather than silently having none.
    const noArm = build({ zone: 'us-west3-a' })
    const offerings = await noArm.listOfferings()
    const arm = offerings.filter((o) => o.arch === 'arm64')

    expect(arm.length).toBeGreaterThan(0)
    expect(arm.every((o) => !o.available)).toBe(true)
    expect(offerings.filter((o) => o.arch === 'amd64').every((o) => o.available)).toBe(true)
  })

  it('marks T2A unavailable but C4A available in the zone C4A exists to close the gap in', async () => {
    // THE WHOLE POINT OF C4A. us-central1-c is the zone T2A_ZONES is conspicuously missing and
    // this provider's default zone dodges — C4A carries it, so an operator there is not
    // actually stuck on amd64. One `available` flag per row means both facts can be true at
    // once without either family's flag lying about the other.
    const zone = 'us-central1-c'
    const offerings = await build({ zone }).listOfferings()
    const t2a = offerings.filter((o) => o.id.startsWith('t2a-'))
    const c4a = offerings.filter((o) => o.id.startsWith('c4a-'))

    expect(t2a.length).toBeGreaterThan(0)
    expect(t2a.every((o) => !o.available)).toBe(true)
    expect(c4a.length).toBeGreaterThan(0)
    expect(c4a.every((o) => o.available)).toBe(true)
  })

  it('marks arm64 available in a zone that has both T2A and C4A', async () => {
    const offerings = await build({ zone: 'europe-west4-a' }).listOfferings()
    expect(offerings.filter((o) => o.arch === 'arm64').every((o) => o.available)).toBe(true)
  })

  it('reports the zone as the region, because stock varies per zone', async () => {
    expect((await provider.listOfferings()).every((o) => o.region === ZONE)).toBe(true)
  })

  it("stamps c4a-standard-* with the feed's per-row transcription date, not the document floor", async () => {
    // The c4a rows were transcribed eight days after e2/t2a (rockysurf-h6mb); reusing the older
    // stamp would claim they were read on a day nobody looked at them. The document-level
    // fetchedAt IS that older date, so this passes only if the per-row map is being honoured.
    const offering = (await provider.listOfferings()).find((o) => o.id === 'c4a-standard-4')
    expect(offering?.hourly).toEqual({ amount: 0.1796, currency: 'USD', fetchedAt: C4A_TRANSCRIBED_AT })
    expect(C4A_TRANSCRIBED_AT).not.toBe(FEED.fetchedAt)
  })

  it('falls back to the document floor for a row the feed does not stamp', async () => {
    // The generator sets the document fetchedAt to the OLDEST transcription, so an unstamped row
    // is dated conservatively rather than optimistically.
    const unstamped: PriceFeedDoc = { ...FEED, transcribedAt: { 't2a-standard-2': E2_T2A_TRANSCRIBED_AT } }
    const offerings = await build({}, feedOf(unstamped)).listOfferings()
    expect(offerings.find((o) => o.id === 'c4a-standard-4')?.hourly?.fetchedAt).toBe(FEED.fetchedAt)
  })
})

describe('validateSpec', () => {
  const rejects = async (overrides: Partial<ProvisionSpec>, matching: RegExp) => {
    const err = await provider.validateSpec(spec(overrides)).catch((e: unknown) => e)
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('invalid_spec')
    expect(String(err)).toMatch(matching)
  }

  it('rejects an unknown offering', () => rejects({ offeringId: 'n1-standard-1' }, /no such offering/))

  it('rejects an arch that does not match the offering', () =>
    rejects({ offeringId: 't2a-standard-2', arch: 'amd64' }, /does not match offering/))

  it('rejects an offering the configured zone does not sell', async () => {
    const noArm = build({ zone: 'us-central1-c' })
    const err = await noArm.validateSpec(spec()).catch((e: unknown) => e)
    assertProviderErrorShape(err)
    // NOT `capacity`, which is retryable and means "sold out today". A zone that has never
    // offered T2A is a permanent no, and inviting an endless retry would be wrong.
    expect(isProviderError(err) && err.code).toBe('invalid_spec')
    expect(String(err)).toContain('us-central1-a')
  })

  it('rejects an empty key list', () => rejects({ sshPublicKeys: [] }, /ssh public key/))

  it('rejects a missing idempotency key', () => rejects({ idempotencyKey: '' }, /idempotencyKey/))

  it('rejects user-data over the metadata ceiling', () =>
    rejects({ userData: 'x'.repeat(262145) }, /262144B per-metadata-value ceiling/))

  it('rejects a managed-by tag that disagrees with this provider (D3)', () =>
    rejects({ tags: { 'managed-by': 'someone-else' } }, /but this provider reconciles/))

  it('rejects a tag that is not a legal GCE label', () =>
    rejects({ tags: { 'Managed-By': 'rockysurf' } }, /not a legal GCE label key/))

  it('rejects a composed name that would exceed the GCE limit', () =>
    // Caught here rather than truncated, because the name is also the dedupe mechanism: a
    // silently shortened name could collide two servers onto one machine.
    rejects({ serverId: `srv-${'a'.repeat(60)}` }, /at most 63 characters/))

  it('accepts a server id starting with a digit, because the prefix makes the name legal', async () => {
    // GCE names must start with a LETTER, which the SDK's hostname-safe rule does not require.
    // `managedBy` is what closes that gap structurally rather than by sanitizing.
    await expect(provider.validateSpec(spec({ serverId: '9lives' }))).resolves.toBeUndefined()
  })

  it('rejects a C4A offering the configured zone does not sell, naming C4A rather than T2A', async () => {
    // us-west3 carries neither arm64 family; the message must not blame T2A for a C4A request.
    const noC4a = build({ zone: 'us-west3-a', bootDiskType: 'hyperdisk-balanced' })
    const err = await noC4a
      .validateSpec(spec({ offeringId: 'c4a-standard-2', arch: 'arm64' }))
      .catch((e: unknown) => e)
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('invalid_spec')
    expect(String(err)).toMatch(/C4A \(arm64\) exists only in/)
    expect(String(err)).toContain('us-central1-c')
  })
})

describe('boot disk type resolved per machine family (rockysurf-ev41.9 / rockysurf-h6mb)', () => {
  it('refuses C4A paired with a Persistent Disk boot disk type, naming the constraint', async () => {
    // Default config is bootDiskType: 'pd-balanced' — legal for e2/t2a, not for C4A.
    const err = await provider
      .validateSpec(spec({ offeringId: 'c4a-standard-4', arch: 'arm64' }))
      .catch((e: unknown) => e)
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('invalid_spec')
    expect(String(err)).toMatch(/C4A supports Hyperdisk only/)
    expect(String(err)).toContain("bootDiskType 'pd-balanced'")
  })

  it('accepts C4A paired with hyperdisk-balanced', async () => {
    const hyperdisk = build({ bootDiskType: 'hyperdisk-balanced' })
    await expect(
      hyperdisk.validateSpec(spec({ offeringId: 'c4a-standard-4', arch: 'arm64' })),
    ).resolves.toBeUndefined()
  })

  it('refuses e2 paired with hyperdisk-balanced — this provider does not expose Hyperdisk for it (yet)', async () => {
    const hyperdisk = build({ bootDiskType: 'hyperdisk-balanced' })
    const err = await hyperdisk.validateSpec(spec({ offeringId: 'e2-micro', arch: 'amd64' })).catch((e: unknown) => e)
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('invalid_spec')
    expect(String(err)).toMatch(/Persistent Disk only/)
  })

  it('refuses T2A paired with hyperdisk-balanced the same way', async () => {
    const hyperdisk = build({ bootDiskType: 'hyperdisk-balanced' })
    const err = await hyperdisk.validateSpec(spec()).catch((e: unknown) => e) // default spec() is t2a-standard-2
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('invalid_spec')
    expect(String(err)).toMatch(/Persistent Disk only/)
  })

  it('still accepts e2/t2a paired with any Persistent Disk type', async () => {
    for (const bootDiskType of ['pd-balanced', 'pd-standard', 'pd-ssd'] as const) {
      const pd = build({ bootDiskType })
      await expect(pd.validateSpec(spec({ offeringId: 't2a-standard-2', arch: 'arm64' }))).resolves.toBeUndefined()
      await expect(pd.validateSpec(spec({ offeringId: 'e2-micro', arch: 'amd64' }))).resolves.toBeUndefined()
    }
  })
})

describe('provision', () => {
  it('creates an instance with the labels, tag, image and user-data it was given', async () => {
    const { data, initial } = await provider.provision(spec())
    const name = composeInstanceName('rockysurf', 'srv-abc123')

    expect(data).toEqual({ instanceName: name, zone: ZONE, projectId: PROJECT })
    expect(initial.state).toBe('pending')

    const created = gce.state.instances.get(name)!
    expect(created.labels).toMatchObject({ 'managed-by': 'rockysurf', 'server-id': 'srv-abc123' })
    // The network tag is what the shared firewall rule matches on. Without it the box comes up
    // with no SSH ingress at all and the bootstrap times out against a closed port.
    expect(created.tags?.items).toEqual(['rockysurf-ssh'])
    expect(created.machineType).toContain('t2a-standard-2')

    const metadata = Object.fromEntries((created.metadata?.items ?? []).map((i) => [i.key, i.value]))
    // Passed through verbatim: the provider must never append to the rendered document.
    expect(metadata['user-data']).toBe('#cloud-config\n')
    expect(metadata['block-project-ssh-keys']).toBe('TRUE')
  })

  it('gives the box no Google Cloud identity', async () => {
    // The AWS provider's "no instance profile, no iam:* anywhere", in GCE's terms. On the REST
    // API omitting `serviceAccounts` creates an instance with no service account at all, which
    // also keeps setServiceAccount and iam.serviceAccounts.actAs out of the published role.
    await provider.provision(spec())
    // Asserted against the REQUEST BODY, not against the fake's copy of it: the fake only
    // stores the fields it models, so checking that would pass no matter what was sent.
    expect(gce.state.lastInsertBody).toBeDefined()
    expect('serviceAccounts' in (gce.state.lastInsertBody ?? {})).toBe(false)
  })

  it('reports a console URL from the moment the instance exists (E16)', async () => {
    const { initial } = await provider.provision(spec())
    expect(initial.consoleUrl).toBe(
      `https://console.cloud.google.com/compute/instancesDetail/zones/${ZONE}/instances/rockysurf-srv-abc123?project=${PROJECT}`,
    )
  })

  it('creates the shared firewall rule once and reuses it afterwards', async () => {
    await provider.provision(spec())
    expect(gce.state.firewalls.get('rockysurf-ssh')).toMatchObject({
      sourceRanges: [CIDR],
      targetTags: ['rockysurf-ssh'],
    })

    // A second provider against the same project adopts the existing rule rather than failing.
    const second = build()
    await expect(second.provision(spec({ serverId: 'srv-two', idempotencyKey: 'idem-two' }))).resolves.toBeDefined()
    expect(gce.state.firewalls.size).toBe(1)
  })

  it('adopts the rule when a concurrent provision wins the race', async () => {
    const [a, b] = [build(), build()]
    await Promise.all([
      a.provision(spec({ serverId: 'srv-a', idempotencyKey: 'idem-a' })),
      b.provision(spec({ serverId: 'srv-b', idempotencyKey: 'idem-b' })),
    ])
    expect(gce.state.firewalls.size).toBe(1)
    expect(gce.state.instances.size).toBe(2)
  })
})

describe('idempotency', () => {
  it('derives a valid, stable, non-zero UUID from the idempotency key', () => {
    const id = requestIdFor('idem-abc')
    // GCE requires "a valid UUID with the exception that zero UUID is not supported".
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id).not.toBe('00000000-0000-0000-0000-000000000000')
    // Stable, or the dedupe is decorative.
    expect(requestIdFor('idem-abc')).toBe(id)
    expect(requestIdFor('idem-abd')).not.toBe(id)
  })

  it('returns the original instance on a replay instead of creating a second one', async () => {
    const first = await provider.provision(spec())
    const replay = await provider.provision(spec())

    expect(replay.data).toEqual(first.data)
    expect(gce.state.instances.size).toBe(1)
  })

  it('adopts its own instance when the name collides but the requestId has expired', async () => {
    await provider.provision(spec())
    // A fresh provider has no memory of the request id, and GCE has forgotten it too — so the
    // replay arrives as a plain name collision, which is the second dedupe mechanism.
    const later = build()
    const result = await later.provision(spec({ idempotencyKey: 'a-completely-different-key' }))

    expect(result.data).toMatchObject({ instanceName: composeInstanceName('rockysurf', 'srv-abc123') })
    expect(gce.state.instances.size).toBe(1)
  })

  it('refuses to adopt a name held by somebody else', async () => {
    // ADR-0003 forbids claiming pre-existing resources a provider merely matched. A machine
    // wearing our name but not our labels belongs to someone, and taking it over would put two
    // logical servers on one box.
    const name = composeInstanceName('rockysurf', 'srv-abc123')
    gce.state.instances.set(name, gce.instanceOf(name, { labels: { 'managed-by': 'someone-else' } }))

    const err = await provider.provision(spec()).catch((e: unknown) => e)
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('conflict')
    expect(String(err)).toContain('not managed by this installation')
  })
})

describe('terminate', () => {
  it('deletes the instance', async () => {
    const { data } = await provider.provision(spec())
    await provider.terminate(data)
    expect(gce.state.instances.size).toBe(0)
  })

  it('is idempotent: a second terminate is success, not an error', async () => {
    const { data } = await provider.provision(spec())
    await provider.terminate(data)
    // Reconcilers retry, so not-found has to be the success path.
    await expect(provider.terminate(data)).resolves.toBeUndefined()
  })

  it('reads STOPPING as terminating once it has asked for the delete', async () => {
    // THE AMBIGUITY GCE FORCES. Its STOPPING means "stopping (either being deleted or
    // killed)" — one status for two SDK states — and nothing on the instance says which. A
    // delete this process issued is the evidence that decides it.
    const { data } = await provider.provision(spec())
    const name = String(data['instanceName'])
    const instance = gce.state.instances.get(name)!

    expect((await provider.describe(data)).state).toBe('pending')
    instance.status = 'STOPPING'
    expect((await provider.describe(data)).state).toBe('stopping')

    // Terminate, but hold the instance in STOPPING so the window is observable.
    gce.state.scriptedGet = () => ({ ...instance, status: 'STOPPING' })
    await provider.terminate(data).catch(() => undefined)
    expect((await provider.describe(data)).state).toBe('terminating')
  })
})

describe('listManaged', () => {
  it('reports instances as server-owned and the firewall rule as shared', async () => {
    await provider.provision(spec())
    const managed = await provider.listManaged()

    expect(managed).toContainEqual({
      kind: 'instance',
      providerNativeId: composeInstanceName('rockysurf', 'srv-abc123'),
      ownership: 'server-owned',
      serverId: 'srv-abc123',
    })
    // Shared, so a reconciler accounts for it and never reaps it — deleting this closes
    // port 22 on every running instance at once (ADR-0003, D1).
    expect(managed).toContainEqual({ kind: 'firewall', providerNativeId: 'rockysurf-ssh', ownership: 'shared' })
  })

  it('ignores instances belonging to another installation', async () => {
    await provider.provision(spec())
    gce.state.instances.set('other-thing', gce.instanceOf('other-thing', { labels: { 'managed-by': 'someone-else' } }))

    const managed = await provider.listManaged()
    expect(managed.map((r) => r.providerNativeId)).not.toContain('other-thing')
  })

  it('still reports a stopped instance, because it still exists and still bills', async () => {
    const { data } = await provider.provision(spec())
    await provider.stop(data)
    expect((await provider.listManaged()).some((r) => r.kind === 'instance')).toBe(true)
  })

  it('reports the firewall rule even before any instance exists', async () => {
    gce.state.firewalls.set('rockysurf-ssh', { name: 'rockysurf-ssh', sourceRanges: [CIDR], targetTags: [] })
    expect(await provider.listManaged()).toEqual([
      { kind: 'firewall', providerNativeId: 'rockysurf-ssh', ownership: 'shared' },
    ])
  })
})

describe('validateCredentials', () => {
  it('reads the configured zone, which proves credential, project and zone at once', async () => {
    await expect(provider.validateCredentials()).resolves.toBeUndefined()
  })

  it('surfaces the cloud refusal as a ProviderError rather than letting it escape raw', async () => {
    // The real distinction between a bad credential (401/403), a project with the Compute API
    // switched off (403 accessNotConfigured) and a zone that does not exist (404) is the
    // cloud's to draw; this asserts only that whichever it draws arrives in core's vocabulary.
    const wrong = build({ projectId: 'not-the-project' })
    const err = await wrong.validateCredentials().catch((e: unknown) => e)
    assertProviderErrorShape(err)
    expect(isProviderError(err) && err.code).toBe('not_found')
  })
})

describe('the console URL', () => {
  it('needs no configuration GCP does not already give it', () => {
    // Unlike Hetzner, which needs a numeric project id its API never reports, everything in a
    // GCE console URL is something this provider already holds.
    expect(gceConsoleUrl(PROJECT, ZONE, 'box')).toContain(`project=${PROJECT}`)
    expect(gceConsoleUrl('', ZONE, 'box')).toBeUndefined()
  })
})

/* ------------------------------------------------------- describe() absence grace (A4) */

describe('the describe() propagation grace', () => {
  it('honours the shared conformance probe', async () => {
    const harness: AbsenceGraceHarness = {
      provider: 'gcp',

      neverSeenRunning(script: readonly DescribeRead[]) {
        const local = fakeGce()
        gce = local
        const built = build()
        const name = 'rockysurf-srv-grace'
        let index = 0

        local.state.scriptedGet = () => {
          // The script answers in order and then repeats its LAST entry forever.
          const entry = script[Math.min(index++, script.length - 1)]
          return entry === 'running'
            ? local.instanceOf(name, { status: 'RUNNING' })
            : 'absent'
        }

        return {
          async run() {
            local.state.instanceReads = 0
            const view = await built.describe({ instanceName: name, zone: ZONE, projectId: PROJECT })
            return { view, reads: local.state.instanceReads }
          },
        }
      },

      goneAfterRunning() {
        const local = fakeGce()
        gce = local
        const built = build()
        const name = 'rockysurf-srv-seen'

        return {
          async run() {
            // Observe it running first — that is what makes its later absence unambiguous.
            local.state.scriptedGet = () => local.instanceOf(name, { status: 'RUNNING' })
            await built.describe({ instanceName: name, zone: ZONE, projectId: PROJECT })

            local.state.scriptedGet = () => 'absent'
            local.state.instanceReads = 0
            const view = await built.describe({ instanceName: name, zone: ZONE, projectId: PROJECT })
            return { view, reads: local.state.instanceReads }
          },
        }
      },
    }

    await assertDescribeAbsenceGrace(harness)
  })

  it('does not report a just-created instance as terminated', async () => {
    // The gyp1.4 data-loss bug, expressed against this provider directly. If GCE ever answers
    // not-found for a machine it has just created, believing the first read marks a healthy,
    // billing instance dead — and terminate() then no-ops on it forever.
    let reads = 0
    gce.state.scriptedGet = () => (++reads < 4 ? 'absent' : gce.instanceOf('box', { status: 'RUNNING' }))

    const view = await provider.describe({ instanceName: 'box', zone: ZONE, projectId: PROJECT })
    expect(view.state).toBe('running')
  })
})
