import type { Offering, Price } from '@rockysurf/provider-sdk'
import type { PriceFeedDoc } from './feed.js'
import { AWS_TYPES } from './prices.generated.js'

/**
 * The machine types this provider offers, and where their prices come from.
 *
 * THE CATALOGUE IS GENERATED AND BUNDLED; THE PRICES ARE FETCHED (gh issue #100, ADR-0009).
 * `AWS_TYPES` — the shapes: vCPU, memory, architecture — still ships in `prices.generated.ts`,
 * because without it there is no catalogue at all and nothing can be created. The hourly
 * numbers come from the hosted price feed (`feed.ts`), republished daily from the same public
 * EC2 on-demand feed the AWS pricing page renders, so a price change reaches every install
 * without a release. Every price carries the feed's own `fetchedAt`, so the UI can say
 * "estimate based on prices as of …" instead of implying a number is current.
 *
 * AWS quotes per REGION. Only the regions the feed generator bundles appear in the feed
 * document; anywhere else, `hourly` is `null`, which the SDK defines as "unknown, never free"
 * rather than quietly reusing a us-east-1 number that would be wrong.
 */

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
 * at that breadth, `AWS_TYPES` (the UNION of every type any feed region's data reported) and
 * "what one region actually sells" are no longer the same set. Outside `us-east-1`, AWS's own
 * regional rollout leaves a large share of `AWS_TYPES` absent from a given region's feed
 * entirely — not merely unpriced, genuinely not offered there (rockysurf-tzzw: `c8gb`/`c7gn`
 * and similar recent families are missing from more than a third of the 12 covered regions'
 * feeds). So the two priced cases below are deliberately different, not the same "null means
 * unknown" rule applied unevenly:
 *
 *  - A REGION THE FEED DOES NOT COVER AT ALL (`forRegion` is `undefined`): every type is
 *    still LISTED, with `hourly: null` — "this shape exists, we do not know its price here."
 *    That is amendment B2's rule, and the whole reason a covered-elsewhere table must not be
 *    reused for a region it says nothing about.
 *  - A COVERED REGION WHOSE OWN DATA SIMPLY DOES NOT CARRY A GIVEN TYPE: that type is OMITTED
 *    from this region's list entirely, not listed unpriced. Showing it anyway would claim
 *    something false about AVAILABILITY, not just about price — a customer who selected it would
 *    hit RunInstances' `InstanceTypeNotAvailable` rather than get the box the picker showed them.
 *
 * So with a live feed, every offering returned for a covered region carries a real price —
 * `hourly: null` on a covered-region result would be cap-blind by construction (jobs/limits.ts
 * counts a `null`-priced row in `unpricedServers` and adds nothing to any bucket).
 *
 * WHEN THE FEED IS DOWN (`feed` is `null`), every type is listed with `hourly: null` — the
 * owner's no-fallback ruling (ADR-0009): tell the user prices are unavailable, keep creates
 * working. The per-region omission semantics above need the feed's region map to exist, so a
 * feed outage also temporarily lists types a region does not sell; that trade — a retryable
 * create error at worst, during an outage — was accepted over shipping a staleness-prone
 * bundled fallback.
 *
 * @param diskGb the root volume size this provider is configured to attach, so the offering
 *   describes the machine core will actually create rather than the AMI's default.
 * @param feed the current hosted price-feed document, or `null` when it could not be fetched.
 */
export function buildOfferings(region: string, diskGb: number, feed: PriceFeedDoc | null): Offering[] {
  const forRegion = feed?.regions[region]
  const price = (amount: number): Price => ({
    amount,
    currency: feed!.currency,
    fetchedAt: feed!.fetchedAt,
  })

  return AWS_TYPES.flatMap((type) => {
    const amount = forRegion?.[type.id]
    // `forRegion` present but this id absent from it: AWS's own data for THIS region does not
    // carry the type at all, so it is not offered here — see the long comment above.
    if (forRegion && amount === undefined) return []
    return [
      {
        id: type.id,
        cpu: type.cpu,
        memoryGb: type.memoryGb,
        diskGb,
        arch: type.arch,
        hourly: amount === undefined ? null : price(amount),
        available: true,
        region,
      },
    ]
  })
}

/** The ids this provider will accept in a `ProvisionSpec`. */
export const OFFERING_IDS = AWS_TYPES.map((t) => t.id)
