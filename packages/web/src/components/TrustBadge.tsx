/**
 * The provenance label, rendered the same way everywhere it appears.
 *
 * Moved from `AdminPackShopPage.tsx` (rockysurf-4d8h) unchanged: `official` is visually
 * distinct from the rest because it is the only one meaning "this came from us". Everything
 * else is styled alike on purpose — a design that made `internal` look safer than `community`
 * would be inventing a ranking the trust model does not have, both are just what the operator
 * called a registry.
 *
 * `label` VS `text` (issue #199). `label` is the wire value — what keys the styling and the
 * `data-testid`, and it never changes: a card's badge still styles and identifies itself off
 * `official`/`registry`/`local`, unaffected by what a person reads. `text` is what a person
 * reads, and defaults to `label` for a caller with nothing to translate. Surge Packs passes
 * `community`/`personal` here so the word on the badge matches the heading of the section the
 * card sits under, without recomputing or renaming the value core sent.
 */
export function TrustBadge({ label, text }: { label: string; text?: string }): React.JSX.Element {
  return (
    <span className={`badge trust-${label === 'official' ? 'official' : 'other'}`} data-testid={`trust-${label}`}>
      {text ?? label}
    </span>
  )
}
