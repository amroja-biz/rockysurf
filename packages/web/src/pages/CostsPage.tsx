import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AppShell } from '../components/AppShell'
import { Moon, Plate, Waterline } from '../components/etched'
import { NEAR_CAP_FRACTION, SpendCapBanner } from '../components/SpendCapBanner'
import { useEvents } from '../contexts/EventsContext'
import { getCosts, type CostsResponse, type ServerCost } from '../lib/api'
import { ESTIMATE_HINT, formatUptime, UNPRICED_HINT } from '../lib/format'

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
  // The product's status tokens, not literal hexes: yellow warns, red refuses. Until it warns,
  // the level is drawn in the beam — the one accent — as the designer's screen draws it
  // (ui_kits/etched); a green "all clear" here would be a status the page is not reporting.
  const tone = costs.cap.overCap
    ? 'var(--rs-red)'
    : fraction >= NEAR_CAP_FRACTION
      ? 'var(--rs-yellow)'
      : 'var(--rs-beam, var(--rs-green-bright))'

  return (
    <Plate as="section" className="spend-cap">
      <h2>Spend cap</h2>
      {/* THE ONE PLACE A LEVEL IS DRAWN (#174): the cap is named in the same breath as the
          spend, so a waterline against it is a fact, not a decoration. The moon gives the
          glance, the text gives the number. */}
      <div className="cap-meter" style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
        <span style={{ color: 'var(--rs-heading)', flexShrink: 0 }}>
          <Moon fraction={fraction} size={62} />
        </span>
        <div>
          <p data-testid="cap-summary" style={{ margin: '0 0 0.5rem' }}>
            <strong className="cost-figure">{money(spent, cap.currency)}</strong> of{' '}
            <span className="cost-figure">{money(cap.amount, cap.currency)}</span> this month ({pct}%)
          </p>
          {/* A meter, not an input: the cap is configuration. A control here would imply core
              can raise its own ceiling. */}
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={cap.amount}
            aria-valuenow={spent}
            aria-label="Spend against cap"
            style={{ color: tone }}
          >
            <Waterline fraction={fraction} width={260} />
          </div>
        </div>
      </div>
      <p style={{ fontSize: '0.875rem', marginBottom: 0 }}>
        Max servers: <strong>{costs.limits.maxServers}</strong>. Both limits are read-only here —
        they come from your config file.
      </p>
    </Plate>
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
      <td>{formatUptime(server.totalUptimeSeconds)}</td>
      {/* `cost-figure`: money is mono, tabular and right-aligned so a column of rates can be
          read down rather than word by word (#225). */}
      <td className="cost-figure" title={server.hourlyCost ? undefined : UNPRICED_HINT}>
        {server.hourlyCost ? `${money(server.hourlyCost.amount, server.hourlyCost.currency)}/h` : 'unpriced'}
      </td>
      {/* The dash and the number are different facts, so they carry different sentences — the
          same pairing the dashboard card and the detail page use (rockysurf-u6af). */}
      <td className="cost-figure" title={server.currency ? ESTIMATE_HINT : UNPRICED_HINT}>
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

  // The shell wraps the loading and error states too. A page that loses its navigation exactly
  // when it cannot load is the state a user most needs to navigate away from.
  if (error) return <AppShell title="Costs"><p role="alert">{error}</p></AppShell>
  if (!costs) return <AppShell title="Costs"><p>Loading costs…</p></AppShell>

  const currencies = Object.keys(costs.monthToDate.byCurrency)
  const providers = Object.entries(costs.pricedAtByProvider)

  return (
    <AppShell title="Costs">
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
              <li key={currency} title={ESTIMATE_HINT}>
                <strong className="cost-figure">{money(costs.monthToDate.byCurrency[currency]!, currency)}</strong>
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
                <th className="cost-figure">Rate</th>
                <th className="cost-figure">Estimated cost</th>
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
    </AppShell>
  )
}
