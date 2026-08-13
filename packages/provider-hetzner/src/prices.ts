import type { Price } from '@rockysurf/provider-sdk'

/**
 * Pricing for this provider: **live first, bundled as fallback** (rockysurf-gyp1.3).
 *
 * The general rule is that prices ship bundled and stamped, because live pricing APIs are out
 * of v0 (ADR-0003). Hetzner is the documented exception, and the reason is narrow: it returns
 * `prices[]` INLINE on `GET /server_types` — the exact call `listOfferings()` already makes.
 * Preferring the bundled table here would mean showing a number we know to be older than one
 * already in hand, for no saved request. That is the opposite of the price-honesty rule's
 * intent.
 *
 * So:
 *  - **live** — read from the offerings response, stamped `fetchedAt: now`, in the currency
 *    `GET /pricing` reports for the project;
 *  - **bundled** — `prices.generated.ts`, consulted only when a type carries no price for the
 *    configured location, and refreshed by `node scripts/refresh-prices.mjs --hetzner`;
 *  - **neither** — `hourly: null`, which the SDK defines as "unknown, never free".
 *
 * AWS keeps the bundled-only rule, because it has no equivalent freebie: its price list is a
 * separate service, so reading it live would be a second dependency at runtime for a number
 * that changes a few times a year.
 */

export interface PriceTable {
  /** ISO 8601, when these prices were read from the provider. */
  fetchedAt: string
  /** ISO 4217, uppercase. Hetzner quotes in the project's billing currency. */
  currency: string
  /** `offeringId` → `location` → hourly amount, VAT-exclusive. */
  hourly: Record<string, Record<string, number>>
}

export { BUNDLED_PRICES } from './prices.generated.js'

/** Look up one offering's bundled price. Returns null — "unknown" — when absent. */
export function lookupPrice(table: PriceTable, offeringId: string, location: string): Price | null {
  const amount = table.hourly[offeringId]?.[location]
  if (amount === undefined) return null
  return { amount, currency: table.currency, fetchedAt: table.fetchedAt }
}

/**
 * Turn an inline price from `GET /server_types` into an SDK `Price`.
 *
 * `net` rather than `gross`: gross folds in a per-account VAT rate, so it is not comparable
 * between two customers looking at the same machine.
 */
export function livePrice(net: string, currency: string, fetchedAt: string): Price | null {
  const amount = Number(net)
  if (!Number.isFinite(amount)) return null
  return { amount, currency, fetchedAt }
}
