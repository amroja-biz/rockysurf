import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_REGISTRY_URL, configSchema, type RegistryConfig } from '../config/schema.js'
import { createRegistryClient } from './registry.js'
import { sha256Text } from './registry-index.js'
import type { SafeFetchResult } from './safe-fetch.js'

/**
 * The registry client.
 *
 * Most of this is about what happens when a registry is WRONG, because a registry is a third
 * party: it can be offline, it can publish a malformed index, it can describe a file it does not
 * actually serve. None of those may become an exception out of this control plane, none may
 * result in something being installed, and none may blank out the registries that are fine.
 *
 * The other half is the trust label, which under the owner's split-horizon ruling comes from the
 * operator's config and never from the registry's own document. Several tests exist only to pin
 * that down, because it is the kind of property that quietly stops holding.
 */

const PACK_YAML = `version: 1
pack:
  packId: rust-dev
  name: Rust Dev
  tools:
    - rustup
  displayOrder: 90
  enabled: true
tools:
  - toolId: rustup
    name: rustup
    description: The Rust toolchain installer
    category: base
    url: https://rustup.rs
    installScript: |
      echo installing
    enabled: true
    installOrder: 30
    bootstrap: false
    runAs: root
`

const entry = (overrides: Record<string, unknown> = {}) => ({
  packId: 'rust-dev',
  name: 'Rust Dev',
  description: 'Installs 1 tool(s): rustup',
  path: 'packs/rust-dev.yaml',
  sha256: sha256Text(PACK_YAML),
  definesTools: ['rustup'],
  referencesTools: [],
  requiresRepos: false,
  requiresRdp: false,
  ...overrides,
})

const index = (packs: unknown[] = [entry()]) =>
  JSON.stringify({ version: 1, generatedAt: '2026-08-14T00:00:00.000Z', packs })

/** Config through the real schema, so defaults and normalisation are the ones boot produces. */
function config(overrides: Record<string, unknown> = {}): RegistryConfig {
  return configSchema.parse({ registry: overrides }).registry
}

/** A fetch stub keyed by URL, which also records the order it was called in. */
function stubFetch(responses: Record<string, string | { fail: string }>) {
  const calls: string[] = []
  const fetchText = vi.fn(async (url: string): Promise<SafeFetchResult> => {
    calls.push(url)
    const response = responses[url]
    if (response === undefined) return { ok: false, reason: `Could not fetch ${url}` }
    if (typeof response === 'object') return { ok: false, reason: response.fail }
    return { ok: true, text: response }
  })
  return { fetchText, calls }
}

const BASE = DEFAULT_REGISTRY_URL
const SHOP = 'Rocky Surf Pack Shop'
const PACK_URL = `${BASE}/packs/rust-dev.yaml`
const OK = { [`${BASE}/index.json`]: index(), [PACK_URL]: PACK_YAML }

const INTERNAL = { name: 'Acme internal', url: 'https://packs.acme.example/shop', trust: 'internal' }

describe('the default configuration', () => {
  it('is the community shop, and only it', () => {
    const { sources, enabled } = config()
    expect(enabled).toBe(true)
    expect(sources).toEqual([{ name: SHOP, url: DEFAULT_REGISTRY_URL, trust: 'community' }])
  })

  it('points at raw.githubusercontent.com, never the GitHub API', () => {
    // rockysurf-c6cm: the unauthenticated API allows 60 requests an hour shared across one
    // source IP. A control plane behind a corporate NAT would spend that before it had listed
    // the shop once, and the failure would look like a broken registry rather than a quota.
    expect(new URL(config().sources[0]!.url).host).toBe('raw.githubusercontent.com')
    expect(config().sources[0]!.url).not.toContain('api.github.com')
  })

  it('normalises a trailing slash away', () => {
    // `…//index.json` is tolerated by most servers and not by all. Normalised once, at parse.
    const { sources } = config({ sources: [{ name: 'x', url: 'https://example.com/shop/' }] })
    expect(sources[0]!.url).toBe('https://example.com/shop')
  })

  it('defaults a source with no trust to community, never to something better', () => {
    const { sources } = config({ sources: [{ name: 'x', url: 'https://example.com/shop' }] })
    expect(sources[0]!.trust).toBe('community')
  })

  it('refuses a source claiming to be official', () => {
    // `official` means "shipped in the tarball", which no registry can be. Allowing a config
    // entry to claim it would let a third-party registry be dressed as first-party, which is
    // exactly the confusion the labels exist to prevent.
    const parsed = configSchema.safeParse({
      registry: { sources: [{ name: 'x', url: 'https://example.com/s', trust: 'official' }] },
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses two sources sharing a name', () => {
    // The name is how an installed pack is attributed, and how `getPack` addresses a registry.
    // Two of them makes both ambiguous.
    const parsed = configSchema.safeParse({
      registry: {
        sources: [
          { name: 'dup', url: 'https://a.example/s' },
          { name: 'dup', url: 'https://b.example/s' },
        ],
      },
    })
    expect(parsed.success).toBe(false)
  })

  it('treats an explicitly empty source list as none, not as the default', () => {
    // An operator who wrote `sources:` with everything commented out meant "no registries",
    // and handing the public shop back would be answering a different question.
    expect(config({ sources: null }).sources).toEqual([])
  })
})

describe('browsing', () => {
  it('fetches <url>/index.json per source and stamps each pack with where it came from', async () => {
    const { fetchText, calls } = stubFetch(OK)
    const client = createRegistryClient({ config: config(), fetchText })

    const shelves = await client.browse()
    expect(calls).toEqual([`${BASE}/index.json`])
    expect(shelves).toHaveLength(1)
    expect(shelves[0]!.packs[0]).toMatchObject({
      packId: 'rust-dev',
      sourceName: SHOP,
      trust: 'community',
    })
  })

  it('takes the trust label from the operator’s config, not from the registry document', async () => {
    // THE PROPERTY THE WHOLE TRUST MODEL RESTS ON. The index below is byte-identical to the one
    // the public shop serves; the label differs because the OPERATOR said this URL is internal.
    // Nothing a registry publishes can promote itself.
    const url = INTERNAL.url
    const { fetchText } = stubFetch({ [`${url}/index.json`]: index() })
    const client = createRegistryClient({ config: config({ sources: [INTERNAL] }), fetchText })

    const shelves = await client.browse()
    expect(shelves[0]!.packs[0]).toMatchObject({ sourceName: 'Acme internal', trust: 'internal' })
  })

  it('one registry being down does not blank out the others', async () => {
    // A merged list with a single failure mode would make an outage look like an empty shop.
    // An operator needs to know WHICH shelf is empty and why.
    const { fetchText } = stubFetch({ ...OK }) // INTERNAL is absent, so it fails
    const client = createRegistryClient({
      config: config({ sources: [{ name: SHOP, url: BASE }, INTERNAL] }),
      fetchText,
    })

    const shelves = await client.browse()
    expect(shelves).toHaveLength(2)
    expect(shelves[0]!.packs).toHaveLength(1)
    expect(shelves[0]!.failure).toBeUndefined()
    expect(shelves[1]!.packs).toEqual([])
    expect(shelves[1]!.failure).toMatchObject({ kind: 'unreachable' })
  })

  it('reuses each source’s cached index inside the TTL, and refetches after it', async () => {
    let clock = 1_000_000
    const { fetchText } = stubFetch(OK)
    const client = createRegistryClient({ config: config({ cacheTtlSeconds: 300 }), fetchText, now: () => clock })

    await client.browse()
    await client.browse()
    expect(fetchText).toHaveBeenCalledTimes(1)

    clock += 301_000
    await client.browse()
    expect(fetchText).toHaveBeenCalledTimes(2)
  })

  it('caches per source, so adding a registry does not invalidate the others', async () => {
    const { fetchText } = stubFetch({ ...OK, [`${INTERNAL.url}/index.json`]: index() })
    const client = createRegistryClient({
      config: config({ sources: [{ name: SHOP, url: BASE }, INTERNAL] }),
      fetchText,
      now: () => 0,
    })
    await client.browse()
    await client.browse()
    // Two sources, one fetch each, and the second browse served entirely from cache.
    expect(fetchText).toHaveBeenCalledTimes(2)
  })

  it('refetches on demand, so a merged pack does not need a wait', async () => {
    const { fetchText } = stubFetch(OK)
    const client = createRegistryClient({ config: config(), fetchText, now: () => 0 })
    await client.browse()
    await client.browse({ force: true })
    expect(fetchText).toHaveBeenCalledTimes(2)
  })
})

describe('refusals, none of which throw', () => {
  it('reports a disabled registry as disabled, not as a failure', async () => {
    // An operator should be able to tell "I turned this off" from "this is broken". They are
    // different sentences and only one is worth investigating.
    const { fetchText } = stubFetch({})
    const client = createRegistryClient({ config: config({ enabled: false }), fetchText })

    const shelves = await client.browse()
    expect(shelves[0]!.failure).toMatchObject({ kind: 'disabled' })
    // And it must not have gone near the network to find that out.
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('passes the SSRF guard’s refusal through verbatim', async () => {
    // The guard already names the URL and says whether it was refused or unreachable. Rewording
    // it here would lose the distinction and print the URL twice.
    const refusal = `Refusing to fetch ${BASE}/index.json: host resolves to a non-public address`
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: { fail: refusal } })
    const client = createRegistryClient({ config: config(), fetchText })

    expect((await client.browse())[0]!.failure).toMatchObject({ kind: 'unreachable', reason: refusal })
  })

  it('reports an index that is not JSON', async () => {
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: '<html>404</html>' })
    const client = createRegistryClient({ config: config(), fetchText })
    expect((await client.browse())[0]!.failure).toMatchObject({ kind: 'invalid' })
  })

  it('reports an index that is JSON but not an index', async () => {
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: JSON.stringify({ version: 99, packs: [] }) })
    const client = createRegistryClient({ config: config(), fetchText })
    expect((await client.browse())[0]!.failure?.reason).toContain('not a pack registry index')
  })

  it('bounds the reason for a badly malformed index', async () => {
    // One issue per pack times a large registry is a reason nobody reads.
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: index(Array.from({ length: 40 }, () => ({ packId: 'x' }))) })
    const client = createRegistryClient({ config: config(), fetchText })
    const failure = (await client.browse())[0]!.failure!
    expect(failure.reason).toMatch(/and \d+ more/)
    expect(failure.reason.length).toBeLessThan(600)
  })

  it('does not cache a failure as if it were an index', async () => {
    let body: string | { fail: string } = { fail: 'offline' }
    const fetchText = vi.fn(async (): Promise<SafeFetchResult> =>
      typeof body === 'object' ? { ok: false, reason: body.fail } : { ok: true, text: body },
    )
    const client = createRegistryClient({ config: config(), fetchText, now: () => 0 })

    expect((await client.browse())[0]!.failure).toBeDefined()
    body = index()
    // Same instant, so a cached FAILURE would still be "fresh" and the registry would look
    // broken until the TTL expired — long after it came back.
    expect((await client.browse())[0]!.failure).toBeUndefined()
  })
})

describe('fetching a pack', () => {
  it('fetches the path the index names and validates the frozen format', async () => {
    const { fetchText, calls } = stubFetch(OK)
    const client = createRegistryClient({ config: config(), fetchText })

    const result = await client.getPack(SHOP, 'rust-dev')
    expect(result.ok).toBe(true)
    expect(result.ok && result.file.pack.packId).toBe('rust-dev')
    expect(result.ok && result.entry).toMatchObject({ sourceName: SHOP, trust: 'community' })
    // The bytes are handed back as fetched, so what is shown and stored is what was verified.
    expect(result.ok && result.yaml).toBe(PACK_YAML)
    expect(calls[1]).toBe(PACK_URL)
  })

  it('refuses a file whose digest does not match the index, naming both', async () => {
    // THE CHECK THAT MATTERS. A pack file changed without regenerating the index is refused
    // rather than installed, whatever the reason for the change.
    const { fetchText } = stubFetch({ ...OK, [PACK_URL]: `${PACK_YAML}# tampered\n` })
    const client = createRegistryClient({ config: config(), fetchText })

    const result = await client.getPack(SHOP, 'rust-dev')
    expect(result).toMatchObject({ ok: false, kind: 'digest-mismatch' })
    expect(result.ok === false && result.reason).toContain(sha256Text(PACK_YAML))
  })

  it('refuses when the index disagrees with the file it points at', async () => {
    // The digest pins the bytes, so this can only fire when the index was generated from a
    // different file than the one it names — a registry bug, and one that would otherwise show
    // the operator one pack and install another.
    const { fetchText } = stubFetch({
      [`${BASE}/index.json`]: index([entry({ packId: 'something-else' })]),
      [PACK_URL]: PACK_YAML,
    })
    const client = createRegistryClient({ config: config(), fetchText })

    const result = await client.getPack(SHOP, 'something-else')
    expect(result).toMatchObject({ ok: false, kind: 'invalid' })
    expect(result.ok === false && result.reason).toContain('disagrees with the file')
  })

  it('refuses a pack file that is not valid against the frozen format', async () => {
    const { fetchText } = stubFetch({
      [`${BASE}/index.json`]: index([entry({ sha256: sha256Text('pack: [unclosed\n') })]),
      [PACK_URL]: 'pack: [unclosed\n',
    })
    const client = createRegistryClient({ config: config(), fetchText })
    expect(await client.getPack(SHOP, 'rust-dev')).toMatchObject({ ok: false, kind: 'invalid' })
  })

  it('does not fail a pack over its filename', async () => {
    // The loader derives an expected packId from a filename. What arrives here is a fetched
    // path, not a file in `packs/`, so that one check is dropped — the same call the import
    // route makes, for the same reason.
    const { fetchText } = stubFetch({
      [`${BASE}/index.json`]: index([entry({ path: 'packs/whatever.yaml' })]),
      [`${BASE}/packs/whatever.yaml`]: PACK_YAML,
    })
    const client = createRegistryClient({ config: config(), fetchText })
    expect((await client.getPack(SHOP, 'rust-dev')).ok).toBe(true)
  })

  it('reports a pack the registry does not list', async () => {
    const { fetchText } = stubFetch(OK)
    const client = createRegistryClient({ config: config(), fetchText })
    expect(await client.getPack(SHOP, 'nope')).toMatchObject({ ok: false, kind: 'not-found' })
  })

  it('reports a source nobody configured', async () => {
    const { fetchText } = stubFetch(OK)
    const client = createRegistryClient({ config: config(), fetchText })
    const result = await client.getPack('Acme internal', 'rust-dev')
    expect(result).toMatchObject({ ok: false, kind: 'not-found' })
    expect(result.ok === false && result.reason).toContain('No registry called')
  })

  it('reports a pack the index lists but the registry does not serve', async () => {
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: index() })
    const client = createRegistryClient({ config: config(), fetchText })
    expect(await client.getPack(SHOP, 'rust-dev')).toMatchObject({ ok: false, kind: 'unreachable' })
  })

  it('is disabled all the way down', async () => {
    const { fetchText } = stubFetch(OK)
    const client = createRegistryClient({ config: config({ enabled: false }), fetchText })
    expect(await client.getPack(SHOP, 'rust-dev')).toMatchObject({ ok: false, kind: 'disabled' })
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('does not let one source’s pack be fetched through another source’s name', async () => {
    // Two registries may both publish a `rust-dev`. Addressing a pack by source AND id is what
    // keeps "install the internal one" from silently fetching the public one.
    const { fetchText, calls } = stubFetch({
      ...OK,
      [`${INTERNAL.url}/index.json`]: index([entry({ path: 'packs/rust-dev.yaml' })]),
      [`${INTERNAL.url}/packs/rust-dev.yaml`]: PACK_YAML,
    })
    const client = createRegistryClient({
      config: config({ sources: [{ name: SHOP, url: BASE }, INTERNAL] }),
      fetchText,
    })

    const result = await client.getPack('Acme internal', 'rust-dev')
    expect(result.ok && result.entry.sourceName).toBe('Acme internal')
    expect(calls.every((c) => c.startsWith(INTERNAL.url))).toBe(true)
  })
})

describe('nothing happens until somebody asks', () => {
  it('constructing a client performs no fetch', async () => {
    // The property the boot path depends on: a control plane behind a proxy, or with no route
    // off the machine at all, must start exactly as fast and as successfully as it does now. A
    // client that warmed its cache on construction would put a third party's outage on the
    // startup path, and nobody would notice until that third party had one.
    const { fetchText } = stubFetch(OK)
    createRegistryClient({ config: config(), fetchText })
    await Promise.resolve()
    expect(fetchText).not.toHaveBeenCalled()
  })
})

describe('describe()', () => {
  it('reports every configured source, so the UI need not read the config', async () => {
    const client = createRegistryClient({
      config: config({ sources: [{ name: SHOP, url: BASE }, INTERNAL] }),
      fetchText: stubFetch({}).fetchText,
    })
    expect(client.describe()).toEqual({
      enabled: true,
      sources: [
        { name: SHOP, url: BASE, trust: 'community' },
        { name: 'Acme internal', url: INTERNAL.url, trust: 'internal' },
      ],
    })
  })
})
