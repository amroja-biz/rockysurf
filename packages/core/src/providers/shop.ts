import type { RegistryConfig, RegistrySource } from '../config/schema.js'
import { isPackFileSource } from '../packs/registry.js'
import { fetchPublicText } from '../packs/safe-fetch.js'
import {
  PROVIDER_INDEX_FILE,
  providerRegistryIndexSchema,
  type ProviderRegistryEntry,
  type ProviderRegistryIndex,
} from './shop-index.js'

/**
 * Reading the provider half of a registry (ADR-0028).
 *
 * Deliberately the same shape as `packs/registry.ts` — a result per source, never a failure for
 * the whole call, no boot fetch, no background refresh, every fetch through the SSRF guard, the
 * trust label taken from the operator's config and never from the document. It reads a different
 * file (`providers.json`) and returns different rows, and everything else about it is the pack
 * registry's behaviour because the reasons for that behaviour did not change.
 *
 * ONE SOURCE LIST, NOT TWO. A provider listing comes from the same `registry.sources` entries a
 * pack listing does, so an operator adds a shop once and says once how far they trust it. The
 * alternative — a second `providerRegistry.sources` block — would have let the two disagree
 * about the same repository, and left an operator answering the trust question twice about one
 * decision. What it does NOT do is make installing automatic: a listing is a listing, and a
 * provider arrives on this machine only when an admin says so, having read the sentence.
 *
 * A SOURCE THAT IS ONE PACK FILE HAS NO PROVIDERS. A `.yaml` URL is a single pack, published by
 * someone with one pack and no CI (ADR-0006's #88 amendment). There is no directory to hold a
 * `providers.json`, and guessing a sibling URL for one would be inventing a layout that source
 * never agreed to. Such a shelf says so, in those words, rather than showing an empty catalogue
 * that reads as "this shop has no providers yet".
 */

/** Same discriminated failure the pack client returns, so one renderer covers both shelves. */
export interface ProviderShopFailure {
  ok: false
  reason: string
  kind: 'disabled' | 'unreachable' | 'invalid' | 'not-found' | 'unsupported'
}

/** An entry, plus where it came from and what the operator said that place is. */
export interface ProviderListing extends ProviderRegistryEntry {
  sourceName: string
  trust: RegistrySource['trust']
}

/** One configured registry's provider outcome. Reported per source, as packs are. */
export interface ProviderShelfResult {
  source: { name: string; url: string; trust: RegistrySource['trust'] }
  providers: ProviderListing[]
  failure?: ProviderShopFailure
  fetchedAt?: Date
}

export type ProviderEntryResult = { ok: true; entry: ProviderListing } | ProviderShopFailure

export interface ProviderShopDeps {
  config: RegistryConfig
  /** The fetch seam. Defaults to the SSRF-guarded one; tests inject a stub. */
  fetchText?: typeof fetchPublicText
  now?: () => number
}

export interface ProviderShopClient {
  browse(options?: { force?: boolean }): Promise<ProviderShelfResult[]>
  getEntry(sourceName: string, providerId: string): Promise<ProviderEntryResult>
  describe(): { enabled: boolean; sources: Array<{ name: string; url: string; trust: RegistrySource['trust'] }> }
}

export function createProviderShopClient(deps: ProviderShopDeps): ProviderShopClient {
  const { config } = deps
  const fetchText = deps.fetchText ?? fetchPublicText
  const now = deps.now ?? Date.now

  /** Keyed by the providers URL, so it never collides with the pack index's cache entry. */
  const cache = new Map<string, { index: ProviderRegistryIndex; at: number }>()

  const disabled = (): ProviderShopFailure => ({
    ok: false,
    kind: 'disabled',
    reason: 'The registry is disabled (registry.enabled is false in the config file).',
  })

  const packFileOnly = (source: RegistrySource): ProviderShopFailure => ({
    ok: false,
    kind: 'unsupported',
    reason: `${source.name} is a single pack file, so it publishes no providers.`,
  })

  async function indexFor(
    source: RegistrySource,
    force: boolean,
  ): Promise<{ ok: true; index: ProviderRegistryIndex; at: number } | ProviderShopFailure> {
    if (isPackFileSource(source.url)) return packFileOnly(source)
    const url = `${source.url}/${PROVIDER_INDEX_FILE}`

    const cached = cache.get(url)
    if (!force && cached && now() - cached.at < config.cacheTtlSeconds * 1000) {
      return { ok: true, index: cached.index, at: cached.at }
    }

    const fetched = await fetchText(url)
    if (!fetched.ok) {
      // A shop that lists packs and no providers answers 404 here, which the guard reports as
      // "could not fetch". That is the ordinary case rather than a fault, and the shelf says the
      // reason it was given rather than inventing a friendlier one it cannot stand behind.
      return { ok: false, kind: 'unreachable', reason: fetched.reason }
    }

    let raw: unknown
    try {
      raw = JSON.parse(fetched.text)
    } catch (err) {
      return { ok: false, kind: 'invalid', reason: `${url} is not valid JSON: ${(err as Error).message}` }
    }

    const parsed = providerRegistryIndexSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      return {
        ok: false,
        kind: 'invalid',
        reason:
          `${url} is not a provider listing: ${issues.join('; ')}` +
          (parsed.error.issues.length > 5 ? ` (and ${parsed.error.issues.length - 5} more)` : ''),
      }
    }

    // Only a SUCCESS is cached — a registry that came back must not look broken until a TTL.
    const at = now()
    cache.set(url, { index: parsed.data, at })
    return { ok: true, index: parsed.data, at }
  }

  const stamp = (entry: ProviderRegistryEntry, source: RegistrySource): ProviderListing => ({
    ...entry,
    sourceName: source.name,
    trust: source.trust,
  })

  async function browse(options: { force?: boolean } = {}): Promise<ProviderShelfResult[]> {
    if (!config.enabled) {
      return config.sources.map((source) => ({
        source: { name: source.name, url: source.url, trust: source.trust },
        providers: [],
        failure: disabled(),
      }))
    }

    const shelves: ProviderShelfResult[] = []
    for (const source of config.sources) {
      const identity = { name: source.name, url: source.url, trust: source.trust }
      const result = await indexFor(source, options.force ?? false)
      if (!result.ok) {
        shelves.push({ source: identity, providers: [], failure: result })
        continue
      }
      shelves.push({
        source: identity,
        providers: result.index.providers.map((entry) => stamp(entry, source)),
        fetchedAt: new Date(result.at),
      })
    }
    return shelves
  }

  async function getEntry(sourceName: string, providerId: string): Promise<ProviderEntryResult> {
    if (!config.enabled) return disabled()
    const source = config.sources.find((s) => s.name === sourceName)
    if (!source) {
      return { ok: false, kind: 'not-found', reason: `No registry called "${sourceName}" is configured.` }
    }
    // Refetched rather than served from a browse the caller made: an install must act on the
    // listing as it is NOW, and the digest it carries is the only thing pinning the artifact.
    const result = await indexFor(source, true)
    if (!result.ok) return result
    const entry = result.index.providers.find((p) => p.providerId === providerId)
    if (!entry) {
      return { ok: false, kind: 'not-found', reason: `${source.name} lists no provider called "${providerId}".` }
    }
    return { ok: true, entry: stamp(entry, source) }
  }

  return {
    browse,
    getEntry,
    describe: () => ({
      enabled: config.enabled,
      sources: config.sources.map((s) => ({ name: s.name, url: s.url, trust: s.trust })),
    }),
  }
}
