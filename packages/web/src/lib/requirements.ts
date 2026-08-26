import type { Offering } from './api'

/**
 * T-shirt sizes are sugar over a Requirements selector.
 *
 * The plan and ADR-0003 both say the same thing: a size is not a machine type, it is a
 * shorthand for "at least this much", resolved against whatever the chosen provider actually
 * sells. That is what lets one UI serve clouds with completely different catalogues — EC2's
 * `t4g.small` and Hetzner's `cpx12` are not comparable by name, only by what they provide.
 *
 * Resolution happens BEFORE submit so the user is shown the concrete offering and its price
 * rather than discovering both on the server detail page.
 */

export type ServerSize = 'small' | 'medium' | 'large'
export type Architecture = 'amd64' | 'arm64'

export interface Requirements {
  vcpu: number
  memGb: number
  diskGb?: number
  arch?: Architecture
}

export const SIZES: ServerSize[] = ['small', 'medium', 'large']

/**
 * What each size asks for. Minimums, not exact matches — the resolver takes the cheapest
 * offering that meets them, so a cloud with coarser types simply rounds up.
 */
export const SIZE_REQUIREMENTS: Record<ServerSize, Requirements> = {
  small: { vcpu: 2, memGb: 2 },
  medium: { vcpu: 2, memGb: 4 },
  large: { vcpu: 4, memGb: 8 },
}

export interface ResolutionSuccess {
  ok: true
  offering: Offering
  /** Other offerings that also satisfy the requirements, cheapest first. */
  alternatives: Offering[]
}

export interface ResolutionFailure {
  ok: false
  /** Why nothing matched, phrased for the person looking at the form. */
  reason: string
  /**
   * True when the requirements COULD be met but everything matching is sold out.
   *
   * Worth distinguishing: "this cloud has no ARM" and "ARM is sold out this afternoon" need
   * different words and different advice. `Offering.available` exists precisely so the UI can
   * tell them apart — Hetzner had zero arm64 stock across all locations during the spike.
   */
  soldOut: boolean
}

export type Resolution = ResolutionSuccess | ResolutionFailure

/** Cheapest first; unpriced offerings sort last, since we cannot compare them honestly. */
function byPrice(a: Offering, b: Offering): number {
  const left = a.hourly?.amount ?? Number.POSITIVE_INFINITY
  const right = b.hourly?.amount ?? Number.POSITIVE_INFINITY
  if (left !== right) return left - right
  return a.id.localeCompare(b.id)
}

const meets = (offering: Offering, requirements: Requirements): boolean =>
  offering.cpu >= requirements.vcpu &&
  offering.memoryGb >= requirements.memGb &&
  (requirements.diskGb === undefined || (offering.diskGb ?? 0) >= requirements.diskGb) &&
  (requirements.arch === undefined || offering.arch === requirements.arch)

/**
 * Resolve requirements against a provider's catalogue.
 *
 * Returns the cheapest AVAILABLE offering that meets them. When nothing available matches, the
 * failure says whether that is because the requirements are unmeetable here or because the
 * matching types are sold out right now.
 */
export function resolveOffering(offerings: Offering[], requirements: Requirements): Resolution {
  const matching = offerings.filter((o) => meets(o, requirements))

  if (matching.length === 0) {
    const archNote = requirements.arch ? ` on ${archLabel(requirements.arch)}` : ''
    return {
      ok: false,
      soldOut: false,
      reason: `No machine type here offers at least ${requirements.vcpu} vCPU and ${requirements.memGb} GB${archNote}.`,
    }
  }

  const available = matching.filter((o) => o.available).sort(byPrice)
  if (available.length === 0) {
    const archNote = requirements.arch ? ` ${archLabel(requirements.arch)}` : ''
    // Lead with the provider's own reason when every candidate has one and they agree on
    // the gist — on Azure that is "no core quota", whose remedy is a portal request, not
    // waiting. Mixed or absent reasons fall back to the generic sentence.
    const why = matching[0]?.unavailableReason
    const unanimous = why !== undefined && matching.every((o) => o.unavailableReason === why)
    return {
      ok: false,
      soldOut: true,
      reason: unanimous
        ? `Every matching${archNote} machine type is unavailable: ${why}. Try another size or architecture.`
        : `Every matching${archNote} machine type is sold out right now. Try another size or architecture.`,
    }
  }

  const [offering, ...alternatives] = available
  return { ok: true, offering: offering!, alternatives }
}

/** Architectures a provider's catalogue actually contains, so the picker offers only real ones. */
export function availableArchitectures(offerings: Offering[]): Architecture[] {
  const seen = new Set<Architecture>()
  for (const offering of offerings) seen.add(offering.arch)
  // arm64 first: it is first-class here, and usually the cheaper of the two.
  return (['arm64', 'amd64'] as Architecture[]).filter((a) => seen.has(a))
}

export function archLabel(arch: Architecture): string {
  return arch === 'arm64' ? 'ARM64' : 'x86-64'
}

/** `$0.0168/hr`, or an honest blank when the provider quoted nothing. */
export function formatHourly(price: { amount: number; currency: string } | null | undefined): string {
  if (!price) return 'price unavailable'
  const symbol = price.currency === 'USD' ? '$' : price.currency === 'EUR' ? '€' : ''
  const amount = price.amount < 1 ? price.amount.toFixed(4) : price.amount.toFixed(2)
  return symbol ? `${symbol}${amount}/hr` : `${amount} ${price.currency}/hr`
}

/** Rough monthly figure at 730 hours. An estimate of an estimate; labelled as such in the UI. */
export function formatMonthly(price: { amount: number; currency: string } | null | undefined): string | null {
  if (!price) return null
  const symbol = price.currency === 'USD' ? '$' : price.currency === 'EUR' ? '€' : ''
  const monthly = (price.amount * 730).toFixed(2)
  return symbol ? `${symbol}${monthly}` : `${monthly} ${price.currency}`
}

/**
 * "prices as of 11 Aug 2026".
 *
 * Shown wherever a price is, because these ship bundled rather than fetched live, and a
 * number with no date invites someone to treat a months-old figure as current.
 */
export function formatPricesAsOf(fetchedAt: string | undefined): string | null {
  if (!fetchedAt) return null
  const date = new Date(fetchedAt)
  if (Number.isNaN(date.getTime())) return null
  return `prices as of ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}
