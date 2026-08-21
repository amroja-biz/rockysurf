/**
 * The provenance label, rendered the same way everywhere it appears.
 *
 * Moved from `AdminPackShopPage.tsx` (rockysurf-4d8h) unchanged: `official` is visually
 * distinct from the rest because it is the only one meaning "this came from us". Everything
 * else is styled alike on purpose — a design that made `internal` look safer than `community`
 * would be inventing a ranking the trust model does not have, both are just what the operator
 * called a registry.
 */
export function TrustBadge({ label }: { label: string }): React.JSX.Element {
  return (
    <span className={`badge trust-${label === 'official' ? 'official' : 'other'}`} data-testid={`trust-${label}`}>
      {label}
    </span>
  )
}
