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
  /** `providers.<providerId>.sizes` — the operator's allowlist (rockysurf-j10e, rockysurf-aiqu). */
  sizes?: string[]
  /** Which config section, and which registry id, the fake provider is registered under. Default `aws`. */
  providerId?: string
  /** `preferences.tiers.<providerId>` — the user's saved types (issue #124). */
  tiers?: Record<string, string>
}

/**
 * The fake provider is registered under the id `aws` by default, but any other section's id
 * (e.g. `hetzner`) proves the same thing.
 *
 * The allowlist reaches the route from `config.providers.<id>.sizes`, looked up by registry
 * id, so a test that wants to prove the wiring — not just the filter function — needs a
 * provider whose id names a real section of the config file. Nothing cloud-specific is
 * exercised by it; the section just has to exist.
 */
async function build(options: BuildOptions = {}): Promise<void> {
  const providerId = options.providerId ?? 'aws'
  const provider = makeFakeProvider({ id: providerId, ...(options.offerings ? { offerings: options.offerings } : {}) })
  opened = openTestDatabase()

  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })

  const config = configSchema.parse(options.sizes ? { providers: { [providerId]: { sizes: options.sizes } } } : {})
  /*
   * Saved types are set AFTER the parse rather than through it (issue #124).
   *
   * Deliberate: the schema refuses a preference outside `providers.<cloud>.sizes` at boot, so
   * writing that pairing through `configSchema.parse` here would fail before the route ever ran
   * — and the route's own narrowing is exactly what one of the cases below is for. A hand-edited
   * file that predates the check reaches the route in precisely this state. That the schema
   * refuses the pairing is pinned separately, in `config/config.test.ts`.
   */
  if (options.tiers) (config.preferences.tiers as Record<string, unknown>)[providerId] = options.tiers

  const created = createApp({
    db: opened.db,
    config,
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
  /** Why the saved type was not used, when it was not (issue #124). */
  sizeNote?: string
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
    ...(typeof parsed['sizeNote'] === 'string' ? { sizeNote: parsed['sizeNote'] } : {}),
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

  /**
   * AND THE REFUSAL SAYS WHAT IT DOES SELL (rockysurf-oeay).
   *
   * The allowlist case was already answered by name, earlier and against the operator's own
   * list. This is the DEFAULT case — no allowlist set — where the message was
   * `provider aws has no offering "..."` and nothing else, so a caller that guessed wrong had
   * nothing better to try. It matters most for an agent: `offering_id` is un-enumerated in the
   * MCP schema by design, so a refusal is one of the few places it can learn a real id.
   */
  it('names the ids the cloud does sell, so a wrong guess is recoverable', async () => {
    await build()
    const { error } = await create({ size: 'small', offeringId: 'no-such-type' })
    expect(error).toContain('fake-small')
    expect(error).toContain('fake-medium')
    // Points at the surface that holds the whole list rather than trying to be it.
    expect(error).toContain('rockysurf offerings')
  })

  it('names a sold-out type too, because it is still a real id', async () => {
    // Sold out and non-existent need different answers — picking it gets the 503 that says so,
    // which is more use than being told it does not exist.
    await build()
    expect((await create({ size: 'small', offeringId: 'no-such-type' })).error).toContain('fake-sold-out')
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

/**
 * providers.hetzner.sizes SPECIFICALLY (rockysurf-aiqu).
 *
 * The enforcement above was already generic — it is keyed by registry id, not by a hardcoded
 * list of cloud names — but the CONFIG SCHEMA was not: `hetznerProviderSchema` had no `sizes`
 * field, and because that section is a `strictObject`, writing `providers.hetzner.sizes` was a
 * startup error rather than a value this route could ever see. This proves the schema now
 * accepts it AND that, once accepted, it is enforced through the same route the aws tests above
 * exercise — not merely parsed and ignored.
 */
describe('providers.hetzner.sizes is accepted and applied, same as the other clouds (rockysurf-aiqu)', () => {
  it('keeps a disallowed offering off the New Server page', async () => {
    await build({ providerId: 'hetzner', sizes: ['fake-medium'] })
    expect(await listedOfferings()).toEqual(['fake-medium'])
  })

  it('resolves a size only among the allowed offerings', async () => {
    await build({ providerId: 'hetzner', sizes: ['fake-medium'] })
    expect(row((await create({ size: 'small' })).serverId!).offeringId).toBe('fake-medium')
  })

  it('refuses a disallowed offering named directly, so the API cannot step over the limit', async () => {
    await build({ providerId: 'hetzner', sizes: ['fake-medium'] })
    const { status, error } = await create({ size: 'small', offeringId: 'fake-small' })
    expect(status).toBe(400)
    expect(error).toMatch(/fake-medium/)
  })
})

/* --------------------------------------------------------- the user's saved type wins */

/**
 * `preferences.tiers` — the favourite machine type, honoured on every surface (issue #124).
 *
 * AT THE WIRING LEVEL FOR THE SAME REASON THE REST OF THIS FILE IS: the CLI and the MCP server
 * do not resolve anything themselves, they POST a `size` to this exact route, so a create that
 * comes back with the saved type HERE is the CLI's and MCP's behaviour too. There is no third
 * resolver for them to drift from — `mcp/tools.ts` builds `{ size }` and hands it over, and
 * `cli/commands.ts` does the same.
 *
 * The fake catalogue again:
 *
 *   fake-small     2 vCPU   4 GB  arm64  $0.01  available
 *   fake-medium    4 vCPU   8 GB  amd64  $0.04  available
 *   fake-sold-out  8 vCPU  16 GB  arm64  $0.08  UNAVAILABLE
 *
 * so `small` defaults to `fake-small`, and a saved `fake-medium` is a machine the default would
 * never have chosen — which is exactly the point of saving one.
 */
describe('a saved machine type is used for that size (issue #124)', () => {
  it('uses the saved type instead of the cheapest that fits', async () => {
    await build({ tiers: { small: 'fake-medium' } })
    const { status, serverId, sizeNote } = await create({ size: 'small' })

    expect(status).toBe(201)
    expect(row(serverId!).offeringId).toBe('fake-medium')
    // Still recorded as the size that was asked for: a preference changes which machine a size
    // means, not what the row says the user asked for.
    expect(row(serverId!).size).toBe('small')
    expect(row(serverId!).arch).toBe('amd64')
    // Nothing to explain when the preference was honoured.
    expect(sizeNote).toBeUndefined()
  })

  it('honours a saved type that does not meet the size floor, because it IS the answer', async () => {
    // `large` is 4 vCPU / 8 GB and `fake-small` meets neither. Saving it anyway is a legitimate
    // thing to want, and re-refusing it against the floor would be the product arguing with a
    // setting it asked the user to make.
    await build({ tiers: { large: 'fake-small' } })
    expect(row((await create({ size: 'large' })).serverId!).offeringId).toBe('fake-small')
  })

  it('changes nothing for a size with no saved type', async () => {
    await build({ tiers: { large: 'fake-medium' } })
    // Today's behaviour, untouched: `small` still takes the cheapest that fits.
    expect(row((await create({ size: 'small' })).serverId!).offeringId).toBe('fake-small')
  })

  it('changes nothing at all on an installation that has saved nothing', async () => {
    await build()
    expect(row((await create({ size: 'small' })).serverId!).offeringId).toBe('fake-small')
    expect(row((await create({ size: 'large' })).serverId!).offeringId).toBe('fake-medium')
  })

  it('falls back and says why when the saved type is unavailable', async () => {
    await build({ tiers: { small: 'fake-sold-out' } })
    const { status, serverId, sizeNote } = await create({ size: 'small' })

    // NOT A REFUSAL. A preference that cannot be met is a reason to fall back, not a reason to
    // stop someone creating a server.
    expect(status).toBe(201)
    expect(row(serverId!).offeringId).toBe('fake-small')
    // ...and it is not silent, which is the whole point: the alternative is a user who saved a
    // type, quietly got another one for six weeks, and found out from the invoice.
    expect(sizeNote).toContain('fake-sold-out')
    expect(sizeNote).toContain('fake-small')
  })

  it('carries the provider own reason when it gives one', async () => {
    await build({
      tiers: { small: 'no-quota' },
      offerings: [
        { id: 'fake-small', cpu: 2, memoryGb: 4, arch: 'arm64', hourly: null, available: true, region: 'fake-1' },
        {
          id: 'no-quota',
          cpu: 4,
          memoryGb: 8,
          arch: 'arm64',
          hourly: null,
          available: false,
          // The shape #139 gave Azure: a refusal whose cure is a portal request, not waiting.
          unavailableReason: 'this subscription has no core quota for the Dpsv5 family',
          region: 'fake-1',
        },
      ],
    })
    const { sizeNote } = await create({ size: 'small' })
    expect(sizeNote).toContain('no core quota')
  })

  it('falls back when the saved type is not offered here at all', async () => {
    await build({ tiers: { small: 'a-type-that-was-retired' } })
    const { status, serverId, sizeNote } = await create({ size: 'small' })
    expect(status).toBe(201)
    expect(row(serverId!).offeringId).toBe('fake-small')
    expect(sizeNote).toContain('a-type-that-was-retired')
  })

  it('does not honour a saved type whose arch contradicts the one asked for', async () => {
    // `fake-medium` is amd64. A caller who explicitly asked for arm64 gets arm64 — the
    // preference is a default, and an explicit argument outranks a default.
    await build({ tiers: { small: 'fake-medium' } })
    const { serverId, sizeNote } = await create({ size: 'small', arch: 'arm64' })
    expect(row(serverId!).offeringId).toBe('fake-small')
    expect(row(serverId!).arch).toBe('arm64')
    expect(sizeNote).toMatch(/x86-64|ARM64/)
  })

  it('does not reinstate a type the operator excluded with providers.<cloud>.sizes', async () => {
    // The operator's allowlist is a policy and the preference is a default; a default never
    // steps over a policy. The catalogue is narrowed before the preference is looked for at all.
    // (`providers.aws.sizes` also refuses this pairing at boot — see `config.test.ts` — so this
    // is the belt beside that brace, for a file that predates the check.)
    await build({ tiers: { small: 'fake-small' }, sizes: ['fake-medium'] })
    const { status, serverId, sizeNote } = await create({ size: 'small' })
    expect(status).toBe(201)
    expect(row(serverId!).offeringId).toBe('fake-medium')
    expect(sizeNote).toContain('fake-small')
  })

  it('sends the saved types to the New Server page alongside the catalogue', async () => {
    await build({ tiers: { small: 'fake-medium', large: 'fake-small' } })
    const res = await app.request('/api/v1/providers', { headers: { cookie } })
    const body = (await res.json()) as { tierPreferences?: Record<string, string> }[]
    // The SPA resolves in the browser, so it needs the preference and the offering it names in
    // the same response — a second request would only create a window where it has one.
    expect(body[0]!.tierPreferences).toEqual({ small: 'fake-medium', large: 'fake-small' })
  })

  it('omits tierPreferences entirely for a cloud with nothing saved', async () => {
    await build()
    const res = await app.request('/api/v1/providers', { headers: { cookie } })
    const body = (await res.json()) as Record<string, unknown>[]
    expect(body[0]!['tierPreferences']).toBeUndefined()
  })
})
