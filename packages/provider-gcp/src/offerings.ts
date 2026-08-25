import type { Offering, Price } from '@rockysurf/provider-sdk'
import type { BootDiskType } from './config.js'
import { regionOf } from './config.js'
import type { PriceFeedDoc } from './feed.js'
import { C4A_ZONES, GCP_TYPES, T2A_ZONES } from './prices.generated.js'

/**
 * The machine types this provider offers, where their prices come from, and — unlike either
 * provider that came before it — an `available` flag that is doing real work.
 *
 * THE CATALOGUE IS BUNDLED; THE PRICES ARE FETCHED (gh issue #100, ADR-0009; rockysurf-ndx6).
 * `GCP_TYPES` — the shapes — and the T2A/C4A zone lists still ship in `prices.generated.ts`,
 * because without them there is no catalogue at all. The hourly numbers come from the hosted
 * price feed (`feed.ts`), so correcting one reaches every install without a release.
 *
 * WHAT DID NOT CHANGE IS WHERE THE NUMBERS CAME FROM. Google publishes no credential-free price
 * feed, so `gcp.json` carries a hand transcription off Google's published pricing page rather
 * than something re-read from Google each morning — the feed fixed their delivery, not their
 * provenance. That is why the document carries a `transcribedAt` map its AWS and Azure
 * counterparts do not, and why the stamp on a price here is a day a person read a web page.
 */

/**
 * `fetchedAt` varies by WHEN A ROW WAS READ, not by a single document-level stamp: the
 * c4a-standard-* rows were transcribed eight days after e2/t2a, and reusing the older stamp for
 * them would claim they were read on a day nobody looked at them.
 *
 * The document-level `fetchedAt` is the fallback because the generator sets it to the OLDEST
 * transcription date — a floor, so a row missing from the map is dated conservatively rather
 * than optimistically.
 */
const priceOf = (amount: number, typeId: string, feed: PriceFeedDoc): Price => ({
  amount,
  currency: feed.currency,
  fetchedAt: feed.transcribedAt?.[typeId] ?? feed.fetchedAt,
})

/**
 * Whether a machine family can actually be ordered in a zone right now.
 *
 * The three families answer for different reasons, and the difference is the whole point of the
 * flag:
 *
 *  - **t2a** — arm64 exists in exactly eight zones and nowhere else. Outside them the answer is
 *    a flat, published no, and the offering is still returned with `available: false` so that a
 *    size selector can say "this zone has no ARM; us-central1-a does" instead of silently
 *    having no arm64 at all. Omitting them, which is the only thing a provider could do before
 *    amendment B1, is what makes that message impossible to write.
 *  - **c4a** — the same shape as t2a (a published, permanent zone list, not a stock level), but
 *    a much bigger one: ~77 zones rather than eight, including `us-central1-c`, the one zone
 *    `T2A_ZONES` conspicuously excludes. A zone can have neither, either, or both arm64 families
 *    — `us-central1-a` has both, `us-central1-c` has only c4a, most non-US zones have only c4a,
 *    and nowhere has t2a without also having e2.
 *  - **e2** — available in every zone GCE runs, and stock is not published per type. A zone out
 *    of capacity refuses at insert with `ZONE_RESOURCE_POOL_EXHAUSTED`, which this provider maps
 *    to `capacity` (retryable), so that signal reaches core through the error path rather than
 *    through this list. Same shape as EC2's `InsufficientInstanceCapacity`.
 */
export function isAvailableInZone(family: string, zone: string): boolean {
  if (family === 't2a') return T2A_ZONES.has(zone)
  if (family === 'c4a') return C4A_ZONES.has(zone)
  return true
}

/** The boot disk types e2/t2a can attach: Persistent Disk, in all three published flavours. */
const PD_BOOT_DISK_TYPES: readonly BootDiskType[] = ['pd-balanced', 'pd-standard', 'pd-ssd']

/** The boot disk types C4A can attach: Hyperdisk Balanced, and nothing else — see below. */
const HYPERDISK_BOOT_DISK_TYPES: readonly BootDiskType[] = ['hyperdisk-balanced']

/**
 * Which boot disk types a machine family can actually attach.
 *
 * C4A does not support Persistent Disk AT ALL — Hyperdisk Balanced is its only boot disk option
 * (Hyperdisk Extreme and Hyperdisk Throughput exist but cannot be used as boot disks, so they are
 * not offered here either). Every other family this provider ships is the mirror image: this
 * package does not yet expose Hyperdisk for e2/t2a, so `hyperdisk-balanced` is refused for them
 * too even on machine types where GCE itself would accept it. `validateSpec()` in `provider.ts`
 * is what turns a mismatch here into a named, pre-insert error rather than a Compute API 400.
 */
export function allowedBootDiskTypes(family: string): readonly BootDiskType[] {
  return family === 'c4a' ? HYPERDISK_BOOT_DISK_TYPES : PD_BOOT_DISK_TYPES
}

/** The machine family a given offering id belongs to, for `validateSpec`'s boot disk check. */
export function familyOf(offeringId: string): string | undefined {
  return GCP_TYPES.find((t) => t.id === offeringId)?.family
}

/**
 * Build the offering list for one zone.
 *
 * Prices are published per REGION while stock varies per ZONE, so `region` on the returned
 * offering is the zone — that is the granularity a caller must actually pick — and the price
 * lookup joins through the zone's region.
 *
 * EVERY TYPE IS ALWAYS LISTED, priced or not, which is where this differs from `provider-aws`:
 * AWS omits a type its region's feed does not carry, because there that means the region does
 * not sell it. Here the catalogue is a fixed hand list and availability is stated by the
 * `available` flag, so an unpriced row means "we do not know this price", never "you cannot have
 * this machine". A zone in a region the feed does not cover — and every zone when the feed is
 * unreachable — lists in full with `hourly: null`, the SDK's "unknown, never free": the owner's
 * no-fallback ruling (ADR-0009) says tell the user prices are unavailable and keep creates
 * working, and reusing a us-central1 number for europe-west4 would be silently wrong rather than
 * honestly unknown.
 *
 * @param diskGb the boot disk size this provider is configured to attach, so the offering
 *   describes the machine core will actually create. Note that GCE bills this separately from
 *   the instance, so it is NOT included in `hourly`.
 * @param feed the current hosted price-feed document, or `null` when it could not be fetched.
 */
export function buildOfferings(zone: string, diskGb: number, feed: PriceFeedDoc | null): Offering[] {
  const forRegion = feed?.regions[regionOf(zone)]

  return GCP_TYPES.map((type) => {
    const amount = forRegion?.[type.id]
    return {
      id: type.id,
      cpu: type.cpu,
      memoryGb: type.memoryGb,
      diskGb,
      arch: type.arch,
      hourly: amount === undefined ? null : priceOf(amount, type.id, feed!),
      available: isAvailableInZone(type.family, zone),
      region: zone,
    }
  })
}

/** The ids this provider will accept in a `ProvisionSpec`. */
export const OFFERING_IDS = GCP_TYPES.map((t) => t.id)
