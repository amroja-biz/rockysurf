import type { Architecture, Offering } from '@rockysurf/provider-sdk'
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
 * So the SPA's rule moves to where every caller passes through. A size is a FLOOR, not a
 * machine type: the cheapest available offering that meets it wins, and a cloud with coarser
 * types simply rounds up. Requested arch is part of the floor rather than a filter applied
 * afterwards, which is what makes arch-only creation possible at all.
 *
 * This module knows nothing about any particular cloud. It compares numbers on `Offering` and
 * matches `Offering.id` against a string allowlist, so no provider-id conditional is involved
 * and a provider added tomorrow is resolved by the same code.
 *
 * The SPA keeps its own copy in `packages/web/src/lib/requirements.ts` — it must resolve
 * BEFORE submit to show the machine and its price, and the dependency lint keeps core and the
 * browser bundle apart. `scripts/check-size-table.mjs` fails the build if the two size tables
 * drift, because two tables that disagree would show one price and bill another.
 */

export interface Requirements {
  vcpu: number
  memGb: number
  /** When set, only offerings of this architecture satisfy the requirements. */
  arch?: Architecture
}

/**
 * What each size asks for. MINIMUMS, not exact matches.
 *
 * Kept identical to the SPA's table by `scripts/check-size-table.mjs`. Changing a row here is
 * a pricing change for every installation that creates by size, so it changes in both places
 * or not at all.
 */
export const SIZE_REQUIREMENTS: Record<ServerSize, Requirements> = {
  small: { vcpu: 2, memGb: 2 },
  medium: { vcpu: 2, memGb: 4 },
  large: { vcpu: 4, memGb: 8 },
}

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

export function archLabel(arch: Architecture): string {
  return arch === 'arm64' ? 'ARM64' : 'x86-64'
}

/** Cheapest first; unpriced offerings sort last, since we cannot compare them honestly. */
function byPrice(a: Offering, b: Offering): number {
  const left = a.hourly?.amount ?? Number.POSITIVE_INFINITY
  const right = b.hourly?.amount ?? Number.POSITIVE_INFINITY
  if (left !== right) return left - right
  // A stable tiebreak, so two equally-priced types do not resolve differently run to run.
  return a.id.localeCompare(b.id)
}

const meets = (offering: Offering, requirements: Requirements): boolean =>
  offering.cpu >= requirements.vcpu &&
  offering.memoryGb >= requirements.memGb &&
  (requirements.arch === undefined || offering.arch === requirements.arch)

/**
 * The cheapest AVAILABLE offering meeting `requirements`, or an honest refusal.
 *
 * NEVER falls back to something that does not meet them. That is the whole point of the bead:
 * a caller who asked for `large` and got the cheapest micro instance was not served, they were
 * ignored, and they found out on the bill rather than in the response.
 */
export function resolveOffering(offerings: readonly Offering[], requirements: Requirements): OfferingResolution {
  const matching = offerings.filter((o) => meets(o, requirements))
  const archNote = requirements.arch ? ` on ${archLabel(requirements.arch)}` : ''

  if (matching.length === 0) {
    return {
      ok: false,
      soldOut: false,
      reason: `no machine type here offers at least ${requirements.vcpu} vCPU and ${requirements.memGb} GB${archNote}`,
    }
  }

  const available = matching.filter((o) => o.available).sort(byPrice)
  const chosen = available[0]
  if (!chosen) {
    return {
      ok: false,
      soldOut: true,
      reason: `every machine type meeting ${requirements.vcpu} vCPU and ${requirements.memGb} GB${archNote} is sold out right now — try another size or architecture`,
    }
  }

  return { ok: true, offering: chosen }
}

/**
 * Narrow a catalogue to the offerings this installation permits (rockysurf-j10e).
 *
 * `providers.<cloud>.sizes` has been declared in the config schema, carried through the
 * settings inventory and rendered on the settings page as "the instance types offered on the
 * New Server page" since it was written — and nothing read it. An operator who set it to keep
 * anyone from starting a 64-vCPU box got the sentence and none of the effect.
 *
 * Applied here rather than in the provider because it is core's own idea: the provider sells
 * what it sells, and which of that this installation is willing to buy is an operator policy.
 * It is a plain string allowlist against `Offering.id`, so applying it costs core no knowledge
 * of any cloud.
 *
 * An unset allowlist offers everything, which is the documented default.
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
