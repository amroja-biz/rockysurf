import type { Offering } from '@rockysurf/provider-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getServer } from '../db/repositories/servers.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createEventsService } from '../services/events.js'

/**
 * SIZE AND ARCH RESOLUTION, THROUGH THE REAL ROUTE (rockysurf-clf2, rockysurf-j10e).
 *
 * The bugs these pin were live-confirmed on real GCP: an MCP create asking for `small` landed
 * on `e2-micro` because it was the cheapest thing in the catalogue, and an API create asking
 * for `arm64` was refused by the provider with `arch arm64 does not match offering e2-micro
 * (amd64)` — the route having picked an amd64 machine and then handed the caller's `arm64`
 * along beside it. Only the SPA worked, because it resolves in the browser and posts a
 * concrete `offeringId`.
 *
 * So these run AT THE WIRING LEVEL, against a real `POST /api/v1/servers` on a real app. A
 * unit test of `resolveOffering` would pass for a fix the route never called — which is
 * precisely the failure mode of the code being replaced, where a perfectly good resolver
 * already existed in `packages/web/src/lib/requirements.ts` and core simply did not use it.
 *
 * The fake provider's `validateSpec` raises the same `arch ... does not match offering ...`
 * that GCP did, so a create that reaches it with a mismatched pair fails here the way it
 * failed in production.
 *
 * The catalogue these read (`providers/fake.ts`) is:
 *
 *   fake-small     2 vCPU   4 GB  arm64  $0.01  available
 *   fake-medium    4 vCPU   8 GB  amd64  $0.04  available
 *   fake-sold-out  8 vCPU  16 GB  arm64  $0.08  UNAVAILABLE
 *
 * which makes `large` (4 vCPU / 8 GB) the interesting size: only `fake-medium` satisfies it,
 * and it is not the cheapest — so a `large` that comes back `fake-small` is the bug itself.
 */

const PASSWORD = 'correct-horse-battery-staple'

let opened: OpenedDatabase
let app: ReturnType<typeof createApp>['app']
let cookie: string

interface BuildOptions {
  /** Replaces the fake provider's whole catalogue. */
  offerings?: Offering[]
  /** `providers.aws.sizes` — the operator's allowlist (rockysurf-j10e). */
  sizes?: string[]
}

/**
 * The fake provider is registered under the id `aws` on purpose.
 *
 * The allowlist reaches the route from `config.providers.<id>.sizes`, looked up by registry
 * id, so a test that wants to prove the wiring — not just the filter function — needs a
 * provider whose id names a real section of the config file. Nothing AWS-specific is exercised
 * by it; `aws` is simply a section that exists.
 */
async function build(options: BuildOptions = {}): Promise<void> {
  const provider = makeFakeProvider({ id: 'aws', ...(options.offerings ? { offerings: options.offerings } : {}) })
  opened = openTestDatabase()

  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })

  const created = createApp({
    db: opened.db,
    config: configSchema.parse(options.sizes ? { providers: { aws: { sizes: options.sizes } } } : {}),
    secrets,
    events: createEventsService(),
    providers: new ProviderRegistry([provider]),
  })
  app = created.app

  const login = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
}

afterEach(() => {
  opened.close()
})

interface CreateResult {
  status: number
  serverId?: string
  error?: string
}

async function create(body: Record<string, unknown>): Promise<CreateResult> {
  const res = await app.request('/api/v1/servers', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json()) as Record<string, unknown>
  return {
    status: res.status,
    ...(typeof parsed['serverId'] === 'string' ? { serverId: parsed['serverId'] } : {}),
    ...(typeof parsed['error'] === 'string' ? { error: parsed['error'] } : {}),
  }
}

const row = (serverId: string) => getServer(opened.db, serverId)!

const listedOfferings = async (): Promise<string[]> => {
  const res = await app.request('/api/v1/providers', { headers: { cookie } })
  const body = (await res.json()) as { id: string; offerings: Offering[] }[]
  return body[0]!.offerings.map((o) => o.id)
}

/* ------------------------------------------------------------------ size is a floor */

describe('a size resolves to an offering that satisfies it (rockysurf-clf2)', () => {
  it('does not hand back the cheapest machine when a larger one was asked for', async () => {
    await build()
    const { status, serverId } = await create({ size: 'large' })

    expect(status).toBe(201)
    // THE REGRESSION. Before this bead, `large` came back `fake-small` — 2 vCPU and $0.01 —
    // because the route sorted the whole catalogue by price and took the head of the list.
    expect(row(serverId!).offeringId).toBe('fake-medium')
    expect(row(serverId!).size).toBe('large')
  })

  it('still takes the cheapest of the offerings that DO satisfy the size', async () => {
    await build()
    // `small` is 2 vCPU / 2 GB, which both fake-small and fake-medium meet. Cheapest wins —
    // the fix narrows the candidates, it does not stop optimising for price among them.
    expect(row((await create({ size: 'small' })).serverId!).offeringId).toBe('fake-small')
  })

  it('rounds up rather than refusing, when the cloud has nothing that fits exactly', async () => {
    // A size is a floor, not an exact match: a catalogue of one oversized machine still
    // serves `small` rather than telling the caller this cloud cannot do it.
    await build({
      offerings: [
        { id: 'only-big', cpu: 16, memoryGb: 64, arch: 'amd64', hourly: null, available: true, region: 'fake-1' },
      ],
    })
    expect(row((await create({ size: 'small' })).serverId!).offeringId).toBe('only-big')
  })

  it('records the arch of the machine it actually chose', async () => {
    await build()
    // `fake-medium` is amd64 while the cheapest offering is arm64. The code this replaced
    // wrote the CHEAPEST offering's arch onto the row, so a `large` box would have been
    // provisioned as amd64 and told the bootstrap it was arm64.
    expect(row((await create({ size: 'large' })).serverId!).arch).toBe('amd64')
  })
})

/* ------------------------------------------------------------------ arch is honoured */

describe('a requested arch is honoured before price (rockysurf-clf2)', () => {
  it('creates an amd64 box when amd64 is asked for, even though arm64 is cheaper', async () => {
    await build()
    const { status, serverId } = await create({ size: 'small', arch: 'amd64' })

    // THE LIVE FAILURE, INVERTED. This request used to resolve to the cheapest offering
    // (arm64 fake-small), keep the caller's `amd64` beside it, and come back 400 with
    // `arch amd64 does not match offering fake-small (arm64)` — the provider refusing a
    // contradiction the route had just built. Arch-only creation was impossible.
    expect(status).toBe(201)
    expect(row(serverId!).offeringId).toBe('fake-medium')
    expect(row(serverId!).arch).toBe('amd64')
  })

  it('creates an arm64 box when arm64 is asked for', async () => {
    await build()
    const { serverId } = await create({ size: 'small', arch: 'arm64' })
    expect(row(serverId!).arch).toBe('arm64')
    expect(row(serverId!).offeringId).toBe('fake-small')
  })

  it('refuses honestly, and retryably, when everything matching is sold out', async () => {
    await build()
    // `large` + arm64 matches only `fake-sold-out`, which is not available. Sold out is a
    // 503 because it is worth retrying — unlike a request this cloud can never serve.
    const { status, error } = await create({ size: 'large', arch: 'arm64' })
    expect(status).toBe(503)
    expect(error).toMatch(/sold out/i)
  })

  it('refuses, and does NOT retry-hint, when the cloud has no such architecture at all', async () => {
    await build({
      offerings: [
        { id: 'x86-only', cpu: 8, memoryGb: 32, arch: 'amd64', hourly: null, available: true, region: 'fake-1' },
      ],
    })
    const { status, error } = await create({ size: 'small', arch: 'arm64' })
    // 400, not 503: backing off and trying again will never make this cloud sell ARM.
    expect(status).toBe(400)
    expect(error).toMatch(/ARM64/)
    expect(error).not.toMatch(/sold out/i)
  })

  it('never silently substitutes a different arch to make a create succeed', async () => {
    await build({
      offerings: [
        { id: 'x86-only', cpu: 8, memoryGb: 32, arch: 'amd64', hourly: null, available: true, region: 'fake-1' },
      ],
    })
    expect((await create({ size: 'small', arch: 'arm64' })).status).toBe(400)
    // The fallback that would have made this "work" is exactly the bug: a caller who asked for
    // ARM and got x86 finds out when their binaries do not run.
    expect((await create({ size: 'small', arch: 'arm64' })).serverId).toBeUndefined()
  })
})

/* ------------------------------------------------------ an explicitly named offering */

describe('an explicitly named offering', () => {
  it('takes its arch from the offering, not from the cheapest row in the catalogue', async () => {
    await build()
    // No `arch` in the body. Before this bead the route filled it in from whatever was
    // cheapest — arm64 — while provisioning the amd64 machine the caller named.
    const { status, serverId } = await create({ size: 'small', offeringId: 'fake-medium' })
    expect(status).toBe(201)
    expect(row(serverId!).arch).toBe('amd64')
  })

  it('is refused in core when the caller also names a contradicting arch', async () => {
    await build()
    const { status, error } = await create({ size: 'small', offeringId: 'fake-medium', arch: 'arm64' })
    // This contradiction really is the caller's, so it is still refused — but the create is
    // fully specified, so the refusal comes from the provider's validateSpec rather than
    // costing a catalogue fetch. Either way it must not provision.
    expect(status).toBe(400)
    expect(error).toMatch(/does not match/)
  })

  it('is refused when the provider does not sell it', async () => {
    await build()
    expect((await create({ size: 'small', offeringId: 'no-such-type' })).status).toBe(400)
  })
})

/* ---------------------------------------------------- the operator's size allowlist */

describe('providers.<cloud>.sizes is applied, not merely displayed (rockysurf-j10e)', () => {
  it('keeps a disallowed offering off the New Server page', async () => {
    await build({ sizes: ['fake-medium'] })
    // The settings page has always called this field "the instance types offered on the New
    // Server page". This is the assertion that makes that sentence true.
    expect(await listedOfferings()).toEqual(['fake-medium'])
  })

  it('offers everything when the operator has set no allowlist', async () => {
    await build()
    expect(await listedOfferings()).toEqual(['fake-small', 'fake-medium', 'fake-sold-out'])
  })

  it('resolves a size only among the allowed offerings', async () => {
    await build({ sizes: ['fake-medium'] })
    // `small` would otherwise resolve to the cheaper fake-small. The allowlist removes it as a
    // candidate rather than being consulted afterwards.
    expect(row((await create({ size: 'small' })).serverId!).offeringId).toBe('fake-medium')
  })

  it('refuses a disallowed offering named directly, so the API cannot step over the limit', async () => {
    await build({ sizes: ['fake-medium'] })
    const { status, error } = await create({ size: 'small', offeringId: 'fake-small' })
    // An allowlist the SPA honours and the HTTP API ignores would protect nobody: the API is
    // the surface the CLI and an MCP agent use, and this field exists to stop someone starting
    // a machine the operator is not willing to pay for.
    expect(status).toBe(400)
    expect(error).toMatch(/fake-medium/)
  })

  it('refuses when the allowlist leaves nothing that satisfies the size', async () => {
    await build({ sizes: ['fake-small'] })
    // fake-small is 2 vCPU, so `large` (4 vCPU / 8 GB) cannot be served. Refusing is right;
    // quietly handing over the undersized box the operator did allow is what this fixes.
    const { status } = await create({ size: 'large' })
    expect(status).toBe(400)
  })
})
