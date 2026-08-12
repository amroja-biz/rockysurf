/** CPU architectures v0 supports. Both are exercised end to end by the spike capstone. */
export type Architecture = 'amd64' | 'arm64'

export const ARCHITECTURES = ['amd64', 'arm64'] as const satisfies readonly Architecture[]

/**
 * A price, in the currency the provider actually quotes (ADR-0003, B2).
 *
 * The sketch had `hourlyUsd: number | null`, which reports `null` for every Hetzner project
 * billed in EUR — a real customer looking at a price list of nulls. Currency is part of the
 * value, not an assumption.
 */
export interface Price {
  /** Numeric amount in `currency`, per hour. */
  amount: number
  /** ISO 4217 code, uppercase: 'USD', 'EUR'. */
  currency: string
  /**
   * ISO 8601 timestamp of when this price was read.
   *
   * Prices ship bundled rather than fetched live (live pricing APIs are out of v0), so a
   * stamp is the only way a caller can tell a fresh quote from one baked in months ago and
   * present it honestly.
   */
  fetchedAt: string
}

/**
 * One purchasable machine type in one region.
 */
export interface Offering {
  /**
   * Provider-native id: `t4g.small`, `cpx12`. Deliberately a plain string (ADR-0003, B3).
   *
   * The AWS SDK types `InstanceType` as a generated closed union that a new family only joins
   * on the next SDK release, so a cast is unavoidable there and validation of native ids is
   * the provider's own job — not something a shared enum can do.
   */
  id: string
  cpu: number
  memoryGb: number
  /** Root disk size the provider gives this type, when it is fixed by the type. */
  diskGb?: number
  arch: Architecture
  /** Reserved; unpopulated in v0.1. */
  gpu?: { model: string; count: number }
  /**
   * Hourly price, or `null` when the provider does not quote one.
   *
   * `null` means "unknown", never "free": a caller must not present it as a price.
   */
  hourly: Price | null
  /**
   * Whether this type can be ordered RIGHT NOW (ADR-0003, B1).
   *
   * A price is not an offer. Hetzner publishes prices for sold-out types, and at spike
   * capstone time had zero arm64 stock across all locations — a fact the provider could
   * express only by silently omitting types from `listOfferings()`, leaving core unable to
   * tell "this cloud has no ARM" from "ARM is sold out this afternoon". Those need different
   * error messages and different fallback behaviour, so they need different data.
   *
   * Providers SHOULD return unavailable types with `available: false` rather than omitting
   * them, so a size selector can explain itself.
   */
  available: boolean
  /** Provider-native region/location id: 'us-east-1', 'fsn1'. */
  region: string
}
