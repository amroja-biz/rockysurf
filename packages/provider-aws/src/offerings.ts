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
 * The whole t4g and t3 families are listed, including the nano and micro sizes that are far too
 * small to run an agent. `listOfferings()` is a CATALOGUE, not a recommendation: core resolves
 * a t-shirt size against `Requirements`, and a selector can only rule out a machine it can see.
 *
 * @param diskGb the root volume size this provider is configured to attach, so the offering
 *   describes the machine core will actually create rather than the AMI's default.
 */
export function buildOfferings(region: string, diskGb: number): Offering[] {
  const forRegion = AWS_HOURLY_USD[region]

  return AWS_TYPES.map((type) => {
    const amount = forRegion?.[type.id]
    return {
      id: type.id,
      cpu: type.cpu,
      memoryGb: type.memoryGb,
      diskGb,
      arch: type.arch,
      hourly: amount === undefined ? null : usd(amount),
      available: true,
      region,
    }
  })
}

/** The ids this provider will accept in a `ProvisionSpec`. */
export const OFFERING_IDS = AWS_TYPES.map((t) => t.id)
