import { Link } from 'react-router'

/**
 * The spend-cap banner: the port of `BillingStatusBanner`, with the billing removed.
 *
 * The old banner asked for a payment method and linked to a Stripe portal. Nothing here takes
 * money — the cap is the operator's own limit on their own cloud spend, so the banner's job is
 * narrower and more honest: say how close the cap is, and when it has been reached, say what
 * that actually stops (new servers) and what it does not (servers already running keep
 * running, and keep costing).
 *
 * `spend-cap-reached` arrives over SSE from the uptime ticker; the same state is derivable
 * from `/costs`, so this renders from props and lets the page own the data.
 */

/** Show the warning from here on. Early enough to act, late enough not to be noise. */
export const NEAR_CAP_FRACTION = 0.8

export interface SpendCapBannerProps {
  /** 0..1+, the share of the cap spent this month. Undefined when no cap is configured. */
  fraction?: number
  overCap: boolean
  cap?: { amount: number; currency: string } | null
  spent?: number
}

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)

export function SpendCapBanner({ fraction, overCap, cap, spent }: SpendCapBannerProps) {
  // No cap configured is not a state worth a banner: it is the default, and nagging about it
  // would train the operator to ignore this strip of the page.
  if (!cap) return null
  if (!overCap && (fraction ?? 0) < NEAR_CAP_FRACTION) return null

  const tone = overCap ? '#f85149' : '#d29922'
  const spentText = spent === undefined ? null : money(spent, cap.currency)

  return (
    <div
      role="status"
      data-testid={overCap ? 'spend-cap-reached' : 'spend-cap-near'}
      style={{
        background: overCap ? 'rgba(248, 81, 73, 0.1)' : 'rgba(210, 153, 34, 0.1)',
        border: `1px solid ${tone}`,
        borderRadius: 8,
        padding: '0.75rem 1rem',
        marginBottom: '1rem',
      }}
    >
      <strong style={{ color: tone }}>
        {overCap ? 'Spend cap reached' : 'Approaching your spend cap'}
      </strong>{' '}
      <span style={{ color: tone, fontSize: '0.875rem' }}>
        {spentText ? `${spentText} of ${money(cap.amount, cap.currency)} this month.` : null}{' '}
        {overCap
          ? 'New servers are blocked until the cap resets or you raise it. Servers already running are NOT stopped — they keep running, and keep costing.'
          : 'Creating servers will be blocked once you reach it.'}
      </span>{' '}
      <Link to="/costs" style={{ color: tone, fontSize: '0.875rem' }}>
        View costs
      </Link>
    </div>
  )
}
