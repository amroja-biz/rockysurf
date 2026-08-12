import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { NEAR_CAP_FRACTION, SpendCapBanner } from '../components/SpendCapBanner'
import { useEvents } from '../contexts/EventsContext'
import { getCosts, type CostsResponse, type ServerCost } from '../lib/api'

/**
 * Costs — the port of `BillingPage` with every payment element removed.
 *
 * What is gone and why: the Stripe portal button, the payment-method status, the invoice list.
 * This installation is not a payment processor; it spends the operator's own cloud budget, so
 * there is nothing to charge and nobody to charge it to. What remains is the part that was
 * always the useful half — what has this cost, and how close am I to the limit that will stop
 * me creating more.
 *
 * Everything here is an estimate and the page says so twice: once in the tooltip on each
 * figure, and once in the provenance line at the bottom naming the date the prices were
 * fetched. Estimates round DOWN — uptime accrues on a timer, so a server running right now has
 * always cost slightly more than this page admits.
 */

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** The estimate caveat, attached to every number that is one. */
const ESTIMATE_TITLE = 'Estimate. Rounds down: uptime accrues on a timer, so a running server has cost slightly more than shown.'

function CapMeter({ costs }: { costs: CostsResponse }) {
  const cap = costs.limits.spendCap
  if (!cap) {
    return (
      <p data-testid="no-cap">
        No spend cap configured. Set <code>limits.spendCap</code> in your config file to have core
        refuse new servers past a monthly amount.
      </p>
    )
  }

  const spent = costs.monthToDate.byCurrency[cap.currency] ?? 0
  const fraction = costs.cap.fraction ?? 0
  const pct = Math.min(100, Math.round(fraction * 100))
  const tone = costs.cap.overCap ? '#f85149' : fraction >= NEAR_CAP_FRACTION ? '#d29922' : '#3fb950'

  return (
    <section>
      <h2>Spend cap</h2>
      <p data-testid="cap-summary">
        <strong>{money(spent, cap.currency)}</strong> of {money(cap.amount, cap.currency)} this month
        {' '}({pct}%)
      </p>
      {/* A meter, not an input: the cap is configuration. A control here would imply core can
          raise its own ceiling. */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={cap.amount}
        aria-valuenow={spent}
        aria-label="Spend against cap"
        style={{ background: '#21262d', borderRadius: 6, height: 10, overflow: 'hidden', maxWidth: 420 }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: tone }} />
      </div>
      <p style={{ fontSize: '0.875rem' }}>
        Max servers: <strong>{costs.limits.maxServers}</strong>. Both limits are read-only here —
        they come from your config file.
      </p>
    </section>
  )
}

function ServerRow({ server }: { server: ServerCost }) {
  return (
    <tr data-testid={`cost-row-${server.id}`}>
      <td>
        <Link to={`/servers/${server.id}`}>{server.name}</Link>
      </td>
      <td>{server.provider}</td>
      <td>{server.status}</td>
      <td>{duration(server.totalUptimeSeconds)}</td>
      <td>{server.hourlyCost ? `${money(server.hourlyCost.amount, server.hourlyCost.currency)}/h` : 'unpriced'}</td>
      <td title={ESTIMATE_TITLE}>
        {server.currency ? money(server.estimatedTotalCost, server.currency) : '—'}
      </td>
    </tr>
  )
}

export function CostsPage() {
  const [costs, setCosts] = useState<CostsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { subscribe } = useEvents()

  const load = useCallback(async () => {
    try {
      setCosts(await getCosts())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load costs')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // The cap event is the one thing that can change this page without the user doing anything,
  // and it is exactly the moment they want to see it: refetch rather than patch state, because
  // the numbers behind it come from the server.
  useEffect(() => subscribe((event) => {
    if (event.type === 'spend-cap-reached') void load()
  }), [subscribe, load])

  if (error) return <p role="alert">{error}</p>
  if (!costs) return <p>Loading costs…</p>

  const currencies = Object.keys(costs.monthToDate.byCurrency)
  const providers = Object.entries(costs.pricedAtByProvider)

  return (
    <main>
      <h1>Costs</h1>

      <SpendCapBanner
        {...(costs.cap.fraction !== undefined ? { fraction: costs.cap.fraction } : {})}
        overCap={costs.cap.overCap}
        cap={costs.limits.spendCap}
        {...(costs.limits.spendCap
          ? { spent: costs.monthToDate.byCurrency[costs.limits.spendCap.currency] ?? 0 }
          : {})}
      />

      <section>
        <h2>This month ({costs.monthToDate.month})</h2>
        {currencies.length === 0 ? (
          <p data-testid="mtd-empty">Nothing accrued yet this month.</p>
        ) : (
          // One figure per currency, never a single total: a EUR project and a USD account
          // cannot be added without inventing an exchange rate.
          <ul data-testid="mtd-by-currency">
            {currencies.map((currency) => (
              <li key={currency} title={ESTIMATE_TITLE}>
                <strong>{money(costs.monthToDate.byCurrency[currency]!, currency)}</strong>
              </li>
            ))}
          </ul>
        )}
        {costs.monthToDate.unpricedServers > 0 && (
          <p data-testid="unpriced-warning">
            {costs.monthToDate.unpricedServers} server
            {costs.monthToDate.unpricedServers === 1 ? '' : 's'} had no price quoted by the provider.
            Their cost is real but is not counted above, or against the cap.
          </p>
        )}
      </section>

      <CapMeter costs={costs} />

      <section>
        <h2>Per server</h2>
        {costs.servers.length === 0 ? (
          <p data-testid="no-servers">No servers yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Server</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Uptime</th>
                <th>Rate</th>
                <th>Estimated cost</th>
              </tr>
            </thead>
            <tbody>
              {costs.servers.map((server) => (
                <ServerRow key={server.id} server={server} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer>
        <p data-testid="estimate-note" style={{ fontSize: '0.875rem' }}>
          {costs.estimateNote}
        </p>
        {providers.length > 0 && (
          <p data-testid="price-provenance" style={{ fontSize: '0.875rem' }}>
            Based on prices fetched{' '}
            {providers.map(([provider, at], i) => (
              <span key={provider}>
                {i > 0 ? ', ' : ''}
                {new Date(at).toISOString().slice(0, 10)} ({provider})
              </span>
            ))}
            .
          </p>
        )}
      </footer>
    </main>
  )
}
