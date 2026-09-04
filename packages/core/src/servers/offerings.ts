import {
  archLabel,
  chooseForSize,
  chooseOffering,
  SIZE_REQUIREMENTS,
  type Architecture,
  type Offering,
  type OfferingRefusal,
  type PreferenceObstacle,
  type RejectedPreference,
  type Requirements,
  type SizeChoiceOptions,
} from '@rockysurf/provider-sdk'
import type { ServerSize } from '../db/schema.js'

/**
 * Resolving a t-shirt size (and an architecture) to a CONCRETE offering — server-side.
 *
 * ADR-0003 left t-shirt resolution "deliberately unresolved" and the create route filled the
 * gap with the cheapest available offering in the catalogue. That made `size` decorative
 * (rockysurf-clf2): every size landed on the same machine, and `arch` was worse than
 * decorative — the route picked the cheapest offering while keeping the arch the caller asked
 * for, handed the pair to the provider, and the provider refused the contradiction the route
 * had just invented ("arch arm64 does not match offering e2-micro (amd64)"). The only surface
 * that worked was the SPA, because it resolves in the browser and posts an `offeringId`.
 *
 * THE DECISIONS ARE NO LONGER MADE HERE (issue #349, ADR-0024). `chooseForSize` /
 * `chooseOffering` in `@rockysurf/provider-sdk` own them, and the SPA's
 * `packages/web/src/lib/requirements.ts` calls the same two functions before submit. This file
 * is the server-side VOICE of that one resolver: it turns a structured outcome into the
 * lowercase fragments core's HTTP errors are built from, and it keeps the two server-only
 * helpers (`allowedOfferings`, `describeCatalogue`) that the browser has no use for.
 *
 * What used to be here — `SIZE_REQUIREMENTS`, `byPrice`, `meets`, `preferenceProblem` and the
 * choosing half of `resolveOffering`/`resolveSize` — existed in parallel in the SPA, and
 * `scripts/check-size-table.mjs` compared only the NUMBERS. There is one table now, so that lint
 * is retired.
 */

export { archLabel, SIZE_REQUIREMENTS, type Requirements }

export type OfferingResolution =
  | { ok: true; offering: Offering }
  /**
   * `soldOut` separates "this cloud cannot do that" from "this cloud cannot do that RIGHT NOW".
   *
   * They need different words and different statuses — a caller that backs off and retries is
   * right about the second and wrong about the first — which is what `Offering.available`
   * exists to express (ADR-0003, B1).
   */
  | { ok: false; reason: string; soldOut: boolean }

/** `on ARM64`, or nothing at all when the caller expressed no preference. */
function archNote(arch: Architecture | undefined): string {
  return arch ? ` on ${archLabel(arch)}` : ''
}

/**
 * The server-side sentence for a refusal.
 *
 * Lowercase and unpunctuated, because every one of these ends up interpolated into a larger
 * HTTP error message in `servers/routes.ts` rather than read on its own.
 */
function refusalReason(refusal: OfferingRefusal): string {
  const { requirements: r } = refusal
  const floor = `${r.vcpu} vCPU and ${r.memGb} GB${archNote(r.arch)}`
  if (!refusal.soldOut) return `no machine type here offers at least ${floor}`
  // Lead with the provider's reason when every candidate gives the same one (Azure: no core
  // quota, issue #116) — its remedy is a portal request, not waiting for stock.
  return refusal.unanimousReason !== undefined
    ? `every machine type meeting ${floor} is unavailable: ${refusal.unanimousReason} — try another size or architecture`
    : `every machine type meeting ${floor} is sold out right now — try another size or architecture`
}

/**
 * The cheapest AVAILABLE offering meeting `requirements`, or an honest refusal.
 *
 * NEVER falls back to something that does not meet them. That is the whole point of the bead:
 * a caller who asked for `large` and got the cheapest micro instance was not served, they were
 * ignored, and they found out on the bill rather than in the response.
 */
export function resolveOffering(offerings: readonly Offering[], requirements: Requirements): OfferingResolution {
  const choice = chooseOffering(offerings, requirements)
  return choice.ok ? choice : { ok: false, soldOut: choice.soldOut, reason: refusalReason(choice) }
}

/**
 * A size resolution that also says what happened to the user's saved preference (issue #124).
 *
 * `preferred` is what the user asked for last time and got again; a `note` is the sentence
 * explaining why they did not. Exactly one of them is ever interesting, and both are absent on
 * an installation where nobody has saved anything — which is every installation until someone
 * does, and the reason this is additive rather than a replacement for `OfferingResolution`.
 */
export type SizeResolution =
  | { ok: true; offering: Offering; preferred: boolean; note?: string }
  | { ok: false; reason: string; soldOut: boolean; note?: string }

export type SizeOptions = SizeChoiceOptions

/**
 * Why the saved type could not be used, in core's voice.
 *
 * THE FLOOR IS NOT CHECKED, on purpose, and that rule lives in the shared resolver
 * (`preferenceObstacle`): a size's `SIZE_REQUIREMENTS` row exists to stop a caller with no
 * opinion being handed something smaller than they asked for; a caller who SAVED `t4g.large` as
 * their small has the opinion, and re-refusing it against the floor would be the product arguing
 * with a setting it asked the user to make.
 */
function obstacleSentence(rejected: RejectedPreference, size: ServerSize): string {
  const saved = `your saved ${size} type "${rejected.preference}"`
  const obstacle: PreferenceObstacle = rejected.obstacle
  switch (obstacle.kind) {
    case 'not-offered':
      return `${saved} is not one this installation offers`
    case 'unavailable':
      // The provider's own reason where it has one (Azure: which quota gate refused, issue #116) —
      // "sold out" would send someone to wait for stock that a quota request is the only cure for.
      return `${saved} is unavailable: ${obstacle.unavailableReason ?? 'it is sold out right now'}`
    case 'arch-mismatch':
      return `${saved} is ${archLabel(obstacle.preferredArch)} and this create asked for ${archLabel(obstacle.requestedArch)}`
  }
}

/**
 * Resolve a t-shirt size, honouring the user's saved type for it where one is usable.
 *
 * THE ORDER IS: preference if set and usable, then the ordinary cheapest-that-fits default.
 * A preference never becomes a refusal — an unusable one falls back and SAYS SO, because the
 * failure mode this has to avoid is a user who saved `t4g.large`, quietly got a `t4g.small` for
 * six weeks, and found out from the invoice.
 *
 * Every caller passes through the shared `chooseForSize`: the SPA calls it in the browser and
 * posts a concrete `offeringId`, and the CLI and the MCP server post a `size` that reaches this
 * wrapper through the create route. Same preference, same order, three surfaces.
 */
export function resolveSize(
  offerings: readonly Offering[],
  size: ServerSize,
  options: SizeOptions = {},
): SizeResolution {
  const choice = chooseForSize(offerings, size, options)
  const note = choice.rejected ? obstacleSentence(choice.rejected, size) : undefined

  if (choice.ok) {
    if (!note) return { ok: true, offering: choice.offering, preferred: choice.preferred }
    return {
      ok: true,
      offering: choice.offering,
      preferred: choice.preferred,
      note: `${note}, so ${choice.offering.id} was used instead`,
    }
  }

  const refusal = { ok: false as const, soldOut: choice.soldOut, reason: refusalReason(choice) }
  return note ? { ...refusal, note } : refusal
}

/**
 * Narrow a catalogue to the offerings this installation permits (rockysurf-j10e).
 *
 * `providers.<cloud>.sizes` has been declared in the config schema, carried through the
 * settings inventory and rendered on the settings page as "the instance types offered on the
 * New Server page" since it was written — and nothing read it. An operator who set it to keep
 * anyone from starting a 64-vCPU box got the sentence and none of the effect.
 *
 * SERVER-ONLY, and deliberately not part of the shared resolver: the provider sells what it
 * sells, and which of that this installation is willing to buy is an operator policy that
 * reaches the browser already applied, in the `/api/v1/providers` response.
 *
 * It is a plain string allowlist against `Offering.id`, so applying it costs core no knowledge
 * of any cloud. An unset allowlist offers everything, which is the documented default.
 */
export function allowedOfferings(
  offerings: readonly Offering[],
  allowlist: readonly string[] | undefined,
): readonly Offering[] {
  if (!allowlist) return offerings
  const permitted = new Set(allowlist)
  return offerings.filter((o) => permitted.has(o.id))
}

/** How many ids a refusal names before it stops being a sentence. */
const NAMED_IN_REFUSAL = 10

/**
 * The ids a caller could have passed, for a refusal that would otherwise only say "not that
 * one" (rockysurf-oeay).
 *
 * The missing-PROVIDER refusal has named the configured clouds since rockysurf-va2l, and that
 * is the prompt an agent needs — one that guessed wrong has nothing better to try otherwise.
 * The offering refusal had no equivalent.
 *
 * Capped and counted rather than exhaustive: a cloud's allowlist can hold dozens of types and
 * an error that scrolls off the screen is one nobody reads. Whoever needs all of them has a
 * surface for it now (`rockysurf offerings`, and the `list_offerings` MCP tool), which the
 * message points at instead of trying to be it.
 *
 * Sold-out types are named too, deliberately: they ARE creatable ids, they are simply out of
 * stock this afternoon, and the caller gets a different, honest refusal if they pick one.
 */
export function describeCatalogue(catalogue: readonly Offering[], limit = NAMED_IN_REFUSAL): string {
  if (catalogue.length === 0) return 'This installation allows none of its machine types.'
  const named = catalogue.slice(0, limit).map((o) => o.id)
  const rest = catalogue.length - named.length
  return (
    `It offers ${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}. ` +
    'Run `rockysurf offerings` for the full list with prices.'
  )
}
