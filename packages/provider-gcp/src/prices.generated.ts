// Bundled Compute Engine machine-type shapes and zone availability.
//
// THE CATALOGUE ONLY — the hourly prices that used to live here as `GCP_HOURLY_USD` moved to the
// hosted price feed (gh issue #100, ADR-0009; rockysurf-ndx6). They now live as data in
// `scripts/gcp-transcribed-prices.json`, are published as `prices/v1/gcp.json` by the
// `price-feed` workflow, and are read at runtime by `feed.ts` — so CORRECTING A TRANSCRIBED
// NUMBER reaches every installation on the next publish instead of the next release. The shapes
// and zone lists below still ship bundled because without them there is no catalogue at all and
// creates would break offline.
//
// PROVENANCE — READ THIS BEFORE TRUSTING ANYTHING HERE OR IN THE FEED.
//
// The shapes below, the zone lists below, and the prices now in
// `scripts/gcp-transcribed-prices.json` were all TRANSCRIBED BY HAND from Google's published
// pages — the general-purpose pricing page (region selector on Iowa/us-central1, "Default (USD)"
// column, which that page's own footnote defines as the on-demand consumption model) and
// https://cloud.google.com/compute/docs/regions-zones. That did not change when the numbers
// moved: the feed fixed their DELIVERY, not their provenance.
//
// They are NOT machine-read, and that is a real difference from `provider-aws` and
// `provider-azure`, whose feed documents are generated from credential-free public feeds. GCP has
// no such feed. Verified 2026-08-13:
//   - https://cloudpricingcalculator.appspot.com/static/data/pricelist.json  -> HTTP 404 (dead)
//   - https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus    -> HTTP 403
//     ("Method doesn't allow unregistered callers")
// The Cloud Billing Catalog API needs an API key — not full OAuth, but not nothing — so
// `node scripts/refresh-prices.mjs --gcp` exists and is gated on GCP_BILLING_API_KEY, exactly
// the way the Hetzner refresh is gated on a project token. It REPORTS what the Catalog says
// beside the transcription and deliberately rewrites nothing, because the Catalog prices machine
// COMPONENTS and predefined machine types are their own cheaper SKUs.
//
// TWO TRANSCRIPTION DATES, NOT ONE, and they are load-bearing. The e2/t2a rows and the eight
// `T2A_ZONES` were read on 2026-08-13; the c4a-standard-* rows and `C4A_ZONES` were read on
// 2026-08-21, when C4A shipped as a general-purpose Arm option (rockysurf-ev41.9 /
// rockysurf-h6mb). The feed document carries both — its `transcribedAt` map stamps each price
// row with the day THAT row was read, and its document-level `fetchedAt` is the older of the two
// as a floor. Backdating (or forward-dating) a price to a day nobody looked at it is exactly the
// kind of silent wrongness these stamps exist to avoid, and a daily republish must not restamp
// them as fresh. See `buildGcpFeedDoc` in `scripts/refresh-prices.mjs`.
//
// There is no `publishedAt`: unlike the AWS feed, the pricing page does not state when its own
// numbers were last changed.
//
// E2, T2A and C4A receive NO sustained-use discount (only N1, N2, N2D, C2, M1, M2 and
// sole-tenant nodes do), so the published on-demand rates are the effective rates rather than a
// pre-discount headline. Feed amounts are USD per hour, tax exclusive, Linux.
//
// The BOOT DISK IS BILLED SEPARATELY and is not in those prices — pd-balanced is $0.10 per
// GiB-month in us-central1, so the configured `bootDiskGb` is a line on the operator's bill
// that `Offering.hourly` does not cover. `docs/providers/gcp.md` says so in the operator's own
// terms.
//
// C4A's boot disk (Hyperdisk Balanced, the only kind it supports — see `config.ts` and
// `offerings.ts`'s `allowedBootDiskTypes`) is billed the same way PLUS two SEPARATELY-METERED
// lines this provider does not set explicitly and therefore does not pay: provisioned IOPS and
// provisioned throughput. Read 2026-08-21 from
//   https://cloud.google.com/compute/disks-image-pricing                      (the rates)
//   https://docs.cloud.google.com/compute/docs/disks/hd-types/hyperdisk-balanced  (the minimums)
// Hyperdisk Balanced charges only for IOPS/throughput ABOVE a free baseline of 3,000 IOPS and
// 140 MiB/s (Iowa: $0.000006849/hour per IOPS and $0.000054795/hour per MiB/s above that). A
// disk created WITHOUT explicit `provisionedIops`/`provisionedThroughput` — which is what this
// provider's create body does, since neither field exists in `GcpProviderConfig` — gets GCE's
// documented minimum for its size (3,000 IOPS / 140 MiB/s for any boot disk at or above 6 GiB,
// i.e. every size this provider's `bootDiskGb` floor of 10 GB can produce), which is exactly the
// free baseline. So at this provider's current, fixed configuration the IOPS/throughput lines
// are real SKUs billed at $0 rather than a free tier this package invented. They are still NOT
// folded into `Offering.hourly`, for the same reason boot disk capacity is not: `hourly` prices
// the instance, not everything on the bill, and a provider that later exposes provisioned
// IOPS/throughput as config would make them non-zero without this comment or the table changing
// at all. `docs/providers/gcp.md` states this in the operator's own terms.
import type { Architecture } from '@rockysurf/provider-sdk'

export interface GcpTypeSpec {
  id: string
  /**
   * vCPU count as Google publishes it.
   *
   * The three shared-core E2 types are burstable and their published vCPU count is not a
   * guarantee: e2-micro, e2-small and e2-medium have baselines of 0.25, 0.5 and 1.0 vCPU
   * respectively and burst above them. The published count is used here because it is the
   * number beside the price on the page these figures came from, and reporting a different one
   * would make the pair unverifiable.
   */
  cpu: number
  /** GiB, as Google's own column is headed. */
  memoryGb: number
  arch: Architecture
  /**
   * The machine family, used to decide zone availability (`isAvailableInZone`) and which boot
   * disk types this machine can attach (`allowedBootDiskTypes` in `offerings.ts`).
   */
  family: 'e2' | 't2a' | 'c4a'
}

export const GCP_TYPES: GcpTypeSpec[] = [
  { id: 'e2-micro', cpu: 2, memoryGb: 1, arch: 'amd64', family: 'e2' },
  { id: 'e2-small', cpu: 2, memoryGb: 2, arch: 'amd64', family: 'e2' },
  { id: 'e2-medium', cpu: 2, memoryGb: 4, arch: 'amd64', family: 'e2' },
  { id: 'e2-standard-2', cpu: 2, memoryGb: 8, arch: 'amd64', family: 'e2' },
  { id: 'e2-standard-4', cpu: 4, memoryGb: 16, arch: 'amd64', family: 'e2' },
  { id: 'e2-standard-8', cpu: 8, memoryGb: 32, arch: 'amd64', family: 'e2' },
  { id: 't2a-standard-1', cpu: 1, memoryGb: 4, arch: 'arm64', family: 't2a' },
  { id: 't2a-standard-2', cpu: 2, memoryGb: 8, arch: 'arm64', family: 't2a' },
  { id: 't2a-standard-4', cpu: 4, memoryGb: 16, arch: 'arm64', family: 't2a' },
  { id: 't2a-standard-8', cpu: 8, memoryGb: 32, arch: 'arm64', family: 't2a' },
  // C4A (Axion): the practical arm64 successor to T2A — same 4 GiB/vCPU shape, ~77 zones
  // instead of eight, eligible for CUDs, and Hyperdisk-only (see `allowedBootDiskTypes`).
  // Shapes read 2026-08-21 from the same page/column as the rows above; their prices carry that
  // same date through the feed's `transcribedAt` map.
  { id: 'c4a-standard-1', cpu: 1, memoryGb: 4, arch: 'arm64', family: 'c4a' },
  { id: 'c4a-standard-2', cpu: 2, memoryGb: 8, arch: 'arm64', family: 'c4a' },
  { id: 'c4a-standard-4', cpu: 4, memoryGb: 16, arch: 'arm64', family: 'c4a' },
  { id: 'c4a-standard-8', cpu: 8, memoryGb: 32, arch: 'arm64', family: 'c4a' },
]

/**
 * The eight zones where Tau T2A (arm64) exists, read on 2026-08-13 from
 * https://cloud.google.com/compute/docs/regions-zones by exact token match on the machine
 * series column.
 *
 * THIS LIST IS WHY `Offering.available` EXISTS (ADR-0003, B1). Unlike EC2 — where every
 * instance family is nominally orderable everywhere and stock is only discovered at
 * RunInstances — GCE simply does not offer T2A outside these eight zones, and that is a
 * published, stable fact rather than this afternoon's stock level. A size selector must be able
 * to tell "this cloud has no ARM here" from "ARM is sold out", and those need different
 * messages, so they need different data.
 *
 * `us-central1-c` is deliberately conspicuous by its absence: three of the four us-central1
 * zones carry T2A and `-c` does not, which makes it exactly the kind of default that would look
 * fine and quietly produce an amd64-only installation.
 */
export const T2A_ZONES: ReadonlySet<string> = new Set([
  'us-central1-a',
  'us-central1-b',
  'us-central1-f',
  'europe-west4-a',
  'europe-west4-b',
  'europe-west4-c',
  'asia-southeast1-b',
  'asia-southeast1-c',
])

/**
 * The ~77 zones where C4A (Axion, arm64) exists, read on 2026-08-21 from
 * https://cloud.google.com/compute/docs/regions-zones by exact token match on the machine
 * series column — the same method, and the same page, as `T2A_ZONES` above. Cross-checked: the
 * same scrape reproduces `T2A_ZONES` exactly (eight zones, same eight), which is what makes this
 * list trustworthy rather than a one-off read.
 *
 * THE POINT OF C4A, MADE CONCRETE: `us-central1-c` — the zone `T2A_ZONES` is conspicuously
 * missing, and the reason this provider's default zone is `us-central1-a` instead — DOES carry
 * C4A. An operator sitting in `us-central1-c` gets no arm64 from T2A and does get it from C4A,
 * and `isAvailableInZone` has to report both facts rather than one flag that averages them.
 *
 * Same shape as `T2A_ZONES`: a published, stable fact rather than a stock level, so a size
 * selector can say "this zone has no C4A" and mean it permanently, not "sold out this afternoon".
 */
export const C4A_ZONES: ReadonlySet<string> = new Set([
  'africa-south1-a',
  'asia-east1-a',
  'asia-east1-b',
  'asia-east1-c',
  'asia-northeast1-a',
  'asia-northeast1-b',
  'asia-northeast1-c',
  'asia-south1-a',
  'asia-south1-b',
  'asia-south1-c',
  'asia-southeast1-a',
  'asia-southeast1-b',
  'asia-southeast1-c',
  'asia-southeast2-a',
  'asia-southeast2-b',
  'asia-southeast2-c',
  'australia-southeast1-c',
  'australia-southeast2-a',
  'australia-southeast2-b',
  'australia-southeast2-c',
  'europe-north1-a',
  'europe-north1-b',
  'europe-north1-c',
  'europe-north2-a',
  'europe-north2-b',
  'europe-central2-a',
  'europe-southwest1-a',
  'europe-southwest1-b',
  'europe-southwest1-c',
  'europe-west1-b',
  'europe-west1-c',
  'europe-west1-d',
  'europe-west2-a',
  'europe-west2-b',
  'europe-west2-c',
  'europe-west3-a',
  'europe-west3-b',
  'europe-west3-c',
  'europe-west4-a',
  'europe-west4-b',
  'europe-west4-c',
  'europe-west6-b',
  'me-central1-c',
  'me-central2-a',
  'me-west1-b',
  'northamerica-northeast1-a',
  'northamerica-northeast1-b',
  'northamerica-northeast2-b',
  'northamerica-south1-a',
  'northamerica-south1-b',
  'northamerica-south1-c',
  'southamerica-east1-c',
  'southamerica-west1-a',
  'southamerica-west1-b',
  'us-central1-a',
  'us-central1-b',
  'us-central1-c',
  'us-central1-f',
  'us-east1-b',
  'us-east1-c',
  'us-east1-d',
  'us-east4-a',
  'us-east4-b',
  'us-east4-c',
  'us-east5-a',
  'us-east5-b',
  'us-east5-c',
  'us-south1-a',
  'us-south1-b',
  'us-west1-a',
  'us-west1-c',
  'us-west2-a',
  'us-west2-b',
  'us-west2-c',
  'us-west4-a',
  'us-west4-b',
  'us-west4-c',
])
