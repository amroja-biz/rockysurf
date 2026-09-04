import {
  archLabel,
  chooseForSize,
  chooseOffering,
  SERVER_SIZES,
  SIZE_REQUIREMENTS,
  type Architecture,
  type OfferingRefusal,
  type PreferenceObstacle,
  type RejectedPreference,
  type Requirements,
  type ServerSize,
  type SizeChoiceOptions,
} from '@rockysurf/provider-sdk'
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
 * rather than discovering both on the server detail page, and the form then posts the offering
 * it quoted rather than a size for core to re-resolve.
 *
 * THE DECISIONS ARE NOT MADE HERE any more (issue #349, ADR-0024). `chooseForSize` /
 * `chooseOffering` in `@rockysurf/provider-sdk` own them and core's
 * `packages/core/src/servers/offerings.ts` calls the same two functions for the CLI and the
 * MCP. This file is the BROWSER'S VOICE of that one resolver: it phrases the outcome as
 * sentences for a person looking at a form (core's wording is lowercase fragments destined for
 * an HTTP error), and it keeps the browser-only display helpers below.
 *
 * The SDK is where the shared half lives because it already owns `Offering` and `Architecture`
 * and depends on nothing — core's tree pulls in better-sqlite3 and ssh2, which is exactly why
 * this file was a copy for so long.
 */

export type { Architecture, Requirements, ServerSize }
export { archLabel, SIZE_REQUIREMENTS }

/** The three sizes, in the order the fieldset draws them. */
export const SIZES = SERVER_SIZES

export interface ResolutionSuccess {
  ok: true
  offering: Offering
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

/** The sentence for a refusal, in the second person the rest of this form speaks in. */
function refusalReason(refusal: OfferingRefusal): string {
  const { requirements: r } = refusal
  if (!refusal.soldOut) {
    const note = r.arch ? ` on ${archLabel(r.arch)}` : ''
    return `No machine type here offers at least ${r.vcpu} vCPU and ${r.memGb} GB${note}.`
  }
  const note = r.arch ? ` ${archLabel(r.arch)}` : ''
  // Lead with the provider's own reason when every candidate has one and they agree on the
  // gist — on Azure that is "no core quota", whose remedy is a portal request, not waiting.
  // Mixed or absent reasons fall back to the generic sentence.
  return refusal.unanimousReason !== undefined
    ? `Every matching${note} machine type is unavailable: ${refusal.unanimousReason}. Try another size or architecture.`
    : `Every matching${note} machine type is sold out right now. Try another size or architecture.`
}

/**
 * Resolve requirements against a provider's catalogue.
 *
 * Returns the cheapest AVAILABLE offering that meets them. When nothing available matches, the
 * failure says whether that is because the requirements are unmeetable here or because the
 * matching types are sold out right now.
 */
export function resolveOffering(offerings: Offering[], requirements: Requirements): Resolution {
  const choice = chooseOffering(offerings, requirements)
  return choice.ok ? { ok: true, offering: choice.offering } : { ok: false, soldOut: choice.soldOut, reason: refusalReason(choice) }
}

/**
 * A size resolution that also says what became of the user's saved type (issue #124).
 *
 * `preferred` means the saved type IS what will be created; a `note` explains why it is not.
 */
export type SizeResolution =
  | (ResolutionSuccess & { preferred: boolean; note?: string })
  | (ResolutionFailure & { note?: string })

export type SizeOptions = SizeChoiceOptions

/**
 * Why the saved type could not be used, in the browser's voice.
 *
 * THE SIZE'S FLOOR IS NOT CHECKED — that rule lives in the shared `preferenceObstacle`, and it
 * is deliberate: the floors exist so a user with no opinion is not under-served, and "my small
 * is t4g.large" is the opinion. Only the three impossibilities are checked — not sold here, not
 * sellable now, or an architecture contradicting one this create named explicitly.
 */
function obstacleSentence(rejected: RejectedPreference, size: ServerSize): string {
  const saved = `Your saved ${size} type “${rejected.preference}”`
  const obstacle: PreferenceObstacle = rejected.obstacle
  switch (obstacle.kind) {
    case 'not-offered':
      return `${saved} is not one this installation offers`
    case 'unavailable':
      // The provider's own words where it has them (Azure: which quota gate refused). "Sold out"
      // would send someone to wait for stock when a quota request is the only thing that helps.
      return `${saved} is unavailable: ${obstacle.unavailableReason ?? 'it is sold out right now'}`
    case 'arch-mismatch':
      return `${saved} is ${archLabel(obstacle.preferredArch)} and you asked for ${archLabel(obstacle.requestedArch)}`
  }
}

/**
 * Resolve a size, honouring the saved type for it where one is usable.
 *
 * Preference first, then the ordinary cheapest-that-fits default. A preference never becomes a
 * refusal: an unusable one falls back and carries a `note` saying why, because the failure this
 * has to avoid is a user who saved a type, quietly got a different one for six weeks, and found
 * out from the invoice.
 */
export function resolveSize(offerings: Offering[], size: ServerSize, options: SizeOptions = {}): SizeResolution {
  const choice = chooseForSize(offerings, size, options)
  const note = choice.rejected ? obstacleSentence(choice.rejected, size) : undefined

  if (choice.ok) {
    if (!note) return { ok: true, offering: choice.offering, preferred: choice.preferred }
    return {
      ok: true,
      offering: choice.offering,
      preferred: choice.preferred,
      note: `${note}, so ${choice.offering.id} is used instead.`,
    }
  }

  const refusal = { ok: false as const, soldOut: choice.soldOut, reason: refusalReason(choice) }
  return note ? { ...refusal, note: `${note}.` } : refusal
}

/** Architectures a provider's catalogue actually contains, so the picker offers only real ones. */
export function availableArchitectures(offerings: Offering[]): Architecture[] {
  const seen = new Set<Architecture>()
  for (const offering of offerings) seen.add(offering.arch)
  // arm64 first: it is first-class here, and usually the cheaper of the two.
  return (['arm64', 'amd64'] as Architecture[]).filter((a) => seen.has(a))
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
