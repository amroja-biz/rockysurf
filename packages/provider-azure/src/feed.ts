/**
 * The hosted price feed client (gh issue #100, ADR-0009).
 *
 * Prices used to ship compiled into this package (`AZURE_HOURLY_USD` in `prices.generated.ts`),
 * which meant a cloud price change only reached an install on the next release. They now come
 * from a world-readable JSON document the `price-feed` workflow republishes daily; this client
 * fetches and caches it.
 *
 * NO FALLBACK, BY OWNER RULING. When the feed cannot be fetched — no URL configured, network
 * down, host unreachable, document malformed — `get()` returns `null` and every offering is
 * listed with `hourly: null` ("unknown, never free"). If this process cannot reach a public
 * GitHub Pages URL, the operator has either lost the internet (in which case nothing in Rocky
 * Surf works) or GitHub is down; a stale bundled table pretending otherwise was rejected.
 *
 * REJECT WHOLE, NEVER PARTIALLY. The spend cap consumes these numbers, so a malformed or
 * tampered document must degrade to UNPRICED, never to WRONG: one bad entry rejects the whole
 * document rather than serving the rest.
 *
 * NOTE: `packages/provider-aws/src/feed.ts` and `packages/provider-gcp/src/feed.ts` are this
 * file's twins — same shape, same rules, kept in lockstep by hand because the types-only SDK
 * cannot host runtime code and providers may not import each other. Change one, change all
 * three. The GCP copy carries one documented extra field (`transcribedAt`, per-row provenance
 * for prices Google publishes no feed for); nothing else may differ.
 */

/** The normalized document `scripts/refresh-prices.mjs --feed` emits, one per provider. */
export interface PriceFeedDoc {
  fetchedAt: string
  currency: string
  /** region → machine type/size → hourly amount. */
  regions: Record<string, Record<string, number>>
}

const FAILURE_RETRY_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 3_000

/**
 * Validate an untrusted body into a `PriceFeedDoc`, or `null`.
 *
 * Hand-rolled rather than zod so the rules are visible at the one place they apply: version
 * must match exactly (a `/v2/` document is a different contract, not a superset), and every
 * price must be a finite positive number — `NaN`, `0`, negatives and `Infinity` are all
 * corruption, not prices.
 */
export function parsePriceFeedDoc(raw: unknown): PriceFeedDoc | null {
  if (typeof raw !== 'object' || raw === null) return null
  const doc = raw as Record<string, unknown>
  if (doc.schemaVersion !== 1) return null
  if (typeof doc.fetchedAt !== 'string' || !doc.fetchedAt) return null
  if (typeof doc.currency !== 'string' || !doc.currency) return null
  if (typeof doc.regions !== 'object' || doc.regions === null) return null

  const regions: Record<string, Record<string, number>> = {}
  for (const [region, table] of Object.entries(doc.regions)) {
    if (typeof table !== 'object' || table === null) return null
    for (const amount of Object.values(table)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null
    }
    regions[region] = table as Record<string, number>
  }
  return { fetchedAt: doc.fetchedAt, currency: doc.currency, regions }
}

/**
 * Fetch-and-cache around one provider's feed document.
 *
 * In-memory, per provider instance (providers are built once at boot). Successes are reused
 * for the configured refresh window; failures are remembered briefly too, so an unreachable
 * feed costs one 3-second attempt every five minutes rather than one per catalogue read.
 * Single-flight: concurrent `get()`s during a fetch share the same promise.
 */
export class PriceFeedClient {
  private doc: PriceFeedDoc | null = null
  private validUntil = 0
  private inflight: Promise<PriceFeedDoc | null> | null = null

  constructor(
    private readonly url: string | undefined,
    refreshHours: number,
    private readonly now: () => number = Date.now,
    private readonly refreshMs: number = refreshHours * 3_600_000,
  ) {}

  async get(): Promise<PriceFeedDoc | null> {
    if (!this.url) return null
    if (this.now() < this.validUntil) return this.doc
    this.inflight ??= this.fetchOnce().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async fetchOnce(): Promise<PriceFeedDoc | null> {
    try {
      const response = await fetch(this.url!, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`GET ${this.url} → HTTP ${response.status}`)
      const doc = parsePriceFeedDoc(await response.json())
      if (!doc) throw new Error(`GET ${this.url} → not a v1 price feed document`)
      this.doc = doc
      this.validUntil = this.now() + this.refreshMs
      return doc
    } catch {
      // Reported through the catalogue itself (every offering unpriced), not thrown: a price
      // is an annotation on an offering, and an unreachable annotation must not take
      // `listOfferings()` — and with it the create form — down.
      this.doc = null
      this.validUntil = this.now() + FAILURE_RETRY_MS
      return null
    }
  }
}
