import { describe, expect, it, vi } from 'vitest'
import { configSchema, type RegistryConfig } from '../config/schema.js'
import { createRegistryClient } from './registry.js'
import { sha256Text } from './registry-index.js'
import type { SafeFetchResult } from './safe-fetch.js'

/**
 * The registry client.
 *
 * Most of this is about what happens when the registry is WRONG, because a registry is a third
 * party: it can be offline, it can publish a malformed index, it can describe a file it does not
 * actually serve. None of those may become an exception out of this control plane, and none of
 * them may result in something being installed. So the assertions are mostly refusals, each
 * naming what a caller would do about it.
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
  tier: 'community',
  path: 'packs/community/rust-dev.yaml',
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

const BASE = 'https://raw.githubusercontent.com/amroja-biz/rockysurf-shop/main'

describe('the default registry', () => {
  it('points at raw.githubusercontent.com, never the GitHub API', () => {
    // rockysurf-c6cm: the unauthenticated API allows 60 requests an hour shared across one
    // source IP. A control plane behind a corporate NAT would spend that before it had listed
    // the shop once, and the failure would look like a broken registry rather than a quota.
    const { baseUrl } = config()
    expect(new URL(baseUrl).host).toBe('raw.githubusercontent.com')
    expect(baseUrl).not.toContain('api.github.com')
  })

  it('is enabled by default and normalises a trailing slash away', () => {
    expect(config().enabled).toBe(true)
    expect(config({ baseUrl: 'https://example.com/shop/' }).baseUrl).toBe('https://example.com/shop')
  })
})

describe('fetching the index', () => {
  it('fetches <baseUrl>/index.json and nothing else', async () => {
    const { fetchText, calls } = stubFetch({ [`${BASE}/index.json`]: index() })
    const client = createRegistryClient({ config: config(), fetchText })

    const result = await client.getIndex()
    expect(result.ok).toBe(true)
    expect(calls).toEqual([`${BASE}/index.json`])
    // A listing is one request. Anything that walked a tree would be the API path this avoids.
    expect(fetchText).toHaveBeenCalledTimes(1)
  })

  it('reuses the cached index inside the TTL, and refetches after it', async () => {
    let clock = 1_000_000
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: index() })
    const client = createRegistryClient({
      config: config({ cacheTtlSeconds: 300 }),
      fetchText,
      now: () => clock,
    })

    await client.getIndex()
    await client.getIndex()
    expect(fetchText).toHaveBeenCalledTimes(1)

    clock += 301_000
    await client.getIndex()
    expect(fetchText).toHaveBeenCalledTimes(2)
  })

  it('refetches on demand, so a merged pack does not need a wait', async () => {
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: index() })
    const client = createRegistryClient({ config: config(), fetchText, now: () => 0 })
    await client.getIndex()
    await client.getIndex({ force: true })
    expect(fetchText).toHaveBeenCalledTimes(2)
  })
})

describe('refusals, none of which throw', () => {
  it('reports a disabled registry as disabled, not as a failure', async () => {
    // An operator should be able to tell "I turned this off" from "this is broken". They are
    // different sentences and only one of them is worth investigating.
    const { fetchText } = stubFetch({})
    const client = createRegistryClient({ config: config({ enabled: false }), fetchText })

    const result = await client.getIndex()
    expect(result).toMatchObject({ ok: false, kind: 'disabled' })
    // And it must not have gone near the network to find that out.
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('passes the SSRF guard’s refusal through verbatim', async () => {
    // The guard already names the URL and says whether it was refused or unreachable. Rewording
    // it here would lose the distinction and print the URL twice.
    const refusal = `Refusing to fetch ${BASE}/index.json: host resolves to a non-public address`
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: { fail: refusal } })
    const client = createRegistryClient({ config: config(), fetchText })

    expect(await client.getIndex()).toMatchObject({ ok: false, kind: 'unreachable', reason: refusal })
  })

  it('reports an index that is not JSON', async () => {
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: '<html>404</html>' })
    const client = createRegistryClient({ config: config(), fetchText })
    expect(await client.getIndex()).toMatchObject({ ok: false, kind: 'invalid' })
  })

  it('reports an index that is JSON but not an index', async () => {
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: JSON.stringify({ version: 99, packs: [] }) })
    const client = createRegistryClient({ config: config(), fetchText })
    const result = await client.getIndex()
    expect(result).toMatchObject({ ok: false, kind: 'invalid' })
    expect(result.ok === false && result.reason).toContain('not a pack registry index')
  })

  it('bounds the reason for a badly malformed index', async () => {
    // One issue per pack times a large registry is a reason nobody reads.
    const packs = Array.from({ length: 40 }, () => ({ packId: 'x' }))
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: index(packs) })
    const client = createRegistryClient({ config: config(), fetchText })
    const result = await client.getIndex()
    expect(result.ok === false && result.reason).toMatch(/and \d+ more/)
    expect(result.ok === false && result.reason.length).toBeLessThan(600)
  })

  it('does not cache a failure as if it were an index', async () => {
    let body: string | { fail: string } = { fail: 'offline' }
    const fetchText = vi.fn(async (): Promise<SafeFetchResult> =>
      typeof body === 'object' ? { ok: false, reason: body.fail } : { ok: true, text: body },
    )
    const client = createRegistryClient({ config: config(), fetchText, now: () => 0 })

    expect((await client.getIndex()).ok).toBe(false)
    body = index()
    // Same instant, so a cached FAILURE would still be "fresh" and the registry would look
    // broken until the TTL expired — long after it came back.
    expect((await client.getIndex()).ok).toBe(true)
  })
})

describe('fetching a pack', () => {
  const responses = { [`${BASE}/index.json`]: index(), [`${BASE}/packs/community/rust-dev.yaml`]: PACK_YAML }

  it('fetches the path the index names and validates the frozen format', async () => {
    const { fetchText, calls } = stubFetch(responses)
    const client = createRegistryClient({ config: config(), fetchText })

    const result = await client.getPack('rust-dev')
    expect(result.ok).toBe(true)
    expect(result.ok && result.file.pack.packId).toBe('rust-dev')
    expect(result.ok && result.entry.tier).toBe('community')
    // The bytes are handed back as fetched, so what is shown and stored is what was verified.
    expect(result.ok && result.yaml).toBe(PACK_YAML)
    expect(calls[1]).toBe(`${BASE}/packs/community/rust-dev.yaml`)
  })

  it('refuses a file whose digest does not match the index, naming both', async () => {
    // THE CHECK THAT MATTERS. A pack file changed without regenerating the index is refused
    // rather than installed, whatever the reason for the change.
    const { fetchText } = stubFetch({
      ...responses,
      [`${BASE}/packs/community/rust-dev.yaml`]: `${PACK_YAML}# tampered\n`,
    })
    const client = createRegistryClient({ config: config(), fetchText })

    const result = await client.getPack('rust-dev')
    expect(result).toMatchObject({ ok: false, kind: 'digest-mismatch' })
    expect(result.ok === false && result.reason).toContain(sha256Text(PACK_YAML))
  })

  it('refuses when the index disagrees with the file it points at', async () => {
    // The digest pins the bytes, so this can only fire when the index was generated from a
    // different file than the one it names — a registry bug, and one that would otherwise show
    // the operator one pack and install another.
    const { fetchText } = stubFetch({
      [`${BASE}/index.json`]: index([entry({ packId: 'something-else' })]),
      [`${BASE}/packs/community/rust-dev.yaml`]: PACK_YAML,
    })
    const client = createRegistryClient({ config: config(), fetchText })

    const result = await client.getPack('something-else')
    expect(result).toMatchObject({ ok: false, kind: 'invalid' })
    expect(result.ok === false && result.reason).toContain('disagrees with the file')
  })

  it('refuses a pack file that is not valid against the frozen format', async () => {
    const { fetchText } = stubFetch({
      [`${BASE}/index.json`]: index([entry({ sha256: sha256Text('pack: [unclosed\n') })]),
      [`${BASE}/packs/community/rust-dev.yaml`]: 'pack: [unclosed\n',
    })
    const client = createRegistryClient({ config: config(), fetchText })
    expect(await client.getPack('rust-dev')).toMatchObject({ ok: false, kind: 'invalid' })
  })

  it('does not fail a pack over its filename', async () => {
    // The loader derives an expected packId from a filename. What arrives here is a fetched
    // path, not a file in `packs/`, so that one check is dropped — the same call the import
    // route makes, for the same reason.
    const renamed = entry({ path: 'packs/community/whatever.yaml' })
    const { fetchText } = stubFetch({
      [`${BASE}/index.json`]: index([renamed]),
      [`${BASE}/packs/community/whatever.yaml`]: PACK_YAML,
    })
    const client = createRegistryClient({ config: config(), fetchText })
    expect((await client.getPack('rust-dev')).ok).toBe(true)
  })

  it('reports a pack the registry does not list', async () => {
    const { fetchText } = stubFetch(responses)
    const client = createRegistryClient({ config: config(), fetchText })
    expect(await client.getPack('nope')).toMatchObject({ ok: false, kind: 'not-found' })
  })

  it('reports a pack the index lists but the registry does not serve', async () => {
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: index() })
    const client = createRegistryClient({ config: config(), fetchText })
    expect(await client.getPack('rust-dev')).toMatchObject({ ok: false, kind: 'unreachable' })
  })

  it('is disabled all the way down', async () => {
    const { fetchText } = stubFetch(responses)
    const client = createRegistryClient({ config: config({ enabled: false }), fetchText })
    expect(await client.getPack('rust-dev')).toMatchObject({ ok: false, kind: 'disabled' })
    expect(fetchText).not.toHaveBeenCalled()
  })
})

describe('nothing happens until somebody asks', () => {
  it('constructing a client performs no fetch', async () => {
    // The property the boot path depends on: a control plane behind a proxy, or with no route
    // off the machine at all, must start exactly as fast and as successfully as it does now. A
    // client that warmed its cache on construction would put a third party's outage on the
    // startup path, and nobody would notice until that third party had one.
    const { fetchText } = stubFetch({ [`${BASE}/index.json`]: index() })
    createRegistryClient({ config: config(), fetchText })
    await Promise.resolve()
    expect(fetchText).not.toHaveBeenCalled()
  })
})

describe('describe()', () => {
  it('reports what the shop is pointed at, so the UI need not read the config', async () => {
    const client = createRegistryClient({
      config: config({ baseUrl: 'https://example.com/mine' }),
      fetchText: stubFetch({}).fetchText,
    })
    expect(client.describe()).toEqual({ enabled: true, baseUrl: 'https://example.com/mine' })
  })
})
