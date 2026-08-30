import { useMemo, useState } from 'react'
import { archLabel, formatHourly, formatPricesAsOf } from '../lib/requirements'
import type { Offering } from '../lib/api'

/**
 * A specific machine type, named directly, over a t-shirt size (rockysurf-kh3u, issue #24 PR 1).
 *
 * A size is a floor — "at least this much" — and the create route already accepts an
 * `offeringId` naming an exact one; this disclosure is the first place the New Server page lets
 * a person reach it, over the SAME catalogue its Size fieldset resolves against. Nothing here
 * fetches anything of its own: it is handed the allowlist-filtered offerings its page already
 * loaded for the resolver, so a row shown here is a row the create request can actually name.
 *
 * TWO PAGES USE IT (issue #212). The Settings page's saved types —
 * `preferences.tiers.<cloud>.<size>` — were free-text boxes over this very catalogue, which
 * asked an operator to type an id from memory in the one place a typo is remembered rather than
 * corrected on the next screen. It is the same list, the same rows, the same "Available only"
 * filter and the same refusals, so it is this component rather than a second one written to look
 * like it. That is also why the two strings a caller's context supplies — the summary and the
 * sentence under it — are props: everything else here is the catalogue, and the catalogue does
 * not change between pages.
 *
 * RENDER CAP, deliberately. The catalogue this reads from is ~12 rows today and will be roughly
 * a thousand once AWS's generator widens it (issue #24 PR 2a) — searching first and rendering a
 * capped, filtered slice is what keeps that future catalogue from becoming a thousand DOM rows.
 *
 * SOLD-OUT ROWS ARE DISABLED, NOT HIDDEN BY DEFAULT — an id a person cannot buy today is still a
 * real id, and hiding it would make the catalogue look smaller than it is. `Offering.available`
 * is the only signal any provider puts on the wire for this (no provider attaches a per-row
 * reason string), so every disabled row carries the same honest, generic sentence rather than
 * one this component would have to invent per cloud.
 *
 * "AVAILABLE ONLY" (issue #153), checked by default, lets a person who does not care to read
 * every refusal skip straight to what they can actually order — Azure in particular fills this
 * table with SKU-restricted and quota-refused rows (issue #139) that outnumber the buyable ones
 * on a fresh subscription. It reads nothing but `available`, so it costs no provider anything to
 * support. One row is exempt from being hidden by it regardless: the saved/preferred type for
 * this provider (`preferredIds`, #152's tier preference). Hiding that row would remove the only
 * place its own unavailable reason is shown *in this table*, contradicting the note the New
 * Server page's Size fieldset gives about it — and on Settings it would hide the very row the
 * operator is looking at.
 */
export function MachineTypePicker({
  offerings,
  selectedId,
  onSelect,
  onClear,
  preferredIds,
  summary = 'Choose a specific machine type',
  hint = 'Pick an exact machine type instead of a size. Selecting one sends this type instead of a size, and clears the Size choice above.',
  instanceId,
}: {
  offerings: readonly Offering[]
  /** The offering id currently driving the request, or `null` when a size drives it instead. */
  selectedId: string | null
  onSelect: (offering: Offering) => void
  onClear: () => void
  /** Saved/preferred type ids for this provider (#152) — never hidden by "Available only". */
  preferredIds: ReadonlySet<string>
  /** The disclosure's own label, since what opening it is FOR differs by page. */
  summary?: string
  /** The sentence under the label: what this list is, and what selecting a row does. */
  hint?: string
  /**
   * Distinguishes one picker from another on a page that mounts several.
   *
   * The Settings form draws one per (cloud, size) — fifteen of them, all mounted, because that
   * page keeps every panel mounted on purpose — and a name that is unique on the New Server page
   * is not unique there. Absent, every name is exactly what it was while this lived in
   * `CreateServerPage`, so that page's markup is unchanged by the move.
   */
  instanceId?: string
}) {
  // Collapsed by default, and the TABLE ITSELF IS NOT MOUNTED while collapsed — not merely
  // visually hidden. Two reasons, not one: the catalogue this reads from is ~12 rows today and
  // will be roughly a thousand once AWS's generator widens it (issue #24 PR 2a), so there is no
  // reason to build rows nobody has asked to see; and a mounted-but-hidden table would duplicate
  // every row's price text into the page underneath, which the New Server page's own price
  // display already renders once. On Settings it is what keeps fifteen of these cheap.
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // On by default (issue #153): most people opening this table want to know what they can
  // actually order, not read a refusal per row.
  const [availableOnly, setAvailableOnly] = useState(true)

  /** A name that has to stay unique where a page mounts more than one of these. */
  const named = (base: string) => (instanceId ? `${base}-${instanceId}` : base)

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return offerings
    return offerings.filter((o) => o.id.toLowerCase().includes(q) || o.region.toLowerCase().includes(q))
  }, [offerings, query])

  // Rows the "Available only" checkbox removes from the searched set — always excluding the
  // saved/preferred type, which stays visible (with its reason) regardless of the checkbox.
  const unavailableHiddenCount = useMemo(() => {
    if (!availableOnly) return 0
    return searched.filter((o) => !o.available && !preferredIds.has(o.id)).length
  }, [searched, availableOnly, preferredIds])

  const filtered = useMemo(() => {
    if (!availableOnly) return searched
    return searched.filter((o) => o.available || preferredIds.has(o.id))
  }, [searched, availableOnly, preferredIds])

  const shown = filtered.slice(0, MACHINE_PICKER_RENDER_CAP)
  const hiddenCount = filtered.length - shown.length

  return (
    <details
      className="machine-picker"
      data-testid={named('machine-type-picker')}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      {/* `role="button"` stated explicitly: the ARIA-in-HTML mapping for a details' first
          `<summary>` is implicitly "button", but it is a context-dependent mapping few
          accessibility-tree implementations compute, so this is declared rather than assumed. */}
      <summary role="button">{summary}</summary>
      {!open ? null : (
        <>
          <p className="hint">{hint}</p>
          <input
            id={named('machine-picker-search')}
            type="search"
            className="machine-picker-search"
            aria-label="Search machine types"
            // The table lists machine TYPES (the `Type` column, an id like `Standard_B12ms`) and
            // their region — not the server's own id, which this box never matched (issue #151).
            placeholder="Search by type or region…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Enter in a search box means "search", and this one searched as it was typed. Both
            // pages that mount it put it inside a form whose implicit submission is a real act —
            // creating a server, writing the configuration file — and neither is what somebody
            // filtering a table asked for.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault()
            }}
          />
          <label className="checkbox-row machine-picker-filter">
            <input
              type="checkbox"
              checked={availableOnly}
              onChange={(e) => setAvailableOnly(e.target.checked)}
            />
            <span>Available only</span>
          </label>
          {/* Present only while the checkbox is actually hiding something — a count that is
              always there, including "0 unavailable hidden", is chrome that stops meaning
              anything (issue #153). */}
          {unavailableHiddenCount > 0 && (
            <p className="hint" data-testid={named('machine-picker-hidden-count')}>
              {unavailableHiddenCount} unavailable hidden
            </p>
          )}
          <div className="machine-picker-table-wrap">
            <table>
              <caption className="hint">Estimates only — you are billed by the provider, not by Rocky Surf.</caption>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>vCPU</th>
                  <th>Memory</th>
                  <th>Disk</th>
                  <th>Arch</th>
                  <th>Region</th>
                  <th>Price</th>
                  <th className="machine-picker-actions">
                    <span className="sr-only">Select</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((offering) => {
                  const asOf = formatPricesAsOf(offering.hourly?.fetchedAt)
                  const selected = offering.id === selectedId
                  return (
                    <tr key={offering.id} className={selected ? 'selected' : ''}>
                      <td><code>{offering.id}</code></td>
                      <td>{offering.cpu}</td>
                      <td>{offering.memoryGb} GB</td>
                      <td>{offering.diskGb ? `${offering.diskGb} GB` : '—'}</td>
                      <td>
                        <span className="arch-badge">{archLabel(offering.arch)}</span>
                      </td>
                      <td>{offering.region}</td>
                      <td>
                        {offering.hourly ? (
                          <>
                            {formatHourly(offering.hourly)}
                            {asOf && <div className="hint">{asOf}</div>}
                          </>
                        ) : (
                          // Never blank, never $0 — null means the provider quoted nothing, not free.
                          'price unknown'
                        )}
                      </td>
                      {/*
                        STICKY, not just scrolled-to (issue #260). The wrapper below scrolls the
                        whole row horizontally on a screen too narrow for eight columns — that
                        is the point of it — but a row whose Select button scrolls off with
                        everything else shows a table of machines with no visible way to pick
                        one, which is indistinguishable from broken. Pinned to the scroller's
                        own right edge, this cell (and its header) stay in view at every scroll
                        position; the opaque background is what stops the columns still
                        scrolling underneath from showing through it.
                      */}
                      <td className="machine-picker-actions">
                        {!offering.available ? (
                          // The provider's own reason where it gives one — Azure says which
                          // quota gate refused (issue #116) — and the generic sentence where
                          // it does not. "Sold out" for a size the subscription has no quota
                          // for would tell the user to wait for stock that never comes.
                          // `.unavailable`, not `.warning`: the latter is a page-level notice
                          // with a border and a rem of padding, and an inline span wearing it
                          // inside a table cell painted a box outside the table (issue #113).
                          <span className="unavailable">{offering.unavailableReason ?? 'sold out right now'}</span>
                        ) : (
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => (selected ? onClear() : onSelect(offering))}
                          >
                            {selected ? 'Selected' : 'Select'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {hiddenCount > 0 && <p className="hint">{hiddenCount} more — refine your search to see them.</p>}
        </>
      )}
    </details>
  )
}

/** Search-filtered rows rendered before "N more — refine" takes over (see `MachineTypePicker`). */
const MACHINE_PICKER_RENDER_CAP = 50
