import type { RegistryConfig } from '../config/schema.js'
import { parsePackFile } from './loader.js'
import { registryIndexSchema, sha256Text, type RegistryEntry, type RegistryIndex } from './registry-index.js'
import { fetchPublicText } from './safe-fetch.js'
import type { PackFile } from './schema.js'

/**
 * Reading a pack registry (rockysurf-arym.3, issue #9).
 *
 * The registry is a git repository of pack YAML plus a generated `index.json`. This module
 * fetches that document, validates it, and fetches individual packs by the paths it names,
 * verifying each against the digest the index recorded. What it deliberately does NOT do is
 * write anything: turning a validated `PackFile` into database rows is the import path that
 * already exists (`routes.ts`), and adding a second one is how two ways of installing a pack
 * start disagreeing about what a pack is.
 *
 * FOUR PROPERTIES, EACH FOR A REASON THAT COST SOMEBODY SOMETHING:
 *
 * 1. NO GITHUB API. Every fetch is a plain file GET against `baseUrl`. Unauthenticated
 *    `api.github.com` allows 60 requests per hour shared across one source IP (rockysurf-c6cm);
 *    a control plane behind a corporate NAT would exhaust that before it had listed the shop
 *    once, and the failure would look like a broken registry rather than a spent quota.
 *
 * 2. EVERY FETCH GOES THROUGH THE SSRF GUARD. `fetchPublicText` resolves each hostname and
 *    requires every resolved address to be publicly routable, re-screens each redirect hop, and
 *    caps the body. `baseUrl` is operator-supplied configuration on a process holding cloud
 *    credentials, so it gets the same treatment the pack-import endpoint gets and for the same
 *    reason. No `allowHosts` is passed: nobody has vouched for anything here, and a registry is
 *    a public thing by definition.
 *
 * 3. NOTHING THROWS. Every failure is a value with a reason fit to show an operator. A registry
 *    is a third party; an outage of one must render as an empty shop that explains itself, never
 *    as a 500 from this control plane.
 *
 * 4. THE BOOT PATH NEVER CALLS THIS. There is no startup fetch and no background refresh. The
 *    index is read when somebody opens the shop, and cached for `cacheTtlSeconds` after that.
 *
 * WHAT THE DIGEST CHECK IS WORTH, stated plainly because it is easy to overclaim. It proves the
 * bytes fetched are the bytes the index describes, so a pack file changed without regenerating
 * the index is refused rather than installed. It does not prove the index is honest — whoever
 * can write one can write both — so the trust chain here is the registry repository's branch and
 * GitHub's account controls, and ADR-0006 says so rather than implying more. Detached signatures
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

export type RegistryIndexResult = { ok: true; index: RegistryIndex; fetchedAt: Date } | RegistryFailure

export interface FetchedPack {
  ok: true
  entry: RegistryEntry
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
  /** The index, from cache when fresh. `force` refetches regardless. */
  getIndex(options?: { force?: boolean }): Promise<RegistryIndexResult>
  /** One pack's YAML, fetched by the path the index names and verified against its digest. */
  getPack(packId: string): Promise<RegistryPackResult>
  /** What the shop UI shows as the registry's identity. */
  describe(): { enabled: boolean; baseUrl: string }
}

const INDEX_FILE = 'index.json'

export function createRegistryClient(deps: RegistryClientDeps): RegistryClient {
  const { config } = deps
  const fetchText = deps.fetchText ?? fetchPublicText
  const now = deps.now ?? Date.now

  let cached: { index: RegistryIndex; at: number } | undefined

  const disabled = (): RegistryFailure => ({
    ok: false,
    kind: 'disabled',
    reason: 'The pack registry is disabled (registry.enabled is false in the config file).',
  })

  async function getIndex(options: { force?: boolean } = {}): Promise<RegistryIndexResult> {
    if (!config.enabled) return disabled()

    if (!options.force && cached && now() - cached.at < config.cacheTtlSeconds * 1000) {
      return { ok: true, index: cached.index, fetchedAt: new Date(cached.at) }
    }

    const url = `${config.baseUrl}/${INDEX_FILE}`
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
      return {
        ok: false,
        kind: 'invalid',
        reason: `${url} is not valid JSON: ${(err as Error).message}`,
      }
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

    const at = now()
    cached = { index: parsed.data, at }
    return { ok: true, index: parsed.data, fetchedAt: new Date(at) }
  }

  async function getPack(packId: string): Promise<RegistryPackResult> {
    const index = await getIndex()
    if (!index.ok) return index

    const entry = index.index.packs.find((p) => p.packId === packId)
    if (!entry) {
      return { ok: false, kind: 'not-found', reason: `The registry has no pack called "${packId}".` }
    }

    // `entry.path` is schema-constrained to a relative path with no traversal, which is what
    // makes this concatenation safe. Without that constraint the index would get to decide what
    // this control plane fetches, and an index is a file in a repository anyone may send a pull
    // request to.
    const url = `${config.baseUrl}/${entry.path}`
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
          `${entry.path} does not match the digest the registry published for it ` +
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
          `${entry.path} declares packId "${file.pack.packId}" but the registry index lists it ` +
          `as "${entry.packId}". The index disagrees with the file it points at.`,
      }
    }

    return { ok: true, entry, file, yaml: fetched.text }
  }

  return {
    getIndex,
    getPack,
    describe: () => ({ enabled: config.enabled, baseUrl: config.baseUrl }),
  }
}
