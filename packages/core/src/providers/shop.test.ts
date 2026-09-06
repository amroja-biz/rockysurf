import { describe, expect, it, vi } from 'vitest'
import { configSchema } from '../config/schema.js'
import type { SafeFetchResult } from '../packs/safe-fetch.js'
import { createProviderShopClient } from './shop.js'
import { providerRegistryIndexSchema } from './shop-index.js'

/**
 * The provider listing: its format, and the client that reads it (ADR-0028).
 *
 * The schema tests are the load-bearing half. `providers.json` is a document written by somebody
 * else and read by a control plane holding cloud credentials, so what it may NOT contain is the
 * part worth pinning: no trust field (ADR-0006's rule, which is why the sentence on every card
 * is Rocky Surf's constant), no http artifact URL, no provider id that could never be a config
 * section key.
 */

const BASE = configSchema.parse({}).registry.sources[0]!.url
const SHOP = configSchema.parse({}).registry.sources[0]!.name

const ENTRY = {
  providerId: 'nimbus',
  name: 'Nimbus Cloud',
  description: 'A fixture cloud.',
  version: '1.0.0',
  package: '@fixture/rockysurf-provider-nimbus',
  tarball: 'https://example.test/nimbus-1.0.0.tgz',
  sha256: 'a'.repeat(64),
  settings: [{ name: 'token', label: 'API token variable', kind: 'secret' }],
  capabilities: {
    stop: true,
    ipStableAcrossStop: true,
    canInjectHostKeys: false,
    generatesUserData: false,
    userDataMaxBytes: 0,
    billsWhileStopped: true,
  },
}

const INDEX = JSON.stringify({ version: 1, generatedAt: '2026-09-04T00:00:00.000Z', providers: [ENTRY] })

function stubFetch(responses: Record<string, string>) {
  return vi.fn(async (url: string): Promise<SafeFetchResult> => {
    const body = responses[url]
    return body === undefined ? { ok: false, reason: `Could not fetch ${url}` } : { ok: true, text: body }
  })
}

const client = (responses: Record<string, string> = { [`${BASE}/providers.json`]: INDEX }, overrides = {}) =>
  createProviderShopClient({ config: configSchema.parse({ registry: overrides }).registry, fetchText: stubFetch(responses) })

describe('the provider listing format', () => {
  it('accepts a well-formed entry', () => {
    expect(providerRegistryIndexSchema.safeParse(JSON.parse(INDEX)).success).toBe(true)
  })

  it('refuses a trust field, rather than ignoring one (ADR-0006)', () => {
    const parsed = providerRegistryIndexSchema.safeParse({
      version: 1,
      generatedAt: '2026-09-04T00:00:00.000Z',
      providers: [{ ...ENTRY, trust: 'official' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses an http artifact, because a provider is code', () => {
    const parsed = providerRegistryIndexSchema.safeParse({
      version: 1,
      generatedAt: '2026-09-04T00:00:00.000Z',
      providers: [{ ...ENTRY, tarball: 'http://example.test/nimbus.tgz' }],
    })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('https')
  })

  it('refuses a provider id that could not be a config section key', () => {
    /* The same rule `config/personal-providers.ts` puts on the key of a `providers:` section:
       an RFC 1123 label, lowercased. A listing that offered anything else would be offering an
       entry that could never be written into a config file. */
    for (const providerId of ['Nimbus', 'nim bus', 'nimbus_cloud', '-nimbus', 'nimbus-']) {
      expect(
        providerRegistryIndexSchema.safeParse({
          version: 1,
          generatedAt: '2026-09-04T00:00:00.000Z',
          providers: [{ ...ENTRY, providerId }],
        }).success,
      ).toBe(false)
    }
  })

  it('refuses a settings kind the page has no control for', () => {
    const parsed = providerRegistryIndexSchema.safeParse({
      version: 1,
      generatedAt: '2026-09-04T00:00:00.000Z',
      providers: [{ ...ENTRY, settings: [{ name: 'x', label: 'X', kind: 'freeform' }] }],
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses a version of the document it does not know', () => {
    expect(
      providerRegistryIndexSchema.safeParse({ version: 2, generatedAt: '2026-09-04T00:00:00.000Z', providers: [] })
        .success,
    ).toBe(false)
  })
})

describe('browsing provider shelves', () => {
  it('stamps every entry with the source name and the label the OPERATOR wrote', async () => {
    const shelves = await client().browse()
    expect(shelves).toHaveLength(1)
    expect(shelves[0]!.providers).toHaveLength(1)
    expect(shelves[0]!.providers[0]).toMatchObject({ providerId: 'nimbus', sourceName: SHOP, trust: 'community' })
  })

  it('reads providers.json, never index.json', async () => {
    const fetchText = stubFetch({ [`${BASE}/providers.json`]: INDEX })
    const shop = createProviderShopClient({ config: configSchema.parse({}).registry, fetchText })
    await shop.browse()
    expect(fetchText).toHaveBeenCalledWith(`${BASE}/providers.json`)
    expect(fetchText).not.toHaveBeenCalledWith(`${BASE}/index.json`)
  })

  it('reports a source that publishes no provider listing as one shelf with a reason', async () => {
    const shelves = await client({})
    const result = await shelves.browse()
    expect(result[0]!.providers).toEqual([])
    expect(result[0]!.failure?.kind).toBe('unreachable')
  })

  it('reports a malformed listing as invalid, naming what was wrong', async () => {
    const bad = JSON.stringify({ version: 1, generatedAt: '2026-09-04T00:00:00.000Z', providers: [{ providerId: 'x' }] })
    const result = await client({ [`${BASE}/providers.json`]: bad }).browse()
    expect(result[0]!.failure?.kind).toBe('invalid')
    expect(result[0]!.failure?.reason).toContain('is not a provider listing')
  })

  it('says a one-file pack source publishes no providers, rather than guessing a URL for it', async () => {
    const shop = createProviderShopClient({
      config: configSchema.parse({
        registry: { sources: [{ name: 'My pack', url: 'https://example.test/my-pack.yaml', trust: 'community' }] },
      }).registry,
      fetchText: stubFetch({}),
    })
    const result = await shop.browse()
    expect(result[0]!.failure?.kind).toBe('unsupported')
    expect(result[0]!.failure?.reason).toContain('single pack file')
  })

  it('is switched off entirely by registry.enabled: false, and fetches nothing', async () => {
    const fetchText = stubFetch({ [`${BASE}/providers.json`]: INDEX })
    const shop = createProviderShopClient({
      config: configSchema.parse({ registry: { enabled: false } }).registry,
      fetchText,
    })
    const result = await shop.browse()
    expect(result[0]!.failure?.kind).toBe('disabled')
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('caches a successful listing for the configured TTL, and never caches a failure', async () => {
    const fetchText = stubFetch({ [`${BASE}/providers.json`]: INDEX })
    const shop = createProviderShopClient({ config: configSchema.parse({}).registry, fetchText })
    await shop.browse()
    await shop.browse()
    expect(fetchText).toHaveBeenCalledTimes(1)
    await shop.browse({ force: true })
    expect(fetchText).toHaveBeenCalledTimes(2)

    const failing = stubFetch({})
    const broken = createProviderShopClient({ config: configSchema.parse({}).registry, fetchText: failing })
    await broken.browse()
    await broken.browse()
    expect(failing).toHaveBeenCalledTimes(2)
  })
})

describe('getting one entry, which is what an install acts on', () => {
  it('refetches rather than serving a cached listing', async () => {
    const fetchText = stubFetch({ [`${BASE}/providers.json`]: INDEX })
    const shop = createProviderShopClient({ config: configSchema.parse({}).registry, fetchText })
    await shop.browse()
    await shop.getEntry(SHOP, 'nimbus')
    expect(fetchText).toHaveBeenCalledTimes(2)
  })

  it('is not-found for a source nobody configured, and for a provider the source does not list', async () => {
    const shop = client()
    expect(await shop.getEntry('Nowhere', 'nimbus')).toMatchObject({ ok: false, kind: 'not-found' })
    expect(await shop.getEntry(SHOP, 'absent')).toMatchObject({ ok: false, kind: 'not-found' })
  })
})
