import type { Offering, Price } from '@rockysurf/provider-sdk'
import {
  AWS_HOURLY_USD,
  AWS_PRICES_FETCHED_AT,
  AWS_PRICES_PUBLISHED_AT,
  AWS_PRICES_SOURCE,
  AWS_TYPES,
} from './prices.generated.js'

/**
 * The machine types this provider offers, and their bundled prices.
 *
 * Prices ship bundled rather than fetched live (live pricing APIs are out of v0), and every
 * entry carries the timestamp it was read, so the UI can say "estimate based on prices as of
 * …" instead of implying a number is current.
 *
 * THE TABLE IS GENERATED, NOT TYPED. `prices.generated.ts` comes from
 * `scripts/refresh-prices.mjs`, which reads the same public feed the EC2 on-demand pricing page
 * renders — no credentials, no AWS account, no SDK. That matters for a number a customer will
 * compare against their bill: nothing here was recalled or rounded by hand, and drift is one
 * command away from a fix. The shape (vCPU, memory) is read from the same feed row as the
 * price, so the two cannot disagree.
 *
 * AWS quotes per REGION. Only the regions in that script's `AWS_REGIONS` map are bundled;
 * anywhere else, `hourly` is `null`, which the SDK defines as "unknown, never free" rather than
 * quietly reusing a us-east-1 number that would be wrong.
 */

export { AWS_PRICES_FETCHED_AT, AWS_PRICES_PUBLISHED_AT, AWS_PRICES_SOURCE }

/** @deprecated Kept for callers that predate the generated table. */
export const PRICES_FETCHED_AT = AWS_PRICES_FETCHED_AT

const usd = (amount: number): Price => ({ amount, currency: 'USD', fetchedAt: AWS_PRICES_FETCHED_AT })

/**
 * Build the offering list for one region.
 *
 * `available: true` on every entry, and that is an honest statement rather than a placeholder:
 * unlike Hetzner — which sells out of whole architectures and had zero arm64 stock across all
 * locations at spike capstone time — EC2 does not publish per-type stock, and refuses at
 * RunInstances with `InsufficientInstanceCapacity` instead. That refusal is mapped to
 * `capacity`, which is retryable, so the signal reaches core through the error path rather
 * than through this list.
 *
 * `listOfferings()` is a CATALOGUE, not a recommendation: core resolves a t-shirt size against
 * `Requirements`, and a selector can only rule out a machine it can see. That is still true at
 * ~1000 types across 12 regions, including nano/micro sizes far too small to run an agent — but
 * at that breadth, `AWS_TYPES` (the UNION of every type any bundled region's feed reported) and
 * "what one region actually sells" are no longer the same set. Outside `us-east-1`, AWS's own
 * regional rollout leaves a large share of `AWS_TYPES` absent from a given region's feed
 * entirely — not merely unpriced, genuinely not offered there (rockysurf-tzzw: `c8gb`/`c7gn`
 * and similar recent families are missing from more than a third of the 12 bundled regions'
 * feeds). So the two cases below are deliberately different, not the same "null means unknown"
 * rule applied unevenly:
 *
 *  - A REGION THIS PROVIDER DOES NOT BUNDLE AT ALL (`forRegion` is `undefined`): every type is
 *    still LISTED, with `hourly: null` — "this shape exists, we do not know its price here."
 *    That is amendment B2's rule, and the whole reason a bundled-elsewhere table must not be
 *    reused for a region it says nothing about.
 *  - A BUNDLED REGION WHOSE OWN FEED SIMPLY DOES NOT CARRY A GIVEN TYPE: that type is OMITTED
 *    from this region's list entirely, not listed unpriced. Showing it anyway would claim
 *    something false about AVAILABILITY, not just about price — a customer who selected it would
 *    hit RunInstances' `InstanceTypeNotAvailable` rather than get the box the picker showed them.
 *
 * The upshot, and the reason this distinction exists: every offering `buildOfferings()` returns
 * for a bundled region carries a real price. `hourly: null` on a bundled-region result would be
 * cap-blind by construction (jobs/limits.ts counts a `null`-priced row in `unpricedServers` and
 * adds nothing to any bucket) — the same defect breadth was rejected for a live catalogue over.
 *
 * @param diskGb the root volume size this provider is configured to attach, so the offering
 *   describes the machine core will actually create rather than the AMI's default.
 */
export function buildOfferings(region: string, diskGb: number): Offering[] {
  const forRegion = AWS_HOURLY_USD[region]

  return AWS_TYPES.flatMap((type) => {
    const amount = forRegion?.[type.id]
    // `forRegion` present but this id absent from it: AWS's own feed for THIS region does not
    // carry the type at all, so it is not offered here — see the long comment above.
    if (forRegion && amount === undefined) return []
    return [
      {
        id: type.id,
        cpu: type.cpu,
        memoryGb: type.memoryGb,
        diskGb,
        arch: type.arch,
        hourly: amount === undefined ? null : usd(amount),
        available: true,
        region,
      },
    ]
  })
}

/** The ids this provider will accept in a `ProvisionSpec`. */
export const OFFERING_IDS = AWS_TYPES.map((t) => t.id)
