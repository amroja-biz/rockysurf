import type { Offering, Price } from '@rockysurf/provider-sdk'
import { regionOf } from './config.js'
import {
  GCP_HOURLY_USD,
  GCP_PRICES_FETCHED_AT,
  GCP_PRICES_METHOD,
  GCP_PRICES_SOURCE,
  GCP_TYPES,
  T2A_ZONES,
} from './prices.generated.js'

/**
 * The machine types this provider offers, their bundled prices, and — unlike either provider
 * that came before it — an `available` flag that is doing real work.
 *
 * See `prices.generated.ts` for where the numbers came from and how they differ in provenance
 * from the AWS table. The short version: transcribed from Google's published pricing page, not
 * machine-read, because GCP publishes no credential-free price feed.
 */

export { GCP_PRICES_FETCHED_AT, GCP_PRICES_METHOD, GCP_PRICES_SOURCE }

const usd = (amount: number): Price => ({ amount, currency: 'USD', fetchedAt: GCP_PRICES_FETCHED_AT })

/**
 * Whether a machine family can actually be ordered in a zone right now.
 *
 * The two families answer for different reasons, and the difference is the whole point of the
 * flag:
 *
 *  - **t2a** — arm64 exists in exactly eight zones and nowhere else. Outside them the answer is
 *    a flat, published no, and the offering is still returned with `available: false` so that a
 *    size selector can say "this zone has no ARM; us-central1-a does" instead of silently
 *    having no arm64 at all. Omitting them, which is the only thing a provider could do before
 *    amendment B1, is what makes that message impossible to write.
 *  - **e2** — available in every zone GCE runs, and stock is not published per type. A zone out
 *    of capacity refuses at insert with `ZONE_RESOURCE_POOL_EXHAUSTED`, which this provider maps
 *    to `capacity` (retryable), so that signal reaches core through the error path rather than
 *    through this list. Same shape as EC2's `InsufficientInstanceCapacity`.
 */
export function isAvailableInZone(family: string, zone: string): boolean {
  return family === 't2a' ? T2A_ZONES.has(zone) : true
}

/**
 * Build the offering list for one zone.
 *
 * Prices are published per REGION while stock varies per ZONE, so `region` on the returned
 * offering is the zone — that is the granularity a caller must actually pick — and the price
 * lookup joins through the zone's region.
 *
 * @param diskGb the boot disk size this provider is configured to attach, so the offering
 *   describes the machine core will actually create. Note that GCE bills this separately from
 *   the instance, so it is NOT included in `hourly`.
 */
export function buildOfferings(zone: string, diskGb: number): Offering[] {
  const forRegion = GCP_HOURLY_USD[regionOf(zone)]

  return GCP_TYPES.map((type) => {
    const amount = forRegion?.[type.id]
    return {
      id: type.id,
      cpu: type.cpu,
      memoryGb: type.memoryGb,
      diskGb,
      arch: type.arch,
      hourly: amount === undefined ? null : usd(amount),
      available: isAvailableInZone(type.family, zone),
      region: zone,
    }
  })
}

/** The ids this provider will accept in a `ProvisionSpec`. */
export const OFFERING_IDS = GCP_TYPES.map((t) => t.id)
