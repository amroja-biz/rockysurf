import type { Architecture, Offering } from './offering.js'

/**
 * T-SHIRT SIZE RESOLUTION — the one implementation, shared by every surface (issue #349).
 *
 * A size is a FLOOR, not a machine type: the cheapest AVAILABLE offering that meets it wins,
 * and a cloud with coarser types simply rounds up. Requested architecture is part of the floor
 * rather than a filter applied afterwards, which is what makes arch-only creation possible at
 * all (ADR-0003 left t-shirt resolution "deliberately unresolved"; rockysurf-clf2 filled it in).
 *
 * WHY IT LIVES IN THE SDK. It was written twice — once in `packages/core/src/servers/offerings.ts`
 * for the CLI and the MCP, once in `packages/web/src/lib/requirements.ts` for the browser, which
 * must resolve BEFORE submit so the New Server page can show the machine and its price and then
 * post the offering it quoted. Two copies of a pricing decision is a bill that disagrees with the
 * screen, and `scripts/check-size-table.mjs` only ever compared the NUMBERS; the logic around them
 * had already drifted structurally. Collapsing them needs a module both trees can import, and the
 * browser is the binding constraint: core's tree pulls in better-sqlite3 and ssh2.
 *
 * This package is where that lands because it already owns `Offering` and `Architecture`, the only
 * two types this file touches, and because its promise — the one its own `contract.test.ts`
 * asserts — is ZERO RUNTIME DEPENDENCIES, not zero runtime code. `errors.ts`, `instance.ts`,
 * `provision.ts` and `ssh-cidr.ts` are all pure helpers shipped here already; `ssh-cidr.ts`
 * arrived (issue #304) for exactly this reason, as "the one place three providers have to agree
 * character-for-character". Nothing here imports anything outside this package, so the promise
 * holds. See ADR-0024.
 *
 * WHAT IS NOT HERE: prose. Every function below returns a STRUCTURED outcome and each surface
 * phrases it in its own voice — core writes lowercase fragments that end up inside an HTTP error
 * message, the SPA writes sentences for a person looking at a form. Those wordings are deliberate
 * and different, and a shared module that tried to own them would either flatten one surface's
 * copy or drag UI strings into a published provider SDK. The DECISION is shared; the sentence is
 * not.
 */

/**
 * The t-shirt vocabulary. Three values, and the persisted `servers.size` column widens this to a
 * fourth (`'custom'`) that no size ever resolves to — see `StoredSize` in core's `db/schema.ts`.
 */
export type ServerSize = 'small' | 'medium' | 'large'

/** Ascending, and the order the New Server page draws the radio buttons in. */
export const SERVER_SIZES = ['small', 'medium', 'large'] as const satisfies readonly ServerSize[]

/** What a caller is asking a machine to be at least. */
export interface Requirements {
  vcpu: number
  memGb: number
  /** When set, only offerings of this architecture satisfy the requirements. */
  arch?: Architecture
}

/**
 * What each size asks for. MINIMUMS, not exact matches.
 *
 * THIS TABLE IS A PRICING DECISION. It used to exist twice with a regex lint (`check-size-table.mjs`)
 * comparing the copies; there is one now, so changing a row changes every surface at once and the
 * lint is retired.
 */
export const SIZE_REQUIREMENTS: Record<ServerSize, Requirements> = {
  small: { vcpu: 2, memGb: 2 },
  medium: { vcpu: 2, memGb: 4 },
  large: { vcpu: 4, memGb: 8 },
}

/** The floor for `size`, with an explicitly requested architecture folded in. */
export function requirementsForSize(size: ServerSize, arch?: Architecture): Requirements {
  return { ...SIZE_REQUIREMENTS[size], ...(arch ? { arch } : {}) }
}

/** How an architecture is written where a person reads it. */
export function archLabel(arch: Architecture): string {
  return arch === 'arm64' ? 'ARM64' : 'x86-64'
}

/** Cheapest first; unpriced offerings sort last, since we cannot compare them honestly. */
export function compareOfferingsByPrice(a: Offering, b: Offering): number {
  const left = a.hourly?.amount ?? Number.POSITIVE_INFINITY
  const right = b.hourly?.amount ?? Number.POSITIVE_INFINITY
  if (left !== right) return left - right
  // A stable tiebreak, so two equally-priced types do not resolve differently run to run.
  return a.id.localeCompare(b.id)
}

/** Whether one offering satisfies a floor. */
export function meetsRequirements(offering: Offering, requirements: Requirements): boolean {
  return (
    offering.cpu >= requirements.vcpu &&
    offering.memoryGb >= requirements.memGb &&
    (requirements.arch === undefined || offering.arch === requirements.arch)
  )
}

/**
 * Why nothing could be chosen.
 *
 * `soldOut` separates "this cloud cannot do that" from "this cloud cannot do that RIGHT NOW".
 * They need different words and different HTTP statuses — a caller that backs off and retries is
 * right about the second and wrong about the first — which is what `Offering.available` exists to
 * express (ADR-0003, B1).
 */
export interface OfferingRefusal {
  ok: false
  soldOut: boolean
  /** The floor that was asked for, so a caller can phrase the refusal without recomputing it. */
  requirements: Requirements
  /**
   * The provider's own reason, when EVERY matching type gave the same one (Azure: no core quota,
   * issue #116) — its remedy is a portal request, not waiting for stock. Only ever set alongside
   * `soldOut: true`.
   */
  unanimousReason?: string
}

export type OfferingChoice = { ok: true; offering: Offering } | OfferingRefusal

/**
 * The cheapest AVAILABLE offering meeting `requirements`, or a structured refusal.
 *
 * NEVER falls back to something that does not meet them. That is the whole point: a caller who
 * asked for `large` and got the cheapest micro instance was not served, they were ignored, and
 * they found out on the bill rather than in the response.
 */
export function chooseOffering(offerings: readonly Offering[], requirements: Requirements): OfferingChoice {
  const matching = offerings.filter((o) => meetsRequirements(o, requirements))
  if (matching.length === 0) return { ok: false, soldOut: false, requirements }

  const chosen = matching.filter((o) => o.available).sort(compareOfferingsByPrice)[0]
  if (chosen) return { ok: true, offering: chosen }

  const why = matching[0]?.unavailableReason
  const unanimous = why !== undefined && matching.every((o) => o.unavailableReason === why)
  return { ok: false, soldOut: true, requirements, ...(unanimous ? { unanimousReason: why } : {}) }
}

/**
 * Why a saved machine type cannot be used right now (issue #124).
 *
 * These are the three things that make a preference IMPOSSIBLE rather than merely unusual: it is
 * not sold here, it is not sellable right now, or its architecture contradicts one the caller
 * named explicitly on this create.
 */
export type PreferenceObstacle =
  | { kind: 'not-offered' }
  | { kind: 'unavailable'; unavailableReason?: string }
  | { kind: 'arch-mismatch'; preferredArch: Architecture; requestedArch: Architecture }

/**
 * Why the saved preference cannot be used, or `undefined` when it can.
 *
 * THE SIZE'S FLOOR IS NOT CHECKED, on purpose. A size's `SIZE_REQUIREMENTS` row exists to stop a
 * caller with no opinion being handed something smaller than they asked for; a caller who SAVED
 * `t4g.large` as their small HAS the opinion, and re-refusing it against the floor would be the
 * product arguing with a setting it asked the user to make.
 */
export function preferenceObstacle(
  offerings: readonly Offering[],
  preference: string,
  arch: Architecture | undefined,
): PreferenceObstacle | undefined {
  const chosen = offerings.find((o) => o.id === preference)
  if (!chosen) return { kind: 'not-offered' }
  if (!chosen.available) {
    return { kind: 'unavailable', ...(chosen.unavailableReason ? { unavailableReason: chosen.unavailableReason } : {}) }
  }
  if (arch !== undefined && chosen.arch !== arch) {
    return { kind: 'arch-mismatch', preferredArch: chosen.arch, requestedArch: arch }
  }
  return undefined
}

/** A saved type that was set, could not be used, and therefore owes the user an explanation. */
export interface RejectedPreference {
  /** The saved machine-type id. */
  preference: string
  obstacle: PreferenceObstacle
}

export interface SizeChoiceOptions {
  arch?: Architecture
  /** The machine type this user saved for this size on this cloud, if they saved one. */
  preference?: string
}

/**
 * The outcome of resolving a size.
 *
 * `rejected` is present exactly when a preference was set and could not be used — on the success
 * branch beside the machine that was used instead, and on the failure branch where there is no
 * such machine. `preferred` says the saved type IS the answer. At most one of them is ever
 * interesting, and on an installation where nobody has saved anything both are absent — which is
 * every installation until someone does.
 */
export type SizeChoice =
  | { ok: true; offering: Offering; preferred: boolean; rejected?: RejectedPreference }
  | (OfferingRefusal & { rejected?: RejectedPreference })

/**
 * Resolve a t-shirt size, honouring the user's saved type for it where one is usable.
 *
 * THE ORDER IS: preference if set and usable, then the ordinary cheapest-that-fits default. A
 * preference never becomes a refusal — an unusable one falls back and SAYS SO (that is what
 * `rejected` is for), because the failure mode this has to avoid is a user who saved `t4g.large`,
 * quietly got a `t4g.small` for six weeks, and found out from the invoice.
 *
 * Every surface passes through here. The SPA calls it in the browser before submit and posts the
 * concrete `offeringId` it quoted; the CLI and the MCP server post a `size` that reaches it
 * through core's create route. Same preference, same order, three surfaces, one function.
 */
export function chooseForSize(
  offerings: readonly Offering[],
  size: ServerSize,
  options: SizeChoiceOptions = {},
): SizeChoice {
  const { arch, preference } = options
  const fallback = chooseOffering(offerings, requirementsForSize(size, arch))

  if (!preference) return fallback.ok ? { ...fallback, preferred: false } : fallback

  const obstacle = preferenceObstacle(offerings, preference, arch)
  if (!obstacle) {
    // `preferenceObstacle` already found it and vouched for it; re-finding it keeps the return
    // type honest without a non-null assertion on a search done twice.
    const chosen = offerings.find((o) => o.id === preference)!
    return { ok: true, offering: chosen, preferred: true }
  }

  const rejected: RejectedPreference = { preference, obstacle }
  return fallback.ok ? { ...fallback, preferred: false, rejected } : { ...fallback, rejected }
}
