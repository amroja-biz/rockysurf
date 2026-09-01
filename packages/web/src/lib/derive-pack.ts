import type { AdminSurgePack } from './api'

/**
 * Forking a pack, in one place (issue #295).
 *
 * There are two doors onto the same act now — "Start from an existing pack" on the Surge Packs
 * page (issue #204) and "Add to a pack…" on a tool's row, which forks when the pack you picked
 * is one you cannot edit. Two doors onto one act is how the two start disagreeing about what a
 * fork is, so the naming rule and the carried fields live here and both import them.
 *
 * What a fork is NOT is a copy of the pack's definition. `tools` is a list of ids and stays a
 * list of ids, so the fork keeps tracking the official tools' scripts as they are updated
 * (`docs/writing-a-pack.md` § "Building on an existing pack"). What freezes at fork time is
 * membership: which tools, and the behaviour flags.
 */

/**
 * A `packId` that is not `taken`. `-copy`, then `-copy-2`, `-copy-3`… — the same source can be
 * forked more than once in one sitting without the second attempt colliding with the first.
 */
export function suggestNewPackId(sourceId: string, taken: ReadonlySet<string>): string {
  let candidate = `${sourceId}-copy`
  let n = 2
  while (taken.has(candidate)) {
    candidate = `${sourceId}-copy-${n}`
    n += 1
  }
  return candidate
}

/** What a fork is called before the operator renames it. */
export const forkNameFor = (source: AdminSurgePack): string => `${source.name} (copy)`

/**
 * The fields a fork inherits that no form control covers, plus the parent id itself.
 *
 * THE ARTWORK IS INHERITED ON PURPOSE (owner's ruling, issue #295). A fork of the Claude Code
 * pack should look like the Claude Code pack with a mark on it, not like an unrelated pack that
 * happens to contain the same tools — recognising it at a glance on the Personal tab is the
 * entire point. `PackIcon` draws the delta over it, and the delta is derived from
 * `derivedFromPackId`, so the two always travel together on this installation.
 *
 * They do NOT travel off it: the pack export drops an inherited image precisely because
 * provenance does not export, so the delta cannot be drawn on the far side and the artwork
 * would arrive unmarked. See the export route in `packs/routes.ts`.
 *
 * `guide` and `inputs` come too, and dropping them was a real bug rather than a stylistic
 * choice: a fork of a pack that declares `inputs` and loses them gets a create form with no
 * fields, and its install scripts then run without the values they were written to read.
 */
export function carryFromSource(source: AdminSurgePack): Partial<AdminSurgePack> {
  return {
    derivedFromPackId: source.packId,
    ...(source.imageUrl ? { imageUrl: source.imageUrl } : {}),
    ...(source.theme ? { theme: source.theme } : {}),
    ...(source.guide ? { guide: source.guide } : {}),
    ...(source.inputs?.length ? { inputs: source.inputs } : {}),
  }
}

/**
 * Every pack that has a personal version, by parent id — what the Surge Packs page marks.
 *
 * Derived in the browser from the pack list it already has, rather than served as a count, so
 * deleting a fork clears the parent's mark with nothing to invalidate. A fork whose parent is
 * no longer installed simply matches no card.
 */
export function forksByParent<T extends { packId: string; name: string; derivedFromPackId?: string }>(
  packs: readonly T[],
): Map<string, T[]> {
  const byParent = new Map<string, T[]>()
  for (const pack of packs) {
    if (!pack.derivedFromPackId) continue
    const existing = byParent.get(pack.derivedFromPackId)
    if (existing) existing.push(pack)
    else byParent.set(pack.derivedFromPackId, [pack])
  }
  return byParent
}
