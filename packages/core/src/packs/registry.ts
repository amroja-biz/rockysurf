import type { RegistryConfig, RegistrySource } from '../config/schema.js'
import { parsePackFile } from './loader.js'
import { registryIndexSchema, sha256Text, type RegistryEntry, type RegistryIndex } from './registry-index.js'
import { fetchPublicText } from './safe-fetch.js'
import type { PackFile } from './schema.js'

/**
 * Reading the pack registries (rockysurf-arym.3, issue #9).
 *
 * A registry is a repository of pack YAML plus a generated `index.json`. This module fetches
 * those documents, validates them, and fetches individual packs by the paths they name,
 * verifying each against the digest its index recorded. What it deliberately does NOT do is
 * write anything: turning a validated `PackFile` into database rows is the import path that
 * already exists (`routes.ts`), and adding a second one is how two ways of installing a pack
 * start disagreeing about what a pack is.
 *
 * THE TRUST LABEL COMES FROM THE OPERATOR'S CONFIG, NOT FROM THE REGISTRY.
 *
 * This is the shape of the owner's split-horizon ruling on issue #9, and it is worth stating as
 * a principle rather than as a consequence. Official packs ship in the tarball and never appear
 * in a registry, so a registry has nothing to say about officialness. What it might otherwise
 * have said — a `tier` field in its own index — would be a claim about trustworthiness written
 * by the party being trusted, and no better than the document containing it.
 *
 * So each entry in `registry.sources` carries the label the operator wrote next to the URL they
 * chose to add. Every pack this module returns is stamped with its source's name and label, and
 * nothing a registry publishes can promote itself. `official` is deliberately not a label a
 * source may claim: it means "arrived in the tarball", which no registry can be.
 *
 * THREE MORE PROPERTIES, EACH FOR A REASON THAT COST SOMEBODY SOMETHING:
 *
 * 1. NO GITHUB API. Every fetch is a plain file GET against a source's `url`. Unauthenticated
 *    `api.github.com` allows 60 requests per hour shared across one source IP (rockysurf-c6cm);
 *    a control plane behind a corporate NAT would exhaust that before it had listed the shop
 *    once, and the failure would look like a broken registry rather than a spent quota.
 *
 * 2. EVERY FETCH GOES THROUGH THE SSRF GUARD. `fetchPublicText` resolves each hostname and
 *    requires every resolved address to be publicly routable, re-screens each redirect hop, and
 *    caps the body. A source URL is operator-supplied configuration on a process holding cloud
 *    credentials, so it gets the same treatment the pack-import endpoint gets and for the same
 *    reason. No `allowHosts` is passed — an internal registry on an RFC1918 address is a real
 *    thing an operator might want and is deliberately NOT supported yet, because vouching for a
 *    host is a decision with its own design (see `SafeFetchDeps.allowHosts`) rather than a
 *    default to fall into.
 *
 * 3. NOTHING THROWS, AND NOTHING HAPPENS UNTIL ASKED. A registry is a third party; an outage of
 *    one must render as one empty shelf that explains itself, never as a 500 from this control
 *    plane and never as an empty shop. There is no boot fetch and no background refresh.
 *
 * WHAT THE DIGEST CHECK IS WORTH, stated plainly because it is easy to overclaim. It proves the
 * bytes fetched are the bytes the index describes, so a pack file changed without regenerating
 * the index is refused rather than installed. It does not prove the index is honest — whoever
 * can write one can write both — so the trust chain is the registry repository's branch and its
 * host's account controls, and ADR-0006 says so rather than implying more. Detached signatures
 * are rockysurf-cqrm.
 */

/** The shape every failure takes, whatever the caller wanted back. */
export interface RegistryFailure {
  ok: false
  reason: string
  /**
   * Distinguishes what an operator can act on. `disabled` is a configuration choice and not a
   * fault; `unreachable` is somebody else's outage; `invalid` means the registry published
   * something malformed and is worth reporting to whoever maintains it.
   */
  kind: 'disabled' | 'unreachable' | 'invalid' | 'not-found' | 'digest-mismatch'
}

/** A pack, plus where it came from and what the operator said that place is. */
export interface RegistryListing extends RegistryEntry {
  /** The configured source's `name`, which is how an installed pack is attributed. */
  sourceName: string
  /** The configured source's `trust`. Never read from the registry's own document. */
  trust: RegistrySource['trust']
}

/** One configured registry's outcome. Reported per source so one outage is not a blank shop. */
export interface ShelfResult {
  source: { name: string; url: string; trust: RegistrySource['trust'] }
  packs: RegistryListing[]
  /** Present when this source could not be read. `packs` is then empty. */
  failure?: RegistryFailure
  fetchedAt?: Date
}

export interface FetchedPack {
  ok: true
  entry: RegistryListing
  /** Validated against the frozen v0.1 format — the same parse `packs/*.yaml` gets. */
  file: PackFile
  /** The bytes as fetched, so a caller can show or store exactly what was verified. */
  yaml: string
}

export type RegistryPackResult = FetchedPack | RegistryFailure

export interface RegistryClientDeps {
  config: RegistryConfig
  /** The fetch seam. Defaults to the SSRF-guarded one; tests inject a stub. */
  fetchText?: typeof fetchPublicText
  /** Injectable clock, so cache expiry is testable without waiting. */
  now?: () => number
}

export interface RegistryClient {
  /**
   * Every configured registry, each with its packs or its reason for having none.
   *
   * Returns a result per source rather than one merged list, and never a failure for the whole
   * call. One registry being down must not blank out the others, and an operator looking at the
   * shop needs to know WHICH shelf is empty and why.
   */
  browse(options?: { force?: boolean }): Promise<ShelfResult[]>
  /** One pack, by source name and pack id, verified against its index digest. */
  getPack(sourceName: string, packId: string): Promise<RegistryPackResult>
  /** What the shop is pointed at, so the UI need not read the config file. */
  describe(): { enabled: boolean; sources: Array<{ name: string; url: string; trust: RegistrySource['trust'] }> }
}

const INDEX_FILE = 'index.json'

export function createRegistryClient(deps: RegistryClientDeps): RegistryClient {
  const { config } = deps
  const fetchText = deps.fetchText ?? fetchPublicText
  const now = deps.now ?? Date.now

  /** Cached per source URL, so adding a registry does not invalidate the others. */
  const cache = new Map<string, { index: RegistryIndex; at: number }>()

  const disabled = (): RegistryFailure => ({
    ok: false,
    kind: 'disabled',
    reason: 'The pack registry is disabled (registry.enabled is false in the config file).',
  })

  async function indexFor(
    source: RegistrySource,
    force: boolean,
  ): Promise<{ ok: true; index: RegistryIndex; at: number } | RegistryFailure> {
    const cached = cache.get(source.url)
    if (!force && cached && now() - cached.at < config.cacheTtlSeconds * 1000) {
      return { ok: true, index: cached.index, at: cached.at }
    }

    const url = `${source.url}/${INDEX_FILE}`
    const fetched = await fetchText(url)
    if (!fetched.ok) {
      // The guard's reasons already name the URL and say whether it was refused or unreachable;
      // repeating the URL here would print it twice.
      return { ok: false, kind: 'unreachable', reason: fetched.reason }
    }

    let raw: unknown
    try {
      raw = JSON.parse(fetched.text)
    } catch (err) {
      return { ok: false, kind: 'invalid', reason: `${url} is not valid JSON: ${(err as Error).message}` }
    }

    const parsed = registryIndexSchema.safeParse(raw)
    if (!parsed.success) {
      // Bounded, and the first few are the diagnostic. A malformed index can produce an issue
      // per pack, and a thousand-line reason helps nobody.
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      return {
        ok: false,
        kind: 'invalid',
        reason:
          `${url} is not a pack registry index: ${issues.join('; ')}` +
          (parsed.error.issues.length > 5 ? ` (and ${parsed.error.issues.length - 5} more)` : ''),
      }
    }

    // Only a SUCCESS is cached. Caching a failure would leave a registry looking broken until
    // the TTL expired, long after it came back.
    const at = now()
    cache.set(source.url, { index: parsed.data, at })
    return { ok: true, index: parsed.data, at }
  }

  const stamp = (entry: RegistryEntry, source: RegistrySource): RegistryListing => ({
    ...entry,
    sourceName: source.name,
    trust: source.trust,
  })

  async function browse(options: { force?: boolean } = {}): Promise<ShelfResult[]> {
    if (!config.enabled) {
      return config.sources.map((source) => ({
        source: { name: source.name, url: source.url, trust: source.trust },
        packs: [],
        failure: disabled(),
      }))
    }

    // Sequential rather than concurrent, deliberately. The list is short, the guard performs a
    // DNS resolution per hop, and a control plane firing every configured registry at once on a
    // page load is a thundering-herd shape with no benefit at this size.
    const shelves: ShelfResult[] = []
    for (const source of config.sources) {
      const identity = { name: source.name, url: source.url, trust: source.trust }
      const result = await indexFor(source, options.force ?? false)
      if (!result.ok) {
        shelves.push({ source: identity, packs: [], failure: result })
        continue
      }
      shelves.push({
        source: identity,
        packs: result.index.packs.map((entry) => stamp(entry, source)),
        fetchedAt: new Date(result.at),
      })
    }
    return shelves
  }

  async function getPack(sourceName: string, packId: string): Promise<RegistryPackResult> {
    if (!config.enabled) return disabled()

    const source = config.sources.find((s) => s.name === sourceName)
    if (!source) {
      return { ok: false, kind: 'not-found', reason: `No registry called "${sourceName}" is configured.` }
    }

    const result = await indexFor(source, false)
    if (!result.ok) return result

    const entry = result.index.packs.find((p) => p.packId === packId)
    if (!entry) {
      return { ok: false, kind: 'not-found', reason: `${source.name} has no pack called "${packId}".` }
    }

    // `entry.path` is schema-constrained to a relative path with no traversal, which is what
    // makes this concatenation safe. Without that constraint the index would get to decide what
    // this control plane fetches, and an index is a file in a repository anyone may send a pull
    // request to.
    const url = `${source.url}/${entry.path}`
    const fetched = await fetchText(url)
    if (!fetched.ok) return { ok: false, kind: 'unreachable', reason: fetched.reason }

    const digest = sha256Text(fetched.text)
    if (digest !== entry.sha256) {
      // Fails CLOSED, and names both halves. This is the check that catches a pack file changed
      // without regenerating the index — whether that is a maintainer who committed by hand or
      // something worse, the honest answer to the operator is the same: what arrived is not what
      // the registry says it published.
      return {
        ok: false,
        kind: 'digest-mismatch',
        reason:
          `${entry.path} does not match the digest ${source.name} published for it ` +
          `(index says ${entry.sha256}, the file is ${digest}). Refusing to install it.`,
      }
    }

    // Validated against the frozen format before any caller sees it, so a registry cannot hand
    // this installation a shape the loader would reject. The filename check is dropped for the
    // same reason the import route drops it: the loader derives an expected packId from a
    // filename, and what arrives here is a fetched path rather than a file in `packs/`.
    const { file, issues } = parsePackFile(entry.path, fetched.text)
    const real = issues.filter((i) => !i.message.includes('does not match the filename'))
    if (!file || real.length > 0) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `${entry.path} is not a valid pack file: ${real.map((i) => i.message).join('; ')}`,
      }
    }

    // The index is a summary of the file, and a summary that disagrees with what it summarises
    // is worse than none — the shop would show one pack and install another. The digest already
    // pins the bytes, so this can only fire when the index was generated from a different file
    // than the one it points at, which is a registry bug worth naming rather than absorbing.
    if (file.pack.packId !== entry.packId) {
      return {
        ok: false,
        kind: 'invalid',
        reason:
          `${entry.path} declares packId "${file.pack.packId}" but ${source.name}'s index lists ` +
          `it as "${entry.packId}". The index disagrees with the file it points at.`,
      }
    }

    return { ok: true, entry: stamp(entry, source), file, yaml: fetched.text }
  }

  return {
    browse,
    getPack,
    describe: () => ({
      enabled: config.enabled,
      sources: config.sources.map((s) => ({ name: s.name, url: s.url, trust: s.trust })),
    }),
  }
}
